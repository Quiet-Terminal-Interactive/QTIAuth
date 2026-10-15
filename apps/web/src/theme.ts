import { existsSync, readFileSync } from "node:fs";
import { configFile, type LoadedConfig } from "@qtiauth/config";
import { sha256 } from "@qtiauth/common";

type Colors = LoadedConfig["branding"]["colors"];

const CSS_VALUE = /^[^;{}<>]*$/;

function safe(v: string): string {
  if (!CSS_VALUE.test(v)) throw new Error(`Unsafe CSS value in branding config: ${v}`);
  return v;
}

export function themeVariables(cfg: LoadedConfig): string {
  const c: Colors = cfg.branding.colors;
  const b = cfg.branding;
  const vars: Record<string, string> = {
    "--bg": c.background,
    "--surface": c.surface,
    "--surface-raised": c.surface_raised,
    "--border": c.border,
    "--text": c.text,
    "--text-muted": c.text_muted,
    "--primary": c.primary,
    "--primary-text": c.primary_text,
    "--accent": c.accent,
    "--success": c.success,
    "--warning": c.warning,
    "--danger": c.danger,
    "--highlight": c.highlight,
    "--info": c.info,
    "--red": c.palette.red,
    "--orange": c.palette.orange,
    "--green": c.palette.green,
    "--yellow": c.palette.yellow,
    "--purple": c.palette.purple,
    "--blue": c.palette.blue,
    "--radius": safe(b.border_radius),
    "--font": safe(b.font_family),
    "--font-heading": safe(b.heading_font_family ?? b.font_family),
  };
  const body = Object.entries(vars)
    .map(([k, v]) => `  ${k}: ${v};`)
    .join("\n");
  return `:root {\n  color-scheme: ${c.scheme};\n${body}\n}\n`;
}

export function customCss(cfg: LoadedConfig): string {
  const v = cfg.branding.custom_css?.trim();
  if (!v) return "";
  if (/\.css$/i.test(v)) {
    const path = configFile(cfg, v);
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  }
  return v;
}

export interface Theme {
  css: string;
  version: string;
}

export function buildTheme(cfg: LoadedConfig, base: string): Theme {
  const css = `${themeVariables(cfg)}\n${base}\n${customCss(cfg)}`;
  return { css, version: sha256(css).slice(0, 12) };
}
