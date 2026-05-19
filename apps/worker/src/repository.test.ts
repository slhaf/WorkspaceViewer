import { describe, expect, it } from "vitest";
import { parseLanguages } from "./repository.js";

describe("repository helpers", () => {
  it("parses workspace languages defensively", () => {
    expect(parseLanguages('["typescript","python"]')).toEqual(["typescript", "python"]);
    expect(parseLanguages('"typescript"')).toBeUndefined();
    expect(parseLanguages("not-json")).toBeUndefined();
    expect(parseLanguages(null)).toBeUndefined();
  });
});
