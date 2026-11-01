// The names agents.js and cleanup.js list as PROMISED (docs/contract.md "Sharing code with
// other packages"): other packages call them, so each must really be exported. Renaming one
// fails here until its PROMISED entry changes too, which is when to name it in the PR.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as agents from "../shared/agents.js";
import * as cleanup from "../shared/cleanup.js";

test("every PROMISED name is exported, as a function", () => {
  for (const [file, mod] of [["agents", agents], ["cleanup", cleanup]]) {
    assert.ok(mod.PROMISED.length > 0, file);
    for (const name of mod.PROMISED) assert.equal(typeof mod[name], "function", `${file}.js ${name}`);
  }
  assert.ok(cleanup.PROMISED.includes("leftoversOf"));
  for (const s of ["lookState", "checkState", "worktreeState"]) assert.ok([...agents.PROMISED, ...cleanup.PROMISED].includes(s), s);
});

test("the promised state shapes", () => {
  assert.deepEqual(Object.keys(agents.lookState()).sort(), ["git", "looking"]);
  assert.deepEqual(Object.keys(cleanup.checkState()).sort(), ["checking", "checks"]);
  assert.deepEqual(Object.keys(cleanup.worktreeState()).sort(), ["at", "folder", "list", "machine", "pending"]);
});
