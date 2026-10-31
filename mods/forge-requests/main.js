import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import {
  exec, readTextFile, appHome, props, theme, shared, agents, terminals, run, spaces, knownAgents, openOverlay, notify,
} from "herdr";
import { forgeClient, projectOf, actionList, matches, runAction, describe, actionLabel, fill, ago, openUrl } from "./lib.js";
import { Chrome, button, chip, note, pill, staleError } from "./ui.js";
import { CI, defaultActions, mergeTip, checkoutOf, liveAgents, itemOf } from "./requests.js";

// Open merge requests (GitLab) / pull requests (GitHub) for one project, through forge.py.
// props: { repo, on?, provider?, host?, folder?, actions? } (docs/contract.md, docs/actions.md)
// forge.py runs on `on` (where glab or gh is logged in); links open in this computer's browser.

const MOD = "forge-requests";
const POLL = 60; // seconds
const SPINNER = `mods/${MOD}/spinner.svg`;
const CLOCK = `mods/${MOD}/clock.svg`;
const STATUS = { working: "Working", blocked: "Needs you", done: "Done", idle: "Idle" };

const message = (e) => String(e?.message ?? e);

export default class ForgeRequests extends View {
  init(_props, cx) {
    this.forge = forgeClient({ exec, readTextFile }, `${appHome()}/mods/${MOD}/forge.py`);
    this.chrome = new Chrome(MOD, { repo: props()?.repo }, { width: 440, height: 600 });
    this.chrome.attach(cx);
    this.requests = [];
    this.at = 0;            // when forge.py fetched them (epoch s)
    this.error = null;
    this.loading = false;
    this.again = null;      // a refresh asked for while one ran: { maxAge, force }
    this.hovered = null;    // iid under the pointer
    this.confirming = null; // { iid, id }: "merge" or an action id waiting for its confirm
    this.busy = {};         // iid -> "Merging…" / "Starting…" while something runs on it
    this.notice = null;     // { iid, text, error } from the last merge or action
    this.asked = 0;         // when we last asked forge.py (ms)
    this.drawn = 0;
    this.refresh(cx, -1, false); // whatever is cached, however old: draw at once
    // Only while on screen and not collapsed; showing it again asks at once if it's due.
    cx.timer.every(1000, (cx) => {
      if (!this.chrome.visible()) return;
      if (Date.now() - this.asked >= POLL * 1000) this.refresh(cx, POLL, false);
      else if (Date.now() - this.drawn >= 30000) cx.notify(); // keep the ages moving
    });
  }

  refresh(cx, maxAge, force) {
    const { provider, host, repo, on } = projectOf(props() ?? {});
    if (!provider || !repo) return;
    if (this.loading) {
      this.again = { maxAge: Math.min(maxAge, this.again?.maxAge ?? maxAge), force: force || Boolean(this.again?.force) };
      return;
    }
    this.loading = true;
    this.asked = Date.now();
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const out = await this.forge(["requests", provider, host, repo, maxAge, force ? 1 : 0], { on });
        // With an error the requests are the last good ones: show both.
        if (Array.isArray(out?.requests)) this.requests = out.requests;
        this.at = out?.at ?? this.at;
        this.error = out?.error ?? null;
      } catch (e) {
        this.error = message(e);
      } finally {
        this.loading = false;
        const again = this.again;
        this.again = null;
        cx.notify();
        if (again) this.refresh(cx, again.maxAge, again.force);
      }
    });
  }

  // Merge only the commit the list showed (its sha), so a later push isn't merged unseen.
  // With CI still running, the forge sets auto-merge instead.
  merge(r, cx) {
    const { provider, host, repo, on } = projectOf(props() ?? {});
    this.confirming = null;
    this.busy = { ...this.busy, [r.iid]: "Merging…" };
    this.notice = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const out = await this.forge(["merge", provider, host, repo, r.iid, r.sha ?? ""], { on });
        this.notice = out?.error
          ? { iid: r.iid, text: out.error, error: true }
          : { iid: r.iid, text: out?.text || "Merged", error: false };
      } catch (e) {
        this.notice = { iid: r.iid, text: message(e), error: true };
      } finally {
        this.toast(r, this.notice.error ? "Merge failed" : "Merged", this.notice);
        this.done(r.iid);
        cx.notify();
        this.refresh(cx, 0, false); // merge dropped the cached list
      }
    });
  }

  // A toast as well as the line under the row: the row may be scrolled away by then.
  toast(r, what, { text, error }) {
    const { terms } = projectOf(props() ?? {});
    try {
      notify({ title: `${what} · ${terms.reqPrefix}${r.iid}`, body: `${r.title ?? ""}\n${text}`.trim(),
        level: error ? "error" : "success" });
    } catch {}
  }

  done(iid) {
    const busy = { ...this.busy };
    delete busy[iid];
    this.busy = busy;
  }

  act(a, r, cx) {
    const p = props() ?? {};
    const project = projectOf(p);
    const folder = checkoutOf(p.folder, spaces(), project.on, project.repo);
    const agent = a.task != null || Boolean(a.agent);
    this.confirming = null;
    this.busy = { ...this.busy, [r.iid]: agent ? "Starting…" : "Running…" };
    this.notice = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        if (agent && !folder) throw new Error("No checkout of the repo found (set props.folder).");
        const res = await runAction(a, itemOf(r, project), { on: project.on, folder },
          { exec, run, spaces, knownAgents, openOverlay });
        if (res?.text) this.notice = { iid: r.iid, text: res.text, error: false };
        this.toast(r, a.label, { text: res?.text || (agent ? "Agent started" : "Done"), error: false });
      } catch (e) {
        this.notice = { iid: r.iid, text: message(e), error: true };
        this.toast(r, `${a.label} failed`, this.notice);
      } finally {
        this.done(r.iid);
        cx.notify();
      }
    });
  }

  // A glyph for the request's CI; click opens it.
  ciBadge(t, r, terms) {
    const ci = r.ci;
    const [glyph, colorKey] = CI[ci.status];
    const color = t[colorKey] ?? t.dim;
    const what = ci.id != null ? ` · ${terms.ciRun} #${ci.id}` : "";
    const when = ci.updated_ms ? `, ${ago(ci.updated_ms)} ago` : "";
    return div().id(`ci-${r.iid}`).flex_none().px(2).rounded(3).text_size(12).text_color(color).cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .tooltip(`CI ${ci.status.replace(/_/g, " ")}${what}${when}`)
      .on_click((_e, cx) => { cx.stop_propagation(); openUrl(exec, ci.url); })
      .child(glyph ?? svg(SPINNER).size(11).text_color(color).spin(900));
  }

  // One agent on the request: icon, name, status. Click goes to it (sub-agents peek).
  agentRow(t, r, a) {
    // An agent resting while its request's CI runs is waiting on CI, not stuck.
    const waiting = (a.status === "idle" || a.status === "done") && Boolean(r.ci && CI[r.ci.status]?.[2]);
    const color = waiting ? t.working : t[a.status] ?? t.dim;
    const pic = !a.program?.icon ? null
      : a.program.tint ? svg(a.program.icon).size(12).flex_none().text_color(t.foreground)
      : image(a.program.icon).w(12).h(12).flex_none();
    const mark = waiting
      ? svg(CLOCK).size(11).flex_none().text_color(color)
      : a.status === "working"
        ? svg(SPINNER).size(11).flex_none().text_color(t.working).spin(900)
        : a.status === "idle"
          ? div().size(7).mx(2).flex_none().rounded(4).border(1.5).border_color(t.idle ?? t.dim)
          : div().size(7).mx(2).flex_none().rounded(4).bg(color);
    return h_flex().id(`rq-${r.iid}-ag-${a.address}`).gap(6).items_center().px(4).py(2).rounded(4)
      .text_size(11).bg(a.status === "blocked" ? t.blocked + "1f" : t.raised)
      .hover((s) => s.bg(t.hover))
      .tooltip(a.pane ? "Go to agent" : "Peek at sub-agent")
      .on_click((_e, cx) => {
        cx.stop_propagation();
        a.pane ? run("pane.focus", { pane: a.pane }) : run("terminal.peek", { terminal: a.address });
      })
      .when(Boolean(pic), (e) => e.child(pic))
      .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(a.name ?? a.address))
      .child(mark)
      .child(div().flex_none().text_color(!waiting && a.status === "idle" ? t.muted : color)
        .child(waiting ? "CI" : STATUS[a.status] ?? a.status ?? ""));
  }

  render(_cx) {
    this.drawn = Date.now();
    const t = theme(), p = props() ?? {};
    const project = projectOf(p);
    const { terms, repo } = project;
    const usable = Boolean(project.provider && repo);

    const header = this.chrome.header(t, {
      title: `Open ${terms.request}s`, count: usable ? this.requests.length : null, sub: repo,
      at: this.at ? this.at * 1000 : null, loading: this.loading,
      onRefresh: usable ? (cx) => this.refresh(cx, 0, true) : null,
    });
    if (this.chrome.collapsed()) return v_flex().id("requests").size_full().min_h(0).bg(t.background).child(header);

    let body;
    if (!project.provider) {
      body = note(t, `${project.host} isn't a forge this panel supports yet (GitLab, GitHub).`);
    } else if (!repo) {
      body = note(t, "No repo set (props.repo).");
    } else if (!this.requests.length) {
      body = this.error ? note(t, this.error, { error: true })
        : note(t, this.loading ? "Loading…" : `No open ${terms.requests.toLowerCase()}.`);
    } else {
      // Only the hovered row shows buttons, so only it needs the actions worked out.
      const hov = this.hovered != null ? this.requests.find((r) => r.iid === this.hovered) : null;
      let hovActions = [];
      if (hov && !this.busy[hov.iid] && this.confirming?.iid !== hov.iid) {
        const item = itemOf(hov, project);
        hovActions = actionList(p.actions, defaultActions(terms), shared(`${MOD}.actions`)).filter((a) => matches(a.when, item));
      }
      // Agents per request (forge.requestAgents), with live status: the maps once per render.
      const byUrl = shared("forge.requestAgents");
      let byAgent = null, byTerminal = null;
      const agentsOf = (url) => {
        const list = byUrl?.[url];
        if (!list?.length) return [];
        byAgent ??= new Map(agents().map((a) => [a.address, a]));
        byTerminal ??= new Map(terminals().map((k) => [k.address, k]));
        return liveAgents(list, byAgent, byTerminal);
      };
      // tone "danger" draws red (Fix conflicts), primary the solid button color.
      const toneOf = (a) => a?.tone === "danger" ? "danger" : a?.primary ? "primary" : null;
      // The confirming action, looked up again (the list may have changed since).
      const actionById = (id) => actionList(p.actions, defaultActions(terms), shared(`${MOD}.actions`)).find((a) => a.id === id);
      const confirmRow = (r) => {
        const c = this.confirming;
        const a = c.id === "merge" ? null : actionById(c.id);
        const question = c.id === "merge" ? `Merge into ${r.target ?? "target"}?` : fill(a?.confirm ?? "", itemOf(r, project));
        return h_flex().gap(6).items_center().text_size(11.5)
          .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(question))
          .child(button(t, `cancel-${r.iid}`, "Cancel", (cx) => { this.confirming = null; cx.notify(); }))
          .child(button(t, `yes-${r.iid}`, c.id === "merge" ? "Merge" : a ? actionLabel(a) : "OK", (cx) => {
            if (c.id === "merge") this.merge(r, cx);
            else if (a) this.act(a, r, cx);
            else { this.confirming = null; cx.notify(); }
          }, { tone: toneOf(a) ?? "primary" }));
      };

      body = v_flex().id("rq-list").flex_1().min_h(0).overflow_y_scrollbar().p(6).gap(2)
        .when(Boolean(this.error), (e) => e.child(staleError(t, this.error)))
        .children(this.requests.map((r) => {
          const busy = this.busy[r.iid];
          const shown = hov === r ? hovActions : [];
          const mergeable = hov === r && !busy && this.confirming?.iid !== r.iid && !r.draft && !r.conflicts;
          return v_flex().id(`rq-${r.iid}`).px(8).py(6).gap(3).rounded(6).cursor_pointer()
            .hover((s) => s.bg(t.hover))
            .on_hover((on, cx) => {
              if (on) this.hovered = r.iid; else if (this.hovered === r.iid) this.hovered = null;
              cx.notify();
            })
            .on_click(() => openUrl(exec, r.url))
            .child(h_flex().gap(6).items_center()
              .child(div().flex_none().text_size(11).text_color(t.dim).child(`${terms.reqPrefix}${r.iid}`))
              .when(Boolean(r.draft), (e) => e.child(chip(t, "Draft")))
              .when(Boolean(r.auto_merge), (e) => e.child(chip(t, "Auto-merge", t.accent)))
              .child(div().flex_1().min_w(0).truncate().text_size(13).child(r.title ?? ""))
              .when(Boolean(r.conflicts), (e) => e.child(div().id(`conflict-${r.iid}`).flex_none().px(2).text_size(12).text_color(t.ansi1)
                .tooltip(`Merge conflicts with ${r.target ?? "target"}`).child("⚠")))
              .when(Boolean(r.ci && CI[r.ci.status]), (e) => e.child(this.ciBadge(t, r, terms)))
              .when(Boolean(busy), (e) => e.child(div().flex_none().text_size(11).text_color(t.muted).child(busy)))
              .children(shown.map((a) => button(t, `act-${r.iid}-${a.id}`, actionLabel(a), (cx) => {
                if (a.confirm) this.confirming = { iid: r.iid, id: a.id }; else { this.act(a, r, cx); return; }
                cx.notify();
              }, { tone: toneOf(a), tooltip: describe(a) })))
              .when(mergeable, (e) => e.child(button(t, `merge-${r.iid}`, "Merge", (cx) => {
                this.confirming = { iid: r.iid, id: "merge" };
                cx.notify();
              }, { tone: "primary", tooltip: mergeTip(r, terms) }))))
            .when(this.confirming?.iid === r.iid, (e) => e.child(confirmRow(r)))
            .when(this.notice?.iid === r.iid, (e) => e.child(div().text_size(11)
              .text_color(this.notice.error ? t.ansi1 : t.muted).child(this.notice.text)))
            .child(h_flex().gap(6).items_center().text_size(11).text_color(t.muted)
              .child(div().flex_none().child(r.author ?? ""))
              .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(r.source ?? ""))
              .children((r.labels ?? []).slice(0, 3).map((l) => pill(t, l)))
              .child(div().flex_none().text_size(10).text_color(t.dim).child(ago(r.updated_ms))))
            .children(agentsOf(r.url).map((a) => this.agentRow(t, r, a)));
        }));
    }

    return v_flex().id("requests").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .child(header).child(body);
  }
}
