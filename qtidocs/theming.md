---
title: Theming and localisation
description: Colours, fonts, logo, custom CSS, email templates, legal documents and adding a language.
order: 3
---

# Theming and localisation

## Colours

The web app is styled entirely from `branding.colors`. Every value is a `#rrggbb` hex colour.

| Key                                           | Default   | Used for                                                                       |
| --------------------------------------------- | --------- | ------------------------------------------------------------------------------ |
| `scheme`                                      | `dark`    | Tells the browser whether form controls and scrollbars should be dark or light |
| `background`                                  | `#222034` | Page background (Midnight Express)                                             |
| `surface`                                     | `#2C2A44` | Cards, header                                                                  |
| `surface_raised`                              | `#363352` | Menus, secondary buttons, active navigation                                    |
| `border`                                      | `#45416A` | Card and input borders                                                         |
| `text`                                        | `#F2F0FA` | Body text                                                                      |
| `text_muted`                                  | `#A9A5C6` | Secondary text, hints                                                          |
| `primary`                                     | `#5BB1EF` | Buttons, links, focus rings (Cornflower Blue)                                  |
| `primary_text`                                | `#222034` | Text on primary buttons                                                        |
| `accent`                                      | `#BC6DE0` | Gradients and highlights (Medium Orchid)                                       |
| `success`                                     | `#80D35D` | Success messages (Pastel Green)                                                |
| `warning`                                     | `#F7DA47` | Warnings (Energy Yellow)                                                       |
| `danger`                                      | `#DD5F5F` | Errors and destructive buttons (Roman)                                         |
| `highlight`                                   | `#FF954F` | Attention badges (Coral)                                                       |
| `info`                                        | `#5BB1EF` | Informational messages                                                         |
| `palette.red/orange/green/yellow/purple/blue` | as above  | Status badges                                                                  |

A light theme only needs a different set of values:

```yaml
branding:
  colors:
    scheme: light
    background: "#F7F7FB"
    surface: "#FFFFFF"
    surface_raised: "#EEEDF5"
    border: "#D9D7E6"
    text: "#1C1A2E"
    text_muted: "#5D5A75"
    primary: "#2563EB"
    primary_text: "#FFFFFF"
```

Choose `text`/`background` and `primary_text`/`primary` pairs with a contrast ratio of at least 4.5:1.

## Fonts, shape and custom CSS

```yaml
branding:
  font_family: "Inter, system-ui, sans-serif"
  heading_font_family: "'Space Grotesk', Inter, sans-serif"
  border_radius: 12px
  custom_css: ./branding/custom.css     # or inline CSS
```

`custom_css` is appended after the theme, so it can override anything. Every colour is also available as a CSS variable (`--bg`, `--surface`, `--primary`, `--accent`, `--radius`, `--font` and so on). The page's Content Security Policy allows stylesheets and fonts from Google Fonts, so you can `@import` one in your custom CSS.

## Logo and favicon

`branding.logo` and `branding.favicon` are paths inside the config directory. SVG, PNG, WebP, ICO and JPEG work. If the logo file is missing, the app draws a lettermark from the product name in your primary and accent colours. Email templates use PNG best, because many email clients don't display SVG.

## Email templates

Default templates (MJML plus plain text) ship in the image. To change one, copy it from `services/notifier/templates/en-GB/` into `config/templates/email/en-GB/` with the same file name and edit it. Each template declares its variables in front matter. Using an undeclared variable is caught at startup by `qtiauth config check`. Templates can also use `product_name`, `company_name`, `support_email`, `logo_url`, `account_url`, `support_url` and `colors`.

## Legal documents

Documents live in `config/legal/*.md` with front matter:

```markdown
---
id: terms
version: 2026-10-01
effective_at: 2026-10-01T00:00:00Z
material: true
summary: "We added passkeys and changed how long we keep security logs."
---
# Terms of Service
...
```

- Publish a change by adding a new `version`. Changing the text of an existing version is refused at startup.
- `material: true` asks every user to accept again once `effective_at` passes. Non-material changes are announced by email.
- `children-summary.md` is shown to under-13s and their guardians if present.
- `{{product_name}}`, `{{company_name}}`, `{{support_email}}`, `{{accountable_person_name}}` and `{{accountable_person_role}}` are filled in automatically.

## Adding a language

1. Copy `apps/web/src/i18n/en-GB.ts` to, say, `fr-FR.ts`, translate the values (keep the keys), and register it in `apps/web/src/i18n/index.ts`.
2. Add email templates under `config/templates/email/fr-FR/` (any missing template falls back to the default locale).
3. Add the locale to `branding.locales`.

The app picks the user's saved locale, then the browser's `Accept-Language`, then `branding.default_locale`. A unit test fails the build if a page uses a translation key that isn't in the catalogue, or hard-codes English text.
