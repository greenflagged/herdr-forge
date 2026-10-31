# How the mods fit together

This is the contract between the mods, `forge.py` and `lib.js`. Read it before changing
any of them; the README covers using the mods.

## The pieces

| Mod | What it shows | forge.py commands |
|---|---|---|
| `forge-requests` | Open MRs (GitLab) / PRs (GitHub), with CI badges, Merge and action buttons | `requests`, `merge` |
| `forge-ci` | Recent pipelines / workflow runs; click for jobs; Retry, Cancel | `pipelines`, `jobs`, `pipeline-act` |
| `forge-runners` | The project's own runners, what they run, jobs queued and stuck | `runners` |
| `forge-milestones` | Active milestones with progress; expand for their issues | `milestones`, `milestone-items` |
| `forge-velocity` | Commits, merged requests, closed issues, cycle time for the focused repo | `velocity`, `commits` |
| `forge-issues` | A full issue browser, opened as a tab; optional triage agent | `sync`, `meta`, `query`, `show`, `update`, `comment`, `launch`, triage ones |
| `forge-toggle` | A bar that shows or hides a hidden panel, or opens a mod's tab | none |

Every mod folder holds `main.js`, `mod.json`, `lib.js` and (except `forge-toggle`)
`forge.py`. `lib.js` and `forge.py` are copies of `shared/`; never edit the copies.
`npm run sync` writes them, and `npm test` fails when one is out of date.

## Props every forge mod takes

```json
{ "repo": "group/project", "on": "my-mac", "provider": "gitlab", "host": "gitlab.com" }
```

- `repo`: the project path on the forge. Required except for `forge-velocity`, which
  follows the focused terminal.
- `on`: the Herdr machine where `glab`/`gh` is logged in and `forge.py` runs. Omitted or
  null: this computer.
- `provider`: `gitlab` (default) or `github` (not built yet: `forge.py` answers with an
  error). Inferred from `host` when missing.
- `host`: defaults to `gitlab.com` / `github.com`. Self-hosted GitLab: set it.
- `folder`: the project's checkout on `on`, where agent actions start. `forge-requests`
  and `forge-issues` only.
- `actions`: see [actions.md](actions.md). `forge-requests` and `forge-issues` only.

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

- Every command prints one JSON object. `forgeClient` returns it, including when it has
  `error`: the cached answer is still there (stale), so show the data and the error.
  It throws only when python can't run or the output isn't JSON.
- `nocli: true` with the error: the forge's CLI isn't installed on that machine.
- Times are epoch milliseconds (`*_ms`) everywhere; never `Date.parse` in a render.
- Reads take `maxAge` (seconds) and `force` (1: fetch now). The answer's `at` is when it
  was fetched (epoch seconds). Pass the refresh interval as `maxAge` and force only on ↻.

### Commands

`P` is `<provider> <host> <repo>`.

| Command | Answer |
|---|---|
| `requests P <maxAge> <force>` | `{requests: [Request], at, error}` |
| `merge P <iid> <sha>` | `{ok, text}` |
| `pipelines P <maxAge> <force>` | `{pipelines: [Pipeline], at, error}` |
| `jobs P <pipelineId> <maxAge> <force>` | `{jobs: [Job], at, error}` |
| `pipeline-act P <pipelineId> retry\|cancel` | `{ok}` |
| `runners P <maxAge> <force>` | `{runners: [Runner], jobs: [CiJob], at, error}` |
| `milestones P <maxAge> <force>` | `{milestones: [Milestone], at, error}` |
| `milestone-items P <title> <maxAge> <force>` | `{items: [MilestoneItem], at, error}` |
| `velocity P <maxAge> <force> <12w\|30d> <nowMs> <tzOffsetMin>` | `{n, size, start, at, error, rows: [Row]}` with row keys `merged`, `closed`, `cycle` |
| `commits <top> <ref> <12w\|30d> <nowMs> <tzOffsetMin> <force>` | `{n, size, start, at, error, row: Row, total}`: run on the repo's machine |
| `sync P <since> <force>` | `{now, last_sync, error, changed, triage_at, triage_run}` |
| `meta P` | `{labels: [{name, color, description}], milestones: [{id, title, due}], sep}` |
| `query P <json>` | `{rows, offset, matched, total, counts, scopes, sep}` (below) |
| `show P <iid>` | `{iid, issue: Issue, description, notes, requests, launches, triage, error}` |
| `update P <iid> <json>` | `{issue: Issue}`; json: `{add_labels?: [], remove_labels?: [], milestone?: id\|null, state?: "opened"\|"closed"}` |
| `comment P <iid> <body>` | same as `show` |
| `launch P <iid> <actionId> <tab>` | `{ok}`: records that an action started an agent |
| `triage P <iid> accepted\|dismissed`, `lock P <iid> 0\|1` | `{ok}` |
| `context P [chars]` | plain text: open issues for the triage agent |
| `propose P <file.json>`, `accept-all P` | triage results in, accepted priorities out |
| `skill <status\|install> <name> <text>` | `{installed, current, path}`: a Claude Code skill in `~/.claude/skills/<name>/` |

### Shapes

```
Request    {iid, title, url, draft, auto_merge, conflicts, source, target, sha, author,
            labels[], created_ms, updated_ms, ci: {id, status, url, updated_ms} | null}
Pipeline   {id, iid, ref, sha, status, source, updated_ms, url}      ref: "main" or "!811"
Job        {id, name, group, status, duration, allow_failure, url}    group: stage / workflow
Runner     {id, name, status, paused, url, details, tags[], run_untagged, version, platform,
            arch, contacted_ms, running: [jobId]}                     details: tags etc. loaded
CiJob      {id, name, group, status, started_ms, created_ms, tags[], runner: {id, name} | null,
            ref, pipeline, url, elsewhere, stuck}
Milestone  {id, title, due, url, open, closed, all}                  due: "YYYY-MM-DD" | null
MilestoneItem {id, iid, title, state, assignees[], url}              open ones first
Row        {key, values: [n per bucket], now, avg, unit?: "duration", lowerBetter?}
Issue      {iid, title, state, labels[], milestone: {id, title, due} | null, assignees[], author,
            created_ms, updated_ms, closed_ms, notes, requests, weight, blocking, url}
```

CI statuses use GitLab's words on every forge: `created`, `waiting_for_resource`,
`preparing`, `pending`, `running`, `success`, `failed`, `canceled`, `skipped`, `manual`,
`scheduled`.

Velocity buckets: bucket `i` covers `[start + i*size, start + (i+1)*size)`. `now` is the
last 7 days, `avg` the average week over 12 weeks (for `duration` rows, medians in ms).

### Issue queries

`query` takes `{state: "opened"|"closed"|"all", q, picked: {group: [values]}, sort:
"priority"|"updated"|"created"|"triage", offset, limit, sep?}` and answers one page:

- `rows`: `[iid, title, state, priority, type, requests, updated_ms, proposedPriority, launched]`.
- `counts`: `{group: {value: n}}` for the sidebar. Groups: `scope:<name>` for every scoped
  label in use (`priority::high` is group `scope:priority`, value `high`), `milestone`,
  `triage`, `labels` (unscoped ones). `(none)` counts issues without a value.
- `scopes`: scope names in use, most used first.
- `sep`: the scoped-label separator (`::` on GitLab). Passing `sep` changes and remembers it.
- `picked` uses the same group names; values within a group are OR, groups are AND.

## lib.js

- `projectOf(props)`, `TERMS`, `providerForHost(host, forges)`, `parseRemote(url)`.
- `forgeClient(h, scriptPath)`: above.
- `isShown(layout(), MOD, { repo })`: whether a block showing this mod is on screen. Herdr
  keeps hidden mods running: every polling mod checks this before fetching. A mod that
  isn't in the layout tree (a tab pane) counts as shown.
- `ago(ms)`, `clock(seconds)`, `span(ms)`, `num(x, digits)`, `openUrl(exec, url)`.
- Actions: `fill`, `matches`, `actionList`, `describe`, `runAction`. See actions.md.

## Shared state

Mods talk through Herdr's `shared(key)` / `setShared(key, value)`:

| Key | Written by | Value |
|---|---|---|
| `forge.requestAgents` | any mod (e.g. an agents list) | `{requestUrl: [{address, name}]}`: agents working on a request; `forge-requests` and `forge-issues` show them |
| `forge-requests.actions` | any mod | `{owner: [Action]}`: extra buttons on requests |
| `forge-issues.actions` | any mod | `{owner: [Action]}`: extra buttons on issues |
| `forge-issues.selected` | `forge-issues` | the open issue's action context, or null |
| `forge-issues.event` | `forge-issues` | `{type, iid, repo, host, at, ...}` after each change it writes |

Setting shared state redraws every mod: write only on real changes.

## Rules for the mods

- Herdr's JS engine is about 1000x slower than V8 and kills slow renders and tasks. Sorting,
  filtering and bucketing happen in `forge.py`; renders only draw.
- Poll only while shown (`isShown`), and gently: 60 s by default, faster only while
  something is running and the window is focused (`window().active`).
- Colors from `theme()`; links through `openUrl`.
- `herdr-app check mods/<name>` must pass.
