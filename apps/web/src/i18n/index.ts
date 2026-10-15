import { enGB } from "./en-GB.ts";

const CATALOGUES: Record<string, Record<string, string>> = { "en-GB": enGB };

export type Translate = (key: string, vars?: Record<string, string | number | null | undefined>) => string;

function interpolate(template: string, vars: Record<string, string | number | null | undefined>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (vars[k] === undefined || vars[k] === null ? m : String(vars[k])));
}

export function translator(locale: string | null | undefined, fallback: string, globals: Record<string, string | number> = {}): Translate {
  const primary = CATALOGUES[locale ?? ""] ?? CATALOGUES[fallback] ?? enGB;
  return (key, vars = {}) => {
    const template = primary[key] ?? enGB[key];
    if (template === undefined) return key;
    return interpolate(template, { ...globals, ...vars });
  };
}

export function errorMessage(t: Translate, code: string | undefined, detail?: string): string {
  if (!code) return t("error.generic");
  const key = `error.${code}`;
  const msg = t(key);
  if (msg !== key) return msg;
  return detail && detail !== code ? detail : t("error.generic");
}

export function hasLocale(locale: string): boolean {
  return Boolean(CATALOGUES[locale]);
}
