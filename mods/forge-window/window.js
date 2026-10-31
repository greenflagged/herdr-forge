// The Forge window's layout and settings, kept free of Herdr imports so they're tested
// under plain Node.

// The panels the window can hold, in order, with where they go.
export const PANELS = [
  { name: "requests", mod: "forge-requests", label: "MRs", side: "left" },
  { name: "milestones", mod: "forge-milestones", label: "Milestones", side: "left" },
  { name: "velocity", mod: "forge-velocity", label: "Velocity", side: "left", px: 330 },
  { name: "ci", mod: "forge-ci", label: "CI", px: 330 },
  { name: "runners", mod: "forge-runners", label: "Runners", px: 290 },
  { name: "issues", mod: "forge-issues", label: "Issues" },
];

// `forge.json` in Herdr's folder (optional):
//   { "forges": { "git.acme.io": "gitlab" },
//     "projects": { "gitlab.com/acme/shop": { "on": "my-mac", "folder": "/src/shop",
//                   "issues": { "triage": true, "actions": [...] }, "requests": { "actions": [...] } } },
//     "hidden": ["runners"] }
// Bad JSON or a missing file is no settings, not an error that stops the window.
export function parseConfig(text) {
  try {
    const c = JSON.parse(text ?? "");
    return c && typeof c === "object" && !Array.isArray(c) ? c : {};
  } catch {
    return {};
  }
}

export const projectKey = (p) => (p ? `${p.host}/${p.repo}` : "");

// A project's settings: the file's entry for it over what was found from the terminal.
export function withConfig(project, config) {
  const own = config?.projects?.[projectKey(project)] ?? {};
  return { ...project, on: own.on !== undefined ? own.on : project.on, folder: own.folder ?? project.folder };
}

// The window's layout: the bar on top, then the left column (MRs, milestones, velocity),
// CI, runners and the issue browser, leaving out hidden panels.
export function forgeLayout(project, hidden = [], config = {}) {
  const own = config?.projects?.[projectKey(project)] ?? {};
  const base = { provider: project.provider, host: project.host, repo: project.repo, on: project.on ?? null };
  const block = (p, props) => ({
    id: `forge-${p.name}`, type: "block", ...(p.px ? { size: { px: p.px } } : {}),
    content: { mod: p.mod, props: { ...props, ...(own[p.name] ?? {}) } },
  });
  const shown = PANELS.filter((p) => !hidden.includes(p.name));
  // Velocity gets the project's checkout too, so it shows this project rather than the
  // focused terminal's (without a folder it follows focus).
  const propsOf = (p) => p.name === "velocity" ? { ...base, folder: project.folder ?? null, glabOn: base.on, forges: config.forges }
    : p.name === "requests" || p.name === "issues" ? { ...base, folder: project.folder ?? null } : base;
  const left = shown.filter((p) => p.side === "left");
  const row = [];
  if (left.length) {
    row.push({ id: "forge-left", type: "column", size: { px: 360 }, divider: { width: 1, color: "border" },
      children: left.map((p) => block(p, propsOf(p))) });
  }
  for (const p of shown.filter((p) => !p.side)) row.push(block(p, propsOf(p)));
  return {
    type: "column", children: [
      { id: "forge-bar", type: "block", size: { px: 36 }, content: { mod: "forge-window", props: { bar: true } } },
      { id: "forge-body", type: "row", divider: { width: 1, color: "border" }, children: row },
    ],
  };
}

// What `git` says about the focused terminal's folder, as the window's project, or null
// outside a repo. fields: { top, url } from the RESOLVE script; remote: parseRemote(url).
export function projectFrom(fields, remote, on, providerForHost, forges) {
  if (!fields?.top) return null;
  if (!remote) return { none: true, top: fields.top };
  const provider = providerForHost(remote.host, forges ?? {});
  if (!provider) return { none: true, top: fields.top, host: remote.host };
  return { provider, host: remote.host, repo: remote.path, on: on ?? null, folder: fields.top };
}
