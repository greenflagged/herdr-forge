// forge-requests' pure parts: no Herdr imports, so test/forge-requests.test.js runs them
// under plain Node.

// A CI status as a one-glyph badge: glyph (null: spinner), theme color, still going.
// Statuses are GitLab's words on every forge (docs/contract.md).
export const CI = {
  created: [null, "working", true],
  waiting_for_resource: [null, "working", true],
  preparing: [null, "working", true],
  pending: [null, "working", true],
  running: [null, "working", true],
  scheduled: [null, "working", true],
  manual: ["▸", "muted", false],
  success: ["✓", "ansi2", false],
  failed: ["✗", "ansi1", false],
  canceled: ["–", "dim", false],
  skipped: ["–", "dim", false],
};

// Ship and Resolve, worded for the forge (terms from projectOf). Their tasks are templates:
// runAction fills {ref}, {repo}, {title}, {url}, {source}, {target}, {iid}.
export function defaultActions(terms) {
  const kind = terms.requests.replace(/s$/, "").toLowerCase(); // "merge request"
  const ci = terms.ciRun; // "pipeline"
  const mergeCmd = terms.cli === "gh"
    ? "gh pr merge {iid} --match-head-commit <head sha you checked>"
    : `${terms.cli} mr merge {iid} --sha <head sha you checked>`;
  return [
    {
      id: "ship", label: "Ship", worktree: true,
      when: { conflicts: false, minAgeHours: 24 },
      tooltip: "Start an agent to fix what's outstanding and merge",
      task: `Get ${kind} {ref} in {repo} merged: "{title}" ({url}), branch {source} into {target}. You're in its worktree.

1. Check whether it's ready, with ${terms.cli}: the ${ci} on the latest commit passed, no merge conflicts and not behind {target} in a way that blocks merging, every discussion thread resolved, required approvals met, not a draft.
2. Resolve whatever is outstanding: rebase on {target} and fix conflicts, fix failing jobs, address review comments (reply on the thread saying what you did, then resolve it). Push and wait for the new ${ci}.
3. Ask me first if a review comment needs a judgment call, if it's a draft, if it needs someone else's approval, or if fixing it would mean a large or risky change.
4. When everything is green, merge it with ${mergeCmd}, then tell me it's done.`,
    },
    {
      id: "resolve", label: "Resolve", worktree: true, primary: true, tone: "danger",
      when: { conflicts: true },
      tooltip: "Start an agent to rebase and resolve the conflicts",
      task: `${kind[0].toUpperCase()}${kind.slice(1)} {ref} in {repo} can't be merged because of conflicts with {target}: "{title}" ({url}), branch {source}. You're in its worktree.

1. Fetch and rebase {source} onto origin/{target}, resolving each conflict so both sides' intent survives. Read the commits on {target} that caused them first.
2. Ask me before choosing if a conflict needs a judgment call (both sides changed the same behavior in incompatible ways).
3. Build and run the tests that cover the files you touched, fix what broke, then push with --force-with-lease.
4. Wait for the ${ci} and fix it if it fails. Don't merge; tell me when it's clean and mergeable.`,
    },
  ];
}

// Where agent actions start: props.folder, else a space on `on` whose folder is named
// after the repo (…/shop, or a worktree-style …-shop).
export { checkoutOf } from "./lib.js";

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
