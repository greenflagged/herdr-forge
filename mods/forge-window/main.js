import { View, div } from "gpui-kit";
import { h_flex, v_flex, Popover } from "gpui-base";
import {
  exec, readTextFile, writeTextFile, appHome, props, theme, focused, spaces, panes, shared, setShared, run, closeOverlay, notify,
} from "herdr";
import { parseRemote, providerForHost } from "./lib.js";
import { PANELS, parseConfig, forgeLayout, keptBlocks, projectFrom, withConfig, rememberedProject,
  panelSelectionKey, selectedPanels, togglePanel, panelLabel } from "./window.js";
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
const RESOLVE = `top=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
printf 'top\\t%s\\n' "$top"
printf 'url\\t%s\\n' "$(git remote get-url origin 2>/dev/null)"`;

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

async function resolve(where, config) {
  const r = await exec("sh", ["-c", RESOLVE], { cwd: where.cwd, on: where.on });
  const f = Object.fromEntries(r.stdout.split("\n").filter(Boolean).map((l) => l.split("\t")));
  return projectFrom(f, parseRemote(f.url ?? ""), where.on, providerForHost, config.forges);
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
    this.busy = null;   // the space being opened
    cx.spawn(async (cx) => { this.config = await readConfig(); this.configReady = true; cx.notify(); });
  }

  // Another space's repo, from the bar's list.
  openSpace(sp, cx) {
    if (this.panelBusy || this.busy) return;
    this.picker = false;
    this.busy = sp.id;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const where = spaceFolder(sp);
        const project = where ? await resolve(where, this.config) : null;
        if (!project || project.none) toast(`${sp.name} isn't in a ${project?.host ? `${project.host} repo Forge supports` : "git repo with a GitLab or GitHub remote"}.`);
        else await show(project, this.config);
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

    const list = v_flex().id("forge-spaces").min_w(240).max_h(360).overflow_y_scrollbar().p(4).gap(1).rounded(6)
      .bg(t.popover).border_1().border_color(t.border).shadow_md()
      .child(div().px(8).py(3).text_size(10.5).text_color(t.dim).child("Choose a project · remembered"))
      .children(spaces().map((sp) => h_flex().id(`forge-sp-${sp.id}`).gap(8).items_center().px(8).py(4).rounded(4)
        .text_size(12).cursor_pointer().hover((st) => st.bg(t.hover))
        .on_click((_e, cx) => this.openSpace(sp, cx))
        .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(sp.name))
        .child(div().flex_none().text_size(10.5).text_color(t.dim).child(this.busy === sp.id ? "opening…" : sp.machine ?? "this computer"))));
    const switcher = Popover.new("forge-switch").open(this.picker)
      .on_open_change((o, cx) => { this.picker = o; cx.notify(); })
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
