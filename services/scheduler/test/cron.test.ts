import { describe, expect, it } from "vitest";
import { cronMatches, nextRun, parseCron } from "../src/cron.ts";
import { compileSchedule, tickId } from "../src/service.ts";

const at = (iso: string) => new Date(`${iso}Z`);

describe("cron", () => {
  it("matches fixed times in UTC", () => {
    const s = parseCron("30 3 * * *");
    expect(cronMatches(s, at("2026-10-14T03:30:00"))).toBe(true);
    expect(cronMatches(s, at("2026-10-14T03:31:00"))).toBe(false);
    expect(cronMatches(s, at("2026-10-14T04:30:00"))).toBe(false);
  });

  it("supports steps, ranges and lists", () => {
    const s = parseCron("*/5 9-17 * * 1-5");
    expect(cronMatches(s, at("2026-10-14T09:05:00"))).toBe(true);
    expect(cronMatches(s, at("2026-10-14T09:07:00"))).toBe(false);
    expect(cronMatches(s, at("2026-10-18T09:05:00"))).toBe(false);
    const l = parseCron("0 0,12 * * *");
    expect(cronMatches(l, at("2026-10-14T12:00:00"))).toBe(true);
  });

  it("treats day-of-month and day-of-week as OR when both are restricted", () => {
    const s = parseCron("0 0 1 * 1");
    expect(cronMatches(s, at("2026-10-01T00:00:00"))).toBe(true);
    expect(cronMatches(s, at("2026-10-12T00:00:00"))).toBe(true);
    expect(cronMatches(s, at("2026-10-13T00:00:00"))).toBe(false);
  });

  it("accepts 7 as Sunday and macros", () => {
    expect(cronMatches(parseCron("0 0 * * 7"), at("2026-10-18T00:00:00"))).toBe(true);
    expect(cronMatches(parseCron("@hourly"), at("2026-10-18T05:00:00"))).toBe(true);
  });

  it("computes the next run", () => {
    expect(nextRun(parseCron("0 9 * * 1"), at("2026-10-14T10:00:00"))?.toISOString()).toBe("2026-10-19T09:00:00.000Z");
  });

  it("rejects invalid expressions with the field name", () => {
    expect(() => parseCron("61 * * * *")).toThrow(/minute/);
    expect(() => parseCron("* * *")).toThrow(/5 fields/);
    expect(() => compileSchedule({ "x.job": "0 25 * * *" })).toThrow(/schedule\.x\.job/);
  });

  it("derives the same tick id per job and minute so replicas deduplicate", () => {
    expect(tickId("retention.sweep", at("2026-10-14T03:00:00"))).toBe(tickId("retention.sweep", at("2026-10-14T03:00:00")));
    expect(compileSchedule({ a: "off", b: "* * * * *" }).size).toBe(1);
  });
});
