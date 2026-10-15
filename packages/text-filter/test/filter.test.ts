import { describe, expect, it, beforeAll } from "vitest";
import { join } from "node:path";
import { filterFromDirectory, normalize, tokenize, collapseSingletons, TextFilter } from "../src/index.ts";

const dir = join(import.meta.dirname, "../../../config/lists/username");
let filter: TextFilter;

beforeAll(() => {
  filter = filterFromDirectory(dir).filter;
});

describe("normalize", () => {
  it("applies leet map but never maps 1 to i", () => {
    expect(normalize("h3ll0")).toBe("hello");
    expect(normalize("user1")).toBe("user1");
  });
  it("strips zero-width characters and maps confusables", () => {
    expect(normalize("pa​ss")).toBe("pass");
    expect(normalize("раss")).toBe("pass");
    expect(normalize("ＡＢＣ")).toBe("abc");
  });
  it("never collapses repeated letters", () => {
    expect(normalize("assassin")).toBe("assassin");
  });
});

describe("tokenize", () => {
  it("splits on underscores, digits and camelCase and collapses singletons", () => {
    expect(tokenize("coolGamer_99x")).toEqual(["cool", "Gamer", "x"]);
    expect(collapseSingletons(tokenize("c_u_n_t"))).toEqual(["cunt"]);
  });
});

describe("filter", () => {
  it("allows Scunthorpe via the dictionary", () => {
    expect(filter.check("Scunthorpe").action).toBe("allow");
    expect(filter.check("ScunthorpeFan").action).toBe("allow");
  });
  it("allows classic, assassin, user1 and ordinary names", () => {
    for (const name of ["classic", "Assassin", "user1", "PassMaster", "Cassandra", "Penistone", "Shitterton"]) {
      expect(filter.check(name).action, name).toBe("allow");
    }
  });
  it("blocks exact matches and spaced-out singletons", () => {
    expect(filter.check("ass").action).toBe("block");
    expect(filter.check("c_u_n_t").action).toBe("block");
    expect(filter.check("c_u_n_t").rule).toBe("token_block");
  });
  it("blocks loose entries padded with digits, separators or x runs", () => {
    const loose = [...filter.Bloose][0]!;
    expect(filter.check(`xxx${loose}xxx`).action).toBe("block");
    expect(filter.check(`${loose}123`).action).toBe("block");
  });
  it("blocks B_exact as a whole token but never as a substring", () => {
    expect(filter.check("big_ass").action).toBe("block");
    expect(filter.check("bigass").action).toBe("allow");
  });
  it("defeats leetspeak and confusables on whole strings", () => {
    expect(filter.check("a55").action).toBe("block");
    expect(filter.check("аss").action).toBe("block");
  });
  it("honours the allowlist before everything else", () => {
    const f = new TextFilter({ ldnoobw: ["badword"], dictionary: [], allow: ["badword"] });
    expect(f.check("badword").rule).toBe("allowlist");
  });
  it("classifies short and dictionary LDNOOBW entries as B_exact", () => {
    const f = new TextFilter({ ldnoobw: ["ass", "twogirlsonecup", "anal"], dictionary: ["anal"] });
    expect(f.Bexact.has("ass")).toBe(true);
    expect(f.Bexact.has("anal")).toBe(true);
    expect(f.Bloose.has("twogirlsonecup")).toBe(true);
  });
  it("logs unknowns as allow/unknown", () => {
    expect(filter.check("zxqvbnmplk").rule).toBe("unknown");
  });
});
