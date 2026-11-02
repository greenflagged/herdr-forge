// Exercise the real view's async query methods without GPUI. Only platform imports are
// removed; the method bodies under test are the installed UI's code.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import * as logic from "../mods/forge-issues/issues.js";
import { projectOf } from "../shared/lib.js";

const source = readFileSync(new URL("../mods/forge-issues/main.js", import.meta.url), "utf8")
  .replace(/^import[\s\S]*?from "[^"]+";\n/gm, "")
  .replace("export default class Issues", "return class Issues");
function makeClass(p = {}, state = new Map(), rpc = async () => ({})) {
  class Input {
    constructor() { this.text = ""; this.events = {}; }
    static new() { return new Input(); }
    set_value(v) { this.text = v; }
    value() { return this.text; }
    on(event, fn) { this.events[event] = fn; }
  }
  const platform = { ...logic, projectOf, View: class {}, props: () => p,
    shared: (key) => state.get(key), setShared: (key, value) => state.set(key, value),
    Chrome: class { attach() {} visible() { return true; } },
    InputState: Input, TextareaState: Input, VirtualListScrollHandle: { new: () => ({}) },
    window: () => ({ active: true }), forgeClient: () => rpc, exec() {}, readTextFile() {}, appHome: () => "/app" };
  return new Function(...Object.keys(platform), source)(...Object.values(platform));
}
const Issues = makeClass();
const view = () => Object.assign(new Issues(), {
  state: "opened", query: "login", picked: {}, sort: "updated", person: "all",
  rows: [], matched: 0, total: 0, seq: 0, paging: false, picker: { open: null },
  ready: () => true,
});

test("Everyone does not need identity; personal queries use the forge's login", async () => {
  const v = view(), calls = [];
  v.py = async (args) => { calls.push(args); return { user: "sam" }; };
  assert.equal(JSON.parse(await v.queryJson(0)).person, undefined);
  assert.equal(calls.length, 0);
  for (const person of ["assigned", "created"]) {
    v.person = person;
    const q = JSON.parse(await v.queryJson(150));
    assert.deepEqual([q.person, q.user, q.offset, q.q], [person, "sam", 150, "login"]);
    assert.deepEqual(calls.at(-1), ["whoami", 3600, 0]);
  }
  assert.equal(calls.length, 1, "switching filters and paging reuses the login");
});

test("identity failures never issue an unfiltered query, and retry recovers", async () => {
  const v = view();
  v.person = "assigned";
  const calls = [];
  v.py = async (args) => { calls.push(args); return { error: "Not signed in" }; };
  await v.loadList(0);
  assert.equal(v.loadFailed, true);
  assert.match(v.listError, /signed-in account: Not signed in/);
  assert.deepEqual(calls, [["whoami", 3600, 0]]);
  v.py = async ([cmd]) => cmd === "whoami" ? { user: "sam" } : { rows: [[7, "mine"]], matched: 1, total: 1 };
  await v.loadList(0);
  assert.equal(v.listError, null);
  assert.equal(v.loadFailed, false);
  assert.equal(v.rows[0][0], 7);
});

test("switching people clears old rows and invalidates a delayed personal query", async () => {
  const v = view();
  v.person = "assigned";
  let release;
  const identity = new Promise((resolve) => { release = resolve; });
  v.py = async ([cmd, json]) => cmd === "whoami" ? identity
    : { rows: [[JSON.parse(json).person ? 1 : 2, "issue"]], matched: 1, total: 1 };
  v.seq = 1;
  const old = v.loadList(1);
  v.rows = [[9, "previous"]]; v.matched = 1;
  v.setDetail = (d) => { v.detail = d; };
  let fresh;
  v.setPerson("all", { spawn: (fn) => { fresh = fn({ notify() {} }); }, notify() {} });
  assert.deepEqual(v.rows, []);
  assert.equal(v.selected, null);
  await fresh;
  assert.equal(v.rows[0][0], 2);
  release({ user: "sam" });
  await old;
  assert.equal(v.rows[0][0], 2, "the previous filter's late answer is discarded");
});

test("pagination retains the personal filter and never queries without an identity", async () => {
  const v = view();
  v.person = "created"; v.rows = [[1]]; v.matched = 2;
  const calls = [];
  v.py = async (args) => {
    calls.push(args);
    return args[0] === "whoami" ? { user: "sam" } : { rows: [[2]] };
  };
  let pending;
  v.more({ spawn: (fn) => { pending = fn({ notify() {} }); } });
  await pending;
  assert.deepEqual(v.rows, [[1], [2]]);
  const q = JSON.parse(calls[1][1]);
  assert.deepEqual([q.person, q.user, q.offset], ["created", "sam", 1]);
});

function context() {
  const tasks = [], timers = [];
  const cx = { notify() {}, focus_handle: () => ({ focus() {} }),
    spawn: (fn) => tasks.push(fn), timer: { every: (ms, fn) => timers.push([ms, fn]) } };
  return { cx, timers, flush: async () => { while (tasks.length) await tasks.shift()(cx); } };
}

test("filters and cached first page survive new view instances and restart", async () => {
  const state = new Map(), calls = [];
  const meta = { labels: [{ name: "bug" }], milestones: [], last_sync: Date.now() / 1000,
    now: Date.now() / 1000, more: false, user: "sam", user_at: Date.now() / 1000 };
  const rpc = async ([cmd, ...args]) => {
    calls.push([cmd, ...args]);
    if (cmd === "meta") return meta;
    if (cmd === "bootstrap") return { ...meta, list: { rows: [[7, "cached issue"]], matched: 1, total: 1, counts: { labels: { bug: 1 } }, scopes: [] } };
    if (cmd === "query") return { rows: [[7, "cached issue"]], matched: 1, total: 1, counts: { labels: { bug: 1 } }, scopes: [] };
    throw new Error(`Unexpected network command: ${cmd}`);
  };
  const C = makeClass({ provider: "github", repo: "acme/shop" }, state, rpc);
  const first = new C(), a = context();
  first.init({}, a.cx);
  // A timer firing during startup must not begin another sync.
  a.timers.find(([ms]) => ms === 5000)[1](a.cx);
  await a.flush();
  first.person = "created"; first.state = "closed"; first.sort = "created";
  first.picked = { labels: ["bug"] }; first.query = "login";
  first.reload(a.cx);
  await a.flush();
  await first.close();
  const before = calls.length;
  const reopened = new C(), b = context();
  reopened.init({}, b.cx);
  assert.deepEqual(reopened.currentView(), { state: "closed", sort: "created", picked: { labels: ["bug"] }, q: "login", person: "created" });
  assert.equal(calls.length, before);
  await b.flush();
  assert.deepEqual(reopened.rows, [[7, "cached issue"]]);
  assert.equal(reopened.loadedOnce, true);
  assert.deepEqual(calls.slice(before).map(([cmd]) => cmd), ["bootstrap"], "warm open reads SQLite in one local call");
  assert.ok(calls.filter(([cmd]) => cmd === "query").slice(1).every((c) => JSON.parse(c.at(-1)).user === "sam"));
});

test("project state is isolated by machine, host and repository", () => {
  const base = { provider: "github", host: "github.com", repo: "acme/shop", on: null };
  const key = logic.projectStateKey(base);
  assert.equal(logic.projectStateKey({ ...base, repo: "ACME/SHOP" }), key);
  for (const patch of [{ repo: "acme/other" }, { host: "github.example.com" }, { on: "remote" }, { provider: "gitlab" }]) {
    assert.notEqual(logic.projectStateKey({ ...base, ...patch }), key);
  }
});

test("only preferences, never private issue previews, are saved in shared state", async () => {
  const state = new Map(), C = makeClass({}, state), v = new C();
  Object.assign(v, { state: "opened", sort: "updated", query: "old", picked: {}, person: "all", rows: [[1]], matched: 1,
    total: 1, loadedOnce: true, viewKey: "view" });
  v.pendingQuery = "new";
  v.saveView();
  assert.equal(state.get("view").q, "new", "pending text is persisted on close");
  assert.deepEqual([...state.keys()], ["view"]);
  assert.equal(state.get("view").rows, undefined);
});

test("network sync waits for freshness, except incomplete syncs", () => {
  const now = 10000000;
  assert.equal(logic.syncDue(now - 60000, false, true, now), false);
  assert.equal(logic.syncDue(now - logic.SYNC_FOCUSED, false, true, now), true);
  assert.equal(logic.syncDue(now - logic.SYNC_FOCUSED, false, false, now), false);
  assert.equal(logic.syncDue(now - logic.SYNC_AWAY, false, false, now), true);
  assert.equal(logic.syncDue(now, true, true, now), true, "unfinished initial syncs continue");
});

test("stale cached rows stay visible while a background refresh fails", async () => {
  const state = new Map(), project = { provider: "github", host: "github.com", repo: "acme/shop" };
  const key = logic.projectStateKey(project), filters = logic.startView({ person: "created" });
  state.set(`forge-issues.view:${key}`, filters);
  const legacyKey = `forge-issues.cache:${key}`;
  state.set(legacyKey, { rows: [[7, "legacy private preview"]] });
  const calls = [];
  const C = makeClass(project, state, async ([cmd]) => {
    calls.push(cmd);
    if (cmd === "bootstrap") return { now: Date.now() / 1000, last_sync: 1, user: "sam", user_at: Date.now() / 1000,
      list: { rows: [[7, "offline copy"]], matched: 1, total: 1 } };
    if (cmd === "sync") return { error: "offline", changed: 0 };
    throw new Error(cmd);
  });
  const v = new C(), c = context();
  v.init({}, c.cx);
  assert.equal(state.get(legacyKey), null, "legacy previews are cleared on opening the project");
  await c.flush();
  assert.deepEqual(calls, ["bootstrap", "sync"]);
  assert.equal(v.rows[0][1], "offline copy");
  assert.equal(v.syncError, "offline");
  assert.equal(v.loading, undefined, "no blank loading state replaces cached rows");
});

test("manual refresh reloads the list even when the sync reports no changes", async () => {
  const v = view(), c = context(), calls = [];
  v.lastPoll = Date.now(); v.since = 1; v.accountForce = true;
  v.person = "created";
  v.py = async ([cmd, ...args]) => {
    calls.push([cmd, ...args]);
    if (cmd === "sync") return { now: 2, last_sync: 2, changed: 0 };
    if (cmd === "meta") return {};
    if (cmd === "whoami") return { user: "sam" };
    return { rows: [], matched: 0, total: 0 };
  };
  v.sync(c.cx, true);
  await c.flush();
  assert.equal(calls[0][0], "sync");
  assert.equal(calls[0].at(-1), 1, "force reaches the backend");
  assert.ok(calls.some(([cmd]) => cmd === "query"));
  assert.deepEqual(calls.find(([cmd]) => cmd === "whoami"), ["whoami", 3600, 1]);
});
