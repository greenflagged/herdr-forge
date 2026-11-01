import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectOf } from "../shared/lib.js";
import { agentPlaces, parseGitLook, ownersOf, withShared, GIT_LOOK, lookState, placeKey } from "../shared/agents.js";
import {
  shownMerged, deployState, checkDue, cleanupPlan, cleanupLines, notDoneWhy, CLEAN_WORKTREE, RECENT,
  WORKTREE_LIST, parseWorktrees, leftoversOf, emptyPlan,
  worktreeState, worktreesDue, listWorktrees, checkState, seedChecks, claimChecks, checkDeploy, checkDeploys,
  planCleanup, runCleanup, WORKTREES_EVERY, DEPLOY_EVERY,
} from "../shared/cleanup.js";
import { now, merged, after, lookOf, remote, hasGit } from "./fixtures.js";

// ---- after a merge ----

test("shownMerged keeps the last day's merges, and older ones an agent is still on", () => {
  const owned = new Set([9]);
  const owners = (m) => (owned.has(m.iid) ? [{}] : []);
  const list = [merged(), merged({ iid: 8, merged_ms: now - RECENT - 1 }), merged({ iid: 9, merged_ms: now - 3 * RECENT })];
  assert.deepEqual(shownMerged(list, owners, now).map((m) => m.iid), [7, 9]);
  assert.deepEqual(shownMerged([merged({ iid: 9, fork: true, merged_ms: now - 3 * RECENT })], owners, now), []);
});

test("deployState: CI first, then the project's deploy check", () => {
  const flux = { label: "Flux", check: "true" };
  assert.deepEqual(deployState(merged(), null, new Map(), now), { ci: "success", deploy: null, done: true });
  assert.equal(deployState(merged({ ci: { status: "running" } }), null, new Map(), now).done, false);
  assert.equal(deployState(merged({ ci: null, merged_ms: now - 60000 }), null, new Map(), now).ci, "pending", "a pipeline may still appear");
  assert.deepEqual(deployState(merged({ ci: null }), null, new Map(), now), { ci: "none", deploy: null, done: true });
  assert.equal(deployState(merged({ ci: { status: "running" } }), flux, new Map(), now).deploy, "waiting");
  assert.equal(deployState(merged({ ci: { status: "failed" } }), flux, new Map(), now).deploy, "blocked");
  assert.equal(deployState(merged(), flux, new Map(), now).deploy, "checking");
  const no = new Map([["m7", { state: "no", text: "image 3380", at: now }]]);
  assert.deepEqual(deployState(merged(), flux, no, now), { ci: "success", deploy: "no", done: false, text: "image 3380" });
  const yes = new Map([["m7", { state: "yes", text: null, at: now }]]);
  assert.equal(deployState(merged(), flux, yes, now).done, true);
});

test("checkDue runs the check once CI is through, again while it says no, never after yes", () => {
  const flux = { check: "true" };
  assert.equal(checkDue(merged(), null, new Map(), now, 60000), false, "no check set");
  assert.equal(checkDue(merged({ ci: { status: "running" } }), flux, new Map(), now, 60000), false);
  assert.equal(checkDue(merged(), flux, new Map(), now, 60000), true);
  assert.equal(checkDue(merged(), flux, new Map([["m7", { state: "no", at: now - 1000 }]]), now, 60000), false);
  assert.equal(checkDue(merged(), flux, new Map([["m7", { state: "no", at: now - 60000 }]]), now, 60000), true);
  assert.equal(checkDue(merged(), flux, new Map([["m7", { state: "yes", at: 0 }]]), now, 60000), false);
});

test("notDoneWhy says what a cleanup would skip waiting for", () => {
  const terms = projectOf({ repo: "acme/shop" }).terms, flux = { label: "Flux", check: "x" };
  const why = (m, d, c = new Map()) => notDoneWhy(deployState(m, d, c, now), d, terms);
  assert.equal(why(merged(), null), null);
  assert.equal(why(merged({ ci: { status: "failed" } }), flux), "pipeline failed on the merge commit");
  assert.equal(why(merged({ ci: { status: "running" } }), null), "pipeline still running on the merge commit");
  assert.equal(why(merged(), flux, new Map([["m7", { state: "error", text: "isn't on main", at: now }]])), "Flux check failed: isn't on main");
  assert.equal(why(merged(), flux, new Map([["m7", { state: "no", text: "Flux runs abc", at: now }]])), "Flux hasn't confirmed it yet (Flux runs abc)");
  assert.deepEqual(cleanupLines({ tabs: [], kills: [{ name: "w" }], worktrees: [], kept: [] }, "x"), ["Not deployed: x", "End w"]);
});


test("cleanupPlan closes a worktree's own tab, removes the worktree, and keeps what isn't safe", () => {
  const pl = agentPlaces(after.agents, after.panes, after.terminals);
  const g = lookOf({
    "/wt/fix-login": { branch: "fix-login", remote, head: "h7", top: "/wt/fix-login", linked: true },
    "/wt/add-csv": { branch: "add-csv", remote, head: "x", top: "/wt/add-csv", linked: true },
    "/repo": { branch: "main", remote, head: "y", top: "/repo", linked: false },
  })(pl);
  const project = projectOf({ repo: "acme/shop" });
  const m = merged();
  const plan = cleanupPlan(m, ownersOf(m, pl, g, project), pl, after.panes, after.terminals, g);
  assert.equal(plan.blocked, null);
  assert.deepEqual(plan.tabs, [{ id: "tab1", name: "fix-login" }], "every pane in the tab is in the worktree");
  assert.deepEqual(plan.kills, []);
  assert.deepEqual(plan.worktrees, [{ machine: null, top: "/wt/fix-login", branch: "fix-login" }]);
  assert.deepEqual(cleanupLines(plan), ["Close tab fix-login and its agent", "Remove worktree /wt/fix-login and branch fix-login"]);

  // A sub-agent: end just it (its PM lives on), and its worktree has more commits than merged.
  const m2 = merged({ iid: 8, source: "add-csv", head_sha: "h8" });
  const plan2 = cleanupPlan(m2, ownersOf(m2, pl, g, project), pl, after.panes, after.terminals, g);
  assert.deepEqual(plan2.kills, [{ address: "t5", name: "worker" }]);
  assert.deepEqual(plan2.tabs, []);
  assert.deepEqual(plan2.kept, [{ top: "/wt/add-csv", why: "it has commits that weren't merged" }]);
  assert.deepEqual(cleanupLines(plan2), ["End worker", "Keep /wt/add-csv: it has commits that weren't merged"]);

  // No head commit from the forge: the tab still closes, but the worktree can't be checked, so it stays.
  const m3 = merged({ head_sha: null });
  const plan3 = cleanupPlan(m3, ownersOf(m3, pl, g, project), pl, after.panes, after.terminals, g);
  assert.deepEqual(plan3.tabs, [{ id: "tab1", name: "fix-login" }]);
  assert.deepEqual(plan3.worktrees, []);
  assert.deepEqual(plan3.kept, [{ top: "/wt/fix-login", why: "the request's head commit is unknown" }]);
  assert.ok(cleanupLines(plan3).includes("Keep /wt/fix-login: the request's head commit is unknown"));
});

test("cleanupPlan waits while an owner or one of its sub-agents is busy", () => {
  const agents = [{ ...after.agents[0], status: "working" }, after.agents[1]];
  const pl = agentPlaces(agents, after.panes, after.terminals);
  const g = lookOf({ "/wt/fix-login": { branch: "fix-login", remote, head: "h7", top: "/wt/fix-login", linked: true } })(pl);
  const project = projectOf({ repo: "acme/shop" });
  const m = merged();
  assert.equal(cleanupPlan(m, ownersOf(m, pl, g, project), pl, after.panes, after.terminals, g).blocked, "fix-login is still working");
  // The owner rests, but a sub-agent it started is at a prompt.
  const pl2 = agentPlaces(after.agents, after.panes, [{ address: "t7", parent: "t1", state: "live", status: "error", cwd: "/tmp" }]);
  const g2 = lookOf({ "/wt/fix-login": { branch: "fix-login", remote, head: "h7", top: "/wt/fix-login", linked: true } })(pl2);
  const plan = cleanupPlan(m, ownersOf(m, pl2, g2, project), pl2, after.panes, [{ address: "t7", parent: "t1", state: "live", status: "error" }], g2);
  assert.match(plan.blocked, /waiting for you/);
  // A tab with another folder in it isn't closed: only the agent ends.
  const panes = [...after.panes, { pane: "p9", tab: "tab1", terminal: "t8", cwd: "/elsewhere" }];
  const plan3 = cleanupPlan(m, ownersOf(m, pl, g, project).map((o) => ({ ...o, status: "idle" })), agentPlaces(after.agents, panes, []), panes, [], g);
  assert.deepEqual(plan3.tabs, []);
  assert.deepEqual(plan3.kills.map((k) => k.address), ["t1"]);
});

// ---- worktrees left behind by agents that already exited ----

test("parseWorktrees keeps linked worktrees on a branch, nothing git wouldn't remove", () => {
  const out = [
    "worktree /repo", "HEAD aaa", "branch refs/heads/main", "",
    "worktree /tmp/scratch", "HEAD bbb", "detached", "",
    "worktree /wt/fix-login", "HEAD h7", "branch refs/heads/fix-login", "",
    "worktree /wt/held", "HEAD ccc", "branch refs/heads/held", "locked", "",
    "worktree /wt/gone", "HEAD ddd", "branch refs/heads/gone", "prunable gitdir file points to non-existent location", "",
    "worktree /wt/with space", "HEAD eee", "branch refs/heads/feature/x", "",
  ].join("\n");
  assert.deepEqual(parseWorktrees(out), [
    { top: "/wt/fix-login", head: "h7", branch: "fix-login" },
    { top: "/wt/with space", head: "eee", branch: "feature/x" },
  ]);
  assert.deepEqual(parseWorktrees(""), []);
  assert.deepEqual(parseWorktrees("worktree /repo\nHEAD a\nbranch refs/heads/fix-login\n"), [], "the main checkout never counts");
});

test("a merged request whose worker exited still shows, and Clean up removes the worktree it left", () => {
  const wts = [{ top: "/wt/fix-login", head: "h7", branch: "fix-login" }, { top: "/wt/other", head: "x", branch: "other" }];
  const m = merged({ merged_ms: now - 3 * RECENT });
  assert.deepEqual(leftoversOf(m, wts), [wts[0]]);
  assert.deepEqual(leftoversOf({ ...m, fork: true }, wts), [], "a fork's branch name says nothing about our worktrees");
  assert.deepEqual(shownMerged([m], () => [], now, (x) => leftoversOf(x, wts)).map((x) => x.iid), [7]);
  assert.deepEqual(shownMerged([m], () => [], now, () => []), [], "nothing left: an old merge drops off");

  const project = projectOf({ repo: "acme/shop" });
  const pl = agentPlaces([], [], []);
  const plan = cleanupPlan(m, ownersOf(m, pl, new Map(), project), pl, [], [], new Map(), leftoversOf(m, wts), "mac");
  assert.deepEqual(plan, { blocked: null, tabs: [], kills: [], worktrees: [{ machine: "mac", top: "/wt/fix-login", branch: "fix-login" }], kept: [] });
  assert.deepEqual(cleanupLines(plan), ["Remove worktree /wt/fix-login and branch fix-login"]);

  // Kept: more commits than merged, or a terminal still open in it.
  assert.deepEqual(cleanupPlan(merged({ head_sha: "h9" }), [], pl, [], [], new Map(), [wts[0]]).kept,
    [{ top: "/wt/fix-login", why: "it has commits that weren't merged" }]);
  for (const head_sha of [null, undefined, ""]) {
    assert.deepEqual(cleanupPlan(merged({ head_sha }), [], pl, [], [], new Map(), [wts[0]], "mac"),
      { blocked: null, tabs: [], kills: [], worktrees: [], kept: [{ top: "/wt/fix-login", why: "the request's head commit is unknown" }] },
      `no head commit (${head_sha}): kept, not removed`);
  }
  const shell = [{ pane: "p5", tab: "tab5", terminal: "t5", cwd: "/wt/fix-login/src" }];
  assert.deepEqual(cleanupPlan(m, [], pl, shell, [], new Map(), [wts[0]]),
    { blocked: null, tabs: [], kills: [], worktrees: [], kept: [{ top: "/wt/fix-login", why: "a terminal is open in it" }] });
  assert.deepEqual(cleanupPlan(merged({ head_sha: null }), [], pl, shell, [], new Map(), [wts[0]]).kept,
    [{ top: "/wt/fix-login", why: "a terminal is open in it" }], "an open terminal is still the reason given first");
  assert.equal(cleanupPlan(m, [], pl, [], [{ address: "t6", state: "live", cwd: "/wt/fix-login" }], new Map(), [wts[0]]).kept.length, 1);
  assert.equal(cleanupPlan(m, [], pl, [{ pane: "p5", cwd: "/wt/fix-login-2" }], [], new Map(), [wts[0]]).worktrees.length, 1,
    "a sibling folder with a longer name isn't inside it");
});

test("a worktree an owner is in is planned once, and its own tab doesn't keep it", () => {
  const pl = agentPlaces(after.agents, after.panes, after.terminals);
  const g = lookOf({ "/wt/fix-login": { branch: "fix-login", remote, head: "h7", top: "/wt/fix-login", linked: true } })(pl);
  const project = projectOf({ repo: "acme/shop" });
  const m = merged();
  const left = [{ top: "/wt/fix-login", head: "h7", branch: "fix-login" }, { top: "/wt/fix-login-old", head: "h7", branch: "fix-login" }];
  const plan = cleanupPlan(m, ownersOf(m, pl, g, project), pl, after.panes, after.terminals, g, left, null);
  assert.deepEqual(plan.tabs, [{ id: "tab1", name: "fix-login" }]);
  assert.deepEqual(plan.worktrees.map((w) => w.top), ["/wt/fix-login", "/wt/fix-login-old"]);
  assert.deepEqual(plan.kept, []);
  // Still waits while the owner works, leftovers or not.
  const busy = agentPlaces([{ ...after.agents[0], status: "working" }, after.agents[1]], after.panes, after.terminals);
  assert.match(cleanupPlan(m, ownersOf(m, busy, g, project), busy, after.panes, after.terminals, g, left).blocked, /still working/);
});

test("Clean up ends a finished sub-agent Work ties to the request, though its folder is the main checkout", () => {
  // A PM in the main checkout started a worker there; the worker did its work in a worktree,
  // finished, and its terminal is still live (done). Work publishes it on the request.
  const terms = [{ address: "t1r", parent: "t4", state: "live", status: "done", cwd: "/repo", name: "pypi-source-diff" }];
  const agentsNow = [{ address: "t4", pane: "p4", tab: "tab4", status: "idle", tab_name: "pm" }];
  const panesNow = [{ pane: "p4", tab: "tab4", terminal: "t4", cwd: "/repo", branch: "main" }];
  const pl = agentPlaces(agentsNow, panesNow, terms);
  const g = lookOf({ "/repo": { branch: "main", remote, head: "y", top: "/repo", linked: false } })(pl);
  const project = projectOf({ repo: "acme/shop" });
  const m = merged();
  assert.deepEqual(ownersOf(m, pl, g, project), [], "its own folder says main");
  const owners = withShared(ownersOf(m, pl, g, project), [{ address: "t1r", name: "x" }, { address: "gone", name: "y" }], pl);
  assert.deepEqual(owners.map((o) => [o.address, o.shared]), [["t1r", true]], "an address with no live terminal drops out");
  const plan = cleanupPlan(m, owners, pl, panesNow, terms, g, [{ top: "/wt/fix-login", head: "h7", branch: "fix-login" }], "mac");
  assert.deepEqual(cleanupLines(plan), ["End pypi-source-diff", "Remove worktree /wt/fix-login and branch fix-login"],
    "the PM lives on, and no line about the main checkout");
  assert.equal(withShared([], undefined, pl).length, 0);
  // Not while it's working.
  const busy = agentPlaces(agentsNow, panesNow, [{ ...terms[0], status: "working" }]);
  assert.match(cleanupPlan(m, withShared([], [{ address: "t1r" }], busy), busy, panesNow, terms, g, []).blocked, /still working/);
});

test("GIT_LOOK and CLEAN_WORKTREE against a real worktree", { skip: !hasGit }, () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "forge-wt-")));
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const git = (cwd, ...a) => execFileSync("git", a, { cwd, env, encoding: "utf8" }).trim();
  const sh = (script, cwd, ...a) => spawnSync("sh", ["-c", script, "sh", ...a], { cwd, env, encoding: "utf8" });
  try {
    const repo = join(dir, "repo"), wt = join(dir, "wt");
    git(dir, "init", "-q", "-b", "main", repo);
    git(repo, "commit", "-q", "--allow-empty", "-m", "one");
    git(repo, "remote", "add", "origin", remote);
    git(repo, "worktree", "add", "-q", "-b", "fix-login", wt);
    const head = git(wt, "rev-parse", "HEAD");

    assert.deepEqual(parseGitLook(sh(GIT_LOOK, join(wt)).stdout),
      { branch: "fix-login", remote, head, top: wt, linked: true });
    assert.equal(parseGitLook(sh(GIT_LOOK, repo).stdout).linked, false, "the main checkout");
    assert.deepEqual(parseWorktrees(git(repo, ...WORKTREE_LIST)), [{ top: wt, head, branch: "fix-login" }]);

    // Refuses: a commit that wasn't merged, then an untracked file.
    git(wt, "commit", "-q", "--allow-empty", "-m", "more");
    let r = sh(CLEAN_WORKTREE, dir, wt, "fix-login", head);
    assert.equal(r.status, 3);
    assert.match(r.stdout, /commits that weren't merged/);
    git(wt, "reset", "-q", "--hard", head);
    writeFileSync(join(wt, "notes.txt"), "keep me");
    r = sh(CLEAN_WORKTREE, dir, wt, "fix-login", head);
    assert.equal(r.status, 4, r.stdout);
    assert.ok(existsSync(join(wt, "notes.txt")), "nothing removed");
    // The linked-worktree and branch checks still come before the empty-head refusal.
    assert.match(sh(CLEAN_WORKTREE, dir, repo, "main", "").stdout, /isn't a linked worktree/);
    assert.match(sh(CLEAN_WORKTREE, dir, wt, "other-branch", "").stdout, /isn't on other-branch any more/);

    rmSync(join(wt, "notes.txt"));
    // Clean and on its branch, but no merged head to compare with: refuses, removes nothing.
    r = sh(CLEAN_WORKTREE, dir, wt, "fix-login", "");
    assert.equal(r.status, 3, r.stdout);
    assert.match(r.stdout, /head commit .* unknown/);
    assert.ok(existsSync(wt), "worktree kept");
    assert.match(git(repo, "branch", "--list", "fix-login"), /fix-login/, "branch kept");
    r = sh(CLEAN_WORKTREE, dir, wt, "fix-login", head);
    assert.equal(r.status, 0, r.stdout);
    assert.ok(!existsSync(wt));
    assert.equal(git(repo, "branch", "--list", "fix-login"), "", "branch deleted");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


// ---- the flows, under fakes ----

// h.exec by command: git (WORKTREE_LIST), sh GIT_LOOK, sh CLEAN_WORKTREE, sh <deploy check>.
function fakeH(over = {}) {
  const calls = [];
  const h = {
    calls,
    exec: async (bin, args, opts) => {
      calls.push({ bin, args, ...opts });
      const what = bin === "git" ? "list" : args[1] === GIT_LOOK ? "look" : args[1] === CLEAN_WORKTREE ? "clean" : "check";
      const a = typeof over[what] === "function" ? await over[what](args, opts) : over[what];
      if (a instanceof Error) throw a;
      return { code: 0, stdout: "", stderr: "", ...a };
    },
    agents: () => over.agents ?? [], panes: () => over.panes ?? [], terminals: () => over.terminals ?? [],
    run: (...a) => { calls.push({ run: a }); if (over.run) over.run(...a); },
    sleep: async (ms) => { calls.push({ sleep: ms }); },
  };
  return h;
}
const porcelain = "worktree /repo\nHEAD a\nbranch refs/heads/main\n\nworktree /wt/fix-login\nHEAD h7\nbranch refs/heads/fix-login\n";
const project = projectOf({ repo: "acme/shop" });

test("worktreesDue: not while listing, only with merged requests, every couple of minutes", () => {
  const w = worktreeState();
  assert.equal(worktreesDue(w, [merged()], now), true);
  assert.equal(worktreesDue(w, [], now), false);
  assert.equal(worktreesDue({ ...w, at: now - 1000 }, [merged()], now), false);
  assert.equal(worktreesDue({ ...w, at: now - WORKTREES_EVERY }, [merged()], now), true);
  assert.equal(worktreesDue({ ...w, pending: Promise.resolve() }, [merged()], now), false);
});

test("listWorktrees lists, keeps the old list on failure, and returns at once while one runs", async () => {
  const w = worktreeState();
  await listWorktrees(w, { folder: null }, fakeH());
  assert.deepEqual(w.list, []);
  assert.ok(w.at > 0, "no checkout: an empty list, listed now");
  const h = fakeH({ list: { stdout: porcelain } });
  await listWorktrees(w, { folder: "/repo", on: "mac" }, h);
  assert.deepEqual(w.list, [{ top: "/wt/fix-login", head: "h7", branch: "fix-login" }]);
  assert.deepEqual([w.folder, w.machine, w.pending], ["/repo", "mac", null]);
  assert.deepEqual([h.calls[0].cwd, h.calls[0].on, h.calls[0].args], ["/repo", "mac", WORKTREE_LIST]);
  w.at = 0;
  await listWorktrees(w, { folder: "/repo" }, fakeH({ list: { code: 128, stdout: "" } }));
  assert.equal(w.list.length, 1, "a failing git keeps the last list");
  assert.ok(w.at > 0);
  await listWorktrees(w, { folder: "/repo" }, fakeH({ list: new Error("away") }));
  assert.equal(w.list.length, 1, "a machine that's away too");
  assert.deepEqual([w.folder, w.machine], ["/repo", "mac"], "and where it was listed");
  // A second call while one runs returns at once without its own git.
  let release;
  const slow = fakeH({ list: () => new Promise((r) => { release = () => r({ stdout: "" }); }) });
  const first = listWorktrees(w, { folder: "/repo" }, slow);
  assert.ok(w.pending);
  await listWorktrees(w, { folder: "/repo" }, slow);
  assert.equal(slow.calls.length, 1);
  release();
  await first;
  assert.equal(w.pending, null);
});

test("seedChecks and claimChecks: seeded yes, nothing without a check or while running", () => {
  const flux = { check: "true" };
  const cs = checkState();
  seedChecks([merged({ deployed: { text: "live", at_ms: 5 } }), merged({ iid: 8, merge_sha: null, deployed: { at_ms: 1 } })], cs);
  assert.deepEqual([...cs.checks], [["m7", { state: "yes", text: "live", at: 5 }]]);
  const fresh = checkState();
  assert.deepEqual(claimChecks([merged()], null, fresh, now), []);
  assert.equal(fresh.checking, false);
  assert.deepEqual(claimChecks([merged({ deployed: { at_ms: 1 } })], flux, fresh, now), [], "seeded on the way: yes is final");
  assert.equal(fresh.checking, false);
  const due = claimChecks([merged({ merge_sha: "m9" })], flux, fresh, now);
  assert.deepEqual(due.map((m) => m.merge_sha), ["m9"]);
  assert.equal(fresh.checking, true);
  assert.deepEqual(claimChecks([merged({ merge_sha: "m10" })], flux, fresh, now), [], "not while a run is going");
  // A tick seeds only what it hasn't seen; seedChecks (at refresh) is what overwrites.
  const seen = checkState();
  const no = { state: "no", text: null, at: now };
  seen.checks.set("m7", no);
  claimChecks([merged({ deployed: { at_ms: 1 } })], flux, seen, now);
  assert.equal(seen.checks.get("m7"), no, "the entry it had is left alone");
  assert.equal(DEPLOY_EVERY, 60000);
});

test("checkDeploy: exit 0 yes, 1 no, else error; no checkout is an error", async () => {
  const run = (code, stdout = "", e = null) => checkDeploy(merged(), { check: "c", folder: "/repo", on: "mac" },
    fakeH({ check: e ?? { code, stdout } }));
  assert.deepEqual(await run(0, "image 33\nmore"), { state: "yes", text: "image 33" });
  assert.deepEqual(await run(1), { state: "no", text: null });
  assert.deepEqual(await run(2), { state: "error", text: "exited 2" });
  assert.deepEqual(await run(0, "", new Error("away")), { state: "error", text: "away" });
  assert.deepEqual(await checkDeploy(merged(), { check: "c", folder: null }, fakeH()),
    { state: "error", text: "No checkout of the repo found (set props.folder)." });
  const h = fakeH({ check: { code: 0 } });
  await checkDeploy(merged(), { check: "c", folder: "/repo", on: "mac" }, h);
  assert.deepEqual([h.calls[0].args, h.calls[0].cwd, h.calls[0].on], [["-c", "c", "sh", "m7"], "/repo", "mac"]);
});

test("checkDeploys records each, tells forge.py about a yes, notifies only a no that turned yes", async () => {
  const deploy = { check: "c" };
  const cs = checkState();
  cs.checks.set("m1", { state: "no", at: 0 });
  cs.checks.set("m3", { state: "error", at: 0 });
  const codes = { m1: 0, m2: 0, m3: 1, m4: 2 };
  const told = [], notes = [], each = [];
  const h = { ...fakeH({ check: (args) => ({ code: codes[args[3]] }) }),
    forge: async (args) => { told.push(args); }, notify: (n) => notes.push(n) };
  const due = ["m1", "m2", "m3", "m4"].map((sha, i) => merged({ iid: i + 1, merge_sha: sha, title: `T${i + 1}` }));
  cs.checking = true;
  await checkDeploys(due, { project, deploy, folder: "/repo", cs }, h, (m, res) => each.push([m.iid, res.state]));
  assert.equal(cs.checking, false);
  assert.deepEqual(each, [[1, "yes"], [2, "yes"], [3, "no"], [4, "error"]]);
  assert.deepEqual(told, [["deployed", "gitlab", "gitlab.com", "acme/shop", "m1", ""], ["deployed", "gitlab", "gitlab.com", "acme/shop", "m2", ""]]);
  assert.deepEqual(notes, [{ title: "Deployed · !1", body: "T1", level: "success" }], "never checked before: no notification");
  assert.equal(cs.checks.get("m4").state, "error");
  // A throwing forge, notify and onEach still end the run; no notify is fine.
  const cs2 = checkState();
  cs2.checks.set("m1", { state: "no", at: 0 });
  cs2.checking = true;
  const bad = { ...fakeH({ check: { code: 0 } }), forge: async () => { throw new Error("x"); }, notify: () => { throw new Error("y"); } };
  await checkDeploys([merged({ merge_sha: "m1" })], { project, deploy, folder: "/repo", cs: cs2 }, bad, () => { throw new Error("z"); });
  assert.equal(cs2.checking, false);
  assert.equal(cs2.checks.get("m1").state, "yes");
  const cs3 = checkState();
  cs3.checks.set("m1", { state: "no", at: 0 });
  await checkDeploys([merged({ merge_sha: "m1" })], { project, deploy, folder: "/repo", cs: cs3 }, { ...fakeH({ check: { code: 0 } }), forge: async () => {} });
  assert.equal(cs3.checks.get("m1").state, "yes", "no h.notify: no notification, no error");
  cs3.checking = true;
  await checkDeploys([], { project, deploy, folder: "/repo", cs: cs3 }, fakeH());
  assert.equal(cs3.checking, false, "an empty claim releases");
});

test("planCleanup waits for a running listing, lists again, and looks again at its own owners only", async () => {
  const look = lookState();
  const w = worktreeState();
  let release;
  const lists = [];
  const h = fakeH({
    agents: after.agents, panes: after.panes, terminals: after.terminals,
    list: () => { lists.push(1); return lists.length === 1 ? new Promise((r) => { release = () => r({ stdout: porcelain }); }) : { stdout: porcelain }; },
    look: (_args, opts) => ({ stdout: opts.cwd === "/wt/fix-login" ? `fix-login\n${remote}\nh7\n/wt/fix-login\n1\n` : "" }),
  });
  const tick = listWorktrees(w, { folder: "/repo" }, h); // a tick's listing, still running
  const pl = agentPlaces(after.agents, after.panes, after.terminals);
  const owner = pl.get("t1");
  const shared = { ...pl.get("t2"), shared: true };
  const ctx = { project, folder: "/repo", look, worktrees: w, listed: undefined };
  const a = planCleanup(merged(), [owner, shared], ctx, h);
  const b = planCleanup(merged(), [owner], ctx, h);
  release();
  await tick;
  const [plan] = await Promise.all([a, b]);
  assert.equal(lists.length, 3, "each plan lists again after the running one");
  const looks = h.calls.filter((c) => c.args?.[1] === GIT_LOOK).map((c) => c.cwd);
  assert.deepEqual(looks, ["/wt/fix-login", "/wt/fix-login"], "never a shared agent's folder");
  assert.deepEqual(plan.tabs, [{ id: "tab1", name: "fix-login" }]);
  assert.deepEqual(plan.worktrees, [{ machine: null, top: "/wt/fix-login", branch: "fix-login" }]);
  assert.equal(emptyPlan(plan), false);
  // Busy, and nothing at all.
  const busy = fakeH({ agents: [{ ...after.agents[0], status: "working" }], panes: after.panes, terminals: [],
    look: { stdout: `fix-login\n${remote}\nh7\n/wt/fix-login\n1\n` } });
  assert.match((await planCleanup(merged(), [owner], { ...ctx, worktrees: worktreeState() }, busy)).blocked, /still working/);
  const none = await planCleanup(merged(), [], { ...ctx, look: lookState(), worktrees: worktreeState() }, fakeH());
  assert.equal(emptyPlan(none), true);
  assert.equal(none.blocked, null);
});

test("runCleanup closes, ends, waits, removes, and never rejects", async () => {
  const look = lookState();
  look.git.set("k1", { top: "/wt/fix-login" });
  look.git.set("k2", { top: "/repo" });
  const w = worktreeState();
  w.at = 5;
  const plan = { blocked: null, tabs: [{ id: "tab1", name: "fix-login" }], kills: [{ address: "t5", name: "worker" }],
    worktrees: [{ machine: "mac", top: "/wt/fix-login", branch: "fix-login" }, { machine: null, top: "/wt/x", branch: "x" }], kept: [] };
  const h = fakeH({ clean: (args) => (args[3] === "/wt/x" ? new Error("away") : { stdout: "removed /wt/fix-login and fix-login" }) });
  const out = await runCleanup(merged(), plan, { look, worktrees: w }, h);
  assert.deepEqual(out, { said: ["closed fix-login", "ended worker", "removed /wt/fix-login and fix-login"], failed: ["/wt/x: away"] });
  assert.deepEqual(h.calls.filter((c) => c.run).map((c) => c.run), [["tab.close", { id: "tab1", confirmed: true }], ["terminal.kill", { terminal: "t5" }]]);
  assert.deepEqual(h.calls.filter((c) => c.sleep), [{ sleep: 1000 }]);
  const clean = h.calls.find((c) => c.args?.[1] === CLEAN_WORKTREE);
  assert.deepEqual([clean.args.slice(2), clean.on], [["sh", "/wt/fix-login", "fix-login", "h7"], "mac"]);
  assert.deepEqual([...look.git.keys()], ["k2"], "looks at a removed worktree are dropped");
  assert.equal(w.at, 0, "listed again on the next tick");
  // A refusal is a failed line; no sleep without both groups.
  const h2 = fakeH({ clean: { code: 3, stdout: "/wt/a has commits that weren't merged\n" } });
  const out2 = await runCleanup(merged(), { ...plan, tabs: [], kills: [], worktrees: [plan.worktrees[0]] }, { look, worktrees: w }, h2);
  assert.deepEqual(out2, { said: [], failed: ["/wt/a has commits that weren't merged"] });
  assert.deepEqual(h2.calls.filter((c) => c.sleep), []);
  // A throwing run becomes a failed line, and the promise resolves.
  const h3 = fakeH({ run: () => { throw new Error("no such tab"); } });
  const w3 = worktreeState();
  assert.deepEqual(await runCleanup(merged(), plan, { look, worktrees: w3 }, h3), { said: [], failed: ["no such tab"] });
});
