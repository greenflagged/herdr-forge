import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  facetEntries, labelToggle, listQuery, metaScopes, nextSort, orderScopes, scopeOf, scopeTitle, scopeValues, scopedChange,
  skillLine, skillVersion, sorts, splitLabels, togglePick, triageConfig, usesPriority, isAgentAction,
} from "../mods/forge-issues/issues.js";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

test("scopeOf and splitLabels follow the separator", () => {
  assert.deepEqual(scopeOf("priority::high", "::"), ["priority", "high"]);
  assert.deepEqual(scopeOf("a::b::c", "::"), ["a::b", "c"], "the last separator splits, as GitLab does");
  assert.deepEqual(scopeOf("priority: high", ": "), ["priority", "high"]);
  assert.deepEqual(scopeOf("bug", "::"), [null, "bug"]);
  assert.deepEqual(scopeOf("::x", "::"), [null, "::x"], "no scope name: plain");
  assert.deepEqual(splitLabels(["type::bug", "ux", "priority::low"], "::"), { scoped: { type: "bug", priority: "low" }, plain: ["ux"] });
  assert.deepEqual(splitLabels(["type::bug"], ": "), { scoped: {}, plain: ["type::bug"] });
});

test("scopedChange swaps a scope's value and builds labels with the separator", () => {
  const ch = scopedChange(["priority::low", "ux"], "priority", "high", "::");
  assert.deepEqual(ch.fields, { add_labels: ["priority::high"], remove_labels: ["priority::low"] });
  assert.deepEqual(ch.labels, ["ux", "priority::high"]);
  assert.deepEqual(scopedChange(["priority: low"], "priority", "high", ": ").fields.add_labels, ["priority: high"]);
  assert.deepEqual(scopedChange(["priority::low", "ux"], "priority", null, "::"), { fields: { remove_labels: ["priority::low"] }, labels: ["ux"] });
  assert.equal(scopedChange(["priority::low"], "priority", "low", "::"), null, "no change: no write");
  assert.equal(scopedChange(["ux"], "priority", null, "::"), null);
  assert.deepEqual(scopedChange(["a::x", "a::y"], "a", "y", "::").fields, { remove_labels: ["a::x"] }, "duplicates of a scope are cleaned up");
});

test("labelToggle adds and removes, as lists", () => {
  assert.deepEqual(labelToggle(["a"], "b"), { fields: { add_labels: ["b"] }, labels: ["a", "b"] });
  assert.deepEqual(labelToggle(["a", "b"], "a"), { fields: { remove_labels: ["a"] }, labels: ["b"] });
});

test("scope values come from meta labels, priority in its own order", () => {
  const labels = [{ name: "priority::low" }, { name: "type::bug" }, { name: "priority::blocker" }, { name: "priority::p9" }, { name: "ux" }, { name: "type::feature" }];
  assert.deepEqual(scopeValues(labels, "priority", "::"), ["blocker", "low", "p9"]);
  assert.deepEqual(scopeValues(labels, "type", "::", "chore"), ["bug", "feature", "chore"], "the issue's own value stays pickable");
  assert.deepEqual(scopeValues(labels, "type", "::", "bug"), ["bug", "feature"]);
  assert.deepEqual(metaScopes(labels, "::"), ["priority", "type"]);
});

test("orderScopes: props pick and order; else priority, type, then by use", () => {
  assert.deepEqual(orderScopes(["area", "type", "stream", "priority"]), ["priority", "type", "area", "stream"]);
  assert.deepEqual(orderScopes(["area"], null, ["type", "area", "team"]), ["type", "area", "team"]);
  assert.deepEqual(orderScopes(["area", "type"], ["team", "area"]), ["team", "area"]);
  assert.deepEqual(orderScopes(["area", "type"], []), [], "an empty list shows no scope facets");
  assert.deepEqual(orderScopes(), []);
  assert.equal(scopeTitle("work-stream"), "Work stream");
});

test("facetEntries: priority and triage in their order, (none) last, picked kept", () => {
  const counts = {
    "scope:priority": { low: 5, "(none)": 9, blocker: 1, high: 3 },
    "scope:area": { db: 2, api: 7, "(none)": 1, cli: 2 },
    triage: { ranked: 4, "proposed change": 2, "(none)": 3 },
  };
  assert.deepEqual(facetEntries(counts, "scope:priority").map(([v]) => v), ["blocker", "high", "low", "(none)"]);
  assert.deepEqual(facetEntries(counts, "scope:area").map(([v]) => v), ["api", "cli", "db", "(none)"]);
  assert.deepEqual(facetEntries(counts, "triage").map(([v]) => v), ["proposed change", "ranked", "(none)"]);
  assert.deepEqual(facetEntries(counts, "milestone", ["M1"]), [["M1", 0]]);
  assert.deepEqual(facetEntries({}, "labels"), []);
});

test("togglePick and listQuery", () => {
  let p = togglePick({}, "scope:type", "bug");
  p = togglePick(p, "milestone", "M1");
  p = togglePick(p, "milestone", "M1");
  assert.deepEqual(p, { "scope:type": ["bug"], milestone: [] });
  const q = JSON.parse(listQuery({ state: "opened", q: "x", picked: p, sort: "priority", offset: 0, limit: 150 }));
  assert.deepEqual(q, { state: "opened", q: "x", picked: { "scope:type": ["bug"] }, sort: "priority", offset: 0, limit: 150 });
  assert.equal(JSON.parse(listQuery({ picked: {}, sep: ": " })).sep, ": ");
});

test("sorts: Triage rank only with triage on", () => {
  assert.deepEqual(sorts(false).map((s) => s.id), ["priority", "updated", "created"]);
  assert.equal(nextSort("created", false), "priority");
  assert.equal(nextSort("created", true), "triage");
  assert.equal(nextSort("triage", false), "priority", "a sort that's gone starts over");
});

test("triageConfig: off unless set", () => {
  assert.equal(triageConfig(undefined), null);
  assert.equal(triageConfig(false), null);
  assert.deepEqual(triageConfig(true), { agent: "claude", tab: "triage", task: "/triage-issues {provider} {host} {repo}" });
  assert.deepEqual(triageConfig({ agent: "codex", tab: "t" }), { agent: "codex", tab: "t", task: "/triage-issues {provider} {host} {repo}" });
});

test("skillLine offers Install only when missing or older", () => {
  assert.equal(skillLine({ installed: false }).install, "Install skill");
  assert.equal(skillLine({ installed: true, older: true, version: "0.0.9" }).install, "Update skill");
  assert.equal(skillLine({ installed: true, older: false, current: true }).install, null);
  assert.equal(skillLine({ installed: true, older: false, current: false, version: "0.2.0" }).install, null, "never downgrade");
  assert.equal(skillLine({ error: "boom" }).install, null);
  assert.equal(skillLine(null).install, null);
});

test("the shipped skill carries the package version and the stable CLI form", () => {
  const skill = read("../mods/forge-issues/skills/triage-issues/SKILL.md");
  const { version } = JSON.parse(read("../package.json"));
  assert.equal(skillVersion(skill), version);
  assert.match(skill, /~\/\.local\/share\/herdr-forge\/forge\.py (sync|context|show|propose) <provider> <host> <project>/);
  assert.doesNotMatch(skill, /gf-issues|sync\.py|greenflagged/);
  const main = read("../mods/forge-issues/main.js");
  assert.doesNotMatch(main, /gf\.|gf-issues|setTimeout|setInterval/);
});

test("usesPriority and isAgentAction", () => {
  assert.equal(usesPriority({ "scope:priority": { "(none)": 4 } }, [], "::"), false);
  assert.equal(usesPriority({ "scope:priority": { high: 1 } }, [], "::"), true);
  assert.equal(usesPriority({}, [{ name: "priority::low" }], "::"), true);
  assert.equal(isAgentAction({ task: "" }), true);
  assert.equal(isAgentAction({ agent: "codex" }), true);
  assert.equal(isAgentAction({ exec: ["x"] }), false);
});
