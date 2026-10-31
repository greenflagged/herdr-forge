// Pure logic for forge-ci, kept out of main.js so it runs under plain Node (test/forge-ci.test.js).

// Statuses that can still change.
export const LIVE = new Set(["created", "waiting_for_resource", "preparing", "pending", "running", "scheduled"]);

// Something stuck in "pending" for hours shouldn't keep the fast poll going.
export const FRESH = 2 * 3600000;

// Seconds between polls: 10 while a recently updated pipeline is live and the window is
// in front, else 60. Also the maxAge the reads pass.
export function pollEvery(pipelines, active, now = Date.now()) {
  const live = active && pipelines.some((p) => LIVE.has(p.status) && p.updated_ms != null && now - p.updated_ms < FRESH);
  return live ? 10 : 60;
}

// Jobs in their groups (stage / workflow), groups in order of their first job:
// [{ group, jobs }]. Done once per answer, not per render.
export function groupJobs(jobs) {
  const out = [], at = new Map();
  for (const j of jobs ?? []) {
    const g = j.group ?? "";
    if (!at.has(g)) { at.set(g, out.length); out.push({ group: g, jobs: [] }); }
    out[at.get(g)].jobs.push(j);
  }
  return out;
}

// Whether an expanded pipeline's jobs need reading again: never read, still running, or
// the pipeline changed since they were read (it finished, or was retried).
export function jobsStale(p, loaded) {
  return !loaded || LIVE.has(p.status) || loaded.status !== p.status || loaded.updated_ms !== p.updated_ms;
}
