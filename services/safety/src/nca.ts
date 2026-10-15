import { isIP } from "node:net";
import type { ContentRef, CseaCase, Report } from "./db.ts";

export type FieldSource = "qtiauth" | "game" | "staff" | "not_held";

export interface NcaField {
  group: "reporter" | "content" | "content_info" | "user" | "declaration" | "priority";
  id: string;
  label: string;
  value: string | null;
  source: FieldSource;
}

interface CseaUserData {
  username: string | null;
  email: string | null;
  email_verified: boolean;
  dob: string | null;
  registration: { at: string; ip: string | null; port: number | null } | null;
  logins: { at: string; ip: string | null; port: number | null; type: string }[];
  logins_since: string;
  linked_accounts: { type: string; subject: string | null; email: string | null }[];
}

interface CaseEvidence {
  content?: ContentRef | null;
  snapshot?: unknown;
  metadata?: { reported_user_data?: CseaUserData | null } | null;
}

export function ncaDate(iso: string | Date | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`;
}

export function ncaTime(iso: string | Date | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.toISOString().slice(11, 19)} UTC`;
}

export function ncaDateTime(iso: string | Date | null | undefined): string | null {
  const date = ncaDate(iso);
  return date ? `${date} ${ncaTime(iso)}` : null;
}

export function ncaIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const v = ip.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, "");
  if (isIP(v) === 4) return v;
  if (isIP(v) !== 6) return null;
  let addr = v.toLowerCase();
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
  if (v4) {
    const [a, b, c, d] = v4[1]!.split(".").map(Number) as [number, number, number, number];
    addr = addr.slice(0, -v4[1]!.length) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = addr.split("::") as [string, string | undefined];
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const groups = tail === undefined ? h : [...h, ...Array(8 - h.length - t.length).fill("0"), ...t];
  return groups.map((g) => g.padStart(4, "0")).join(":");
}

function ipLine(ip: string | null | undefined, port: number | null | undefined, at: string | null | undefined): string | null {
  const formatted = ncaIp(ip);
  if (!formatted) return null;
  return [formatted, port ? `port ${port}` : "port not recorded", ncaDateTime(at)].filter(Boolean).join(" · ");
}

export function ncaSheet(c: CseaCase, report: Report, evidence: CaseEvidence | null, previousReferences: string[]): NcaField[] {
  const content = evidence?.content ?? report.content ?? null;
  const upload = content?.upload ?? null;
  const user = evidence?.metadata?.reported_user_data ?? null;
  const fromGame = report.game_id ? "game" : "not_held";
  const field = (group: NcaField["group"], id: string, label: string, value: string | null | undefined, fallback: FieldSource): NcaField => ({
    group,
    id,
    label,
    value: value ?? null,
    source: value ? (fallback === "staff" ? "staff" : "qtiauth") : fallback,
  });
  const detection =
    report.source === "flag"
      ? `Automated classifier${report.game_id ? ` in game ${report.game_id}` : ""}`
      : report.source === "game"
        ? `User report submitted through game ${report.game_id ?? ""}`.trim()
        : report.source === "staff"
          ? "Staff review"
          : "User report on the account site";
  const recovery = user?.linked_accounts.filter((a) => a.email && a.email !== user.email).map((a) => `${a.email} (${a.type})`) ?? [];
  const logins = (user?.logins ?? []).map((l) => ipLine(l.ip, l.port, l.at)).filter((l): l is string => Boolean(l));
  return [
    field("priority", "priority_level", "Priority level (1: immediate threat to life or of serious harm; 2: possible serious harm soon or urgent safeguarding; 3: neither)", c.nca_priority ? String(c.nca_priority) : null, "staff"),
    field("reporter", "reporter_name", "Name of the person submitting the report", null, "staff"),
    field("reporter", "reporter_email", "Email address of the person submitting the report", null, "staff"),
    field("reporter", "reporter_phone", "Telephone number with international dialling code", null, "staff"),
    field("content", "content", "The detected CSEA content", evidence?.snapshot ? "Preserved in the evidence below" : content?.url ? `At ${content.url}` : null, fromGame),
    field("content_info", "detection", "How the content was detected, and on what platform", `${detection}${upload?.platform ? ` (${upload.platform})` : ""}`, "qtiauth"),
    field("content_info", "previous_reports", "Previous related NCA reports (reference numbers)", previousReferences.length ? previousReferences.join(", ") : "None", "qtiauth"),
    field("content_info", "uploaded_at", "Date and time of upload", ncaDateTime(upload?.uploaded_at), fromGame),
    field("content_info", "upload_ip", "IP address of the uploading device, port number, and the date and time of that IP", ipLine(upload?.ip, upload?.port, upload?.ip_at ?? upload?.uploaded_at), fromGame),
    field("content_info", "exif", "Linked EXIF data", upload?.exif ? JSON.stringify(upload.exif) : null, fromGame),
    field("content_info", "url", "URL of the page where the content was uploaded", content?.url, fromGame),
    field("content_info", "hash", "Original hash value", upload?.hash ? `${upload.hash.algorithm}: ${upload.hash.value}` : null, fromGame),
    field("user", "username", "Account username", user?.username, "qtiauth"),
    field("user", "billing_name", "Name from billing details", null, "not_held"),
    field("user", "billing_address", "Address from billing details", null, "not_held"),
    field("user", "billing_dob", "Date of birth from billing details (the account's self-declared date of birth is below)", null, "not_held"),
    field("user", "account_dob", "Date of birth given at sign-up (not billing)", ncaDate(user?.dob), "qtiauth"),
    field("user", "email", "Email address", user?.email ? `${user.email}${user.email_verified ? " (verified)" : " (unverified)"}` : null, "qtiauth"),
    field("user", "recovery_email", "Recovery email address", recovery.length ? recovery.join(", ") : null, "not_held"),
    field("user", "phone", "Telephone number, whether verified, and date verified", null, "not_held"),
    field("user", "profile_url", "URL of the user's profile", null, "not_held"),
    field("user", "registration_ip", "Registration IP address, port, date and time", ipLine(user?.registration?.ip, user?.registration?.port, user?.registration?.at), "qtiauth"),
    field("user", "login_ips", `Login IP addresses, ports, dates and times since ${ncaDate(user?.logins_since) ?? "three months before the case"}`, logins.length ? logins.join("\n") : null, "qtiauth"),
    field("declaration", "declaration", "Declaration that all available information has been provided", null, "staff"),
  ];
}
