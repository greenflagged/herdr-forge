# Adding your own buttons

`forge-issues` and `forge-requests` show buttons on each issue or request. You choose the
buttons, so the panels fit how you work. A button can start an agent with your own prompt, run a
script, fire a Herdr command, or open a mod of your own with the item.

## In the layout

```json
{ "mod": "forge-issues", "props": {
  "repo": "acme/shop", "on": "my-mac", "folder": "/Users/me/src/shop",
  "actions": [
    { "id": "fix", "label": "Fix it", "primary": true,
      "when": { "labels": ["type::bug"], "state": "opened" },
      "task": "Fix issue {ref} in {repo}: {title}\n\n{url}\n\nRead it first with glab issue view {iid} --comments." },
    { "id": "branch", "label": "Branch", "exec": ["git", "switch", "-c", "issue-{iid}"] },
    { "id": "estimate", "label": "Estimate", "overlay": { "mod": "my-estimator", "width": 420, "height": 300 } }
  ] } }
```

`props.actions` replaces the defaults. To keep them and add yours, put `"defaults"` in
the list: `["defaults", { ... }]`. `forge-issues` has no defaults. `forge-requests` has two:

- **Ship** shows on a request open for a day or more. An agent fixes what's outstanding, then
  waits for your go-ahead before merging.
- **Resolve** shows on a conflicted request. An agent rebases it and force-pushes the branch,
  without merging.

Both ask before starting, work in a worktree of the request's branch, and don't show on requests
from forks.

## What an action can do

Every action has an `id` and a `label`, and does one of these:

| Kind | Fields | Does |
|---|---|---|
| agent | `task`, `agent?` (default `claude`), `tab?`, `folder?` | Starts the agent in a new tab in `folder` (default `props.folder`), with `task` as its first message |
| exec | `exec: [program, ...args]`, `cwd?`, `local?` | Runs the program on `props.on` (here with `local: true`); its last line of output shows as a notice |
| command | `command`, `args?` | Runs a Herdr command, including `<mod>.<command>` for your own mods |
| overlay | `overlay: {mod, kind?, width?, height?, props?}` | Opens your mod as a dialog; it gets `props().item` (the fields below), `action`, `on`, `folder` |

Optional on any action:

- `when`: show the button only for some items. These conditions are available:
  - `{ "labels": [...] }` needs all of those labels.
  - `{ "without": [...] }` needs none of them.
  - `{ "minAgeHours": 24 }` needs an item at least that old.
  - Any other field is compared with the item's: `{ "state": "opened" }`,
    `{ "conflicts": true }`, `{ "draft": [false] }`. A list means any of.
- `confirm`: a question to ask before running it ("Close as won't fix?").
- `primary`: draw it as the main button.
- `tone: "danger"`: draw it red, for actions that rewrite history or can't be undone.
- `tooltip`: what hovering says.
- `worktree: true` (requests, agent actions): start in a worktree with the request's
  branch checked out instead of `folder`.

## Placeholders

Strings in `task`, `tab`, `folder`, `exec`, `cwd`, `args` and `overlay.props` fill
`{name}` from the item. Lists join with commas; `{scoped.priority}` reaches inside.

| Both | Issues | Requests |
|---|---|---|
| `iid`, `ref` (`#12`, `!7`), `title`, `url`, `repo`, `host`, `provider`, `author`, `labels`, `created_ms` | `state`, `assignees`, `milestone` (title), `scoped` (`{priority: "high", type: "bug"}`) | `source`, `target`, `sha`, `draft`, `conflicts`, `ci_status`, `fork` (true when the request comes from another project) |

For a request from a fork, `source` is a branch in someone else's project, not yours:
`worktree: true` actions refuse those (check fork MRs out by hand), and `when: { "fork":
false }` hides an action from them.

Titles and branch names come from whoever wrote them. `exec` never runs through a shell, so they
can't inject a command, as long as each placeholder is its own argument:

- Don't write `["sh", "-c", "echo {title}"]`; write `["sh", "-c", "echo \"$1\"", "sh", "{title}"]`.
- If a placeholder is a whole argument and fills in text starting with `-`, Forge refuses to run
  it, because the program would read the text as an option. Where the program allows it, put `--`
  before such arguments anyway: `["git", "switch", "--", "{source}"]`.
- An agent `task` hands the title to the agent as text: treat it like any untrusted input.

## From another mod, at run time

A mod can add buttons without touching the layout. For example, it can add them only while it's
running, or only for some repos:

```js
import { shared, setShared } from "herdr";
const register = () => setShared("forge-issues.actions", {
  ...(shared("forge-issues.actions") ?? {}),
  "my-mod": { at: Date.now(), actions: [{ id: "my-mod.log-time", label: "Log time", overlay: { mod: "my-mod" } }] },
});
// in init(): register now and every 30 minutes
register();
cx.timer.every(30 * 60000, () => register());
```

Key the object by your mod's name so mods don't overwrite each other. An entry older than an hour
is ignored, so the buttons of a mod that stopped or was removed go away by themselves. Set
`actions: []` to take yours away at once. Requests use `forge-requests.actions`.

Registered actions run exactly like the ones in your layout: an agent in your checkout, a program
on your machine, any Herdr command. Any mod you install can register them, so they have the same
power as your own. Only install mods you trust.

## Reacting to the issue browser

`forge-issues` publishes what's happening, so other panels can follow along:

- `shared("forge-issues.selected")`: the open issue (the fields above), or null.
- `shared("forge-issues.event")`: the last change it wrote, `{type, iid, repo, host, at}`,
  with `type` one of `updated`, `commented`, `closed`, `reopened`, `action`.

And `forge.requestAgents` (`{requestUrl: [{address, name}]}`) lets an agents list tell the panels
which agents are working on which request. The panels show each agent's live status.
