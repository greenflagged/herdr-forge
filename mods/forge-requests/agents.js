// Which agents are on a request: where every agent and live sub-agent is, what git says
// about each folder, and the ones on a request's branch in a checkout of the project.
// Shared by every mod that shows agents on requests (forge-requests, and other packages:
// docs/contract.md "Sharing code with other packages"). No Herdr imports, so the tests run
// it under plain Node: Herdr's functions come in as `h`.

import { parseRemote } from "./lib.js";

// What other packages call (docs/contract.md "Sharing code with other packages", provisional):
// a change to one of these is named in the PR that makes it. Everything else exported here
// is internal. test/shared-api.test.js checks each is exported; a consumer's imports test can
// read this list from its synced copy.
export const PROMISED = [
  "lookState", "placesOf", "claimLooks", "lookAt", "ownersOf", "withShared", "askTarget", "liveAgents",
];

// The agents on one request, from shared("forge.requestAgents")[url], with their live
// status: top-level agents by address, else live sub-agents among the terminals. Ones
// that ended drop out here even before the publisher updates.
// byAgent / byTerminal: Maps of address -> agents() / terminals() entry.
export function liveAgents(list, byAgent, byTerminal) {
  if (!Array.isArray(list) || !list.length) return [];
  return list.flatMap(({ address, name }) => {
    const a = byAgent.get(address);
    if (a) return [{ address, name, pane: a.pane, program: a.program, status: a.status }];
    const k = byTerminal.get(address);
    if (!k || k.state !== "live") return [];
    const status = k.status === "error" ? "blocked" : k.status === "done" ? "idle" : k.status;
    return [{ address, name, pane: null, program: k.program, status }];
  });
}

// ---- the agents that own a request ----
// An agent owns a request when its folder is a checkout of the project on the request's
// source branch. Herdr says where every agent and live sub-agent is (and, for panes, the
// branch); lookAt below looks up the rest with git, into the `git` Map ownersOf reads.

export const machineOf = (address) => {
  const i = (address ?? "").indexOf("/");
  return i > 0 ? address.slice(0, i) : null;
};
export const placeKey = (machine, cwd) => JSON.stringify([machine, cwd]);

// address -> { address, key, machine, cwd, branch, parent, pane, status, program, name }
// from agents(), panes() and terminals(). Sub-agents have no pane: branch null, parent set.
export function agentPlaces(agentList, paneList, terminalList) {
  const byPane = new Map((paneList ?? []).map((p) => [p.pane, p]));
  const out = new Map();
  for (const a of agentList ?? []) {
    const p = byPane.get(a.pane);
    if (!p?.cwd) continue;
    const machine = machineOf(a.address);
    out.set(a.address, {
      address: a.address, key: placeKey(machine, p.cwd), machine, cwd: p.cwd, branch: p.branch ?? null,
      parent: null, pane: a.pane, tab: a.tab ?? p.tab ?? null, tabName: a.tab_name ?? null,
      status: a.status, program: a.program,
      name: a.tab_name || a.space_name || a.program?.name || a.address,
    });
  }
  for (const k of terminalList ?? []) {
    if (out.has(k.address) || !k.parent || k.state !== "live" || !k.cwd) continue;
    const machine = machineOf(k.address);
    out.set(k.address, {
      address: k.address, key: placeKey(machine, k.cwd), machine, cwd: k.cwd, branch: null,
      parent: k.parent, pane: null, tab: null, tabName: null, status: k.status === "error" ? "blocked" : k.status === "done" ? "idle" : k.status ?? null,
      program: k.program, name: k.name || k.template || k.program?.name || k.address,
    });
  }
  return out;
}

// Asks git about a folder: its branch, remote, HEAD, top folder, and whether that's a
// linked worktree (its .git is a file) rather than the main checkout.
export const GIT_LOOK = `t=$(git rev-parse --show-toplevel 2>/dev/null)
printf '%s\\n%s\\n%s\\n%s\\n%s\\n' "$(git branch --show-current 2>/dev/null)" "$(git remote get-url origin 2>/dev/null)" \\
  "$(git rev-parse HEAD 2>/dev/null)" "$t" "$([ -n "$t" ] && [ -f "$t/.git" ] && echo 1)"`;

// What GIT_LOOK printed -> { branch, remote, head, top, linked }.
export function parseGitLook(stdout) {
  const [branch = "", remote = "", head = "", top = "", linked = ""] = String(stdout ?? "").split("\n").map((l) => l.trim());
  return { branch: branch || null, remote: remote || null, head: head || null, top: top || null, linked: linked === "1" };
}

// The places working on request r. git: Map key -> { branch, remote }. A pane's live
// branch beats what git said earlier; the remote must be this project (a branch with the
// same name in another repo isn't ours). Never a fork's request: its branch name says
// nothing about our checkouts.
export function ownersOf(r, places, git, project) {
  if (!r?.source || r.fork || !project?.repo) return [];
  const repo = project.repo.toLowerCase();
  const out = [];
  for (const pl of places.values()) {
    const g = git.get(pl.key);
    if (!g) continue;
    if ((pl.branch ?? g.branch) !== r.source) continue;
    const remote = parseRemote(g.remote);
    if (!remote || remote.path.toLowerCase() !== repo) continue;
    out.push(pl);
  }
  return out;
}

// The owners plus the agents another panel says are on the request (shared
// forge.requestAgents: [{ address }]). Work finds those from where an agent's processes
// run, so it catches a worker whose own folder is the main checkout but whose work is in
// the branch's worktree. Marked shared: Clean up ends them but never takes their folder.
export function withShared(owners, list, places) {
  if (!Array.isArray(list) || !list.length) return owners;
  const have = new Set(owners.map((o) => o.address));
  const more = list.map(({ address }) => places.get(address)).filter((pl) => pl && !have.has(pl.address));
  return more.length ? [...owners, ...more.map((pl) => ({ ...pl, shared: true }))] : owners;
}

// Who to talk to about a request: a top-level owner, else the agent that started an
// owning sub-agent (it's the one running that work). null: no one we can type to.
export function askTarget(owners, places) {
  const top = owners.find((o) => o.pane);
  if (top) return top;
  for (const o of owners) {
    const parent = o.parent ? places.get(o.parent) : null;
    if (parent?.pane) return parent;
  }
  return null;
}

// ---- looking at agent folders with git ----
// Each agent folder's branch and remote (GIT_LOOK), looked up with git on the agent's
// machine. A folder whose pane reports its branch only needs the remote, which rarely
// changes, so it's looked at less often.

export const LOOK_EVERY = 60 * 1000;        // folders whose branch only git knows (sub-agents)
export const LOOK_EVERY_PANE = 10 * 60 * 1000;

// Where the agents are, from Herdr (cheap; read again on every render). h: { agents, panes, terminals }.
export function placesOf(h) {
  try { return agentPlaces(h.agents(), h.panes(), h.terminals()); } catch { return new Map(); }
}

// What a view keeps between ticks: git: Map place key -> { branch, remote, head, top, linked, at },
// and whether a look is running. Keep one per view; never reset `looking` yourself.
export function lookState() {
  return { git: new Map(), looking: false };
}

// The places to look at now: each place whose look is missing or older than its cadence,
// then one per folder (a pane and a sub-agent in the same folder share one look).
export function looksDue(places, git, now = Date.now(), { every = LOOK_EVERY, everyPane = LOOK_EVERY_PANE } = {}) {
  const due = [], seen = new Set();
  for (const pl of places.values()) {
    const g = git.get(pl.key);
    if (g && now - g.at < (pl.branch ? everyPane : every)) continue;
    if (seen.has(pl.key)) continue;
    seen.add(pl.key);
    due.push(pl);
  }
  return due;
}

// Call on each tick before spawning anything: [] at once while a look runs (so a tick
// then costs nothing), else the places due. A non-empty claim marks the look running:
// hand it to exactly one lookAt (lookAt([]) releases it). h: { agents, panes, terminals }.
export function claimLooks(look, h, now = Date.now(), opts = {}) {
  if (look.looking) return [];
  const due = looksDue(placesOf(h), look.git, now, opts);
  if (due.length) look.looking = true;
  return due;
}

// Asks git about each claimed place, one at a time, so a machine that's away holds up
// nothing else. Never rejects; ends the claim. h: { exec }.
export async function lookAt(due, look, h) {
  try {
    for (const pl of due) {
      try {
        const r = await h.exec("sh", ["-c", GIT_LOOK], { cwd: pl.cwd, on: pl.machine });
        look.git.set(pl.key, { ...parseGitLook(r.stdout), at: Date.now() });
      } catch {
        // Machine away or folder gone: keep what we had, look again later.
        look.git.set(pl.key, { ...(look.git.get(pl.key) ?? { branch: null, remote: null }), at: Date.now() });
      }
    }
  } finally {
    look.looking = false;
  }
}
