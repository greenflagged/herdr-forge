// Shared helpers for the forge-* mods. Herdr mods can only import from their own folder,
// so every mod carries an identical copy: edit shared/lib.js and run `npm run sync`.
// Nothing here imports from Herdr (callers pass in what's needed), so the tests run
// under plain Node.

// ---- forges ----

export const TERMS = {
  gitlab: {
    name: "GitLab", cli: "glab", request: "MR", requests: "Merge requests", reqPrefix: "!",
    ci: "Pipelines", ciRun: "pipeline", group: "stage", host: "gitlab.com",
  },
  github: {
    name: "GitHub", cli: "gh", request: "PR", requests: "Pull requests", reqPrefix: "#",
    ci: "Workflow runs", ciRun: "run", group: "workflow", host: "github.com",
  },
};

// The forge a host runs, or null for forges we don't support. props.forges can name
// self-hosted ones: { "git.example.com": "gitlab" }.
export function providerForHost(host, forges = {}) {
  if (!host) return null;
  if (forges[host]) return forges[host];
  // github.com, and GitHub Enterprise hosts that say so (github.acme.com, acme-github.io)
  if (/(^|[.-])github([.-]|$)/.test(host)) return "github";
  if (/(^|\.)(bitbucket\.org|codeberg\.org|sr\.ht)$/.test(host)) return null;
  return "gitlab";
}

// { provider, host, repo, on, terms } from a mod's props. provider defaults from host,
// host from provider; with neither it's GitLab on gitlab.com. provider is null for a
// host we don't support (Bitbucket, Codeberg): mods say so instead of calling it.
export function projectOf(p = {}) {
  const provider = p.provider ?? (p.host ? providerForHost(p.host, p.forges) : "gitlab");
  const terms = TERMS[provider] ?? TERMS.gitlab;
  return { provider: TERMS[provider] ? provider : null, host: p.host ?? terms.host, repo: p.repo ?? "", on: p.on ?? null, terms };
}

// git@host:group/proj.git, https://host/group/proj.git, ssh://git@host:22/group/proj
export function parseRemote(url) {
  const m = /^[\w.-]+@([^:/]+):(.+?)(?:\.git)?\/?$/.exec(url ?? "")
    ?? /^\w+:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/.exec(url ?? "");
  return m ? { host: m[1], path: m[2] } : null;
}

// ---- running forge.py ----

// POSIX machines only (macOS, Linux): the script goes over as one argument.
const PYTHONS = ["python3", "/usr/bin/python3", "/opt/homebrew/bin/python3", "/usr/local/bin/python3"];
// The same folder forge.py uses: $HERDR_FORGE_HOME, else $XDG_DATA_HOME/herdr-forge.
const DIR = `d=os.environ.get("HERDR_FORGE_HOME") or os.path.join(os.environ.get("XDG_DATA_HOME") or os.path.expanduser("~/.local/share"),"herdr-forge")`;

// Runs the installed copy of this exact version, or says it isn't there. Touching it
// marks it used, so cleanup only removes versions nothing runs.
const boot = (ver) => `import os,sys
${DIR}
p=os.path.join(d,"forge-${ver}.py")
if not os.path.exists(p):
    print('{"install": true}'); sys.exit(0)
try: os.utime(p)
except OSError: pass
sys.argv=[p]+sys.argv[1:]
exec(compile(open(p).read(),p,"exec"),{"__name__":"__main__","__file__":p})`;

// Writes forge-<version>.py (what boot runs), and forge.py (the stable path agents and
// skills call) unless a newer release is already there; removes versions unused for two
// weeks. Every mod may install at once on first start: each writes its own temp file.
// The folder also holds the caches (issue text): private to its owner, like forge.py makes it.
const INSTALL = `import os,sys,glob,time,re
os.umask(0o077)
${DIR}
os.makedirs(d,mode=0o700,exist_ok=True)
try: os.chmod(d,0o700)
except OSError: pass
v,t=sys.argv[1],sys.argv[2]
rel=lambda s:tuple(int(x) for x in re.findall(r"\\d+",s.split("+")[0]))
def put(n):
    f=os.path.join(d,n); tmp="%s.%d"%(f,os.getpid())
    with open(tmp,"w") as o: o.write(t)
    os.replace(tmp,f)
put("forge-%s.py"%v)
try:
    with open(os.path.join(d,"forge.py")) as o: old=re.search(r'^VERSION = "([^"]+)"',o.read(),re.M).group(1)
except Exception: old="0"
if rel(v)>=rel(old): put("forge.py")
for f in glob.glob(os.path.join(d,"forge-*.py")):
    try:
        if not f.endswith("forge-%s.py"%v) and time.time()-os.path.getmtime(f)>14*86400: os.remove(f)
    except OSError: pass
print('{"ok": true}')`;

export function versionOf(text) {
  return /^VERSION = "([^"]+)"/m.exec(text ?? "")?.[1] ?? "dev";
}

function parseOut(r, what) {
  try { return JSON.parse(r.stdout); }
  catch { throw new Error((r.stderr || r.stdout).trim().split("\n").pop() || `${what} exited ${r.code}`); }
}

// A function that runs forge.py commands on a machine and returns their JSON:
//   const forge = forgeClient({ exec, readTextFile }, `${appHome()}/mods/forge-ci/forge.py`);
//   await forge(["pipelines", provider, host, repo, 60, 0], { on });
// The script goes over once per machine and version; after that only a short boot does.
// An answer with `error` is returned, not thrown: callers keep stale data and show why.
export function forgeClient(h, scriptPath) {
  let text = null, ver = null;
  const bins = new Map(); // machine -> the python that started there
  async function py(args, on) {
    const known = bins.get(on);
    let last;
    for (const bin of known ? [known] : PYTHONS) {
      try { const r = await h.exec(bin, args, { on }); bins.set(on, bin); return r; }
      catch (e) { last = e; }
    }
    throw last ?? new Error("python3 not found");
  }
  return async function forge(args, { on = null } = {}) {
    if (text == null) {
      text = await h.readTextFile(scriptPath);
      if (!text) throw new Error(`missing ${scriptPath}`);
      ver = versionOf(text);
    }
    for (let i = 0; i < 2; i++) {
      const out = parseOut(await py(["-I", "-c", boot(ver), ...args.map(String)], on), "python3");
      if (!out?.install) return out;
      const done = parseOut(await py(["-I", "-c", INSTALL, ver, text], on), "python3");
      if (!done?.ok) throw new Error(done?.error ?? "couldn't install forge.py");
    }
    throw new Error("couldn't install forge.py");
  };
}

// ---- small formatting ----

export function ago(t, now = Date.now()) {
  if (t == null) return "";
  const s = Math.max(0, (now - t) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  if (s < 86400 * 60) return `${Math.round(s / 86400)}d`;
  return `${Math.round(s / (86400 * 30))}mo`;
}

// Seconds as 42s / 3m07s / 1h05m.
export function clock(sec) {
  if (sec == null) return "";
  sec = Math.max(0, Math.round(sec));
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, "0")}s`;
  return `${Math.floor(sec / 3600)}h${String(Math.floor(sec / 60) % 60).padStart(2, "0")}m`;
}

// This runtime's toLocaleString ignores fraction digits: round by hand.
export function num(x, d = 0) {
  const [whole, frac] = (+x.toFixed(d)).toString().split(".");
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (frac ? `.${frac}` : "");
}

// Milliseconds as 40m / 5.2h / 3.1d.
export function span(msec) {
  if (msec == null) return "–";
  const h = msec / 3600000;
  return h < 1 ? `${Math.max(1, Math.round(h * 60))}m` : h < 48 ? `${num(h, h < 10 ? 1 : 0)}h` : `${num(h / 24, 1)}d`;
}

export function openUrl(exec, url) {
  if (!/^https?:\/\//.test(url ?? "")) return;
  exec("xdg-open", [url]).catch(() => exec("open", [url]).catch(() => {}));
}

// ---- layout ----

// Whether a copy of this mod (with these props, where given) is on screen. Herdr keeps
// hidden mods running, so polling mods check this before fetching.
// - A layout block: not hidden, not under a hidden node, not an inactive stack child.
// - A mod pane (a tab opened with { mod }): its tab is the shown tab of the shown space.
//   Pass live = { panes: panes(), spaces: spaces() } for this.
// - Neither (an overlay, a layout still loading): shown, so it fails safe.
// It answers for any copy, not this one: Herdr doesn't tell a block its own id, so two
// copies with the same props poll while either is shown. A minimized window counts as
// shown; check window().active to slow down.
export function isShown(tree, mod, match = {}, live = {}) {
  const inTree = shownInTree(tree, mod, match);
  if (inTree != null) return inTree;
  const panes = (live.panes ?? []).filter((p) => p.mod === mod);
  if (!panes.length) return true;
  const showing = new Set();
  for (const s of live.spaces ?? []) if (s.active) for (const t of s.tabs ?? []) if (t.active) showing.add(t.id);
  return panes.some((p) => showing.has(p.tab));
}

// true / false for a block in the layout tree; null when the mod has no block there.
function shownInTree(tree, mod, match) {
  let found = false, shown = false;
  const walk = (n, hidden) => {
    if (!n || typeof n !== "object") return;
    const h = hidden || Boolean(n.hidden);
    const c = n.content;
    if (c?.mod === mod && Object.entries(match).every(([k, v]) => v == null || c.props?.[k] === v)) {
      found = true;
      if (!h) shown = true;
    }
    const kids = Array.isArray(n.children) ? n.children : [];
    const active = n.type === "stack" ? (n.active ?? kids[0]?.id) : null;
    for (const k of kids) walk(k, h || (active != null && k.id !== active));
    for (const f of Array.isArray(n.floating) ? n.floating : []) walk(f, h);
  };
  walk(tree, false);
  return found ? shown : null;
}

// The layout blocks showing this mod (with these props, where given): [{ id, size, hidden }].
// The layout blocks showing this mod (with these props, where given):
// [{ id, size, hidden, parent }], parent being the containing node's type ("row",
// "column", "stack", "floating").
export function findBlocks(tree, mod, match = {}) {
  const out = [];
  const walk = (n, parent) => {
    if (!n || typeof n !== "object") return;
    const c = n.content;
    if (c?.mod === mod && n.id && Object.entries(match).every(([k, v]) => v == null || c.props?.[k] === v)) {
      out.push({ id: n.id, size: n.size ?? null, hidden: Boolean(n.hidden), parent });
    }
    for (const k of Array.isArray(n.children) ? n.children : []) walk(k, n.type ?? null);
    for (const f of Array.isArray(n.floating) ? n.floating : []) walk(f, "floating");
  };
  walk(tree, null);
  return out;
}

// Panel chrome (ui.js) collapses a block in place by sizing it to its header. A block
// that size is collapsed; expanding gives back the size it had (or a share of the column).
export const HEADER_PX = 34;
export const isCollapsed = (block) => block?.size?.px === HEADER_PX;
export function expandedSize(saved) {
  if (saved && typeof saved === "object" && (saved.px > HEADER_PX || saved.weight > 0)) return saved;
  return { weight: 1 };
}

// ---- actions: buttons people add to issues and requests ----
//
// An action is { id, label, tooltip?, when?, confirm?, primary?, ...one of }:
//   agent:   { agent?: "claude", task, tab?, folder? }   start an agent in a new tab
//   exec:    { exec: [program, ...args], local?, cwd? }   run a program (on `on`, or here if local)
//   command: { command, args? }                           any Herdr command, including <mod>.<command>
//   overlay: { overlay: { mod, kind?, width?, height?, props? } }   open your own mod with the item
// Strings in task, tab, folder, exec, cwd, args and overlay.props fill {placeholders}
// from the item (docs/actions.md lists them). exec never goes through a shell: put
// placeholders in their own arguments, not inside an `sh -c` script. A placeholder that
// is a whole argument may not fill in something starting with "-" (it would read as an
// option): runAction refuses it.

// The fields an action sees for a request or an issue (see docs/actions.md).
export function requestItem(r, project) {
  return {
    kind: "request", iid: r.iid, ref: `${project.terms.reqPrefix}${r.iid}`, title: r.title, url: r.url,
    repo: project.repo, host: project.host, provider: project.provider, author: r.author ?? null,
    labels: r.labels ?? [], created_ms: r.created_ms ?? null, source: r.source ?? null, target: r.target ?? null,
    sha: r.sha ?? null, draft: Boolean(r.draft), conflicts: Boolean(r.conflicts), ci_status: r.ci?.status ?? null,
    fork: Boolean(r.fork),
  };
}

export function issueItem(i, project, sep = "::") {
  const scoped = {};
  for (const l of i.labels ?? []) {
    const k = l.lastIndexOf(sep);
    if (k > 0) scoped[l.slice(0, k)] = l.slice(k + sep.length);
  }
  return {
    kind: "issue", iid: i.iid, ref: `#${i.iid}`, title: i.title, url: i.url,
    repo: project.repo, host: project.host, provider: project.provider, author: i.author ?? null,
    labels: i.labels ?? [], created_ms: i.created_ms ?? null, state: i.state, assignees: i.assignees ?? [],
    milestone: i.milestone?.title ?? null, scoped,
  };
}

// The folder with a request's branch checked out, on `on`: its worktree if it has one,
// else a new one next to Herdr's (~/.herdr/worktrees/<repo>/<branch>). Runs in the main
// checkout with the branch as $1; prints the folder.
export const WORKTREE = `b="$1"
wt=$(git worktree list --porcelain | awk -v ref="refs/heads/$b" '/^worktree /{w=substr($0,10)} $0=="branch "ref{print w; exit}')
if [ -z "$wt" ]; then
  git fetch -q origin "$b" || exit 1
  wt="$HOME/.herdr/worktrees/$(basename "$PWD")/$(printf %s "$b" | tr / -)"
  git worktree add -q "$wt" "$b" >&2 || exit 1
fi
printf %s "$wt"`;

export function fill(v, ctx) {
  if (typeof v === "string") {
    return v.replace(/\{([\w.]+)\}/g, (m, path) => {
      const x = path.split(".").reduce((o, k) => (o == null ? o : o[k]), ctx);
      return x == null ? m : Array.isArray(x) ? x.join(",") : String(x);
    });
  }
  if (Array.isArray(v)) return v.map((x) => fill(x, ctx));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x, ctx)]));
  return v;
}

const asList = (v) => (Array.isArray(v) ? v : [v]);

// when: { labels: all of, without: none of, minAgeHours, <field>: value | [values] }.
export function matches(when, ctx, now = Date.now()) {
  if (!when) return true;
  for (const [k, v] of Object.entries(when)) {
    if (k === "labels") { if (!asList(v).every((l) => ctx.labels?.includes(l))) return false; }
    else if (k === "without") { if (asList(v).some((l) => ctx.labels?.includes(l))) return false; }
    else if (k === "minAgeHours") { if (!(ctx.created_ms != null && now - ctx.created_ms >= v * 3600000)) return false; }
    else if (Array.isArray(v)) { if (!v.includes(ctx[k])) return false; }
    else if (ctx[k] !== v) return false;
  }
  return true;
}

// Registered actions older than this are dropped: a mod that registers refreshes its
// entry (re-registers) at least every half hour, so an uninstalled or crashed one's
// buttons go away by themselves.
export const REGISTRATION_TTL = 3600000;

// The actions a mod shows: props.actions (null: the mod's defaults; "defaults" inside
// it: the defaults there), then ones other mods registered in shared state
// ({ owner: { at, actions } }). The first action with an id wins.
export function actionList(fromProps, defaults = [], registered = null, now = Date.now()) {
  const base = fromProps == null ? defaults : asList(fromProps).flatMap((a) => (a === "defaults" ? defaults : [a]));
  const extra = registered && typeof registered === "object"
    ? Object.values(registered).filter((r) => r && now - (r.at ?? 0) < REGISTRATION_TTL).flatMap((r) => asList(r.actions ?? []))
    : [];
  const seen = new Set(), out = [];
  for (const a of [...base, ...extra]) {
    if (!a || typeof a !== "object" || !a.id || !a.label || seen.has(a.id)) continue;
    seen.add(a.id);
    out.push(a);
  }
  return out;
}

export function describe(a) {
  if (a.tooltip) return a.tooltip;
  if (isAgentAction(a)) return `Starts ${a.agent ?? "claude"} in a new tab`;
  if (a.exec) return `Run ${asList(a.exec)[0]}`;
  if (a.command) return `Run ${a.command}`;
  if (a.overlay) return `Open ${a.overlay.mod}`;
  return a.label;
}

// Agent actions (they start a tab with an agent) vs the rest, as runAction tells them apart.
export const isAgentAction = (a) => a.task != null || Boolean(a.agent);

// A button's text: ✦ marks every action that starts an agent, the defaults and yours alike,
// so it's clear which buttons hand work to AI and which act at once.
export const AGENT_MARK = "✦";
export function actionLabel(a) {
  return isAgentAction(a) ? `${AGENT_MARK} ${a.label}` : a.label;
}

// Where agents start for a project: props.folder, else a space on `on` whose folder is
// named after the repo, exactly: "shop" or "acme-shop" for acme/shop (not "other-shop",
// which is some other project), else null.
export function checkoutOf(folder, spaces, on, repo) {
  if (folder) return folder;
  const parts = (repo ?? "").split("/");
  const name = parts[parts.length - 1];
  if (!name) return null;
  const names = new Set([name]);
  if (parts.length > 1) names.add(`${parts[parts.length - 2]}-${name}`);
  return spaces.find((s) => (s.machine ?? null) === (on ?? null) && typeof s.folder === "string"
    && names.has(s.folder.replace(/\/+$/, "").split("/").pop()))?.folder ?? null;
}

// Fills a list of arguments, refusing a whole-argument placeholder that turns into an option.
function fillArgs(list, ctx) {
  return asList(list).map((t) => {
    const v = fill(t, ctx);
    if (typeof t === "string" && /^\{[\w.]+\}$/.test(t) && typeof v === "string" && v.startsWith("-")) {
      throw new Error(`Refusing ${t} = "${v}": it would read as an option.`);
    }
    return v;
  });
}

// Runs one action for one item. env: { on, folder } from the mod's props (folder: the
// checkout agents start in). h: Herdr's { exec, run, spaces, knownAgents, openOverlay }.
// Resolves with { text?, tab? }.
export async function runAction(a, ctx, env, h) {
  const on = env.on ?? null;
  if (a.task != null || a.agent) {
    let folder = fill(a.folder, ctx) ?? env.folder;
    if (!folder) throw new Error("No checkout set (props.folder).");
    if (a.worktree) {
      // The worktree is found and fetched by branch name in our repo: a fork's branch of
      // the same name would be someone else's code, or not there at all.
      if (ctx.fork) throw new Error("This request comes from a fork: check out fork MRs by hand.");
      if (!ctx.source || ctx.source.startsWith("-")) throw new Error("No branch to check out.");
      const r = await h.exec("sh", ["-c", WORKTREE, "sh", ctx.source], { cwd: folder, on });
      if (r.code !== 0 || !r.stdout.trim()) throw new Error(r.stderr.trim() || `Couldn't check out ${ctx.source}`);
      folder = r.stdout.trim();
    }
    const key = a.agent ?? "claude";
    const agent = (await h.knownAgents({ on })).find((x) => x.key === key && x.installed);
    if (!agent) throw new Error(`${key} isn't installed on ${on ?? "this computer"}.`);
    const tab = fill(a.tab ?? `${a.id} ${ctx.ref ?? ""}`.trim(), ctx);
    const task = fill(a.task ?? "", ctx);
    const space = h.spaces().find((s) => s.machine === on && s.folder === folder);
    if (space) h.run("tab.new", { name: tab, space: space.id, folder, argv: agent.run, task });
    else h.run("space.new", { folder, machine: on, tab, argv: agent.run, task });
    return { tab, text: `Started ${agent.name ?? key} in "${tab}"` };
  }
  if (a.exec) {
    const [cmd, ...args] = fillArgs(a.exec, ctx);
    const cwd = fill(a.cwd, ctx) ?? env.folder ?? undefined;
    const r = await h.exec(cmd, args, { on: a.local ? null : on, ...(cwd && !a.local ? { cwd } : {}) });
    const last = (s) => (s ?? "").trim().split("\n").filter(Boolean).pop();
    if (r.code !== 0) throw new Error(last(r.stderr) || last(r.stdout) || `${cmd} exited ${r.code}`);
    return { text: last(r.stdout) || `${a.label}: done` };
  }
  if (a.command) {
    h.run(a.command, fill(a.args ?? {}, ctx));
    return {};
  }
  if (a.overlay?.mod) {
    const { mod, kind = "dialog", width = 520, height = 420, props = {} } = a.overlay;
    h.openOverlay({ mod, kind, width, height, props: { ...fill(props, ctx), item: ctx, action: a.id, on, folder: env.folder ?? null } });
    return {};
  }
  throw new Error(`Action ${a.id} has nothing to do: give it agent/task, exec, command or overlay.`);
}
