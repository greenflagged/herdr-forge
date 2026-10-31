# Forge

GitLab panels for Herdr. Press ctrl-shift-f to open a floating Forge window. It holds every panel
for the repo of the focused terminal:

- open merge requests, which you can merge or hand to an agent
- pipelines
- runners
- milestones
- a velocity chart
- an issue browser with filters, editing, your own buttons and an optional triage agent

The same panels also work as blocks in any layout.

![Forge](preview.png)

## What you see

**The Forge window** (key `forge`, 90% × 88% of the window, floating, kept across restarts):

- A 36 px bar on `chrome`, with a 1 px `border` line below. From the left it holds:
  - "Forge" (13 px semibold).
  - The project path (12.5 px).
  - The host, when it isn't gitlab.com (11 px `dim`).
  - A pill with the machine ("this computer" when local).
  - A Pinned / Following focus button (solid when pinned).
  - On the right, one switch per panel (MRs, Milestones, Velocity, CI, Runners, Issues), `selected`
    when shown and `dim` when hidden, and a × close.
- Below the bar, a row of columns. The first is 360 px and holds MRs, Milestones and Velocity
  (330 px tall). Then come CI (330 px) and Runners (290 px). Issues fills the rest. 1 px `border` dividers
  sit between them.

**Every panel** draws on `background` under the same 34 px header with a 1 px `border` line. The
header holds, in order: a ▾/▸ caret when the panel can collapse, the title (13 px semibold), a count
pill (10 px, bordered, `muted`), the project (11 px `dim`, truncated), the data's age ("now", "3m"),
and ↻ (a braille spinner while loading). Hovering the header of a block in a layout adds ⧉ (open as
a pane) and ↗ (detach into a window). A detached window shows ↙ (dock).

- **MRs** ("Open MRs" / "Open PRs"): rounded-6 cards. Line one: `!iid` (11 px `dim`), Draft and
  Auto-merge chips, the title (13 px), a red ⚠ for conflicts, and a CI glyph (spinning ring in
  `working` while running, ✓ `ansi2`, ✗ `ansi1`, ▸ manual, – canceled). Line two (11 px `muted`):
  author, source branch, up to three label pills, age. Agents working on an MR show as small rows
  under it with their live status.
- **Pipelines**: the last 20 as cards: a status icon in its color (success `ansi2`, failed `ansi1`,
  running `ansi4`, pending `ansi3`, manual `ansi5`), the ref in 13 px semibold (`main` or `!811`), the
  short sha, the age; below, the status word, `#iid` and source. An expanded card lists its jobs in 20
  px rows under dim stage headings, with durations and an "allowed" tag for allowed failures.
- **Runners**: an "N/M up" pill in the header (red when none). Each runner: a dot (green idle, red
  offline, `muted` paused; a spinning ring while busy), its name, its state on the right, tag pills,
  and the jobs it runs with ticking elapsed times. Then "Running elsewhere" (`dim`) and "Queued"
  (`ansi3`) sections; a queued job no online runner can take reads "no runner (tags)" in red.
- **Milestones**: soonest due first. ▸/▾, the title, ↗, and the due text ("due in 3d", or a red
  "2d overdue" chip); under it a 4 px progress bar (`accent`, `ansi2` when done) and "3/5 closed · 2
  open". Expanded: its issues with ● / ✓, `#iid`, title and assignees.
- **Velocity**: 12w / 30d pills in the header. Four rows (Commits `accent`, MRs merged `ansi5`, Issues
  closed `ansi2`, MR cycle time `ansi3` on a square-root scale): a label, a change chip ("↑12%" green
  when better, red when worse, "≈ avg"), the last 7 days in 15 px semibold, and a 22 px bar strip.
  Hovering a bar shows that bucket in every row. A 22 px footer: branch, totals.
- **Issues**: three resizable columns. Filters (210 px, `chrome`): one section per scoped label with
  counts and priority dots, then Milestone and Labels. The list: a search box, Open / Closed / All, a
  sort switch, then 30 px rows (priority dot, `#iid`, title, chips, age) and a footer ("42 of 293").
  The detail (480 px): title with ↗, state and dates, your buttons, then Fields as dropdowns (one per
  scope, plus Milestone), Labels, Merge requests, the description as markdown, comments and a comment
  box.

## How it behaves

- ctrl-shift-f toggles the Forge window. It opens on the focused terminal's repo. The terminal's
  origin remote names the project, the terminal's machine runs `glab`, and the terminal's checkout is
  where agents start. The window follows focus to other repos unless pinned, and reopens with the
  panel switches you chose.
- Clicking a header collapses the panel in place. In a column it shrinks to its header. In a row it
  shrinks to a 34 px strip with the title's letters stacked. Collapsed and hidden panels stop polling.
- Panels poll only while on screen: MRs every 60 s, CI every 10 s while a recent pipeline runs and the
  window is focused (else 60 s), runners 20 s / 60 s, milestones 5 min, velocity 5 min (commits) and
  15 min (GitLab), issues 60 s focused / 5 min away. The first read after starting shows the cache at
  once.
- Merge asks "Merge into main?" and merges only the commit shown.
- Ship (MRs open a day or more) and Resolve (conflicted MRs) ask first. Then they start Claude Code
  in a worktree of the branch. The task treats MR text as untrusted. For Ship, the task also waits
  for a go-ahead before merging. Neither shows on fork MRs.
- Issue edits are written to GitLab first, shown at once, and rolled back if GitLab refuses. One write
  runs at a time.
- Keys: ↑/↓ or j/k move the selection, `/` searches, Esc clears, Enter opens in the browser.
- Results of Merge, Retry, Cancel, buttons and comments also show as Herdr toasts.
- Triage (optional): a box at the top of the filters shows the last run and the changes waiting. On
  click it installs the skill and starts the agent in a "triage" tab. You accept proposals one at a
  time or all at once.
- Agent statuses: an agent on an MR shows working (spinner), blocked (tinted `blocked`), done or
  idle. An agent resting while its MR's pipeline runs shows a clock and "CI".

## Built from

- Mods: `forge-window` (launcher and bar), `forge-requests`, `forge-ci`, `forge-runners`,
  `forge-milestones`, `forge-velocity`, `forge-issues`, and `forge-toggle` (a bar for layouts that
  shows a hidden node or opens a mod's tab). Props: `repo`, `on`, `host`, `provider`, `folder`,
  `actions`; issues adds `scopes`, `scopeSep`, `triage`, `issue`, `view`.
- Every mod carries `lib.js` (helpers, actions, visibility), `ui.js` (header, collapse, detach, parts)
  and `forge.py`, all copied from `shared/`.
- `forge.py` runs on the `on` machine through `exec(python3 -I -c …)`. A small boot script runs
  `~/.local/share/herdr-forge/forge-<version>.py`, which is installed once per version.
- `forge.py` calls `glab api` and caches every answer in SQLite. Each cached answer has a max age, a
  fetch lease and a per-host rate-limit pause.
  `forge.py` also does the filtering, sorting and bucketing. docs/contract.md has every command and
  shape.
- Herdr: `exec`, `readTextFile`, `openOverlay` (window with `key`, `keep`, `layout`), `closeOverlay`,
  `run` (`layout.resize`, `layout.hide`, `layout.show`, `pane.split`, `tab.new`, `space.new`),
  `shared`/`setShared`, `knownAgents`, `notify`, `layout()`, `panes()`, `spaces()`, `focused()`,
  `Popover` for dropdowns, `v_virtual_list` with a scroll handle, `h_resizable`, `TextView.markdown`.
- keys.json: `"ctrl-shift-f": "mod.open:forge-window"`. Settings: optional `forge.json` in Herdr's
  folder.

## Watch out

- Herdr's JS is about 1000x slower than V8, and Herdr stops slow renders. Keep sorting and counting
  in forge.py, and keep renders to drawing.
- Herdr keeps hidden mods running, so every poll must check that its panel is on screen.
  `layout()` changes don't redraw mods, so each panel's header (ui.js) checks the layout once a second.
- Each `exec` must finish within 30 s: forge.py stops work at 18 s and answers `more: true`.
- `herdr-app check` panics on a `v_virtual_list` with rows (a Herdr bug); it passes with an empty
  list.
- A panel can't tell which block it's in; it finds blocks by mod and `repo`.
- Write `mod.json` before `main.js`, or Herdr docks the new mod on its own.
- Machines that run forge.py must be macOS or Linux with python3.

## Done when

- ctrl-shift-f in a GitLab repo's terminal opens the window on that project. Pressing it again
  closes the window. The window comes back after restarting Herdr.
- Each panel shows its data, and after a restart shows it at once from the cache.
- Clicking a header collapses it; clicking again restores its size.
- A filter click in Issues narrows the list and the counts; a priority change shows at once and in
  GitLab.
- Merge asks, then merges; a failed pipeline's Retry starts it again.
- With triage on, Install skill installs it, Triage proposes priorities, Accept writes the label.
- `npm test` passes and `herdr-app check` passes for every mod.
