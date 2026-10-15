import { describe, expect, it } from "vitest";
import { findViolations } from "../../../scripts/check-literals.ts";

describe("check-literals", () => {
  it("allows placeholder and third-party API hosts", () => {
    expect(findViolations(`const a = "https://me.example.com/x"; fetch("https://api.pwnedpasswords.com/range/")`, [])).toEqual([]);
  });

  it("flags unknown domains, reserved prefixes and extra deployment literals", () => {
    expect(findViolations(`const u = "https://account.mycompany.co.uk/";`, [])[0]?.message).toContain("account.mycompany.co.uk");
    expect(findViolations("reserved_prefixes: ['QTI_']")).toHaveLength(1);
    expect(findViolations('name: "Acme Games"', [{ pattern: /acme games/i, reason: "brand" }])).toHaveLength(1);
  });

  it("honours an explicit allow marker", () => {
    expect(findViolations(`fetch("https://api.somevendor.io/v1") // check-literals: allow`, [])).toEqual([]);
  });
});
