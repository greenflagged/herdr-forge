import assert from "node:assert/strict";
import { test } from "node:test";
import {
  actionList, checkoutOf, expandedSize, findBlocks, isCollapsed, ago, clock, fill, forgeClient, isShown, issueItem, matches, packScript, parseRemote, projectOf, providerForHost, requestItem, runAction, span, versionOf, WORKTREE,
} from "../shared/lib.js";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasGit } from "./fixtures.js";

test("projectOf defaults to GitLab and infers the provider from the host", () => {
  assert.equal(projectOf({ repo: "a/b" }).host, "gitlab.com");
  assert.equal(projectOf({ host: "github.com", repo: "a/b" }).provider, "github");
  assert.equal(projectOf({ host: "git.acme.io" }).provider, "gitlab");
  assert.equal(projectOf({ provider: "github" }).terms.request, "PR");
  assert.equal(providerForHost("codeberg.org"), null);
  assert.equal(projectOf({ host: "bitbucket.org" }).provider, null, "unsupported stays unsupported");
  assert.equal(providerForHost("git.acme.io", { "git.acme.io": "github" }), "github");
  assert.equal(providerForHost("github.acme.com"), "github", "GitHub Enterprise that says so");
  assert.equal(providerForHost("acme-github.io"), "github");
  assert.equal(providerForHost("gitlab.acme.com"), "gitlab");
  assert.equal(providerForHost("mygithubby.com"), "gitlab", "only github as a word");
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
  const now = 10_000_000;
  const reg = {
    other: { at: now - 60000, actions: [{ id: "y", label: "Y" }, { id: "x", label: "dup" }] },
    gone: { at: now - 2 * 3600000, actions: [{ id: "old", label: "Old" }] },
    broken: "nope",
  };
  assert.deepEqual(actionList(["defaults", { id: "x", label: "X" }, { label: "no id" }], defaults, reg, now).map((a) => a.id),
    ["ship", "x", "y"], "stale registrations drop out");
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
  assert.equal(isShown(tree, "forge-issues"), true, "nowhere: fails safe");
  assert.equal(isShown(tree, "forge-ci", { repo: "x/y" }), true, "no block for that repo");
  const spaces = [{ id: "s1", active: true, tabs: [{ id: "t1", active: false }, { id: "t2", active: true }] },
    { id: "s2", active: false, tabs: [{ id: "t3", active: true }] }];
  assert.equal(isShown(tree, "forge-issues", {}, { panes: [{ mod: "forge-issues", tab: "t1" }], spaces }), false, "a background tab");
  assert.equal(isShown(tree, "forge-issues", {}, { panes: [{ mod: "forge-issues", tab: "t3" }], spaces }), false, "another space's tab");
  assert.equal(isShown(tree, "forge-issues", {}, { panes: [{ mod: "forge-issues", tab: "t2" }], spaces }), true);
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
  await assert.rejects(runAction({ id: "g", label: "G", exec: ["git", "switch", "{source}"] }, { source: "--orphan=x" }, {}, h),
    /read as an option/);
  await runAction({ id: "g", label: "G", exec: ["echo", "branch {source}"] }, { source: "-x" }, {}, h); // inside a longer argument: fine
  await assert.rejects(runAction({ id: "t", label: "T", task: "x" }, {}, {}, h), /No checkout/);
});

test("runAction starts worktree actions in the request's checkout", async () => {
  const h = fakeHerdr();
  h.exec = async (cmd, args, opts) => { h.calls.push(["exec", cmd, args, opts]); return { code: 0, stdout: "/wt/shop/feat-x", stderr: "" }; };
  h.spaces = () => [];
  await runAction({ id: "ship", label: "Ship", worktree: true, task: "merge {ref}", tab: "ship {ref}" },
    { ref: "!3", source: "feat/x" }, { on: "mac", folder: "/src/shop" }, h);
  assert.equal(h.calls[0][2].at(-1), "feat/x");
  assert.deepEqual(h.calls[1], ["run", "space.new", { folder: "/wt/shop/feat-x", machine: "mac", tab: "ship !3", argv: ["claude"], task: "merge !3" }]);
  await assert.rejects(runAction({ id: "s", label: "S", worktree: true, task: "x" }, { source: "-x" }, { folder: "/f" }, h), /No branch/);
  const n = h.calls.length;
  await assert.rejects(runAction({ id: "s", label: "S", worktree: true, task: "x" }, { source: "main", fork: true }, { folder: "/f" }, h),
    /fork/, "a fork's branch name means nothing in our repo");
  assert.equal(h.calls.length, n, "nothing ran");
});

test("WORKTREE names the new worktree after the main checkout, wherever it runs", { skip: !hasGit }, () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "forge-wt-")));
  const env = { ...process.env, HOME: dir, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const git = (cwd, ...a) => execFileSync("git", a, { cwd, env, encoding: "utf8" }).trim();
  const run = (cwd, b) => spawnSync("sh", ["-c", WORKTREE, "sh", b], { cwd, env, encoding: "utf8" });
  try {
    const origin = join(dir, "origin"), shop = join(dir, "shop");
    git(dir, "init", "-q", "-b", "main", origin);
    git(origin, "commit", "-q", "--allow-empty", "-m", "one");
    for (const b of ["feat/a", "feat/b"]) git(origin, "branch", b);
    git(dir, "clone", "-q", origin, shop);
    let r = run(shop, "feat/a");
    assert.equal(r.status, 0, r.stderr);
    const a = join(dir, ".herdr/worktrees/shop/feat-a");
    assert.equal(r.stdout, a, "from the main checkout: under its folder name");
    r = run(a, "feat/b");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, join(dir, ".herdr/worktrees/shop/feat-b"), "from inside a worktree: still the main checkout's name");
    assert.equal(run(a, "feat/a").stdout, a, "an existing worktree is found, not made again");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("checkoutOf matches the repo's folder name exactly", () => {
  const spaces = [
    { machine: null, folder: "/home/me/src/other-shop" },
    { machine: null, folder: "/home/me/src/shopping" },
    { machine: null, folder: "/home/me/.herdr/worktrees/acme-shop/" },
    { machine: "mac", folder: "/u/src/shop" },
  ];
  assert.equal(checkoutOf(null, spaces, null, "acme/shop"), "/home/me/.herdr/worktrees/acme-shop/");
  assert.equal(checkoutOf(null, spaces, null, "acme/api"), null);
  assert.equal(checkoutOf(null, spaces.slice(0, 2), null, "acme/shop"), null, "other-shop is another project");
  assert.equal(checkoutOf(null, spaces, "mac", "group/sub/shop"), "/u/src/shop");
});

test("item builders give actions their fields", () => {
  const project = projectOf({ repo: "acme/shop" });
  const r = requestItem({ iid: 3, title: "T", url: "u", source: "b", ci: { status: "failed" }, labels: [] }, project);
  assert.equal(r.ref, "!3");
  assert.equal(r.ci_status, "failed");
  assert.equal(r.fork, false);
  assert.equal(requestItem({ iid: 4, fork: true }, project).fork, true);
  const i = issueItem({ iid: 4, title: "T", labels: ["priority::high", "bug"], milestone: { title: "M1" }, state: "opened" }, project);
  assert.deepEqual(i.scoped, { priority: "high" });
  assert.equal(i.milestone, "M1");
  assert.equal(fill("{scoped.priority} {ref}", i), "high #4");
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
  const { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const home = mkdtempSync(`${tmpdir()}/forge-`);
  const source = readFileSync(new URL("../shared/forge.py", import.meta.url), "utf8");
  const as = (v) => source.replace(/^VERSION = "[^"]*"/m, `VERSION = "${v}"`);
  // An ASCII-only locale with UTF-8 mode off: a text read or write of forge.py (it has a
  // non-ASCII line) would fail here, so this proves boot and INSTALL handle it as bytes.
  const exec = (bin, args) => new Promise((resolve, reject) => execFile(bin, ["-X", "utf8=0", ...args],
    { env: { HOME: home, PATH: process.env.PATH, LC_ALL: "C" } },
    (err, stdout, stderr) => (err && err.code === "ENOENT" ? reject(err) : resolve({ code: err?.code ?? 0, stdout, stderr }))));
  const dir = `${home}/.local/share/herdr-forge`;

  // Every mod installs at once on first start: none may fail.
  const clients = Array.from({ length: 8 }, () => forgeClient({ exec, readTextFile: async () => as("0.2.0+aa") }, "/x"));
  const answers = await Promise.all(clients.map((f) => f(["version"])));
  assert.ok(answers.every((a) => a.version === "0.2.0+aa"), JSON.stringify(answers));
  assert.ok(existsSync(`${dir}/forge-0.2.0+aa.py`));
  assert.deepEqual(readFileSync(`${dir}/forge-0.2.0+aa.py`), Buffer.from(as("0.2.0+aa")), "byte for byte what the mod ships");
  assert.ok(/[^\x00-\x7f]/.test(source), "forge.py still has a non-ASCII line, or this proves less");
  assert.match(readFileSync(`${dir}/forge.py`, "utf8"), /VERSION = "0.2.0\+aa"/, "a stable path for agents");
  const { statSync } = await import("node:fs");
  assert.equal(statSync(dir).mode & 0o777, 0o700, "the folder (caches with issue text) is private");
  assert.equal(statSync(`${dir}/forge.py`).mode & 0o077, 0);

  // An older mod installing later doesn't take the stable path back.
  const old = forgeClient({ exec, readTextFile: async () => as("0.1.0+bb") }, "/x");
  assert.equal((await old(["version"])).version, "0.1.0+bb");
  assert.match(readFileSync(`${dir}/forge.py`, "utf8"), /VERSION = "0.2.0\+aa"/);
  assert.match((await old(["nope", "gitlab", "gitlab.com", "a/b"])).error, /unknown command/);

  // $HERDR_FORGE_HOME moves everything.
  const elsewhere = `${home}/elsewhere`;
  mkdirSync(elsewhere);
  const exec2 = (bin, args) => new Promise((resolve) => execFile(bin, args, { env: { HOME: home, PATH: process.env.PATH, HERDR_FORGE_HOME: elsewhere } },
    (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr })));
  await forgeClient({ exec: exec2, readTextFile: async () => as("0.2.0+aa") }, "/x")(["version"]);
  assert.ok(existsSync(`${elsewhere}/forge-0.2.0+aa.py`));
  writeFileSync(`${home}/unused`, "");
});

test("forge.py stays small enough to send as one argument", async () => {
  const { statSync } = await import("node:fs");
  const { expected } = await import("../scripts/sync.mjs");
  // Linux caps one argument at 131,072 bytes. What INSTALL gets is packScript(the stamped
  // mods/*/forge.py), one argv entry. This measures Node's zlib; Herdr's packs the same text
  // about 170 bytes smaller. Base64 needs no shell quoting (at most 2 bytes if Herdr's remote
  // hop wraps it), and INSTALL itself is under 1 KB, so even one `sh -c` string stays under the cap.
  const stamped = expected().get("mods/forge-requests/forge.py");
  const packed = packScript(stamped);
  assert.match(packed, /^[A-Za-z0-9+/=]+$/);
  assert.ok(packed.length < 120_000, `${packed.length}`);
  // Raw size: every forge.py call compiles the whole file (boot), so the cost of each spawn
  // grows with it. Past this, decide on purpose (a bytecode cache, or splitting it up).
  assert.ok(statSync(new URL("../shared/forge.py", import.meta.url)).size < 250_000);
});

test("sync copies agents.js and cleanup.js only into the mods that import them", async () => {
  const { expected } = await import("../scripts/sync.mjs");
  const out = expected();
  assert.ok(out.has("mods/forge-requests/agents.js"));
  assert.ok(out.has("mods/forge-requests/cleanup.js"));
  assert.ok(!out.has("mods/forge-ci/agents.js"));
  assert.ok(!out.has("mods/forge-ci/cleanup.js"));
  assert.ok(out.has("mods/forge-ci/lib.js"), "lib.js still goes everywhere");
});

test("a stray agents.js in a mod that doesn't import it: --check names it, sync deletes it", async () => {
  const { cpSync, existsSync, writeFileSync } = await import("node:fs");
  const { stale, sync } = await import("../scripts/sync.mjs");
  const base = mkdtempSync(join(tmpdir(), "forge-sync-"));
  try {
    const here = new URL("..", import.meta.url).pathname;
    for (const d of ["shared", "mods", "package.json"]) cpSync(join(here, d), join(base, d), { recursive: true });
    assert.deepEqual(stale(base), []);
    writeFileSync(join(base, "mods/forge-ci/agents.js"), "// stray\n");
    assert.deepEqual(stale(base), ["mods/forge-ci/agents.js (not imported there: sync deletes it)"]);
    sync(base);
    assert.ok(!existsSync(join(base, "mods/forge-ci/agents.js")));
    assert.ok(existsSync(join(base, "mods/forge-requests/agents.js")), "an imported copy stays");
    assert.deepEqual(stale(base), []);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("findBlocks and collapse sizes", () => {
  const tree = { type: "row", children: [
    { id: "a", type: "block", size: { px: 34 }, content: { mod: "forge-ci", props: { repo: "a/b" } } },
    { id: "b", type: "block", hidden: true, content: { mod: "forge-ci", props: { repo: "c/d" } } }],
    floating: [{ id: "f", content: { mod: "forge-ci" } }] };
  assert.deepEqual(findBlocks(tree, "forge-ci", { repo: "a/b" }).map((b) => b.id), ["a"]);
  assert.deepEqual(findBlocks(tree, "forge-ci").map((b) => b.id), ["a", "b", "f"]);
  assert.ok(isCollapsed(findBlocks(tree, "forge-ci")[0]));
  assert.deepEqual(findBlocks(tree, "forge-ci").map((b) => b.parent), ["row", "row", "floating"]);
  assert.ok(!isCollapsed(findBlocks(tree, "forge-ci")[1]));
  assert.deepEqual(expandedSize({ px: 200 }), { px: 200 });
  assert.deepEqual(expandedSize({ px: 34 }), { weight: 1 }, "never 'expand' to the collapsed size");
  assert.deepEqual(expandedSize(null), { weight: 1 });
});
