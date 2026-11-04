import { expect, it } from "vitest";

import { compareInventory } from "../../../src/mcpDoctor.js";

it("reports exact missing, unexpected, and duplicate inventory names", () => {
  expect(compareInventory(["a", "b"], ["b", "c", "c"])).toEqual({
    expected: 2,
    observed: 3,
    missing: ["a"],
    unexpected: ["c"],
    duplicates: ["c"],
  });
});
