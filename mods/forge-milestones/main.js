import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, readTextFile, appHome, props, theme } from "herdr";
import { forgeClient, projectOf, openUrl } from "./lib.js";
import { Chrome, note, staleError } from "./ui.js";

// Active milestones for one project, with issue progress. Click a milestone to expand its
// issues (open first); ↗ opens it in the browser; ↻ fetches again.
// props: { repo: "group/project", on?, provider?, host? } (docs/contract.md).
// forge.py runs on `on` (where glab is logged in); links open in this computer's browser.

const MOD = "forge-milestones";
const EVERY = 300;          // seconds: how old an answer may be before we fetch again
const DAY = 86400000;

const msg = (e) => String(e?.message ?? e);

// "YYYY-MM-DD" -> local midnight, epoch ms. Done once per answer, never in render.
function dueMs(date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date ?? "");
  return m ? new Date(+m[1], +m[2] - 1, +m[3]).getTime() : null;
}

function dueText(ms) {
  if (ms == null) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const days = Math.round((ms - today.getTime()) / DAY);
  if (days < 0) return { text: `${-days}d overdue`, late: true };
  if (days === 0) return { text: "due today", late: false };
  return { text: `due in ${days}d`, late: false };
}

export default class Milestones extends View {
  init(_props, cx) {
    this.forge = forgeClient({ exec, readTextFile }, `${appHome()}/mods/${MOD}/forge.py`);
    this.chrome = new Chrome(MOD, { repo: props()?.repo });
    this.chrome.attach(cx);
    this.list = [];             // Milestone, plus pct and dueMs
    this.at = 0;                // when the answer was fetched (epoch s)
    this.error = null;
    this.loading = false;
    this.again = false;         // a ↻ came while a fetch ran: fetch again after it
    this.started = false;      // the first read (maxAge -1) has run
    this.polled = 0;            // when we last asked (ms)
    this.expanded = new Set();  // titles shown open
    this.items = {};            // title -> { list, at, error, loading, started }
    this.tick(cx);
    cx.timer.every(15000, (cx) => this.tick(cx));
  }

  project() { return projectOf(props() ?? {}); }

  // On screen and not collapsed (a detached window counts).
  shown() {
    return this.chrome.visible();
  }

  tick(cx) {
    const p = this.project();
    if (!p.repo || !p.provider || !this.shown()) return;
    if (!this.started || Date.now() - this.polled >= EVERY * 1000) this.refresh(cx, false);
  }

  // Stale-first: the first read takes any cached answer at once, then (if that one is old
  // or missing) a second asks for a fresh one.
  refresh(cx, force) {
    const p = this.project();
    if (!p.repo || !p.provider) return;
    // A ↻ while a fetch runs goes after it (a poll can wait for its next turn).
    if (this.loading) { if (force) this.again = true; return; }
    this.loading = true;
    this.polled = Date.now();
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const first = !this.started && !force;
        this.started = true;
        await this.load(p, first ? -1 : EVERY, force);
        cx.notify();
        if (first && Date.now() / 1000 - this.at >= EVERY) await this.load(p, EVERY, false);
      } catch (e) {
        this.error = msg(e);
      } finally {
        this.loading = false;
        cx.notify();
      }
      if (this.again) { this.again = false; this.refresh(cx, true); return; } // it loads the items too
      for (const title of this.expanded) this.loadItems(title, cx, force);
    });
  }

  async load(p, maxAge, force) {
    const out = await this.forge(["milestones", p.provider, p.host, p.repo, maxAge, force ? 1 : 0], { on: p.on });
    // Soonest due first (overdue ones lead), undated last.
    this.list = (out.milestones ?? []).map((m) => ({
      ...m, dueMs: dueMs(m.due), pct: m.all ? Math.round((m.closed / m.all) * 100) : 0,
    })).sort((a, b) => (a.dueMs ?? Infinity) - (b.dueMs ?? Infinity));
    this.at = out.at ?? 0;
    this.error = out.error ?? null;
  }

  toggle(m, cx) {
    if (this.expanded.has(m.title)) this.expanded.delete(m.title);
    else { this.expanded.add(m.title); this.loadItems(m.title, cx, false); }
    cx.notify();
  }

  loadItems(title, cx, force) {
    const p = this.project();
    const prev = this.items[title];
    if (prev?.loading) { if (force) prev.again = true; return; }
    const st = (this.items[title] = { list: prev?.list ?? [], at: prev?.at ?? 0, error: null, loading: true, started: prev?.started });
    cx.notify();
    cx.spawn(async (cx) => {
      const ask = async (maxAge, f) => {
        const out = await this.forge(["milestone-items", p.provider, p.host, p.repo, title, maxAge, f ? 1 : 0], { on: p.on });
        st.list = out.items ?? [];
        st.at = out.at ?? 0;
        st.error = out.error ?? null;
      };
      try {
        const first = !st.started && !force;
        st.started = true;
        await ask(first ? -1 : EVERY, force);
        cx.notify();
        if (first && Date.now() / 1000 - st.at >= EVERY) await ask(EVERY, false);
      } catch (e) {
        st.error = msg(e);
      } finally {
        st.loading = false;
        cx.notify();
      }
      if (st.again && this.items[title] === st) this.loadItems(title, cx, true);
    });
  }

  workItems(m, t) {
    const st = this.items[m.title] ?? { list: [], loading: true };
    const err = st.error && div().px(8).pb(4).text_size(11).text_color(t.ansi1).child(st.error);
    if (!st.list.length) {
      return v_flex().when(Boolean(err), (e) => e.child(err))
        .when(!st.error || st.loading, (e) => e.child(div().px(8).pb(6).text_size(11).text_color(t.muted)
          .child(st.loading ? "Loading…" : "No issues.")));
    }
    return v_flex().pl(14).pr(4).pb(4).gap(1)
      .when(Boolean(err), (e) => e.child(err))
      .children(st.list.map((i) => {
        const done = i.state !== "opened";
        const who = (i.assignees ?? []).join(", ");
        return h_flex().id(`wi-${i.id}`).px(6).py(3).gap(6).items_center().rounded(4).cursor_pointer()
          .text_size(12).text_color(done ? t.dim : t.foreground)
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { cx.stop_propagation(); openUrl(exec, i.url); })
          .child(div().w(10).flex_none().text_size(10).text_color(done ? t.ansi2 : t.accent).child(done ? "✓" : "●"))
          .child(div().flex_none().text_size(11).text_color(t.dim).child(`#${i.iid}`))
          .child(div().flex_1().min_w(0).truncate().child(i.title))
          .when(Boolean(who), (e) => e.child(div().flex_none().text_size(10).text_color(t.muted).child(who)));
      }));
  }

  milestone(m, t) {
    const d = dueText(m.dueMs), open = this.expanded.has(m.title);
    const row = v_flex().id(`ms-${m.id}`).px(8).py(6).gap(4).rounded(6).cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.toggle(m, cx))
      .child(h_flex().gap(6).items_center()
        .child(div().w(10).flex_none().text_size(10).text_color(t.muted).child(open ? "▾" : "▸"))
        .child(div().flex_1().min_w(0).truncate().text_size(13).child(m.title))
        .child(div().id(`ms-open-${m.id}`).flex_none().px(4).rounded(3).text_size(11).text_color(t.dim)
          .hover((s) => s.bg(t.raised).text_color(t.foreground))
          .on_click((_e, cx) => { cx.stop_propagation(); openUrl(exec, m.url); })
          .child("↗"))
        .when(Boolean(d), (e) => e.child(d.late
          ? div().flex_none().px(5).rounded(4).bg(t.ansi1 + "26").text_size(10.5).text_color(t.ansi1).child(d.text)
          : div().flex_none().text_size(11).text_color(t.muted).child(d.text))))
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().h(4).rounded(2).bg(t.raised).overflow_hidden()
          .child(div().h_full().w(`${m.pct}%`).rounded(2).bg(m.pct === 100 ? t.ansi2 : t.accent)))
        .child(div().w(150).flex_none().text_size(11).text_color(t.muted)
          // Counts are null when forge.py ran out of time before fetching them.
          .child(m.all == null ? "counts on the next refresh" : `${m.closed}/${m.all} closed · ${m.open} open`)));
    return open ? v_flex().child(row).child(this.workItems(m, t)) : row;
  }

  render(cx) {
    const t = theme(), p = this.project();
    const header = this.chrome.header(t, {
      title: "Milestones", count: this.list.length, sub: p.repo, at: this.at ? this.at * 1000 : null,
      loading: this.loading, onRefresh: (cx) => this.refresh(cx, true),
    });
    let body = null;
    if (this.chrome.collapsed()) body = null;
    else if (!p.repo) body = note(t, "No repo set (props.repo).");
    else if (!p.provider) body = note(t, `${p.host} isn't a forge this panel supports.`);
    else if (!this.list.length) body = this.error ? note(t, this.error, { error: true })
      : note(t, this.loading || !this.started ? "Loading…" : "No active milestones.");
    else body = v_flex().id("ms-list").flex_1().min_h(0).overflow_y_scrollbar().p(6).gap(2)
      .when(Boolean(this.error), (e) => e.child(staleError(t, this.error)))
      .children(this.list.map((m) => this.milestone(m, t)));

    return v_flex().id("milestones").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .child(header).when(Boolean(body), (e) => e.child(body));
  }
}
