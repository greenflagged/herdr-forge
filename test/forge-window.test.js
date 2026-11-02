import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRemote, providerForHost } from "../shared/lib.js";
import { PANELS, forgeLayout, keptBlocks, parseConfig, projectFrom, withConfig, rememberedProject,
  selectedPanels, togglePanel, panelSelectionKey, panelLabel } from "../mods/forge-window/window.js";

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
  const config = parseConfig(JSON.stringify({ projects: { "gitlab.com/acme/shop": { on: "vps", issues: { triage: true } } } }));
  const p = withConfig(project, config);
  assert.equal(p.on, "vps");
  const blocks = forgeLayout(p, config).children[1].children.flatMap((n) => n.children ?? [n]);
  const issues = blocks.find((b) => b.content.mod === "forge-issues").content.props;
  assert.equal(issues.triage, true);
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
