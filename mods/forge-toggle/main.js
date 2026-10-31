import { View, div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { layout, props, run, spaces, theme } from "herdr";

// A bar that shows or hides a hidden panel, or goes to a mod's tab.
// props: { target: "<layout node id>", label?, keys? }: toggles that node (layout.toggle).
//    or: { tab: { name, mod, props? }, label?, keys? }: goes to the tab with that name,
//        opening it with that mod if it isn't open.
// label defaults to the target or tab name; keys is only a hint drawn on the right (bind
// the real key in keys.json).

// A layout node by id, floating blocks included.
function find(node, id) {
  if (!node || typeof node !== "object") return null;
  if (node.id === id) return node;
  for (const c of [...(Array.isArray(node.children) ? node.children : []), ...(Array.isArray(node.floating) ? node.floating : [])]) {
    const r = find(c, id);
    if (r) return r;
  }
  return null;
}

export default class Toggle extends View {
  // layout() changes don't redraw this bar by themselves: look a few times a second.
  init(_props, cx) {
    this.open = this.isOpen();
    cx.timer.every(250, (cx) => {
      const open = this.isOpen();
      if (open !== this.open) { this.open = open; cx.notify(); }
    });
  }

  // The tab a `tab` bar opens, if it's open: { space, tab }.
  findTab() {
    const name = props()?.tab?.name;
    if (!name) return null;
    for (const s of spaces()) {
      const tab = (s.tabs ?? []).find((t) => t.name === name);
      if (tab) return { space: s, tab };
    }
    return null;
  }

  isOpen() {
    const { target, tab } = props() ?? {};
    if (tab) { const f = this.findTab(); return Boolean(f?.space.active && f.tab.active); }
    if (!target) return false;
    const node = find(layout(), target);
    return Boolean(node) && !node.hidden; // a shown node has no `hidden` at all
  }

  click() {
    const { target, tab } = props() ?? {};
    if (tab?.mod || tab?.name) {
      const f = this.findTab();
      if (f) { run("space.select", { id: f.space.id }); run("tab.select", { id: f.tab.id }); }
      else if (tab.mod) run("tab.new", { name: tab.name ?? tab.mod, mod: tab.mod, props: tab.props ?? {} });
    } else if (target) run("layout.toggle", { id: target });
  }

  // Type and spacing as the panels' headers (Chrome in shared/ui.js): the arrow where
  // their collapse caret is, the label as their title, the keys where their age goes.
  render() {
    const { target, tab, label, keys } = props() ?? {};
    const t = theme();
    if (!target && !tab) {
      return h_flex().id("toggle").size_full().px(12).items_center().bg(t.background).text_size(11).text_color(t.muted)
        .child("No target set (props.target or props.tab).");
    }
    const open = (this.open = this.isOpen());
    return h_flex().id(`toggle-${target ?? tab.name ?? tab.mod}`).size_full().pl(6).pr(12).gap(6).items_center()
      .bg(t.background).cursor_pointer().text_color(open ? t.foreground : t.muted)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click(() => this.click())
      .child(div().w(12).flex_none().flex().justify_center().text_size(tab ? 11 : 9).text_color(t.dim)
        .child(tab ? "↗" : open ? "◂" : "▸"))
      .child(div().flex_1().min_w(0).truncate().text_size(13).font_semibold().child(label ?? tab?.name ?? tab?.mod ?? target))
      .when(Boolean(keys), (e) => e.child(div().flex_none().text_size(10).text_color(t.dim).child(keys)));
  }
}
