import assert from "node:assert/strict";
import { test } from "node:test";
import { projectOf } from "../shared/lib.js";
import {
  liveAgents, agentPlaces, ownersOf, askTarget, machineOf, placeKey, parseGitLook,
  placesOf, lookState, looksDue, claimLooks, lookAt, LOOK_EVERY, LOOK_EVERY_PANE,
} from "../shared/agents.js";
import { now, request, places, git } from "./fixtures.js";

test("liveAgents keeps top-level agents and live sub-agents, mapping terminal statuses", () => {
  const byAgent = new Map([["t1", { pane: "p1", program: { name: "Claude" }, status: "working" }]]);
  const byTerminal = new Map([
    ["t2", { state: "live", status: "error", program: null }],
    ["t3", { state: "exited", status: "done" }],
    ["t4", { state: "live", status: "done" }],
  ]);
  const list = [{ address: "t1", name: "a" }, { address: "t2", name: "b" }, { address: "t3", name: "c" },
    { address: "t4", name: "d" }, { address: "t9", name: "gone" }];
  assert.deepEqual(liveAgents(list, byAgent, byTerminal).map((a) => [a.address, a.status, a.pane]),
    [["t1", "working", "p1"], ["t2", "blocked", null], ["t4", "idle", null]]);
  assert.deepEqual(liveAgents(null, byAgent, byTerminal), []);
});

// ---- owning agents ----

test("agentPlaces lists agents with their pane's branch and live sub-agents by folder", () => {
  const pl = places();
  assert.deepEqual([...pl.keys()], ["t1", "mbp/t4", "t5", "mbp/t9"]);
  assert.equal(pl.get("t1").branch, "fix-login");
  assert.equal(pl.get("mbp/t9").machine, "mbp");
  assert.equal(pl.get("mbp/t9").status, "idle", "done sub-agents read as idle");
  assert.equal(pl.get("mbp/t9").parent, "mbp/t4");
  assert.equal(machineOf("t1"), null);
});

test("ownersOf matches the request's branch in a checkout of this project only", () => {
  const pl = places();
  const g = git(pl, {
    "/w/shop-fix-login": { branch: "fix-login", remote: "git@gitlab.com:acme/shop.git" },
    "/w/elsewhere": { branch: "fix-login", remote: "git@gitlab.com:acme/other.git" },
    "/Users/me/shop": { branch: "main", remote: "https://gitlab.com/acme/shop.git" },
    "/Users/me/.herdr/worktrees/shop/add-csv": { branch: "add-csv", remote: "https://gitlab.com/Acme/Shop" },
  });
  const project = projectOf({ repo: "acme/shop" });
  assert.deepEqual(ownersOf(request(), pl, g, project).map((o) => o.address), ["t1"], "same branch in another repo isn't ours");
  assert.deepEqual(ownersOf(request({ source: "add-csv" }), pl, g, project).map((o) => o.address), ["mbp/t9"], "sub-agent, path case-insensitive");
  assert.deepEqual(ownersOf(request({ fork: true }), pl, g, project), [], "never a fork's request");
  assert.deepEqual(ownersOf(request({ source: "nobody" }), pl, g, project), []);
  // The pane's live branch beats an older git answer.
  const moved = git(pl, { "/w/shop-fix-login": { branch: "old-branch", remote: "git@gitlab.com:acme/shop.git" } });
  assert.deepEqual(ownersOf(request(), pl, moved, project).map((o) => o.address), ["t1"]);
  assert.deepEqual(ownersOf(request(), pl, new Map(), project), [], "not looked at yet: no owner");
});

test("ownersOf works for GitHub remotes", () => {
  const pl = places();
  const g = git(pl, { "/w/shop-fix-login": { branch: "fix-login", remote: "https://github.com/acme/shop.git" } });
  const project = projectOf({ repo: "acme/shop", provider: "github" });
  assert.deepEqual(ownersOf(request({ iid: 12 }), pl, g, project).map((o) => o.address), ["t1"]);
});

test("askTarget prefers a top-level owner, else the sub-agent's parent", () => {
  const pl = places();
  assert.equal(askTarget([pl.get("t1")], pl).address, "t1");
  assert.equal(askTarget([pl.get("mbp/t9")], pl).address, "mbp/t4", "a worker's PM gets asked");
  assert.equal(askTarget([], pl), null);
  assert.equal(askTarget([{ address: "x", pane: null, parent: "gone" }], pl), null);
});

test("parseGitLook reads what GIT_LOOK printed", () => {
  assert.deepEqual(parseGitLook("feat\ngit@x:a/b.git\nabc\n/w/x\n1\n"),
    { branch: "feat", remote: "git@x:a/b.git", head: "abc", top: "/w/x", linked: true });
  assert.deepEqual(parseGitLook("\n\n"), { branch: null, remote: null, head: null, top: null, linked: false });
});

// ---- looking at agent folders, under fakes ----

// h.exec answers GIT_LOOK per folder: a string is stdout, an Error rejects.
const fakeExec = (answers, calls = []) => async (bin, args, opts) => {
  calls.push({ bin, args, ...opts });
  const a = answers[opts?.cwd];
  if (a instanceof Error) throw a;
  return { code: 0, stdout: a ?? "", stderr: "" };
};
const herdrOf = (agents, panes, terminals) => ({ agents: () => agents, panes: () => panes, terminals: () => terminals });

test("looksDue: each place by its own cadence, then one per folder", () => {
  // A pane and a sub-agent in the same folder: the pane reports its branch (10 min), the
  // sub-agent doesn't (1 min). Looked at 2 minutes ago: due, through the sub-agent.
  const pl = agentPlaces(
    [{ address: "t1", pane: "p1", status: "idle" }],
    [{ pane: "p1", cwd: "/w/a", branch: "a" }],
    [{ address: "t2", parent: "t1", state: "live", cwd: "/w/a" }, { address: "t3", parent: "t1", state: "live", cwd: "/w/a" }]);
  const key = placeKey(null, "/w/a");
  const g = new Map([[key, { branch: "a", remote: "r", at: now - 2 * 60000 }]]);
  assert.deepEqual(looksDue(pl, g, now).map((p) => p.address), ["t2"], "filtered by cadence, then deduplicated");
  assert.deepEqual(looksDue(pl, new Map(), now).map((p) => p.address), ["t1"], "never looked at: one per folder");
  assert.deepEqual(looksDue(pl, new Map([[key, { at: now - 1000 }]]), now), []);
  const panesOnly = agentPlaces([{ address: "t1", pane: "p1" }], [{ pane: "p1", cwd: "/w/a", branch: "a" }], []);
  assert.deepEqual(looksDue(panesOnly, new Map([[key, { at: now - LOOK_EVERY - 1 }]]), now), [], "a pane waits longer");
  assert.equal(looksDue(panesOnly, new Map([[key, { at: now - LOOK_EVERY_PANE }]]), now).length, 1);
});

test("claimLooks costs nothing while a look runs, and marks one running", () => {
  const look = lookState();
  let read = 0;
  const h = { agents: () => { read++; return [{ address: "t1", pane: "p1" }]; }, panes: () => [{ pane: "p1", cwd: "/w/a" }], terminals: () => [] };
  look.looking = true;
  assert.deepEqual(claimLooks(look, h, now), []);
  assert.equal(read, 0, "Herdr isn't asked while a look runs");
  look.looking = false;
  assert.equal(claimLooks(look, h, now).length, 1);
  assert.equal(look.looking, true);
  look.looking = false;
  look.git.set(placeKey(null, "/w/a"), { at: now });
  assert.deepEqual(claimLooks(look, h, now), []);
  assert.equal(look.looking, false, "nothing due: no claim");
  assert.deepEqual([...placesOf({ agents: () => { throw new Error("x"); } })], [], "Herdr throwing: no places");
});

test("lookAt records what git said, keeps the whole old entry on failure, and always ends the claim", async () => {
  const look = lookState();
  const pl = [...agentPlaces([{ address: "t1", pane: "p1" }, { address: "m/t2", pane: "p2" }],
    [{ pane: "p1", cwd: "/w/a" }, { pane: "p2", cwd: "/w/b" }], []).values()];
  const old = { branch: "b", remote: "r", head: "h", top: "/w/b", linked: true, at: 1 };
  look.git.set(pl[1].key, old);
  look.looking = true;
  const calls = [];
  await lookAt(pl, look, { exec: fakeExec({ "/w/a": "a\nr\nh1\n/w/a\n1\n", "/w/b": new Error("away") }, calls) });
  assert.equal(look.looking, false);
  assert.deepEqual(calls.map((c) => [c.cwd, c.on]), [["/w/a", null], ["/w/b", "m"]]);
  assert.equal(look.git.get(pl[0].key).top, "/w/a");
  const kept = look.git.get(pl[1].key);
  assert.deepEqual({ ...kept, at: 1 }, old, "every old field kept");
  assert.ok(kept.at > 1, "with a fresh at");
  look.looking = true;
  await lookAt([], look, { exec: fakeExec({}) });
  assert.equal(look.looking, false, "an empty claim releases");
});
