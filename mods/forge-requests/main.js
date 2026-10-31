import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import {
  exec, readTextFile, appHome, props, theme, shared, agents, terminals, run, spaces, panes, layout,
  knownAgents, openOverlay,
} from "herdr";
import { forgeClient, projectOf, isShown, requestItem, actionList, matches, runAction, describe, fill, ago, openUrl } from "./lib.js";
import { CI, defaultActions, checkoutOf, liveAgents } from "./requests.js";

// Open merge requests (GitLab) / pull requests (GitHub) for one project, through forge.py.
// props: { repo, on?, provider?, host?, folder?, actions? } (docs/contract.md, docs/actions.md)
// forge.py runs on `on` (where glab is logged in); links open in this computer's browser.

const MOD = "forge-requests";
const POLL = 60; // seconds
const SPINNER = `mods/${MOD}/spinner.svg`;
const CLOCK = `mods/${MOD}/clock.svg`;
const STATUS = { working: "Working", blocked: "Needs you", done: "Done", idle: "Idle" };

export default class ForgeRequests extends View {
  init(_props, cx) {
    this.forge = forgeClient({ exec, readTextFile }, `${appHome()}/mods/${MOD}/forge.py`);
    this.requests = [];
    this.at = 0;            // when forge.py fetched them (epoch s)
    this.error = null;
    this.loading = false;
    this.again = null;      // a refresh asked for while one ran: { maxAge, force }
    this.hovered = null;    // iid under the pointer
    this.confirming = null; // { iid, id }: "merge" or an action id waiting for its confirm
    this.busy = {};         // iid -> "Merging…" / "Starting…" while something runs on it
    this.notice = null;     // { iid, text, error } from the last merge or action
    this.refresh(cx, -1, false); // whatever is cached, however old: draw at once
    cx.timer.every(POLL * 1000, (cx) => {
      if (isShown(layout(), MOD, { repo: props()?.repo }, { panes: panes(), spaces: spaces() })) this.refresh(cx, POLL, false);
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
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const out = await this.forge(["requests", provider, host, repo, maxAge, force ? 1 : 0], { on });
        // With an error the requests are the last good ones: show both.
        if (Array.isArray(out?.requests)) this.requests = out.requests;
        this.at = out?.at ?? this.at;
        this.error = out?.error ?? null;
      } catch (e) {
        this.error = String(e?.message ?? e);
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
        this.notice = { iid: r.iid, text: String(e?.message ?? e), error: true };
      } finally {
        this.done(r.iid);
        cx.notify();
        this.refresh(cx, 0, false); // merge dropped the cached list
      }
    });
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
        const res = await runAction(a, requestItem(r, project), { on: project.on, folder },
          { exec, run, spaces, knownAgents, openOverlay });
        if (res?.text) this.notice = { iid: r.iid, text: res.text, error: false };
      } catch (e) {
        this.notice = { iid: r.iid, text: String(e?.message ?? e), error: true };
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

  render(cx) {
    const t = theme(), p = props() ?? {};
    const project = projectOf(p);
    const { terms, repo } = project;

    const header = h_flex().h(34).px(12).gap(8).items_center().border_b(1).border_color(t.border)
      .child(div().font_semibold().child(`Open ${terms.request}s`))
      .child(div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted)
        .child(String(this.requests.length)))
      .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(repo))
      .when(Boolean(project.provider && repo), (e) => e.child(div().id("rq-refresh").px(6).py(2).rounded(4)
        .text_size(11).cursor_pointer().text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
        .tooltip(this.at ? `Updated ${ago(this.at * 1000)} ago · refresh` : "Refresh")
        .on_click((_e, cx) => this.refresh(cx, 0, true))
        .child(this.loading ? "Loading…" : "↻")));

    // Small row button; stops the click so the row doesn't also open the request.
    const button = (id, label, primary, onClick) =>
      div().id(id).flex_none().px(6).py(1).rounded(4).bg(primary ? t.solid : t.raised).text_size(11)
        .text_color(primary ? t.solid_foreground : t.foreground).cursor_pointer()
        .hover((s) => s.opacity(0.85))
        .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); })
        .child(label);

    let body;
    if (!project.provider) {
      body = div().p(12).text_color(t.muted).child(`${project.host} isn't a forge this panel supports yet (GitLab, GitHub).`);
    } else if (!repo) {
      body = div().p(12).text_color(t.muted).child("No repo set (props.repo).");
    } else if (!this.requests.length) {
      body = this.error
        ? div().p(12).text_size(12).text_color(t.ansi1).child(this.error)
        : div().p(12).text_color(t.muted).child(this.loading ? "Loading…" : `No open ${terms.requests.toLowerCase()}.`);
    } else {
      // Only the hovered row shows buttons, so only it needs the actions worked out.
      const hov = this.hovered != null ? this.requests.find((r) => r.iid === this.hovered) : null;
      let hovActions = [];
      if (hov && !this.busy[hov.iid] && this.confirming?.iid !== hov.iid) {
        const item = requestItem(hov, project);
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
      // The confirming action, looked up again (the list may have changed since).
      const actionById = (id) => actionList(p.actions, defaultActions(terms), shared(`${MOD}.actions`)).find((a) => a.id === id);
      const confirmRow = (r) => {
        const c = this.confirming;
        const a = c.id === "merge" ? null : actionById(c.id);
        const question = c.id === "merge" ? `Merge into ${r.target ?? "target"}?` : fill(a?.confirm ?? "", requestItem(r, project));
        return h_flex().gap(6).items_center().text_size(11)
          .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(question))
          .child(button(`cancel-${r.iid}`, "Cancel", false, (cx) => { this.confirming = null; cx.notify(); }))
          .child(button(`yes-${r.iid}`, c.id === "merge" ? "Merge" : a?.label ?? "OK", true, (cx) => {
            if (c.id === "merge") this.merge(r, cx);
            else if (a) this.act(a, r, cx);
            else { this.confirming = null; cx.notify(); }
          }));
      };

      body = v_flex().id("rq-list").flex_1().min_h(0).overflow_y_scrollbar().p(6).gap(2)
        .when(Boolean(this.error), (e) => e.child(div().px(8).py(2).text_size(11).text_color(t.ansi1).truncate()
          .child(this.error)))
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
              .child(div().text_size(11).text_color(t.dim).child(`${terms.reqPrefix}${r.iid}`))
              .when(Boolean(r.draft), (e) => e.child(div().px(4).rounded(3).bg(t.raised).text_size(10).text_color(t.muted).child("Draft")))
              .when(Boolean(r.auto_merge), (e) => e.child(div().px(4).rounded(3).bg(t.raised).text_size(10).text_color(t.accent).child("Auto-merge")))
              .child(div().flex_1().min_w(0).truncate().text_size(13).child(r.title ?? ""))
              .when(Boolean(r.conflicts), (e) => e.child(div().id(`conflict-${r.iid}`).flex_none().px(2).text_size(12).text_color(t.ansi1)
                .tooltip(`Merge conflicts with ${r.target ?? "target"}`).child("⚠")))
              .when(Boolean(r.ci && CI[r.ci.status]), (e) => e.child(this.ciBadge(t, r, terms)))
              .when(Boolean(busy), (e) => e.child(div().flex_none().text_size(11).text_color(t.muted).child(busy)))
              .children(shown.map((a) => button(`act-${r.iid}-${a.id}`, a.label, Boolean(a.primary), (cx) => {
                if (a.confirm) this.confirming = { iid: r.iid, id: a.id }; else { this.act(a, r, cx); return; }
                cx.notify();
              }).tooltip(describe(a))))
              .when(mergeable, (e) => e.child(button(`merge-${r.iid}`, "Merge", true, (cx) => {
                this.confirming = { iid: r.iid, id: "merge" };
                cx.notify();
              }))))
            .when(this.confirming?.iid === r.iid, (e) => e.child(confirmRow(r)))
            .when(this.notice?.iid === r.iid, (e) => e.child(div().text_size(11)
              .text_color(this.notice.error ? t.ansi1 : t.muted).child(this.notice.text)))
            .child(h_flex().gap(8).items_center().text_size(11).text_color(t.muted)
              .child(div().child(r.author ?? ""))
              .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(r.source ?? ""))
              .children((r.labels ?? []).slice(0, 3).map((l) => div().px(4).rounded(3).border_1().border_color(t.border).text_size(10).child(l)))
              .child(div().text_color(t.dim).child(ago(r.updated_ms))))
            .children(agentsOf(r.url).map((a) => this.agentRow(t, r, a)));
        }));
    }

    return v_flex().id("requests").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .child(header).child(body);
  }
}
