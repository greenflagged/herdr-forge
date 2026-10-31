// The Forge layout and its settings, kept free of Herdr imports so they're tested
// under plain Node.

// The panels, in order, with where they go.
export const PANELS = [
  { name: "requests", mod: "forge-requests", label: "MRs", side: "left" },
  { name: "milestones", mod: "forge-milestones", label: "Milestones", side: "left" },
  { name: "velocity", mod: "forge-velocity", label: "Velocity", side: "left", px: 330 },
  { name: "ci", mod: "forge-ci", label: "CI", side: "middle", weight: 2 },
  { name: "runners", mod: "forge-runners", label: "Runners", side: "middle", weight: 1 },
  { name: "issues", mod: "forge-issues", label: "Issues" },
];

// `forge.json` in Herdr's folder (optional):
//   { "forges": { "git.acme.io": "gitlab" },
//     "projects": { "gitlab.com/acme/shop": { "on": "my-mac", "folder": "/src/shop",
//       "issues": { "triage": true, "actions": [...] }, "requests": { "actions": [...] } } } }
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
// The Forge layout: the whole Herdr window for one project. The bar on top, then a
// column with MRs, milestones and velocity, a column with CI over runners, and the issue
// browser filling the rest (it needs the room: filters, list and detail side by side). Each
// panel is a layout block, so it collapses, detaches and opens as a pane like any other.
// Written to layouts/forge.json and shown with layout.switch.
export function forgeLayout(project, config = {}) {
  const own = config?.projects?.[projectKey(project)] ?? {};
  const base = { provider: project.provider, host: project.host, repo: project.repo, on: project.on ?? null };
  const block = (p, props) => ({
    id: `forge-${p.name}`, type: "block",
    ...(p.px ? { size: { px: p.px } } : p.weight ? { size: { weight: p.weight } } : {}),
    content: { mod: p.mod, props: { ...props, ...(own[p.name] ?? {}) } },
  });
  // Velocity gets the project's checkout too, so it shows this project rather than the
  // focused terminal's (without a folder it follows focus).
  const propsOf = (p) => p.name === "velocity" ? { ...base, folder: project.folder ?? null, glabOn: base.on, forges: config.forges }
    : p.name === "requests" || p.name === "issues" ? { ...base, folder: project.folder ?? null } : base;
  const column = (id, side, px) => ({ id, type: "column", size: { px }, divider: { width: 1, color: "border" },
    children: PANELS.filter((p) => p.side === side).map((p) => block(p, propsOf(p))) });
  const row = [
    column("forge-left", "left", 360),
    column("forge-middle", "middle", 340),
    ...PANELS.filter((p) => !p.side).map((p) => block(p, propsOf(p))),
  ];
  return {
    id: "root", type: "column", children: [
      { id: "forge-bar", type: "block", size: { px: 38 }, content: { mod: "forge-window", props: { bar: true } } },
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
