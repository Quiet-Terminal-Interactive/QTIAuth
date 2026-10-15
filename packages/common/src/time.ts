const UNITS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
  y: 31_536_000_000,
};

export const DURATION_RE = /^(\d+(?:\.\d+)?)(ms|s|m|h|d|w|y)$/;

export function parseDuration(input: string | number): number {
  if (typeof input === "number") return input;
  const parts = input.trim().split(/\s+/);
  let total = 0;
  for (const part of parts) {
    const m = DURATION_RE.exec(part);
    if (!m) throw new Error(`Invalid duration "${input}"`);
    total += Number(m[1]) * UNITS[m[2]!]!;
  }
  return total;
}

export function seconds(ms: number): number {
  return Math.floor(ms / 1000);
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function iso(d: Date | string | number | null | undefined): string | null {
  if (d === null || d === undefined) return null;
  return new Date(d).toISOString();
}

export function addMs(d: Date, ms: number): Date {
  return new Date(d.getTime() + ms);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function ageOn(dob: string | Date, on: Date = new Date()): number {
  const d = typeof dob === "string" ? new Date(`${dob.slice(0, 10)}T00:00:00Z`) : dob;
  let age = on.getUTCFullYear() - d.getUTCFullYear();
  const m = on.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && on.getUTCDate() < d.getUTCDate())) age--;
  return age;
}

export function birthdayOnOrAfter(dob: string, years: number): Date {
  const d = new Date(`${dob.slice(0, 10)}T00:00:00Z`);
  const target = new Date(Date.UTC(d.getUTCFullYear() + years, d.getUTCMonth(), d.getUTCDate()));
  if (target.getUTCMonth() !== d.getUTCMonth()) return new Date(Date.UTC(d.getUTCFullYear() + years, d.getUTCMonth() + 1, 1));
  return target;
}
