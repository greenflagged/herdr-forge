import { View, div, svg } from "gpui-kit";
import {
  v_flex, h_flex, InputState, Input, TextareaState, Textarea, TextView, Scrollbar, v_virtual_list, VirtualListScrollHandle,
  h_resizable, resizable_panel,
} from "gpui-base";
import {
  exec, props, theme, run, spaces, knownAgents, shared, setShared, appHome, window, readTextFile, openOverlay, notify,
} from "herdr";
import { forgeClient, projectOf, issueItem, actionList, matches, runAction, describe, actionLabel, ago, openUrl } from "./lib.js";
import { Chrome, button, chip, note, staleError, dropdown } from "./ui.js";
import {
  STATES, DEFAULT_SEP, sorts, nextSort, splitLabels, scopedChange, labelToggle, scopeValues, metaScopes,
  orderScopes, scopeTitle, facetEntries, togglePick, listQuery, triageConfig, skillLine, usesPriority, isAgentAction, scopeOf,
  startView,
} from "./issues.js";

// An issue browser, opened as a tab: tab.new { name, mod: "forge-issues", props }.
// props (docs/contract.md, docs/actions.md):
//   repo, on, provider, host, folder   the project, and where agents start
//   actions                            buttons on each issue (none by default)
//   scopes: ["priority", "type", ...]  which scoped-label facets to show, in order
//   scopeSep: "::"                     the scoped-label separator (default: the forge's)
//   triage: true | { agent, task, tab } the optional triage agent (off by default)
//   issue: 123                         open this issue at once (a link into the tab from another mod)
//   view: { state, sort, picked, q }   where the list starts, e.g. { picked: { "scope:type": ["bug"] } }
// Keys on the list: ↑/↓ or j/k move the selection, / searches, Esc clears the search,
// Enter opens the selected issue in the browser.
// forge.py keeps the issues in SQLite on `on` and does the filtering, counting and
// sorting: Herdr's JS engine is far too slow for that. This view keeps only the rows it
// has fetched and the open issue. Every edit goes to the forge first; the cache keeps
// the forge's answer.
//
// For other mods: shared("forge-issues.actions") adds buttons; this view publishes
// shared("forge-issues.selected") (the open issue) and shared("forge-issues.event")
// (each change it writes).

const MOD = "forge-issues";
const ROW = 30;
const PAGE = 150;
const POLL_FOCUSED = 60000, POLL_AWAY = 300000;
const ACCEPT_ROUNDS = 20; // accept-all answers `more` after ~18 s of work: call again
// A row as `query` sends it.
const [IID, TITLE, STATE, PRIO, TYPE, REQS, UPDATED, PROPOSED, LAUNCHED] = [0, 1, 2, 3, 4, 5, 6, 7, 8];

const msg = (e) => String(e?.message ?? e);
// A toast besides the inline notice (the toast mod may be off: never let that break a write).
const toast = (title, body, level) => { try { notify({ title, body, level }); } catch { /* no toasts */ } };
const since = (ms) => { const a = ago(ms); return a === "now" ? "just now" : `${a} ago`; };

export default class Issues extends View {
  init(_props, cx) {
    this.labels = [];            // [{ name, color, description }] (meta)
    this.milestones = [];        // active ones (meta)
    this.rows = [];              // the fetched part of the list, from the top
    this.matched = 0;            // rows in the list, fetched or not
    this.total = 0;              // before the sidebar filters
    this.counts = {};
    this.scopes = [];            // scoped-label scopes in use, most used first
    this.sepSeen = null;         // the separator forge.py answered with
    this.loadedOnce = false;
    this.loadFailed = false;     // the first list read failed: say so instead of "Loading"
    this.since = 0;              // forge.py's clock at the last sync
    this.lastSync = 0;
    this.lastPoll = 0;
    this.syncMore = false;       // the last sync ran out of time: go again soon
    this.error = null;           // a write or action that failed (click to dismiss)
    this.listError = null;
    this.syncError = null;
    this.syncing = false;
    this.syncAgain = false;      // a ↻ came during a sync: sync again after it
    this.seq = 0;                // newest list query; older answers are dropped
    this.listPending = null;     // the seq of the list load in flight
    this.paging = false;
    // props.view: where the list starts ("my open bugs"); the person changes it from there.
    const view = startView(props()?.view);
    this.state = view.state;
    this.sort = view.sort;
    this.picked = view.picked;   // group -> [values] (OR within, AND across)
    this.query = view.q;
    this.selected = null;
    this.detail = null;          // show() of the selected issue
    this.detailError = null;
    this.busy = false;           // a write in flight for the selected issue
    this.adding = false;         // the "+ label" picker is open
    this.confirming = null;      // the action whose confirm question is showing
    this.notice = null;          // an action's result
    this.published = undefined; // what forge-issues.selected was last set to (JSON)
    this.skill = null;           // `skill status` of the triage skill
    this.triageRun = null;       // the triage agent's last run (sync): triage facets wait for one
    this.picker = { open: null }; // which detail dropdown is open
    this.openAt = 0;             // a keyboard move opens its issue after a pause (ms)
    this.chrome = new Chrome(MOD, { repo: props()?.repo }, { width: 1100, height: 700 });
    this.chrome.attach(cx);
    this.keys = cx.focus_handle();
    this.scroll = VirtualListScrollHandle.new();
    this.inputFocused = false;
    const { terms } = this.project();
    this.forge = forgeClient({ exec, readTextFile }, `${appHome()}/mods/${MOD}/forge.py`);
    this.input = InputState.new({ placeholder: "Search issues (title, text, #iid)" });
    if (this.query) this.input.set_value(this.query);
    this.input.on("change", () => { this.typedAt = Date.now(); this.pendingQuery = this.input.value().trim(); });
    this.input.on("focus", (_e, cx) => { this.inputFocused = true; cx?.notify(); });
    this.input.on("blur", (_e, cx) => { this.inputFocused = false; cx?.notify(); });
    this.comment = TextareaState.new({ placeholder: `Comment (written to ${terms.name})`, rows: 3 });

    // Stale first: what SQLite has now, then a sync with the forge.
    cx.spawn(async (cx) => {
      if (!this.ready()) return;
      await Promise.all([this.readMeta(), this.loadList(++this.seq)]);
      const first = Number(props()?.issue);
      if (Number.isInteger(first) && first > 0) this.open(first, cx);
      cx.notify();
      if (this.triage()) this.checkSkill(cx, false);
      this.sync(cx, false);
    });
    // Searching waits for a pause in typing; the next page waits for the list to need it.
    cx.timer.every(150, (cx) => {
      if (this.wantMore) { this.wantMore = false; this.more(cx); }
      if (this.openAt && Date.now() >= this.openAt) { this.openAt = 0; if (this.selected) this.open(this.selected, cx); }
      if (this.pendingQuery != null && Date.now() - this.typedAt >= 200) {
        this.query = this.pendingQuery;
        this.pendingQuery = null;
        this.reload(cx);
      }
    });
    // Sync only while shown: a background tab keeps running but mustn't poll.
    cx.timer.every(5000, (cx) => {
      if (!this.shown()) return;
      const every = this.syncMore ? 0 : window().active ? POLL_FOCUSED : POLL_AWAY;
      if (Date.now() - this.lastPoll >= every) this.sync(cx, false);
    });
  }

  async close() {
    const s = shared(`${MOD}.selected`);
    const { repo, host } = this.project();
    if (s && s.repo === repo && s.host === host) setShared(`${MOD}.selected`, null);
  }

  // ---- the project and forge.py ----

  project() { return projectOf(props() ?? {}); }
  ready() { const p = this.project(); return Boolean(p.repo && p.provider); }
  triage() { return triageConfig(props()?.triage); }

  sep() {
    return props()?.scopeSep ?? this.sepSeen ?? DEFAULT_SEP[this.project().provider] ?? "::";
  }

  // On screen and not collapsed (a detached window counts).
  shown() {
    try { return this.chrome.visible(); } catch { return true; }
  }

  // A project command: [cmd, ...args] -> forge.py cmd provider host repo ...args, on `on`.
  py([cmd, ...args]) {
    const { provider, host, repo, on } = this.project();
    return this.forge([cmd, provider, host, repo, ...args], { on });
  }

  helpers() { return { exec, run, spaces, knownAgents, openOverlay }; }

  nocliText(out) {
    const { terms, on } = this.project();
    return out?.nocli ? `${terms.cli} isn't installed on ${on ?? "this computer"}` : null;
  }

  sync(cx, force) {
    if (!this.ready()) return;
    // A ↻ while a sync runs goes after it (a poll can wait for its next turn).
    if (this.syncing) { if (force) this.syncAgain = true; return; }
    this.syncing = true;
    this.lastPoll = Date.now();
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const out = await this.py(["sync", this.since, force ? 1 : 0]);
        const first = !this.since;
        this.since = out.now ?? this.since;
        this.lastSync = (out.last_sync ?? 0) * 1000;
        this.syncError = this.nocliText(out) ?? out.error ?? null;
        this.syncMore = Boolean(out.more);
        const triageMoved = (out.triage_at ?? 0) > (this.triageAt ?? 0);
        this.triageAt = out.triage_at ?? 0;
        if (out.triage_run !== undefined) this.triageRun = out.triage_run;
        if (out.changed || (!first && triageMoved)) {
          this.reload(cx);
          if (this.selected) this.open(this.selected, cx);
        }
        // sync refreshes labels and milestones now and then: read them back.
        if (force || first || out.changed) await this.readMeta();
      } catch (e) {
        this.syncError = msg(e);
        this.syncMore = false;
      } finally {
        this.syncing = false;
        cx.notify();
      }
      if (this.syncAgain) { this.syncAgain = false; this.sync(cx, true); }
    });
  }

  async readMeta() {
    try {
      const m = await this.py(["meta"]);
      if (Array.isArray(m.labels)) this.labels = m.labels;
      if (Array.isArray(m.milestones)) this.milestones = m.milestones;
      if (m.sep) this.sepSeen = m.sep;
    } catch { /* the list read shows why */ }
  }

  queryJson(offset) {
    return listQuery({ state: this.state, q: this.query, picked: this.picked, sort: this.sort, offset, limit: PAGE, sep: props()?.scopeSep });
  }

  async loadList(seq) {
    this.listPending = seq; // more() waits for it: its rows replace the list
    try {
      const out = await this.py(["query", this.queryJson(0)]);
      if (seq !== this.seq) return;
      if (!Array.isArray(out.rows)) throw new Error(this.nocliText(out) ?? out.error ?? "no answer");
      this.rows = out.rows;
      this.matched = out.matched ?? out.rows.length;
      this.total = out.total ?? this.matched;
      this.counts = out.counts ?? {};
      this.scopes = out.scopes ?? [];
      if (out.sep) this.sepSeen = out.sep;
      this.loadedOnce = true;
      this.loadFailed = false;
      this.listError = null;
    } catch (e) {
      if (seq !== this.seq) return;
      this.listError = msg(e);
      if (!this.loadedOnce) this.loadFailed = true;
    } finally {
      if (this.listPending === seq) this.listPending = null;
    }
  }

  // The list from the top, after anything that changes what's in it.
  reload(cx) {
    if (!this.ready()) return;
    const seq = ++this.seq;
    cx.spawn(async (cx) => { await this.loadList(seq); cx.notify(); });
  }

  // The next page, when the list scrolls near the end of what's fetched. Not while the
  // list itself is loading (its rows replace these), and only onto the rows it started
  // from: a reload meanwhile would put the page at the wrong offset.
  more(cx) {
    if (this.paging || this.listPending === this.seq || this.rows.length >= this.matched) return;
    this.paging = true;
    const seq = this.seq, from = this.rows, offset = from.length;
    cx.spawn(async (cx) => {
      try {
        const out = await this.py(["query", this.queryJson(offset)]);
        if (seq === this.seq && this.rows === from && Array.isArray(out.rows)) this.rows = from.concat(out.rows);
      } catch { /* the next scroll asks again */ }
      this.paging = false;
      cx.notify();
    });
  }

  open(iid, cx) {
    if (this.selected !== iid) {
      this.detail = null;
      this.adding = false;
      this.confirming = null;
      this.notice = null;
      this.picker.open = null;
    }
    this.openAt = 0;
    this.selected = iid;
    this.detailError = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const out = await this.py(["show", iid]);
        if (this.selected !== iid) return;
        if (out.issue) this.setDetail(out);
        else this.detailError = out.error ?? `#${iid} not found`;
      } catch (e) {
        if (this.selected === iid) this.detailError = msg(e);
      }
      cx.notify();
    });
  }

  // The open issue, published for other mods (only when it changes).
  setDetail(d) {
    this.detail = d;
    const item = d?.issue ? issueItem(d.issue, this.project(), this.sep()) : null;
    const key = JSON.stringify(item);
    if (key !== this.published) {
      this.published = key;
      setShared(`${MOD}.selected`, item);
    }
  }

  event(type, iid, extra = {}) {
    const { repo, host } = this.project();
    setShared(`${MOD}.event`, { type, iid, repo, host, at: Date.now(), ...extra });
  }

  // ---- writing to the forge ----

  // fields go to `update`; `local` is how the issue should look meanwhile. On failure
  // the issue goes back to how it was. One write at a time (`busy`): the detail pane
  // disables its controls meanwhile, so a rollback never undoes another write's change.
  // then(cx): runs only once the forge took the write. Returns whether it started.
  write(i, fields, local, type, cx, then = null) {
    if (this.busy) return false;
    const before = this.detail;
    this.setDetail({ ...before, issue: { ...i, ...local } });
    this.busy = true;
    this.error = null;
    this.picker.open = null;
    cx.notify();
    cx.spawn(async (cx) => {
      let ok = false;
      try {
        const out = await this.py(["update", i.iid, JSON.stringify(fields)]);
        if (out.error || !out.issue) throw new Error(out.error ?? "no answer");
        ok = true;
        if (this.selected === i.iid) this.setDetail({ ...this.detail, issue: out.issue });
        this.event(type, i.iid);
        this.reload(cx);
      } catch (e) {
        if (this.selected === i.iid) this.setDetail(before);
        this.error = `#${i.iid} not updated: ${msg(e)}`;
        toast(`#${i.iid} not updated`, msg(e), "error");
      } finally {
        this.busy = false;
        cx.notify();
      }
      if (ok && then) then(cx);
    });
    return true;
  }

  // Sets scope<sep>value (null clears it), dropping any other label of that scope.
  // then(cx) runs once the forge has it (or at once if there's nothing to change).
  setScoped(i, scope, value, cx, then = null) {
    const ch = scopedChange(i.labels, scope, value, this.sep());
    if (ch) this.write(i, ch.fields, { labels: ch.labels }, "updated", cx, then);
    else if (then && !this.busy) then(cx);
  }

  toggleLabel(i, label, cx) {
    const ch = labelToggle(i.labels, label);
    this.write(i, ch.fields, { labels: ch.labels }, "updated", cx);
  }

  setMilestone(i, m, cx) {
    this.write(i, { milestone: m ? m.id : null }, { milestone: m ? { id: m.id, title: m.title, due: m.due ?? null } : null }, "updated", cx);
  }

  setState(i, cx) {
    const closing = i.state === "opened";
    const state = closing ? "closed" : "opened";
    this.write(i, { state }, { state }, closing ? "closed" : "reopened", cx);
  }

  postComment(i, cx) {
    const body = this.comment.value().trim();
    if (!body || this.busy) return;
    this.busy = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const out = await this.py(["comment", i.iid, body]);
        if (!out.issue) throw new Error(out.error ?? "no answer");
        if (this.selected === i.iid) this.setDetail(out);
        this.comment.set_value("");
        this.event("commented", i.iid);
        this.reload(cx);
        toast(`Commented on #${i.iid}`, i.title, "success");
      } catch (e) {
        this.error = `Comment not posted: ${msg(e)}`;
        toast(`Comment on #${i.iid} not posted`, msg(e), "error");
      } finally {
        this.busy = false;
        cx.notify();
      }
    });
  }

  // ---- actions: the person's own buttons ----

  actionsFor(item) {
    return actionList(props()?.actions, [], shared(`${MOD}.actions`)).filter((a) => matches(a.when, item));
  }

  act(i, a, cx) {
    if (this.busy) return;
    if (a.confirm && this.confirming !== a.id) { this.confirming = a.id; cx.notify(); return; }
    this.confirming = null;
    this.notice = null;
    this.error = null;
    this.busy = true;
    cx.notify();
    const { on } = this.project();
    const folder = props()?.folder ?? null;
    const item = issueItem(i, this.project(), this.sep());
    cx.spawn(async (cx) => {
      try {
        const r = await runAction(a, item, { on, folder }, this.helpers());
        if (isAgentAction(a) && r.tab) {
          // Recorded so the launch row (and its tab's live status) shows on the issue.
          try { await this.py(["launch", i.iid, a.id, r.tab]); } catch { /* the row just won't show */ }
          if (this.selected === i.iid && this.detail) {
            this.detail = { ...this.detail, launches: [...(this.detail.launches ?? []), { action: a.id, tab: r.tab, at: Date.now() / 1000 }] };
          }
          this.reload(cx);
        }
        if (r.text) this.notice = r.text;
        this.event("action", i.iid, { action: a.id });
        toast(`${a.label} #${i.iid}`, r.text ?? (r.tab ? `Started in tab ${r.tab}` : "Done"), "success");
      } catch (e) {
        this.error = `${a.label} #${i.iid}: ${msg(e)}`;
        toast(`${a.label} #${i.iid} failed`, msg(e), "error");
      } finally {
        this.busy = false;
        cx.notify();
      }
    });
  }

  // The tab a launch made, if it's still open: { space, tab }.
  launchTab(name) {
    const { on } = this.project();
    for (const s of spaces()) {
      if ((s.machine ?? null) !== on) continue;
      const tab = s.tabs.find((t) => t.name === name);
      if (tab) return { space: s, tab };
    }
    return null;
  }

  goTo(where) {
    run("space.select", { id: where.space.id });
    run("tab.select", { id: where.tab.id });
  }

  // ---- triage (only with props.triage) ----

  // Accepting records "accepted" only once the forge took the priority: a failed write
  // leaves the proposal standing (write's rollback brings it back).
  answerTriage(i, accept, cx) {
    const p = this.detail?.triage;
    if (!p || this.busy) return;
    const record = (cx) => cx.spawn(async (cx) => {
      try { await this.py(["triage", i.iid, accept ? "accepted" : "dismissed"]); this.reload(cx); } catch { /* shows again next time */ }
    });
    if (accept && p.priority) this.setScoped(i, "priority", p.priority, cx, record);
    else record(cx);
    if (this.detail?.issue?.iid === i.iid) this.detail = { ...this.detail, triage: { ...p, status: accept ? "accepted" : "dismissed" } };
    cx.notify();
  }

  // A priority set by hand is locked: triage ranks the issue but won't propose another.
  setLock(i, locked, cx) {
    if (this.detail?.issue.iid === i.iid) this.detail = { ...this.detail, triage: { ...(this.detail.triage ?? {}), locked } };
    cx.notify();
    cx.spawn(async (cx) => { try { await this.py(["lock", i.iid, locked ? 1 : 0]); this.reload(cx); } catch { /* not locked */ } });
  }

  // Starts the triage agent in its own tab, or goes to the one already open.
  retriage(cx) {
    const tc = this.triage();
    if (!tc) return;
    const open = this.launchTab(tc.tab);
    if (open) { this.goTo(open); return; }
    const { provider, host, repo, on } = this.project();
    const ctx = { provider, host, repo, ref: "" };
    cx.spawn(async (cx) => {
      try {
        await runAction({ id: "triage", agent: tc.agent, task: tc.task, tab: tc.tab }, ctx, { on, folder: props()?.folder ?? null }, this.helpers());
      } catch (e) {
        this.error = `Triage: ${msg(e)}`;
      }
      cx.notify();
    });
  }

  // Writes every open proposal to the forge, one issue at a time (asks first, in the sidebar).
  acceptAll(cx) {
    this.confirmAll = false;
    this.accepting = true;
    this.triageNotice = null;
    cx.notify();
    cx.spawn(async (cx) => {
      const accepted = [], failed = [];
      try {
        for (let k = 0; k < ACCEPT_ROUNDS; k++) {
          const out = await this.py(["accept-all"]);
          if (out.error) throw new Error(out.error);
          accepted.push(...(out.accepted ?? []));
          failed.push(...(out.failed ?? []));
          if (!out.more) break;
          this.triageNotice = `Accepted ${accepted.length} so far…`;
          cx.notify();
        }
        this.triageNotice = `Accepted ${accepted.length}${failed.length ? `, ${failed.length} failed: ${failed[0].error}` : ""}`;
        toast(`Accepted ${accepted.length} triage proposal${accepted.length === 1 ? "" : "s"}`,
          failed.length ? `${failed.length} failed: ${failed[0].error}` : undefined, failed.length ? "warning" : "success");
      } catch (e) {
        this.error = `Accept all: ${msg(e)}`;
        toast("Accept all failed", msg(e), "error");
      } finally {
        this.accepting = false;
        if (accepted.length) this.event("updated", null, { iids: accepted });
        this.reload(cx);
        if (this.selected) this.open(this.selected, cx);
        cx.notify();
      }
    });
  }

  // The shipped skill's status on `on` (install: only when the person clicks Install).
  checkSkill(cx, install) {
    this.skillBusy = install;
    cx.spawn(async (cx) => {
      try {
        const text = await readTextFile(`${appHome()}/mods/${MOD}/skills/triage-issues/SKILL.md`);
        if (!text) throw new Error("SKILL.md is missing from the mod");
        const replace = install && skillLine(this.skill).replace ? ["replace"] : [];
        const out = await this.forge(["skill", install ? "install" : "status", "triage-issues", text, ...replace], { on: this.project().on });
        this.skill = out.error ? { error: out.error } : out;
      } catch (e) {
        this.skill = { error: msg(e) };
      }
      this.skillBusy = false;
      cx.notify();
    });
  }

  // ---- the keyboard (on the list) ----

  // ↑/↓ and j/k move; the issue opens after a pause so a held key doesn't fetch every row.
  move(delta, cx) {
    const rows = this.rows;
    if (!rows.length) return;
    const at = rows.findIndex((r) => r[IID] === this.selected);
    const k = at < 0 ? (delta > 0 ? 0 : rows.length - 1) : Math.max(0, Math.min(rows.length - 1, at + delta));
    if (k > rows.length - 30) this.wantMore = true;
    if (rows[k][IID] !== this.selected) {
      this.selected = rows[k][IID];
      this.detail = null;
      this.detailError = null;
      this.adding = false;
      this.confirming = null;
      this.notice = null;
      this.picker.open = null;
      this.openAt = Date.now() + 250;
    }
    this.scroll.scroll_to_item(k);
    cx.notify();
  }

  clearSearch(cx) {
    this.input.set_value("");
    this.pendingQuery = null;
    if (this.query) { this.query = ""; this.reload(cx); }
    this.keys.focus();
    cx.notify();
  }

  onKey(e, cx) {
    const key = e.keystroke;
    const handled = () => cx.stop_propagation();
    if (key === "escape") {
      if (this.picker.open) { this.picker.open = null; cx.notify(); return handled(); }
      if (this.inputFocused || this.query || this.pendingQuery) { this.clearSearch(cx); return handled(); }
      return;
    }
    if (key === "up" || key === "down") { this.move(key === "up" ? -1 : 1, cx); return handled(); }
    if (this.inputFocused) return; // the rest are typing
    if (key === "j" || key === "k") { this.move(key === "k" ? -1 : 1, cx); return handled(); }
    if (key === "/" || e.key_char === "/") { this.input.focus(); return handled(); }
    if (key === "enter") {
      const url = this.detail?.issue?.iid === this.selected ? this.detail.issue.url : null;
      if (url) openUrl(exec, url);
      return handled();
    }
  }

  // ---- drawing ----

  prioColor(t, p) {
    return { blocker: t.ansi1, critical: t.ansi1, high: t.ansi3, medium: t.ansi4, low: t.dim }[p] ?? t.dim;
  }

  // Triage facets, the Triage rank sort and proposal chips wait for a triage run.
  triaged(tc) { return Boolean(tc && this.triageRun); }

  sidebar(t, tc) {
    const section = (group, title) => {
      const picked = this.picked[group] ?? [];
      const entries = facetEntries(this.counts, group, picked);
      if (!entries.length) return null;
      return v_flex().gap(1).pb(8)
        .child(div().px(8).pt(6).pb(2).text_size(11).font_semibold().text_color(t.dim).child(title))
        .children(entries.map(([v, n]) => h_flex().id(`f-${group}-${v}`).h(22).px(8).gap(6).items_center().rounded(5).cursor_pointer()
          .when(picked.includes(v), (e) => e.bg(t.selected))
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { this.picked = togglePick(this.picked, group, v); this.reload(cx); cx.notify(); })
          .when(group === "scope:priority", (e) => e.child(div().size(7).rounded(4).flex_none().bg(this.prioColor(t, v))))
          .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(picked.includes(v) ? t.foreground : t.muted).child(v))
          .child(div().flex_none().text_size(10.5).text_color(t.dim).child(String(n)))));
    };
    const any = Object.values(this.picked).some((v) => v.length);
    const scopes = orderScopes(this.scopes, props()?.scopes);
    return v_flex().id("issues-facets").size_full().min_h(0).overflow_y_scrollbar().p(6).bg(t.chrome)
      .when(any, (e) => e.child(div().id("f-clear").mx(8).my(4).text_size(11).text_color(t.accent).cursor_pointer()
        .on_click((_e, cx) => { this.picked = {}; this.reload(cx); cx.notify(); }).child("Clear filters")))
      .when(Boolean(tc), (e) => e.child(this.triageBox(t, tc)))
      .children([
        this.triaged(tc) ? section("triage", "Triage") : null,
        ...scopes.map((s) => section(`scope:${s}`, scopeTitle(s))),
        section("milestone", "Milestone"),
        section("labels", "Labels"),
      ].filter(Boolean));
  }

  // The triage agent's last run, the skill, and the buttons that act on its proposals.
  triageBox(t, tc) {
    const last = this.triageRun;
    const proposed = this.counts.triage?.["proposed change"] ?? 0;
    const open = this.launchTab(tc.tab);
    const { terms } = this.project();
    const skill = skillLine(this.skill);
    const btn = (id, label, onClick, primary) => button(t, id, label, onClick, { tone: primary ? "primary" : null });
    return v_flex().gap(6).mx(4).mb(6).p(8).rounded(8).border_1().border_color(t.border)
      .child(h_flex().gap(6).items_center()
        .child(div().flex_1().text_size(11.5).font_semibold().child("Triage agent"))
        .when(Boolean(open), (e) => e.child(open.tab.status === "working"
          ? svg("mods/workspace-chrome/spinner.svg").size(11).text_color(t.working).spin(900)
          : div().text_size(10.5).text_color(t[open.tab.status] ?? t.dim).child(open.tab.status ?? "open"))))
      .child(div().text_size(11).text_color(t.dim).child(last
        ? `Last run ${since(last.at * 1000)}: ${last.issues} ranked, ${proposed} change${proposed === 1 ? "" : "s"} waiting`
        : "Not run yet."))
      // The text on its own line: beside a button it was squeezed to a word per line.
      .child(div().text_size(11).text_color(this.skill?.error ? t.ansi1 : t.dim).child(skill.text))
      .when(Boolean(skill.install) && !this.skillBusy && !this.confirmSkill, (e) => e.child(h_flex()
        .child(btn("skill-install", skill.install, (cx) => {
          // Replacing someone else's skill asks first.
          if (skill.replace) { this.confirmSkill = true; cx.notify(); } else this.checkSkill(cx, true);
        }))))
      .when(Boolean(this.confirmSkill), (e) => e.child(v_flex().gap(4)
        .child(div().text_size(11).text_color(t.foreground).child("Replace it with this package's triage-issues skill?"))
        .child(h_flex().gap(6)
          .child(btn("skill-no", "Cancel", (cx) => { this.confirmSkill = false; cx.notify(); }))
          .child(btn("skill-yes", "Replace", (cx) => { this.confirmSkill = false; this.checkSkill(cx, true); }, true)))))
      .when(Boolean(this.skillBusy), (e) => e.child(div().text_size(11).text_color(t.muted).child("Installing…")))
      .child(h_flex().gap(6).flex_wrap()
        .child(btn("retriage", open ? "Go to triage" : last ? "Re-triage" : "Triage", (cx) => this.retriage(cx), !proposed))
        .when(proposed > 0 && !this.confirmAll && !this.accepting, (e) => e.child(btn("accept-all", `Accept all ${proposed}`, (cx) => { this.confirmAll = true; cx.notify(); }, true)))
        .when(Boolean(this.accepting), (e) => e.child(div().text_size(11).text_color(t.muted).child(`Writing to ${terms.name}…`))))
      .when(Boolean(this.confirmAll), (e) => e.child(v_flex().gap(4)
        .child(div().text_size(11).text_color(t.foreground).child(`Set priority on ${proposed} issues in ${terms.name}?`))
        .child(h_flex().gap(6)
          .child(btn("all-no", "Cancel", (cx) => { this.confirmAll = false; cx.notify(); }))
          .child(btn("all-yes", "Accept all", (cx) => this.acceptAll(cx), true)))))
      .when(Boolean(this.triageNotice), (e) => e.child(div().text_size(11).text_color(t.muted).child(this.triageNotice)));
  }

  // One list row. No handlers here (virtual list rule): clicks come through on_item_click.
  row(t, r, k, look) {
    if (!r) return h_flex().id(`issue-row-${k}`).h(ROW).px(10).items_center().text_size(11).text_color(t.dim).child("…");
    const on = this.selected === r[IID];
    const p = r[PRIO];
    return h_flex().id(`issue-${r[IID]}`).h(ROW).px(10).gap(8).items_center().rounded(6).cursor_pointer()
      .when(on, (e) => e.bg(t.selected))
      .hover((s) => s.bg(t.hover))
      .when(look.prio, (e) => e.child(div().size(8).rounded(4).flex_none().when(Boolean(p), (e) => e.bg(this.prioColor(t, p)))
        .when(!p, (e) => e.border_1().border_color(t.dim))))
      .child(div().w(40).flex_none().text_size(11).text_color(t.dim).child(`#${r[IID]}`))
      .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(r[STATE] === "closed" ? t.muted : t.foreground).child(r[TITLE]))
      .when(look.triage && Boolean(r[PROPOSED]), (e) => e.child(chip(t, `→ ${r[PROPOSED]}`, t.accent)))
      .when(Boolean(r[LAUNCHED]), (e) => e.child(chip(t, "agent", t.working)))
      .when(r[REQS] > 0, (e) => e.child(div().flex_none().text_size(10.5).text_color(t.muted).child(`${look.reqPrefix}${r[REQS]}`)))
      .when(Boolean(r[TYPE]), (e) => e.child(chip(t, r[TYPE], r[TYPE] === "bug" ? t.ansi1 : t.muted)))
      .child(div().w(32).flex_none().text_right().text_size(10.5).text_color(t.dim).child(ago(r[UPDATED])));
  }

  list(t, tc) {
    const triaged = this.triaged(tc);
    const sortList = sorts(triaged);
    const sort = sortList.find((s) => s.id === this.sort) ?? sortList[0];
    // Search on its own row, so it keeps its width in a narrow list; state and sort below it.
    const header = v_flex().flex_none().px(10).pt(8).pb(6).gap(6).border_b(1).border_color(t.border)
      .child(div().id("issues-search").w_full().h(28).px(8).flex().items_center().rounded(6).border_1().border_color(t.border).cursor_text()
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .when(this.inputFocused, (e) => e.border_color(t.accent))
        .child(Input.new(this.input).h_full().text_size(12.5).text_color(t.foreground)))
      .child(h_flex().gap(8).items_center().child(h_flex().flex_none().rounded(6).border_1().border_color(t.border).children(STATES.map((s) =>
        div().id(`st-${s.id}`).px(8).py(3).text_size(11.5).cursor_pointer()
          .when(this.state === s.id, (e) => e.bg(t.selected).text_color(t.foreground))
          .when(this.state !== s.id, (e) => e.text_color(t.muted))
          .hover((st) => st.text_color(t.foreground))
          .on_click((_e, cx) => { this.state = s.id; this.reload(cx); cx.notify(); }).child(s.label))))
      .child(div().id("issues-sort").flex_none().px(8).py(3).rounded(6).text_size(11.5).text_color(t.muted).cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .tooltip("Sort (click to change)")
        .on_click((_e, cx) => { this.sort = nextSort(sort.id, triaged); this.reload(cx); cx.notify(); })
        .child(`↕ ${sort.label}`)));
    const err = this.error ?? this.listError ?? this.syncError;
    const status = h_flex().h(24).flex_none().px(12).gap(8).items_center().border_t(1).border_color(t.border)
      .text_size(11).text_color(t.dim)
      .child(div().flex_none().child(`${this.matched} of ${this.total}`))
      .child(div().id("issues-error").flex_1().min_w(0).truncate().text_color(err ? t.ansi1 : t.dim)
        .when(Boolean(err), (e) => e.tooltip(this.error ? `${this.error}\n(click to dismiss)` : err))
        .when(Boolean(this.error), (e) => e.cursor_pointer().on_click((_e, cx) => { this.error = null; cx.notify(); }))
        .child(err ?? (this.syncing && this.syncMore ? "Fetching more from the forge…" : "")));
    const rows = this.rows, n = this.matched;
    const look = {
      prio: usesPriority(this.counts, this.labels, this.sep()),
      triage: triaged,
      reqPrefix: this.project().terms.reqPrefix,
    };
    const body = !n
      ? div().flex_1().min_h(0).child(note(t, this.loadFailed ? "Couldn't load issues: see below, then ↻ to retry."
        : this.loadedOnce ? (this.total ? "No issues match." : this.syncing ? "Fetching issues…" : "No issues.") : "Loading issues…"))
      : div().flex_1().min_h(0).relative()
        .child(v_virtual_list("issues-list", n, ROW, (k) => (rows[k] ? String(rows[k][IID]) : `row-${k}`),
          // Rows can't have handlers or start work here: clicks come through
          // on_item_click, and the next page is fetched by the timer in init.
          (range) => {
            if (range.end > rows.length - 30) this.wantMore = true;
            const out = [];
            for (let k = range.start; k < range.end; k++) out.push(this.row(t, rows[k], k, look));
            return out;
          }).size_full().px(4).track_scroll(this.scroll)
          .on_item_click((key, cx) => { this.keys.focus(); if (/^\d+$/.test(key)) this.open(Number(key), cx); }))
        .child(Scrollbar.vertical("issues-list").viewport_from_layout().absolute().inset_0());
    // The keyboard: the column holds the focus (clicking a row or Esc gives it back), and
    // keys typed in the search box pass through here too.
    return v_flex().id("issues-keys").size_full().min_h(0).track_focus(this.keys)
      .on_key_down((e, cx) => this.onKey(e, cx))
      .child(header).child(body).child(status);
  }

  detailPane(t, tc) {
    if (!this.selected) return note(t, "Select an issue (↑/↓ or j/k on the list).");
    const d = this.detail;
    if (!d) {
      return this.detailError ? note(t, `#${this.selected}: ${this.detailError}`, { error: true }) : note(t, `Loading #${this.selected}…`);
    }
    const i = d.issue;
    const sep = this.sep();
    const project = this.project();
    const { terms } = project;
    const { scoped, plain } = splitLabels(i.labels, sep);
    const busy = this.busy;
    const item = issueItem(i, project, sep);
    const actions = this.actionsFor(item);
    const confirming = actions.find((a) => a.id === this.confirming);
    const proposal = tc ? d.triage : null;
    const launches = d.launches ?? [];
    const requestAgents = shared("forge.requestAgents") ?? {};

    // One value per field (a scoped label holds one), so each is a dropdown. While a write
    // is in flight every control that writes is inert: one write at a time.
    const pickRow = (title, options, current, onPick) => h_flex().gap(6).items_center()
      .child(div().w(64).flex_none().text_size(11).text_color(t.dim).truncate().child(title))
      .child(busy
        ? div().px(6).py(1).rounded(4).border_1().border_color(t.border).text_size(11.5).text_color(t.dim).max_w(220).truncate()
          .child((options.find(([v]) => v === current) ?? [null, "none"])[1])
        : dropdown(t, `pick-${title}`, options, current, onPick, this.picker));
    // A button that does nothing while busy.
    const btn = (id, label, onClick, opts) => busy
      ? div().id(id).flex_none().px(8).py(2).rounded(5).bg(t.raised).opacity(0.5).text_size(11.5).text_color(t.dim).child(label)
      : button(t, id, label, onClick, opts);

    const scopes = orderScopes(this.scopes, props()?.scopes, [...metaScopes(this.labels, sep), ...Object.keys(scoped)]);
    const scopeRow = (scope) => {
      const cur = scoped[scope] ?? null;
      const prio = scope === "priority";
      const opts = scopeValues(this.labels, scope, sep, cur).map((v) => [v, v, prio ? this.prioColor(t, v) : undefined]);
      // A priority set by hand locks it, once the forge has it.
      return pickRow(scopeTitle(scope), [...opts, [null, "none"]], cur, (v, cx) =>
        this.setScoped(i, scope, v, cx, prio && tc ? (cx) => this.setLock(i, true, cx) : null));
    };
    const plainLabels = this.labels.filter((l) => !scopeOf(l.name, sep)[0]);
    const milestones = i.milestone && !this.milestones.some((m) => m.id === i.milestone.id) ? [...this.milestones, i.milestone] : this.milestones;
    const section = (title) => div().pt(12).pb(4).text_size(11).font_semibold().text_color(t.dim).child(title);
    const scopeRows = [];
    for (const s of scopes) {
      scopeRows.push(scopeRow(s));
      if (s === "priority" && proposal?.locked) {
        scopeRows.push(h_flex().pl(70).gap(6).items_center().text_size(11).text_color(t.dim)
          .child(div().child("Set by hand: triage keeps it."))
          .child(div().id("unlock").text_color(t.accent).cursor_pointer().on_click((_e, cx) => this.setLock(i, false, cx)).child("Let triage change it")));
      }
    }

    return v_flex().id("issue-detail").size_full().min_h(0).overflow_y_scrollbar().p(14).gap(6)
      .child(h_flex().gap(8).items_start()
        .child(div().flex_1().min_w(0).text_size(15).font_semibold().child(i.title))
        .child(button(t, "open-issue", "↗", () => openUrl(exec, i.url), { tooltip: `Open in ${terms.name}` })))
      .child(h_flex().gap(8).text_size(11).text_color(t.muted).flex_wrap()
        .child(div().text_color(i.state === "opened" ? t.ansi2 : t.ansi5).child(i.state === "opened" ? "Open" : "Closed"))
        .child(div().child(`#${i.iid}`))
        .when(Boolean(i.author), (e) => e.child(div().child(`by ${i.author}`)))
        .when(i.created_ms != null, (e) => e.child(div().child(`opened ${since(i.created_ms)}`)))
        .when(i.updated_ms != null, (e) => e.child(div().child(`updated ${since(i.updated_ms)}`)))
        .when((i.assignees ?? []).length > 0, (e) => e.child(div().child(`→ ${i.assignees.join(", ")}`)))
        .when(busy, (e) => e.child(div().text_color(t.accent).child(`Saving to ${terms.name}…`))))
      .child(h_flex().gap(6).pt(6).flex_wrap()
        .children(actions.map((a) => btn(`act-${a.id}`, actionLabel(a), (cx) => this.act(i, a, cx),
          { tone: a.tone ?? (a.primary ? "primary" : null), tooltip: describe(a) })))
        .child(btn("state", i.state === "opened" ? "Close issue" : "Reopen", (cx) => this.setState(i, cx))))
      .when(Boolean(confirming), (e) => e.child(h_flex().gap(6).items_center().p(8).rounded(6).border_1().border_color(t.accent).text_size(11.5)
        .child(div().flex_1().min_w(0).child(typeof confirming.confirm === "string" ? confirming.confirm : `${confirming.label}?`))
        .child(button(t, "confirm-no", "Cancel", (cx) => { this.confirming = null; cx.notify(); }))
        .child(btn("confirm-yes", confirming.label, (cx) => this.act(i, confirming, cx),
          { tone: confirming.tone ?? "primary" }))))
      .when(Boolean(this.notice), (e) => e.child(div().text_size(11.5).text_color(t.muted).child(this.notice)))
      .when(launches.length > 0, (e) => e.children(launches.map((l, k) => {
        const where = this.launchTab(l.tab);
        const working = where?.tab.status === "working";
        return h_flex().id(`launch-${k}`).gap(6).items_center().px(8).py(4).rounded(6).bg(t.raised).text_size(11.5)
          .when(Boolean(where), (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)).on_click(() => this.goTo(where)))
          .child(working
            ? svg("mods/workspace-chrome/spinner.svg").size(11).flex_none().text_color(t.working).spin(900)
            : div().size(7).mx(2).flex_none().rounded(4).bg(where ? t.idle ?? t.dim : t.dim))
          .child(div().flex_1().min_w(0).truncate().child(`${l.tab} · started ${since(l.at * 1000)}`))
          .child(div().flex_none().text_color(t.dim).child(where ? (where.tab.status ?? "open") : "tab closed"));
      })))
      .when(proposal?.status === "proposed" && Boolean(proposal?.priority), (e) => e.child(v_flex().gap(4).p(8).rounded(6).border_1().border_color(t.accent)
        .child(h_flex().gap(6).items_center().text_size(11.5)
          .child(div().flex_1().child(`Triage suggests priority${sep}${proposal.priority}${proposal.rank ? ` (rank ${proposal.rank})` : ""}`))
          .child(btn("tri-yes", "Accept", (cx) => this.answerTriage(i, true, cx), { tone: "primary" }))
          .child(btn("tri-no", "Dismiss", (cx) => this.answerTriage(i, false, cx))))
        .when(Boolean(proposal.reason), (e) => e.child(div().text_size(11.5).text_color(t.muted).child(proposal.reason)))))
      .child(section("Fields"))
      .children(scopeRows)
      .child(pickRow("Milestone", [...milestones.map((m) => [m.id, m.title]), [null, "none"]], i.milestone?.id ?? null,
        (id, cx) => this.setMilestone(i, milestones.find((m) => m.id === id) ?? null, cx)))
      .child(h_flex().gap(6).items_start()
        .child(div().w(64).flex_none().pt(2).text_size(11).text_color(t.dim).child("Labels"))
        .child(h_flex().flex_1().min_w(0).gap(4).flex_wrap()
          .children(plain.map((l) => div().id(`rm-${l}`).px(6).py(1).rounded(4).border_1().border_color(t.border).text_size(11)
            .when(busy, (e) => e.opacity(0.5))
            .when(!busy, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)).tooltip("Remove")
              .on_click((_e, cx) => this.toggleLabel(i, l, cx)))
            .child(`${l} ×`)))
          .child(div().id("add-label").px(6).py(1).rounded(4).text_size(11).text_color(t.accent).cursor_pointer()
            .hover((s) => s.bg(t.hover)).on_click((_e, cx) => { this.adding = !this.adding; cx.notify(); })
            .child(this.adding ? "done" : "+ label"))))
      .when(this.adding, (e) => e.child(h_flex().pl(70).gap(4).flex_wrap().children(plainLabels.filter((l) => !plain.includes(l.name)).map((l) =>
        div().id(`add-${l.name}`).px(6).py(1).rounded(4).border_1().border_color(t.border).text_size(11).text_color(t.muted)
          .when(Boolean(l.description), (e) => e.tooltip(l.description))
          .when(busy, (e) => e.opacity(0.5))
          .when(!busy, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.toggleLabel(i, l.name, cx)))
          .child(l.name)))))
      .child(section(terms.requests))
      .child(!d.requests?.length ? div().text_size(11.5).text_color(t.dim).child("None linked.")
        : v_flex().gap(2).children(d.requests.map((m) => {
          const color = m.state === "merged" ? t.ansi5 : m.state === "closed" ? t.dim : m.draft ? t.muted : t.accent;
          const agentsOn = requestAgents[m.url] ?? [];
          return h_flex().id(`req-${m.iid}`).gap(6).items_center().px(6).py(3).rounded(5).cursor_pointer().text_size(12)
            .hover((s) => s.bg(t.hover))
            .on_click(() => openUrl(exec, m.url))
            .child(div().flex_none().text_color(color).child(`${terms.reqPrefix}${m.iid}`))
            .child(div().flex_1().min_w(0).truncate().child(m.title))
            .children(agentsOn.map((a) => chip(t, a.name ?? a.address, t.working)))
            .child(div().flex_none().text_size(10.5).text_color(color).child(m.draft && m.state === "opened" ? "draft" : m.state));
        })))
      .child(section("Description"))
      .child(div().w_full().text_size(12.5).text_color(t.foreground)
        .child(d.description ? TextView.markdown(`desc-${i.iid}`, d.description) : "No description."))
      .child(section(`Comments${d.notes?.length ? ` · ${d.notes.length}` : ""}`))
      .children((d.notes ?? []).map((n, k) => v_flex().id(`note-${k}`).gap(2).p(8).rounded(6).bg(t.raised)
        .child(h_flex().gap(6).text_size(11).text_color(t.dim).child(div().text_color(t.muted).child(n.author)).child(div().child(since(n.at_ms))))
        .child(div().w_full().text_size(12).child(TextView.markdown(`note-${i.iid}-${k}`, n.body)))))
      .when(Boolean(d.error), (e) => e.child(staleError(t, d.error, { inset: 0 })))
      .child(v_flex().gap(6).pt(6)
        .child(div().id("comment-box").rounded(6).border_1().border_color(t.border).p(6).cursor_text()
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .child(Textarea.new(this.comment).w_full().text_size(12).text_color(t.foreground)))
        .child(h_flex().justify_end().child(btn("post-comment", "Comment", (cx) => this.postComment(i, cx)))));
  }

  render() {
    const t = theme();
    const { repo, host, provider } = this.project();
    const filtered = this.matched !== this.total;
    const header = this.chrome.header(t, {
      title: "Issues", count: this.loadedOnce ? (filtered ? `${this.matched}/${this.total}` : this.total) : null,
      sub: repo, at: this.lastSync || null, loading: this.syncing,
      onRefresh: repo && provider ? (cx) => { if (!this.loadedOnce) this.reload(cx); this.sync(cx, true); } : null,
    });
    const frame = (body) => v_flex().id("issues").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .child(header).when(Boolean(body), (e) => e.child(body));
    if (this.chrome.collapsed()) return frame(null);
    if (!repo) return frame(note(t, "No repo set (props.repo)."));
    if (!provider) return frame(note(t, `${host} isn't a forge herdr-forge supports yet.`));
    const tc = this.triage();
    return frame(div().flex_1().min_h(0)
      .child(h_resizable("forge-issues").size_full()
        .child(resizable_panel().size(210).size_range(150, 320).child(this.sidebar(t, tc)))
        // The list needs room for a title; in the Forge layout the whole browser is ~880px wide.
        .child(resizable_panel().size_range(260).child(this.list(t, tc)))
        .child(resizable_panel().size(400).size_range(300, 900).child(div().size_full().border_l(1).border_color(t.border).child(this.detailPane(t, tc))))));
  }
}
