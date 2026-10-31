import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, readTextFile, appHome, props, theme, window } from "herdr";
import { forgeClient, projectOf, ago, clock, openUrl } from "./lib.js";
import { Chrome, note, pill, staleError } from "./ui.js";
import { pollEvery, arrange } from "./runners.js";

// The project's own CI runners (not the forge's shared ones), what each is running, and
// jobs queued for a runner, through forge.py on `on`.
// props: { repo: "group/project", on?, provider?, host? }
// A queued job no online runner can take (by tags) is flagged: that's CI stuck, not slow.

const MOD = "forge-runners";

const message = (e) => String(e?.message ?? e);

export default class Runners extends View {
  init(_props, cx) {
    this.forge = forgeClient({ exec, readTextFile }, `${appHome()}/mods/${MOD}/forge.py`);
    this.project = projectOf(props() ?? {});
    this.chrome = new Chrome(MOD, { repo: this.project.repo }, { width: 380, height: 480 });
    this.chrome.attach(cx);
    this.view = arrange(null);
    this.at = 0;         // when forge.py fetched them (epoch s)
    this.jobs = [];
    this.error = null;
    this.loading = false;
    this.again = null;   // a refresh asked for while one ran: [maxAge, force]
    this.last = 0;
    this.shown = false;
    this.ticks = 0;
    if (!this.usable()) return;
    // Whatever is cached, however old, so the panel draws at once.
    this.refresh(cx, -1, false);
    // Only while on screen and not collapsed: every 20 s while jobs run or wait (and the
    // window is in front), else every minute. Showing it refreshes at once.
    cx.timer.every(1000, (cx) => {
      const shown = this.chrome.visible();
      const opened = shown && !this.shown;
      this.shown = shown;
      if (!shown) return;
      const every = pollEvery(this.jobs, window().active);
      if (opened || Date.now() - this.last >= every * 1000) this.refresh(cx, every, false);
      else if (this.jobs.length || ++this.ticks % 30 === 0) cx.notify(); // keep job timers and "3m" moving
    });
  }

  usable() {
    return Boolean(this.project.provider && this.project.repo);
  }

  refresh(cx, maxAge, force) {
    if (!this.usable()) return;
    if (this.loading) { this.again = [maxAge, force || Boolean(this.again?.[1])]; return; }
    this.loading = true;
    cx.notify();
    cx.spawn(async (cx) => {
      const { provider, host, repo, on } = this.project;
      try {
        const out = await this.forge(["runners", provider, host, repo, maxAge, force ? 1 : 0], { on });
        this.jobs = out.jobs ?? [];
        this.view = arrange(out);
        this.at = out.at ?? this.at;
        this.error = out.error ?? null;
      } catch (e) {
        this.error = message(e);
      }
      this.loading = false;
      this.last = Date.now();
      const again = this.again;
      this.again = null;
      if (again) this.refresh(cx, ...again);
      cx.notify();
    });
  }

  jobRow(t, j, now, extra) {
    const { terms } = this.project;
    const since = j.status === "running" ? j.started_ms : j.created_ms;
    return h_flex().id(`job-${j.id}`).h(20).px(4).gap(6).items_center().rounded(4).text_size(11.5).cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .tooltip(`${j.group ?? ""} · ${j.name} · ${terms.ciRun} #${j.pipeline ?? "?"}`)
      .on_click((_e, cx) => { cx.stop_propagation(); openUrl(exec, j.url); })
      .child(div().flex_none().text_color(t.foreground).child(j.ref ?? ""))
      .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(j.name))
      .when(Boolean(extra), (e) => e.child(extra))
      .child(div().flex_none().text_color(t.dim).child(since == null ? "" : clock((now - since) / 1000)));
  }

  runnerRow(t, r, now) {
    const busy = r.jobs.length > 0;
    const color = r.paused ? t.muted : r.status === "online" ? (busy ? t.working : t.ansi2) : r.status === "offline" ? t.ansi1 : t.dim;
    const state = r.paused ? "paused" : r.status === "online" ? (busy ? `${r.jobs.length} running` : "idle") : (r.status ?? "unknown").replace(/_/g, " ");
    const mark = busy && !r.paused
      ? svg(`mods/${MOD}/spinner.svg`).size(10).flex_none().text_color(color).spin(900)
      : div().size(7).mx(1).flex_none().rounded(4).bg(color);
    const seen = r.contacted_ms == null ? "" : ago(r.contacted_ms, now);
    const kind = this.project.provider === "gitlab" ? "gitlab-runner" : "runner";
    const tip = r.details
      ? `#${r.id} · ${kind} ${r.version ?? "?"} · ${r.platform ?? ""}/${r.arch ?? ""}` +
        (seen ? ` · last seen ${seen === "now" ? "just now" : `${seen} ago`}` : "")
      : `#${r.id}`;
    return v_flex().id(`runner-${r.id}`).px(8).py(6).gap(3).rounded(6).cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .tooltip(tip)
      .on_click(() => openUrl(exec, r.url))
      .child(h_flex().gap(7).items_center()
        .child(mark)
        .child(div().flex_1().min_w(0).truncate().text_size(13).child(r.name ?? `#${r.id}`))
        .child(div().flex_none().text_size(11).text_color(color).child(state)))
      .when(Boolean(r.tags?.length), (e) => e.child(h_flex().pl(15).gap(4).flex_wrap()
        .children(r.tags.map((tag) => pill(t, tag)))))
      .when(busy, (e) => e.child(v_flex().pl(11).children(r.jobs.map((j) => this.jobRow(t, j, now)))));
  }

  render() {
    const t = theme(), { provider, host, repo } = this.project;
    const { runners, up, elsewhere, queued } = this.view;
    const now = Date.now();
    const header = this.chrome.header(t, {
      title: "Runners", sub: repo, at: this.at ? this.at * 1000 : null, loading: this.loading,
      onRefresh: this.usable() ? (cx) => this.refresh(cx, 0, true) : null,
      // Up out of all, red when none is: the count the other panels put by the title.
      extra: runners.length ? [pill(t, `${up}/${runners.length} up`, up ? null : t.ansi1)] : [],
    });
    if (this.chrome.collapsed()) return v_flex().id("runners").size_full().min_h(0).bg(t.background).child(header);

    const section = (text, color) => div().px(8).pt(8).pb(2).text_size(11).text_color(color).child(text);
    let body;
    if (!provider) body = note(t, `${host} isn't a forge herdr-forge supports.`);
    else if (!repo) body = note(t, "No repo set (props.repo).");
    else if (this.error && !runners.length) body = note(t, this.error, { error: true });
    else if (!runners.length) body = note(t, this.loading ? "Loading…" : "No project runners.");
    else body = v_flex().id("rn-list").flex_1().min_h(0).overflow_y_scrollbar().p(6).gap(2)
      .when(Boolean(this.error), (e) => e.child(staleError(t, this.error)))
      .children(runners.map((r) => this.runnerRow(t, r, now)))
      .when(elsewhere.length > 0, (e) => e
        .child(section(`Running elsewhere · ${elsewhere.length}`, t.dim))
        .child(v_flex().px(4).children(elsewhere.map((j) => this.jobRow(t, j, now,
          div().flex_none().max_w(110).truncate().text_size(10).text_color(t.dim).child(j.runner?.name ?? ""))))))
      .when(queued.length > 0, (e) => e
        .child(section(`Queued · ${queued.length}`, t.ansi3))
        .child(v_flex().px(4).children(queued.map((j) => {
          const tags = (j.tags ?? []).join(", ") || "untagged";
          return this.jobRow(t, j, now, div().flex_none().max_w(140).truncate().text_size(10).text_color(j.stuck ? t.ansi1 : t.dim)
            .child(j.stuck ? `no runner (${tags})` : tags));
        }))));

    return v_flex().id("runners").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .child(header).child(body);
  }
}
