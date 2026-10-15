export type Vars = Record<string, unknown>;

type Node =
  | { t: "text"; v: string }
  | { t: "var"; path: string; raw: boolean }
  | { t: "if"; path: string; yes: Node[]; no: Node[] }
  | { t: "each"; path: string; body: Node[] }
  | { t: "partial"; name: string };

const TOKEN = /\{\{\{\s*([\w.]+)\s*\}\}\}|\{\{\s*(#if|#each|else|\/if|\/each|>)?\s*([\w.]*)\s*\}\}/g;

export class TemplateError extends Error {}

export function parse(src: string): Node[] {
  const root: Node[] = [];
  const stack: { nodes: Node[]; node?: Node & { t: "if" | "each" }; inElse?: boolean }[] = [{ nodes: root }];
  let last = 0;
  for (const m of src.matchAll(TOKEN)) {
    const top = stack[stack.length - 1]!;
    const target = () => (top.node?.t === "if" && top.inElse ? top.node.no : top.nodes);
    if (m.index! > last) target().push({ t: "text", v: src.slice(last, m.index) });
    last = m.index! + m[0].length;
    if (m[1]) {
      target().push({ t: "var", path: m[1], raw: true });
      continue;
    }
    const kw = m[2];
    const arg = m[3] ?? "";
    if (!kw) {
      target().push({ t: "var", path: arg, raw: false });
    } else if (kw === ">") {
      target().push({ t: "partial", name: arg });
    } else if (kw === "#if") {
      const node: Node & { t: "if" } = { t: "if", path: arg, yes: [], no: [] };
      target().push(node);
      stack.push({ nodes: node.yes, node });
    } else if (kw === "#each") {
      const node: Node & { t: "each" } = { t: "each", path: arg, body: [] };
      target().push(node);
      stack.push({ nodes: node.body, node });
    } else if (kw === "else") {
      if (top.node?.t !== "if") throw new TemplateError("{{else}} outside {{#if}}");
      top.inElse = true;
    } else if (kw === "/if" || kw === "/each") {
      if (!top.node || top.node.t !== kw.slice(1)) throw new TemplateError(`Unexpected {{${kw}}}`);
      stack.pop();
    }
  }
  if (stack.length !== 1) throw new TemplateError("Unclosed block");
  const top = stack[0]!;
  if (last < src.length) top.nodes.push({ t: "text", v: src.slice(last) });
  return root;
}

function lookup(scope: Vars[], path: string): unknown {
  const parts = path.split(".");
  if (parts[0] === "this") {
    let v: unknown = scope[scope.length - 1]?.this;
    for (const p of parts.slice(1)) v = v && typeof v === "object" ? (v as Record<string, unknown>)[p] : undefined;
    return v;
  }
  for (let i = scope.length - 1; i >= 0; i--) {
    const s = scope[i]!;
    if (parts[0]! in s) {
      let v: unknown = s[parts[0]!];
      for (const p of parts.slice(1)) v = v && typeof v === "object" ? (v as Record<string, unknown>)[p] : undefined;
      return v;
    }
  }
  return undefined;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function truthy(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  return Boolean(v);
}

function show(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.map(show).join(", ");
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export function render(nodes: Node[], vars: Vars, opts: { html: boolean; partials?: Record<string, Node[]> }, scope: Vars[] = [vars]): string {
  let out = "";
  for (const n of nodes) {
    switch (n.t) {
      case "text":
        out += n.v;
        break;
      case "var": {
        const s = show(lookup(scope, n.path));
        out += opts.html && !n.raw ? escapeHtml(s) : s;
        break;
      }
      case "if":
        out += render(truthy(lookup(scope, n.path)) ? n.yes : n.no, vars, opts, scope);
        break;
      case "each": {
        const list = lookup(scope, n.path);
        if (Array.isArray(list)) for (const item of list) out += render(n.body, vars, opts, [...scope, { this: item, ...(item && typeof item === "object" ? (item as Vars) : {}) }]);
        break;
      }
      case "partial": {
        const p = opts.partials?.[n.name];
        if (!p) throw new TemplateError(`Unknown partial ${n.name}`);
        out += render(p, vars, opts, scope);
        break;
      }
    }
  }
  return out;
}

export function referencedVars(nodes: Node[], inEach = false): Set<string> {
  const out = new Set<string>();
  for (const n of nodes) {
    if (n.t === "var" && !(inEach && n.path.startsWith("this"))) {
      if (!inEach || !n.path.includes(".") || !n.path.startsWith("this")) out.add(n.path.split(".")[0]!);
    }
    if (n.t === "if") {
      if (!(inEach && n.path.startsWith("this"))) out.add(n.path.split(".")[0]!);
      for (const v of referencedVars(n.yes, inEach)) out.add(v);
      for (const v of referencedVars(n.no, inEach)) out.add(v);
    }
    if (n.t === "each") {
      out.add(n.path.split(".")[0]!);
      for (const v of referencedVars(n.body, true)) if (v !== "this") out.add(`each:${v}`);
    }
  }
  return out;
}
