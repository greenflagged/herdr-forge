import assert from "node:assert/strict";
import { test } from "node:test";
import { groupJobs, jobsStale, pollEvery } from "../mods/forge-ci/ci.js";

test("forge-ci polls fast only while a recent pipeline is live and the window is active", () => {
  const now = 10 * 3600000;
  const running = { status: "running", updated_ms: now - 60000 };
  assert.equal(pollEvery([running], true, now), 10);
  assert.equal(pollEvery([running], false, now), 60, "window in the background");
  assert.equal(pollEvery([{ status: "pending", updated_ms: now - 3 * 3600000 }], true, now), 60, "stuck for hours");
  assert.equal(pollEvery([{ status: "success", updated_ms: now }], true, now), 60);
  assert.equal(pollEvery([{ status: "running", updated_ms: null }], true, now), 60);
  assert.equal(pollEvery([], true, now), 60);
});

test("forge-ci groups jobs by group in order of first appearance", () => {
  const jobs = [
    { id: 1, group: "build" }, { id: 2, group: "test" }, { id: 3, group: "build" }, { id: 4, group: null },
  ];
  assert.deepEqual(groupJobs(jobs).map((g) => [g.group, g.jobs.map((j) => j.id)]), [["build", [1, 3]], ["test", [2]], ["", [4]]]);
  assert.deepEqual(groupJobs(undefined), []);
});

test("forge-ci reloads an expanded pipeline's jobs when they could have changed", () => {
  const done = { status: "success", updated_ms: 5 };
  assert.equal(jobsStale(done, null), true, "never read");
  assert.equal(jobsStale(done, { status: "success", updated_ms: 5 }), false);
  assert.equal(jobsStale(done, { status: "running", updated_ms: 4 }), true, "finished since");
  assert.equal(jobsStale({ status: "running", updated_ms: 5 }, { status: "running", updated_ms: 5 }), true, "still running");
});
