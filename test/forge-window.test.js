import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseRemote, providerForHost } from "../shared/lib.js";
import { PANELS, RESOLVE, forgeLayout, keptBlocks, otherProjects, parseConfig, parseFields, projectFrom, withConfig, withTimeout,
  rememberedProject, selectedPanels, togglePanel, panelSelectionKey, panelLabel, usableProject } from "../mods/forge-window/window.js";

const project = { provider: "gitlab", host: "gitlab.com", repo: "acme/shop", on: "mac", folder: "/src/shop" };
const mods = (node) => node.content ? [node.content.mod] : (node.children ?? []).flatMap(mods);

test("the Forge layout holds every panel under its bar, with the project's props", () => {
  const l = forgeLayout(project);
  assert.equal(l.id, "root");
  assert.deepEqual(l.children[1].children.map((n) => n.id), ["forge-left", "forge-middle", "forge-issues"]);
  assert.deepEqual(mods(l), ["forge-window", ...PANELS.map((p) => p.mod)]);
  const blocks = l.children[1].children.flatMap((n) => n.children ?? [n]);
  const issues = blocks.find((b) => b.content.mod === "forge-issues").content.props;
  assert.deepEqual(issues, { provider: "gitlab", host: "gitlab.com", repo: "acme/shop", on: "mac", folder: "/src/shop" });
  const velocity = blocks.find((b) => b.content.mod === "forge-velocity").content.props;
  assert.equal(velocity.glabOn, "mac");
  // The window's project, not the focused terminal's: velocity reads this checkout.
  assert.equal(velocity.folder, "/src/shop");
  assert.equal(velocity.on, "mac");
  assert.equal(velocity.repo, "acme/shop");
});

test("another package's block in forge.json survives Forge rewriting it, in its column", () => {
  const publisher = { id: "workstream-publisher", type: "block", size: { px: 0 }, min: 0,
    content: { mod: "workstream", props: { publisher: true } } };
  const middle = { id: "other-thing", type: "block", content: { mod: "my-mod" } };
  const old = forgeLayout(project);
  old.children[1].children[0].children.push(publisher);
  old.children[1].children[1].children.push(middle);
  const kept = keptBlocks(old);
  assert.deepEqual(kept.map((k) => [k.parent, k.block.id]), [["forge-left", "workstream-publisher"], ["forge-middle", "other-thing"]]);
  const again = forgeLayout({ ...project, repo: "acme/other" }, {}, kept);
  assert.deepEqual(again.children[1].children[0].children.at(-1), publisher);
  assert.deepEqual(again.children[1].children[1].children.at(-1), middle);
  // Forge's own blocks are never "kept", and rewriting with the same kept set is stable.
  assert.deepEqual(keptBlocks(forgeLayout(project)), []);
  assert.deepEqual(forgeLayout(project, {}, keptBlocks(again)), forgeLayout(project, {}, kept));
  // A kept block whose column is gone goes to the left one; a duplicate id is dropped.
  const moved = forgeLayout(project, {}, [{ parent: "gone", block: middle }, { parent: "forge-left", block: { ...middle } }]);
  assert.deepEqual(moved.children[1].children[0].children.filter((b) => b.id === "other-thing").length, 1);
  assert.deepEqual(keptBlocks(null), []);
});

test("forge.json adds per-project props and machine", () => {
  const config = parseConfig(JSON.stringify({ projects: { "gitlab.com/acme/shop": { on: "vps", issues: { triage: true, sync: { focused: 60, away: 300 } } } } }));
  const p = withConfig(project, config);
  assert.equal(p.on, "vps");
  const blocks = forgeLayout(p, config).children[1].children.flatMap((n) => n.children ?? [n]);
  const issues = blocks.find((b) => b.content.mod === "forge-issues").content.props;
  assert.equal(issues.triage, true);
  assert.deepEqual(issues.sync, { focused: 60, away: 300 }, "issues.sync reaches the Issues props");
  assert.equal(issues.on, "vps");
  assert.deepEqual(parseConfig("{not json"), {});
  assert.deepEqual(parseConfig("[1]"), {});
});

test("projectFrom reads the focused repo", () => {
  const f = { top: "/src/shop", url: "git@gitlab.com:acme/shop.git" };
  assert.deepEqual(projectFrom(f, parseRemote(f.url), "mac", providerForHost),
    { provider: "gitlab", host: "gitlab.com", repo: "acme/shop", on: "mac", folder: "/src/shop" });
  assert.equal(projectFrom({}, null, null, providerForHost), null, "not a repo");
  assert.ok(projectFrom({ top: "/x", url: "https://codeberg.org/a/b" }, parseRemote("https://codeberg.org/a/b"), null, providerForHost).none);
});

test("remembered projects retain the repository, host, machine and checkout", () => {
  assert.equal(rememberedProject(project), project);
  for (const provider of ["gitlab", "github"]) {
    const saved = { ...project, provider };
    assert.deepEqual(rememberedProject(JSON.parse(JSON.stringify(saved))), saved);
  }
  for (const bad of [null, [], "acme/shop", {}, { ...project, none: true }, { ...project, provider: "other" },
    { ...project, repo: "" }, { ...project, host: null }, { ...project, on: 4 }, { ...project, folder: {} }]) {
    assert.equal(rememberedProject(bad), null);
  }
});

test("removing a panel removes its module entirely rather than hiding it", () => {
  const all = PANELS.map((p) => p.name);
  for (const panel of PANELS) {
    const selected = togglePanel(all, panel.name);
    const layout = forgeLayout(project, {}, [], selected);
    assert.ok(!mods(layout).includes(panel.mod), panel.mod);
    assert.ok(!JSON.stringify(layout).includes('"hidden":true'), "no hidden copy may keep polling");
    for (const other of PANELS.filter((p) => p !== panel)) assert.ok(mods(layout).includes(other.mod), other.mod);
    assert.deepEqual(togglePanel(selected, panel.name), all, "adding the panel back restores it in its normal position");
  }
});

test("empty columns disappear and remaining panels fill the space", () => {
  const issuesOnly = forgeLayout(project, {}, [], ["issues"]);
  assert.deepEqual(issuesOnly.children[1].children.map((n) => n.id), ["forge-issues"]);
  const ciOnly = forgeLayout(project, {}, [], ["ci"]);
  assert.deepEqual(ciOnly.children[1].children.map((n) => n.id), ["forge-middle"]);
  assert.deepEqual(ciOnly.children[1].children[0].size, { weight: 1 });
});

test("all panels can be removed without losing the controls to add them back", () => {
  const empty = forgeLayout(project, {}, [], []);
  assert.deepEqual(mods(empty), ["forge-window", "forge-window"], "no network-fetching panel stays mounted");
  assert.equal(empty.children[0].content.props.bar, true);
  assert.deepEqual(empty.children[1].children[0].content.props, { empty: true });
  const restored = forgeLayout(project, {}, [], PANELS.map((p) => p.name));
  assert.deepEqual(mods(restored), ["forge-window", ...PANELS.map((p) => p.mod)]);
});

test("panel selections override config defaults and stay isolated by project and machine", () => {
  const all = PANELS.map((p) => p.name);
  assert.deepEqual(selectedPanels(project, { hidden: ["runners"] }), all.filter((p) => p !== "runners"));
  assert.deepEqual(selectedPanels(project, { hidden: ["runners"] }, all), all);
  assert.deepEqual(selectedPanels(project, {}, []), []);
  assert.deepEqual(selectedPanels(project, {}, ["issues", "unknown", "issues"]), ["issues"]);
  assert.equal(panelSelectionKey(project), panelSelectionKey({ ...project }));
  for (const patch of [{ repo: "acme/other" }, { host: "git.example.com" }, { on: null }, { provider: "github" }]) {
    assert.notEqual(panelSelectionKey(project), panelSelectionKey({ ...project, ...patch }));
  }
  assert.equal(panelLabel(PANELS[0], "github"), "Pull requests");
  assert.equal(panelLabel(PANELS[3], "github"), "Workflow runs");
});

test("custom blocks survive removal of every standard panel", () => {
  const custom = { id: "custom", type: "block", content: { mod: "my-panel" } };
  const layout = forgeLayout(project, {}, [{ parent: "forge-middle", block: custom }], []);
  assert.deepEqual(mods(layout), ["forge-window", "my-panel"]);
  assert.equal(layout.children[1].children[0].id, "forge-middle");
});

// otherProjects: spaces as main.js's bar sees them (machine null: this computer).
const repo = (r, host = "gitlab.com") => ({ provider: "gitlab", host, repo: r, on: null, folder: `/src/${r}` });
const sp = (id, machine = null) => ({ id, name: id, machine });

test("otherProjects: one row per repo, from the main checkout over a linked worktree", () => {
  const rows = otherProjects([
    { space: sp("wt"), project: repo("a/b"), linked: true },
    { space: sp("main"), project: repo("a/b"), linked: false },
  ], null);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].space.id, "main");
  assert.deepEqual(Object.keys(rows[0]).sort(), ["host", "key", "label", "project", "showHost", "space"]);
  assert.equal(rows[0].key, "gitlab.com/a/b");
  assert.equal(rows[0].label, "a/b");
  assert.equal(rows[0].host, "gitlab.com");
  assert.equal(rows[0].showHost, false);
  assert.equal(rows[0].project.folder, "/src/a/b");
});

test("otherProjects: showHost for another host, and for the same owner/repo on two hosts", () => {
  const rows = otherProjects([
    { space: sp("gl"), project: repo("a/b"), linked: false },
    { space: sp("gh"), project: { ...repo("a/b", "github.com"), provider: "github" }, linked: false },
    { space: sp("own"), project: repo("x/y", "git.example.com"), linked: false },
    { space: sp("plain"), project: repo("p/q"), linked: false },
  ], null);
  assert.deepEqual(rows.map((r) => [r.key, r.showHost]), [
    ["gitlab.com/a/b", true], ["github.com/a/b", true], ["git.example.com/x/y", true], ["gitlab.com/p/q", false],
  ]);
});

test("otherProjects: this computer beats another machine, even a linked worktree over its main checkout", () => {
  const rows = otherProjects([
    { space: sp("desk", "sean-arch-desktop"), project: { ...repo("a/b"), on: "sean-arch-desktop" }, linked: false },
    { space: sp("here"), project: repo("a/b"), linked: true },
  ], null);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].space.id, "here");
  assert.equal(rows[0].project.on, null);
});

test("otherProjects: the window's project, non-repos and unsupported forges are left out; same owner, other repo stays", () => {
  const rows = otherProjects([
    { space: sp("board"), project: repo("a/b"), linked: false },
    { space: sp("home"), project: null, linked: false },
    { space: sp("cb"), project: { none: true, top: "/src/x", host: "codeberg.org" }, linked: false },
    { space: sp("other"), project: repo("a/c"), linked: false },
  ], repo("a/b"));
  assert.deepEqual(rows.map((r) => r.key), ["gitlab.com/a/c"]);
});

test("otherProjects: rows follow each repo's first space; no current project hides nothing", () => {
  const rows = otherProjects([
    { space: sp("1", "desk"), project: repo("x/one"), linked: false },
    { space: sp("2"), project: repo("x/two"), linked: false },
    { space: sp("3"), project: repo("x/one"), linked: false },
  ], null);
  assert.deepEqual(rows.map((r) => [r.key, r.space.id]), [["gitlab.com/x/one", "3"], ["gitlab.com/x/two", "2"]]);
  assert.equal(otherProjects([{ space: sp("1"), project: repo("x/one"), linked: false }], { none: true, top: "/" }).length, 1);
  assert.deepEqual(otherProjects(undefined, null), []);
  assert.equal(usableProject({ none: true, top: "/" }), false);
  assert.equal(usableProject(project), true);
});

test("RESOLVE: top, url, and linked 0 in the main checkout, 1 in a linked worktree; nothing outside a repo", (t) => {
  const g = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try { g(tmpdir(), "--version"); } catch { t.skip("no git"); return; }
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "forge-resolve-")));
  const main = join(dir, "main");
  execFileSync("mkdir", [main]);
  g(main, "init", "-q", "-b", "main");
  g(main, "config", "user.email", "t@t");
  g(main, "config", "user.name", "t");
  g(main, "commit", "-q", "--allow-empty", "-m", "one");
  g(main, "remote", "add", "origin", "git@gitlab.com:a/b.git");
  g(main, "worktree", "add", "-q", join(dir, "wt"));
  const run = (cwd) => parseFields(execFileSync("sh", ["-c", RESOLVE], { cwd, encoding: "utf8" }));
  assert.deepEqual(run(main), { top: main, url: "git@gitlab.com:a/b.git", linked: "0" });
  assert.deepEqual(run(join(dir, "wt")), { top: join(dir, "wt"), url: "git@gitlab.com:a/b.git", linked: "1" });
  // From a subfolder too (git-dir is then absolute, common-dir may be relative).
  execFileSync("mkdir", [join(main, "sub")]);
  assert.equal(run(join(main, "sub")).linked, "0");
  const outside = join(dir, "plain");
  execFileSync("mkdir", [outside]);
  assert.equal(execFileSync("sh", ["-c", RESOLVE], { cwd: outside, encoding: "utf8", env: { ...process.env, GIT_CEILING_DIRECTORIES: dir } }), "");
  assert.deepEqual(parseFields(""), {});
});

test("withTimeout: the answer when it comes first, an error when the timer does", async () => {
  const never = new Promise(() => {});
  assert.equal(await withTimeout(Promise.resolve(3), 1000, () => never), 3);
  await assert.rejects(withTimeout(never, 2000, () => Promise.resolve()), /timed out after 2 s/);
});
