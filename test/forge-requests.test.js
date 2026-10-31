import assert from "node:assert/strict";
import { test } from "node:test";
import { actionList, fill, matches, projectOf, requestItem } from "../shared/lib.js";
import { CI, checkoutOf, defaultActions, liveAgents } from "../mods/forge-requests/requests.js";

const now = 1000 * 3600000;
const request = (over = {}) => ({
  iid: 7, title: "Fix login", url: "https://gitlab.com/acme/shop/-/merge_requests/7", draft: false,
  auto_merge: false, conflicts: false, source: "fix-login", target: "main", sha: "abc", author: "sam",
  labels: [], created_ms: now - 30 * 3600000, updated_ms: now, ci: null, ...over,
});

test("Ship shows on day-old requests without conflicts, Resolve on conflicted ones", () => {
  const project = projectOf({ repo: "acme/shop" });
  const shown = (r) => actionList(null, defaultActions(project.terms))
    .filter((a) => matches(a.when, requestItem(r, project), now)).map((a) => a.id);
  assert.deepEqual(shown(request()), ["ship"]);
  assert.deepEqual(shown(request({ created_ms: now - 3600000 })), []);
  assert.deepEqual(shown(request({ conflicts: true })), ["resolve"]);
});

test("default tasks fill every placeholder and use the forge's words", () => {
  for (const provider of ["gitlab", "github"]) {
    const project = projectOf({ repo: "acme/shop", provider });
    const item = requestItem(request(), project);
    for (const a of defaultActions(project.terms)) {
      assert.equal(a.worktree, true);
      const task = fill(a.task, item);
      assert.doesNotMatch(task, /\{\w+\}/, `${provider} ${a.id}: unfilled placeholder`);
      assert.match(task, provider === "gitlab" ? /merge request !7 in acme\/shop|Merge request !7/i : /pull request #7/i);
      assert.match(task, /fix-login/);
    }
    const ship = fill(defaultActions(project.terms)[0].task, item);
    assert.match(ship, provider === "gitlab" ? /glab mr merge 7 --sha/ : /gh pr merge 7 --match-head-commit/);
  }
});

test("checkoutOf prefers props.folder, else a space on that machine named after the repo", () => {
  const spaces = [
    { machine: "mac", folder: "/u/src/shop" },
    { machine: null, folder: "/home/me/src/other" },
    { machine: null, folder: "/home/me/.herdr/worktrees/x-shop" },
    { machine: null, folder: null },
  ];
  assert.equal(checkoutOf("/given", spaces, null, "acme/shop"), "/given");
  assert.equal(checkoutOf(null, spaces, "mac", "acme/shop"), "/u/src/shop");
  assert.equal(checkoutOf(null, spaces, null, "acme/shop"), "/home/me/.herdr/worktrees/x-shop");
  assert.equal(checkoutOf(undefined, spaces, undefined, "acme/none"), null);
  assert.equal(checkoutOf(null, spaces, null, ""), null);
});

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

test("CI covers every status in the contract", () => {
  for (const s of ["created", "waiting_for_resource", "preparing", "pending", "running", "success",
    "failed", "canceled", "skipped", "manual", "scheduled"]) assert.ok(CI[s], s);
});
