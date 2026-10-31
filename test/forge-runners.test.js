import assert from "node:assert/strict";
import { test } from "node:test";
import { arrange, pollEvery } from "../mods/forge-runners/runners.js";

test("forge-runners polls fast only while jobs run or wait and the window is active", () => {
  assert.equal(pollEvery([{ id: 1 }], true), 20);
  assert.equal(pollEvery([{ id: 1 }], false), 60);
  assert.equal(pollEvery([], true), 60);
});

test("forge-runners arranges an answer: runners sorted with their jobs, elsewhere, queued", () => {
  const answer = {
    runners: [
      { id: 1, name: "zeta", status: "online", paused: false, running: [10] },
      { id: 2, name: "alpha", status: "offline", paused: false, running: [] },
      { id: 3, name: "beta", status: "online", paused: true, running: [99] },
      { id: 4, name: "gamma", status: "online", paused: false },
    ],
    jobs: [
      { id: 10, status: "running", elsewhere: false },
      { id: 11, status: "running", elsewhere: true },
      { id: 12, status: "pending", created_ms: 300, stuck: true },
      { id: 13, status: "pending", created_ms: 100, stuck: false },
    ],
  };
  const v = arrange(answer);
  assert.deepEqual(v.runners.map((r) => r.name), ["beta", "gamma", "zeta", "alpha"], "online first, then by name");
  assert.deepEqual(v.runners.find((r) => r.id === 1).jobs.map((j) => j.id), [10]);
  assert.deepEqual(v.runners.find((r) => r.id === 3).jobs, [], "an id not in jobs is dropped");
  assert.equal(v.up, 2, "online and not paused");
  assert.deepEqual(v.elsewhere.map((j) => j.id), [11]);
  assert.deepEqual(v.queued.map((j) => j.id), [13, 12], "oldest first");
  assert.deepEqual(arrange(null), { runners: [], up: 0, elsewhere: [], queued: [] });
});
