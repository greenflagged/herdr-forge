// Turns forge.py's velocity answers into what the panel draws. Pure (no Herdr imports),
// so the tests run under Node. Runs once per answer, not per render.

import { num, span } from "./lib.js";

export const DAY = 86400000;
export const BAR = 22; // bar height, px
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// Row key -> label and theme color name.
export function rowStyles(terms) {
  return {
    commits: { label: "Commits", color: "accent" },
    merged: { label: `${terms.request}s merged`, color: "ansi5" },
    closed: { label: "Issues closed", color: "ansi2" },
    cycle: { label: `${terms.request} cycle time`, color: "ansi3" },
  };
}

// Bar heights in px: durations on a square-root scale, so one slow week doesn't flatten
// the rest. null (no data in that bucket) is a 1px stub.
export function heights(values, unit) {
  const scale = unit === "duration" ? Math.sqrt : (x) => x;
  const max = Math.max(1, ...values.map((v) => scale(v ?? 0)));
  return values.map((v) => (v == null ? 1 : Math.max(2, Math.round((scale(v) / max) * BAR))));
}

export function format(v, unit) {
  return unit === "duration" ? span(v) : v == null ? "–" : num(v);
}

// The last 7 days against the average week. Under one a week a percentage says nothing
// (1 vs 0.08 is "+1100%"). tone: "dim" | "good" | "bad".
export function delta(r) {
  if (r.now == null || !r.avg || (r.unit !== "duration" && r.avg < 1)) return null;
  const pct = Math.round(((r.now - r.avg) / r.avg) * 100);
  if (Math.abs(pct) < 5) return { text: "≈ avg", tone: "dim" };
  const good = r.lowerBetter ? pct < 0 : pct > 0;
  return { text: `${pct > 0 ? "↑" : "↓"}${Math.abs(pct)}%`, tone: good ? "good" : "bad" };
}

function prepRow(key, row, style, n, unit = row?.unit) {
  const values = row?.values ?? Array(n).fill(null);
  return {
    key, label: style.label, color: style.color, unit, values,
    now: row?.now ?? null, avg: row?.avg ?? null, lowerBetter: Boolean(row?.lowerBetter),
    heights: heights(values, unit),
    shown: values.map((v) => format(v, unit)),
    headline: format(row?.now ?? null, unit),
    delta: row ? delta(row) : null,
    total: unit === "duration" ? null : values.reduce((a, v) => a + (v ?? 0), 0),
  };
}

// commits: the `commits` answer (or null); velocity: the `velocity` answer (or null);
// forge: whether the repo is on a forge we read (false: commits only).
// -> { n, size, start, rows }
export function prepare(commits, velocity, terms, forge, range) {
  const n = commits?.n ?? velocity?.n ?? (range === "30d" ? 30 : 12);
  const b = commits?.n ? commits : velocity?.n ? velocity : null;
  const styles = rowStyles(terms);
  const rows = [prepRow("commits", commits?.row, styles.commits, n)];
  if (forge) {
    const byKey = Object.fromEntries((velocity?.rows ?? []).map((r) => [r.key, r]));
    for (const k of ["merged", "closed", "cycle"]) {
      rows.push(prepRow(k, byKey[k], styles[k], n, byKey[k]?.unit ?? (k === "cycle" ? "duration" : undefined)));
    }
  }
  return { n, size: b?.size ?? null, start: b?.start ?? null, rows };
}

export function day(ms) {
  const d = new Date(ms);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

// One bucket's name, for the caption while the pointer is on it.
export function bucketLabel(i, { n, size, start }) {
  if (start == null || size == null) return "";
  const a = start + i * size;
  if (size === DAY) return i === n - 1 ? "Today" : `${DAYS[new Date(a).getDay()]} ${day(a)}`;
  return `${day(a)} – ${day(a + size - 1)}`;
}
