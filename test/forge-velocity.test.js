import assert from "node:assert/strict";
import { test } from "node:test";
import { bucketLabel, delta, heights, prepare, BAR, DAY } from "../mods/forge-velocity/view.js";
import { TERMS } from "../shared/lib.js";

const commits = { n: 12, size: 7 * DAY, start: 1000, at: 5, row: { key: "commits", values: [0, 2, 4, 1, 0, 0, 0, 0, 0, 0, 0, 8], now: 8, avg: 1.25 } };
const velocity = { n: 12, size: 7 * DAY, start: 1000, at: 5, rows: [
  { key: "merged", values: Array(12).fill(1), now: 1, avg: 1 },
  { key: "closed", values: Array(12).fill(0), now: 0, avg: 0 },
  { key: "cycle", unit: "duration", lowerBetter: true, values: [null, 3600000, ...Array(10).fill(7200000)], now: 3600000, avg: 7200000 },
] };

test("prepare names rows from the forge's terms and keeps forge.py's order", () => {
  const v = prepare(commits, velocity, TERMS.github, true, "12w");
  assert.deepEqual(v.rows.map((r) => r.label), ["Commits", "PRs merged", "Issues closed", "PR cycle time"]);
  assert.deepEqual(v.rows.map((r) => r.color), ["accent", "ansi5", "ansi2", "ansi3"]);
  assert.equal(v.rows[0].total, 15);
  assert.equal(v.rows[0].headline, "8");
  assert.equal(v.rows[3].headline, "1h");
  assert.equal(v.rows[3].shown[0], "–");
  assert.equal(v.start, 1000);
});

test("prepare without a forge shows commits only, and placeholders before answers", () => {
  assert.equal(prepare(commits, null, TERMS.gitlab, false, "12w").rows.length, 1);
  const empty = prepare(null, null, TERMS.gitlab, true, "30d");
  assert.equal(empty.n, 30);
  assert.equal(empty.rows.length, 4);
  assert.equal(empty.rows[3].unit, "duration");
  assert.ok(empty.rows.every((r) => r.values.length === 30 && r.headline === "–"));
  assert.equal(empty.start, null);
});

test("heights scale to the bar and leave stubs for empty buckets", () => {
  assert.deepEqual(heights([0, 5, 10, null]), [2, 11, BAR, 1]);
  assert.deepEqual(heights([1, 100], "duration"), [2, BAR], "durations use a square-root scale");
});

test("delta compares the last week with the average", () => {
  assert.deepEqual(delta({ now: 8, avg: 4 }), { text: "↑100%", tone: "good" });
  assert.deepEqual(delta({ now: 1, avg: 2, lowerBetter: true, unit: "duration" }), { text: "↓50%", tone: "good" });
  assert.equal(delta({ now: 1, avg: 0.5 }), null, "under one a week says nothing");
  assert.deepEqual(delta({ now: 10, avg: 10.2 }), { text: "≈ avg", tone: "dim" });
});

test("bucketLabel names days and weeks", () => {
  const start = new Date(2026, 9, 1).getTime();
  assert.equal(bucketLabel(0, { n: 30, size: DAY, start }), "Thu Oct 1");
  assert.equal(bucketLabel(29, { n: 30, size: DAY, start }), "Today");
  assert.equal(bucketLabel(0, { n: 12, size: 7 * DAY, start }), "Oct 1 – Oct 7");
  assert.equal(bucketLabel(0, { n: 12, size: null, start: null }), "");
});
