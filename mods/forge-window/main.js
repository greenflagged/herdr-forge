import { View, div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { exec, readTextFile, appHome, props, theme, focused, spaces, panes, shared, setShared, openOverlay, closeOverlay, notify } from "herdr";
import { parseRemote, providerForHost } from "./lib.js";
import { PANELS, parseConfig, forgeLayout, projectFrom, projectKey, withConfig } from "./window.js";
import { button, pill } from "./ui.js";

// The Forge window: every forge panel for one project in a floating window, opened and
// closed with ctrl-shift-f (keys.json: "mod.open:forge-window"). It shows the repo of the
// focused terminal and follows focus to other repos unless pinned. It stays where it's
// dropped and comes back after a restart.
//
// This mod plays two parts:
// - the launcher: what mod.open opens. It toggles the window and closes itself.
// - the bar on top of the window (props.bar): the project, pin, panel switches, close.
// Per-project settings (buttons, triage, the machine glab runs on) come from an optional
// forge.json in Herdr's folder; see window.js.

const STATE = "forge-window.state"; // shared: { id, project, pinned, hidden }
const RESOLVE = `top=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
printf 'top\\t%s\\n' "$top"
printf 'url\\t%s\\n' "$(git remote get-url origin 2>/dev/null)"`;

const state = () => shared(STATE) ?? {};
const save = (patch) => setShared(STATE, { ...state(), ...patch });
const msg = (e) => String(e?.message ?? e);
// A redraw for a view that may be gone: openWindow() replaces the window (and this bar)
// in place, and the window can close while a spawn waits.
const redraw = (view, cx) => { if (view.gone) return; try { cx.notify(); } catch { /* closed */ } };

async function readConfig() {
  try { return parseConfig(await readTextFile(`${appHome()}/forge.json`)); } catch { return {}; }
}

// Where the keyboard is: the focused terminal's folder, on its space's machine.
function target() {
  const f = focused();
  if (!f) return null;
  const sp = spaces().find((s) => s.id === f.space);
  const inTab = panes().filter((p) => p.tab === f.tab && p.cwd);
  const cwd = f.cwd ?? inTab.find((p) => p.focused)?.cwd ?? inTab[0]?.cwd ?? sp?.folder;
  return cwd ? { on: sp?.machine ?? null, cwd } : null;
}

async function resolve(tg, config) {
  const r = await exec("sh", ["-c", RESOLVE], { cwd: tg.cwd, on: tg.on });
  const f = Object.fromEntries(r.stdout.split("\n").filter(Boolean).map((l) => l.split("\t")));
  return projectFrom(f, parseRemote(f.url ?? ""), tg.on, providerForHost, config.forges);
}

// Opens the window for a project, or replaces the open one in place (same key).
function openWindow(project, config) {
  const s = state();
  const hidden = s.hidden ?? config.hidden ?? [];
  const id = openOverlay({ kind: "window", key: "forge", keep: true, width: 0.9, height: 0.88,
    layout: forgeLayout(withConfig(project, config), hidden, config) });
  save({ id, project });
}

export default class Forge extends View {
  init(_props, cx) {
    if (props()?.bar) return this.initBar(cx);
    // The launcher: toggle, then go.
    cx.spawn(async () => {
      try {
        const s = state();
        if (s.id) {
          closeOverlay(s.id);
          save({ id: null });
        } else {
          const config = await readConfig();
          const tg = target();
          let project = null;
          if (!s.pinned && tg) project = await resolve(tg, config).catch(() => null);
          if (!project || project.none) project = s.project ?? null;
          if (project) openWindow(project, config);
          else notify({ title: "Forge", body: "Focus a terminal in a GitLab repo, then press ctrl-shift-f again.", level: "info" });
        }
      } catch (e) {
        notify({ title: "Forge", body: msg(e), level: "error" });
      }
      closeOverlay(props().overlay);
    });
  }

  // ---- the bar ----

  initBar(cx) {
    this.bar = true;
    save({ id: props().overlay });
    this.config = {};
    this.busy = false;
    this.lastTarget = null;
    cx.spawn(async (cx) => { this.config = await readConfig(); redraw(this, cx); });
    // Follow focus to another repo (unless pinned): checked when the focused folder changes.
    cx.timer.every(1000, (cx) => this.follow(cx));
  }

  async close() {
    this.gone = true;
    // Closed (not replaced by another project's window, which has its own id).
    if (this.bar && state().id === props()?.overlay) save({ id: null });
  }

  follow(cx) {
    if (this.gone || state().pinned || this.busy) return;
    const tg = target();
    if (!tg) return;
    const key = JSON.stringify([tg.on, tg.cwd]);
    if (key === this.lastTarget) return;
    this.lastTarget = key;
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        const p = await resolve(tg, this.config);
        if (!this.gone && !state().pinned && p && !p.none && projectKey(p) !== projectKey(state().project)) this.replace(p);
      } catch { /* unreachable machine or no git: stay on this project */ }
      this.busy = false;
      redraw(this, cx);
    });
  }

  // Opens a project in place of this window. This bar is gone after it: nothing here may
  // redraw it.
  replace(project) {
    this.gone = true;
    openWindow(project, this.config);
  }

  togglePanel(name) {
    const s = state();
    const hidden = new Set(s.hidden ?? this.config.hidden ?? []);
    if (hidden.has(name)) hidden.delete(name); else hidden.add(name);
    if (hidden.size === PANELS.length) return; // keep at least one
    save({ hidden: [...hidden] });
    if (s.project) this.replace(s.project);
  }

  render() {
    const t = theme();
    if (!this.bar) return div();
    const s = state(), p = s.project;
    const hidden = new Set(s.hidden ?? this.config.hidden ?? []);
    const stop = (_e, cx) => cx.stop_propagation();
    const chip = (panel) => {
      const on = !hidden.has(panel.name);
      return div().id(`panel-${panel.name}`).flex_none().px(8).py(2).rounded(5).text_size(11.5).cursor_pointer()
        .bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.dim)
        .border_1().border_color(on ? t.border : t.chrome)
        .hover((st) => st.bg(t.hover))
        .tooltip(on ? `Hide ${panel.label}` : `Show ${panel.label}`)
        .on_mouse_down("left", stop)
        .on_click((_e, cx) => { cx.stop_propagation(); this.togglePanel(panel.name); redraw(this, cx); })
        .child(panel.label);
    };
    // Pressing the bar anywhere but its controls drags the window.
    return h_flex().id("forge-bar").size_full().px(12).gap(8).items_center().bg(t.chrome)
      .border_b(1).border_color(t.border).text_color(t.foreground)
      .child(div().flex_none().text_size(13).font_semibold().child("Forge"))
      .child(div().flex_none().text_size(12.5).text_color(t.foreground).max_w(320).truncate().child(p?.repo ?? ""))
      .when(Boolean(p) && p.host !== "gitlab.com", (e) => e.child(div().flex_none().text_size(11).text_color(t.dim).child(p.host)))
      .when(Boolean(p), (e) => e.child(pill(t, p.on ?? "this computer")))
      .child(button(t, "forge-pin", s.pinned ? "Pinned" : "Following focus", (cx) => { save({ pinned: !s.pinned }); cx.notify(); },
        { tone: s.pinned ? "primary" : null,
          tooltip: s.pinned ? "Stays on this project. Click to follow the focused terminal again." : "Moves to the focused terminal's repo. Click to stay on this project." }))
      .child(div().flex_1())
      .children(PANELS.map(chip))
      .child(div().id("forge-close").w(24).h(24).flex_none().flex().items_center().justify_center().rounded(5)
        .text_size(14).text_color(t.muted).cursor_pointer().hover((st) => st.bg(t.hover).text_color(t.foreground))
        .tooltip("Close (ctrl-shift-f)")
        .on_mouse_down("left", stop)
        .on_click((_e, cx) => { cx.stop_propagation(); save({ id: null }); closeOverlay(props().overlay); })
        .child("×"));
  }
}
