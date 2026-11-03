import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import * as logic from "../mods/forge-window/window.js";
import { parseRemote, providerForHost } from "../shared/lib.js";

// Run the real launcher and project-picker handlers, replacing only Herdr's APIs.
const source = readFileSync(new URL("../mods/forge-window/main.js", import.meta.url), "utf8")
  .replace(/^import[\s\S]*?from "[^"]+";\n/gm, "")
  .replace("export default class Forge", "return class Forge");
const A = { provider: "github", host: "github.com", repo: "acme/a", on: null, folder: "/src/a" };
const B = { provider: "github", host: "github.com", repo: "acme/b", on: "remote", folder: "/src/b" };

function harness(saved, noRepo = false, spaces = [{ id: "a", folder: A.folder, machine: null }]) {
  const state = new Map([["layout", "main"], ["forge-window.state", saved ?? {}]]);
  const files = new Map(), tasks = [], calls = [], notices = [], controls = { failWrites: false };
  const platform = { ...logic, parseRemote, providerForHost, View: class {},
    shared: (k) => state.get(k), setShared: (k, v) => state.set(k, v),
    props: () => ({ overlay: "launcher" }), appHome: () => "/app",
    focused: () => ({ space: "a", tab: "ta", cwd: A.folder }),
    panes: () => [], spaces: () => spaces,
    readTextFile: async (p) => files.get(p) ?? null,
    writeTextFile: async (p, text) => { if (controls.failWrites) throw new Error("file changed"); files.set(p, text); },
    exec: async (_bin, _args, opts) => {
      calls.push(opts);
      const project = opts.cwd === B.folder ? B : A;
      return { code: 0, stdout: noRepo ? "" : `top\t${project.folder}\nurl\tgit@github.com:${project.repo}.git\n` };
    },
    run: (cmd, args) => { if (cmd === "layout.switch") state.set("layout", args.name); },
    closeOverlay() {}, notify: (n) => notices.push(n),
  };
  const Forge = new Function(...Object.keys(platform), source)(...Object.values(platform));
  // sleep never resolves, so a look's timeout never wins over the fake exec.
  const cx = { notify() {}, spawn: (fn) => tasks.push(fn), focus_handle: () => ({ focus() {} }), sleep: () => new Promise(() => {}) };
  const flush = async () => { while (tasks.length) await tasks.shift()(cx); };
  const launch = async () => { const v = new Forge(); v.init({}, cx); await flush(); return v; };
  return { state, files, calls, notices, controls, Forge, cx, flush, launch };
}

test("reopening uses the saved project instead of the focused terminal", async () => {
  const h = harness({ project: B, previous: "main" });
  await h.launch();
  assert.equal(h.calls.length, 0, "no git lookup can override the selection");
  assert.deepEqual(h.state.get("forge-window.state").project, B);
  assert.equal(h.state.get("layout"), "forge");
  assert.match(h.files.get("/app/layouts/forge.json"), /acme\/b/);
});

test("first open still discovers the focused repository", async () => {
  const h = harness();
  await h.launch();
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.state.get("forge-window.state").project, A);
});

test("choosing another project survives toggling Back and a serialized restart", async () => {
  // A's space (the window's project), and B open in two spaces on its machine.
  const h = harness({ project: A }, false, [{ id: "a", folder: A.folder, machine: null },
    { id: "b", folder: B.folder, machine: B.on, tabs: [] }, { id: "b2", folder: B.folder, machine: B.on, tabs: [] }]);
  await h.launch();
  const bar = new h.Forge();
  bar.initBar(h.cx);
  bar.picker = true;
  assert.equal(bar.otherRows().pending, 3, "the bar starts looking before anything is drawn");
  await h.flush();
  const { rows, pending } = bar.otherRows();
  assert.equal(pending, 0);
  assert.deepEqual(rows.map((r) => [r.key, r.space.id]), [["github.com/acme/b", "b"]], "B once; A is on the window already");
  const looks = h.calls.length;
  bar.scan(h.cx); // the picker opening again inside SPACES_EVERY: nothing is looked up again
  await h.flush();
  assert.equal(h.calls.length, looks);
  bar.openRow(rows[0], h.cx);
  await h.flush();
  assert.equal(h.calls.length, looks, "opening a row needs no second lookup");
  assert.deepEqual(h.state.get("forge-window.state").project, B);
  await h.launch(); // Forge -> Back
  assert.equal(h.state.get("layout"), "main");
  await h.launch(); // reopen while A still has terminal focus
  assert.deepEqual(h.state.get("forge-window.state").project, B);
  const restarted = harness(JSON.parse(JSON.stringify(h.state.get("forge-window.state"))));
  await restarted.launch();
  assert.equal(restarted.calls.length, 0);
  assert.deepEqual(restarted.state.get("forge-window.state").project, B);
});

test("invalid saved state falls back safely; no repository shows guidance", async () => {
  const h = harness({ project: { none: true } });
  await h.launch();
  assert.deepEqual(h.state.get("forge-window.state").project, A);
  const empty = harness({}, true);
  await empty.launch();
  assert.equal(empty.state.get("layout"), "main");
  assert.equal(empty.files.size, 0);
  assert.match(empty.notices[0].body, /Focus a terminal/);
});

test("panel removal persists across reopen and restart without any network or git call", async () => {
  const h = harness({ project: A });
  await h.launch();
  const bar = new h.Forge(); bar.config = {};
  const selected = ["requests", "issues"];
  bar.setPanels(selected, h.cx);
  await h.flush();
  assert.deepEqual(h.state.get(logic.panelSelectionKey(A)), selected);
  let layout = JSON.parse(h.files.get("/app/layouts/forge.json"));
  assert.ok(!JSON.stringify(layout).includes('"forge-runners"'));
  assert.ok(!JSON.stringify(layout).includes('"forge-ci"'));
  assert.equal(h.calls.length, 0, "editing the dashboard only reads/writes local files");
  await h.launch(); await h.launch();
  assert.ok(!h.files.get("/app/layouts/forge.json").includes('"forge-ci"'));
  const restarted = harness(JSON.parse(JSON.stringify(h.state.get("forge-window.state"))));
  restarted.state.set(logic.panelSelectionKey(A), JSON.parse(JSON.stringify(selected)));
  await restarted.launch();
  assert.ok(!restarted.files.get("/app/layouts/forge.json").includes('"forge-ci"'));
  const nextBar = new restarted.Forge(); nextBar.config = {};
  nextBar.setPanels([...selected, "ci"], restarted.cx);
  await restarted.flush();
  assert.ok(restarted.files.get("/app/layouts/forge.json").includes('"forge-ci"'));
});

test("failed layout writes do not persist a removal; overlapping updates are guarded", async () => {
  const h = harness({ project: A });
  await h.launch();
  const original = h.files.get("/app/layouts/forge.json");
  const bar = new h.Forge(); bar.config = {};
  h.controls.failWrites = true;
  bar.setPanels([], h.cx);
  await h.flush();
  assert.equal(h.state.get(logic.panelSelectionKey(A)), undefined);
  assert.equal(h.files.get("/app/layouts/forge.json"), original);
  assert.match(h.notices[0].body, /Couldn't update panels/);
  assert.equal(bar.panelBusy, false);
  h.controls.failWrites = false;
  bar.setPanels(["issues"], h.cx);
  bar.setPanels([], h.cx);
  await h.flush();
  assert.deepEqual(h.state.get(logic.panelSelectionKey(A)), ["issues"]);
});
