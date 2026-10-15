const FIELDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day of week", min: 0, max: 7 },
] as const;

const MACROS: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

export class CronError extends Error {}

export interface CronSchedule {
  source: string;
  minutes: Set<number>;
  hours: Set<number>;
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
  daysRestricted: boolean;
  weekdaysRestricted: boolean;
}

function parseField(text: string, f: (typeof FIELDS)[number]): Set<number> {
  const out = new Set<number>();
  for (const part of text.split(",")) {
    const m = /^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/.exec(part);
    if (!m) throw new CronError(`Invalid ${f.name} "${part}"`);
    const step = m[3] ? Number(m[3]) : 1;
    if (step < 1) throw new CronError(`Invalid step in ${f.name} "${part}"`);
    let lo: number;
    let hi: number;
    if (m[1] === "*") {
      if (m[2]) throw new CronError(`Invalid ${f.name} "${part}"`);
      lo = f.min;
      hi = f.max;
    } else {
      lo = Number(m[1]);
      hi = m[2] ? Number(m[2]) : m[3] ? f.max : lo;
    }
    if (lo < f.min || hi > f.max || lo > hi) throw new CronError(`${f.name} out of range in "${part}"`);
    for (let v = lo; v <= hi; v += step) out.add(f.name === "day of week" && v === 7 ? 0 : v);
  }
  return out;
}

export function parseCron(expr: string): CronSchedule {
  const source = MACROS[expr.trim()] ?? expr.trim();
  const parts = source.split(/\s+/);
  if (parts.length !== 5) throw new CronError(`Expected 5 fields, got ${parts.length} in "${expr}"`);
  const [mi, h, d, mo, w] = parts.map((p, i) => parseField(p, FIELDS[i]!)) as [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>];
  return { source: expr, minutes: mi, hours: h, days: d, months: mo, weekdays: w, daysRestricted: parts[2] !== "*", weekdaysRestricted: parts[4] !== "*" };
}

export function cronMatches(s: CronSchedule, at: Date): boolean {
  if (!s.minutes.has(at.getUTCMinutes()) || !s.hours.has(at.getUTCHours()) || !s.months.has(at.getUTCMonth() + 1)) return false;
  const dom = s.days.has(at.getUTCDate());
  const dow = s.weekdays.has(at.getUTCDay());
  if (s.daysRestricted && s.weekdaysRestricted) return dom || dow;
  if (s.daysRestricted) return dom;
  if (s.weekdaysRestricted) return dow;
  return true;
}

export function nextRun(s: CronSchedule, after: Date, limitMinutes = 366 * 24 * 60): Date | null {
  const t = new Date(Math.floor(after.getTime() / 60_000) * 60_000 + 60_000);
  for (let i = 0; i < limitMinutes; i++) {
    if (cronMatches(s, t)) return t;
    t.setTime(t.getTime() + 60_000);
  }
  return null;
}
