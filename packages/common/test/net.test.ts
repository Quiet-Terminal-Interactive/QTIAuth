import { describe, expect, it } from "vitest";
import { clientPort } from "../src/net.ts";

describe("clientPort", () => {
  it("uses the socket's port when there is no trusted proxy", () => {
    expect(clientPort("203.0.113.9", 51000, "1234", [])).toBe(51000);
  });

  it("reads the header only from a trusted proxy", () => {
    expect(clientPort("10.0.0.5", 33000, "51234", ["10.0.0.0/8"])).toBe(51234);
    expect(clientPort("203.0.113.9", 33000, "51234", ["10.0.0.0/8"])).toBe(33000);
  });

  it("rejects invalid header values rather than recording the proxy's port", () => {
    expect(clientPort("10.0.0.5", 33000, "0", ["10.0.0.0/8"])).toBeNull();
    expect(clientPort("10.0.0.5", 33000, "70000", ["10.0.0.0/8"])).toBeNull();
    expect(clientPort("10.0.0.5", 33000, null, ["10.0.0.0/8"])).toBeNull();
  });
});
