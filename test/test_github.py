"""forge.py's GitHub provider against a fake gh, in a throwaway HOME."""
import json, os, subprocess, sys, tempfile, time, unittest

from test_forge import FAKES, NOW, SCRIPT, iso

P = ["github", "github.com", "acme/shop"]
DAY = 86400000
URL = "https://github.com/acme/shop"


def conn(nodes, more=False, cursor=None):
    return {"pageInfo": {"hasNextPage": more, "endCursor": cursor}, "nodes": nodes}


def repo(**fields):
    return {"out": {"data": {"repository": fields}}}


def pr(n, rollup="SUCCESS", **kw):
    return {"number": n, "title": f"PR {n}", "url": f"{URL}/pull/{n}", "isDraft": False, "mergeable": "MERGEABLE",
            "autoMergeRequest": None, "headRefName": f"b{n}", "baseRefName": "main", "headRefOid": f"sha{n}",
            "isCrossRepository": False, "author": {"login": "ann"}, "labels": {"nodes": [{"name": "bug"}]},
            "createdAt": iso(NOW - 3 * DAY), "updatedAt": iso(NOW - 3600000),
            "commits": {"nodes": [{"commit": {"statusCheckRollup": {"state": rollup} if rollup else None}}]}, **kw}


def issue(n, labels=(), state="OPEN", **kw):
    return {"number": n, "databaseId": 1000 + n, "title": f"Issue {n}", "body": f"text {n}", "state": state,
            "url": f"{URL}/issues/{n}", "createdAt": iso(NOW - 10 * DAY), "updatedAt": iso(NOW - n * 60000),
            "closedAt": None, "labels": {"nodes": [{"name": l} for l in labels]}, "milestone": None,
            "assignees": {"nodes": []}, "author": {"login": "bo"}, "comments": {"totalCount": 2},
            "closedByPullRequestsReferences": {"totalCount": 1}, **kw}


def run(i, **kw):
    return {"id": i, "run_number": i - 100, "head_branch": "main", "head_sha": f"s{i}", "status": "completed",
            "conclusion": "success", "event": "push", "pull_requests": [], "updated_at": iso(NOW),
            "html_url": f"{URL}/actions/runs/{i}", "name": "CI", **kw}


def job(i, **kw):
    return {"id": i, "name": f"job {i}", "workflow_name": "CI", "status": "completed", "conclusion": "success",
            "started_at": iso(NOW - 90000), "completed_at": iso(NOW), "created_at": iso(NOW - 100000),
            "html_url": f"{URL}/actions/runs/1/job/{i}", "labels": ["ubuntu-latest"], "runner_id": None,
            "runner_name": None, **kw}


class GitHub(unittest.TestCase):
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

    def run_forge(self, *args, **extra):
        env = {"HOME": self.home, "PATH": "/usr/bin:/bin", "HERDR_FORGE_BIN": FAKES, "FAKE_GLAB": self.fake, **extra}
        r = subprocess.run([sys.executable, "-I", SCRIPT, *map(str, args)], capture_output=True, text=True, env=env)
        self.assertEqual(r.returncode, 0, r.stderr)
        return json.loads(r.stdout)

    def sync_issues(self, issues):
        self.routes([[r"issues\(first:100,after:\$after,orderBy", repo(issues=conn(issues))],
                     [r"repos/acme/shop/labels", {"out": [{"name": "bug", "color": "d73a4a", "description": ""}]}],
                     [r"milestones\?state=open", {"out": [{"number": 3, "title": "v1", "due_on": "2026-11-01T07:00:00Z"}]}],
                     [r"nodes\{number\}", repo(issues=conn([{"number": i["number"]} for i in issues]))]])
        out = self.run_forge("sync", *P, 0, 1)
        self.assertIsNone(out["error"])
        return out

    # -- pull requests --

    def test_pull_requests_carry_their_checks(self):
        self.routes([[r"pullRequests\(states:OPEN", repo(pullRequests=conn([
            pr(7), pr(8, rollup="FAILURE", mergeable="CONFLICTING", isDraft=True, isCrossRepository=True,
                      autoMergeRequest={"enabledAt": iso(NOW)}),
            pr(9, rollup=None)]))]])
        out = self.run_forge("requests", *P, 60, 0)
        self.assertIsNone(out["error"])
        a, b, c = out["requests"]
        self.assertEqual((a["iid"], a["source"], a["sha"], a["labels"], a["conflicts"]), (7, "b7", "sha7", ["bug"], False))
        self.assertEqual(a["ci"], {"id": None, "status": "success", "url": f"{URL}/pull/7/checks", "updated_ms": a["updated_ms"]})
        self.assertTrue(b["conflicts"] and b["draft"] and b["fork"] and b["auto_merge"])
        self.assertEqual(b["ci"]["status"], "failed")
        self.assertIsNone(c["ci"], "no checks at all")
        self.assertEqual(len(self.calls()), 1, "one call: the checks come with the PRs")

    def test_merged_pull_requests_carry_their_merge_commits_checks(self):
        now = time.time() * 1000
        def merged(n, at, commit):
            return {**pr(n), "mergedAt": iso(at), "mergeCommit": commit}
        self.routes([[r"pullRequests\(states:MERGED", repo(pullRequests=conn([
            merged(7, now - 3600000, {"oid": "m7", "statusCheckRollup": {"state": "PENDING"}}),
            merged(8, now - 600000, {"oid": "m8", "statusCheckRollup": None}),
            merged(9, now - 30 * DAY, {"oid": "m9", "statusCheckRollup": None})]))]])
        out = self.run_forge("merged", *P, 60, 0)
        self.assertIsNone(out["error"])
        b, a = out["merged"]
        self.assertEqual((a["iid"], a["merge_sha"], a["head_sha"], a["source"]), (7, "m7", "sha7", "b7"))
        self.assertEqual((a["ci"]["status"], a["ci"]["url"]), ("running", f"{URL}/commit/m7"))
        self.assertIsNone(b["ci"], "no checks on the merge commit")
        self.assertEqual(len(out["merged"]), 2, "a month-old merge is left out")

    def test_order_asks_compare_for_how_far_behind(self):
        nodes = [{"number": 7, "headRefOid": "sha7", "baseRefName": "main", "mergeStateStatus": "BEHIND",
                  "files": {"totalCount": 1, "nodes": [{"path": "a.py"}]}},
                 {"number": 9, "headRefOid": "sha9", "baseRefName": "main", "mergeStateStatus": "CLEAN",
                  "files": {"totalCount": 0, "nodes": []}}]
        self.routes([[r"pullRequests\(states:OPEN,first:50,\s*orderBy:\{field:UPDATED_AT,direction:DESC\}\)\{nodes\{number headRefOid", repo(pullRequests=conn(nodes))],
                     [r"pullRequests\(states:OPEN", repo(pullRequests=conn([pr(7)]))],
                     [r"compare/main\.\.\.sha7", {"out": {"behind_by": 4}}]])
        out = self.run_forge("order", *P, 60, 0)
        self.assertIsNone(out["error"])
        self.assertEqual(out["requests"], {"7": {"sha": "sha7", "behind": 4, "rebase": True, "files": ["a.py"]}},
                         "only open PRs the list shows")
        self.assertEqual(out["targets"], [], "no migration pattern: no folders listed")

    def test_merge_uses_a_method_the_repo_allows(self):
        self.routes([[r"-X PUT .*repos/acme/shop/pulls/7/merge", {"out": {"merged": True, "message": "Pull Request successfully merged"}}],
                     [r"mergeCommitAllowed", repo(mergeCommitAllowed=False, squashMergeAllowed=True, rebaseMergeAllowed=True)]])
        out = self.run_forge("merge", *P, 7, "sha7")
        self.assertEqual(out, {"ok": True, "text": "Pull Request successfully merged"})
        body = json.loads(self.calls()[-1].split(" <<< ")[1])
        self.assertEqual(body, {"merge_method": "squash", "sha": "sha7"})

    def test_merge_waits_for_required_checks_with_auto_merge(self):
        self.routes([[r"-X PUT", {"err": 'gh: Required status check "build" is expected. (HTTP 405)'}],
                     [r"repos/acme/shop/pulls/7$", {"out": {"node_id": "PR_x"}}],
                     [r"enablePullRequestAutoMerge", {"out": {"data": {"enablePullRequestAutoMerge": {"clientMutationId": None}}}}],
                     [r"mergeCommitAllowed", repo(mergeCommitAllowed=True)]])
        out = self.run_forge("merge", *P, 7, "sha7")
        self.assertEqual(out["text"], "Set to merge when checks pass")
        last = self.calls()[-1]
        for part in ["id=PR_x", "m=MERGE", "sha=sha7"]:
            self.assertIn(part, last)

    def test_merge_reports_other_refusals(self):
        self.routes([[r"-X PUT", {"err": "gh: Pull Request is not mergeable (HTTP 405)"}], [r"mergeCommitAllowed", repo(mergeCommitAllowed=True)]])
        self.assertIn("not mergeable", self.run_forge("merge", *P, 7, "sha7")["error"])
        self.assertFalse(any("enablePullRequestAutoMerge" in c for c in self.calls()))

    # -- CI --

    def test_workflow_runs_and_jobs(self):
        self.routes([[r"actions/runs\?per_page=20", {"out": {"workflow_runs": [
            run(201, status="in_progress", conclusion=None, event="pull_request", pull_requests=[{"number": 12}]),
            run(202, conclusion="cancelled", event="schedule"),
            run(203, status="queued", conclusion=None, event="pull_request", head_branch="fork-branch")]}}],
            [r"actions/runs/201/jobs", {"out": {"jobs": [job(2, conclusion="failure"), job(1, status="in_progress", conclusion=None, completed_at=None)]}}]])
        a, b, c = self.run_forge("pipelines", *P, 60, 0)["pipelines"]
        self.assertEqual((a["ref"], a["status"], a["source"], a["iid"], a["name"]), ("#12", "running", "request", 101, "CI"))
        self.assertEqual((b["ref"], b["status"], b["source"]), ("main", "canceled", "schedule"))
        self.assertEqual((c["ref"], c["status"]), ("fork-branch", "pending"), "a fork's PR run names its branch")
        j1, j2 = self.run_forge("jobs", *P, 201, 60, 0)["jobs"]
        self.assertEqual((j1["id"], j1["status"], j1["duration"], j1["group"]), (1, "running", None, "CI"))
        self.assertEqual((j2["status"], j2["duration"], j2["allow_failure"]), ("failed", 90.0, False))

    def test_retry_reruns_failed_jobs_else_the_whole_run(self):
        self.routes([[r"-X POST repos/acme/shop/actions/runs/5/rerun-failed-jobs", {"out": ""}],
                     [r"runs/5$", {"out": run(5, conclusion="failure")}]])
        self.assertTrue(self.run_forge("pipeline-act", *P, 5, "retry")["ok"])
        self.routes([[r"-X POST .*runs/5/rerun$", {"out": ""}], [r"runs/5$", {"out": run(5, conclusion="success")}]])
        self.assertTrue(self.run_forge("pipeline-act", *P, 5, "retry")["ok"])
        self.assertTrue(self.calls()[-1].endswith("runs/5/rerun"), "nothing failed: the whole run")
        self.routes([[r"rerun", {"err": "gh: Must have admin rights (HTTP 403)"}], [r"runs/5$", {"out": run(5, conclusion="failure")}]])
        self.assertIn("admin", self.run_forge("pipeline-act", *P, 5, "retry")["error"])
        self.assertFalse(self.calls()[-1].endswith("runs/5/rerun"), "a refusal isn't a reason to rerun everything")
        self.routes([[r"-X POST .*runs/5/cancel$", {"out": ""}]])
        self.assertTrue(self.run_forge("pipeline-act", *P, 5, "cancel")["ok"])

    def test_runners_and_stuck_jobs(self):
        self.routes([
            [r"actions/runners\?", {"out": {"runners": [
                {"id": 1, "name": "box", "os": "Linux", "status": "online", "labels": [{"name": "self-hosted"}, {"name": "Linux"}, {"name": "X64"}]}]}}],
            [r"runs\?status=in_progress", {"out": {"workflow_runs": [run(301, status="in_progress", conclusion=None)]}}],
            [r"runs\?status=queued", {"out": {"workflow_runs": [run(301, status="in_progress", conclusion=None)]}}],
            [r"runs\?status=waiting", {"out": {"workflow_runs": []}}],
            [r"runs/301/jobs", {"out": {"jobs": [
                job(6, status="waiting", conclusion=None, labels=["self-hosted", "gpu"]),
                job(1, status="in_progress", conclusion=None, runner_id=1, runner_name="box", labels=["self-hosted", "linux"]),
                job(2, status="queued", conclusion=None, labels=["self-hosted", "gpu"]),
                job(3, status="queued", conclusion=None, labels=["ubuntu-latest"]),
                job(4, status="in_progress", conclusion=None, runner_id=99, runner_name="GitHub Actions 99"),
                job(5)]}}]])
        out = self.run_forge("runners", *P, 60, 0)
        self.assertIsNone(out["error"])
        [r] = out["runners"]
        self.assertEqual((r["tags"], r["platform"], r["arch"], r["running"], r["details"]),
                         (["self-hosted", "linux", "x64"], "Linux", "x64", [1], True))
        jobs = {j["id"]: j for j in out["jobs"]}
        self.assertNotIn(5, jobs, "finished jobs aren't listed")
        self.assertTrue(jobs[2]["stuck"], "needs a gpu runner nobody has")
        self.assertFalse(jobs[3]["stuck"], "GitHub's own runners take it")
        self.assertTrue(jobs[4]["elsewhere"])
        self.assertFalse(jobs[6]["stuck"], "waiting for an approval, not a runner")
        self.assertEqual(len(out["jobs"]), 5, "a run listed twice gives its jobs once")
        self.assertFalse(any(c.endswith("actions/runners/1") for c in self.calls()), "details came with the list")

    def test_runners_without_admin_rights_flag_nothing_stuck(self):
        self.routes([[r"actions/runners", {"err": "gh: Resource not accessible by integration (HTTP 403)"}],
                     [r"runs\?status=in_progress", {"out": {"workflow_runs": []}}],
                     [r"runs\?status=queued", {"out": {"workflow_runs": [run(1, status="queued", conclusion=None)]}}],
                     [r"runs\?status=waiting", {"out": {"workflow_runs": []}}],
                     [r"runs/1/jobs", {"out": {"jobs": [job(2, status="queued", conclusion=None, labels=["self-hosted"])]}}]])
        out = self.run_forge("runners", *P, 60, 0)
        self.assertIn("admins", out["error"])
        self.assertFalse(out["jobs"][0]["stuck"])

    def test_org_runners_we_cant_list_dont_make_jobs_stuck(self):
        self.routes([[r"actions/runners", {"out": {"runners": []}}],
                     [r"runs\?status=queued", {"out": {"workflow_runs": [run(1, status="queued", conclusion=None)]}}],
                     [r"runs\?status=", {"out": {"workflow_runs": []}}],
                     [r"runs/1/jobs", {"out": {"jobs": [job(2, status="queued", conclusion=None, labels=["self-hosted"])]}}]])
        out = self.run_forge("runners", *P, 60, 0)
        self.assertIsNone(out["error"])
        self.assertFalse(out["jobs"][0]["stuck"])

    # -- milestones --

    def test_milestones_count_issues_and_items_skip_prs(self):
        self.routes([[r"milestones\(states:OPEN", repo(milestones=conn([
            {"number": 3, "title": "v1", "dueOn": "2026-11-01T07:00:00Z", "url": f"{URL}/milestone/3",
             "open": {"totalCount": 2}, "closed": {"totalCount": 5}}]))],
            [r"milestones\?state=all", {"out": [{"number": 3, "title": "v1"}]}],
            [r"issues\?milestone=3", {"out": [
                {"id": 1, "number": 1, "title": "done", "state": "closed", "assignees": [], "html_url": "u1"},
                {"id": 2, "number": 2, "title": "a PR", "state": "open", "pull_request": {}, "assignees": [], "html_url": "u2"},
                {"id": 3, "number": 3, "title": "todo", "state": "open", "assignees": [{"login": "cy"}], "html_url": "u3"}]}]])
        [m] = self.run_forge("milestones", *P, 60, 0)["milestones"]
        self.assertEqual((m["id"], m["due"], m["open"], m["closed"], m["all"]), (3, "2026-11-01", 2, 5, 7))
        items = self.run_forge("milestone-items", *P, "v1", 60, 0)["items"]
        self.assertEqual([(i["iid"], i["state"]) for i in items], [(3, "opened"), (1, "closed")])
        self.assertEqual(items[0]["assignees"], ["cy"])

    # -- velocity --

    def test_velocity_searches_from_a_utc_time(self):
        self.routes([[r"is:pr is:merged", {"out": {"data": {"search": conn([
            {"number": 1, "mergedAt": iso(NOW - DAY), "createdAt": iso(NOW - 3 * DAY)}, {}])}}}],
            [r"is:issue is:closed", {"out": {"data": {"search": conn([{"number": 4, "closedAt": iso(NOW - 2 * DAY)}])}}}]])
        out = self.run_forge("velocity", *P, 900, 0, "12w", NOW, 0)
        self.assertIsNone(out["error"])
        rows = {r["key"]: r for r in out["rows"]}
        self.assertEqual((rows["merged"]["now"], rows["closed"]["now"], rows["cycle"]["now"]), (1, 1, 2 * DAY))
        self.assertRegex(self.calls()[0], r"merged:>=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ")

    # -- milestone issues and issue notes --

    @staticmethod
    def mi(n, state="OPEN", prs=(), **kw):
        return {"number": n, "databaseId": 1000 + n, "title": f"Issue {n}", "state": state, "url": f"{URL}/issues/{n}",
                "updatedAt": iso(NOW - n * 60000), "closedAt": iso(NOW) if state == "CLOSED" else None,
                "labels": {"nodes": [{"name": "bug"}]}, "assignees": {"nodes": [{"login": "ann"}]},
                "comments": {"totalCount": 2}, "closedByPullRequestsReferences": {"nodes": list(prs)}, **kw}

    @staticmethod
    def cpr(n, r="acme/shop", **kw):
        return {"number": n, "title": f"PR {n}", "state": "MERGED", "isDraft": False, "headRefName": f"b{n}",
                "headRefOid": f"sha{n}", "url": f"{URL}/pull/{n}", "mergedAt": iso(NOW), "repository": {"nameWithOwner": r}, **kw}

    def milestone_route(self, title, nodes, pattern=r"milestone\(number", **extra):
        return [pattern, {"out": {"data": {"repository": {"milestone": {"title": title, "issues": {
            "totalCount": len(nodes), **conn(nodes)}}}}, **extra}}]

    def prime_milestones(self):
        self.routes([[r"milestones\(states:OPEN", repo(milestones=conn([{
            "number": 3, "title": "v1", "dueOn": None, "url": f"{URL}/milestone/3",
            "open": {"totalCount": 1}, "closed": {"totalCount": 1}}]))]])
        self.run_forge("milestones", *P, 600, 0)

    def test_milestone_issues_come_with_their_closing_prs(self):
        self.prime_milestones()
        self.routes([self.milestone_route("v1", [self.mi(1, "CLOSED", [self.cpr(5), self.cpr(6, r="other/repo")]), self.mi(2)])])
        out = self.run_forge("milestone-issues", *P, "v1", 600, 0)
        self.assertIsNone(out["error"])
        self.assertTrue(any("orderBy:{field:UPDATED_AT" in c and "-F m=3" in c for c in self.calls()))
        self.assertFalse(any("milestones?state=all" in c for c in self.calls()), "the cached list had the number")
        self.assertEqual([i["iid"] for i in out["issues"]], [2, 1], "open first")
        reqs = out["issues"][1]["requests"]
        self.assertEqual([(r["iid"], r["state"], r["via"]) for r in reqs], [(5, "merged", "closes")])
        self.assertEqual((reqs[0]["sha"], reqs[0]["merged_ms"]), ("sha5", NOW // 1000 * 1000))
        self.assertEqual((out["links"]["closes"], out["total"], out["partial"]), (True, 2, False))
        self.assertEqual((out["issues"][0]["labels"], out["issues"][0]["notes"]), (["bug"], 2))

    def test_milestone_issues_look_the_number_up_without_a_cached_list(self):
        self.routes([[r"milestones\?state=all", {"out": [{"number": 3, "title": "v1"}]}],
                     self.milestone_route("v1", [self.mi(1)])])
        self.assertEqual([i["iid"] for i in self.run_forge("milestone-issues", *P, "v1", 600, 0)["issues"]], [1])
        out = self.run_forge("milestone-issues", *P, "nope", 600, 0)
        self.assertEqual((out["issues"], out["total"], out["error"]), ([], 0, None))

    def test_milestone_issues_notice_a_renamed_milestone(self):
        self.prime_milestones()
        self.routes([[r"milestones\?state=all", {"out": [{"number": 3, "title": "v1.0"}]}], self.milestone_route("v1.0", [self.mi(1)])])
        out = self.run_forge("milestone-issues", *P, "v1", 600, 0)
        self.assertEqual((out["issues"], out["error"]), ([], None), "not another milestone's issues under the old name")
        self.routes([[r"milestones\?state=all", {"out": [{"number": 3, "title": "v1.0"}, {"number": 4, "title": "v1"}]}],
                     self.milestone_route("v1", [self.mi(1)], pattern=r"milestone\(number.* -F m=4"),
                     self.milestone_route("v1.0", [self.mi(9)])])
        out = self.run_forge("milestone-issues", *P, "v1", 600, 1)
        self.assertEqual([i["iid"] for i in out["issues"]], [1])

    def test_milestone_issues_skip_a_closing_pr_they_cant_see(self):
        self.prime_milestones()
        saml = {"message": "SAML", "type": "FORBIDDEN",
                "path": ["repository", "milestone", "issues", "nodes", 0, "closedByPullRequestsReferences", "nodes", 1]}
        # gh exits 1 when any part of a query failed.
        self.routes([[r"milestone\(number", {**self.milestone_route("v1", [self.mi(1, prs=[self.cpr(5), None])], errors=[saml])[1], "exit": 1}]])
        out = self.run_forge("milestone-issues", *P, "v1", 600, 0)
        self.assertIsNone(out["error"])
        self.assertEqual([r["iid"] for r in out["issues"][0]["requests"]], [5])

    # What `update` asks, and the REST number lookup once it has dropped the cached milestones.
    number_routes = [[r"-X (POST|DELETE|PATCH)", {"out": []}], [r"issue\(number:\$i\)", repo(issue=issue(1))],
                     [r"milestones\?state=all", {"out": [{"number": 3, "title": "v1"}]}]]

    def ms_page(self, nodes, total, cursor=None, after=None):
        """One page of milestone 3's issues; `after` is the cursor that asks for it."""
        pattern = r"milestone\(number" + (rf".* -f after={after}$" if after else r"(?!.* -f after=)")
        page = {"title": "v1", "issues": {"totalCount": total, **conn(nodes, more=cursor is not None, cursor=cursor)}}
        return [pattern, {"out": {"data": {"repository": {"milestone": page}}}}]

    def test_milestone_issues_walk_pages_and_stop(self):
        self.prime_milestones()
        self.page_routes = [self.ms_page([self.mi(1)], 3, cursor="c1"), self.ms_page([self.mi(2)], 3, cursor="c2", after="c1"),
                            self.ms_page([self.mi(3)], 3, after="c2")]
        self.routes(self.page_routes)
        out = self.run_forge("milestone-issues", *P, "v1", 600, 0)
        self.assertEqual((sorted(i["iid"] for i in out["issues"]), out["total"], out["partial"]), ([1, 2, 3], 3, False))
        # Out of time after the first page: what came back, partial.
        out = self.run_forge("milestone-issues", *P, "v1", 600, 1, HERDR_FORGE_BUDGET="0")
        self.assertEqual((sorted(i["iid"] for i in out["issues"]), out["partial"]), ([1, 2, 3], False),
                         "a shorter partial walk keeps the complete answer")
        self.routes(self.page_routes + self.number_routes)
        self.run_forge("update", *P, 1, json.dumps({"milestone": None}))  # drops the cached answer
        before = len(self.calls())
        out = self.run_forge("milestone-issues", *P, "v1", 600, 1, HERDR_FORGE_BUDGET="0")
        self.assertEqual(([i["iid"] for i in out["issues"]], out["total"], out["partial"]), ([1], 3, True))
        self.assertEqual(sum("milestone(number" in c for c in self.calls()[before:]), 1)
        # The page cap: five pages, then stop with pages left.
        self.routes([self.ms_page([self.mi(10)], 9, cursor="c1")]
                    + [self.ms_page([self.mi(10 + k)], 9, cursor=f"c{k + 1}", after=f"c{k}") for k in range(1, 6)]
                    + self.number_routes)
        before = len(self.calls())
        out = self.run_forge("milestone-issues", *P, "v1", 600, 1)
        self.assertEqual(sum("milestone(number" in c for c in self.calls()[before:]), 5)
        self.assertEqual((len(out["issues"]), out["partial"]), (5, True))

    def test_issue_notes_come_newest_first(self):
        # Oldest first, as GraphQL lists them; a deleted account's author is null.
        self.routes([[r"comments\(last", repo(issue={"comments": {"nodes": [
            {"databaseId": None, "author": None, "body": "ghost", "createdAt": iso(NOW - 120000)},
            {"databaseId": 1, "author": {"__typename": "User", "login": "di"}, "body": "old", "createdAt": iso(NOW - 60000)},
            {"databaseId": 2, "author": {"__typename": "Bot", "login": "eng"}, "body": "new\x1b[2J", "createdAt": iso(NOW)}]}})]])
        out = self.run_forge("issue-notes", *P, 7, 60, 0, 3)
        self.assertIsNone(out["error"])
        self.assertTrue(any("-F l=3" in c and "-F i=7" in c for c in self.calls()))
        self.assertEqual([(n["id"], n["author"], n["body"]) for n in out["notes"]],
                         [(2, "eng[bot]", "new[2J"), (1, "di", "old"), (None, None, "ghost")])
        self.assertFalse(out["partial"])

    def test_issue_notes_of_a_missing_issue_are_empty(self):
        self.routes([[r"comments\(last", {"out": {"data": {"repository": {"issue": None}}, "errors": [
            {"type": "NOT_FOUND", "path": ["repository", "issue"], "message": "Could not resolve to an Issue with the number of 99."}]},
            "exit": 1}]])
        out = self.run_forge("issue-notes", *P, 99, 60, 0)
        self.assertEqual((out["notes"], out["error"]), ([], None))
        self.routes([[r"comments\(last", {"out": {"data": {"repository": {"issue": None}}, "errors": [{"message": "Something went wrong"}]},
                                          "exit": 1}]])
        self.assertEqual(self.run_forge("issue-notes", *P, 98, 60, 0)["error"], "Something went wrong", "an error without a path fails")

    # -- issues --

    def test_issues_sync_and_query_with_github_scoped_labels(self):
        self.sync_issues([issue(1, ["priority: high", "bug"]), issue(2, ["priority: low"], state="CLOSED", closedAt=iso(NOW))])
        out = self.run_forge("query", *P, json.dumps({"state": "all"}))
        self.assertEqual(out["sep"], ": ")
        self.assertEqual(out["counts"]["scope:priority"], {"high": 1, "low": 1})
        self.assertEqual(out["counts"]["labels"], {"bug": 1})
        rows = {r[0]: r for r in out["rows"]}
        self.assertEqual((rows[1][2], rows[1][3], rows[1][5]), ("opened", "high", 1))
        self.assertEqual(rows[2][2], "closed")
        meta = self.run_forge("meta", *P)
        self.assertEqual(meta["labels"][0]["color"], "#d73a4a")
        self.assertEqual(meta["milestones"], [{"id": 3, "title": "v1", "due": "2026-11-01"}])

    def test_show_lists_this_repos_linked_prs(self):
        self.sync_issues([issue(1)])
        p = lambda n, r="acme/shop", **kw: {"number": n, "title": f"PR {n}", "state": "MERGED", "isDraft": False,
                                             "headRefName": f"b{n}", "url": f"{URL}/pull/{n}", "repository": {"nameWithOwner": r}, **kw}
        self.routes([[r"issues/1/comments", {"out": [{"id": 1, "user": {"login": "di"}, "body": "hi\x1b[2J", "created_at": iso(NOW)}]}],
                     [r"timelineItems", repo(issue={
                         "closedByPullRequestsReferences": {"nodes": [p(5)]},
                         "timelineItems": {"nodes": [{"source": p(5)}, {"source": p(6, state="OPEN", isDraft=True)},
                                                     {"source": p(7, r="other/repo")}, {"source": {}}, {"subject": p(8, state="CLOSED")}]}})]])
        out = self.run_forge("show", *P, 1)
        self.assertIsNone(out["error"])
        self.assertEqual([(r["iid"], r["state"], r["draft"]) for r in out["requests"]],
                         [(5, "merged", False), (6, "opened", True), (8, "closed", False)])
        self.assertEqual(out["notes"], [{"id": 1, "author": "di", "body": "hi[2J", "at_ms": NOW // 1000 * 1000}])

    def test_update_translates_fields(self):
        self.sync_issues([issue(1, ["priority: low"])])
        self.routes([[r"-X (POST|DELETE|PATCH)", {"out": []}],
                     [r"issue\(number:\$i\)", repo(issue=issue(1, ["priority: high"], state="CLOSED"))]])
        out = self.run_forge("update", *P, 1, json.dumps({"add_labels": ["priority: high"], "remove_labels": ["priority: low"],
                                                          "milestone": None, "state": "closed"}))
        self.assertEqual((out["issue"]["state"], out["issue"]["labels"]), ("closed", ["priority: high"]))
        add, remove, patch = [c for c in self.calls() if " -X " in c]
        self.assertIn('{"labels": ["priority: high"]}', add)
        self.assertIn("-X DELETE repos/acme/shop/issues/1/labels/priority%3A%20low", remove)
        self.assertIn('{"milestone": null, "state": "closed"}', patch)

    def test_update_drops_milestone_issues(self):
        self.prime_milestones()
        self.routes([self.milestone_route("v1", [self.mi(1)])])
        self.run_forge("milestone-issues", *P, "v1", 600, 0)
        self.routes(self.number_routes + [self.milestone_route("v1", [self.mi(1), self.mi(2)])])
        self.run_forge("update", *P, 1, json.dumps({"milestone": None}))
        out = self.run_forge("milestone-issues", *P, "v1", 600, 0)
        self.assertEqual([i["iid"] for i in out["issues"]], [1, 2], "refetched, not the cached answer")

    def test_removing_a_label_thats_already_gone_is_fine(self):
        self.sync_issues([issue(1)])
        self.routes([[r"-X DELETE", {"err": "gh: Label does not exist (HTTP 404)"}],
                     [r"issue\(number:\$i\)", repo(issue=issue(1))]])
        self.assertNotIn("error", self.run_forge("update", *P, 1, json.dumps({"remove_labels": ["x"]})))

    def test_comment(self):
        self.sync_issues([issue(1)])
        self.routes([[r"-X POST .*repos/acme/shop/issues/1/comments", {"out": {}}],
                     [r"issue\(number:\$i\)", repo(issue=issue(1, comments={"totalCount": 3}))],
                     [r"issues/1/comments", {"out": []}],
                     [r"timelineItems", repo(issue={})]])
        out = self.run_forge("comment", *P, 1, "Looks good")
        self.assertEqual(out["issue"]["notes"], 3)
        self.assertTrue(any('<<< {"body": "Looks good"}' in c for c in self.calls()))

    # -- transport --

    def test_rate_limits_pause_the_host(self):
        self.routes([[r".", {"err": "gh: API rate limit exceeded for user ID 1. (HTTP 403)"}]])
        self.run_forge("pipelines", *P, 60, 0)
        n = len(self.calls())
        self.assertIn("rate-limited", self.run_forge("pipelines", "github", "github.com", "acme/other", 60, 0)["error"])
        self.assertEqual(len(self.calls()), n)

    def test_issue_429_isnt_a_rate_limit(self):
        self.routes([[r".", {"err": "gh: Could not resolve to an Issue with the number of 429."}]])
        self.run_forge("pipelines", *P, 60, 0)
        self.assertNotIn("rate-limited", self.run_forge("pipelines", *P, 60, 1)["error"])

    def test_graphql_rate_limit_pauses_the_host(self):
        self.routes([[r".", {"err": "gh: API rate limit already exceeded for user ID 1."}]])
        self.run_forge("requests", *P, 60, 0)
        self.assertIn("rate-limited", self.run_forge("requests", *P, 60, 1)["error"])

    def test_partial_graphql_answers_keep_what_came(self):
        # gh exits 1 when any field failed, with the data on stdout.
        self.sync_issues([issue(1)])
        p5 = {"number": 5, "title": "PR 5", "state": "OPEN", "isDraft": False, "headRefName": "b5",
              "url": f"{URL}/pull/5", "repository": {"nameWithOwner": "acme/shop"}}
        partial = {"data": {"repository": {"issue": {"closedByPullRequestsReferences": {"nodes": [p5]},
                                                     "timelineItems": {"nodes": [{"source": None}]}}}},
                   "errors": [{"type": "FORBIDDEN", "message": "Resource protected by organization SAML enforcement."}]}
        self.routes([[r"issues/1/comments", {"out": []}],
                     [r"timelineItems", {"out": json.dumps(partial), "exit": 1, "stderr": "gh: Resource protected by organization SAML enforcement."}]])
        out = self.run_forge("show", *P, 1)
        self.assertIsNone(out["error"])
        self.assertEqual([r["iid"] for r in out["requests"]], [5])

    def test_repos_are_owner_and_name(self):
        self.assertIn("owner/name", self.run_forge("requests", "github", "github.com", "a/b/c", 60, 0)["error"])

    def test_missing_gh_is_reported(self):
        out = self.run_forge("requests", *P, 60, 0, HERDR_FORGE_BIN=self.home, PATH=self.home)
        self.assertTrue(out.get("nocli"))
        self.assertIn("gh isn't installed", out["error"])


if __name__ == "__main__":
    unittest.main()
