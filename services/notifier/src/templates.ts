import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import mjml2html from "mjml";
import { configFile, parseFrontMatter, surfaceUrl, type LoadedConfig, type ResolvedSurface, type SurfaceName } from "@qtiauth/config";
import { parse, render, referencedVars, TemplateError, type Vars } from "./templating.ts";

const DEFAULT_DIR = fileURLToPath(new URL("../templates", import.meta.url));

export const GLOBAL_VARS = new Set(["product_name", "company_name", "support_email", "logo_url", "account_url", "support_url", "colors", "year", "locale"]);

interface CompiledTemplate {
  name: string;
  locale: string;
  subject: ReturnType<typeof parse>;
  mjml: ReturnType<typeof parse>;
  text: ReturnType<typeof parse>;
  vars: Set<string>;
  source: "default" | "override";
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export class TemplateStore {
  private readonly templates = new Map<string, CompiledTemplate>();
  private readonly partials = new Map<string, Record<string, ReturnType<typeof parse>>>();
  private readonly cfg: LoadedConfig;
  private readonly globals: Vars;
  readonly defaultLocale: string;

  constructor(cfg: LoadedConfig, surfaces: Record<SurfaceName, ResolvedSurface>) {
    this.cfg = cfg;
    this.defaultLocale = cfg.branding.default_locale;
    this.globals = {
      product_name: cfg.branding.product_name,
      company_name: cfg.branding.company_name,
      support_email: cfg.branding.support_email,
      logo_url: surfaceUrl(surfaces.account, "/branding/logo.png"),
      account_url: surfaces.account.url,
      support_url: surfaces.support.url,
      colors: cfg.branding.colors,
      year: new Date().getUTCFullYear(),
    };
  }

  async load(): Promise<{ loaded: number; overrides: number }> {
    const overrideRoot = configFile(this.cfg, "./templates/email");
    const locales = new Set([this.defaultLocale, ...this.cfg.branding.locales]);
    let overrides = 0;
    const errors: string[] = [];
    for (const locale of locales) {
      const defaultDir = join(DEFAULT_DIR, locale);
      const overrideDir = join(overrideRoot, locale);
      const names = new Set<string>();
      for (const dir of [defaultDir, overrideDir]) {
        if (!existsSync(dir)) continue;
        for (const f of readdirSync(dir)) if (f.endsWith(".mjml") && !f.startsWith("_")) names.add(f.slice(0, -5));
      }
      const partials: Record<string, ReturnType<typeof parse>> = {};
      for (const p of ["header", "footer"]) {
        const file = [join(overrideDir, `_${p}.mjml`), join(defaultDir, `_${p}.mjml`), join(DEFAULT_DIR, this.defaultLocale, `_${p}.mjml`)].find(existsSync);
        if (file) partials[p] = parse(readFileSync(file, "utf8"));
      }
      this.partials.set(locale, partials);
      for (const name of names) {
        try {
          const mjmlPath = [join(overrideDir, `${name}.mjml`), join(defaultDir, `${name}.mjml`)].find(existsSync)!;
          const txtPath = [join(overrideDir, `${name}.txt`), join(defaultDir, `${name}.txt`)].find(existsSync);
          if (!txtPath) throw new TemplateError("missing .txt plain-text version");
          const isOverride = mjmlPath.startsWith(overrideDir) || txtPath.startsWith(overrideDir);
          if (isOverride) overrides++;
          const { data, body } = parseFrontMatter(readFileSync(mjmlPath, "utf8"));
          const declaredFrom = (mjmlPath.startsWith(overrideDir) && existsSync(join(defaultDir, `${name}.mjml`)) ? parseFrontMatter(readFileSync(join(defaultDir, `${name}.mjml`), "utf8")).data : data) as { vars?: string[] };
          const vars = new Set<string>((declaredFrom.vars ?? data.vars ?? []) as string[]);
          const subjectSrc = String(data.subject ?? "");
          if (!subjectSrc) throw new TemplateError("no subject in front matter");
          const compiled: CompiledTemplate = { name, locale, subject: parse(subjectSrc), mjml: parse(body), text: parse(readFileSync(txtPath, "utf8")), vars, source: isOverride ? "override" : "default" };
          for (const part of [compiled.subject, compiled.mjml, compiled.text]) {
            for (const ref of referencedVars(part)) {
              if (ref.startsWith("each:")) continue;
              if (!vars.has(ref) && !GLOBAL_VARS.has(ref)) throw new TemplateError(`uses {{${ref}}} which is not a declared variable (${[...vars].join(", ")})`);
            }
          }
          const test = await Promise.resolve(mjml2html(render(compiled.mjml, { ...this.globals, ...Object.fromEntries([...vars].map((v) => [v, "x"])) }, { html: true, partials }), { validationLevel: "soft" }));
          if (test.errors.length) throw new TemplateError(`MJML: ${test.errors.map((e: { formattedMessage: string }) => e.formattedMessage).join("; ")}`);
          this.templates.set(`${locale}:${name}`, compiled);
        } catch (err) {
          errors.push(`${locale}/${name}: ${(err as Error).message}`);
        }
      }
    }
    if (errors.length) throw new TemplateError(`Invalid email templates:\n  ${errors.join("\n  ")}`);
    return { loaded: this.templates.size, overrides };
  }

  has(name: string): boolean {
    return this.templates.has(`${this.defaultLocale}:${name}`);
  }

  names(): string[] {
    return [...this.templates.values()].filter((t) => t.locale === this.defaultLocale).map((t) => t.name);
  }

  async render(name: string, locale: string | null | undefined, vars: Vars): Promise<RenderedEmail> {
    const t = this.templates.get(`${locale}:${name}`) ?? this.templates.get(`${this.defaultLocale}:${name}`);
    if (!t) throw new TemplateError(`Unknown email template ${name}`);
    const missing = [...t.vars].filter((v) => !(v in vars));
    const all: Vars = { ...Object.fromEntries(missing.map((m) => [m, ""])), ...this.globals, ...vars, locale: t.locale };
    const partials = this.partials.get(t.locale) ?? {};
    const subject = render(t.subject, all, { html: false }).replace(/\s+/g, " ").trim();
    const { html, errors } = await Promise.resolve(mjml2html(render(t.mjml, all, { html: true, partials }), { validationLevel: "soft", minify: false }));
    if (errors.length && !html) throw new TemplateError(errors.map((e: { formattedMessage: string }) => e.formattedMessage).join("; "));
    const text = render(t.text, all, { html: false }).replace(/\n{3,}/g, "\n\n");
    return { subject, html, text };
  }
}
