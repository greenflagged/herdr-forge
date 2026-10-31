"""forge.py against a fake glab, in a throwaway HOME."""
import json, os, subprocess, sys, tempfile, time, unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPT = os.path.join(ROOT, "shared", "forge.py")
FAKES = os.path.join(ROOT, "test", "fakes")
P = ["gitlab", "gitlab.com", "acme/shop"]
NOW = 1_780_000_000_000  # a fixed "now" in ms


def iso(msec):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(msec / 1000))


def mr(iid, **kw):
    return {"iid": iid, "title": f"MR {iid}", "web_url": f"https://gitlab.com/acme/shop/-/merge_requests/{iid}",
            "draft": False, "sha": f"sha{iid}", "source_branch": f"b{iid}", "target_branch": "main",
            "author": {"username": "ann"}, "labels": [], "created_at": iso(NOW - 3 * 86400000),
            "updated_at": iso(NOW - 3600000), "detailed_merge_status": "mergeable", "has_conflicts": False, **kw}


def issue(iid, labels=(), state="opened", **kw):
    return {"iid": iid, "id": 1000 + iid, "title": f"Issue {iid}", "description": f"text {iid}", "state": state,
            "labels": list(labels), "milestone": None, "assignees": [], "author": {"username": "bo"},
            "created_at": iso(NOW - 10 * 86400000), "updated_at": iso(NOW - iid * 60000), "closed_at": None,
            "user_notes_count": 0, "merge_requests_count": 0, "web_url": f"https://gitlab.com/acme/shop/-/issues/{iid}", **kw}


class Forge(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = self.tmp.name
        self.fake = os.path.join(self.home, "fake")
        os.makedirs(self.fake)
        self.routes([])

    def tearDown(self):
        self.tmp.cleanup()

    def routes(self, routes):
        with open(os.path.join(self.fake, "routes.json"), "w") as f:
            json.dump(routes, f)

    def calls(self):
        try:
            with open(os.path.join(self.fake, "calls.log")) as f:
                return f.read().splitlines()
        except FileNotFoundError:
            return []

    def run_forge(self, *args, text=False):
        env = {"HOME": self.home, "PATH": "/usr/bin:/bin", "HERDR_FORGE_BIN": FAKES, "FAKE_GLAB": self.fake}
        r = subprocess.run([sys.executable, "-I", SCRIPT, *map(str, args)], capture_output=True, text=True, env=env)
        self.assertEqual(r.returncode, 0, r.stderr)
        return r.stdout if text else json.loads(r.stdout)

    # -- requests --

    def test_requests_are_normalized_and_cached(self):
        self.routes([
            [r"merge_requests\?state=opened", {"out": [mr(7), mr(8, detailed_merge_status="conflict", draft=True)]}],
            [r"pipelines\?per_page=50", {"out": [
                {"id": 2, "sha": "sha7", "status": "running", "web_url": "u2", "updated_at": iso(NOW)},
                {"id": 1, "sha": "sha7", "status": "failed", "web_url": "u1", "updated_at": iso(NOW - 1000)}]}],
        ])
        out = self.run_forge("requests", *P, 60, 0)
        self.assertIsNone(out["error"])
        a, b = out["requests"]
        self.assertEqual((a["iid"], a["conflicts"], a["draft"], a["source"]), (7, False, False, "b7"))
        self.assertEqual(a["ci"]["id"], 2, "the newest pipeline per commit wins")
        self.assertTrue(b["conflicts"] and b["draft"])
        self.assertIsNone(b["ci"])
        n = len(self.calls())
        self.run_forge("requests", *P, 60, 0)
        self.assertEqual(len(self.calls()), n, "a fresh answer comes from the cache")
        self.run_forge("requests", *P, 60, 1)
        self.assertGreater(len(self.calls()), n, "force fetches again")

    def test_stale_conflict_flag_is_ignored_while_checking(self):
        self.routes([[r"merge_requests", {"out": [mr(7, has_conflicts=True, detailed_merge_status="checking")]}],
                     [r"pipelines", {"out": []}]])
        self.assertFalse(self.run_forge("requests", *P, 60, 0)["requests"][0]["conflicts"])

    def test_failed_fetch_keeps_the_last_answer(self):
        self.routes([[r"merge_requests", {"out": [mr(7)]}], [r"pipelines", {"out": []}]])
        self.run_forge("requests", *P, 60, 0)
        self.routes([[r".", {"err": "connection refused"}]])
        out = self.run_forge("requests", *P, 0, 1)
        self.assertEqual([r["iid"] for r in out["requests"]], [7])
        self.assertIn("connection refused", out["error"])

    def test_rate_limit_pauses_every_command(self):
        self.routes([[r".", {"err": "HTTP 429 Too Many Requests"}]])
        self.assertIn("429", self.run_forge("pipelines", *P, 60, 0)["error"])
        n = len(self.calls())
        out = self.run_forge("milestones", *P, 60, 0)
        self.assertIn("rate-limited", out["error"])
        self.assertEqual(len(self.calls()), n, "no call while backing off")

    @unittest.skipIf(any(os.path.exists(f"{d}/glab") for d in ["/opt/homebrew/bin", "/usr/local/bin", "/home/linuxbrew/.linuxbrew/bin"]),
                     "a real glab is installed where forge.py looks")
    def test_missing_cli_is_reported(self):
        env = {"HOME": self.home, "PATH": "/nonexistent"}
        r = subprocess.run([sys.executable, "-I", SCRIPT, "pipelines", *P, "60", "0"], capture_output=True, text=True, env=env)
        self.assertTrue(json.loads(r.stdout).get("nocli"))

    def test_bad_project_is_refused(self):
        self.assertIn("bad project", self.run_forge("pipelines", "gitlab", "gitlab.com", "../etc", 60, 0)["error"])

    def test_writes_drop_what_they_change(self):
        self.routes([[r"pipelines\?per_page=20", {"out": [{"id": 5, "iid": 1, "ref": "refs/merge-requests/9/head", "sha": "s",
                                                         "status": "failed", "source": "merge_request_event",
                                                         "updated_at": iso(NOW), "web_url": "u"}]}],
                     [r"-X POST .*pipelines/5/retry", {"out": {}}]])
        p = self.run_forge("pipelines", *P, 600, 0)["pipelines"][0]
        self.assertEqual((p["ref"], p["source"]), ("!9", "MR"))
        self.run_forge("pipeline-act", *P, 5, "retry")
        n = len(self.calls())
        self.run_forge("pipelines", *P, 600, 0)
        self.assertGreater(len(self.calls()), n, "retry dropped the cached list")
        self.assertIn("unknown action", self.run_forge("pipeline-act", *P, 5, "delete")["error"])

    # -- runners --

    def test_runners_flag_stuck_and_elsewhere_jobs(self):
        self.routes([
            [r"runners\?type=project_type", {"out": [{"id": 1, "description": "mac", "status": "online", "paused": False}]}],
            [r"runners/1$", {"out": {"tag_list": ["macos"], "run_untagged": False}}],
            [r"jobs\?scope", {"out": [
                {"id": 10, "name": "a", "stage": "t", "status": "pending", "tag_list": ["linux"], "web_url": "u",
                 "created_at": iso(NOW), "pipeline": {"id": 3, "ref": "main"}},
                {"id": 11, "name": "b", "stage": "t", "status": "pending", "tag_list": ["macos"], "web_url": "u",
                 "created_at": iso(NOW), "pipeline": {"id": 3, "ref": "main"}},
                {"id": 12, "name": "c", "stage": "t", "status": "running", "tag_list": [], "web_url": "u",
                 "created_at": iso(NOW), "started_at": iso(NOW), "runner": {"id": 99, "description": "shared"},
                 "pipeline": {"id": 3, "ref": "main"}}]}],
        ])
        out = self.run_forge("runners", *P, 60, 0)
        jobs = {j["id"]: j for j in out["jobs"]}
        self.assertTrue(jobs[10]["stuck"])
        self.assertFalse(jobs[11]["stuck"])
        self.assertTrue(jobs[12]["elsewhere"])
        self.assertEqual(out["runners"][0]["tags"], ["macos"])

    # -- velocity --

    def test_velocity_buckets(self):
        day = 86400000
        merged = [{"iid": "1", "mergedAt": iso(NOW - day), "createdAt": iso(NOW - 3 * day)},
                  {"iid": "2", "mergedAt": iso(NOW - 20 * day), "createdAt": iso(NOW - 21 * day)}]
        page = lambda nodes: {"pageInfo": {"hasNextPage": False, "endCursor": None}, "nodes": nodes}
        self.routes([[r"mergeRequests", {"out": {"data": {"project": {"mergeRequests": page(merged)}}}}],
                     [r"issues\(state:closed", {"out": {"data": {"project": {"issues": page([{"iid": "4", "closedAt": iso(NOW - 2 * day)}])}}}}]])
        out = self.run_forge("velocity", *P, 900, 0, "12w", NOW, 0)
        rows = {r["key"]: r for r in out["rows"]}
        self.assertEqual(out["n"], 12)
        self.assertEqual(sum(rows["merged"]["values"]), 2)
        self.assertEqual(rows["merged"]["now"], 1)
        self.assertEqual(rows["merged"]["values"][-1], 1)
        self.assertEqual(rows["closed"]["now"], 1)
        self.assertEqual(rows["cycle"]["now"], 2 * day)
        n = len(self.calls())
        self.run_forge("velocity", *P, 900, 0, "30d", NOW, 0)
        self.assertEqual(len(self.calls()), n, "changing the range recomputes from the cache")

    def test_commits(self):
        repo = os.path.join(self.home, "repo")
        env = {**os.environ, "HOME": self.home, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t",
               "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t"}
        subprocess.run(["git", "init", "-q", repo], check=True, env=env)
        for k in range(3):
            subprocess.run(["git", "-C", repo, "commit", "-q", "--allow-empty", "-m", f"c{k}"], check=True, env=env)
        now = int(time.time() * 1000)
        out = self.run_forge("commits", repo, "", "30d", now, 0, 0)
        self.assertIsNone(out["error"])
        self.assertEqual(out["total"], 3)
        self.assertEqual(out["row"]["values"][-1], 3)

    # -- issues --

    def sync_issues(self, issues, labels=()):
        page = {"pageInfo": {"hasNextPage": False, "endCursor": None}, "nodes": [{"iid": str(i["iid"])} for i in issues]}
        self.routes([[r"issues\?scope=all", {"out": issues}],
                     [r"/labels", {"out": [{"name": l, "color": "#fff"} for l in labels]}],
                     [r"milestones\?state=active", {"out": []}],
                     [r"graphql", {"out": {"data": {"project": {"issues": page}}}}]])
        out = self.run_forge("sync", *P, 0, 1)
        self.assertIsNone(out["error"])
        return out

    def test_query_facets_come_from_the_labels_in_use(self):
        self.sync_issues([issue(1, ["priority::high", "team::web"]), issue(2, ["priority::low", "bug"]),
                          issue(3, ["team::api"]), issue(4, state="closed")])
        out = self.run_forge("query", *P, json.dumps({"state": "opened", "sort": "priority"}))
        self.assertEqual(out["total"], 3)
        self.assertEqual(out["counts"]["scope:priority"], {"high": 1, "low": 1, "(none)": 1})
        self.assertEqual(out["counts"]["scope:team"], {"web": 1, "api": 1, "(none)": 1})
        self.assertEqual(out["counts"]["labels"], {"bug": 1})
        self.assertEqual([r[0] for r in out["rows"]], [1, 2, 3])
        picked = self.run_forge("query", *P, json.dumps({"picked": {"scope:team": ["api", "web"], "labels": []}}))
        self.assertEqual(sorted(r[0] for r in picked["rows"]), [1, 3])

    def test_custom_separator(self):
        self.sync_issues([issue(1, ["priority: high"]), issue(2, ["priority: low"])])
        out = self.run_forge("query", *P, json.dumps({"sep": ": "}))
        self.assertEqual(out["counts"]["scope:priority"], {"high": 1, "low": 1})
        self.assertEqual(self.run_forge("meta", *P)["sep"], ": ", "the separator is remembered")

    def test_search_and_iid_lookup(self):
        self.sync_issues([issue(1, title="Login breaks"), issue(12, description="the checkout flow"), issue(3)])
        q = lambda s: [r[0] for r in self.run_forge("query", *P, json.dumps({"q": s, "sort": "created"}))["rows"]]
        self.assertEqual(q("#1"), [1, 12])
        self.assertEqual(q("checkout"), [12])
        self.assertEqual(q("login"), [1])

    def test_update_translates_fields(self):
        self.sync_issues([issue(1, ["priority::low"])])
        self.routes([[r"-X PUT .*issues/1", {"out": issue(1, ["priority::high"], state="closed")}]])
        out = self.run_forge("update", *P, 1, json.dumps({"add_labels": ["priority::high"], "remove_labels": ["priority::low"],
                                                          "milestone": None, "state": "closed"}))
        self.assertEqual(out["issue"]["state"], "closed")
        call = self.calls()[-1]
        for part in ["add_labels=priority::high", "remove_labels=priority::low", "milestone_id=0", "state_event=close"]:
            self.assertIn(part, call)

    def test_reconcile_drops_deleted_issues(self):
        self.sync_issues([issue(1), issue(2)])
        page = {"pageInfo": {"hasNextPage": False, "endCursor": None}, "nodes": [{"iid": "1"}]}
        self.routes([[r"issues\?scope=all", {"out": []}], [r"/labels", {"out": []}], [r"milestones", {"out": []}],
                     [r"graphql", {"out": {"data": {"project": {"issues": page}}}}]])
        self.run_forge("sync", *P, 0, 1)
        self.assertEqual(self.run_forge("query", *P, "{}")["total"], 1)

    def test_triage_round_trip(self):
        self.sync_issues([issue(1, ["priority::low"]), issue(2), issue(3, ["priority::medium"])])
        self.run_forge("lock", *P, 3, 1)
        proposals = os.path.join(self.home, "p.json")
        with open(proposals, "w") as f:
            json.dump([{"iid": 1, "priority": "high", "rank": 1, "reason": "r"}, {"iid": 2, "priority": "low", "rank": 2},
                       {"iid": 3, "priority": "blocker", "rank": 3}, {"iid": 99, "priority": "low"}], f)
        out = self.run_forge("propose", *P, proposals)
        self.assertEqual((out["issues"], out["changes"], out["skipped"]), (3, 2, [99]))
        self.assertIn("#3 [priority=medium] - |", self.run_forge("context", *P, text=True))
        self.routes([[r"-X PUT .*issues/1", {"out": issue(1, ["priority::high"])}],
                     [r"-X PUT .*issues/2", {"out": issue(2, ["priority::low"])}]])
        out = self.run_forge("accept-all", *P)
        self.assertEqual(sorted(out["accepted"]), [1, 2], "the locked issue keeps its priority")

    def test_skill_install(self):
        self.assertFalse(self.run_forge("skill", "status", "triage-issues", "x")["installed"])
        out = self.run_forge("skill", "install", "triage-issues", "x")
        self.assertTrue(out["installed"] and out["current"])
        self.assertFalse(self.run_forge("skill", "status", "triage-issues", "y")["current"])
        self.assertIn("bad skill name", self.run_forge("skill", "install", "../x", "y")["error"])


if __name__ == "__main__":
    unittest.main()
