// Panel chrome and small parts shared by the forge-* mods, so every panel looks and
// behaves the same: one header (collapse in place, title, count, project, age, refresh,
// open as a pane, detach into a window), and the same empty, error, button, chip and
// dropdown styles. Copied into every mod like lib.js: edit shared/ui.js, run `npm run sync`.

import { div } from "gpui-kit";
import { h_flex, v_flex, Popover } from "gpui-base";
import { closeOverlay, layout, openOverlay, panes, props, run, setShared, shared, spaces } from "herdr";
import { HEADER_PX, ago, expandedSize, findBlocks, isCollapsed, isShown } from "./lib.js";

export { HEADER_PX };
const SIZES = "forge.sizes"; // shared: block id -> its size before collapsing
const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// Where a panel is and what its header can do there:
//   block   a layout block: collapse in place (to a bar in a column, a strip in a row),
//           open as a pane, detach
//   window  detached (props.dockTo): dock back
//   pane    opened as a pane (props.asPane): Herdr's pane header closes and zooms it
//   inside  part of a window's layout (the Forge window): that window's bar shows and hides it
export class Chrome {
  // mod: this mod's folder name. match: the props that tell its blocks apart ({ repo }).
  constructor(mod, match = {}, { width = 380, height = 560 } = {}) {
    this.mod = mod;
    this.match = match;
    this.size = { width, height };
    this.hovered = false;
    this.seen = null;
  }

  // Call in init: layout changes don't redraw mods, so look for a collapse or dock made
  // elsewhere (a key, another window) once a second.
  attach(cx) {
    let drawn = Date.now();
    cx.timer.every(1000, (cx) => {
      const now = `${this.where()}|${this.collapsed()}`;
      // And every 30 s, so the header's "3m" stays true.
      if (now !== this.seen || Date.now() - drawn >= 30000) { this.seen = now; drawn = Date.now(); cx.notify(); }
    });
  }

  where() {
    const p = props() ?? {};
    if (p.overlay != null && p.dockTo) return "window";
    if (p.overlay != null) return "inside";
    if (p.asPane) return "pane";
    return "block";
  }

  block() {
    const p = props() ?? {};
    const blocks = findBlocks(layout(), this.mod, this.match);
    return blocks.find((b) => !b.hidden) ?? blocks.find((b) => b.id === p.dockTo) ?? null;
  }

  canCollapse() {
    const b = this.where() === "block" ? this.block() : null;
    return Boolean(b && (b.parent === "column" || b.parent === "row"));
  }

  // Collapsed in a row: a strip on its edge rather than a bar.
  rail() {
    return this.collapsed() && this.block()?.parent === "row";
  }

  collapsed() {
    return this.where() === "block" && isCollapsed(this.block());
  }

  // Whether this copy should poll: on screen and not collapsed.
  visible() {
    const where = this.where();
    if (where === "window" || where === "inside") return true;
    if (where === "pane") return isShown(null, this.mod, {}, { panes: panes(), spaces: spaces() });
    if (this.collapsed()) return false;
    return isShown(layout(), this.mod, this.match, { panes: panes(), spaces: spaces() });
  }

  toggleCollapse(cx) {
    const b = this.block();
    if (!b || !this.canCollapse()) return;
    const sizes = { ...(shared(SIZES) ?? {}) };
    if (isCollapsed(b)) {
      run("layout.resize", { id: b.id, ...expandedSize(sizes[b.id]) });
    } else {
      sizes[b.id] = b.size;
      setShared(SIZES, sizes);
      run("layout.resize", { id: b.id, px: HEADER_PX });
    }
    cx.notify();
  }

  // A floating window that stays where it's dropped and comes back after a restart; the
  // block it came from hides until it's docked again.
  detach(cx) {
    const b = this.block();
    if (!b) return;
    const { overlay: _o, ...p } = props() ?? {};
    openOverlay({ kind: "window", mod: this.mod, key: `${this.mod}:${b.id}`, keep: true,
      width: this.size.width, height: this.size.height, props: { ...p, dockTo: b.id } });
    run("layout.hide", { id: b.id });
    cx.notify();
  }

  dock() {
    const p = props() ?? {};
    if (p.dockTo) run("layout.show", { id: p.dockTo });
    if (p.overlay != null) closeOverlay(p.overlay);
  }

  // A copy of this panel as a pane beside the focused terminal: it drags, zooms and closes
  // like any pane and is saved with its tab.
  openAsPane() {
    const { overlay: _o, dockTo: _d, ...p } = props() ?? {};
    run("pane.split", { direction: "right", mod: this.mod, props: { ...p, asPane: true } });
  }

  // The header. title: string; count (a number or text such as "12/80"), sub (the project), at (ms of the data), loading,
  // onRefresh(cx), extra: elements placed before the buttons (range pills, say).
  header(t, { title, count = null, sub = "", at = null, loading = false, onRefresh = null, extra = [] }) {
    if (this.rail()) return this.railView(t, title, count);
    const where = this.where(), collapsed = this.collapsed(), canCollapse = this.canCollapse();
    const icon = (id, glyph, tip, onClick) => div().id(`${this.mod}-${id}`).w(20).h(20).flex_none().rounded(4)
      .flex().items_center().justify_center().text_size(12).text_color(t.muted).cursor_pointer()
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(tip)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); })
      .child(glyph);
    return h_flex().id(`${this.mod}-header`).h(HEADER_PX).flex_none().pl(canCollapse ? 6 : 12).pr(6).gap(6).items_center()
      .when(!collapsed, (e) => e.border_b(1).border_color(t.border))
      .on_hover((h, cx) => { this.hovered = h; cx.notify(); })
      .when(canCollapse, (e) => e.cursor_pointer().on_click((_e, cx) => this.toggleCollapse(cx)))
      .when(canCollapse, (e) => e.child(div().w(12).flex_none().text_size(9).text_color(t.dim).child(collapsed ? "▸" : "▾")))
      .child(div().flex_none().text_size(13).font_semibold().text_color(t.foreground).child(title))
      .when(count != null, (e) => e.child(pill(t, String(count))))
      .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(sub ?? ""))
      .children(extra)
      .when(at != null && !loading && !this.hovered, (e) => e.child(div().flex_none().text_size(10).text_color(t.dim)
        .child(ago(at) === "now" ? "now" : ago(at))))
      .when(Boolean(onRefresh), (e) => e.child(loading
        ? div().w(20).flex_none().text_size(12).text_color(t.muted).flex().justify_center().child(div().frames(SPIN, 90))
        : icon("refresh", "↻", at ? `Refresh (updated ${ago(at) === "now" ? "just now" : `${ago(at)} ago`})` : "Refresh",
          (cx) => onRefresh(cx))))
      .when(this.hovered && where === "block" && Boolean(this.block()), (e) => e
        .child(icon("pane", "⧉", "Open as a pane", () => this.openAsPane()))
        .child(icon("detach", "↗", "Detach into a window", (cx) => this.detach(cx))))
      .when(where === "window", (e) => e.child(icon("dock", "↙", "Dock it back", () => this.dock())));
  }
}

// The collapsed strip of a panel in a row: ▸, then the title down the strip, then the
// count. Text can't turn sideways here, so the letters stack. Click anywhere to expand.
Chrome.prototype.railView = function (t, title, count) {
  return v_flex().id(`${this.mod}-rail`).size_full().pt(10).gap(1).items_center().cursor_pointer()
    .bg(t.chrome).hover((s) => s.bg(t.hover)).tooltip(`Show ${title}`)
    .on_click((_e, cx) => this.toggleCollapse(cx))
    .child(div().pb(6).text_size(10).text_color(t.dim).child("▸"))
    .children([...title].map((ch) => div().text_size(11).font_semibold().text_color(t.muted).child(ch === " " ? "·" : ch)))
    .when(count != null, (e) => e.child(div().pt(6).child(pill(t, String(count)))));
};

// ---- small parts ----

export function pill(t, text, color = null) {
  return div().flex_none().px(5).rounded(4).border_1().border_color(t.border).text_size(10).text_color(color ?? t.muted).child(text);
}

export function chip(t, text, color = null) {
  return div().flex_none().px(5).rounded(4).border_1().border_color(t.border).text_size(10.5).text_color(color ?? t.muted).child(text);
}

// tone: "primary" (solid), "danger" (red), or a plain raised button.
export function button(t, id, label, onClick, { tone = null, tooltip = null } = {}) {
  const bg = tone === "danger" ? t.ansi1 : tone === "primary" ? t.solid : t.raised;
  const fg = tone === "danger" ? t.background : tone === "primary" ? t.solid_foreground : t.foreground;
  return div().id(id).flex_none().px(8).py(2).rounded(5).bg(bg).text_size(11.5).text_color(fg).cursor_pointer()
    .hover((s) => s.opacity(0.85))
    .when(Boolean(tooltip), (e) => e.tooltip(tooltip))
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); })
    .child(label);
}

// The body when there's nothing to list: a quiet line, or the error in red.
export function note(t, text, { error = false } = {}) {
  return div().p(12).text_size(12).text_color(error ? t.ansi1 : t.muted).child(text);
}

// An error above data that's still shown (stale data stays; this says why it's stale).
export function staleError(t, text, { inset = 12 } = {}) {
  return div().px(inset).py(4).text_size(11).text_color(t.ansi1).truncate().tooltip(text).child(text);
}

// A single-choice dropdown: the current value (with its color dot) and a list on click.
// options: [[value, label, color?]]. state: an object the view keeps ({ open: id | null }).
export function dropdown(t, id, options, current, onPick, state) {
  const dot = (color) => div().size(7).rounded(4).flex_none().bg(color);
  const open = state.open === id;
  const cur = options.find(([v]) => v === current) ?? [null, "none"];
  const trigger = h_flex().id(`${id}-trigger`).gap(6).items_center().px(6).py(1).rounded(4).text_size(11.5)
    .cursor_pointer().border_1().border_color(open ? t.accent : t.border).hover((s) => s.bg(t.hover))
    .when(Boolean(cur[2]), (e) => e.child(dot(cur[2])))
    .child(div().max_w(220).truncate().text_color(current == null ? t.muted : t.foreground).child(cur[1]))
    .child(div().text_size(9).text_color(t.dim).child("▾"));
  const list = v_flex().id(`${id}-list`).min_w(160).max_h(320).overflow_y_scrollbar().p(4).gap(1).rounded(6)
    .bg(t.popover).border_1().border_color(t.border).shadow_md()
    .children(options.map(([value, label, color]) => h_flex().id(`${id}-${label}`).gap(6).items_center()
      .px(8).py(3).rounded(4).text_size(11.5).cursor_pointer()
      .when(value === current, (e) => e.bg(t.selected))
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => {
        state.open = null;
        if (value !== current) onPick(value, cx);
        cx.notify();
      })
      .child(color ? dot(color) : div().size(7).flex_none())
      .child(div().flex_1().min_w(0).truncate().text_color(value == null ? t.muted : t.foreground).child(label))
      .when(value === current, (e) => e.child(div().text_size(10).text_color(t.dim).child("✓")))));
  return Popover.new(id).open(open)
    .on_open_change((o, cx) => { state.open = o ? id : state.open === id ? null : state.open; cx.notify(); })
    .trigger(trigger).content(list);
}
