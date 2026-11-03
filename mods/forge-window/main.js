import { View, div } from "gpui-kit";
import { h_flex, v_flex, Popover } from "gpui-base";
import {
  exec, readTextFile, writeTextFile, appHome, props, theme, focused, spaces, panes, shared, setShared, run, closeOverlay, notify,
} from "herdr";
import { parseRemote, providerForHost } from "./lib.js";
import { PANELS, RESOLVE, parseConfig, parseFields, forgeLayout, keptBlocks, otherProjects, projectFrom, withConfig, withTimeout,
  rememberedProject, panelSelectionKey, selectedPanels, togglePanel, panelLabel } from "./window.js";
import { button, pill } from "./ui.js";

// Forge: ctrl-shift-f (keys.json: "mod.open:forge-window") turns the whole Herdr window into
// the Forge layout for the remembered project, and back to the layout you came from.
// Only the first open uses the focused terminal's repo; Other project changes the saved choice.
// The layout is written to layouts/forge.json for that project, so every panel is an
// ordinary block: it collapses, detaches and opens as a pane, and Herdr keeps its size.
//
// This mod plays two parts:
// - the launcher: what mod.open opens. It switches the layout and closes itself.
// - the bar on top of the Forge layout (props.bar): the project, another project, Back.
// Per-project settings (buttons, triage, the machine glab runs on) come from an optional
// forge.json in Herdr's folder; see window.js.

const LAYOUT = "forge";
const STATE = "forge-window.state"; // shared: { project, previous }
// The bar's "Other project" list: how long a space's repo is trusted before it is looked up
// again (seconds; SPACES_RETRY after a failed look), and how long one look may take (ms).
// RESOLVE_STALL (ms): a look still marked waiting after this was interrupted (herdr-app's
// interrupt skips the step after the await), so scan looks again and the footer stops counting it.
const SPACES_EVERY = 600;
const SPACES_RETRY = 60;
const RESOLVE_TIMEOUT = 10000;
const RESOLVE_STALL = RESOLVE_TIMEOUT * 2;

const state = () => shared(STATE) ?? {};
const save = (patch) => setShared(STATE, { ...state(), ...patch });
const msg = (e) => String(e?.message ?? e);
const toast = (body, level = "info") => { try { notify({ title: "Forge", body, level }); } catch { /* no toast mod */ } };

async function readConfig() {
  try { return parseConfig(await readTextFile(`${appHome()}/forge.json`)); } catch { return {}; }
}

// Where the keyboard is: the focused terminal's folder, on its space's machine.
function focusedFolder() {
  const f = focused();
  if (!f) return null;
  const sp = spaces().find((s) => s.id === f.space);
  const inTab = panes().filter((p) => p.tab === f.tab && p.cwd);
  const cwd = f.cwd ?? inTab.find((p) => p.focused)?.cwd ?? inTab[0]?.cwd ?? sp?.folder;
  return cwd ? { on: sp?.machine ?? null, cwd } : null;
}

// A space's folder: where its first terminal is now, else where it was made.
function spaceFolder(sp) {
  const tabs = new Set((sp.tabs ?? []).map((t) => t.id));
  const cwd = panes().find((p) => tabs.has(p.tab) && p.cwd)?.cwd ?? sp.folder;
  return cwd ? { on: sp.machine ?? null, cwd } : null;
}

// RESOLVE's fields for a folder ({} outside a repo), and the project they make (projectFrom).
async function resolveFields(where) {
  const r = await exec("sh", ["-c", RESOLVE], { cwd: where.cwd, on: where.on });
  return parseFields(r.stdout);
}
const projectOfFields = (f, on, config) => projectFrom(f, parseRemote(f.url ?? ""), on, providerForHost, config?.forges);
async function resolve(where, config) {
  return projectOfFields(await resolveFields(where), where.on, config);
}

// Writes layouts/forge.json for a project (only when it changed: Herdr reloads the layout
// and its panels on every write).
// Blocks another package added (keptBlocks) are carried over.
async function writeLayout(project, config, selection = null) {
  const path = `${appHome()}/layouts/${LAYOUT}.json`;
  let current = null;
  try { current = await readTextFile(path); } catch { current = null; }
  let kept = [];
  try { kept = current ? keptBlocks(JSON.parse(current)) : []; } catch { kept = []; }
  const effective = withConfig(project, config);
  const selected = selection ?? selectedPanels(effective, config, shared(panelSelectionKey(effective)));
  const text = `${JSON.stringify(forgeLayout(effective, config, kept, selected), null, 2)}\n`;
  if (text !== current) await writeTextFile(path, text, current);
}

// Shows a project: the layout for it, then the switch (from anywhere but Forge itself).
async function show(project, config) {
  await writeLayout(project, config);
  const now = shared("layout");
  save({ project, ...(now && now !== LAYOUT ? { previous: now } : {}) });
  if (now !== LAYOUT) run("layout.switch", { name: LAYOUT });
}

function back() {
  const prev = state().previous;
  run("layout.switch", { name: prev && prev !== LAYOUT ? prev : "main" });
}

export default class Forge extends View {
  init(_props, cx) {
    if (props()?.empty) { this.empty = true; return; }
    if (props()?.bar) return this.initBar(cx);
    // The launcher: in Forge, go back; elsewhere, restore the last project. Shared
    // state survives restarts, unlike whatever terminal happens to have focus now.
    cx.spawn(async () => {
      try {
        if (shared("layout") === LAYOUT) back();
        else {
          const config = await readConfig();
          let project = rememberedProject(state().project);
          if (!project) {
            const where = focusedFolder();
            const found = where ? await resolve(where, config).catch(() => null) : null;
            project = rememberedProject(found);
          }
          if (project) await show(project, config);
          else toast("Focus a terminal in a GitLab or GitHub repo, then press ctrl-shift-f again.");
        }
      } catch (e) {
        toast(msg(e), "error");
      }
      closeOverlay(props().overlay);
    });
  }

  // ---- the bar ----

  initBar(cx) {
    this.bar = true;
    this.config = {};
    this.configReady = false;
    this.picker = false;
    this.panelPicker = false;
    this.panelBusy = false;
    this.panelAt = 0;
    this.panelKeys = cx.focus_handle();
    this.busy = null;   // the key of the row being opened
    // What repo each space is in, for the "Other project" list: space id -> { key (the
    // space's machine and folder: spaceFolder), at, waiting, ok, fields (RESOLVE's), on }.
    this.known = new Map();
    cx.spawn(async (cx) => { this.config = await readConfig(); this.configReady = true; cx.notify(); });
    this.scan(cx);
  }

  // Looks up the repo of each space whose entry is missing, stale (SPACES_EVERY, or
  // SPACES_RETRY after a failure), for another folder, or waiting past RESOLVE_STALL, all at
  // once. A slow look is cut off at RESOLVE_TIMEOUT and an interrupted one is redone after
  // RESOLVE_STALL, so a machine that is away can't hold the list. Runs when the bar starts
  // and each time the picker opens, never from render. The project is made from the fields
  // at render (projectOfFields), so forge.json read later still applies.
  scan(cx) {
    let list;
    try { list = spaces() ?? []; } catch { return; }
    const now = Date.now();
    const ids = new Set(list.map((sp) => sp.id));
    for (const id of this.known.keys()) if (!ids.has(id)) this.known.delete(id);
    const due = [];
    for (const sp of list) {
      const where = spaceFolder(sp);
      if (!where) { this.known.delete(sp.id); continue; }
      const key = `${where.on ?? ""}\t${where.cwd}`;
      const had = this.known.get(sp.id);
      const same = had?.key === key;
      if (same && (had.waiting ? now - had.at < RESOLVE_STALL : now - had.at < (had.ok ? SPACES_EVERY : SPACES_RETRY) * 1000)) continue;
      // A refresh of the same folder keeps showing what it knew while it looks again.
      const entry = { key, at: now, waiting: true, ok: false, fields: same ? had.fields : null, on: where.on };
      this.known.set(sp.id, entry);
      due.push([entry, where]);
    }
    if (!due.length) return;
    cx.spawn(async (cx) => {
      const sleep = (ms) => cx.sleep(ms);
      await Promise.allSettled(due.map(async ([entry, where]) => {
        try {
          entry.fields = await withTimeout(resolveFields(where), RESOLVE_TIMEOUT, sleep);
          entry.ok = true;
        } catch { entry.ok = false; } // machine away or timed out: looked up again after SPACES_RETRY
        entry.waiting = false;
        entry.at = Date.now();
        try { cx.notify(); } catch { /* the bar restarted with a new layout */ }
      }));
    });
  }

  // The rows of the "Other project" list (window.js otherProjects) from what scan found, and
  // how many spaces it is still looking at.
  otherRows() {
    let list;
    try { list = spaces() ?? []; } catch { list = []; }
    const entries = [];
    let pending = 0;
    const now = Date.now();
    for (const space of list) {
      const k = this.known.get(space.id);
      if (!k) continue;
      if (k.waiting && now - k.at < RESOLVE_STALL) pending++;
      if (!k.fields) continue;
      entries.push({ space, project: projectOfFields(k.fields, k.on, this.config), linked: k.fields.linked === "1" });
    }
    return { rows: otherProjects(entries, state().project), pending };
  }

  // Shows a row's repo, from the space scan picked (no second look).
  openRow(row, cx) {
    if (this.panelBusy || this.busy) return;
    this.picker = false;
    this.busy = row.key;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await show(row.project, this.config);
      } catch (e) {
        toast(msg(e), "error");
      }
      this.busy = null;
      try { cx.notify(); } catch { /* the bar restarted with the new layout */ }
    });
  }

  panelsFor(project) {
    const effective = withConfig(project, this.config);
    return selectedPanels(effective, this.config, shared(panelSelectionKey(effective)));
  }

  setPanels(selected, cx) {
    const project = rememberedProject(state().project);
    if (!project || this.panelBusy || this.busy || this.configReady === false) return;
    this.panelBusy = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        // The file write is compare-and-swap. Save the preference only after the
        // layout accepted it, so a failed write cannot silently disable a panel.
        await writeLayout(project, this.config, selected);
        setShared(panelSelectionKey(withConfig(project, this.config)), selected);
      } catch (e) {
        toast(`Couldn't update panels: ${msg(e)}`, "error");
      } finally {
        this.panelBusy = false;
        cx.notify();
      }
    });
  }

  render() {
    const t = theme();
    if (this.empty) return v_flex().size_full().p(24).gap(8).bg(t.background).text_color(t.muted)
      .child(div().text_size(14).child("No panels selected"))
      .child(div().text_size(12).child("Use Panels in the bar above to add a panel. Removed panels do not poll GitHub."));
    if (!this.bar) return div();
    const s = state(), p = s.project;
    const prev = s.previous && s.previous !== LAYOUT ? s.previous : "main";

    const { rows, pending } = this.picker ? this.otherRows() : { rows: [], pending: 0 };
    const foot = pending ? `Looking at ${pending} space${pending === 1 ? "" : "s"}…` : rows.length ? null : "No other project is open in a space";
    const list = v_flex().id("forge-spaces").min_w(240).max_h(360).overflow_y_scrollbar().p(4).gap(1).rounded(6)
      .bg(t.popover).border_1().border_color(t.border).shadow_md()
      .child(div().px(8).py(3).text_size(10.5).text_color(t.dim).child("Choose a project · remembered"))
      .children(rows.map((row) => h_flex().id(`forge-repo-${row.key}`).gap(8).items_center().px(8).py(4).rounded(4)
        .text_size(12).cursor_pointer().hover((st) => st.bg(t.hover))
        .on_click((_e, cx) => this.openRow(row, cx))
        .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(row.label))
        .when(row.showHost, (e) => e.child(div().flex_none().text_size(10.5).text_color(t.dim).child(row.host)))
        .child(div().flex_none().text_size(10.5).text_color(t.dim).child(this.busy === row.key ? "opening…" : row.space.machine ?? "this computer"))))
      .when(Boolean(foot), (e) => e.child(div().px(8).py(3).text_size(10.5).text_color(t.dim).child(foot)));
    const switcher = Popover.new("forge-switch").open(this.picker)
      .on_open_change((o, cx) => { this.picker = o; if (o) this.scan(cx); cx.notify(); })
      .trigger(h_flex().id("forge-switch-trigger").gap(6).items_center().px(8).py(2).rounded(5).cursor_pointer()
        .tooltip("Your project choice is remembered across reopens and app restarts")
        .border_1().border_color(this.picker ? t.accent : t.border).hover((st) => st.bg(t.hover))
        .child(div().text_size(11.5).text_color(t.muted).child("Other project"))
        .child(div().text_size(9).text_color(t.dim).child("▾")))
      .content(list);

    const selected = p ? this.panelsFor(p) : [];
    const panelDisabled = this.panelBusy || Boolean(this.busy) || this.configReady === false;
    const panelList = v_flex().id("forge-panels-list").min_w(250).p(5).gap(2).rounded(6).track_focus(this.panelKeys)
      .bg(t.popover).border_1().border_color(t.border).shadow_md()
      .on_key_down((e, cx) => {
        const key = e.key ?? e.keystroke;
        if (key === "escape") { this.panelPicker = false; cx.stop_propagation(); cx.notify(); return; }
        if (panelDisabled) return;
        if (key === "up" || key === "down") {
          this.panelAt = (this.panelAt + (key === "down" ? 1 : PANELS.length - 1)) % PANELS.length;
        } else if (key === "enter" || key === "space" || key === " ") {
          this.setPanels(togglePanel(selected, PANELS[this.panelAt].name), cx);
        } else return;
        cx.stop_propagation(); cx.notify();
      })
      .child(div().px(8).py(4).text_size(10.5).text_color(t.dim).child("Add or remove panels · remembered per project"))
      .children(PANELS.map((panel, i) => h_flex().id(`forge-panel-${panel.name}`).h(30).px(8).gap(8).items_center().rounded(4)
        .text_size(12).text_color(t.foreground)
        .when(this.panelAt === i, (e) => e.bg(t.selected))
        .when(panelDisabled, (e) => e.opacity(0.5))
        .when(!panelDisabled, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { this.panelAt = i; this.setPanels(togglePanel(selected, panel.name), cx); }))
        .child(div().size(14).flex_none().flex().items_center().justify_center().rounded(3).border_1()
          .border_color(selected.includes(panel.name) ? t.accent : t.dim).text_color(t.accent).text_size(10)
          .child(selected.includes(panel.name) ? "✓" : ""))
        .child(div().child(panelLabel(panel, p?.provider)))))
      .child(div().px(8).pt(6).pb(4).text_size(10.5).text_color(t.dim)
        .child(this.configReady === false ? "Loading panel settings…" : this.panelBusy ? "Updating panels…" : "Removed panels stop polling. In-flight requests may finish."));
    const panelPicker = Popover.new("forge-panels").open(this.panelPicker)
      .on_open_change((o, cx) => { this.panelPicker = o; if (o) this.panelKeys.focus(); cx.notify(); })
      .trigger(h_flex().id("forge-panels-trigger").gap(6).items_center().px(8).py(2).rounded(5).cursor_pointer()
        .tooltip("Add or remove dashboard panels. Removed panels stop their GitHub polling.")
        .border_1().border_color(this.panelPicker ? t.accent : t.border).hover((s) => s.bg(t.hover))
        .child(div().text_size(11.5).text_color(t.muted).child(`Panels ${selected.length}/${PANELS.length}`))
        .child(div().text_size(9).text_color(t.dim).child("▾")))
      .content(panelList);

    return h_flex().id("forge-bar").size_full().px(12).gap(10).items_center().bg(t.chrome)
      .border_b(1).border_color(t.border).text_color(t.foreground)
      .child(div().flex_none().text_size(13.5).font_semibold().child("Forge"))
      .child(div().flex_none().text_size(13).text_color(t.foreground).max_w(360).truncate().child(p?.repo ?? "No project yet"))
      .when(Boolean(p) && p.host !== "gitlab.com", (e) => e.child(div().flex_none().text_size(11).text_color(t.dim).child(p.host)))
      .when(Boolean(p), (e) => e.child(pill(t, p.on ?? "this computer")))
      .child(switcher)
      .child(panelPicker)
      .child(div().flex_1())
      .child(div().flex_none().text_size(11).text_color(t.dim).child("ctrl-shift-f"))
      .child(button(t, "forge-back", `Back to ${prev}`, () => back(), { tooltip: "Leave Forge (ctrl-shift-f)" }));
  }
}
