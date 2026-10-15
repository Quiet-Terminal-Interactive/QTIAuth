import MarkdownIt from "markdown-it";

const SAFE_PROTOCOLS = /^(https?:|mailto:|\/|#|\.\/|\.\.\/)/i;

function create(): MarkdownIt {
  const md = new MarkdownIt({ html: false, linkify: true, typographer: true, breaks: false });
  md.validateLink = (url: string) => SAFE_PROTOCOLS.test(url.trim()) && !/^\s*(javascript|vbscript|data|file):/i.test(url);
  const defaultLink = md.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    const token = tokens[idx]!;
    const href = token.attrGet("href") ?? "";
    if (/^https?:/i.test(href)) {
      token.attrSet("rel", "noopener noreferrer nofollow ugc");
      token.attrSet("target", "_blank");
    }
    return defaultLink(tokens, idx, options, env, self);
  };
  const defaultImage = md.renderer.rules.image!;
  md.renderer.rules.image = (tokens, idx, options, env, self) => {
    tokens[idx]!.attrSet("loading", "lazy");
    tokens[idx]!.attrSet("referrerpolicy", "no-referrer");
    return defaultImage(tokens, idx, options, env, self);
  };
  return md;
}

const instance = create();

export function renderMarkdown(source: string): string {
  return instance.render(source);
}

export function markdownToText(source: string): string {
  return instance
    .render(source)
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function slugify(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}
