# Forge panels for Herdr

[Herdr](https://herdr.dev) panels for the project you work on in GitLab: open merge requests you can
merge or hand to an agent, CI pipelines and runners, milestones, a velocity chart, and a full issue
browser that starts agents on issues. Every button that starts work is yours to change, and other
mods can add their own.

GitLab (gitlab.com and self-hosted) for now. GitHub is next: the panels already use neutral words
and data, so it arrives as a second backend.

![The panels beside a Herdr workspace](preview.png)

## The panels

| Mod | What it shows |
|---|---|
| `forge-requests` | Open merge requests: draft, auto-merge, conflict and CI badges. Hover for **Merge** (asks first, merges only the commit you saw), **Ship** (an agent gets an older MR merged) and **Resolve** (an agent rebases away conflicts). Shows the agents working on each MR when your agents list publishes them. |
| `forge-ci` | The last 20 pipelines. Click one for its jobs by stage; hover for Retry, Cancel and ↗. |
| `forge-runners` | The project's own runners, what each is running, and queued jobs, flagged when no online runner has their tags. |
| `forge-milestones` | Active milestones with progress. Click one for its issues. |
| `forge-velocity` | Commits, merged MRs, closed issues and MR cycle time for the repo you're focused on, over 12 weeks or 30 days. |
| `forge-issues` | Every issue in the project, opened as a tab: filters from your scoped labels, search, editing (labels, milestone, state, comments), and your own buttons. Optional triage agent. |
| `forge-toggle` | A bar that shows or hides a hidden panel, or opens the Issues tab. |

## Install

You need `glab` logged in (`glab auth login`) and `python3` on the machine the panels should talk
to GitLab from: this computer, or another Herdr machine (a Mac you work on over ssh, say).

Ask your agent to add `github.com/greenflagged/herdr-forge`, or copy the folders you want:

```sh
git clone https://github.com/greenflagged/herdr-forge
cp -R herdr-forge/mods/forge-* ~/.config/herdr-app/mods/
for m in ~/.config/herdr-app/mods/forge-*; do herdr-app check "$m"; done
```

The mods don't place themselves: put them in your layout (a layout clone of `main`, see Herdr's
`AGENTS.md`) with the project they show. A column on the right, for example:

```json
{ "id": "forge", "type": "column", "size": { "px": 340 }, "children": [
  { "id": "forge-mrs", "type": "block",
    "content": { "mod": "forge-requests", "props": { "repo": "acme/shop", "on": "my-mac", "folder": "/Users/me/src/shop" } } },
  { "id": "forge-ms", "type": "block", "content": { "mod": "forge-milestones", "props": { "repo": "acme/shop", "on": "my-mac" } } },
  { "id": "forge-vel", "type": "block", "size": { "px": 356 }, "content": { "mod": "forge-velocity", "props": { "glabOn": "my-mac" } } },
  { "id": "forge-issues-bar", "type": "block", "size": { "px": 32 }, "content": { "mod": "forge-toggle",
    "props": { "label": "Issues", "tab": { "name": "Issues", "mod": "forge-issues",
      "props": { "repo": "acme/shop", "on": "my-mac", "folder": "/Users/me/src/shop" } } } } }
] }
```

| Prop | Meaning |
|---|---|
| `repo` | The project's path on GitLab, `group/project`. |
| `on` | The Herdr machine where `glab` is logged in (a name from `hc machine ls`). Leave it out for this computer. |
| `host` | Your GitLab's host name, if it isn't gitlab.com. |
| `folder` | The project's checkout on that machine, where agents start (Requests and Issues). |
| `actions` | Your own buttons (Requests and Issues): see [docs/actions.md](docs/actions.md). |

Each panel's own props are at the top of its `main.js`.

## Make it yours

The buttons on merge requests and issues are a list you write: start an agent with your prompt,
run a script, run a Herdr command, or open a mod of your own with the issue. Buttons can depend on
labels, state or age, and other mods can add buttons while they run. The Issues tab also tells other
mods which issue is open and what just changed. [docs/actions.md](docs/actions.md) has the details
and examples.

```json
"actions": [
  { "id": "fix", "label": "Fix it", "when": { "labels": ["type::bug"] },
    "task": "Fix issue {ref} in {repo}: {title}\n\n{url}" }
]
```

### Triage agent (optional)

Set `"triage": true` in the Issues props to get a triage box. **Install skill** puts the
`triage-issues` skill in `~/.claude/skills` on that machine; **Triage** starts Claude Code to
propose a priority, a rank and a reason for every open issue. You accept or dismiss each one in
the tab, or accept them all. Nothing changes in GitLab until you accept. A priority you set by hand
is kept.

## What it does on your machine

- **Network:** only through `glab`, to your GitLab, with your login. Reads poll while a panel is on
  screen: about once a minute, every 10 s for pipelines while one is running and the window is in
  front, and less often for milestones and velocity. Hidden panels and background tabs don't poll.
- **Writes to GitLab** only when you click: Merge, Retry, Cancel, issue edits and comments, and
  accepting triage proposals.
- **Programs:** `python3` and `glab` on the `on` machine, `git` in your checkouts (velocity's commit
  counts, a worktree for Ship and Resolve), `xdg-open` or `open` for links, and the agents your
  buttons start.
- **Files**, on each machine the panels talk from:
  - `~/.local/share/herdr-forge/` (or `$HERDR_FORGE_HOME`): the panels' helper script and one SQLite
    database per project, which caches what the panels show, including issue text and comments.
    Agents can read it.
  - `~/.claude/skills/triage-issues/`, only when you click Install skill.
  - Delete those to remove everything.

## Update

Herdr doesn't update mods. Pull the repo and copy the folders again:

```sh
git -C herdr-forge pull
cp -R herdr-forge/mods/forge-* ~/.config/herdr-app/mods/
```

Updating some panels and not others is fine: each runs its own version of the helper script against
the same cache.

## Develop

```sh
npm test        # lib.js under Node, forge.py against a fake glab
npm run sync    # after editing shared/: copies lib.js and forge.py into every mod
```

`shared/forge.py` does all the GitLab work and caching; `shared/lib.js` holds what the panels share.
Each mod carries copies, because Herdr mods can only import from their own folder.
[docs/contract.md](docs/contract.md) describes how they fit together.
