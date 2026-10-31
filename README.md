# Forge for Herdr

Forge puts your GitLab or GitHub project inside [Herdr](https://herdr.dev). You get open merge requests
(or pull requests) you can merge or hand to an agent, CI pipelines or workflow runs and runners, milestones, a velocity chart, and a full issue
browser that starts agents on issues. Press **ctrl-shift-f** and the whole window turns into Forge
for the repo of the terminal you're in.

GitLab (gitlab.com and self-hosted) and GitHub (github.com; Enterprise Server through `host`). The
panels use each forge's own words: MRs and pipelines on GitLab, PRs and workflow runs on GitHub.
See [On GitHub](#on-github) for what differs.

![Forge: merge requests, milestones and velocity on the left, then pipelines, runners and the issue browser with an issue open](preview.png)

## Forge

**ctrl-shift-f** switches the whole Herdr window to Forge, with every panel for the repo of the
focused terminal. Press it again, or **Back** in the bar, to return to your layout. **Other project**
in the bar opens the repo of another space.

Click a panel's header to collapse it in place, and again to bring it back. Hover the header for ⧉,
which opens the panel as a pane beside your terminals, and ↗, which detaches it into its own window.
Herdr remembers the sizes you choose.

You can also put any panel in your own layout (see [Panels in your layout](#panels-in-your-layout)).
Panels there work the same way.

## Merge requests and CI

![Open merge requests, milestones with their progress, and the pipelines list](docs/requests-ci.png)

- **Merge requests:** each open MR with its draft, auto-merge, conflict and pipeline status. Hover one
  for **Merge**. It asks first, and it merges only the commit you saw.
  - On an MR that has been open for a day or more, **Ship** starts an agent. The agent fixes what's
    outstanding, then waits for your go-ahead to merge.
  - On a conflicted MR, **Resolve** starts an agent that rebases it and force-pushes the branch, without merging.
  - Both work in a worktree of the MR's branch.
- **Pipelines:** the last 20. Click one for its jobs by stage; hover for Retry, Cancel and ↗.
- **Runners:** the project's own runners, what each is running, and queued jobs, flagged red when no
  online runner has their tags.
- **Milestones:** progress for each active milestone, soonest due first. Click one for its issues.
- **Velocity:** commits, merged MRs, closed issues and MR cycle time over 12 weeks or 30 days, against
  your average week.

## Issues

![The issue browser filtered to low priority: filters from scoped labels on the left, the list, and an issue with its fields as dropdowns](docs/issues.png)

Every issue in the project, cached on your machine so filtering and search are instant.

- Filters come from your scoped labels (`priority::high`, `type::bug`, `team::web`), with counts.
- Search titles and descriptions, or jump to `#123`. Use ↑/↓ or j/k to move, `/` to search.
- Change priority, type, milestone and the other scoped labels from dropdowns, add or remove labels,
  comment, close and reopen. Every change goes to the forge first.
- Your own buttons on each issue (below).

## Make it yours

You write the list of buttons on merge requests and issues. Each button can start an agent with your
prompt, run a program, run a Herdr command, or open a mod of your own with the issue. A button can
depend on labels, state or age. Other mods can add buttons while they run. The issue browser also
tells other mods which issue is open and what just changed.

```json
"actions": [
  { "id": "fix", "label": "Fix it", "when": { "labels": ["type::bug"] },
    "task": "Fix issue {ref} in {repo}: {title}\n\n{url}" }
]
```

[docs/actions.md](docs/actions.md) has every field and placeholder, with examples.

### Triage agent (optional)

Turn it on with `"triage": true` in the issue browser's settings. **Install skill** puts the
`triage-issues` skill in `~/.claude/skills`. **Triage** then starts Claude Code, which proposes a
priority, a rank and a one-line reason for every open issue. You accept or dismiss each proposal, or
accept them all. Nothing changes on the forge until you accept. A priority you set by hand is kept.

## On GitHub

The panels work the same way; a few things follow from how GitHub works:

- **Checks:** a PR's badge is its head commit's checks rolled up into one status. Click it for the
  checks page.
- **Merge** uses the first method the repository allows (merge commit, then squash, then rebase).
  While required checks still run, it turns on auto-merge instead, which the repository has to allow.
- **Runners** lists the repository's self-hosted runners, and needs admin rights to the repository;
  without them the panel says so. Queued jobs show as stuck only when they ask for `self-hosted` and
  none of your runners has their labels. Jobs on GitHub's own runners show as running elsewhere.
- **Scoped labels:** GitHub has none, so Forge reads `priority: high` as scope `priority`, value
  `high`. Set the issue browser's `scopeSep` prop if yours differ.
- **Issues:** weight and blocking counts are GitLab-only. Linked PRs are the ones that close the
  issue or mention it, from the same repository.
- **Velocity** uses GitHub search, which stops at 1000 results: a repository merging more than 1000
  PRs in 12 weeks sees only the newest 1000.

## Install

You need `python3` and the forge's CLI logged in on the machine the panels should talk to the forge
from (this computer, or another Herdr machine): `glab auth login` for GitLab, `gh auth login` for
GitHub.

Ask your agent to add `github.com/greenflagged/herdr-forge`, or copy the folders and the key yourself:

```sh
git clone https://github.com/greenflagged/herdr-forge
cp -R herdr-forge/mods/forge-* ~/.config/herdr-app/mods/
for m in ~/.config/herdr-app/mods/forge-*; do herdr-app check "$m"; done
```

Then add the key from `herdr-forge/keys.json` to your `~/.config/herdr-app/keys.json`:

```json
"global": { "ctrl-shift-f": "mod.open:forge-window" }
```

Install the mods on the machine that runs the Herdr window. Forge finds `glab` or `gh` on the
machine of the terminal you're in.

### Settings

`~/.config/herdr-app/forge.json` is optional. Use it to give a project your buttons, the triage
agent, or a different machine for `glab`/`gh`:

```json
{
  "forges": { "git.acme.io": "gitlab" },
  "projects": {
    "gitlab.com/acme/shop": {
      "on": "my-mac",
      "issues": { "triage": true, "actions": [ { "id": "fix", "label": "Fix it", "task": "Fix {ref}: {title}" } ] },
      "requests": { "actions": ["defaults", { "id": "review", "label": "Review", "task": "Review {ref}: {url}" }] }
    }
  },
  "hidden": ["runners"]
}
```

`forges` names self-hosted hosts that don't say "gitlab" or "github" in their name
(`"git.acme.io": "gitlab"`, `"ghe.acme.io": "github"`).

### Panels in your layout

Each panel is a mod, so you can place it in a layout of your own (a clone of `main`; see Herdr's
`AGENTS.md`). You tell it which project to show with props:

```json
{ "id": "forge-mrs", "type": "block",
  "content": { "mod": "forge-requests", "props": { "repo": "acme/shop", "on": "my-mac", "folder": "/Users/me/src/shop" } } }
```

| Prop | Meaning |
|---|---|
| `repo` | The project's path: `group/project` on GitLab, `owner/repo` on GitHub. |
| `on` | The Herdr machine where `glab`/`gh` is logged in (a name from `hc machine ls`). Leave it out for this computer. |
| `provider` | `gitlab` or `github`. Worked out from `host` when left out. |
| `host` | Your forge's host name, if it isn't gitlab.com (or github.com with `provider: github`). |
| `folder` | The project's checkout on that machine, where agents start (merge requests and issues). |
| `actions` | Your own buttons (merge requests and issues). |

Each panel's other props are listed at the top of its `main.js`. To add a Forge button to a tab bar
you've cloned, give the tab bar a button that runs `run("mod.open", { name: "forge-window" })`.

## What it does on your machine

- **Network:** only through `glab` or `gh`, to your forge, with your login. Panels ask only while they're on
  screen. That means about once a minute; every 10 s for pipelines while one is running and the
  window is in front; and less often for milestones and velocity. Hidden, collapsed and background
  panels don't ask.
- **Writes to the forge** only when you click: Merge, Retry, Cancel, issue edits and comments, and
  accepting triage proposals.
- **Agents:** buttons start agents with prompts that include issue and MR text. Anyone who can open
  an issue or MR wrote that text. The built-in prompts tell the agent to treat it as data and to ask
  before merging. Review your own prompts the same way.
- **Programs:** `python3` and `glab` or `gh` on the machine with your forge login, `git` in your checkouts
  (commit counts, and a worktree for Ship and Resolve), `xdg-open` or `open` for links.
- **Files**, on each machine the panels talk to the forge from, readable only by you:
  - `~/.local/share/herdr-forge/` (or `$HERDR_FORGE_HOME`): the panels' helper script and one SQLite
    database per project caching what they show, including issue text and comments.
  - `~/.claude/skills/triage-issues/`, only when you click Install skill.
  - Delete those to remove everything.

## Update

Herdr doesn't update mods. Pull the repo and copy the folders again:

```sh
git -C herdr-forge pull
cp -R herdr-forge/mods/forge-* ~/.config/herdr-app/mods/
```

You can update some panels and not others. Each runs its own version of the helper script against the
same cache.

## Develop

```sh
npm test        # lib.js and the panels' logic under Node, forge.py against a fake glab and gh
npm run sync    # after editing shared/: copies lib.js, ui.js and forge.py into every mod
```

`shared/forge.py` does all the forge work and caching. `shared/lib.js` holds the logic the panels
share, and `shared/ui.js` holds their look. Each mod carries copies, because Herdr mods can only
import from their own folder. [docs/contract.md](docs/contract.md) describes how the pieces fit
together.
