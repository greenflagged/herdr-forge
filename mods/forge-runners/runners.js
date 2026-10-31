// Pure logic for forge-runners, kept out of main.js so it runs under plain Node
// (test/forge-runners.test.js). forge.py already decides running / elsewhere / stuck;
// this only arranges the answer for drawing, once per answer rather than per render.

// Seconds between polls: 20 while jobs run or wait and the window is in front, else 60.
// Also the maxAge the reads pass.
export function pollEvery(jobs, active) {
  return active && jobs.length ? 20 : 60;
}

// { runners, up, elsewhere, queued } from a `runners` answer:
// - runners: online first, then by name; each with `jobs`, the CiJobs it runs.
// - up: how many are online and not paused.
// - elsewhere: running jobs on a runner that isn't the project's (a shared one).
// - queued: pending jobs, oldest first.
export function arrange(answer) {
  const jobs = answer?.jobs ?? [];
  const byId = new Map(jobs.map((j) => [j.id, j]));
  const runners = (answer?.runners ?? []).map((r) => ({
    ...r, jobs: (r.running ?? []).map((id) => byId.get(id)).filter(Boolean),
  }));
  runners.sort((a, b) => (b.status === "online") - (a.status === "online") || (a.name ?? "").localeCompare(b.name ?? ""));
  return {
    runners,
    up: runners.filter((r) => r.status === "online" && !r.paused).length,
    elsewhere: jobs.filter((j) => j.elsewhere),
    queued: jobs.filter((j) => j.status === "pending").sort((a, b) => (a.created_ms ?? 0) - (b.created_ms ?? 0)),
  };
}
