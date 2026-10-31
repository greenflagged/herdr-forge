// The issue browser's pure logic: labels, facets, the list query, triage settings. No
// Herdr imports, so the tests run it under plain Node (test/forge-issues.test.js).

export const PRIORITIES = ["blocker", "critical", "high", "medium", "low"];
export const STATES = [{ id: "opened", label: "Open" }, { id: "closed", label: "Closed" }, { id: "all", label: "All" }];
const SORTS = [
  { id: "priority", label: "Priority" },
  { id: "updated", label: "Updated" },
  { id: "created", label: "Newest" },
  { id: "triage", label: "Triage rank" },
];
// The scoped-label separator each forge uses unless props.scopeSep says otherwise.
export const DEFAULT_SEP = { gitlab: "::", github: ": " };
export const TRIAGE_DEFAULTS = { agent: "claude", tab: "triage", task: "/triage-issues {provider} {host} {repo}" };
// The order the triage facet lists its values in.
export const TRIAGE_ORDER = ["proposed change", "locked", "ranked", "(none)"];

// The sorts on offer: "Triage rank" only with triage on.
export function sorts(triageOn) {
  return triageOn ? SORTS : SORTS.filter((s) => s.id !== "triage");
}

export function nextSort(current, triageOn) {
  const list = sorts(triageOn);
  const k = list.findIndex((s) => s.id === current);
  return list[(k + 1) % list.length].id;
}

// "priority::high" -> ["priority", "high"]; a plain label -> [null, label].
export function scopeOf(label, sep) {
  const k = label.lastIndexOf(sep);
  return k > 0 ? [label.slice(0, k), label.slice(k + sep.length)] : [null, label];
}

// One issue's labels split for the detail pane: { scoped: {scope: value}, plain: [] }.
export function splitLabels(labels, sep) {
  const scoped = {}, plain = [];
  for (const l of labels ?? []) {
    const [scope, value] = scopeOf(l, sep);
    if (scope) scoped[scope] = value; else plain.push(l);
  }
  return { scoped, plain };
}

// The `update` fields that set scope=value (null clears it) and drop any other label of
// that scope, with the labels the issue has afterwards. null: nothing to change.
export function scopedChange(labels, scope, value, sep) {
  const want = value == null ? null : `${scope}${sep}${value}`;
  const drop = labels.filter((l) => scopeOf(l, sep)[0] === scope && l !== want);
  const add = want && !labels.includes(want) ? [want] : [];
  if (!drop.length && !add.length) return null;
  const fields = {};
  if (add.length) fields.add_labels = add;
  if (drop.length) fields.remove_labels = drop;
  return { fields, labels: [...labels.filter((l) => !drop.includes(l)), ...add] };
}

export function labelToggle(labels, label) {
  return labels.includes(label)
    ? { fields: { remove_labels: [label] }, labels: labels.filter((l) => l !== label) }
    : { fields: { add_labels: [label] }, labels: [...labels, label] };
}

// The values a scope has among the project's labels (meta), plus `current` if the
// issue carries one the project no longer lists. Priority values in PRIORITIES order.
export function scopeValues(metaLabels, scope, sep, current = null) {
  const vals = [];
  for (const l of metaLabels ?? []) {
    const [s, v] = scopeOf(l.name, sep);
    if (s === scope && !vals.includes(v)) vals.push(v);
  }
  if (current != null && !vals.includes(current)) vals.push(current);
  if (scope === "priority") vals.sort((a, b) => rankOf(a) - rankOf(b));
  return vals;
}

const rankOf = (p) => { const k = PRIORITIES.indexOf(p); return k < 0 ? PRIORITIES.length : k; };

// Every scope among the project's labels (meta), in first-seen order.
export function metaScopes(metaLabels, sep) {
  const out = [];
  for (const l of metaLabels ?? []) {
    const [s] = scopeOf(l.name, sep);
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

// The scopes to show, in order. props.scopes (a list of names) picks them and their
// order; otherwise priority first, then type, then the rest as `inUse` lists them
// (query's `scopes`: most used first), then any `extra` (scopes only meta knows).
export function orderScopes(inUse = [], fromProps = null, extra = []) {
  if (Array.isArray(fromProps)) return fromProps.filter((s) => typeof s === "string" && s);
  const all = [...inUse];
  for (const s of extra) if (!all.includes(s)) all.push(s);
  const head = ["priority", "type"].filter((s) => all.includes(s));
  return [...head, ...all.filter((s) => !head.includes(s))];
}

// "area" -> "Area", "work-stream" -> "Work stream".
export function scopeTitle(scope) {
  const s = scope.replace(/[-_]+/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// A sidebar section's rows: [[value, n]], picked values kept even at zero.
export function facetEntries(counts, group, picked = []) {
  const entries = Object.entries(counts?.[group] ?? {});
  const order = group === "triage" ? TRIAGE_ORDER : group === "scope:priority" ? [...PRIORITIES, "(none)"] : null;
  const pos = (v) => { const k = order.indexOf(v); return k < 0 ? order.length : k; };
  entries.sort((a, b) => {
    if (a[0] === "(none)" || b[0] === "(none)") return (a[0] === "(none)") - (b[0] === "(none)");
    if (order && pos(a[0]) !== pos(b[0])) return pos(a[0]) - pos(b[0]);
    return b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  });
  for (const v of picked) if (!entries.some(([k]) => k === v)) entries.push([v, 0]);
  return entries;
}

export function togglePick(picked, group, value) {
  const vals = picked[group] ?? [];
  return { ...picked, [group]: vals.includes(value) ? vals.filter((v) => v !== value) : [...vals, value] };
}

// props.view, checked: { state, sort, picked, q } with anything malformed at its default.
// picked keeps only groups whose values are a list of strings (the layout is hand-written).
export function startView(view) {
  const v = view && typeof view === "object" && !Array.isArray(view) ? view : {};
  const picked = {};
  if (v.picked && typeof v.picked === "object" && !Array.isArray(v.picked)) {
    for (const [g, vals] of Object.entries(v.picked)) {
      if (Array.isArray(vals) && vals.every((x) => typeof x === "string")) picked[g] = [...vals];
    }
  }
  return {
    state: STATES.some((s) => s.id === v.state) ? v.state : "opened",
    sort: SORTS.some((s) => s.id === v.sort) ? v.sort : "priority",
    picked,
    q: typeof v.q === "string" ? v.q : "",
  };
}

// The JSON `query` takes. `sep` only when props set one (passing it makes forge.py
// remember it for the project).
export function listQuery({ state, q, picked, sort, offset, limit, sep }) {
  const p = {};
  for (const [g, vals] of Object.entries(picked ?? {})) if (vals.length) p[g] = vals;
  const o = { state, q, picked: p, sort, offset, limit };
  if (sep) o.sep = sep;
  return JSON.stringify(o);
}

// props.triage: off unless set. true, or { agent, task, tab } over the defaults.
export function triageConfig(v) {
  if (!v) return null;
  const o = v === true || typeof v !== "object" ? {} : v;
  return {
    agent: o.agent ?? TRIAGE_DEFAULTS.agent,
    tab: o.tab ?? TRIAGE_DEFAULTS.tab,
    task: o.task ?? TRIAGE_DEFAULTS.task,
  };
}

// What the triage box says about the skill, from `skill status`.
// { text, install: label of the Install button or null }.
export function skillLine(s) {
  if (!s) return { text: "Checking the triage skill…", install: null };
  if (s.error) return { text: `Skill: ${s.error}`, install: null };
  if (!s.installed) return { text: "The triage-issues skill isn't installed.", install: "Install skill" };
  if (s.foreign) return { text: "Another triage-issues skill is installed (not this package's).", install: "Replace skill", replace: true };
  if (s.older) return { text: `The installed triage-issues skill is from ${s.version}.`, install: "Update skill" };
  return { text: s.current ? "Skill installed." : `Skill ${s.version ?? ""} installed.`.replace("  ", " "), install: null };
}

// The version a SKILL.md carries ("herdr-forge 0.1.0"), or null.
export function skillVersion(text) {
  return /herdr-forge (\S+)/.exec(text ?? "")?.[1] ?? null;
}

// Whether the project uses priority labels at all: in use, or defined.
export function usesPriority(counts, metaLabels, sep) {
  if (Object.keys(counts?.["scope:priority"] ?? {}).some((v) => v !== "(none)")) return true;
  return (metaLabels ?? []).some((l) => scopeOf(l.name, sep)[0] === "priority");
}

export { isAgentAction } from "./lib.js";
