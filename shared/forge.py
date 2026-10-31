# forge.py: the cache and API layer behind the forge-* Herdr mods.
#
# The mods run it on the machine where the forge's CLI is logged in (glab for GitLab,
# gh for GitHub). It keeps one SQLite database per project:
#   ~/.local/share/herdr-forge/<host>/<owner__project>.db
# and answers each command with one JSON object on stdout. Reads take a max age in
# seconds: an answer that fresh comes from the database, and while one process fetches,
# the others get the last answer instead of fetching too. Writes go to the forge first
# and drop the cached answers they change. A rate limit pauses every project on that host.
#
#   python3 -I forge.py <command> <provider> <host> <owner/project> [args...]
#   python3 -I forge.py commits <top> <ref> <range> <now_ms> <tz_offset_min> <force 0|1>
#   python3 -I forge.py skill <status|install> <name> <text>
#   python3 -I forge.py version
#
# docs/contract.md lists every command and the shapes it returns, and which commands
# agents may rely on. Every mod folder carries a copy of this file stamped with its
# version; edit shared/forge.py and run `npm run sync`.

VERSION = "0.0.0+dev"

import json, os, random, re, sqlite3, subprocess, sys, time, urllib.parse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime

HOME = os.environ.get("HERDR_FORGE_HOME") or os.path.join(
    os.environ.get("XDG_DATA_HOME") or os.path.expanduser("~/.local/share"), "herdr-forge")
PATH = os.pathsep.join(d for d in [
    os.environ.get("HERDR_FORGE_BIN"),  # tests put a fake glab here
    "/opt/homebrew/bin", "/usr/local/bin", "/home/linuxbrew/.linuxbrew/bin",
    os.path.expanduser("~/.local/bin"), *os.environ.get("PATH", "").split(os.pathsep),
] if d)  # an empty entry would mean the current folder
ENV = {**os.environ, "PATH": PATH, "NO_COLOR": "1", "GIT_TERMINAL_PROMPT": "0"}

# Bump when any answer's shape changes: cached answers of another shape are misses, so
# mods of different versions on one machine never read each other's shapes.
SHAPES = 1
DAY = 86400000
KEEP = 85 * DAY                 # velocity history kept
BUDGET = float(os.environ.get("HERDR_FORGE_BUDGET") or 18)  # seconds of work per call: Herdr stops a program at 30
CLI_TIMEOUT = float(os.environ.get("HERDR_FORGE_CLI_TIMEOUT") or 15)
LEASE = 30                      # seconds one process may hold a fetch before others retry it
MIN_GAP = 45                    # seconds between incremental issue syncs
META_EVERY = 3600               # labels and milestones for the issue browser
RECONCILE_EVERY = 3600          # look for deleted issues
RUNNER_DETAILS_EVERY = 600
CACHE_DAYS = 7                  # cached answers nobody asked for in a week are deleted
PRIORITIES = ["blocker", "critical", "high", "medium", "low"]
START = time.time()


class Busy(RuntimeError):
    """The forge rate-limited us; we're waiting before asking again."""


class NoCli(RuntimeError):
    """The forge's CLI isn't installed on this machine."""


# What a failed fetch can raise: a forge error, a timeout, an answer that isn't JSON or
# isn't shaped as expected. All of them keep the last good answer.
FETCH_ERRORS = (RuntimeError, ValueError, KeyError, TypeError, IndexError, OSError, subprocess.SubprocessError)


def release(version):
    """"1.2.3+abc" -> (1, 2, 3), for comparing versions."""
    try:
        return tuple(int(x) for x in version.split("+")[0].split("."))
    except ValueError:
        return (0,)


def over_budget():
    return time.time() - START > BUDGET


def ms(iso):
    if not iso:
        return None
    return int(datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp() * 1000)


def ref_label(ref):
    """refs/merge-requests/811/head -> !811; branches stay as they are."""
    m = re.match(r"^refs/merge-requests/(\d+)/", ref or "")
    return f"!{m.group(1)}" if m else (ref or "")


def scoped_of(labels, sep):
    """{scope: value} for labels like "priority::high"; the last separator wins."""
    out = {}
    for l in labels:
        k = l.rfind(sep)
        if k > 0:
            out[l[:k]] = l[k + len(sep):]
    return out


def median(xs):
    if not xs:
        return None
    s = sorted(xs)
    m = len(s) // 2
    return s[m] if len(s) % 2 else (s[m - 1] + s[m]) / 2


def connect(path, migrations):
    """Opens a database and brings it up to date. Migrations only ever add (tables,
    columns, indexes) and every statement names its columns, so an older forge.py keeps
    working on a database a newer one migrated."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    db = sqlite3.connect(path, timeout=15, isolation_level=None)
    db.execute("PRAGMA busy_timeout=15000")
    db.execute("PRAGMA journal_mode=WAL")
    if db.execute("PRAGMA user_version").fetchone()[0] < len(migrations):
        db.execute("BEGIN IMMEDIATE")
        try:
            v = db.execute("PRAGMA user_version").fetchone()[0]
            for i in range(v, len(migrations)):
                for stmt in migrations[i]:
                    db.execute(stmt)
            db.execute(f"PRAGMA user_version={max(v, len(migrations))}")
            db.execute("COMMIT")
        except BaseException:
            db.execute("ROLLBACK")
            raise
    db.isolation_level = ""  # back to implicit transactions, committed by hand
    return db


# ---- velocity buckets (shared by the project's requests/issues and the repo's commits) ----

def buckets(rng, now_ms, tz):
    """(n, size, start): 30 calendar days ending today in the viewer's time zone
    (tz = JS getTimezoneOffset(), minutes), or 12 rolling weeks ending now."""
    if rng == "30d":
        local = now_ms - tz * 60000
        end = (local // DAY + 1) * DAY + tz * 60000
        return 30, DAY, end - 30 * DAY
    return 12, 7 * DAY, now_ms - 84 * DAY


def count_row(key, times, b, now_ms):
    n, size, start = b
    values = [0] * n
    for t in times:
        i = (t - start) // size
        if 0 <= i < n:
            values[int(i)] += 1
    week, all_ = now_ms - 7 * DAY, now_ms - 84 * DAY
    return {"key": key, "values": values,
            "now": sum(1 for t in times if t >= week),
            "avg": sum(1 for t in times if t >= all_) / 12}


def cycle_row(key, pairs, b, now_ms):
    """pairs: (merged_ms, created_ms). Median time to merge per bucket, in ms."""
    n, size, start = b
    per = [[] for _ in range(n)]
    for m, c in pairs:
        i = (m - start) // size
        if 0 <= i < n:
            per[int(i)].append(m - c)
    week, all_ = now_ms - 7 * DAY, now_ms - 84 * DAY
    return {"key": key, "unit": "duration", "lowerBetter": True, "values": [median(x) for x in per],
            "now": median([m - c for m, c in pairs if m >= week]),
            "avg": median([m - c for m, c in pairs if m >= all_])}


# ---- providers: each turns its forge's API into the shapes in docs/contract.md ----

class GitLab:
    name = "gitlab"
    cli = "glab"
    sep = "::"

    def __init__(self, p):
        self.p = p
        self.project = "projects/" + urllib.parse.quote(p.repo, safe="")
        self.url = f"https://{p.host}/{p.repo}"

    # -- transport --

    @staticmethod
    def retry_after(err):
        """Seconds to wait when an error is the forge's rate limit, else None."""
        return 120 if re.search(r"\b429\b.*(too many|rate)|too many requests", err, re.I) else None

    def run(self, argv):
        self.p.check_backoff()
        try:
            r = subprocess.run(["glab", *argv], capture_output=True, text=True, env=ENV, timeout=CLI_TIMEOUT)
        except FileNotFoundError:
            raise NoCli("glab isn't installed on this machine")
        except subprocess.TimeoutExpired:
            raise RuntimeError(f"glab took longer than {CLI_TIMEOUT}s")
        if r.returncode != 0:
            err = (r.stderr or r.stdout).strip() or f"glab exited {r.returncode}"
            wait = self.retry_after(err)
            if wait:
                self.p.backoff(wait)
            raise RuntimeError(err[-500:])
        return r.stdout

    def json(self, text):
        try:
            return json.loads(text or "null")
        except ValueError:
            raise RuntimeError(f"glab's answer isn't JSON: {text[:120]!r}")

    def api(self, path, method="GET", fields=None):
        argv = ["api", "--hostname", self.p.host]
        if method != "GET":
            argv += ["-X", method]
        for k, v in (fields or {}).items():
            argv += ["-f", f"{k}={v}"]
        return self.json(self.run(argv + [path]))

    def pages(self, path, per=100):
        """Yields one page at a time, so callers can save progress and stop on budget."""
        page = 1
        sep = "&" if "?" in path else "?"
        while True:
            batch = self.api(f"{path}{sep}per_page={per}&page={page}")
            yield batch
            if len(batch) < per:
                return
            page += 1

    def all_pages(self, path, per=100):
        return [x for batch in self.pages(path, per) for x in batch]

    def gql(self, query, variables=None):
        argv = ["api", "--hostname", self.p.host, "graphql", "-f", f"query={query}"]
        for k, v in (variables or {}).items():
            if v is not None:
                argv += ["-F" if isinstance(v, int) else "-f", f"{k}={v}"]
        out = self.json(self.run(argv))
        if out.get("errors"):
            raise RuntimeError(out["errors"][0].get("message", "GraphQL error"))
        return out["data"]

    # -- merge requests --

    def requests(self):
        out = []
        for m in self.api(f"{self.project}/merge_requests?state=opened&order_by=updated_at&per_page=50"):
            status = m.get("detailed_merge_status")
            out.append({
                "iid": m["iid"], "title": m["title"], "url": m["web_url"],
                "draft": bool(m.get("draft") or m.get("work_in_progress")),
                "auto_merge": bool(m.get("merge_when_pipeline_succeeds")),
                # Right after a push GitLab says "unchecked"/"checking" and has_conflicts
                # still holds the old answer.
                "conflicts": status == "conflict" or (bool(m.get("has_conflicts")) and status not in ("unchecked", "checking")),
                "source": m.get("source_branch"), "target": m.get("target_branch"), "sha": m.get("sha"),
                "author": (m.get("author") or {}).get("username"), "labels": m.get("labels") or [],
                "created_ms": ms(m["created_at"]), "updated_ms": ms(m["updated_at"]),
            })
        return out

    def request_ci(self):
        """{sha: ci}: the newest pipeline per commit."""
        out = {}
        for p in self.api(f"{self.project}/pipelines?per_page=50"):
            out.setdefault(p["sha"], {"id": p["id"], "status": p["status"], "url": p["web_url"], "updated_ms": ms(p["updated_at"])})
        return out

    def merge(self, iid, sha):
        # glab sets auto-merge instead while the pipeline still runs. --sha: merge only the
        # commit the person saw.
        argv = ["mr", "merge", str(iid), "-R", self.url, "--yes"]
        if sha:
            argv += ["--sha", sha]
        lines = [l for l in self.run(argv).splitlines() if l.strip()]
        return lines[-1] if lines else "Merged"

    # -- CI --

    def pipelines(self):
        return [{
            "id": p["id"], "iid": p.get("iid"), "ref": ref_label(p.get("ref")), "sha": p.get("sha"),
            "status": p["status"], "source": "MR" if p.get("source") == "merge_request_event" else (p.get("source") or ""),
            "updated_ms": ms(p.get("updated_at")), "url": p["web_url"],
        } for p in self.api(f"{self.project}/pipelines?per_page=20")]

    def jobs(self, pid):
        jobs = self.api(f"{self.project}/pipelines/{pid}/jobs?per_page=100&include_retried=false")
        jobs.sort(key=lambda j: j["id"])
        return [{"id": j["id"], "name": j["name"], "group": j.get("stage"), "status": j["status"],
                 "duration": j.get("duration"), "allow_failure": bool(j.get("allow_failure")), "url": j["web_url"]}
                for j in jobs]

    def pipeline_act(self, pid, what):
        self.api(f"{self.project}/pipelines/{pid}/{what}", "POST")

    def runners(self):
        return [{
            "id": r["id"], "name": r.get("description") or r.get("name") or f"#{r['id']}",
            "status": r.get("status"), "paused": bool(r.get("paused")),
            "url": f"{self.url}/-/runners/{r['id']}",
        } for r in self.api(f"{self.project}/runners?type=project_type&per_page=50")]

    def runner_details(self, rid):
        d = self.api(f"runners/{rid}")
        return {"tags": d.get("tag_list") or [], "run_untagged": d.get("run_untagged") is not False,
                "version": d.get("version"), "platform": d.get("platform"), "arch": d.get("architecture"),
                "contacted_ms": ms(d.get("contacted_at"))}

    def ci_jobs(self):
        """Running and pending jobs of the project."""
        return [{
            "id": j["id"], "name": j["name"], "group": j.get("stage"), "status": j["status"],
            "started_ms": ms(j.get("started_at")), "created_ms": ms(j.get("created_at")),
            "tags": j.get("tag_list") or [],
            "runner": {"id": j["runner"]["id"], "name": j["runner"].get("description")} if j.get("runner") else None,
            "ref": ref_label((j.get("pipeline") or {}).get("ref") or j.get("ref")),
            "pipeline": (j.get("pipeline") or {}).get("id"), "url": j["web_url"],
        } for j in self.api(f"{self.project}/jobs?scope[]=running&scope[]=pending&per_page=100")]

    # -- milestones --

    def milestones(self):
        ms_ = self.api(f"{self.project}/milestones?state=active&per_page=100")

        def stats(m):
            s = self.api(f"{self.project}/issues_statistics?milestone={urllib.parse.quote(m['title'])}")
            return (s or {}).get("statistics", {}).get("counts", {})

        with ThreadPoolExecutor(4) as pool:
            counts = list(pool.map(stats, ms_))
        return [{"id": m["id"], "title": m["title"], "due": m.get("due_date"), "url": m["web_url"],
                 "open": c.get("opened", 0), "closed": c.get("closed", 0), "all": c.get("all", 0)}
                for m, c in zip(ms_, counts)]

    def milestone_items(self, title):
        items = self.api(f"{self.project}/issues?milestone={urllib.parse.quote(title)}&state=all&per_page=100&order_by=updated_at")
        items.sort(key=lambda i: i["state"] != "opened")
        return [{"id": i["id"], "iid": i["iid"], "title": i["title"], "state": i["state"],
                 "assignees": [a["username"] for a in i.get("assignees") or []], "url": i["web_url"]} for i in items]

    # -- velocity --

    MR_Q = ("query($p:ID!,$t:Time,$after:String){project(fullPath:$p){mergeRequests(state:merged,mergedAfter:$t,"
            "first:100,after:$after){pageInfo{hasNextPage endCursor} nodes{iid mergedAt createdAt}}}}")
    ISSUE_Q = ("query($p:ID!,$t:Time,$after:String){project(fullPath:$p){issues(state:closed,closedAfter:$t,"
               "first:100,after:$after){pageInfo{hasNextPage endCursor} nodes{iid closedAt}}}}")

    def _nodes(self, q, field, since):
        """Every node since `since`, and whether that's all of them (False: out of time)."""
        out, after = [], None
        while True:
            project = self.gql(q, {"p": self.p.repo, "t": since, "after": after})["project"]
            if not project:
                raise RuntimeError("project not found")
            conn = project[field]
            out += conn["nodes"]
            if not conn["pageInfo"]["hasNextPage"]:
                return out, True
            if over_budget():
                return out, False
            after = conn["pageInfo"]["endCursor"]

    def velocity(self, since_iso):
        mrs, done1 = self._nodes(self.MR_Q, "mergeRequests", since_iso)
        issues, done2 = self._nodes(self.ISSUE_Q, "issues", since_iso) if done1 else ([], False)
        return ([(int(n["iid"]), ms(n["mergedAt"]), ms(n["createdAt"])) for n in mrs],
                [(int(n["iid"]), ms(n["closedAt"])) for n in issues], done1 and done2)

    # -- issues --

    def issue(self, i):
        m = i.get("milestone")
        return {
            "iid": i["iid"], "id": i["id"], "title": i["title"], "description": i.get("description") or "",
            "state": i["state"], "labels": i.get("labels") or [],
            "milestone": {"id": m["id"], "title": m["title"], "due": m.get("due_date")} if m else None,
            "assignees": [a["username"] for a in i.get("assignees") or []],
            "author": (i.get("author") or {}).get("username"),
            "created_at": i["created_at"], "updated_at": i["updated_at"], "closed_at": i.get("closed_at"),
            "notes": i.get("user_notes_count", 0), "requests": i.get("merge_requests_count", 0),
            "weight": i.get("weight"), "blocking": i.get("blocking_issues_count", 0), "url": i["web_url"],
        }

    def issue_pages(self, cursor):
        """Pages of issues changed since `cursor` (inclusive), oldest change first."""
        q = f"{self.project}/issues?scope=all&state=all&order_by=updated_at&sort=asc"
        if cursor:
            q += "&updated_after=" + urllib.parse.quote(cursor)
        for batch in self.pages(q):
            yield [self.issue(i) for i in batch]

    def issue_get(self, iid):
        return self.issue(self.api(f"{self.project}/issues/{iid}"))

    def issue_iids(self):
        q = ("query($path: ID!, $after: String) { project(fullPath: $path) {"
             " issues(first: 100, after: $after) { pageInfo { endCursor hasNextPage } nodes { iid } } } }")
        alive, after = set(), None
        while True:
            page = self.gql(q, {"path": self.p.repo, "after": after})["project"]["issues"]
            alive |= {int(n["iid"]) for n in page["nodes"]}
            if not page["pageInfo"]["hasNextPage"]:
                return alive
            if over_budget():
                return None  # not all of them: drop nothing
            after = page["pageInfo"]["endCursor"]

    def labels(self):
        return [{"name": l["name"], "color": l["color"], "description": l.get("description")}
                for l in self.all_pages(f"{self.project}/labels")]

    def active_milestones(self):
        return [{"id": m["id"], "title": m["title"], "due": m.get("due_date")}
                for m in self.all_pages(f"{self.project}/milestones?state=active")]

    def issue_detail(self, iid):
        notes = [n for n in self.all_pages(f"{self.project}/issues/{iid}/notes?sort=asc") if not n.get("system")]
        mrs = self.api(f"{self.project}/issues/{iid}/related_merge_requests?per_page=50")
        return {
            "notes": [{"author": n["author"]["username"], "body": n["body"], "at_ms": ms(n["created_at"])} for n in notes],
            "requests": [{"iid": m["iid"], "title": m["title"], "state": m["state"], "draft": bool(m.get("draft")),
                          "source": m.get("source_branch"), "url": m["web_url"]} for m in mrs],
        }

    def issue_update(self, iid, f):
        """f: {add_labels: [..], remove_labels: [..], milestone: id | None, state: "opened" | "closed"}"""
        fields = {}
        if f.get("add_labels"):
            fields["add_labels"] = ",".join(f["add_labels"])
        if f.get("remove_labels"):
            fields["remove_labels"] = ",".join(f["remove_labels"])
        if "milestone" in f:
            fields["milestone_id"] = f["milestone"] or 0
        if f.get("state"):
            fields["state_event"] = "close" if f["state"] == "closed" else "reopen"
        return self.issue(self.api(f"{self.project}/issues/{iid}", "PUT", fields))

    def issue_comment(self, iid, body):
        self.api(f"{self.project}/issues/{iid}/notes", "POST", {"body": body})


class GitHub:
    name = "github"
    cli = "gh"
    sep = ": "

    def __init__(self, p):
        raise RuntimeError("GitHub support is coming in a later release")


PROVIDERS = {"gitlab": GitLab, "github": GitHub}


# ---- one project's database ----
# Rebuildable (dropped and fetched again if ever needed): cache, issues, issues_fts,
# details, merged, closed. The person's own state (migrate with care): triage, launches,
# meta (separator, sync cursor).

MIGRATIONS = [[
    "CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT)",
    "CREATE TABLE IF NOT EXISTS cache(k TEXT PRIMARY KEY, at REAL, json TEXT, shape INTEGER, lease REAL DEFAULT 0, etag TEXT)",
    "CREATE INDEX IF NOT EXISTS cache_at ON cache(at)",
    """CREATE TABLE IF NOT EXISTS issues(
      iid INTEGER PRIMARY KEY, id INTEGER, title TEXT, description TEXT, state TEXT,
      labels TEXT, milestone TEXT, assignees TEXT, author TEXT, created_at TEXT, updated_at TEXT,
      closed_at TEXT, notes INTEGER, requests INTEGER, weight INTEGER, blocking INTEGER, url TEXT,
      written_at REAL)""",
    "CREATE INDEX IF NOT EXISTS issues_written ON issues(written_at)",
    "CREATE VIRTUAL TABLE IF NOT EXISTS issues_fts USING fts5(iid UNINDEXED, title, description)",
    "CREATE TABLE IF NOT EXISTS details(iid INTEGER PRIMARY KEY, for_updated_at TEXT, json TEXT)",
    "CREATE TABLE IF NOT EXISTS launches(id INTEGER PRIMARY KEY, iid INTEGER, action TEXT, tab TEXT, at REAL)",
    """CREATE TABLE IF NOT EXISTS triage(iid INTEGER PRIMARY KEY, rank INTEGER, priority TEXT, reason TEXT,
      status TEXT DEFAULT 'proposed', at REAL, locked INTEGER DEFAULT 0)""",
    "CREATE TABLE IF NOT EXISTS merged(iid INTEGER PRIMARY KEY, merged_ms INTEGER, created_ms INTEGER)",
    "CREATE TABLE IF NOT EXISTS closed(iid INTEGER PRIMARY KEY, closed_ms INTEGER)",
]]

ISSUE_COLS = "iid,title,state,labels,milestone,assignees,author,created_at,updated_at,closed_at,notes,requests,weight,blocking,url"


class Project:
    def __init__(self, provider, host, repo):
        if provider not in PROVIDERS:
            raise RuntimeError(f"unsupported forge {provider}")
        if not re.fullmatch(r"[\w.-]+", host) or ".." in repo or not re.fullmatch(r"[\w.-]+(/[\w.-]+)+", repo):
            raise RuntimeError(f"bad project {host}/{repo}")
        self.host, self.repo = host, repo
        self.nocli = False  # set when the forge's CLI is missing; main() adds it to the answer
        self.db = connect(os.path.join(HOME, host, repo.replace("/", "__") + ".db"), MIGRATIONS)
        self.forge = PROVIDERS[provider](self)
        self.sep = self.meta("scope_sep", self.forge.sep)

    # -- bookkeeping --

    def meta(self, k, default=None):
        r = self.db.execute("SELECT v FROM meta WHERE k=?", (k,)).fetchone()
        return json.loads(r[0]) if r else default

    def set_meta(self, k, v):
        self.db.execute("INSERT OR REPLACE INTO meta(k, v) VALUES(?,?)", (k, json.dumps(v)))

    def write(self, sql, params):
        self.db.execute(sql, params)
        self.db.commit()
        return {"ok": True}

    # Rate limits are per account and host, so the pause is too: one file per host.
    def _backoff_file(self):
        return os.path.join(HOME, self.host, "backoff")

    def check_backoff(self):
        try:
            with open(self._backoff_file()) as f:
                until = float(f.read() or 0)
        except (OSError, ValueError):
            return
        if time.time() < until:
            raise Busy(f"rate-limited by {self.host}: trying again in {int(until - time.time())}s")

    def backoff(self, seconds):
        tmp = f"{self._backoff_file()}.{os.getpid()}"
        with open(tmp, "w") as f:
            f.write(str(time.time() + seconds))
        os.replace(tmp, self._backoff_file())

    def cached(self, k, max_age, fetch, default, force=False):
        """(data, fetched_at, error).
        max_age < 0 takes any cached answer (a mod's first read, so it draws at once).
        While another process fetches the same answer, this one gets the last answer.
        A failed fetch keeps the last answer and says why; with none, `default`."""
        now = time.time()
        row = self.db.execute("SELECT at, json, lease FROM cache WHERE k=? AND shape=?", (k, SHAPES)).fetchone()
        if row and not force and (max_age < 0 or now - row[0] < max_age):
            return json.loads(row[1]), row[0], None
        if row:
            got = self.db.execute("UPDATE cache SET lease=? WHERE k=? AND lease<=?", (now + LEASE, k, now)).rowcount
            self.db.commit()
            if not got and not force:
                return json.loads(row[1]), row[0], None
        try:
            data = fetch()
        except FETCH_ERRORS as e:
            self.nocli = self.nocli or isinstance(e, NoCli)
            if row:
                self.write("UPDATE cache SET lease=0 WHERE k=?", (k,))
                return json.loads(row[1]), row[0], str(e) or type(e).__name__
            return default, 0, str(e) or type(e).__name__
        self.db.execute("INSERT OR REPLACE INTO cache(k, at, json, shape, lease) VALUES(?,?,?,?,0)",
                        (k, now, json.dumps(data), SHAPES))
        if random.random() < 0.05:
            self.db.execute("DELETE FROM cache WHERE at < ?", (now - CACHE_DAYS * 86400,))
        self.db.commit()
        return data, now, None

    def drop(self, *keys):
        """Forget cached answers: "pipelines" drops it and every "pipelines:..." key."""
        for k in keys:
            self.db.execute("DELETE FROM cache WHERE k=? OR k LIKE ?", (k, k + ":%"))
        self.db.commit()

    # -- requests (MRs / PRs) --

    def requests(self, max_age, force):
        reqs, at, err = self.cached("requests", max_age, self.forge.requests, [], force)
        ci = self.cached("request-ci", max_age, self.forge.request_ci, {}, force)[0]
        for r in reqs:
            r["ci"] = ci.get(r["sha"])
        return {"requests": reqs, "at": at, "error": err}

    def merge(self, iid, sha):
        text = self.forge.merge(iid, sha)
        self.drop("requests", "request-ci", "pipelines", "velocity")
        return {"ok": True, "text": text}

    # -- CI --

    def pipelines(self, max_age, force):
        pls, at, err = self.cached("pipelines", max_age, self.forge.pipelines, [], force)
        return {"pipelines": pls, "at": at, "error": err}

    def jobs(self, pid, max_age, force):
        jobs, at, err = self.cached(f"jobs:{pid}", max_age, lambda: self.forge.jobs(pid), [], force)
        return {"jobs": jobs, "at": at, "error": err}

    def pipeline_act(self, pid, what):
        if what not in ("retry", "cancel"):
            raise RuntimeError(f"unknown action {what}")
        self.forge.pipeline_act(pid, what)
        self.drop("pipelines", f"jobs:{pid}", "request-ci", "ci-jobs")
        return {"ok": True}

    def runners(self, max_age, force):
        runners, at, err = self.cached("runners", max_age, self.forge.runners, [], force)
        jobs, _, err2 = self.cached("ci-jobs", max_age, self.forge.ci_jobs, [], force)
        err = err or err2
        # Tags and versions rarely change: each runner's details are fetched every 10 minutes,
        # all at once.
        now, details, stale = time.time(), {}, []
        for r in runners:
            row = self.db.execute("SELECT at, json FROM cache WHERE k=? AND shape=?", (f"runner:{r['id']}", SHAPES)).fetchone()
            if row:
                details[r["id"]] = json.loads(row[1])
            if max_age >= 0 and (not row or force or now - row[0] >= RUNNER_DETAILS_EVERY):
                stale.append(r["id"])

        def fetch(rid):
            try:
                return rid, self.forge.runner_details(rid)
            except FETCH_ERRORS:
                return rid, None

        if stale:
            with ThreadPoolExecutor(4) as pool:
                for rid, d in pool.map(fetch, stale):
                    if d is not None:
                        details[rid] = d
                        self.db.execute("INSERT OR REPLACE INTO cache(k, at, json, shape, lease) VALUES(?,?,?,?,0)",
                                        (f"runner:{rid}", now, json.dumps(d), SHAPES))
            self.db.commit()
        loaded = True
        for r in runners:
            d = details.get(r["id"])
            r["details"] = d is not None
            loaded = loaded and r["details"]
            r.update(d or {})
        own = {r["id"] for r in runners}
        for r in runners:
            r["running"] = [j["id"] for j in jobs if j["status"] == "running" and (j["runner"] or {}).get("id") == r["id"]]
        for j in jobs:
            j["elsewhere"] = j["status"] == "running" and (j["runner"] or {}).get("id") not in own
            # Only when every runner's tags are known: don't cry wolf.
            j["stuck"] = j["status"] == "pending" and loaded and not any(can_run(r, j) for r in runners)
        return {"runners": runners, "jobs": jobs, "at": at, "error": err}

    # -- milestones --

    def milestones(self, max_age, force):
        ms_, at, err = self.cached("milestones", max_age, self.forge.milestones, [], force)
        return {"milestones": ms_, "at": at, "error": err}

    def milestone_items(self, title, max_age, force):
        items, at, err = self.cached(f"milestone:{title}", max_age, lambda: self.forge.milestone_items(title), [], force)
        return {"items": items, "at": at, "error": err}

    # -- velocity --

    def velocity(self, max_age, force, rng, now_ms, tz):
        """Merged requests and closed issues, fetched incrementally. `velocity_through` is the
        newest time every earlier change is known to be fetched; a fetch cut short by the
        time budget keeps what it got and starts from there again next time."""
        err = None
        if max_age >= 0 and (force or time.time() - self.meta("velocity_at", 0) >= max_age):
            started = int(time.time() * 1000)
            since = max(now_ms - KEEP, self.meta("velocity_through", 0) - 3600000)
            try:
                merged, closed, complete = self.forge.velocity(datetime.fromtimestamp(since / 1000).astimezone().isoformat())
                self.db.executemany("INSERT OR REPLACE INTO merged(iid, merged_ms, created_ms) VALUES(?,?,?)", merged)
                self.db.executemany("INSERT OR REPLACE INTO closed(iid, closed_ms) VALUES(?,?)", closed)
                self.db.execute("DELETE FROM merged WHERE merged_ms < ?", (now_ms - KEEP,))
                self.db.execute("DELETE FROM closed WHERE closed_ms < ?", (now_ms - KEEP,))
                if complete:
                    self.set_meta("velocity_through", started)
                    self.set_meta("velocity_at", time.time())
                self.db.commit()
            except FETCH_ERRORS as e:
                err = str(e) or type(e).__name__
                self.nocli = self.nocli or isinstance(e, NoCli)
        b = buckets(rng, now_ms, tz)
        pairs = self.db.execute("SELECT merged_ms, created_ms FROM merged").fetchall()
        closed = [r[0] for r in self.db.execute("SELECT closed_ms FROM closed")]
        out = {"n": b[0], "size": b[1], "start": b[2], "at": self.meta("velocity_at", 0), "error": err, "rows": [
            count_row("merged", [m for m, _ in pairs], b, now_ms),
            count_row("closed", closed, b, now_ms),
            cycle_row("cycle", pairs, b, now_ms),
        ]}
        return out

    # -- issues: a full local copy, filtered and sorted here --

    def store(self, i, now):
        self.db.execute(f"INSERT OR REPLACE INTO issues({ISSUE_COLS},id,description,written_at) VALUES({','.join('?' * 18)})", (
            i["iid"], i["title"], i["state"], json.dumps(i["labels"]), json.dumps(i["milestone"]),
            json.dumps(i["assignees"]), i["author"], i["created_at"], i["updated_at"], i["closed_at"],
            i["notes"], i["requests"], i["weight"], i["blocking"], i["url"], i["id"], i["description"], now))
        self.db.execute("DELETE FROM issues_fts WHERE iid=?", (i["iid"],))
        self.db.execute("INSERT INTO issues_fts(iid, title, description) VALUES(?,?,?)", (i["iid"], i["title"], i["description"]))

    def issue_out(self, iid):
        r = self.db.execute(f"SELECT {ISSUE_COLS} FROM issues WHERE iid=?", (iid,)).fetchone()
        if not r:
            return None
        iid, title, state, labels, milestone, assignees, author, ca, ua, cl, notes, reqs, weight, blocking, url = r
        return {"iid": iid, "title": title, "state": state, "labels": json.loads(labels), "milestone": json.loads(milestone),
                "assignees": json.loads(assignees), "author": author, "created_ms": ms(ca), "updated_ms": ms(ua),
                "closed_ms": ms(cl), "notes": notes, "requests": reqs, "weight": weight, "blocking": blocking, "url": url}

    def sync(self, since, force):
        """Fetches issues changed since the last sync, a page at a time: the cursor is saved
        after each page, and a first sync of a big project finishes over several calls
        (`more` says call again)."""
        now = time.time()
        error, more = None, False
        if force or now - self.meta("last_sync", 0) >= MIN_GAP:
            try:
                cursor = self.meta("cursor")
                for page in self.forge.issue_pages(cursor):
                    for i in page:
                        self.store(i, now)
                        cursor = max(cursor or "", i["updated_at"])
                    self.set_meta("cursor", cursor)
                    self.db.commit()
                    if over_budget():
                        more = True
                        break
                self.set_meta("last_sync", now)
                self.db.commit()
                if not more and (force or now - self.meta("meta_at", 0) >= META_EVERY):
                    self.set_meta("labels", self.forge.labels())
                    self.set_meta("milestones", self.forge.active_milestones())
                    self.set_meta("meta_at", now)
                    self.db.commit()
                if not more and not over_budget() and (force or now - self.meta("reconcile_at", 0) >= RECONCILE_EVERY):
                    gone = self.reconcile()
                    if gone is not None:
                        if gone:
                            self.set_meta("deleted_at", now)
                        self.set_meta("reconcile_at", now)
                    self.db.commit()
            except FETCH_ERRORS as e:
                self.db.commit()
                error = str(e) or type(e).__name__
        changed = self.db.execute("SELECT count(*) FROM issues WHERE written_at > ?", (since,)).fetchone()[0]
        if self.meta("deleted_at", 0) > since:
            changed += 1
        return {"now": now, "last_sync": self.meta("last_sync", 0), "error": error, "changed": changed, "more": more,
                "triage_at": self.db.execute("SELECT max(at) FROM triage").fetchone()[0] or 0,
                "triage_run": self.meta("triage_run")}

    def reconcile(self):
        """Deleted issues don't show in the change feed: drop what the forge no longer has.
        None: couldn't list them all in time."""
        alive = self.forge.issue_iids()
        if not alive:  # out of time, or an empty answer: that's a fault, not "all deleted"
            return None
        gone = [r[0] for r in self.db.execute("SELECT iid FROM issues") if r[0] not in alive]
        for t in ("issues", "issues_fts", "details", "triage", "launches"):
            self.db.executemany(f"DELETE FROM {t} WHERE iid=?", [(i,) for i in gone])
        return gone

    def search(self, q):
        words = [w.replace('"', "") for w in q.split() if w.strip('"')]
        if not words:
            return []
        match = " ".join(f'"{w}"*' for w in words)
        return [r[0] for r in self.db.execute(
            "SELECT iid FROM issues_fts WHERE issues_fts MATCH ? ORDER BY rank LIMIT 300", (match,))]

    def query(self, o):
        """One page of the filtered, sorted list, plus counts for the sidebar.
        o: {state, q, picked: {group: [values]}, sort, offset, limit, sep?}"""
        if o.get("sep") and o["sep"] != self.sep:
            self.sep = o["sep"]
            self.set_meta("scope_sep", self.sep)
            self.db.commit()
        state, q = o.get("state", "opened"), (o.get("q") or "").strip()
        picked = {g: set(v) for g, v in (o.get("picked") or {}).items() if v}
        sort, offset, limit = o.get("sort", "priority"), o.get("offset", 0), o.get("limit", 150)
        tri = {iid: (rank, prio, status, locked) for iid, rank, prio, status, locked in
               self.db.execute("SELECT iid, rank, priority, status, locked FROM triage")}
        launched = {r[0] for r in self.db.execute("SELECT DISTINCT iid FROM launches WHERE at > ?", (time.time() - 14 * 86400,))}
        m = re.fullmatch(r"#?(\d+)", q)
        words = q.lower().split()
        hits = set(self.search(q)) if q and not m and len(q) >= 3 else None
        base = []
        for iid, title, st, labels, milestone, ca, ua, reqs in self.db.execute(
                "SELECT iid, title, state, labels, milestone, created_at, updated_at, requests FROM issues"):
            if state != "all" and st != state:
                continue
            if q:
                if m:
                    if not str(iid).startswith(m.group(1)):
                        continue
                elif not (all(w in title.lower() for w in words) or (hits is not None and iid in hits)):
                    continue
            labels = json.loads(labels)
            scoped = scoped_of(labels, self.sep)
            plain = [l for l in labels if self.sep not in l]
            mt = json.loads(milestone)
            groups = {f"scope:{k}": v for k, v in scoped.items()}
            groups["milestone"] = mt["title"] if mt else None
            t = tri.get(iid)
            if t and t[3]:
                groups["triage"] = "locked"
            elif t and t[2] == "proposed" and t[1] and t[1] != scoped.get("priority"):
                groups["triage"] = "proposed change"
            elif t and t[0]:
                groups["triage"] = "ranked"
            base.append((iid, title, st, groups, plain, ms(ca), ms(ua), reqs, scoped))
        counts = {"milestone": {}, "triage": {}, "labels": {}}
        for i in base:
            for g, v in i[3].items():
                if v is not None:
                    counts.setdefault(g, {})
                    counts[g][v] = counts[g].get(v, 0) + 1
            for l in i[4]:
                counts["labels"][l] = counts["labels"].get(l, 0) + 1
        for g, c in counts.items():
            if g != "labels":
                none = len(base) - sum(c.values())
                if none:
                    c["(none)"] = none

        def keep(i):
            for g, vals in picked.items():
                if g == "labels":
                    if not vals.issubset(i[4]):
                        return False
                elif (i[3].get(g) or "(none)") not in vals:
                    return False
            return True

        rows = [i for i in base if keep(i)]
        prio = lambda i: PRIORITIES.index(i[8]["priority"]) if i[8].get("priority") in PRIORITIES else len(PRIORITIES)
        key = {
            "priority": lambda i: (prio(i), -i[6]),
            "updated": lambda i: -i[6],
            "created": lambda i: -i[5],
            "triage": lambda i: ((tri.get(i[0]) or (None,))[0] or 10 ** 9, prio(i)),
        }.get(sort, lambda i: -i[6])
        rows.sort(key=key)
        page = []
        for i in rows[offset:offset + limit]:
            t = tri.get(i[0])
            proposed = t[1] if i[3].get("triage") == "proposed change" else None
            # [iid, title, state, priority, type, requests, updated_ms, proposed priority, agent launched]
            page.append([i[0], i[1], i[2], i[8].get("priority"), i[8].get("type"), i[7], i[6], proposed, i[0] in launched])
        scopes = sorted((g[6:] for g in counts if g.startswith("scope:")),
                        key=lambda s: -sum(v for k, v in counts[f"scope:{s}"].items() if k != "(none)"))
        return {"rows": page, "offset": offset, "matched": len(rows), "total": len(base), "counts": counts,
                "scopes": scopes, "sep": self.sep}

    def show(self, iid, refetch=False):
        r = self.db.execute("SELECT description, updated_at FROM issues WHERE iid=?", (iid,)).fetchone()
        if not r:
            return {"error": f"#{iid} isn't cached yet", "issue": None, "notes": [], "requests": [], "launches": []}
        desc, updated = r
        d = self.db.execute("SELECT for_updated_at, json FROM details WHERE iid=?", (iid,)).fetchone()
        error = None
        if refetch or not d or d[0] != updated:
            try:
                detail = self.forge.issue_detail(iid)
                self.db.execute("INSERT OR REPLACE INTO details(iid, for_updated_at, json) VALUES(?,?,?)",
                                (iid, updated, json.dumps(detail)))
                self.db.commit()
            except FETCH_ERRORS as e:
                error = str(e) or type(e).__name__
                detail = json.loads(d[1]) if d else {"notes": [], "requests": []}
        else:
            detail = json.loads(d[1])
        t = self.db.execute("SELECT rank, priority, reason, status, locked FROM triage WHERE iid=?", (iid,)).fetchone()
        launches = [{"action": a, "tab": b, "at": c} for a, b, c in
                    self.db.execute("SELECT action, tab, at FROM launches WHERE iid=? ORDER BY at", (iid,))]
        return {"iid": iid, "issue": self.issue_out(iid), "description": desc, "notes": detail.get("notes", []),
                "requests": detail.get("requests", []), "error": error, "launches": launches,
                "triage": {"rank": t[0], "priority": t[1], "reason": t[2], "status": t[3], "locked": bool(t[4])} if t else None}

    def update(self, iid, fields):
        self.store(self.forge.issue_update(iid, fields), time.time())
        self.db.commit()
        self.drop("milestones", "milestone", "velocity")
        return {"issue": self.issue_out(iid)}

    def comment(self, iid, body):
        self.forge.issue_comment(iid, body)
        # The comment bumps updated_at: pull the issue so the list and the details agree.
        self.store(self.forge.issue_get(iid), time.time())
        self.db.commit()
        return self.show(iid, refetch=True)

    def labels_meta(self):
        return {"labels": self.meta("labels", []), "milestones": self.meta("milestones", []), "sep": self.sep}

    # -- triage (optional; the triage-issues skill drives these) --

    def context(self, snippet=400):
        tri = {r[0]: r[1:] for r in self.db.execute("SELECT iid, locked, status, priority FROM triage")}
        rows = self.db.execute("SELECT iid, title, description, labels, milestone, created_at, updated_at, notes, requests, blocking, assignees "
                               "FROM issues WHERE state='opened' ORDER BY iid").fetchall()
        now = time.time() * 1000
        days = lambda iso: int((now - ms(iso)) / DAY)
        synced = datetime.fromtimestamp(self.meta("last_sync", 0)).isoformat(timespec="minutes")
        out = [f"# Open issues in {self.repo}: {len(rows)} (cached {synced})", "",
               f"Scoped labels look like priority{self.sep}high.", "", "## Active milestones"]
        for m in self.meta("milestones", []):
            n = sum(1 for r in rows if (json.loads(r[4]) or {}).get("title") == m["title"])
            out.append(f"- {m['title']} (due {m.get('due') or 'none'}): {n} open")
        out += ["", "## Issues",
                "Format: #iid [scope=value ...] milestone | age d / updated d ago | requests, comments, blocks"
                " | LOCKED = priority set by hand, keep it", ""]
        for iid, title, desc, labels, milestone, ca, ua, notes, reqs, blocking, assignees in rows:
            labels = json.loads(labels)
            sc = scoped_of(labels, self.sep)
            plain = [l for l in labels if self.sep not in l]
            mt = (json.loads(milestone) or {}).get("title") or "-"
            t = tri.get(iid)
            lock = " LOCKED" if t and t[0] else ""
            dismissed = f" (dismissed proposal: {t[2]})" if t and t[1] == "dismissed" and t[2] else ""
            who = json.loads(assignees)
            out.append(f"#{iid} [{' '.join(f'{k}={v}' for k, v in sorted(sc.items())) or '-'}] {mt}"
                       f" | {days(ca)}d / {days(ua)}d | requests {reqs}, comments {notes}, blocks {blocking}"
                       f"{' | labels ' + ','.join(plain) if plain else ''}{' | @' + ','.join(who) if who else ''}{lock}{dismissed}")
            out.append(f"  {title}")
            text = " ".join((desc or "").split())
            if text and snippet:
                out.append(f"  > {text[:snippet]}{'…' if len(text) > snippet else ''}")
        return "\n".join(out)

    def propose(self, path):
        with open(path) as f:
            items = json.load(f)
        now = time.time()
        current = {iid: scoped_of(json.loads(l), self.sep).get("priority") for iid, l in
                   self.db.execute("SELECT iid, labels FROM issues WHERE state='opened'")}
        old = {r[0]: r[1:] for r in self.db.execute("SELECT iid, priority, status, locked FROM triage")}
        seen, changes, skipped = set(), 0, []
        for it in items:
            iid = int(it["iid"])
            if iid not in current:
                skipped.append(iid)
                continue
            seen.add(iid)
            prio = it.get("priority") if it.get("priority") in PRIORITIES else None
            was = old.get(iid)
            locked = was[2] if was else 0
            if locked:
                prio = current[iid]
            # Don't bring back what the person already turned down.
            status = "dismissed" if was and was[1] == "dismissed" and was[0] == prio else "proposed"
            if status == "proposed" and prio and prio != current[iid]:
                changes += 1
            self.db.execute("INSERT OR REPLACE INTO triage(iid, rank, priority, reason, status, at, locked) VALUES(?,?,?,?,?,?,?)",
                            (iid, it.get("rank"), prio, (it.get("reason") or "")[:300], status, now, locked))
        # Ranks come from the latest run only.
        self.db.execute(f"UPDATE triage SET rank=NULL WHERE iid NOT IN ({','.join('?' * len(seen)) or 'NULL'})", list(seen))
        self.set_meta("triage_run", {"at": now, "issues": len(seen), "changes": changes})
        self.db.commit()
        return {"ok": True, "issues": len(seen), "changes": changes, "skipped": skipped}

    def accept_all(self):
        rows = self.db.execute("SELECT t.iid, t.priority, i.labels FROM triage t JOIN issues i ON i.iid = t.iid "
                               "WHERE t.status='proposed' AND NOT t.locked AND t.priority IS NOT NULL AND i.state='opened'").fetchall()
        done, failed, more = [], [], False
        want = lambda p: f"priority{self.sep}{p}"
        for iid, prio, labels in rows:
            if over_budget():
                more = True
                break
            labels = json.loads(labels)
            drop = [l for l in labels if l.startswith(f"priority{self.sep}") and l != want(prio)]
            if want(prio) in labels and not drop:
                continue
            try:
                self.update(iid, {"add_labels": [want(prio)], "remove_labels": drop})
                self.write("UPDATE triage SET status='accepted', at=? WHERE iid=?", (time.time(), iid))
                done.append(iid)
            except FETCH_ERRORS as e:
                failed.append({"iid": iid, "error": str(e)})
                if isinstance(e, Busy):
                    break
        return {"accepted": done, "failed": failed, "more": more}


def can_run(r, job):
    """Whether a runner could pick up a job: online, not paused, and has all its tags."""
    if r.get("status") != "online" or r.get("paused") or not r.get("details"):
        return False
    if not job["tags"]:
        return r.get("run_untagged", True)
    return all(t in r.get("tags", []) for t in job["tags"])


# ---- commits: run on the repo's machine, cached in its own database ----

GIT_MIGRATIONS = [[
    "CREATE TABLE IF NOT EXISTS commits(top TEXT, ref TEXT, at REAL, fetched REAL, json TEXT, PRIMARY KEY(top, ref))",
]]


def commits(top, ref, rng, now_ms, tz, force):
    db = connect(os.path.join(HOME, "git.db"), GIT_MIGRATIONS)
    now = time.time()
    row = db.execute("SELECT at, fetched, json FROM commits WHERE top=? AND ref=?", (top, ref)).fetchone()
    at, fetched, times = (row[0], row[1], json.loads(row[2])) if row else (0, 0, [])
    error = None
    fetch = ref.startswith("origin/") and (force or now - fetched >= 900)
    try:
        if fetch:
            fetched = now
            env = {**ENV, "GIT_SSH_COMMAND": "ssh -o BatchMode=yes -o ConnectTimeout=8"}
            subprocess.run(["git", "fetch", "-q", "origin", ref[len("origin/"):]], cwd=top, env=env,
                           capture_output=True, timeout=CLI_TIMEOUT)
        if force or fetch or not row or now - at >= 300:
            r = subprocess.run(["git", "log", ref or "HEAD", "--since=85 days ago", "--no-merges", "--format=%ct"],
                               cwd=top, env=ENV, capture_output=True, text=True, timeout=CLI_TIMEOUT)
            if r.returncode == 0:
                times = [int(x) * 1000 for x in r.stdout.split()]
                at = now
            else:
                error = r.stderr.strip() or f"git exited {r.returncode}"
    except FETCH_ERRORS as e:
        error = str(e) or type(e).__name__
    db.execute("INSERT OR REPLACE INTO commits(top, ref, at, fetched, json) VALUES(?,?,?,?,?)",
               (top, ref, at, fetched, json.dumps(times)))
    db.execute("DELETE FROM commits WHERE at < ? AND fetched < ?", (now - 30 * 86400, now - 30 * 86400))
    db.commit()
    b = buckets(rng, now_ms, tz)
    return {"n": b[0], "size": b[1], "start": b[2], "at": at, "error": error,
            "row": count_row("commits", times, b, now_ms), "total": len(times)}


def skill(action, name, text):
    """A Claude Code skill a mod ships. Its text carries `herdr-forge <version>`; install
    never replaces a newer one, so mods of different versions don't fight over it."""
    if not re.fullmatch(r"[\w-]+", name):
        raise RuntimeError("bad skill name")
    dest = os.path.expanduser(f"~/.claude/skills/{name}/SKILL.md")
    version = lambda t: (re.search(r"herdr-forge (\S+)", t or "") or [None, "0"])[1]

    def read():
        try:
            with open(dest) as f:
                return f.read()
        except OSError:
            return None

    current = read()
    if action == "install" and (current is None or release(version(text)) >= release(version(current))):
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        tmp = f"{dest}.{os.getpid()}"
        with open(tmp, "w") as f:
            f.write(text)
        os.replace(tmp, dest)
        current = read()
    return {"installed": current is not None, "current": current == text, "path": dest,
            "version": version(current) if current else None,
            "older": current is not None and release(version(current)) < release(version(text))}


def main(argv):
    cmd, args = argv[0], argv[1:]
    if cmd == "version":
        return {"version": VERSION, "shapes": SHAPES}
    if cmd == "commits":
        top, ref, rng, now_ms, tz, force = args
        return commits(top, ref, rng, int(now_ms), int(tz), force == "1")
    if cmd == "skill":
        return skill(*args)
    provider, host, repo, *a = args
    p = Project(provider, host, repo)
    age = lambda k: float(a[k]) if len(a) > k else 60
    force = lambda k: len(a) > k and a[k] == "1"
    handlers = {
        "requests": lambda: p.requests(age(0), force(1)),
        "merge": lambda: p.merge(int(a[0]), a[1] if len(a) > 1 else ""),
        "pipelines": lambda: p.pipelines(age(0), force(1)),
        "jobs": lambda: p.jobs(int(a[0]), age(1), force(2)),
        "pipeline-act": lambda: p.pipeline_act(int(a[0]), a[1]),
        "runners": lambda: p.runners(age(0), force(1)),
        "milestones": lambda: p.milestones(age(0), force(1)),
        "milestone-items": lambda: p.milestone_items(a[0], age(1), force(2)),
        "velocity": lambda: p.velocity(age(0), force(1), a[2], int(a[3]), int(a[4])),
        "sync": lambda: p.sync(float(a[0]) if a else 0, force(1)),
        "meta": p.labels_meta,
        "query": lambda: p.query(json.loads(a[0]) if a else {}),
        "show": lambda: p.show(int(a[0])),
        "search": lambda: {"iids": p.search(a[0])},
        "update": lambda: p.update(int(a[0]), json.loads(a[1])),
        "comment": lambda: p.comment(int(a[0]), a[1]),
        "launch": lambda: p.write("INSERT INTO launches(iid, action, tab, at) VALUES(?,?,?,?)",
                                  (int(a[0]), a[1], a[2], time.time())),
        # A proposal accepted or dismissed in the browser (the label change itself goes through `update`).
        "triage": lambda: p.write("UPDATE triage SET status=?, at=? WHERE iid=?",
                                  (a[1] if a[1] in ("accepted", "dismissed") else "dismissed", time.time(), int(a[0]))),
        # A priority set by hand: triage ranks the issue but won't propose another.
        "lock": lambda: p.write("INSERT INTO triage(iid, status, at, locked) VALUES(?, 'dismissed', ?, ?) "
                                "ON CONFLICT(iid) DO UPDATE SET locked=excluded.locked, at=excluded.at",
                                (int(a[0]), time.time(), int(a[1]))),
        "propose": lambda: p.propose(a[0]),
        "accept-all": p.accept_all,
    }
    if cmd == "context":
        return p.context(int(a[0]) if a else 400)
    if cmd not in handlers:
        raise RuntimeError(f"unknown command {cmd}")
    out = handlers[cmd]()
    if p.nocli and isinstance(out, dict):
        out["nocli"] = True
    return out


if __name__ == "__main__":
    try:
        out = main(sys.argv[1:])
    except NoCli as e:
        out = {"error": str(e), "nocli": True}
    except Exception as e:  # every answer is JSON, even a crash
        out = {"error": str(e) if isinstance(e, RuntimeError) else f"{type(e).__name__}: {e}"}
    print(out if isinstance(out, str) else json.dumps(out))
