import { inc, setGauge } from "@qtiauth/common";
import { cronSubject, makeEvent } from "@qtiauth/bus";
import { defineService, type ServiceContext } from "@qtiauth/service-kit";
import { CronError, cronMatches, nextRun, parseCron, type CronSchedule } from "./cron.ts";

const MAX_CATCH_UP_MINUTES = 5;

interface Job {
  name: string;
  schedule: CronSchedule;
  lastTick: string | null;
}

let timer: NodeJS.Timeout | null = null;
const jobs = new Map<string, Job>();

export function compileSchedule(schedule: Record<string, string>): Map<string, Job> {
  const out = new Map<string, Job>();
  const errors: string[] = [];
  for (const [name, expr] of Object.entries(schedule)) {
    if (!expr || expr === "off") continue;
    try {
      out.set(name, { name, schedule: parseCron(expr), lastTick: null });
    } catch (err) {
      errors.push(`schedule.${name}: ${err instanceof CronError ? err.message : String(err)}`);
    }
  }
  if (errors.length) throw new Error(`Invalid schedule:\n  - ${errors.join("\n  - ")}`);
  return out;
}

export function tickId(job: string, minute: Date): string {
  return `cron-${job}-${minute.toISOString().slice(0, 16)}`;
}

export async function publishTick(ctx: ServiceContext, job: string, minute: Date, manual = false): Promise<void> {
  const env = makeEvent(cronSubject(job), { job, scheduled_at: minute.toISOString(), manual }, { subject: { type: "cron", id: job }, actor: { type: "system", id: "scheduler" } });
  env.event_id = manual ? env.event_id : tickId(job, minute);
  await ctx.bus.publishEvent(env);
  inc("qtiauth_scheduler_ticks_total", { job, manual: String(manual) }, 1, "Cron ticks published");
}

async function runMinute(ctx: ServiceContext, minute: Date): Promise<void> {
  for (const job of jobs.values()) {
    if (!cronMatches(job.schedule, minute)) continue;
    try {
      await publishTick(ctx, job.name, minute);
      job.lastTick = minute.toISOString();
    } catch (err) {
      inc("qtiauth_scheduler_tick_failures_total", { job: job.name }, 1, "Cron ticks that failed to publish");
      ctx.log.error({ err, job: job.name }, "failed to publish cron tick");
    }
  }
  setGauge("qtiauth_scheduler_last_tick_timestamp_seconds", minute.getTime() / 1000, {}, "Minute of the last scheduler tick");
}

function startLoop(ctx: ServiceContext): void {
  let last = Math.floor(Date.now() / 60_000) * 60_000;
  const schedule = () => {
    const delay = 60_000 - (Date.now() % 60_000) + 50;
    timer = setTimeout(async () => {
      const now = Math.floor(Date.now() / 60_000) * 60_000;
      const from = Math.max(last + 60_000, now - (MAX_CATCH_UP_MINUTES - 1) * 60_000);
      for (let m = from; m <= now; m += 60_000) await runMinute(ctx, new Date(m));
      last = now;
      schedule();
    }, delay);
    timer.unref();
  };
  schedule();
}

export const schedulerService = defineService({
  name: "scheduler",
  async init(ctx) {
    for (const [k, v] of compileSchedule(ctx.config.schedule)) jobs.set(k, v);
  },
  async start(ctx) {
    ctx.bus.handle("scheduler.jobs", async () => ({
      timezone: "UTC",
      jobs: [...jobs.values()].map((j) => ({ name: j.name, schedule: j.schedule.source, last_tick: j.lastTick, next_run: nextRun(j.schedule, new Date())?.toISOString() ?? null })),
    }));
    ctx.bus.handle<{ job: string }, unknown>("scheduler.trigger", async (req) => {
      if (!jobs.has(req.job) && req.job !== "retention.sweep") return { triggered: false };
      await publishTick(ctx, req.job, new Date(), true);
      return { triggered: true };
    });
    startLoop(ctx);
    ctx.log.info({ jobs: [...jobs.keys()] }, "schedule loaded (UTC)");
  },
  async shutdown() {
    if (timer) clearTimeout(timer);
  },
});
