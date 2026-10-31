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
  if (/(^|\.)github\.com$/.test(host)) return "github";
  if (/(^|\.)(bitbucket\.org|codeberg\.org|sr\.ht)$/.test(host)) return null;
  return "gitlab";
}

// { provider, host, repo, on, terms } from a mod's props. provider defaults from host,
// host from provider; with neither it's GitLab on gitlab.com.
export function projectOf(p = {}) {
  const provider = p.provider ?? (p.host ? providerForHost(p.host, p.forges) : null) ?? "gitlab";
  const terms = TERMS[provider] ?? TERMS.gitlab;
  return { provider, host: p.host ?? terms.host, repo: p.repo ?? "", on: p.on ?? null, terms };
}

// git@host:group/proj.git, https://host/group/proj.git, ssh://git@host:22/group/proj
export function parseRemote(url) {
  const m = /^[\w.-]+@([^:/]+):(.+?)(?:\.git)?\/?$/.exec(url ?? "")
    ?? /^\w+:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/.exec(url ?? "");
  return m ? { host: m[1], path: m[2] } : null;
}

// ---- running forge.py ----

const PYTHONS = ["python3", "/usr/bin/python3", "/opt/homebrew/bin/python3", "/usr/local/bin/python3"];
const DIR = "~/.local/share/herdr-forge";

// Runs the installed copy of this exact version, or says it isn't there.
const boot = (ver) => `import os,sys
p=os.path.expanduser("${DIR}/forge-${ver}.py")
if not os.path.exists(p):
    print('{"install": true}'); sys.exit(0)
sys.argv=[p]+sys.argv[1:]
exec(compile(open(p).read(),p,"exec"),{"__name__":"__main__","__file__":p})`;

// Writes forge-<version>.py (what boot runs) and forge.py (a stable path for agents and
// skills), and clears versions untouched for a week.
const INSTALL = `import os,sys,glob,time
d=os.path.expanduser("${DIR}"); os.makedirs(d,exist_ok=True)
v,t=sys.argv[1],sys.argv[2]
for n in ("forge-%s.py"%v,"forge.py"):
    f=os.path.join(d,n)
    with open(f+".tmp","w") as o: o.write(t)
    os.replace(f+".tmp",f)
for f in glob.glob(os.path.join(d,"forge-*.py")):
    if not f.endswith("forge-%s.py"%v) and time.time()-os.path.getmtime(f)>7*86400: os.remove(f)
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

// Whether a block showing this mod (with these props, where given) is on screen: not
// hidden, not under a hidden node, not an inactive child of a stack. Herdr keeps hidden
// mods running, so polling mods check this. A mod that isn't in the layout tree at all
// (a tab pane, an overlay) counts as shown.
export function isShown(tree, mod, match = {}) {
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
  return !found || shown;
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
// placeholders in their own arguments, not inside an `sh -c` script.

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

// The actions a mod shows: props.actions (null: the mod's defaults; "defaults" inside
// it: the defaults there), then ones other mods registered in shared state
// ({ owner: [actions] }). The first action with an id wins.
export function actionList(fromProps, defaults = [], registered = null) {
  const base = fromProps == null ? defaults : asList(fromProps).flatMap((a) => (a === "defaults" ? defaults : [a]));
  const extra = registered && typeof registered === "object" ? Object.values(registered).flatMap(asList) : [];
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
  if (a.task != null || a.agent) return `Start ${a.agent ?? "claude"} in a new tab`;
  if (a.exec) return `Run ${asList(a.exec)[0]}`;
  if (a.command) return `Run ${a.command}`;
  if (a.overlay) return `Open ${a.overlay.mod}`;
  return a.label;
}

// Runs one action for one item. env: { on, folder } from the mod's props (folder: the
// checkout agents start in; a worktree for some request actions). h: Herdr's
// { exec, run, spaces, knownAgents, openOverlay }. Resolves with { text?, tab? }.
export async function runAction(a, ctx, env, h) {
  const on = env.on ?? null;
  if (a.task != null || a.agent) {
    const folder = fill(a.folder, ctx) ?? env.folder;
    if (!folder) throw new Error("No checkout set (props.folder).");
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
    const [cmd, ...args] = fill(asList(a.exec), ctx);
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
