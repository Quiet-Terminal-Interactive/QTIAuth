import { describe, expect, it } from "vitest";
import { ncaDate, ncaDateTime, ncaIp, ncaSheet, ncaTime } from "../src/nca.ts";
import { retainUntil } from "../src/lib.ts";
import type { CseaCase, Report } from "../src/db.ts";

describe("NCA formatting (SI 2026/268 Schedule 2)", () => {
  it("formats dates as DD/MM/YYYY and times in UTC", () => {
    expect(ncaDate("2026-04-07T09:05:03Z")).toBe("07/04/2026");
    expect(ncaTime("2026-04-07T09:05:03Z")).toBe("09:05:03 UTC");
    expect(ncaDateTime("2026-12-31T23:59:59+01:00")).toBe("31/12/2026 22:59:59 UTC");
    expect(ncaDate(null)).toBeNull();
    expect(ncaDate("not a date")).toBeNull();
  });

  it("writes IPv4 as a dotted quad and IPv6 as eight groups of four hex digits", () => {
    expect(ncaIp("203.0.113.7")).toBe("203.0.113.7");
    expect(ncaIp("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(ncaIp("2001:db8::1")).toBe("2001:0db8:0000:0000:0000:0000:0000:0001");
    expect(ncaIp("::1")).toBe("0000:0000:0000:0000:0000:0000:0000:0001");
    expect(ncaIp("fe80::")).toBe("fe80:0000:0000:0000:0000:0000:0000:0000");
    expect(ncaIp("64:ff9b::192.0.2.33")).toBe("0064:ff9b:0000:0000:0000:0000:c000:0221");
    expect(ncaIp("garbage")).toBeNull();
  });
});

describe("retention", () => {
  it("never goes below the statutory minimum in calendar years", () => {
    const from = new Date("2028-02-29T12:00:00Z");
    expect(retainUntil(from, 0, 1).toISOString()).toBe("2029-03-01T12:00:00.000Z");
    const leap = new Date("2027-03-01T00:00:00Z");
    expect(retainUntil(leap, 365 * 86_400_000, 1).toISOString()).toBe("2028-03-01T00:00:00.000Z");
    expect(retainUntil(from, 3 * 365 * 86_400_000, 1).getTime()).toBe(from.getTime() + 3 * 365 * 86_400_000);
  });
});

describe("NCA report sheet", () => {
  const report = {
    id: "r",
    reference: "R-1",
    source: "game",
    game_id: "g1",
    content: { id: "c1", url: "https://game.example/post/1", upload: { uploaded_at: "2026-05-01T10:00:00Z", ip: "2001:db8::2", port: 51234, hash: { algorithm: "sha256", value: "abcdef0123456789" } } },
  } as unknown as Report;
  const kase = { nca_priority: 2 } as unknown as CseaCase;
  const evidence = {
    snapshot: { text: "…" },
    metadata: {
      reported_user_data: {
        username: "someone",
        email: "a@example.com",
        email_verified: true,
        dob: "2001-02-03",
        registration: { at: "2026-01-01T00:00:00Z", ip: "198.51.100.1", port: 40000 },
        logins: [{ at: "2026-04-30T08:00:00Z", ip: "198.51.100.2", port: null, type: "session.created" }],
        logins_since: "2026-02-01T00:00:00Z",
        linked_accounts: [],
      },
    },
  };
  const sheet = Object.fromEntries(ncaSheet(kase, report, evidence, ["NCA-OLD"]).map((f) => [f.id, f]));

  it("fills what QTIAuth and the game supplied, in the portal's formats", () => {
    expect(sheet.priority_level!.value).toBe("2");
    expect(sheet.uploaded_at!.value).toBe("01/05/2026 10:00:00 UTC");
    expect(sheet.upload_ip!.value).toBe("2001:0db8:0000:0000:0000:0000:0000:0002 · port 51234 · 01/05/2026 10:00:00 UTC");
    expect(sheet.hash!.value).toBe("sha256: abcdef0123456789");
    expect(sheet.registration_ip!.value).toContain("port 40000");
    expect(sheet.login_ips!.value).toContain("port not recorded");
    expect(sheet.account_dob!.value).toBe("03/02/2001");
    expect(sheet.previous_reports!.value).toBe("NCA-OLD");
  });

  it("says who holds what QTIAuth doesn't", () => {
    expect(sheet.exif!.source).toBe("game");
    expect(sheet.billing_name!.source).toBe("not_held");
    expect(sheet.phone!.source).toBe("not_held");
    expect(sheet.reporter_name!.source).toBe("staff");
    expect(sheet.declaration!.source).toBe("staff");
  });
});
