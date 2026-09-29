# topencode / tclaude

Manage multiple coding-agent projects and sessions as **mouse-driven tabs** inside a single, attachable tmux session. Built for remote/ssh workflows: run it on the box, attach from anywhere, and every live session is a clickable tab.

Two products, one engine:

| Binary | Drives | Session store | tmux session |
|---|---|---|---|
| `topencode` | [opencode](https://github.com/sst/opencode) | `~/.local/share/opencode/opencode.db` | `topencode` |
| `tclaude` | [Claude Code](https://claude.com/claude-code) | `~/.claude/projects/<slug>/<uuid>.jsonl` | `tclaude` |

They are separate compiled binaries with separate install paths, so either can be
updated without touching the other, and both can run side by side — separate tmux
sessions, separate `@oc_*` / `@tc_*` window options, no shared state.

## Why

- Interactive agents are great locally but awkward on remote hosts. Each product wraps its agent in one dedicated tmux session you can attach to over ssh.
- Multiple sessions/projects become **tabs** (tmux windows). Click a tab in the status bar to switch.
- A **Home dashboard** (window 0) is a two-column, fully mouse-driven browser of every project and session — scroll with the wheel, click to open.
- Each session tab is split **65% agent / 35% clean zsh**, so you always have a shell for git/build/logs next to the AI.

## Layout

```
 topencode                         click ▸ browse/open   wheel ▸ scroll   q ▸ quit
PROJECTS                      SESSIONS — fancy-tmux
 fancy-tmux  (1/3)          │ ＋ New session
 k2          (0/12)         │ ● TUI+tmux design      now
 WorkSpace   (2/5)          │ ○ refactor cli          3h
                            │ ○ fix bug #42           2d
```

Each session tab:

```
┌ claude --resume <uuid>  (65%) ─────┬ clean zsh (35%) ─┐
│                                    │                  │
└────────────────────────────────────┴──────────────────┘
```

## Install

Requires: tmux 3.0+, zsh, [Bun](https://bun.sh) 1.3+, plus whichever agent you use
(`opencode` or `claude`).

```sh
bun install
bun run install:local            # -> ~/.local/bin/topencode
bun run install:local:tclaude    # -> ~/.local/bin/tclaude
bun run install:all              # both
```

Make sure `~/.local/bin` is on your `PATH`. Installing over a running instance is
fine — the installer renames the new build into place rather than overwriting the
inode, so the running process keeps working and the next pane picks up the new build.

## Usage

`<cmd>` below is `topencode` or `tclaude`:

```sh
<cmd>                 # attach (create the tmux session if needed)
<cmd> attach          # same as above
<cmd> list            # list all sessions grouped by project (plain stdout)
<cmd> status          # status lamp per open tab
<cmd> watch           # live-refreshing status view
<cmd> open <id>       # open/select a tab for a session id
<cmd> new [dir]       # start a new session tab (default: cwd)
<cmd> close <tab|id>  # close a tab (does NOT delete the session)
<cmd> delete <id...>  # permanently delete session(s) and all their data
<cmd> clean [filters] # bulk cleanup, dry run by default
<cmd> vacuum          # sweep leftovers / compact the store
<cmd> kill            # kill the whole tmux session
```

- **Attach from outside tmux** → `tmux attach`.
- **Attach from inside another tmux** → `switch-client` (no nested tmux trap).
- Clicking a session in the dashboard: if it's already live, jumps to its tab; if dormant, opens a new tab and launches the agent on it.

## Deleting sessions

Two strategies, deliberately different in what they touch:

| | ♻ recycle (orange) | ✗ delete for good (red) |
|---|---|---|
| what it does | writes the session id to our own bin | asks the agent to delete the session |
| touches agent data | no | yes, through the product's own delete |
| reversible | yes (`unhide`) | no |
| lives in | `~/.local/state/<product>/hidden.json` | the agent's own store |

**Whether to delegate is the decision that matters: recycling never does, deleting for good always does.** opencode owns its database invariants — its `session delete` removes the rows, parts and events together — and Claude Code owns its files (the transcript, the sibling `<uuid>/` tool-output directory, and the session-keyed `file-history/<uuid>` and `session-env/<uuid>` directories). Hand-rolling either is how a store gets corrupted, so the only permanent delete path is the agent's own.

Recycling is the opposite: one id in a local JSON file, nothing the agent owns is touched, identical for both products, and instant even for a session with a 10MB transcript.

In the dashboard:

- Every session row carries **♻** recycle and **✗** delete-for-good; a live row also keeps **✕** close-the-tab.
- **✗ arms on the first click and acts on the second** — the hint line becomes "⚠ click ✗ again to delete for good" — because it is the one irreversible thing in the UI.
- Recycling a live session also closes its tab, so the listing and the tab bar never disagree about whether it is around.
- When the bin is non-empty it appears at the bottom of the project column as **♻ recycle bin (N)**; its rows carry **↩** restore and **✗** delete-for-good.

From the CLI:

```sh
<cmd> hide <id...>    # recycle: out of the listings, nothing deleted
<cmd> bin             # what is in the bin
<cmd> unhide <id...>  # put it back
<cmd> list --all      # include recycled sessions, marked [recycled]
<cmd> delete <id...>  # delete for good (same as the red button)
```

The bin is per product, survives restarts, and `vacuum` never touches it — empty it only by purging or restoring. `open <id>` on a recycled session restores it, on the grounds that opening it is a decision to use it again.

## Scrolling

- The **agent pane** enables its own mouse tracking (SGR), so the wheel scrolls the agent's view natively — no tmux copy-mode friction.
- The **dashboard** parses SGR mouse itself; each column scrolls independently with the wheel.
- The **zsh pane** uses tmux mouse copy-mode with a large scrollback (`history-limit=50000`).

## Configuration (env vars)

Exported before the tmux session is created — panes inherit the **tmux server's**
environment, not your shell's:

| `topencode` | `tclaude` | Default | Meaning |
|---|---|---|---|
| `TOPENCODE_SESSION` | `TCLAUDE_SESSION` | product name | tmux session name |
| `TOPENCODE_OPENCODE_BIN` | `TCLAUDE_CLAUDE_BIN` | see below | agent binary |
| `TOPENCODE_SHELL` | `TCLAUDE_SHELL` | `zsh` | right-pane shell |
| `TOPENCODE_SHELL_PCT` | `TCLAUDE_SHELL_PCT` | `35` | right-pane width % |

### Choosing the opencode binary

The default path (`~/.opencode/bin/opencode`) is used when it is a runnable file.
If it is missing, empty (0 bytes — what a truncated `opencode upgrade` leaves
behind), or not executable, topencode falls back to the `opencode` on `PATH`
instead of launching a binary that would die instantly and leave the pane reading
`Pane is dead`. Resolution is re-run on every tab open, so repairing the binary
takes effect without restarting anything.

`TOPENCODE_OPENCODE_BIN` is treated as a deliberate instruction and is never
silently bypassed: if you point it at a broken file, you get an error naming that
file rather than a quiet fallback.

tclaude has no canonical install path to pin, so it uses `TCLAUDE_CLAUDE_BIN` if
set and the `claude` on `PATH` otherwise.

When no usable binary can be found, the dashboard shows an
`⚠ <agent> unusable — …` line on its bottom row, and opening a tab prints the same
reason inside the pane instead of exec'ing the bad binary.

## tclaude specifics

Claude Code keeps no database and offers no session-management CLI, so tclaude
reads the transcripts it writes:

- A conversation is `~/.claude/projects/<slug-of-cwd>/<session-uuid>.jsonl`, where
  the slug is the cwd with every non-alphanumeric byte replaced by `-`. The real
  path is recovered from `~/.claude.json`'s project map (the slug alone is lossy),
  and each transcript's own `cwd` field is used when present.
- **Titles** come from the generated `ai-title` line, falling back to the last
  prompt. Subagent work lives inside the parent transcript, so only top-level
  `<uuid>.jsonl` files are sessions.
- **Status** is derived from the transcript: it is appended to as a turn runs, so
  its mtime is the heartbeat, and the newest user/assistant line says whether a
  reply is outstanding. A long tool call can go quiet for tens of seconds between
  appends — the 90s stalled window is what keeps a working agent from being
  reported as stopped.
- **delete** removes the transcript, its sibling `<uuid>/` directory (tool output),
  and the session-keyed `file-history/<uuid>` / `session-env/<uuid>` directories.
  **vacuum** sweeps those leftovers when a transcript is already gone; there is no
  database to compact.
- Transcripts reach tens of megabytes, so nothing reads one whole: metadata comes
  from a 64KB tail read memoised on size+mtime, which is what keeps the dashboard's
  5s refresh cheap.

## Architecture

- **One engine, two products**: `src/profile.ts` is the seam. Everything above it —
  the tmux driver, the dashboard, status rendering, the CLI — is product-agnostic;
  a `Profile` supplies the product-specific parts (session store, launch command,
  tmux session and option names, binary resolution). `src/products/opencode/` and
  `src/products/claude/` are the two implementations, and `bin/topencode.ts` /
  `bin/tclaude.ts` differ only in which one they select.
- **Stateless live/dormant model**: a live session is any tmux window in the
  product's session tagged with its session/dir options (`@oc_*`, `@tc_*`).
  Dormant = everything in the store minus live. No separate state file — state dies
  with the tmux objects, so closed windows and server restarts self-heal.
- **Idempotent opens** guarded by `tmux wait-for` locks: opening the same session
  twice selects the existing tab instead of duplicating.
- **Auto-respawn**: the zsh pane is tagged with the shell role; a `pane-died` hook
  respawns only shell panes (never the agent), preserving the split.
- **Quitting the agent leaves a shell behind**: the agent pane's command is
  `<agent> … ; exec <shell> -il`, so Ctrl-C drops you into an interactive login
  shell in the same pane instead of leaving a dead one. Chained with `;` rather than
  `&&` because a signal-killed agent exits non-zero — exactly when you want the
  shell. Running `exit` in that fallback shell does close the pane; reopen the tab
  from the dashboard.
- All tmux options are set **on the product's session only** — your global tmux
  config is untouched.

### Modules

```
src/profile.ts          the product seam (Profile interface + active-profile accessor)
src/config.ts           binary resolution, launch/quoting helpers
src/tmux.ts             argv-based tmux driver (bootstrap, tabs, locks, hooks)
src/dashboard.ts        raw-ANSI + SGR-mouse two-column TUI
src/status.ts           status classifier + labels
src/views.ts            store sessions + live tabs -> dashboard model
src/format.ts           width-aware text/byte/age helpers
src/fileutil.ts         tail/head reads, safe stat
src/cli.ts              CLI routing, shared by both products
src/products/opencode/  store.ts · cleanup.ts · status.ts · profile.ts
src/products/claude/    store.ts · cleanup.ts · status.ts · profile.ts
bin/topencode.ts        sets the opencode profile
bin/tclaude.ts          sets the claude profile
```

## Dev

```sh
bun run dev list                # topencode from source
bun run dev:tclaude list        # tclaude from source
bun run src/dashboard.ts        # standalone dashboard self-test (fake data)
bun run typecheck               # tsc --noEmit
bun run build:all               # dist/topencode + dist/tclaude
```
