# diagram-pane

A Claude Code mod that opens a side pane with a live picture of the work: every diagram Claude draws, pinned and readable, and a small map of what Claude is doing right now.

![diagram-pane: Claude adds a discount module on the left; on the right the pane has gone into the checkout.js box, its numbered steps drawn as boxes, with a change being typed into the field below](screenshot.png)

Claude explains things with mermaid charts, but in a terminal you only see the raw code, and it scrolls away. Meanwhile the shape of the work (which files, which steps, what connects to what) lives only in Claude's context. This pane shows you both.

- **Pinned diagrams.** Whenever a reply has a mermaid code block or an ASCII box diagram, it is pinned in the pane, newest first. Mermaid flowcharts are redrawn as boxes and arrows that fit a 60 column pane.
- **Live work map.** Every few turns (and on `/diagram`) a cheap Haiku call asks whether the work changed shape. Only on yes does a fork of the session return a small graph of the files, components and steps it is working on, and the pane draws it. The node Claude is on right now is marked `▶`.
- **Go into a box.** Boxes are numbered. Press a number to open that box's detail: a mermaid `subgraph` opens at once, and any other box gets a detail drawn by a fork of the session. `b` goes back, `t` to the top. A box marked `▸` already has a detail.
- **Change a diagram.** Press `c` (or Tab to the field) and type a change into the field under a diagram ("split auth into login and token refresh") and a fork redraws it. Or ask Claude: it reads and edits the pane with two tools, `diagram_get` and `diagram_set`.
- Square boxes are files, round ones components, double ones steps or decisions.

Claude sees the pane only through those two tools, plus `progress_set` for the progress tab.

### The other tabs

The pane has six tabs: `m` map (everything above), `w` progress, `d` diffs, `g` github, `s` chats, `i` shots. Every tab starts with the same strip: branch, PR, CI, how many files changed, how full the context is. Under it is a line saying what this chat is for and where it stands. That line is written by the same fork that draws the map, so it costs nothing extra.

- **Progress.** Where the work stands, as stages: plan → implement → test → review → fix → verify → commit → push → PR → CI → merge. Each stage shows `✓` done, `▶` now, `✗` failed, `–` skipped or `·` not yet, with the turn it happened in and what marked it. The stages come from what Claude ran, so they cost nothing to track:
  - `TodoWrite` or plan mode is plan, and file edits are implement;
  - a test command (`npm test`, `pytest`, `go test`, `claude plugin test`, …) is test, and its exit code is pass or fail;
  - a review subagent or `/code-review` is review, an edit after it is fix, and a test after that is verify;
  - `git commit`, `git push`, `gh pr create` and `gh pr merge` are their own stages, and CI and merge come from the GitHub tab.

  Claude can also name a stage with the `progress_set` tool ("fixing review findings 3/10"). A chat that came from a handoff starts where the chat before it stood. The current stage also shows in the strip on every tab, and next to each chat in the chats tab.
- **Diffs.** What this chat changed: every file that differs from the commit HEAD was on when the chat started, committed since or not, and the commits made since then are listed above the files. `v` cycles through three views: this chat, **the PR**, and uncommitted changes only.

  The PR view is what GitHub's Files changed shows: the branch's commits on top of the point where it last met the PR's base. That base is fetched from origin at most every five minutes. Merging or rebasing `main` into the branch moves that point forward, so main's own changes never show. Times in this view are each file's last commit.

  An open diff is drawn hunk by hunk, and each hunk sits under a `↗ line N` link. Cmd+click the link and VS Code opens at that line. `o` does the same through the `code` command. For searching across the whole PR, VS Code's GitHub Pull Requests view (View All Changes) is the better fit: it gives you a read-only diff editor with cmd+F and go-to-definition. Each row shows the file's status, `+added −removed`, and how long ago it was last written. `✎` marks files Claude wrote in this session. Press a number to open that file's diff, then `n` / `p` for the next or previous file and `b` to go back to the list. The diff is drawn with Claude Code's own diff colors. The list refreshes as Claude edits files, not only when the turn ends.
- **GitHub.** The branch's PR: title, link, review decision and reviewers, merge state, and the CI checks tallied (`✓ passed ✗ failing … running`), with every failing or running check named. It also shows how far the branch is ahead of or behind upstream, and the latest workflow runs on the branch. It reads from `gh` every 3 minutes, every 45 seconds while checks run, and right after Claude runs `git push` or `gh pr create`.
- **Chats.** Under herdr, the list starts with every pane in this herdr tab that runs an agent, newest first. Each row shows the pane's state (`●` working, `!` needs you, `✓` finished but not yet seen, `○` idle) and its title, and `◀ here` marks your own pane. A number, or a click, jumps to that pane with `herdr agent focus`. herdr reports which Claude session each pane holds, so a pane whose chat ran this mod also shows that chat's summary, turns, context fill and handoff source. Below that are the earlier chats that no pane holds any more.

  Without herdr: every chat this terminal tab has held, newest first. A `/clear`, a handoff or a fresh `claude` in the same tab adds a row. Each row shows when the chat ran, its turns, how full its context got, how it ended, its branch and its summary. A chat that started from another's `HANDOFF-xxxxxxxx.md` note (as cache-clock writes them) is linked to that chat. Once there are two or more chats, a Haiku call writes one overall line for the whole chain. `copy resume command` copies `claude --resume <id>` for an older chat.

- **Shots.** Every screenshot the chat has taken or looked at, newest first, so you never open Finder to see what a browser test saw. It picks up:
  - images that came back inline from a tool, such as a Claude in Chrome or computer-use screenshot;
  - image files (`.png`, `.jpg`, `.gif`, `.webp`) a tool named, in its input or its output: a Playwright or agent-browser screenshot it saved, a `Read` of a PNG, a path a script printed;
  - the same in every subagent the chat ran, labelled with the subagent's task;
  - images pasted into a prompt.

  The newest is drawn in the pane until you pick another: a number picks one from the list, `n` / `p` step to the older or newer one. `o` opens it in Preview, `f` shows the file in Finder, and `copy path` copies it. The list updates after every tool call while the tab shows, so a browser test's screenshots appear as it takes them. Each shot is made a PNG of at most 1400 pixels a side with `sips` (kept under `~/.claude/diagram-pane/shots/`) and drawn with the terminal's picture support: Ghostty, kitty, or iTerm2 3.5+. A terminal that cannot draw pictures shows the shot's name instead, and `o` still opens it.

  Under herdr, pictures need herdr 0.9.2 or later (earlier versions do not draw an app's kitty graphics) and `CLAUDE_CODE_FORCE_TERMINAL_IMAGES=1`, since herdr names itself `libghostty` and Claude Code draws pictures only for terminals it knows. Set it for herdr panes alone, for example in `~/.zshrc`: `[ -n "$HERDR_ENV" ] && export CLAUDE_CODE_FORCE_TERMINAL_IMAGES=1`.

"This tab" is the first of these that is set: `HERDR_TAB_ID`, `TMUX_PANE`, `ZELLIJ_PANE_ID`, `WEZTERM_PANE`, `KITTY_WINDOW_ID`, `ITERM_SESSION_ID`, `TERM_SESSION_ID`. With none of them set, the project folder stands in for the tab. A tab used for another project, or left idle for a day, starts a new chain. `-p` runs read the chain but are never added to it.

The diffs and GitHub tabs work in the git repository of the file Claude wrote last, or else of the session's folder. A session started above its repositories still shows the right one.

![A mermaid chart in Claude's reply on the left, the same chart drawn as boxes and arrows in the pane on the right](images/pinned.png)

![A plain question: the Haiku gate says the work kept its shape, so the map stays and no fork runs](images/gate.png)

![Claude is asked to add a receipt step: it calls diagram_get and diagram_set, and the map in the pane gains the step and is marked edited](images/tools.png)

## Install

```
claude plugin marketplace add abdul-raafai-asim/claude-code-mods
claude plugin install diagram-pane@claude-code-mods
```

Or inside Claude Code: `/plugin marketplace add abdul-raafai-asim/claude-code-mods`, then `/plugin install diagram-pane@claude-code-mods`.

The pane stays off until you type `/diagram`; then it opens at any width. With fullscreen rendering it docks beside the transcript; in the classic renderer it sits above the prompt.

**One pane per herdr tab.** Under herdr, only one chat in a tab shows the pane, however many chats the tab holds. Once `/diagram` has shown it in a tab, a new chat there, such as a handoff's, takes the pane over, and the chat it left closes its own. When the chat that shows it exits, the next chat to check (within 15 seconds) takes it. `/diagram` in any chat moves the pane there. The tab's record is `~/.claude/diagram-pane/tabs/<tab>.json`. Outside herdr each chat has a terminal pane of its own, so each shows its own.

**Show and hide.** A bare `/diagram` toggles the pane. Hiding is for the whole tab: the pane stays hidden in every chat in the tab, and in new ones, until you show it again. The `x hide` button in the pane's tab row, the pane's close mark and ctrl+x x hide it the same way. `/diagram hide` and `/diagram show` do one or the other.

## Usage

- Ask for a diagram (`explain the checkout flow with a mermaid flowchart`) and it is pinned when the turn ends.
- `/diagram diffs`, `/diagram github`, `/diagram chats`, `/diagram shots`, `/diagram map` open the pane on that tab, with the keyboard.
- `/diagram` shows the pane (hidden or in another chat) and runs the gate, redrawing the map if the work changed; when this chat already shows it, `/diagram` hides it for the tab. `/diagram force` skips the gate and draws the map from scratch, dropping edits.
- `/diagram open` gives the pane the keyboard, so number keys work at once. Clicking the pane, or ctrl+x tab, does the same; Esc hands the keys back to the prompt.
- Ask Claude to change what you are looking at: "add the NAT gateway to the network box", "move the cache under the API layer". It calls `diagram_get`, then `diagram_set`, and the pane shows the changed level.

## Settings

| Option | Default | What it does |
| :- | :- | :- |
| `everyTurns` | 3 | Turns between work-map checks. Set it with `/plugin configure diagram-pane@claude-code-mods`. |
| `maxPins` | 5 | How many pinned diagrams the pane keeps |
| `DIAGRAM_PANE_EVERY` (env) | unset | Overrides `everyTurns` for one session, handy for a demo: `DIAGRAM_PANE_EVERY=1 claude` |

## How it works

- On `turn.complete` it reads the transcript (`$.session.messages()`) and pins any new mermaid or ASCII diagram it finds in Claude's replies.
- Every N turns the gate runs: `$.model.complete` on Haiku with the current map, the files touched since that are not on it, and a digest of tool calls. It answers YES or NO.
- On YES, `$.model.fork` asks the session itself for `{ title, nodes, edges }` as JSON. A fork sees the whole conversation but cannot call tools, so it is cheap and served mostly from the prompt cache.
- `hooks/panel.js` runs `git` and `gh` through `$.process.run` and lays out the diffs, github and chats tabs; `hooks/work.js` holds the parsers (numstat, porcelain status, unified diff per file, check rollups, the tab's chain), with no `$`, so the tests feed it text.
- The chain of chats is kept in `$.store` under the tab's id, read fresh and written back on every turn, so a chat in another process of the same tab adds to it rather than overwriting it.
- `hooks/draw.js` lays out both mermaid charts and the map the same way: layers top to bottom, boxes wrapped to the pane's width, connectors drawn with box characters.
- A box's detail is stored inside it (`sub`), so the whole map is a tree. `hooks/graph.js` walks it, patches it, and writes it back out as mermaid with each detail as a `subgraph`, which is what `diagram_get` returns.
- Opening a box with no detail forks the session with the level it sits on and asks for the inside as the same JSON. The detail's ids are renamed where they clash with the rest of the tree, since mermaid ids are global.
- `diagram_set` takes a target (`view`, `map` or `pin:N`), a `path` of node ids to go down, and either a whole `mermaid` flowchart for that level or `ops` (`add_node`, `remove_node`, `relabel`, `set_kind`, `add_edge`, `remove_edge`). Boxes that keep their id keep their details.
- An edited map is marked `edited`. The next refresh hands the fork the current map and asks it to keep those edits, and boxes that keep their id and label keep their details.
- The map, the edited pins and the open view are saved per session in `$.store`, so they survive a hot reload or `--resume`. Pins are rebuilt from the transcript, with edits laid back over them.

## Limits

- Only mermaid `graph` and `flowchart` charts are redrawn. Sequence, class, state and other types are pinned as raw code. `diagram_set` with mermaid, or a typed change, can turn one into a flowchart.
- Number keys reach the first nine boxes of a level; Tab or a click reaches the rest. Pinned diagrams on the home view are drawn without numbers: open a pin first to go into its boxes.
- A fork cannot call tools, so a detail it draws holds only what the session has already seen.
- Edges between boxes in different subgraphs are drawn to the subgraph's box on the level where both ends show; inside a subgraph, edges that leave it are not shown.
- Every chart is drawn top to bottom, even `graph LR`, because a narrow pane has no room sideways.
- Edges that skip a row or point back up are not routed. They are listed under the drawing with `⇢` and `↺`. A row too wide for the pane wraps, and edges into the wrapped part are listed the same way.
- ASCII diagrams are only picked up from plain code blocks (no language, or `text`), and shown as written.
- The map check runs after a turn ends, not while Claude is working. Before the first reply there is nothing to fork, and `/diagram` says so.
- The map, edits and view are saved per install: moving the plugin to another marketplace or reinstalling it starts with no saved maps. A session that already has `everyTurns` turns of work gets a fresh map at its next turn or `diagram_get`, without waiting.
- `/clear` starts the pane fresh: the old session's map, pins and view are dropped (its saved map stays under its own id for `--resume`), and a map or detail fork still running from before `/clear` is discarded.
- The GitHub tab needs `gh` signed in. It reads only, as whichever account `gh` has active.
- The diffs tab lists 80 files at most, and counts the lines of only the first 20 untracked files.
- The shots tab keeps the 40 newest shots, needs macOS (`sips`, `open`), and finds a file only by a path with no spaces in it. An inline screenshot has no file time, so it counts as taken when the pane first saw it.
- The map is the model's own summary of the work, so it can include a step such as "run tests" beside the files.

## Develop

```
claude --plugin-dir ./diagram-pane
claude plugin validate .
claude plugin test .
```

For headless runs, `DIAGRAM_PANE_SYNC=1` waits for the gate and fork before the turn ends, and `DIAGRAM_PANE_DUMP=<file>` writes the pane's text to a file.
