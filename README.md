# topencode

Manage multiple opencode projects and sessions as **mouse-driven tabs** inside a single, attachable tmux session. Built for remote/ssh workflows: run it on the box, `topencode` from anywhere, and every live opencode session is a clickable tab.

## Why

- opencode is great locally but awkward on remote hosts. `topencode` wraps it in one dedicated tmux session you can `attach` to over ssh.
- Multiple sessions/projects become **tabs** (tmux windows). Click a tab in the status bar to switch.
- A **Home dashboard** (window 0) is a two-column, fully mouse-driven browser of every project and session — scroll with the wheel, click to open.
- Each session tab is split **65% opencode / 35% clean zsh**, so you always have a shell for git/build/logs next to the AI.

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
┌ opencode <dir> -s <id>  (65%) ─────┬ clean zsh (35%) ─┐
│                                    │                  │
└────────────────────────────────────┴──────────────────┘
```

## Install

Requires: tmux 3.0+, zsh, [opencode](https://github.com/sst/opencode), Bun 1.3+.

```sh
bun install
bun run install:local     # builds a single binary -> ~/.local/bin/topencode
```

Make sure `~/.local/bin` is on your `PATH`.

## Usage

```sh
topencode                 # attach (create the tmux session if needed)
topencode attach          # same as above
topencode list            # list all sessions grouped by project (plain stdout)
topencode open <id>       # open/select a tab for a session id
topencode new [dir]       # start a new opencode session tab (default: cwd)
topencode close <tab|id>  # close a tab (does NOT delete the opencode session)
topencode kill            # kill the whole topencode tmux session
```

- **Attach from outside tmux** → `tmux attach`.
- **Attach from inside another tmux** → `switch-client` (no nested tmux trap).
- Clicking a session in the dashboard: if it's already live, jumps to its tab; if dormant, opens a new tab and launches opencode.

## Scrolling

- The **opencode pane** enables its own mouse tracking (SGR), so the wheel scrolls opencode's view natively — no tmux copy-mode friction.
- The **dashboard** parses SGR mouse itself; each column scrolls independently with the wheel.
- The **zsh pane** uses tmux mouse copy-mode with a large scrollback (`history-limit=50000`).

## Configuration (env vars)

| Var | Default | Meaning |
|---|---|---|
| `TOPENCODE_SESSION` | `topencode` | tmux session name |
| `TOPENCODE_OPENCODE_BIN` | `~/.opencode/bin/opencode` | opencode binary path (see below) |
| `TOPENCODE_SHELL` | `zsh` | right-pane shell |
| `TOPENCODE_SHELL_PCT` | `35` | right-pane width % |

### Choosing the opencode binary

The default path is used when it is a runnable file. If it is missing, empty
(0 bytes — what a truncated `opencode upgrade` leaves behind), or not
executable, topencode falls back to the `opencode` on `PATH` instead of
launching a binary that would die instantly and leave the pane reading
`Pane is dead`. Resolution is re-run on every tab open, so repairing the
binary takes effect without restarting anything.

`TOPENCODE_OPENCODE_BIN` is treated as a deliberate instruction and is never
silently bypassed: if you point it at a broken file, you get an error naming
that file rather than a quiet fallback.

When no usable binary can be found, the dashboard shows an
`⚠ opencode unusable — …` line on its bottom row, and opening a tab prints the
same reason inside the pane instead of exec'ing the bad binary.

## Architecture

- **Stateless live/dormant model**: a live session is any tmux window in the `topencode` session tagged with `@oc_session`/`@oc_dir`. Dormant = `opencode session list` minus live. No separate state file — state dies with the tmux objects, so closed windows and server restarts self-heal.
- **Idempotent opens** guarded by `tmux wait-for` locks: opening the same session twice selects the existing tab instead of duplicating.
- **Auto-respawn**: the zsh pane is tagged `@oc_role=shell`; a `pane-died` hook respawns only shell panes (never opencode), preserving the split.
- **Quitting opencode leaves a shell behind**: the opencode pane's command is `opencode … ; exec <shell> -il`, so Ctrl-C drops you into an interactive login shell in the same pane instead of leaving a dead one. Chained with `;` rather than `&&` because a signal-killed opencode exits non-zero — exactly when you want the shell. Running `exit` in that fallback shell does close the pane; reopen the tab from the dashboard.
- All tmux options are set **on the topencode session only** — your global tmux config is untouched.

### Modules

- `src/config.ts` — constants & env overrides
- `src/types.ts` — shared interfaces
- `src/tmux.ts` — argv-based tmux driver (bootstrap, tabs, locks, hooks)
- `src/opencode.ts` — session list + live/dormant merge
- `src/dashboard.ts` — raw-ANSI + SGR-mouse two-column TUI
- `bin/topencode.ts` — CLI entry & routing

## Dev

```sh
bun run dev list                # run from source
bun run src/dashboard.ts        # standalone dashboard self-test (fake data)
bun run typecheck               # tsc --noEmit
bun run build                   # dist/topencode single binary
```
