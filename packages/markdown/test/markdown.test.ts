import { describe, expect, it } from "vitest";
import { renderMarkdown, slugify } from "../src/index.ts";

describe("renderMarkdown", () => {
  it("escapes raw HTML", () => {
    expect(renderMarkdown("<script>alert(1)</script>")).not.toContain("<script>");
  });
  it("drops javascript links", () => {
    expect(renderMarkdown("[x](javascript:alert(1))")).not.toContain("href=\"javascript");
  });
  it("marks external links noopener", () => {
    expect(renderMarkdown("[x](https://example.com)")).toContain('rel="noopener noreferrer nofollow ugc"');
  });
  it("slugifies", () => {
    expect(slugify("Héllo, World!")).toBe("hello-world");
  });
});
