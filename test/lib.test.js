import assert from "node:assert/strict";
import { test } from "node:test";
import {
  actionList, ago, clock, fill, forgeClient, isShown, matches, parseRemote, projectOf, providerForHost, runAction, span, versionOf,
} from "../shared/lib.js";

test("projectOf defaults to GitLab and infers the provider from the host", () => {
  assert.equal(projectOf({ repo: "a/b" }).host, "gitlab.com");
  assert.equal(projectOf({ host: "github.com", repo: "a/b" }).provider, "github");
  assert.equal(projectOf({ host: "git.acme.io" }).provider, "gitlab");
  assert.equal(projectOf({ provider: "github" }).terms.request, "PR");
  assert.equal(providerForHost("codeberg.org"), null);
  assert.equal(providerForHost("git.acme.io", { "git.acme.io": "github" }), "github");
});

test("parseRemote reads ssh, scp-style and https remotes", () => {
  assert.deepEqual(parseRemote("git@gitlab.com:acme/shop.git"), { host: "gitlab.com", path: "acme/shop" });
  assert.deepEqual(parseRemote("https://gitlab.com/acme/sub/shop.git"), { host: "gitlab.com", path: "acme/sub/shop" });
  assert.deepEqual(parseRemote("ssh://git@git.acme.io:2222/acme/shop"), { host: "git.acme.io", path: "acme/shop" });
  assert.equal(parseRemote(""), null);
});

test("formatting", () => {
  assert.equal(ago(1000 - 30000, 1000), "now");
  assert.equal(ago(0, 3 * 3600000), "3h");
  assert.equal(clock(187), "3m07s");
  assert.equal(span(5.2 * 3600000), "5.2h");
  assert.equal(span(null), "–");
});

test("fill replaces placeholders in strings, lists and objects, leaving unknown ones", () => {
  const ctx = { iid: 7, title: "Fix it", labels: ["a", "b"], scoped: { type: "bug" } };
  assert.equal(fill("#{iid} {title} {labels} {scoped.type} {nope}", ctx), "#7 Fix it a,b bug {nope}");
  assert.deepEqual(fill(["git", "switch", "-c", "issue-{iid}"], ctx), ["git", "switch", "-c", "issue-7"]);
  assert.deepEqual(fill({ x: "{iid}", n: 3 }, ctx), { x: "7", n: 3 });
});

test("matches checks labels, absent labels, age and fields", () => {
  const now = 100 * 3600000;
  const ctx = { labels: ["bug", "ui"], state: "opened", conflicts: false, created_ms: now - 30 * 3600000 };
  assert.ok(matches(null, ctx));
  assert.ok(matches({ labels: ["bug"], without: "wontfix", state: "opened" }, ctx, now));
  assert.ok(!matches({ labels: ["bug", "api"] }, ctx, now));
  assert.ok(!matches({ without: ["ui"] }, ctx, now));
  assert.ok(matches({ minAgeHours: 24 }, ctx, now));
  assert.ok(!matches({ minAgeHours: 48 }, ctx, now));
  assert.ok(matches({ state: ["opened", "closed"], conflicts: false }, ctx, now));
});

test("actionList merges props, defaults and registered actions", () => {
  const defaults = [{ id: "ship", label: "Ship" }];
  assert.deepEqual(actionList(null, defaults).map((a) => a.id), ["ship"]);
  assert.deepEqual(actionList([{ id: "x", label: "X" }], defaults).map((a) => a.id), ["x"]);
  const reg = { other: [{ id: "y", label: "Y" }, { id: "x", label: "dup" }], broken: "nope" };
  assert.deepEqual(actionList(["defaults", { id: "x", label: "X" }, { label: "no id" }], defaults, reg).map((a) => a.id), ["ship", "x", "y"]);
});

test("isShown follows hidden ancestors, stacks and missing blocks", () => {
  const tree = { type: "row", children: [
    { id: "col", type: "column", hidden: true, children: [{ id: "a", type: "block", content: { mod: "forge-ci", props: { repo: "a/b" } } }] },
    { id: "s", type: "stack", active: "two", children: [
      { id: "one", type: "block", content: { mod: "forge-runners" } },
      { id: "two", type: "block", content: { mod: "forge-milestones" } }] },
  ] };
  assert.equal(isShown(tree, "forge-ci"), false);
  assert.equal(isShown(tree, "forge-runners"), false);
  assert.equal(isShown(tree, "forge-milestones"), true);
  assert.equal(isShown(tree, "forge-issues"), true, "not in the layout: a tab pane");
  assert.equal(isShown(tree, "forge-ci", { repo: "x/y" }), true, "no block for that repo");
});

function fakeHerdr() {
  const calls = [];
  return {
    calls,
    exec: async (cmd, args, opts) => { calls.push(["exec", cmd, args, opts]); return { code: 0, stdout: "line1\nok done\n", stderr: "" }; },
    run: (name, args) => { calls.push(["run", name, args]); return null; },
    spaces: () => [{ id: "s1", machine: "mac", folder: "/src/shop" }],
    knownAgents: async () => [{ key: "claude", name: "Claude", installed: true, run: ["claude"] }],
    openOverlay: (spec) => { calls.push(["overlay", spec]); return "o1"; },
  };
}

test("runAction starts an agent in the project's space", async () => {
  const h = fakeHerdr();
  const out = await runAction({ id: "fix", label: "Fix", task: "Fix {ref}: {title}", tab: "fix {ref}" },
    { iid: 7, ref: "#7", title: "Broken" }, { on: "mac", folder: "/src/shop" }, h);
  assert.equal(out.tab, "fix #7");
  assert.deepEqual(h.calls[0], ["run", "tab.new", { name: "fix #7", space: "s1", folder: "/src/shop", argv: ["claude"], task: "Fix #7: Broken" }]);
});

test("runAction runs programs without a shell, and reports their last line", async () => {
  const h = fakeHerdr();
  const out = await runAction({ id: "b", label: "B", exec: ["git", "switch", "-c", "i-{iid}"] }, { iid: 3 }, { on: "mac", folder: "/src/shop" }, h);
  assert.equal(out.text, "ok done");
  assert.deepEqual(h.calls[0], ["exec", "git", ["switch", "-c", "i-3"], { on: "mac", cwd: "/src/shop" }]);
  await assert.rejects(runAction({ id: "z", label: "Z" }, {}, {}, h), /nothing to do/);
  await assert.rejects(runAction({ id: "t", label: "T", task: "x" }, {}, {}, h), /No checkout/);
});

test("runAction opens overlays with the item", async () => {
  const h = fakeHerdr();
  await runAction({ id: "o", label: "O", overlay: { mod: "mine", props: { n: "{iid}" } } }, { iid: 4 }, { on: null }, h);
  assert.equal(h.calls[0][1].mod, "mine");
  assert.deepEqual(h.calls[0][1].props.item, { iid: 4 });
  assert.equal(h.calls[0][1].props.n, "4");
});

test("forgeClient installs the script once, then runs the installed copy", async () => {
  let installed = false;
  const seen = [];
  const exec = async (bin, args) => {
    seen.push(args);
    if (bin !== "/usr/bin/python3") throw new Error("not here");
    if (args[2].includes("os.replace")) { installed = true; return { code: 0, stdout: '{"ok": true}', stderr: "" }; }
    return { code: 0, stdout: installed ? '{"pipelines": []}' : '{"install": true}', stderr: "" };
  };
  const forge = forgeClient({ exec, readTextFile: async () => 'VERSION = "abc123"\n' }, "/x/forge.py");
  assert.deepEqual(await forge(["pipelines", "gitlab", "gitlab.com", "a/b"]), { pipelines: [] });
  assert.ok(seen.some((a) => a[2].includes("forge-abc123.py")));
  const n = seen.length;
  await forge(["pipelines"]);
  assert.equal(seen.length, n + 1, "one call once installed, with the python that worked");
  assert.equal(versionOf("nothing"), "dev");
});

test("forgeClient's boot and install code runs under real python", async () => {
  const { execFile } = await import("node:child_process");
  const { mkdtempSync, readFileSync, existsSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const home = mkdtempSync(`${tmpdir()}/forge-`);
  const script = readFileSync(new URL("../shared/forge.py", import.meta.url), "utf8").replace(/^VERSION = "dev"/m, 'VERSION = "t1"');
  const exec = (bin, args) => new Promise((resolve, reject) => execFile(bin, args, { env: { HOME: home, PATH: process.env.PATH } },
    (err, stdout, stderr) => (err && err.code === "ENOENT" ? reject(err) : resolve({ code: err?.code ?? 0, stdout, stderr }))));
  const forge = forgeClient({ exec, readTextFile: async () => script }, "/x/forge.py");
  assert.deepEqual(await forge(["version"]), { version: "t1" });
  assert.ok(existsSync(`${home}/.local/share/herdr-forge/forge-t1.py`));
  assert.ok(existsSync(`${home}/.local/share/herdr-forge/forge.py`), "a stable path for agents");
  assert.match((await forge(["nope", "gitlab", "gitlab.com", "a/b"])).error, /unknown command/);
});
