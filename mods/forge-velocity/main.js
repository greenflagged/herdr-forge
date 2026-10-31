import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, readTextFile, appHome, focused, spaces, panes, props, theme, window } from "herdr";
import { forgeClient, parseRemote, providerForHost, TERMS, num } from "./lib.js";
import { Chrome, note } from "./ui.js";
import { prepare, bucketLabel, day } from "./view.js";

// Velocity of the focused project: commits, merged requests, closed issues and request
// cycle time, last 12 weeks (or 30 days). Follows the focused terminal's repo on its
// machine, unless props.folder names a checkout to show. forge.py does the fetching, caching and bucketing; this file only draws.
// - Commits: `forge.py commits` on the repo's machine (git log of the default branch,
//   fetched every 15 min there). Asked every 5 min while shown.
// - Requests and issues: `forge.py velocity` with the repo's remote (host and path).
//   Asked every 5 min while shown; forge.py fetches when its copy is 15 min old and the
//   window is active (otherwise it only re-buckets what it has). A repo whose host isn't a
//   forge we read (props.forges can name self-hosted ones) gets its commits only.
// - ↻ fetches both now.
// props: { forges?: { "git.example.com": "gitlab" },
//          glabOn?: "<machine>" | null,  where forge.py talks to the forge when the repo's
//          machine has no CLI (glab) logged in. The repo's machine is tried first; the one
//          that works is remembered per repo until restart.
//          folder?, on? }                a checkout (on that machine) to show instead of
//          following focus: the Forge window passes its project's.

const MOD = "forge-velocity";
const COMMITS_EVERY = 5 * 60000, FORGE_EVERY = 5 * 60000;
const FORGE_AGE = 900; // seconds: forge.py fetches when its copy is older than this

const RESOLVE = `top=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
printf 'top\\t%s\\n' "$top"
printf 'url\\t%s\\n' "$(git remote get-url origin 2>/dev/null)"
printf 'ref\\t%s\\n' "$(git symbolic-ref -q --short refs/remotes/origin/HEAD 2>/dev/null)"`;

const msg = (e) => String(e?.message ?? e);
const store = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
const load = (k) => { try { return localStorage.getItem(k); } catch { return null; } };

export default class Velocity extends View {
  init(_props, cx) {
    this.forge = forgeClient({ exec, readTextFile }, `${appHome()}/mods/${MOD}/forge.py`);
    this.chrome = new Chrome(MOD, {}, { width: 340, height: 460 });
    this.chrome.attach(cx);
    this.range = load("range") === "30d" ? "30d" : "12w";
    this.resolved = {};   // JSON [on, cwd] -> { key } | { none, at }
    this.resolving = null;
    this.key = null;      // the repo shown: JSON [on, remote url or top]
    this.followed = true; // false: focus is somewhere that isn't a repo; showing the last one
    this.data = {};       // key -> repo state (see state())
    this.hover = null;    // bucket index under the pointer
    // Show the last repo at once after a restart: its first calls answer from forge.py's cache.
    // (Not with a fixed folder: that's the only repo this panel shows.)
    if (!this.fixed()) try {
      const last = JSON.parse(load("last") ?? "null");
      if (last?.key && last.top) { this.data[last.key] = this.state(last); this.key = last.key; }
    } catch {}
    this.tick(cx);
    cx.timer.every(1000, (cx) => this.tick(cx));
  }

  // props.folder: a checkout to show, instead of following focus.
  fixed() {
    const f = props()?.folder;
    return typeof f === "string" && f ? f : null;
  }

  // The folder to show: props.folder (on props.on), else where the keyboard is (the
  // focused terminal's folder, on its space's machine).
  target() {
    const fixed = this.fixed();
    if (fixed) return { on: props()?.on ?? null, cwd: fixed };
    const f = focused();
    if (!f) return null;
    const sp = spaces().find((s) => s.id === f.space);
    const inTab = panes().filter((p) => p.tab === f.tab && p.cwd);
    const cwd = f.cwd ?? inTab.find((p) => p.focused)?.cwd ?? inTab[0]?.cwd ?? sp?.folder;
    return cwd ? { on: sp?.machine ?? null, cwd } : null;
  }

  tick(cx) {
    this.follow(cx);
    // Redraw now and then: "3m" moves, and a redraw Herdr dropped doesn't stick.
    if (Date.now() - (this.drawn ?? 0) > 30000) cx.notify();
    const s = this.key && this.data[this.key];
    if (!s || !this.chrome.visible()) return;
    const now = Date.now();
    if (!s.cBusy && now - s.cAt >= COMMITS_EVERY) this.loadCommits(s, false, cx);
    if (s.provider && !s.vBusy && now - s.vAt >= FORGE_EVERY) this.loadVelocity(s, false, cx);
  }

  follow(cx) {
    const tg = this.target();
    if (!tg) return;
    const rk = JSON.stringify([tg.on, tg.cwd]), r = this.resolved[rk];
    if (r === undefined || (r.none && Date.now() - r.at > 5 * 60000)) this.resolve(rk, tg, cx);
    else if (r && !r.none && r.key !== this.key) {
      this.key = r.key; this.followed = true; this.hover = null;
      if (!this.fixed()) store("last", JSON.stringify(this.data[r.key].meta));
      cx.notify();
    }
    else if (r?.none && this.followed) { this.followed = false; cx.notify(); }
    else if (r && !r.none && !this.followed) { this.followed = true; cx.notify(); }
  }

  resolve(rk, tg, cx) {
    if (this.resolving) return;
    this.resolving = rk;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("sh", ["-c", RESOLVE], { cwd: tg.cwd, on: tg.on });
        const f = Object.fromEntries(r.stdout.split("\n").filter(Boolean).map((l) => l.split("\t")));
        if (!f.top) { this.resolved[rk] = { none: true, at: Date.now() }; return; }
        const remote = parseRemote(f.url ?? "");
        const key = JSON.stringify([tg.on, f.url || f.top]);
        this.resolved[rk] = { key };
        if (!this.data[key]) {
          this.data[key] = this.state({ key, on: tg.on, top: f.top, ref: f.ref || "", host: remote?.host ?? null, path: remote?.path ?? null,
            name: remote?.path.split("/").pop() ?? f.top.split("/").pop() });
        }
      } catch (e) {
        // Machine unreachable or no such folder: try again in a while.
        this.resolved[rk] = { none: true, at: Date.now(), error: msg(e) };
      } finally {
        this.resolving = null;
        cx.notify();
      }
    });
  }

  // meta: where the repo is ({ key, on, top, ref, host, path, name }); kept in localStorage
  // for the last one. The rest is in memory: forge.py keeps the numbers.
  state(meta) {
    const provider = meta.host && meta.path ? providerForHost(meta.host, props()?.forges ?? {}) : null;
    const s = { ...meta, meta, provider, terms: TERMS[provider] ?? TERMS.gitlab,
      commits: null, cAt: 0, cBusy: false, cErr: null,
      velocity: null, vAt: 0, vBusy: false, vErr: null, vQuick: true, nocli: false,
      forgeOn: undefined, view: null };
    this.prepare(s);
    return s;
  }

  prepare(s) {
    s.view = prepare(s.commits, s.velocity, s.terms, Boolean(s.provider), this.range);
  }

  loadCommits(s, force, cx) {
    const range = this.range;
    s.cBusy = true;
    s.cAt = Date.now();
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const out = await this.forge(["commits", s.top, s.ref, range, Date.now(), new Date().getTimezoneOffset(), force ? 1 : 0], { on: s.on });
        if (range !== this.range) { s.cAt = 0; return; } // asked for the other range: again
        s.commits = out;
        s.cErr = out.error ?? null;
      } catch (e) {
        s.cErr = msg(e);
      } finally {
        s.cBusy = false;
        this.prepare(s);
        cx.notify();
      }
    });
  }

  // The repo's machine first; if it has no CLI, props.glabOn. Remembers the one that works.
  async askForge(s, maxAge, force, range) {
    const fallback = props()?.glabOn;
    const where = s.forgeOn !== undefined ? [s.forgeOn]
      : [s.on, ...(fallback !== undefined && fallback !== s.on ? [fallback] : [])];
    let out, last;
    for (const [i, on] of where.entries()) {
      const more = i < where.length - 1;
      try {
        out = await this.forge(["velocity", s.provider, s.host, s.path, maxAge, force ? 1 : 0, range, Date.now(), new Date().getTimezoneOffset()], { on });
      } catch (e) {
        last = e;
        if (more) continue;
        throw e;
      }
      if (out.nocli && more) continue;
      s.forgeOn = out.nocli ? undefined : on;
      return out;
    }
    throw last ?? new Error("forge.py didn't answer");
  }

  // Stale-first: the first call for a repo (or range) takes forge.py's copy however old,
  // then, if the window is active and that copy is old, asks for a fresh one.
  loadVelocity(s, force, cx) {
    const range = this.range;
    const quick = s.vQuick && !force;
    s.vQuick = false;
    s.vBusy = true;
    s.vAt = Date.now();
    cx.notify();
    cx.spawn(async (cx) => {
      const take = (out) => {
        if (range !== this.range) { s.vQuick = true; s.vAt = 0; return false; }
        s.velocity = out;
        s.vErr = out.error ?? null;
        s.nocli = Boolean(out.nocli);
        this.prepare(s);
        return true;
      };
      try {
        const active = window().active;
        const out = await this.askForge(s, force || (active && !quick) ? FORGE_AGE : -1, force, range);
        if (take(out) && quick && window().active && Date.now() / 1000 - (out.at ?? 0) >= FORGE_AGE) {
          cx.notify();
          take(await this.askForge(s, FORGE_AGE, false, range));
        }
      } catch (e) {
        s.vErr = msg(e);
      } finally {
        s.vBusy = false;
        cx.notify();
      }
    });
  }

  refresh(cx) {
    const s = this.key && this.data[this.key];
    if (!s) return;
    if (!s.cBusy) this.loadCommits(s, true, cx);
    if (s.provider && !s.vBusy) this.loadVelocity(s, true, cx);
  }

  setRange(id, cx) {
    if (id === this.range) return;
    this.range = id;
    this.hover = null;
    store("range", id);
    // Re-bucket from forge.py's copies (no fetch) on the next tick.
    for (const s of Object.values(this.data)) { s.cAt = 0; s.vAt = 0; s.vQuick = true; }
    cx.notify();
  }

  row(r, t, sel) {
    const shown = this.hover != null ? r.shown[this.hover] ?? "–" : r.headline;
    const d = this.hover == null ? r.delta : null;
    const color = t[r.color] ?? t.accent;
    const tone = { dim: t.dim, good: t.ansi2, bad: t.ansi1 };
    return v_flex().gap(4)
      .child(h_flex().items_baseline().gap(6)
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.muted).child(r.label))
        .when(Boolean(d), (e) => e.child(div().text_size(10).text_color(tone[d.tone]).child(d.text)))
        .child(div().text_size(15).font_semibold().child(shown)))
      .child(h_flex().h(22).gap(1).children(r.values.map((v, i) =>
        v_flex().id(`b-${r.key}-${i}`).flex_1().h_full().justify_end()
          .on_hover((on, cx) => {
            if (on) this.hover = i; else if (this.hover === i) this.hover = null;
            cx.notify();
          })
          .child(div().w_full().rounded(1).bg(v == null ? t.border : color)
            .opacity(i === sel ? 1 : 0.4)
            .h(r.heights[i])))));
  }

  render(cx) {
    this.drawn = Date.now();
    try { return this.draw(cx); }
    catch (e) {
      return div().id("velocity").size_full().p(12).bg(theme().background).text_size(11).text_color(theme().ansi1)
        .child(`Velocity: ${String(e?.stack ?? e)}`);
    }
  }

  draw(_cx) {
    const t = theme(), s = this.key ? this.data[this.key] : null;
    const busy = Boolean(s && (s.cBusy || s.vBusy));

    const range = (id) => div().id(`range-${id}`).flex_none().px(5).rounded(4).border_1().text_size(10).cursor_pointer()
      .when(this.range === id, (e) => e.border_color(t.border).bg(t.raised).text_color(t.foreground))
      .when(this.range !== id, (e) => e.border_color(t.background).text_color(t.dim).hover((h) => h.text_color(t.foreground)))
      .tooltip(id === "12w" ? "Last 12 weeks" : "Last 30 days")
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); this.setRange(id, cx); })
      .child(id);

    const header = this.chrome.header(t, {
      title: "Velocity", sub: s ? (this.followed ? s.name : `${s.name} (last)`) : "",
      at: s?.commits?.at ? s.commits.at * 1000 : null, loading: busy,
      onRefresh: s ? (cx) => this.refresh(cx) : null,
      extra: [h_flex().flex_none().gap(1).child(range("12w")).child(range("30d"))],
    });
    const root = () => v_flex().id("velocity").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .child(header);
    if (this.chrome.collapsed()) return root();
    if (!s) {
      const fixed = this.fixed(), on = props()?.on;
      return root().child(note(t, this.resolving ? "Finding the repo…"
        : fixed ? `No git checkout at ${fixed}${on ? ` on ${on}` : ""} (or it can't be reached).`
        : "Focus a terminal in a git repo."));
    }

    const v = s.view;
    const sel = this.hover ?? v.n - 1;
    const caption = this.hover != null ? bucketLabel(this.hover, v)
      : !this.followed ? "last repo · focus isn't in one" : "last 7 days · vs avg week";

    const hint = s.nocli && props()?.glabOn === undefined ? ` (set props.glabOn to a machine where ${s.terms.cli} is logged in)` : "";
    const warn = s.cErr ? { text: s.cErr, color: t.ansi1 }
      : s.vErr ? { text: `${s.terms.name}: ${s.vErr}${hint}`, color: t.ansi1 }
      : !s.provider ? { text: `${s.host ?? "no remote"}: commits only`, color: t.dim }
      : null;

    const total = (k) => v.rows.find((r) => r.key === k)?.total ?? 0;
    const footer = `${s.ref || "HEAD"} · ${num(total("commits"))} commits`
      + (s.provider ? ` · ${num(total("merged"))} ${s.terms.request}s` : "");

    return root()
      .child(v_flex().id("vel-body").flex_1().min_h(0).overflow_y_scrollbar().px(12).pt(8).pb(8).gap(10)
        .child(div().text_size(10).text_color(this.hover != null ? t.foreground : this.followed ? t.dim : t.ansi3).truncate().child(caption))
        .children(v.rows.map((r) => this.row(r, t, sel)))
        .child(h_flex().justify_between().text_size(9).text_color(t.dim)
          .child(v.start != null ? day(v.start) : "").child(this.range === "30d" ? "today" : "now"))
        .when(Boolean(warn), (e) => e.child(div().text_size(11).text_color(warn.color).child(warn.text))))
      .child(div().flex_none().h(24).px(12).border_t(1).border_color(t.border).flex().items_center()
        .text_size(10).text_color(t.dim).child(div().truncate().child(footer)));
  }
}
