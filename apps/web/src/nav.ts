import { can, canAny, href, signedIn, surfaceHref, type Features, type RequestContext } from "./context.ts";

export interface NavItem {
  key: string;
  label: string;
  href: string;
}

export interface SideItem {
  key?: string;
  text?: string;
  href?: string;
  label?: string;
}

export function hasAdmin(rc: RequestContext): boolean {
  return ["users.", "roles.", "audit.", "text_filter.", "system.", "webhooks.", "safety.", "games.", "oidc.clients"].some((p) => canAny(rc, p));
}

export function hasSupportStaff(rc: RequestContext): boolean {
  return can(rc, "support.tickets.staff") || can(rc, "support.kb.edit");
}

export function accountNav(rc: RequestContext, f: Features): NavItem[] {
  const t = rc.t;
  if (!signedIn(rc)) return [];
  const items: NavItem[] = [{ key: "overview", label: t("nav.overview"), href: href(rc, "/") }];
  items.push({ key: "settings", label: t("app.settings"), href: href(rc, "/settings/profile") });
  if (f.features.games) items.push({ key: "games", label: t("nav.games"), href: href(rc, "/games") });
  if (f.modules.oidc) items.push({ key: "apps", label: t("nav.apps"), href: href(rc, "/settings/apps") });
  if (f.features.safety) items.push({ key: "safety", label: t("nav.safety"), href: href(rc, "/safety") });
  if (f.features.developer_portal) items.push({ key: "developer", label: t("nav.developer"), href: href(rc, "/developer") });
  if (hasAdmin(rc)) items.push({ key: "admin", label: t("app.admin"), href: href(rc, "/admin") });
  if (hasSupportStaff(rc) && f.features.support) items.push({ key: "staff", label: t("app.staff"), href: surfaceHref(rc, "support", "/staff/tickets") });
  return items;
}

export function supportNav(rc: RequestContext, f: Features): NavItem[] {
  const t = rc.t;
  const items: NavItem[] = [{ key: "help", label: t("nav.help"), href: href(rc, "/") }];
  if (f.features.support?.tickets && signedIn(rc)) items.push({ key: "tickets", label: t("nav.tickets"), href: href(rc, "/tickets") });
  if (hasSupportStaff(rc)) items.push({ key: "staff", label: t("app.staff"), href: href(rc, can(rc, "support.tickets.staff") ? "/staff/tickets" : "/staff/kb") });
  if (signedIn(rc)) items.push({ key: "account", label: t("app.account"), href: surfaceHref(rc, "account", "/") });
  return items;
}

export function settingsSide(rc: RequestContext, f: Features): SideItem[] {
  const t = rc.t;
  const items: SideItem[] = [
    { label: t("app.account") },
    { key: "profile", text: t("nav.profile"), href: href(rc, "/settings/profile") },
    { key: "security", text: t("nav.security"), href: href(rc, "/settings/security") },
    { key: "sessions", text: t("nav.sessions"), href: href(rc, "/settings/sessions") },
    { key: "notifications", text: t("nav.notifications"), href: href(rc, "/settings/notifications") },
  ];
  if (f.modules.oidc) items.push({ key: "apps", text: t("nav.apps"), href: href(rc, "/settings/apps") });
  items.push({ key: "family", text: t("nav.family"), href: href(rc, "/settings/family") });
  if (f.features.games) items.push({ key: "devices", text: t("games.devices"), href: href(rc, "/games/devices") });
  items.push({ key: "privacy", text: t("nav.privacy"), href: href(rc, "/settings/privacy") });
  return items;
}

export function adminSide(rc: RequestContext, f: Features): SideItem[] {
  const t = rc.t;
  const items: SideItem[] = [{ label: t("app.admin") }, { key: "health", text: t("nav.admin_health"), href: href(rc, "/admin") }];
  if (can(rc, "users.read")) items.push({ key: "users", text: t("nav.admin_users"), href: href(rc, "/admin/users") });
  if (can(rc, "roles.manage")) items.push({ key: "roles", text: t("nav.admin_roles"), href: href(rc, "/admin/roles") });
  if (can(rc, "audit.read")) items.push({ key: "audit", text: t("nav.admin_audit"), href: href(rc, "/admin/audit") });
  if (can(rc, "text_filter.manage")) items.push({ key: "filter", text: t("nav.admin_filter"), href: href(rc, "/admin/text-filter") });
  if (can(rc, "webhooks.manage")) {
    items.push({ key: "webhooks", text: t("nav.admin_webhooks"), href: href(rc, "/admin/webhooks") });
    items.push({ key: "email", text: t("nav.admin_email"), href: href(rc, "/admin/email") });
  }
  if (f.modules.oidc && (can(rc, "oidc.clients.read") || can(rc, "oidc.clients.suspend"))) items.push({ key: "clients", text: t("nav.admin_clients"), href: href(rc, "/admin/oidc/clients") });
  if (f.features.safety && can(rc, "safety.reports.read")) {
    items.push({ label: t("nav.admin_safety") });
    items.push({ key: "safety", text: t("nav.admin_safety"), href: href(rc, "/admin/safety") });
    if (can(rc, "safety.appeals.resolve")) items.push({ key: "appeals", text: t("nav.admin_appeals"), href: href(rc, "/admin/safety/appeals") });
    if (can(rc, "safety.flags.read")) items.push({ key: "flags", text: t("nav.admin_flags"), href: href(rc, "/admin/safety/flags") });
  }
  if (f.features.safety && can(rc, "safety.csea.access")) items.push({ key: "csea", text: t("nav.admin_csea"), href: href(rc, "/admin/safety/csea") });
  if (f.features.games && (can(rc, "games.catalog.edit") || can(rc, "games.entitlements.grant"))) {
    items.push({ label: t("nav.games") });
    if (can(rc, "games.catalog.edit")) items.push({ key: "games", text: t("nav.admin_games"), href: href(rc, "/admin/games") });
    if (can(rc, "games.entitlements.grant")) items.push({ key: "entitlements", text: t("nav.admin_entitlements"), href: href(rc, "/admin/games/entitlements") });
  }
  return items;
}

export function staffSide(rc: RequestContext): SideItem[] {
  const t = rc.t;
  const items: SideItem[] = [{ label: t("app.staff") }];
  if (can(rc, "support.tickets.staff")) {
    items.push({ key: "tickets", text: t("nav.staff_tickets"), href: href(rc, "/staff/tickets") });
    items.push({ key: "macros", text: t("nav.staff_macros"), href: href(rc, "/staff/macros") });
    items.push({ key: "metrics", text: t("nav.staff_metrics"), href: href(rc, "/staff/metrics") });
  }
  if (can(rc, "support.kb.edit")) items.push({ key: "kb", text: t("nav.staff_kb"), href: href(rc, "/staff/kb") });
  return items;
}
