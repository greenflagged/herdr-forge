# How the mods fit together

This is the contract between the mods, `forge.py` and `lib.js`. Read it before changing
any of them; the README covers using the mods.

## The pieces

| Mod | What it shows | forge.py commands |
|---|---|---|
| `forge-requests` | Open MRs (GitLab) / PRs (GitHub), with CI badges, Merge and action buttons; then merged ones, their deploy, and Clean up; merge order chips | `requests`, `merge`, `merged`, `order` |
| `forge-ci` | Recent pipelines / workflow runs; click for jobs; Retry, Cancel | `pipelines`, `jobs`, `pipeline-act` |
| `forge-runners` | The project's own runners, what they run, jobs queued and stuck | `runners` |
| `forge-milestones` | Active milestones with progress; expand for their issues | `milestones`, `milestone-items` |
| `forge-velocity` | Commits, merged requests, closed issues, cycle time for the focused repo | `velocity`, `commits` |
| `forge-issues` | A full issue browser, opened as a tab; optional triage agent | `sync`, `meta`, `query`, `show`, `update`, `comment`, `launch`, triage ones |
| `forge-toggle` | A bar that shows or hides a hidden panel, or opens a mod's tab | none |

Every mod folder holds `main.js`, `mod.json`, `lib.js` and (except `forge-toggle`)
`forge.py`. `lib.js` and `forge.py` are copies of `shared/`; never edit the copies.
`npm run sync` writes them (stamping forge.py's `VERSION` as `<package version>+<hash>`),
and `npm test` fails when one is out of date. Machines that run forge.py must be POSIX
(macOS, Linux) with `python3`.

## Props every forge mod takes

```json
{ "repo": "group/project", "on": "my-mac", "provider": "gitlab", "host": "gitlab.com" }
```

- `repo`: the project path on the forge. Required except for `forge-velocity`, which
  follows the focused terminal.
- `on`: the Herdr machine where `glab`/`gh` is logged in and `forge.py` runs. Omitted or
  null: this computer.
- `provider`: `gitlab` (default) or `github`. Inferred from `host` when missing. `projectOf` gives `provider: null` for a host
  we don't support (Bitbucket, Codeberg): say so on screen instead of calling forge.py.
- `host`: defaults to `gitlab.com` / `github.com`. Self-hosted GitLab: set it.
- `folder`: the project's checkout on `on`, where agent actions start. `forge-requests`
  and `forge-issues` only.
- `actions`: see [actions.md](actions.md). `forge-requests` and `forge-issues` only.
- `migrations`: `forge-requests` only. A pattern (Python and JS regex alike) for migration file
  paths whose last group of digits (dots or underscores between them allowed) is the version;
  default `(^|/)V(\d+(?:[._]\d+)*)__[^/]*\.sql$` (Flyway, dotted versions too). Versions compare
  as Flyway does: `1_02_0` is `1.2`;
  `false` for none.
- `deploy`: `{ label?, check }`, `forge-requests` only. `check` is run as `sh -c check sh <merge sha>`
  in `folder` on `on`: exit 0 deployed, 1 not yet, anything else the check failed (its first
  output line is shown). Run only once the merge commit's CI passed (or after 10 minutes with no
  pipeline), at most once a minute per commit, never again after 0.

`lib.js`'s `projectOf(props())` resolves these into `{ provider, host, repo, on, terms }`.
Use `terms` for every forge word on screen: `terms.request` ("MR"/"PR"),
`terms.requests`, `terms.reqPrefix` ("!"/"#"), `terms.ci` ("Pipelines"/"Workflow
runs"), `terms.group` ("stage"/"workflow"), `terms.name` ("GitLab").

## Calling forge.py

```js
import { forgeClient, projectOf } from "./lib.js";
import { exec, readTextFile, appHome, props } from "herdr";

const MOD = "forge-ci";
// in init():
this.forge = forgeClient({ exec, readTextFile }, `${appHome()}/mods/${MOD}/forge.py`);
// later:
const { provider, host, repo, on } = projectOf(props());
const out = await this.forge(["pipelines", provider, host, repo, maxAge, force ? 1 : 0], { on });
```

- Every command prints one JSON object, and every read's answer always has its data key
  (`pipelines: []` on a first failure). `forgeClient` returns it, including when it has
  `error`: with a cached answer, the data is the last good one, so show the data and the
  error. It throws only when python can't run or the output isn't JSON.
- `nocli: true` with the error: the forge's CLI isn't installed on that machine.
- Times are epoch milliseconds (`*_ms`) everywhere; never `Date.parse` in a render.
  On screen they're ages (`ago`) or the viewer's local time with its zone (`stamp`); due
  dates are `"YYYY-MM-DD"` calendar days, never parsed as UTC (see lib.js).
- **Reads take `maxAge` (seconds) and `force`.** The answer's `at` is when it was fetched
  (epoch seconds, 0: never).
  - **First read after `init`: `maxAge` `-1`.** Any cached answer comes back at once,
    however old, so the panel draws instantly after a restart; only a missing one is
    fetched. Then poll with the refresh interval as `maxAge`.
  - **↻: `force` 1.**
- While one process fetches an answer, others asking for it get the last one (a 30 s
  lease), so panels in several windows don't fetch the same thing together.
- **One call must finish within Herdr's 30 s limit, so `forge.py` stops work at ~18 s.**
  `sync` and `accept-all` then answer `more: true`: call again soon. While the last
  `sync` ended with `more`, the next one carries on at once, forced or not (otherwise an
  unforced `sync` fetches at most every 45 s). Velocity fetches merged requests and
  closed issues separately, each from its own watermark: a walk cut short keeps the rows
  it got and carries on from where it stopped on the next fetch, and the answer's `at`
  moves only once both are complete. `milestones` past the budget starts no more count
  calls: those milestones come with `open`, `closed`, `all` null.
  A walking command that stops early says `partial: true` (its answer starts from page 1
  next time) or `more: true` (it carries on next time).

### Commands

`P` is `<provider> <host> <repo>`.

| Command | Answer |
|---|---|
| `requests P <maxAge> <force>` | `{requests: [Request], at, error}` |
| `merge P <iid> <sha>` | `{ok, text}` |
| `order P <maxAge> <force> [pattern]` | `{requests: {iid: Order}, targets: [{ref, folder, files}], at, error}`: for the open requests (the cached list); `targets`: the file names on each target branch in every folder where an open request has a path matching `pattern` |
| `merged P <maxAge> <force>` | `{merged: [Merged], at, error}`: merged in the last 7 days, newest first |
| `deployed P <sha> <text>` | `{ok}`: records that the deploy check said this merge commit is live. Final: `merged` returns it as `deployed` from then on, and the panel stops checking. Kept 90 days |
| `pipelines P <maxAge> <force>` | `{pipelines: [Pipeline], at, error}` |
| `jobs P <pipelineId> <maxAge> <force>` | `{jobs: [Job], at, error}` |
| `pipeline-act P <pipelineId> retry\|cancel` | `{ok}` |
| `runners P <maxAge> <force>` | `{runners: [Runner], jobs: [CiJob], at, error}` |
| `milestones P <maxAge> <force>` | `{milestones: [Milestone], at, error}` |
| `milestone-items P <title> <maxAge> <force>` | `{items: [MilestoneItem], at, error}` |
| `milestone-issues P <title> <maxAge> <force>` | `{issues: [MilestoneIssue], total, partial, links: {closes, closes_reason, requests, merged}, at, error}`: the milestone's issues with the requests that close them (below) |
| `issue-notes P <iid> <maxAge> <force> [n]` | `{notes: [Note], partial, at, error}`: the newest `n` comments (default 20, at most 100), newest first, system notes left out (below) |
| `velocity P <maxAge> <force> <12w\|30d> <nowMs> <tz>` | `{n, size, start, edges, at, error, rows: [Row]}` with row keys `merged`, `closed`, `cycle` |
| `commits <top> <ref> <12w\|30d> <nowMs> <tz> <force> [quick]` | `{n, size, start, edges, at, fetched, error, row: Row, total}`: run on the repo's machine. No maxAge: it re-reads git every 5 min and fetches an `origin/*` ref every 15; an empty ref means HEAD. `quick` 1: answer from the cache without git (a local `git log` when nothing is cached, never a fetch), for a panel's first draw |
| `sync P <since> <force>` | `{now, last_sync, error, changed, more, triage_at, triage_run}`: `changed` counts issues written after `since` (an issue the forge sends again unchanged isn't rewritten) |
| `meta P` | `{labels: [{name, color, description}], milestones: [{id, title, due}], sep}` |
| `query P <json>` | `{rows, offset, matched, total, counts, scopes, sep}` (below) |
| `search P <text>` | `{iids}`: full-text matches, best first |
| `show P <iid>` | `{iid, issue: Issue, description, notes: [Note], requests: [LinkedRequest], launches, triage, error}` |
| `update P <iid> <json>` | `{issue: Issue}`; json: `{add_labels?: [], remove_labels?: [], milestone?: id\|null, state?: "opened"\|"closed"}` |
| `comment P <iid> <body>` | same as `show` |
| `launch P <iid> <actionId> <tab>` | `{ok}`: records that an action started an agent |
| `triage P <iid> accepted\|dismissed`, `lock P <iid> 0\|1` | `{ok}` |
| `context P [chars]` | plain text: open issues for the triage agent. Everything from the forge sits between `<<<UNTRUSTED ISSUE DATA ...>>>` and `<<<END UNTRUSTED ISSUE DATA>>>` lines, each field on one line with control characters removed |
| `propose P <file.json>` | `{ok, issues, changes, skipped}`: the file is `[{iid, priority, rank, reason}]`, at most 5000 read; a `rank` that isn't a whole number is null |
| `accept-all P` | `{accepted, failed, more}` |
| `skill <status\|install> <name> <text> [replace]` | `{installed, current, older, foreign, version, path}`: `foreign` is a same-named skill that didn't come from herdr-forge (its first line after the frontmatter isn't `<!-- Shipped with herdr-forge X.Y.Z`); install leaves it alone unless given `replace` |
| `version` | `{version, shapes}` |

Writes (`merge`, `pipeline-act`, `update`, `comment`, triage ones) answer `{error}` instead
when they fail; nothing is cached for them. Writes drop the cached answers they change: `merge` drops requests, merged, order, CI and velocity;
`pipeline-act` drops CI and runners' jobs; `update` drops milestones (`milestone-issues`
too) and velocity; `comment` drops the issue's `issue-notes`. Whatever drops `milestone-items`
drops `milestone-issues` too.
Velocity isn't a cached answer: dropping it sets `velocity_at` to 0, so its next read fetches.

`show`, `milestone-issues` and `issue-notes` clean what they return: titles, label and
milestone names, assignees, authors and branch names are one line without control
characters; descriptions and comments lose control characters but keep their newlines.
They are still untrusted: anyone who can comment wrote them.

#### `milestone-issues`

- `issues`: up to 500, most recently updated first (open ones first in the answer).
  `total`: how many the milestone has (the forge's count; null when it isn't known).
- `partial`: the walk stopped before the end (time ran out, or the 5-page cap). The most
  recently updated issues came first, so the ones missing are the least recently updated,
  open ones that haven't changed lately included; `total` counts all states, and some
  `requests` may be missing. Force at most once per `maxAge`: if the answer is still
  partial, that is the steady state for this milestone, so poll normally and read `total`.
  A refetch (forced or not) that comes back partial with fewer issues than a complete
  answer under an hour old keeps that answer: `partial` stays false and `at` doesn't move
  (`at` is still when that data was fetched). The kept answer then counts as fresh for
  `maxAge` from the refetch, but not past an hour from `at`, so polls don't walk the
  milestone again before then. A kept answer looks just like one a concurrent fetch left
  in place: same answer, same `at`.
  So during that hour, `partial: false` after a forced refetch doesn't mean the walk
  finished, and a milestone whose walks are always partial shows no partial answer until
  the complete one is an hour old. After that, the next refetch's answer replaces it.
- An unknown milestone title (renamed, deleted, or a typo) answers `issues: []`, `total: 0`,
  `error: null`, the same as an empty milestone. Check the title against `milestones` to
  tell them apart.
- `links.closes`: the forge's own closing links are in this answer. False on a GitLab
  without the work-item development widget (checked again after 24 h): `links.closes_reason`
  then holds the server's words, `requests` hold branch matches only, and `error` stays null.
  Also false, on either forge, when nothing has been fetched yet: the first fetch failed,
  so `issues` is empty and `error` is set.
- `links.requests`, `links.merged`: the `at` of the cached `requests` / `merged` answer this
  one was joined with, or null when none was used (none cached in this shape, or cached
  more than an hour ago). They are as fresh as whoever last polled them (any mod on this
  machine) and cover what those answers hold: open requests (GitLab: the 50 most recently
  updated) and the last 7 days of merges. A consumer that polls neither gets both null and
  closing links only.

#### `issue-notes`

One call per issue; a batched form, if it comes, will be a new command. `partial`: fewer
than `n` came back because time ran out, not because the issue has no more, so a search
through them is inconclusive. It and `show` keep their own copies of the comments and
refresh them by different rules, so they can disagree until both have refetched.

#### Polling a milestone cheaply

Poll `milestone-issues` per milestone on screen: one cached answer, one GraphQL page per
100 issues on GitHub, one REST page plus one GraphQL page per 100 issues on GitLab, at most
5 of each. Keep polling `requests` and `merged`: they carry CI (join by iid) and feed the
branch matches. Fetch `issue-notes` with a long `maxAge`, forcing it when an issue's
`updated_ms` or `notes` changed: a new comment moves both on both forges, a deleted one
moves `notes`, an edited one moves `updated_ms` on GitLab (unverified on GitHub). So for
issues whose comments you act on, also poll `issue-notes` with a bounded `maxAge` (10
minutes is plenty). A `comment` through forge.py drops the issue's notes, so the next read
refetches; `show`'s copy refetches when the issue next syncs.

### Shapes

```
Request    {iid, title, url, draft, auto_merge, conflicts, source, target, sha, fork, author,
            labels[], created_ms, updated_ms, ci: {id, status, url, updated_ms} | null}
           fork: the source branch is in another project (a fork), so `source` names a
           branch that isn't in this repo
Order      {sha, behind, rebase, files[]}   behind: commits the target gained since the branch
           point (null if unknown); rebase: it can't merge until rebased (GitLab need_rebase,
           or behind on a fast-forward / semi-linear project; GitHub BEHIND); files: paths it
           changes, both sides of a rename (GitHub: the first 100)
Merged     {iid, title, url, author, source, target, fork, head_sha, merge_sha, merged_ms,
            ci: {id, status, url, updated_ms} | null, deployed: {at_ms, text} | null}
           merge_sha: what landed on target (the merge or squash commit; the head for a
           fast-forward); ci: the newest pipeline for merge_sha on target (GitLab), the merge
           commit's rolled-up checks (GitHub, id null), null when none ran;
           deployed: {at_ms, text} once `deployed` recorded it, else null
Pipeline   {id, iid, ref, sha, status, source, updated_ms, url, name?} ref: "main" or "!811";
           source: "request" (an MR/PR pipeline), else the forge's word (push, schedule, web...);
           name: the workflow's name (GitHub only)
Job        {id, name, group, status, duration, allow_failure, url}    group: stage / workflow
Runner     {id, name, status, paused, url, details, running: [jobId],
            tags[], run_untagged, version, platform, arch, contacted_ms}   last six: when details
CiJob      {id, name, group, status, started_ms, created_ms, tags[], runner: {id, name} | null,
            ref, pipeline, url, elsewhere, stuck}
Milestone  {id, title, due, url, open, closed, all}                  due: "YYYY-MM-DD" | null;
           open/closed/all: null when the call ran out of time before counting it
MilestoneItem {id, iid, title, state, assignees[], url}              open ones first
MilestoneIssue {id, iid, title, state, labels[], assignees[], url, updated_ms, closed_ms, notes,
            triage: {rank, priority, status, locked} | null, requests: [LinkedRequest]}
           notes: the comment count; triage: this machine's triage row, read fresh
Row        {key, values: [n per bucket], now, avg, unit?: "duration", lowerBetter?}
Issue      {iid, title, state, labels[], milestone: {id, title, due} | null, assignees[], author,
            created_ms, updated_ms, closed_ms, notes, requests, weight, blocking, url}
Note       {id, author, body, at_ms}   id: the forge's comment id; may be null (a `show` row
           cached by an older version, or a GitHub comment without a database id)
LinkedRequest {iid, title, state, draft, source, url, sha, merged_ms, via}
           state: opened | merged | closed. sha, merged_ms and via are filled by
           `milestone-issues` and null on `show` rows. sha: the head commit; merged_ms: null
           unless merged; via: "closes" is the forge's own link (the request closes the
           issue; up to 20 per issue, the first 20 the forge lists). Any other value is
           weaker, and more may come: treat an unknown one like "branch" (an open or
           recently merged request whose source branch holds the issue number as its own
           run of digits; check the title). For a request a fresher `requests` / `merged`
           answer also holds, state, sha, draft and merged_ms are theirs (a merge always
           wins); otherwise the milestone fetch's.
```

`iid` is the number people see (`#12`, `!7`; issues are `#` on every forge). CI statuses use GitLab's words on every
forge: `created`, `waiting_for_resource`, `preparing`, `pending`, `running`, `success`,
`failed`, `canceled`, `skipped`, `manual`, `scheduled`.

Velocity buckets: bucket `i` covers `[edges[i], edges[i+1])` (an older answer without
`edges`: `[start + i*size, start + (i+1)*size)`). `30d` buckets are the viewer's calendar
days, midnight to midnight, 23 or 25 hours across a DST change; `12w` ones are rolling weeks
ending now. `tz` is `getTimezoneOffset()` now, then at each of the 31 midnights (lib.js's
`tzArg()`), since forge.py may run on a machine in another zone. `now` is the
last 7 days, `avg` the average week over 12 weeks (for `duration` rows, medians in ms).

### What the shapes mean on GitHub

`GitHub` in forge.py talks to `gh api` (REST, and GraphQL where REST would need more calls or
mixes PRs into issues). Mods must cope with the nulls:

- `repo` is `owner/name`; anything deeper is refused.
- `Request.ci` is the PR head commit's rolled-up check status (`statusCheckRollup`); `id` null,
  `url` the PR's checks page, `updated_ms` the PR's. It comes with `requests` in one call.
- `merge` picks the first allowed method (merge, squash, rebase; read through GraphQL, since
  REST shows them only to admins) and passes `sha`. Refused for
  required status checks or a merge queue, it enables auto-merge instead (`text` says so).
- `Pipeline` is one workflow run: `iid` the run number, `ref` the branch or `#<pr>` (a fork's PR
  run has no PR attached, so its branch), `name` the workflow. `Job.group` is the workflow name,
  `allow_failure` always false, `duration` null until the job completes. `retry` reruns the
  failed jobs when the run failed, was cancelled or timed out, else the whole run; `cancel`
  cancels the run.
- `Runner`: the repository's own self-hosted runners (not the organisation's); listing them
  needs admin rights, and without them `runners`
  answers that error (with `jobs` still filled). Details come with the list: `tags` are the
  runner's labels lowercased, `run_untagged` always true, `version` and `contacted_ms` null,
  `platform` the OS, `arch` from the labels. `CiJob.tags` are the job's `runs-on` labels;
  `waiting: true` marks a job waiting for a deployment approval. A pending job is `stuck` only
  when it asks for `self-hosted`, isn't waiting, and the repository has runners; nothing is
  stuck while the runner list failed.
- `Milestone.id` is the milestone number (what `update`'s `milestone` takes); counts are issues
  only (GraphQL), so they come with the milestone and are never null.
- `Issue.weight` and `blocking` are null; `requests` counts the PRs that close the issue.
  `show`'s requests are the closing PRs plus cross-referenced and connected ones, from this
  repository only. `LinkedRequest.state` is `opened`, `merged` or `closed`.
- `milestone-issues` finds the milestone's number in the cached `milestones` answer (open
  milestones), else through REST (`milestones?state=all`, one page per 100 milestones): a
  closed milestone pays that lookup on every refetch, seconds on a repository with hundreds.
  A cached number whose milestone now has another title is looked up again. Then one
  GraphQL call per 100 issues; closing PRs from this repository only. It assumes github.com's
  schema (`closedByPullRequestsReferences`, `Milestone.issues(orderBy:)`): an older GitHub
  Enterprise Server answers `error` on every poll. `issue-notes` is one GraphQL call; bot
  authors read `name[bot]`, as REST and `show` name them.
- Velocity comes from search (`is:pr is:merged merged:>=...`), which stops at 1000 results.
- GraphQL answers with some failed fields (an inaccessible cross-reference) keep what came
  back; `gh` exits 1 for them, so `run` hands back their output. `milestone-issues` and
  `issue-notes` are stricter. `milestone-issues` skips only an error inside a closing PR.
  `issue-notes` skips only an error at an author, and a NOT_FOUND at `repository.issue` (no
  such issue), which answers `notes: []` with `error: null`. Any other error fails the fetch
  (the last good answer stays, with `error`).
- Scoped labels: GitHub has none; the separator is a setting (`query`'s `sep`), default
  `": "` (`priority: high`). Accepting a triage proposal adds the label, which GitHub creates
  if it's missing.
- Rate limits: the secondary limit pauses the host 2 minutes, the primary one (REST or
  GraphQL) 10.

### Issue queries

`query` takes `{state: "opened"|"closed"|"all", q, picked: {group: [values]}, sort:
"priority"|"updated"|"created"|"triage", offset, limit, sep?}` and answers one page:

- `rows`: `[iid, title, state, priority, type, requests, updated_ms, proposedPriority, launched]`.
- `counts`: `{group: {value: n}}` for the sidebar. Groups: `scope:<name>` for every scoped
  label in use (`priority::high` is group `scope:priority`, value `high`), `milestone`,
  `triage`, `labels` (unscoped ones). `(none)` counts issues without a value.
- `scopes`: scope names the project's issues use, in any state, most used first.
- `sep`: the scoped-label separator (`::` on GitLab). Passing `sep` changes and remembers it.
- `picked` uses the same group names; values within a group are OR, groups are AND.
  The exception is `labels`: plain labels are independent tags, so picking `bug` and
  `ui` means issues with both (AND), not either.

## lib.js

- `projectOf(props)`, `TERMS`, `providerForHost(host, forges)`, `parseRemote(url)`.
- `forgeClient(h, scriptPath)`: above.
- `isShown(layout(), MOD, { repo }, { panes: panes(), spaces: spaces() })`: whether a copy
  of this mod is on screen: a layout block that isn't hidden, or a mod pane in the shown
  tab. Herdr keeps hidden mods running, so every polling mod checks this before fetching.
  It answers for any copy with those props (Herdr doesn't tell a block its own id), and
  fails safe (true) when it can't tell.
- `requestItem(request, project)`, `issueItem(issue, project, sep)`: the fields actions see.
- `ago(ms)` ("now", "3m", "2h", "5d": write "3m ago" yourself, and "now" alone),
  `clock(seconds)`, `span(ms)`, `num(x, digits)`, `openUrl(exec, url)`.
- Times in the viewer's zone. Herdr's engine has no `Intl` (and `toLocaleString` ignores
  its options), but local `Date` getters follow the OS zone with DST, so zones are named
  from the offset: `zoneLabel(ms)` ("UTC−7", "UTC+5:30", "UTC"), `localTime(ms, now)`
  ("Oct 31, 1:40 PM UTC−7", the year when it isn't this one), `stamp(ms)` (the same,
  remembered: use it for tooltips built in render), `agoAt(ms)` ("2h ago (Oct 31, 1:40 PM
  UTC−7)"). Due dates: `daysUntil(date)`, `dateLabel(date)` ("Sun Nov 1"), `localDay(date)`
  (local midnight, for sorting). `tzArg(now)`: velocity's `tz`.
- `checkoutOf(folder, spaces(), on, repo)`: where agents start when `props.folder` is
  missing: a space on `on` whose folder is named exactly `<name>` or `<owner>-<name>`
  (`shop` or `acme-shop` for `acme/shop`).
- Actions: `fill`, `matches`, `actionList`, `describe`, `runAction`, `WORKTREE`. See
  actions.md.

## Shared state

Mods talk through Herdr's `shared(key)` / `setShared(key, value)`:

| Key | Written by | Value |
|---|---|---|
| `forge.requestAgents` | any mod (e.g. an agents list) | `{requestUrl: [{address, name}]}`: agents working on a request; `forge-requests` and `forge-issues` show them. Optional: `forge-requests` also finds agents on a request's branch itself, and shows both. Clean up on a merged request ends the listed agents too (never their folders), so keep an agent listed on its request while it lives, even after its worktree is gone |
| `forge-requests.actions` | any mod | `{owner: {at, actions: [Action]}}`: extra buttons on requests |
| `forge-issues.actions` | any mod | `{owner: {at, actions: [Action]}}`: extra buttons on issues |
| `forge-issues.selected` | `forge-issues` | the open issue's action fields (`issueItem`), or null |
| `forge-issues.event` | `forge-issues` | `{type, iid, repo, host, at}` after each change it writes; `type: "action"` adds `action` (its id); a change to many issues at once (accept-all) has `iid: null` and `iids` |

Setting shared state redraws every mod: write only on real changes.

## Stable for agents and other packages

Agents, skills and other people's mods will call these, so they only ever gain things:

- **forge.py, through the stable path** `~/.local/share/herdr-forge/forge.py` (the
  newest release installed): `version`, `sync`, `query`, `search`, `show`, `context`,
  `propose`, `accept-all`. Their arguments keep their order. New options come as new
  commands or `--name=value` flags at the end, never new positional slots.
- **Shared-state keys and their values** above: fields are only added, and readers ignore
  fields they don't know.
- **Action fields** (actions.md) and **props** names.

Internal, and free to change between releases: every other forge.py command (each mod
runs its own pinned `forge-<version>.py`), the SQLite schema, `lib.js`.

## Mixed versions

Herdr doesn't update mods, and people copy them one at a time, so one machine runs
several versions of forge.py against the same databases. The rules that keep that safe:

- **Answer shapes are numbered (`SHAPES`), and cached answers carry theirs.** One with
  another shape is a miss. Change an answer's shape: bump `SHAPES`. Each shape has its
  own cache row (`<key>@<shape>`, e.g. `pipelines@2`), so two versions polling the same
  thing don't keep overwriting each other's answer; dropping a key drops every shape.
- **The schema only grows.** Migrations (`MIGRATIONS`, tracked in `PRAGMA user_version`)
  only add tables, columns and indexes, and every statement names its columns. An older
  forge.py then works on a database a newer one migrated.
- **Rebuildable tables** can be dropped and fetched again if a change ever needs it:
  `cache`, `issues`, `issues_fts`, `details`, `merged`, `closed`. **The person's own
  state** needs real migrations: `triage`, `launches`, `meta`.
- **Installs never downgrade shared things.** The stable `forge.py` and shipped skills are
  only replaced by the same or a newer release.

## What it writes where

- `~/.local/share/herdr-forge/` (or `$HERDR_FORGE_HOME`, or `$XDG_DATA_HOME/herdr-forge`),
  on each machine forge.py runs on. The folder is made private (0700) and everything in
  it is written readable by its owner only, since the caches hold issue text:
  - `forge-<version>.py`: one per version in use, removed after two weeks unused.
  - `forge.py`: the newest.
  - `<host>/<owner__project>.db`: the cache, including issue text and comments.
  - `<host>/backoff`: the rate-limit pause.
  - `git.db`: commit times per checkout (velocity), pruned after 30 days unused. `commits`
    only takes branch-like refs (letters, digits, `_ . / -`, not starting with `-`) and
    passes them after `--end-of-options` where the installed version supports it.
- Cached answers nobody asked for in a week are deleted.
- `~/.claude/skills/triage-issues/` only when the person clicks Install in Issues.
- Removing everything: delete those folders.

## Untrusted input

Issue and request text, branch names, label and milestone names come from anyone who can
open an issue or push a branch. `forge.py` refuses hosts and project paths that could
leave its folder or read as options (a host is letters and digits with `.` or `-` inside;
no path segment starts with `.` or `-`), and `context`/`show` hand agents cleaned,
clearly marked text. Mods: put such text in its own `exec` argument, never in a shell
script (see actions.md).

## Rules for the mods

- Herdr's JS engine is about 1000x slower than V8 and kills slow renders and tasks. Sorting,
  filtering and bucketing happen in `forge.py`; renders only draw.
- Poll only while shown (`isShown`), and gently: 60 s by default, faster only while
  something is running and the window is focused (`window().active`).
- Colors from `theme()`; links through `openUrl`.
- `herdr-app check mods/<name>` must pass.
