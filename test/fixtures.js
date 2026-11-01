// Fixtures the forge-requests, agents and cleanup tests share. Not a test file itself
// (npm test runs test/*.test.js).
import { spawnSync } from "node:child_process";
import { agentPlaces } from "../shared/agents.js";

export const now = 1000 * 3600000;
export const request = (over = {}) => ({
  iid: 7, title: "Fix login", url: "https://gitlab.com/acme/shop/-/merge_requests/7", draft: false,
  auto_merge: false, conflicts: false, source: "fix-login", target: "main", sha: "abc", author: "sam",
  labels: [], created_ms: now - 30 * 3600000, updated_ms: now, ci: null, ...over,
});

// ---- owning agents ----

export const herdr = {
  agents: [
    { address: "t1", pane: "p1", status: "working", tab_name: "fix-login", program: { name: "Claude" } },
    { address: "mbp/t4", pane: "p4", status: "idle", tab_name: "pm", program: { name: "Claude" } },
    { address: "t5", pane: "p5", status: "blocked", tab_name: "other" },
  ],
  panes: [
    { pane: "p1", cwd: "/w/shop-fix-login", branch: "fix-login" },
    { pane: "p4", cwd: "/Users/me/shop", branch: "main" },
    { pane: "p5", cwd: "/w/elsewhere", branch: "fix-login" },
  ],
  terminals: [
    { address: "mbp/t9", parent: "mbp/t4", state: "live", status: "done", cwd: "/Users/me/.herdr/worktrees/shop/add-csv", name: "worker" },
    { address: "mbp/t8", parent: "mbp/t4", state: "exited", status: "done", cwd: "/x" },
    { address: "t1", parent: null, state: "live", cwd: "/w/shop-fix-login" },
  ],
};
export const places = () => agentPlaces(herdr.agents, herdr.panes, herdr.terminals);
export const git = (pl, m) => new Map([...pl.values()].map((p) => [p.key, m[p.cwd] ?? { branch: null, remote: null }]));

// ---- after a merge ----

export const merged = (over = {}) => ({
  iid: 7, title: "Fix login", url: "u7", source: "fix-login", target: "main", fork: false,
  head_sha: "h7", merge_sha: "m7", merged_ms: now - 3600000, ci: { id: 3, status: "success", url: "c3" }, ...over,
});

// One worker in its own worktree tab, a PM elsewhere with a sub-agent in another worktree.
export const after = {
  agents: [
    { address: "t1", pane: "p1", tab: "tab1", status: "idle", tab_name: "fix-login" },
    { address: "t2", pane: "p3", tab: "tab2", status: "idle", tab_name: "pm" },
  ],
  panes: [
    { pane: "p1", tab: "tab1", terminal: "t1", cwd: "/wt/fix-login", branch: "fix-login" },
    { pane: "p2", tab: "tab1", terminal: "t9", cwd: "/wt/fix-login/src", branch: "fix-login" },
    { pane: "p3", tab: "tab2", terminal: "t2", cwd: "/repo", branch: "main" },
  ],
  terminals: [{ address: "t5", parent: "t2", state: "live", status: "done", cwd: "/wt/add-csv", name: "worker" }],
};
export const lookOf = (m) => (pl) => new Map([...pl.values()].map((p) => [p.key, m[p.cwd]]).filter(([, g]) => g));
export const remote = "git@gitlab.com:acme/shop.git";

// The scripts, run for real against a throwaway repo.
export const hasGit = spawnSync("git", ["--version"]).status === 0;
