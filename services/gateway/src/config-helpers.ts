import type { Config } from "@qtiauth/config";

export function normalizeEmailLike(cfg: Config, value: string): string {
  const v = value.trim().toLowerCase();
  const at = v.lastIndexOf("@");
  if (at < 1) return v;
  let local = v.slice(0, at);
  let domain = v.slice(at + 1);
  const rule = cfg.accounts.email_normalization[domain];
  if (rule) {
    if (rule.strip_plus) local = local.split("+")[0]!;
    if (rule.strip_dots) local = local.replaceAll(".", "");
    if (rule.canonical_domain) domain = rule.canonical_domain;
  }
  return `${local}@${domain}`;
}
