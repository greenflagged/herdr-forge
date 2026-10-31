import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, readTextFile, appHome, props, theme, layout, panes, spaces, window } from "herdr";
import { forgeClient, projectOf, isShown, ago, clock, openUrl } from "./lib.js";
import { LIVE, pollEvery, groupJobs, jobsStale } from "./ci.js";

// Recent pipelines (GitLab) / workflow runs (GitHub) for one project, through forge.py on
// `on` (where glab/gh is logged in).
// props: { repo: "group/project", on?, provider?, host? }
// Click a pipeline to see its jobs; hover for Retry / Cancel / ↗.

const MOD = "forge-ci";
const ICON = { success: "✓", failed: "✕", running: "●", pending: "○", created: "○", canceled: "⊘", skipped: "»", manual: "▶", scheduled: "◷" };

const message = (e) => String(e?.message ?? e);

export default class CI extends View {
  init(_props, cx) {
    this.forge = forgeClient({ exec, readTextFile }, `${appHome()}/mods/${MOD}/forge.py`);
    this.project = projectOf(props() ?? {});
    this.pipelines = [];
    this.jobs = {};          // pipeline id -> { groups, error, status, updated_ms } | "loading"
    this.jobsBusy = new Set();
    this.open = new Set();   // expanded pipeline ids
    this.hovered = null;
    this.acting = null;      // pipeline id with a retry/cancel in flight
    this.error = null;
    this.loading = false;
    this.again = null;       // a refresh asked for while one ran: [maxAge, force]
    this.last = 0;
    this.shown = false;
    this.ticks = 0;
    if (!this.usable()) return;
    // Whatever is cached, however old, so the panel draws at once.
    this.refresh(cx, -1, false);
    // Only while shown: every 10 s while something recent is running (and the window is
    // in front), else every minute. Showing it refreshes at once.
    cx.timer.every(1000, (cx) => {
      const shown = isShown(layout(), MOD, { repo: this.project.repo }, { panes: panes(), spaces: spaces() });
      const opened = shown && !this.shown;
      this.shown = shown;
      if (!shown) return;
      const every = this.every();
      if (opened || Date.now() - this.last >= every * 1000) this.refresh(cx, every, false);
      else if (++this.ticks % 10 === 0) cx.notify(); // keep "3m" moving
    });
  }

  usable() {
    return Boolean(this.project.provider && this.project.repo);
  }

  every() {
    return pollEvery(this.pipelines, window().active);
  }

  call(args) {
    const { provider, host, repo, on } = this.project;
    const [cmd, ...rest] = args;
    return this.forge([cmd, provider, host, repo, ...rest], { on });
  }

  refresh(cx, maxAge, force) {
    if (!this.usable()) return;
    if (this.loading) { this.again = [maxAge, force || Boolean(this.again?.[1])]; return; }
    this.loading = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const out = await this.call(["pipelines", maxAge, force ? 1 : 0]);
        this.pipelines = out.pipelines ?? [];
        this.error = out.error ?? null;
        // Expanded ones whose jobs could have changed.
        for (const p of this.pipelines) {
          if (this.open.has(p.id) && jobsStale(p, this.jobs[p.id] === "loading" ? null : this.jobs[p.id])) {
            this.loadJobs(cx, p, [maxAge], force);
          }
        }
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

  // Reads a pipeline's jobs with each maxAge in turn, stopping once the answer is fresh
  // enough: [-1, every] draws what's cached at once, then fetches only if it's old.
  loadJobs(cx, p, ages, force = false) {
    if (this.jobsBusy.has(p.id)) return;
    this.jobsBusy.add(p.id);
    if (!this.jobs[p.id]) this.jobs[p.id] = "loading";
    cx.spawn(async (cx) => {
      for (const age of ages) {
        try {
          const out = await this.call(["jobs", p.id, age, force ? 1 : 0]);
          this.jobs[p.id] = { groups: groupJobs(out.jobs), error: out.error ?? null, status: p.status, updated_ms: p.updated_ms };
          cx.notify();
          if (out.error || (out.at && Date.now() / 1000 - out.at < this.every())) break;
        } catch (e) {
          const had = this.jobs[p.id];
          this.jobs[p.id] = { groups: had?.groups ?? [], error: message(e), status: p.status, updated_ms: p.updated_ms };
          break;
        }
      }
      this.jobsBusy.delete(p.id);
      cx.notify();
    });
  }

  toggle(p, cx) {
    if (this.open.has(p.id)) this.open.delete(p.id);
    else {
      this.open.add(p.id);
      const had = this.jobs[p.id];
      if (jobsStale(p, had === "loading" ? null : had)) this.loadJobs(cx, p, had ? [this.every()] : [-1, this.every()]);
    }
    cx.notify();
  }

  act(p, what, cx) {
    this.acting = p.id;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const out = await this.call(["pipeline-act", p.id, what]);
        this.error = out.error ? `${what} failed: ${out.error}` : null;
      } catch (e) {
        this.error = `${what} failed: ${message(e)}`;
      }
      this.acting = null;
      // pipeline-act dropped the cached answers: this fetches them again.
      this.refresh(cx, this.every(), false);
      cx.notify();
    });
  }

  color(t, status) {
    return { success: t.ansi2, failed: t.ansi1, running: t.ansi4, pending: t.ansi3, created: t.ansi3,
      waiting_for_resource: t.ansi3, preparing: t.ansi3, manual: t.ansi5, scheduled: t.ansi5 }[status] ?? t.dim;
  }

  jobList(p, t) {
    const jobs = this.jobs[p.id];
    if (jobs === "loading" || jobs == null) return div().pl(22).py(2).text_size(11).text_color(t.dim).child("Loading jobs…");
    if (!jobs.groups.length) {
      return div().pl(22).py(2).text_size(11).text_color(jobs.error ? t.ansi1 : t.dim).child(jobs.error ?? "No jobs.");
    }
    return v_flex().pl(22).gap(1)
      .when(Boolean(jobs.error), (e) => e.child(div().py(2).text_size(11).text_color(t.ansi1).child(jobs.error)))
      .children(jobs.groups.flatMap(({ group, jobs }) => [
        div().pt(3).text_size(10).text_color(t.dim).child(group),
        ...jobs.map((j) =>
          h_flex().id(`job-${j.id}`).h(20).px(4).gap(6).items_center().rounded(4).text_size(11.5).cursor_pointer()
            .hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => { cx.stop_propagation(); openUrl(exec, j.url); })
            .child(div().w(12).flex_none().text_color(this.color(t, j.status)).child(ICON[j.status] ?? "·"))
            .child(div().flex_1().min_w(0).truncate().child(j.name))
            .when(j.allow_failure && j.status === "failed", (e) => e.child(div().text_size(10).text_color(t.ansi3).child("allowed")))
            .child(div().flex_none().text_color(t.dim).child(clock(j.duration)))),
      ]));
  }

  render() {
    const t = theme(), { provider, host, repo, terms } = this.project;
    const header = h_flex().h(34).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
      .child(div().font_semibold().child(terms.ci))
      .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(repo))
      .when(this.usable(), (e) => e.child(div().id("ci-refresh").px(6).py(2).rounded(4).text_size(12).cursor_pointer()
        .text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
        .tooltip("Refresh")
        .when(this.loading, (e) => e.loop("opacity", { from: 0.3, to: 1, period: 900 }))
        .on_click((_e, cx) => this.refresh(cx, 0, true))
        .child("↻")));

    const button = (id, label, onClick) =>
      div().id(id).flex_none().px(6).py(1).rounded(4).bg(t.raised).text_size(11).text_color(t.foreground).cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); })
        .child(label);

    const now = Date.now();
    let body;
    if (!provider) body = div().p(12).text_color(t.muted).child(`${host} isn't a forge herdr-forge supports.`);
    else if (!repo) body = div().p(12).text_color(t.muted).child("No repo set (props.repo).");
    else if (this.error && !this.pipelines.length) body = div().p(12).text_size(12).text_color(t.ansi1).child(this.error);
    else if (!this.pipelines.length) body = div().p(12).text_color(t.muted).child(this.loading ? "Loading…" : `No ${terms.ciRun}s.`);
    else body = v_flex().id("ci-list").flex_1().min_h(0).overflow_y_scrollbar().p(6).gap(2)
      .when(Boolean(this.error), (e) => e.child(div().px(8).py(4).text_size(11).text_color(t.ansi1).child(this.error)))
      .children(this.pipelines.map((p) => {
        const hovered = this.hovered === p.id, open = this.open.has(p.id);
        return v_flex().id(`pl-${p.id}`).px(8).py(6).gap(3).rounded(6).cursor_pointer()
          .when(open, (e) => e.bg(t.raised))
          .hover((s) => s.bg(t.hover))
          .on_hover((on, cx) => {
            if (on) this.hovered = p.id; else if (this.hovered === p.id) this.hovered = null;
            cx.notify();
          })
          .on_click((_e, cx) => this.toggle(p, cx))
          .child(h_flex().gap(6).items_center()
            .child(div().w(14).flex_none().text_color(this.color(t, p.status)).child(ICON[p.status] ?? "·"))
            .child(div().flex_none().text_size(13).font_semibold().child(p.ref ?? ""))
            .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(p.sha?.slice(0, 8) ?? ""))
            .when(this.acting === p.id, (e) => e.child(div().text_size(11).text_color(t.muted).child("…")))
            .when(hovered && this.acting !== p.id, (e) => e
              .when(LIVE.has(p.status), (e) => e.child(button(`cancel-${p.id}`, "Cancel", (cx) => this.act(p, "cancel", cx))))
              .when(p.status === "failed" || p.status === "canceled", (e) => e.child(button(`retry-${p.id}`, "Retry", (cx) => this.act(p, "retry", cx))))
              .child(button(`open-${p.id}`, "↗", () => openUrl(exec, p.url))))
            .when(!hovered || this.acting === p.id, (e) => e.child(div().flex_none().text_size(11).text_color(t.dim).child(ago(p.updated_ms, now)))))
          .child(h_flex().pl(20).gap(8).text_size(11).text_color(t.muted)
            .child(div().text_color(this.color(t, p.status)).child((p.status ?? "").replace(/_/g, " ")))
            .when(p.iid != null, (e) => e.child(div().text_color(t.dim).child(`#${p.iid}`)))
            .child(div().text_color(t.dim).child(p.source === "request" ? terms.request : p.source ?? "")))
          .when(open, (e) => e.child(this.jobList(p, t)));
      }));

    return v_flex().id("ci").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .child(header).child(body);
  }
}
