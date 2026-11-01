import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import {
  exec, readTextFile, appHome, props, theme, shared, agents, terminals, panes, run, spaces, knownAgents, openOverlay, notify,
} from "herdr";
import { CI, forgeClient, projectOf, actionList, matches, runAction, describe, actionLabel, fill, ago, agoAt, openUrl } from "./lib.js";
import { Chrome, button, chip, note, pill, staleError } from "./ui.js";
import { liveAgents, ownersOf, withShared, askTarget, placesOf, lookState, claimLooks, lookAt } from "./agents.js";
import {
  shownMerged, deployState, cleanupLines, notDoneWhy, leftoversOf, emptyPlan,
  worktreeState, worktreesDue, listWorktrees, checkState, seedChecks, claimChecks, checkDeploys as runChecks,
  planCleanup, runCleanup,
} from "./cleanup.js";
import {
  defaultActions, mergeTip, mergeBlocked, checkoutOf, itemOf, askText,
  orderFacts, migrationPattern, clashText,
} from "./requests.js";

// Open merge requests (GitLab) / pull requests (GitHub) for one project, through forge.py,
// then the ones merged lately: did they deploy, and Clean up their agents and worktrees.
// Each open one also shows where it stands against the others: behind its target, the
// same files as another, a migration number someone else took, and who should merge first.
// props: { repo, on?, provider?, host?, folder?, actions?, deploy?, migrations? } (docs/contract.md, docs/actions.md)
// forge.py runs on `on` (where glab or gh is logged in); links open in this computer's browser.

const MOD = "forge-requests";
const POLL = 60; // seconds
const SPINNER = `mods/${MOD}/spinner.svg`;
const CLOCK = `mods/${MOD}/clock.svg`;
const STATUS = { working: "Working", blocked: "Needs you", done: "Done", idle: "Idle" };

const message = (e) => String(e?.message ?? e);

const ORDER_EVERY = 300;             // seconds: how far behind and changed files, per open request
// Herdr's functions the shared agent and cleanup flows use (agents.js, cleanup.js).
const H = { exec, agents, panes, terminals };

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
    this.look = lookState();  // git: place key -> { branch, remote, head, top, linked, at }
    this.merged = [];         // merged lately (forge.py `merged`), newest first
    this.mergedError = null;
    this.checks = checkState(); // checks: merge sha -> { state: "yes"|"no"|"error", text, at } from props.deploy
    this.shownMerged = [];    // the merged rows on screen, from the last render
    this.worktrees = worktreeState(); // the checkout's linked worktrees (parseWorktrees)
    this.order = null;        // forge.py `order`: { requests: {iid: {...}}, targets }
    this.facts = new Map();   // orderFacts from the last render
    this.refresh(cx, -1, false); // whatever is cached, however old: draw at once
    // Only while on screen and not collapsed; showing it again asks at once if it's due.
    cx.timer.every(1000, (cx) => {
      if (!this.chrome.visible()) return;
      if (Date.now() - this.asked >= POLL * 1000) this.refresh(cx, POLL, false);
      else if (Date.now() - this.drawn >= 30000) cx.notify(); // keep the ages moving
      this.lookAtAgents(cx);
      this.lookAtWorktrees(cx);
      this.checkDeploys(cx);
    });
  }

  // Where the agents are, from Herdr (cheap; read again on every render).
  places() {
    return placesOf(H);
  }

  // Asks git about agent folders it hasn't seen, or not lately (agents.js lookAt).
  lookAtAgents(cx) {
    if (!this.requests.length && !this.merged.length) return;
    const due = claimLooks(this.look, H);
    if (!due.length) return;
    cx.spawn(async (cx) => {
      await lookAt(due, this.look, H);
      cx.notify();
    });
  }

  // Lists the checkout's worktrees, so a merged request whose worker already exited still
  // gets Clean up for the worktree it left. One git call on the forge machine, every couple
  // of minutes while merged requests are listed.
  lookAtWorktrees(cx) {
    if (!worktreesDue(this.worktrees, this.merged)) return;
    const p = props() ?? {};
    const project = projectOf(p);
    const folder = checkoutOf(p.folder, spaces(), project.on, project.repo);
    cx.spawn(async (cx) => {
      await listWorktrees(this.worktrees, { folder, on: project.on }, H);
      cx.notify();
    });
  }

  // Types into the agent that owns a request (hc send: as if you typed it and pressed Enter).
  ask(target, kind, r, cx) {
    const { terms } = projectOf(props() ?? {});
    this.confirming = null;
    this.busy = { ...this.busy, [r.iid]: "Asking…" };
    this.notice = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const out = await exec("hc", ["send", target.address, askText(kind, r, terms, this.clashOf(r))]);
        if (out?.code) throw new Error((out.stderr || out.stdout || `hc send failed (${out.code})`).trim());
        this.notice = { iid: r.iid, text: `Asked ${target.name}`, error: false };
      } catch (e) {
        this.notice = { iid: r.iid, text: message(e), error: true };
      } finally {
        this.toast(r, this.notice.error ? "Couldn't ask the agent" : "Asked the agent", this.notice);
        this.done(r.iid);
        cx.notify();
      }
    });
  }

  // Runs the project's deploy check (props.deploy.check) for merged requests on screen whose
  // CI is through: one at a time, in the checkout, with the merge commit as $1 (cleanup.js).
  checkDeploys(cx) {
    const p = props() ?? {};
    const due = claimChecks(this.shownMerged, p.deploy, this.checks);
    if (!due.length) return;
    const project = projectOf(p);
    const folder = checkoutOf(p.folder, spaces(), project.on, project.repo);
    cx.spawn(async (cx) => {
      await runChecks(due, { project, deploy: p.deploy, folder, cs: this.checks }, { exec, forge: this.forge, notify }, () => cx.notify());
    });
  }

  // Clean up, step one: look at the owners' folders again (HEAD may have moved since the
  // last look), then show exactly what will go.
  prepareCleanup(m, owners, cx) {
    this.busy = { ...this.busy, [m.iid]: "Checking…" };
    this.notice = null;
    cx.notify();
    cx.spawn(async (cx) => {
      const p = props() ?? {};
      const project = projectOf(p);
      const folder = checkoutOf(p.folder, spaces(), project.on, project.repo);
      const plan = await planCleanup(m, owners, { project, folder, look: this.look, worktrees: this.worktrees,
        listed: shared("forge.requestAgents")?.[m.url] }, H);
      this.done(m.iid);
      if (plan.blocked) this.notice = { iid: m.iid, text: `Not yet: ${plan.blocked}.`, error: true };
      else if (emptyPlan(plan)) this.notice = { iid: m.iid, text: "Nothing left to clean up.", error: false };
      else this.confirming = { iid: m.iid, id: "cleanup", plan };
      cx.notify();
    });
  }

  // Clean up, step two: close the tabs, end the agents, then remove each worktree and its
  // branch (CLEAN_WORKTREE checks again and refuses anything that wasn't merged).
  cleanup(m, plan, cx) {
    this.confirming = null;
    this.busy = { ...this.busy, [m.iid]: "Cleaning up…" };
    this.notice = null;
    cx.notify();
    cx.spawn(async (cx) => {
      const { said, failed } = await runCleanup(m, plan, { look: this.look, worktrees: this.worktrees },
        { exec, run, sleep: (ms) => cx.sleep(ms) });
      const text = [...said, ...failed].join("; ") || "Done";
      this.notice = { iid: m.iid, text: text[0].toUpperCase() + text.slice(1), error: failed.length > 0 };
      this.toast(m, failed.length ? "Clean up incomplete" : "Cleaned up", this.notice);
      this.done(m.iid);
      cx.notify();
    });
  }

  // Where r stands against the others, as small chips under its row: behind its target,
  // taken migration numbers, the same files as another request, and who merges first.
  // null when there's nothing to say.
  orderChips(t, r, terms) {
    const f = this.facts.get(r.iid);
    if (!f) return null;
    const ref = (iid) => `${terms.reqPrefix}${iid}`;
    const out = [];
    const tag = (id, text, color, tip) => out.push(div().id(`ord-${r.iid}-${id}`).flex_none().px(5).rounded(4)
      .border_1().border_color(t.border).text_size(10.5).text_color(color).tooltip(tip).child(text));
    if (f.next) tag("next", "merge first", t.accent,
      `It touches the same things as ${[...new Set([...f.overlaps.map((o) => o.iid), ...f.clashes.map((c) => c.by)].filter((x) => x !== "target"))].map(ref).join(", ")}, and it's the readiest of them: merge it first, then rebase the others.`);
    if (f.after != null) tag("after", `after ${ref(f.after)}`, t.muted, `Merge ${ref(f.after)} first: it's readier, and this one shares files or a migration number with it.`);
    if (f.behind > 0) tag("behind", `${f.behind} behind`, f.rebase ? t.ansi3 ?? t.working : t.dim,
      f.rebase ? `${f.behind} commit${f.behind === 1 ? "" : "s"} behind ${r.target ?? "the target"}: it has to be rebased before it can merge.`
        : `${f.behind} commit${f.behind === 1 ? "" : "s"} behind ${r.target ?? "the target"}. That doesn't block merging here.`);
    for (const v of [...new Set(f.clashes.map((c) => c.version))]) {
      const by = f.clashes.filter((c) => c.version === v).map((c) => (c.by === "target" ? r.target ?? "the target" : ref(c.by)));
      tag(`v${v}`, `V${v} taken`, t.ansi1, `Its migration number ${v} is also used by ${by.join(" and ")}. Renumber it when rebasing.`);
    }
    if (f.overlaps.length) {
      const files = [...new Set(f.overlaps.flatMap((o) => o.files))];
      tag("overlap", f.overlaps.length === 1 ? `overlaps ${ref(f.overlaps[0].iid)}` : `overlaps ${f.overlaps.length}`, t.muted,
        `Same files as ${f.overlaps.map((o) => ref(o.iid)).join(", ")}: ${files.slice(0, 6).join(", ")}${files.length > 6 ? ` and ${files.length - 6} more` : ""}`);
    }
    return out.length ? h_flex().gap(4).items_center().flex_wrap().children(out) : null;
  }

  // What a rebase of r must also do about clashing migrations ("" when nothing).
  clashOf(r) {
    return clashText(this.facts.get(r.iid)?.clashes ?? [], projectOf(props() ?? {}).terms);
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
      }
      cx.notify();
      try {
        const out = await this.forge(["merged", provider, host, repo, maxAge, force ? 1 : 0], { on });
        if (Array.isArray(out?.merged)) {
          this.merged = out.merged;
          // Confirmed before (by this window or another): final, no need to check again.
          seedChecks(this.merged, this.checks);
        }
        this.mergedError = out?.error ?? null;
      } catch (e) {
        this.mergedError = message(e);
      }
      cx.notify();
      // Less often than the list: one call per open request. Errors keep the last answer
      // quietly; the chips are hints, the list above still says what's wrong.
      try {
        const age = maxAge < 0 ? -1 : Math.max(maxAge, ORDER_EVERY);
        const pattern = migrationPattern((props() ?? {}).migrations) ?? "";
        const out = await this.forge(["order", provider, host, repo, age, force ? 1 : 0, pattern], { on });
        if (out?.requests) this.order = out;
      } catch {
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
  // The button hides while CI runs; if it started since the list loaded, the forge sets auto-merge.
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
        const res = await runAction(a, itemOf(r, project, this.facts.get(r.iid)), { on: project.on, folder },
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
    const when = ci.updated_ms ? `, ${agoAt(ci.updated_ms)}` : "";
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

  // "Merged lately" folded, per project, remembered across restarts. Deploy checks keep
  // running while it's folded, so the "Deployed" toast still comes.
  mergedFolded(repo) {
    this.folded ??= (() => { try { return JSON.parse(localStorage.getItem("mergedFolded") ?? "{}"); } catch { return {}; } })();
    return Boolean(this.folded[repo]);
  }

  foldMerged(repo, on) {
    this.mergedFolded(repo);
    if (on) this.folded[repo] = true; else delete this.folded[repo];
    try { localStorage.setItem("mergedFolded", JSON.stringify(this.folded)); } catch {}
  }

  // Where the merge commit's deploy is: the project's check (props.deploy), as a chip.
  deployChip(t, m, deploy, st) {
    const label = deploy.label ?? "Deploy";
    const looks = {
      waiting: ["○", t.dim, "Waits for CI to pass"],
      blocked: ["–", t.dim, "CI failed on the merge commit, so it won't deploy"],
      checking: [null, t.working, "Checking…"],
      no: [CLOCK, t.working, "Not deployed yet"],
      yes: ["✓", t.ansi2, "Deployed"],
      error: ["?", t.ansi1, "The deploy check failed"],
    };
    const [mark, color, what] = looks[st.deploy] ?? looks.waiting;
    const icon = mark === null ? svg(SPINNER).size(10).text_color(color).spin(900)
      : mark === CLOCK ? svg(CLOCK).size(10).text_color(color) : div().child(mark);
    return h_flex().id(`dep-${m.iid}`).flex_none().gap(3).items_center().px(2).text_size(11).text_color(color)
      .tooltip(`${label}: ${what}${st.text ? ` · ${st.text}` : ""}`)
      .child(icon).child(div().child(label));
  }

  // A merged request: its CI and deploy, the agents still on it, and Clean up (on hover,
  // like the open rows' buttons): the solid button once it's deployed, else a plain one
  // whose confirm says what isn't done (a merge that never reached CI shouldn't strand its agent).
  mergedRow(t, m, p, terms, now, owners, agentList, leftovers) {
    const st = deployState(m, p.deploy, this.checks.checks, now);
    const busy = this.busy[m.iid];
    const hov = this.hovered === m.iid && !busy && this.confirming?.iid !== m.iid;
    const canClean = hov && (owners.length > 0 || leftovers.length > 0);
    const ci = m.ci && CI[m.ci.status] ? m : null;
    return v_flex().id(`mg-${m.iid}`).px(8).py(5).gap(3).rounded(6).cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_hover((on, cx) => {
        if (on) this.hovered = m.iid; else if (this.hovered === m.iid) this.hovered = null;
        cx.notify();
      })
      .on_click(() => openUrl(exec, m.url))
      .child(h_flex().gap(6).items_center()
        .child(div().flex_none().text_size(11).text_color(t.dim).child(`${terms.reqPrefix}${m.iid}`))
        .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(t.muted).child(m.title ?? ""))
        .when(Boolean(ci), (e) => e.child(this.ciBadge(t, ci, terms)))
        .when(!ci && st.ci === "none", (e) => e.child(div().id(`noci-${m.iid}`).flex_none().text_size(11).text_color(t.dim)
          .tooltip(`No ${terms.ciRun} ran on the merge commit`).child("no CI")))
        .when(Boolean(p.deploy?.check), (e) => e.child(this.deployChip(t, m, p.deploy, st)))
        .when(!owners.length && leftovers.length > 0 && !busy && !canClean, (e) => e.child(div().id(`left-${m.iid}`).flex_none()
          .text_size(11).text_color(t.dim).tooltip(`Its worktree is still there: ${leftovers.map((w) => w.top).join(", ")}`)
          .child(leftovers.length > 1 ? `${leftovers.length} worktrees` : "worktree")))
        .when(Boolean(busy), (e) => e.child(div().flex_none().text_size(11).text_color(t.muted).child(busy)))
        .when(canClean, (e) => e.child(button(t, `clean-${m.iid}`, "Clean up", (cx) => this.prepareCleanup(m, owners, cx), {
          tone: st.done ? "primary" : null,
          tooltip: `${st.done ? "" : `Not deployed yet: ${notDoneWhy(st, p.deploy, terms)}. `}Ends the agents still on this branch and removes its worktrees and local branch, including ones a finished agent left behind. Shows exactly what goes first; never touches uncommitted or unmerged work.`,
        }))))
      .when(this.confirming?.iid === m.iid && this.confirming.id === "cleanup", (e) => e.child(v_flex().gap(4).text_size(11.5)
        .children(cleanupLines(this.confirming.plan, notDoneWhy(st, p.deploy, terms)).map((l) => div()
          .text_color(l.startsWith("Not deployed") ? t.ansi3 ?? t.working : l.startsWith("Keep ") ? t.muted : t.foreground).child(l)))
        .child(h_flex().gap(6).justify_end()
          .child(button(t, `cancel-${m.iid}`, "Cancel", (cx) => { this.confirming = null; cx.notify(); }))
          .child(button(t, `yes-${m.iid}`, "Clean up", (cx) => this.cleanup(m, this.confirming.plan, cx), { tone: "danger" })))))
      .when(this.notice?.iid === m.iid, (e) => e.child(div().text_size(11)
        .text_color(this.notice.error ? t.ansi1 : t.muted).child(this.notice.text)))
      .child(h_flex().gap(6).items_center().text_size(11).text_color(t.muted)
        .child(div().flex_none().child(m.author ?? ""))
        .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(m.source ?? ""))
        .child(div().id(`mgd-${m.iid}`).flex_none().text_size(10).text_color(t.dim)
          .tooltip(`Merged ${agoAt(m.merged_ms)}`).child(`merged ${ago(m.merged_ms)}`)))
      .children(agentList.map((a) => this.agentRow(t, m, a)));
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
    } else if (!this.requests.length && !this.merged.length) {
      body = this.error ? note(t, this.error, { error: true })
        : note(t, this.loading ? "Loading…" : `No open ${terms.requests.toLowerCase()}.`);
    } else {
      // Where each request stands against the others (cheap: a few small lists).
      this.facts = orderFacts(this.requests, this.order, migrationPattern(p.migrations));
      // Only the hovered row shows buttons, so only it needs the actions worked out.
      const hov = this.hovered != null ? this.requests.find((r) => r.iid === this.hovered) : null;
      // Agents already working on each request: on its branch, in a checkout of this project.
      const places = this.places();
      const ownersCache = new Map();
      const ownersOfReq = (r) => {
        if (!ownersCache.has(r.iid)) ownersCache.set(r.iid, ownersOf(r, places, this.look.git, project));
        return ownersCache.get(r.iid);
      };
      let hovActions = [], hovAsk = null;
      if (hov && !this.busy[hov.iid] && this.confirming?.iid !== hov.iid) {
        const item = itemOf(hov, project, this.facts.get(hov.iid));
        hovActions = actionList(p.actions, defaultActions(terms), shared(`${MOD}.actions`)).filter((a) => matches(a.when, item));
        // An agent owns it: ask that agent instead of starting another one. Not while it
        // shows a prompt: typed text would answer the prompt.
        const target = askTarget(ownersOfReq(hov), places);
        if (target) {
          hovActions = hovActions.filter((a) => a.id !== "ship" && a.id !== "resolve" && a.id !== "rebase");
          if (target.status !== "blocked") hovAsk = { target, kind: hov.conflicts ? "conflicts" : item.needs_rebase ? "rebase" : "merge" };
        }
      }
      // Agents per request (forge.requestAgents), with live status: the maps once per render.
      const byUrl = shared("forge.requestAgents");
      let byAgent = null, byTerminal = null;
      const agentsOf = (r) => {
        const list = byUrl?.[r.url];
        let out = [];
        if (list?.length) {
          byAgent ??= new Map(agents().map((a) => [a.address, a]));
          byTerminal ??= new Map(terminals().map((k) => [k.address, k]));
          out = liveAgents(list, byAgent, byTerminal);
        }
        // Plus the ones found here (another mod may publish some of the same).
        const have = new Set(out.map((a) => a.address));
        for (const o of ownersOfReq(r)) {
          if (!have.has(o.address)) out.push({ address: o.address, name: o.name, pane: o.pane, program: o.program, status: o.status });
        }
        return out;
      };
      // tone "danger" draws red (Fix conflicts), primary the solid button color.
      const toneOf = (a) => a?.tone === "danger" ? "danger" : a?.primary ? "primary" : null;
      // The confirming action, looked up again (the list may have changed since).
      const actionById = (id) => actionList(p.actions, defaultActions(terms), shared(`${MOD}.actions`)).find((a) => a.id === id);
      const confirmRow = (r) => {
        const c = this.confirming;
        if (c.id === "ask") {
          // Says exactly what will be typed into which agent.
          return v_flex().gap(4).text_size(11.5)
            .child(div().text_color(t.foreground).child(`Send to ${c.target.name}:`))
            .child(div().px(6).py(4).rounded(4).bg(t.raised).text_color(t.muted).child(askText(c.kind, r, terms, this.clashOf(r))))
            .child(h_flex().gap(6).justify_end()
              .child(button(t, `cancel-${r.iid}`, "Cancel", (cx) => { this.confirming = null; cx.notify(); }))
              .child(button(t, `yes-${r.iid}`, "Send", (cx) => this.ask(c.target, c.kind, r, cx), { tone: "primary" })));
        }
        const a = c.id === "merge" ? null : actionById(c.id);
        const question = c.id === "merge" ? `Merge into ${r.target ?? "target"}?` : fill(a?.confirm ?? "", itemOf(r, project, this.facts.get(r.iid)));
        return h_flex().gap(6).items_center().text_size(11.5)
          .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(question))
          .child(button(t, `cancel-${r.iid}`, "Cancel", (cx) => { this.confirming = null; cx.notify(); }))
          .child(button(t, `yes-${r.iid}`, c.id === "merge" ? "Merge" : a ? actionLabel(a) : "OK", (cx) => {
            if (c.id === "merge") this.merge(r, cx);
            else if (a) this.act(a, r, cx);
            else { this.confirming = null; cx.notify(); }
          }, { tone: toneOf(a) ?? "primary" }));
      };

      // Merged lately: the last day's, and older ones an agent is still on.
      const now = Date.now();
      const leftoversOfReq = (m) => leftoversOf(m, this.worktrees.list);
      const cleanOwners = (m) => withShared(ownersOfReq(m), byUrl?.[m.url], places);
      const recent = shownMerged(this.merged, cleanOwners, now, leftoversOfReq);
      this.shownMerged = recent;

      body = v_flex().id("rq-list").flex_1().min_h(0).overflow_y_scrollbar().p(6).gap(2)
        .when(Boolean(this.error), (e) => e.child(staleError(t, this.error)))
        .when(!this.requests.length, (e) => e.child(div().px(8).py(6).text_size(12).text_color(t.muted)
          .child(`No open ${terms.requests.toLowerCase()}.`)))
        .children(this.requests.map((r) => {
          const busy = this.busy[r.iid];
          const chips = this.orderChips(t, r, terms);
          const shown = hov === r ? hovActions : [];
          const mergeable = hov === r && !busy && this.confirming?.iid !== r.iid && !r.draft && !r.conflicts
            && !mergeBlocked(r, agentsOf(r));
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
              .when(hov === r && Boolean(hovAsk), (e) => e.child(button(t, `ask-${r.iid}`,
                hovAsk.kind === "conflicts" ? "✦ Ask to fix conflicts" : hovAsk.kind === "rebase" ? "✦ Ask to rebase" : "✦ Ask to merge", (cx) => {
                  this.confirming = { iid: r.iid, id: "ask", kind: hovAsk.kind, target: hovAsk.target };
                  cx.notify();
                }, { tone: hovAsk.kind === "conflicts" ? "danger" : null,
                  tooltip: hovAsk.kind === "conflicts"
                    ? `Asks ${hovAsk.target.name}, the agent already on this branch, to rebase and resolve the conflicts. Never merges. Shows the message first.`
                    : hovAsk.kind === "rebase"
                    ? `Asks ${hovAsk.target.name}, the agent already on this branch, to rebase it onto ${hov.target ?? "the target"}${this.facts.get(hov.iid)?.clashes.length ? " and renumber its migration" : ""}. Never merges. Shows the message first.`
                    : `Asks ${hovAsk.target.name}, the agent already on this branch, to get it ready and merge once CI passes. Shows the message first.` })))
              .when(mergeable, (e) => e.child(button(t, `merge-${r.iid}`, "Merge", (cx) => {
                this.confirming = { iid: r.iid, id: "merge" };
                cx.notify();
              }, { tone: "primary", tooltip: mergeTip(r) }))))
            .when(this.confirming?.iid === r.iid, (e) => e.child(confirmRow(r)))
            .when(this.notice?.iid === r.iid, (e) => e.child(div().text_size(11)
              .text_color(this.notice.error ? t.ansi1 : t.muted).child(this.notice.text)))
            .child(h_flex().gap(6).items_center().text_size(11).text_color(t.muted)
              .child(div().flex_none().child(r.author ?? ""))
              .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(r.source ?? ""))
              .children((r.labels ?? []).slice(0, 3).map((l) => pill(t, l)))
              .child(div().id(`upd-${r.iid}`).flex_none().text_size(10).text_color(t.dim).tooltip(`Updated ${agoAt(r.updated_ms)}`).child(ago(r.updated_ms))))
            .when(Boolean(chips), (e) => e.child(chips))
            .children(agentsOf(r).map((a) => this.agentRow(t, r, a)));
        }))
        .when(recent.length > 0 || Boolean(this.mergedError), (e) => e
          .child(h_flex().id("merged-head").gap(4).items_center().px(8).pt(10).pb(2).rounded(4).cursor_pointer()
            .text_size(11).text_color(t.dim).hover((s) => s.text_color(t.muted))
            .tooltip(this.mergedFolded(repo) ? "Show merged" : "Hide merged")
            .on_click((_e, cx) => { this.foldMerged(repo, !this.mergedFolded(repo)); cx.notify(); })
            .child(div().w(12).flex_none().text_size(9).child(this.mergedFolded(repo) ? "▸" : "▾"))
            .child(div().child("Merged lately"))
            .child(div().text_color(t.dim).child(String(recent.length))))
          .when(!this.mergedFolded(repo), (e) => e
            .when(Boolean(this.mergedError), (e) => e.child(staleError(t, this.mergedError)))
            .children(recent.map((m) => this.mergedRow(t, m, p, terms, now, cleanOwners(m), agentsOf(m), leftoversOfReq(m))))));
    }

    return v_flex().id("requests").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .child(header).child(body);
  }
}
