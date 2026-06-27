import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { selectSoleOrganizeImportsAction } from "./organizeImports";

describe("selectSoleOrganizeImportsAction", () => {
  it("reports that no organizer is available", () => {
    assert.deepEqual(selectSoleOrganizeImportsAction([]), { kind: "unavailable" });
  });

  it("selects the sole organizer", () => {
    const action = { name: "Ruff" };

    assert.deepEqual(selectSoleOrganizeImportsAction([action]), { kind: "found", action });
  });

  it("reports multiple organizers as ambiguous", () => {
    assert.deepEqual(selectSoleOrganizeImportsAction([{ name: "Ruff" }, { name: "isort" }]), {
      kind: "ambiguous",
      count: 2,
    });
  });
});
