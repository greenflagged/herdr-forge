// After a merge: did it deploy, which worktrees did its agents leave, and Clean up (end
// the agents, remove the worktrees). Shared like agents.js (docs/contract.md "Sharing code
// with other packages"); no Herdr imports, Herdr's functions come in as `h`.

import { GIT_LOOK, parseGitLook, ownersOf, withShared, placesOf } from "./agents.js";

// What other packages call (docs/contract.md "Sharing code with other packages", provisional):
// a change to one of these is named in the PR that makes it. Everything else exported here
// is internal. test/shared-api.test.js checks each is exported; a consumer's imports test can
// read this list from its synced copy.
export const PROMISED = [
  "worktreeState", "checkState", "worktreesDue", "listWorktrees", "seedChecks", "claimChecks", "checkDeploys",
  "planCleanup", "emptyPlan", "cleanupLines", "runCleanup", "deployState", "notDoneWhy", "shownMerged", "leftoversOf",
];

const message = (e) => String(e?.message ?? e);

// ---- after a merge: deployed yet, then clean up ----
// forge.py's `merged` lists what merged lately, with the merge commit's pipeline. A
// project may add a deploy check (props.deploy, docs/actions.md): a shell snippet run in
// its checkout with the merge commit as $1, exiting 0 once that commit is live, 1 until then.

export const RECENT = 24 * 3600000;     // merged this lately: shown whether or not anyone's on it
const NO_CI_GRACE = 10 * 60000;         // no pipeline this long after merging: there won't be one

// The merged requests worth a row: recent ones, and older ones an agent is still on or
// that left a worktree behind (leftoversOf(m): the ones on its branch, as below).
export function shownMerged(merged, ownersOfReq, now, leftoversOf = () => []) {
  return (merged ?? []).filter((m) => now - m.merged_ms < RECENT
    || (!m.fork && (ownersOfReq(m).length > 0 || leftoversOf(m).length > 0)));
}

// Workers often finish and exit, leaving their worktree behind with no agent in it. The
// checkout's worktrees come from `git worktree list --porcelain` run there.
export const WORKTREE_LIST = ["worktree", "list", "--porcelain"];

// What WORKTREE_LIST printed -> the linked worktrees on a branch: [{ top, head, branch }].
// Leaves out the main checkout (always first), detached ones, locked ones (git won't
// remove them without --force) and prunable ones (their folder is already gone).
export function parseWorktrees(stdout) {
  const out = [];
  const blocks = String(stdout ?? "").split(/\n\s*\n/).map((b) => b.split("\n").filter(Boolean)).filter((b) => b.length);
  for (const lines of blocks.slice(1)) {
    const w = {};
    for (const l of lines) {
      const i = l.indexOf(" ");
      const [k, v] = i < 0 ? [l, ""] : [l.slice(0, i), l.slice(i + 1)];
      w[k] = v;
    }
    if (!w.worktree || !w.branch?.startsWith("refs/heads/") || "locked" in w || "prunable" in w || "bare" in w) continue;
    out.push({ top: w.worktree, head: w.HEAD || null, branch: w.branch.slice("refs/heads/".length) });
  }
  return out;
}

// The worktrees still on merged request m's branch (never for a fork's request).
export function leftoversOf(m, worktrees) {
  if (!m?.source || m.fork) return [];
  return (worktrees ?? []).filter((w) => w.branch === m.source);
}

// Where a merged request has got to. checks: Map merge sha -> { state: "yes"|"no"|"error", text }.
// ci: the merge commit's CI status, or "none" (no pipeline, and there won't be one).
// deploy: null without a check, else "waiting" (for CI), "checking", "yes", "no", "error", "blocked" (CI failed).
// done: nothing more to wait for, so it's time to clean up.
export function deployState(m, deploy, checks, now) {
  const status = m.ci?.status ?? (now - m.merged_ms >= NO_CI_GRACE ? "none" : "pending");
  const ciDone = status === "success" || status === "none";
  const ciBad = status === "failed" || status === "canceled";
  if (!deploy?.check) return { ci: status, deploy: null, done: ciDone };
  const c = checks?.get(m.merge_sha);
  const d = ciBad ? "blocked" : !ciDone ? "waiting" : c?.state ?? "checking";
  return { ci: status, deploy: d, done: d === "yes", text: c?.text ?? null };
}

// Should this merged request's deploy check run now? Only once its CI is through, never
// again once it says yes, and not more than every `every` ms otherwise.
export function checkDue(m, deploy, checks, now, every) {
  if (!deploy?.check || !m.merge_sha) return false;
  const st = deployState(m, deploy, checks, now);
  if (st.deploy === "waiting" || st.deploy === "blocked" || st.deploy === "yes") return false;
  const c = checks?.get(m.merge_sha);
  return !c || now - c.at >= every;
}

// What "Clean up" would do for a merged request m, from its owners (ownersOf), every place
// (agentPlaces), panes() and terminals(), what git said about each folder, and the
// worktrees left on its branch with no agent in them (leftoversOf; on `machine`).
// { blocked: why not | null, tabs: [{ id, name }] to close, kills: [{ address, name }] to end,
//   worktrees: [{ machine, top, branch }] to remove, kept: [{ top, why }] }
export function cleanupPlan(m, owners, places, paneList, terminalList, git, leftovers = [], machine = null) {
  const plan = { blocked: null, tabs: [], kills: [], worktrees: [], kept: [] };
  if (!owners.length && !leftovers.length) return plan;
  const owning = new Set(owners.map((o) => o.address));
  // Ending an agent ends its sub-agents too: none of them may be busy.
  const kids = (terminalList ?? []).filter((k) => k.state === "live" && owning.has(k.parent));
  const statusOf = (x) => places.get(x.address)?.status ?? (x.status === "error" ? "blocked" : x.status);
  const busy = [...owners, ...kids].find((x) => ["working", "blocked"].includes(statusOf(x)));
  if (busy) {
    const name = places.get(busy.address)?.name ?? busy.name ?? busy.address;
    plan.blocked = `${name} is ${statusOf(busy) === "blocked" ? "waiting for you" : "still working"}`;
    return plan;
  }
  const tops = new Map(); // place key -> git look
  for (const o of owners) {
    const g = o.shared ? null : git.get(o.key);
    if (g?.top) tops.set(JSON.stringify([o.machine, g.top]), { machine: o.machine, ...g });
  }
  const inside = (cwd, top) => cwd === top || cwd?.startsWith(top.endsWith("/") ? top : `${top}/`);
  for (const o of owners) {
    if (o.parent && owning.has(o.parent)) continue; // its parent's ending covers it
    const top = o.shared ? null : git.get(o.key)?.top;
    // A tab of nothing but this worktree's terminals goes with it; otherwise just the agent.
    const tabPanes = o.tab ? (paneList ?? []).filter((p) => p.tab === o.tab && p.terminal) : [];
    if (o.tab && top && tabPanes.length && tabPanes.every((p) => inside(p.cwd, top))) {
      if (!plan.tabs.some((t) => t.id === o.tab)) plan.tabs.push({ id: o.tab, name: o.tabName ?? o.name });
    } else {
      plan.kills.push({ address: o.address, name: o.name ?? o.address });
    }
  }
  for (const g of tops.values()) {
    if (!g.linked) plan.kept.push({ top: g.top, why: "the main checkout" });
    else if (g.branch !== m.source) plan.kept.push({ top: g.top, why: `on ${g.branch ?? "no branch"}, not ${m.source}` });
    else if (!m.head_sha) plan.kept.push({ top: g.top, why: "the request's head commit is unknown" });
    else if (g.head !== m.head_sha) plan.kept.push({ top: g.top, why: "it has commits that weren't merged" });
    else plan.worktrees.push({ machine: g.machine, top: g.top, branch: g.branch });
  }
  // Left behind with no agent. A terminal open in one (a shell, say) keeps it: removing
  // the folder under it would strand it. The owners' tabs and terminals are going anyway.
  const going = new Set(plan.tabs.map((t) => t.id));
  const ending = new Set([...owning, ...(terminalList ?? []).filter((k) => owning.has(k.parent)).map((k) => k.address)]);
  const covered = new Set([...tops.values()].map((g) => g.top));
  for (const w of leftovers) {
    if (covered.has(w.top) || w.branch !== m.source) continue;
    covered.add(w.top);
    const open = (paneList ?? []).some((p) => !going.has(p.tab) && !ending.has(p.terminal) && inside(p.cwd, w.top))
      || (terminalList ?? []).some((k) => k.state === "live" && !ending.has(k.address) && inside(k.cwd, w.top));
    if (open) plan.kept.push({ top: w.top, why: "a terminal is open in it" });
    else if (!m.head_sha) plan.kept.push({ top: w.top, why: "the request's head commit is unknown" });
    else if (w.head !== m.head_sha) plan.kept.push({ top: w.top, why: "it has commits that weren't merged" });
    else plan.worktrees.push({ machine, top: w.top, branch: w.branch });
  }
  return plan;
}

// Why a merged request isn't through yet, in words, or null when it is (deployState).
export function notDoneWhy(st, deploy, terms) {
  if (st.done) return null;
  const label = deploy?.label ?? "Deploy";
  if (st.ci === "failed" || st.ci === "canceled") return `${terms.ciRun} ${st.ci} on the merge commit`;
  if (!deploy?.check || st.deploy === "waiting") return `${terms.ciRun} still running on the merge commit`;
  if (st.deploy === "error") return `${label} check failed${st.text ? `: ${st.text}` : ""}`;
  return `${label} hasn't confirmed it yet${st.text ? ` (${st.text})` : ""}`;
}

// The confirm's lines: a warning when it isn't deployed, then exactly what goes, and
// what stays and why.
export function cleanupLines(plan, why = null) {
  const out = why ? [`Not deployed: ${why}`] : [];
  for (const t of plan.tabs) out.push(`Close tab ${t.name} and its agent`);
  if (plan.kills.length) out.push(`End ${plan.kills.map((k) => k.name).join(", ")}`);
  for (const w of plan.worktrees) out.push(`Remove worktree ${w.top} and branch ${w.branch}`);
  for (const k of plan.kept) out.push(`Keep ${k.top}: ${k.why}`);
  return out;
}

// Removes one worktree and its branch: sh -c CLEAN_WORKTREE sh <worktree> <branch> <merged head>.
// Checks again first (it's still a linked worktree, on that branch, and the merged head is
// known and is the commit it's at); `git worktree remove` without --force refuses changes
// and untracked files.
// Prints why on failure (exit 3: refused before touching anything).
export const CLEAN_WORKTREE = `wt=$1 br=$2 head=$3
[ -f "$wt/.git" ] || { echo "$wt isn't a linked worktree"; exit 3; }
[ "$(git -C "$wt" branch --show-current)" = "$br" ] || { echo "$wt isn't on $br any more"; exit 3; }
[ -n "$head" ] || { echo "the merged head commit of $wt is unknown: refusing"; exit 3; }
[ "$(git -C "$wt" rev-parse HEAD)" = "$head" ] || { echo "$wt has commits that weren't merged"; exit 3; }
main=$(git -C "$wt" worktree list --porcelain | sed -n '1s/^worktree //p')
[ -n "$main" ] || { echo "can't find the main checkout of $wt"; exit 3; }
git -C "$main" worktree remove -- "$wt" 2>&1 || exit 4
git -C "$main" branch -D -- "$br" >/dev/null 2>&1 || { echo "removed $wt; couldn't delete branch $br"; exit 5; }
echo "removed $wt and $br"`;

export const emptyPlan = (plan) => !plan.tabs.length && !plan.kills.length && !plan.worktrees.length;

// ---- the flows: what a view calls each tick and from its Clean up button ----
// Each takes a state object made here (keep one per view, never reset its flag yourself)
// and Herdr's functions as `h`. Claims are cheap and run before any spawn (Herdr runs mod
// code on its main thread). The ones that hold a busy flag (listWorktrees, checkDeploys)
// never reject, so it always clears; planCleanup holds none and may reject: catch it.

export const DEPLOY_EVERY = 60 * 1000;         // a deploy check that said "not yet" runs again after this
export const WORKTREES_EVERY = 2 * 60 * 1000;  // the checkout's worktrees, for ones merged work left behind

// The checkout's linked worktrees (parseWorktrees), on `machine`, listed at `at`.
// pending: the running listing's promise, or null.
export function worktreeState() {
  return { list: [], at: 0, folder: null, machine: null, pending: null };
}

// Whether to list them on this tick: not while a listing runs, only while there are
// merged requests (`merged`: whatever list the caller passes), every couple of minutes.
export function worktreesDue(w, merged, now = Date.now(), every = WORKTREES_EVERY) {
  return !w.pending && (merged?.length ?? 0) > 0 && now - w.at >= every;
}

// One `git worktree list` in the checkout (folder, on `on`), so a merged request whose
// worker already exited still gets Clean up for the worktree it left. Returns at once
// while a listing runs; a failure keeps the last list. Never rejects. h: { exec }.
export async function listWorktrees(w, { folder, on = null }, h) {
  if (w.pending) return;
  if (!folder) { Object.assign(w, { list: [], at: Date.now() }); return; }
  let finished;
  w.pending = new Promise((resolve) => { finished = resolve; });
  try {
    const r = await h.exec("git", WORKTREE_LIST, { cwd: folder, on });
    if (r.code === 0) Object.assign(w, { list: parseWorktrees(r.stdout), folder, machine: on ?? null });
  } catch {
    // Machine away: keep what we had, look again later.
  } finally {
    w.at = Date.now();
    w.pending = null; // before anyone waiting on it resumes
    finished();
  }
}

// What a view keeps of the deploy checks: checks: Map merge sha -> { state, text, at },
// and whether a run is going. Keep one per view; never reset `checking` yourself.
export function checkState() {
  return { checks: new Map(), checking: false };
}

// Confirmed before (by this window or another, forge.py `merged`'s `deployed`): final, no
// need to check again. Call right after storing a new merged list, so the next render
// already shows it deployed.
export function seedChecks(merged, cs) {
  for (const m of merged ?? []) {
    if (m.deployed && m.merge_sha) cs.checks.set(m.merge_sha, { state: "yes", text: m.deployed.text || null, at: m.deployed.at_ms });
  }
}

// Call on each tick before spawning anything: the merged requests (the ones on screen)
// whose deploy check is due. [] without a check or while a run is going. A non-empty
// claim marks the run going: hand it to exactly one checkDeploys (checkDeploys([]) releases it).
export function claimChecks(merged, deploy, cs, now = Date.now(), every = DEPLOY_EVERY) {
  if (!deploy?.check || cs.checking) return [];
  // Seeds only what it hasn't seen, so a tick doesn't rewrite every shown request's entry.
  seedChecks((merged ?? []).filter((m) => !cs.checks.has(m.merge_sha)), cs);
  const due = (merged ?? []).filter((m) => checkDue(m, deploy, cs.checks, now, every));
  if (due.length) cs.checking = true;
  return due;
}

// Runs the project's deploy check (props.deploy.check) once, in the checkout, with the
// merge commit as $1. Exit 0: deployed. 1: not yet. Anything else: the check itself failed.
// h: { exec }.
export async function checkDeploy(m, { check, folder, on = null }, h) {
  if (!folder) return { state: "error", text: "No checkout of the repo found (set props.folder)." };
  try {
    const r = await h.exec("sh", ["-c", check, "sh", m.merge_sha], { cwd: folder, on });
    const text = `${r.stdout ?? ""}\n${r.stderr ?? ""}`.trim().split("\n")[0] || null;
    return { state: r.code === 0 ? "yes" : r.code === 1 ? "no" : "error", text: text ?? (r.code > 1 ? `exited ${r.code}` : null) };
  } catch (e) {
    return { state: "error", text: message(e) };
  }
}

// The claimed checks, one at a time. A yes is remembered on the forge machine (so a
// restart, or another window, doesn't check again), and one that turns yes after saying
// otherwise notifies. onEach(m, res) after each, to redraw. Never rejects; ends the claim.
// h: { exec, forge, notify? }.
export async function checkDeploys(due, { project, deploy, folder, cs }, h, onEach = () => {}) {
  try {
    for (const m of due) {
      const res = await checkDeploy(m, { check: deploy?.check, folder, on: project.on }, h);
      const was = cs.checks.get(m.merge_sha)?.state;
      cs.checks.set(m.merge_sha, { ...res, at: Date.now() });
      if (res.state === "yes") {
        const { provider, host, repo } = project;
        try { await h.forge(["deployed", provider, host, repo, m.merge_sha, res.text ?? ""], { on: project.on }); } catch {}
      }
      if (res.state === "yes" && was && was !== "yes" && h.notify) {
        try { h.notify({ title: `Deployed · ${project.terms.reqPrefix}${m.iid}`, body: m.title ?? "", level: "success" }); } catch {}
      }
      try { onEach(m, res); } catch {}
    }
  } catch {
    // Nothing above throws; the claim must end regardless.
  } finally {
    cs.checking = false;
  }
}

// Clean up, step one: list the worktrees again (waiting for a listing that's running),
// look at the owners' folders again (HEAD may have moved since the last look), then work
// out exactly what will go. listed: shared("forge.requestAgents")?.[m.url].
// h: { exec, agents, panes, terminals }.
export async function planCleanup(m, owners, { project, folder, look, worktrees, listed }, h) {
  while (worktrees.pending) await worktrees.pending;
  await listWorktrees(worktrees, { folder, on: project.on }, h);
  for (const o of owners.filter((x) => !x.shared)) {
    try {
      const r = await h.exec("sh", ["-c", GIT_LOOK], { cwd: o.cwd, on: o.machine });
      look.git.set(o.key, { ...parseGitLook(r.stdout), at: Date.now() });
    } catch {}
  }
  const places = placesOf(h);
  const fresh = withShared(ownersOf(m, places, look.git, project), listed, places);
  let ps = [], ks = [];
  try { ps = h.panes(); ks = h.terminals(); } catch {}
  return cleanupPlan(m, fresh, places, ps, ks, look.git, leftoversOf(m, worktrees.list), worktrees.machine ?? null);
}

// Clean up, step two: close the tabs, end the agents, then remove each worktree and its
// branch (CLEAN_WORKTREE checks again and refuses anything that wasn't merged).
// -> { said, failed }: lines for the caller to word. Never rejects. h: { exec, run, sleep }.
export async function runCleanup(m, plan, { look, worktrees }, h) {
  const said = [], failed = [];
  try {
    // confirmed: our own confirm already listed the tab.
    for (const t of plan.tabs) { h.run("tab.close", { id: t.id, confirmed: true }); said.push(`closed ${t.name}`); }
    for (const k of plan.kills) { h.run("terminal.kill", { terminal: k.address }); said.push(`ended ${k.name}`); }
    if (plan.worktrees.length && (plan.tabs.length || plan.kills.length)) await h.sleep(1000); // let their shells go
    for (const w of plan.worktrees) {
      try {
        const r = await h.exec("sh", ["-c", CLEAN_WORKTREE, "sh", w.top, w.branch, m.head_sha ?? ""], { on: w.machine });
        const text = (r.stdout || r.stderr || "").trim().split("\n").pop();
        (r.code === 0 ? said : failed).push(text || `exited ${r.code}`);
      } catch (e) {
        failed.push(`${w.top}: ${message(e)}`);
      }
      for (const [key, g] of look.git) if (g.top === w.top) look.git.delete(key);
    }
    if (plan.worktrees.length) worktrees.at = 0; // list them again on the next tick
  } catch (e) {
    failed.push(message(e));
  }
  return { said, failed };
}
