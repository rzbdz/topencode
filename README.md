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

```sh
./install.sh
```

That's it. The script checks prerequisites, installs Bun if it's missing, builds the binary, and drops it in `~/.local/bin/topencode`. It's idempotent — rerun it any time to upgrade.

Requires tmux 3.0+, zsh, and [opencode](https://github.com/sst/opencode). Bun 1.3+ is installed automatically if absent.

| Flag | Effect |
|---|---|
| `--dry-run` | Report what would happen, change nothing |
| `--mirror` | Force the npmmirror download mirror (China) |
| `--no-mirror` | Force the official bun.sh installer |
| `--prefix DIR` | Install somewhere other than `~/.local/bin` |
| `--skip-shell-rc` | Never touch shell rc files |

Notes:

- **Bun mirror**: by default the script probes `bun.sh` and falls back to npmmirror when it's unreachable, so it works inside and outside China. Proxy variables are bypassed for mirror hosts, since routing a domestic mirror through a foreign proxy defeats the purpose.
- **opencode discovery**: the script finds your `opencode` binary on `PATH` or in the usual install roots. If it isn't at the default `~/.opencode/bin/opencode`, the script records `TOPENCODE_OPENCODE_BIN` in your shell rc so you don't have to.
- **PATH**: if `~/.local/bin` isn't on your `PATH`, the script adds it and tells you to reload your shell.

Manual install, if you prefer:

```sh
bun install
bun run install:local
```

## Usage

```sh
topencode                 # attach (create the tmux session if needed)
topencode attach          # same as above
topencode list            # list all sessions grouped by project (plain stdout)
topencode status          # show status of every open session tab
topencode watch           # live-refreshing status view
topencode open <id>       # open/select a tab for a session id
topencode new [dir]       # start a new opencode session tab (default: cwd)
topencode close <tab|id>  # close a tab (does NOT delete the opencode session)
topencode clean           # remove any leftover dead panes
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
| `TOPENCODE_OPENCODE_BIN` | `~/.opencode/bin/opencode` | opencode binary path |
| `TOPENCODE_SHELL` | `zsh` | right-pane shell |
| `TOPENCODE_SHELL_PCT` | `35` | right-pane width % |

## Architecture

- **Stateless live/dormant model**: a live session is any tmux window in the `topencode` session tagged with `@oc_session`/`@oc_dir`. Dormant = `opencode session list` minus live. No separate state file — state dies with the tmux objects, so closed windows and server restarts self-heal.
- **Idempotent opens** guarded by `tmux wait-for` locks: opening the same session twice selects the existing tab instead of duplicating.
- **Exit closes the tab, failures stay visible**: session windows use `remain-on-exit failed`. A pane that exits cleanly is destroyed and a `pane-exited` hook closes the whole tab, so quitting opencode or typing `exit` in the zsh pane removes it. A pane that exits *non-zero* is kept so the error stays readable, with the output in scrollback. `topencode clean` clears leftovers.
- **Deleted project directories**: opencode exits immediately (with status 0) if a session's directory is gone, which would otherwise make the tab vanish on click. Such sessions are marked `⚠` in the dashboard, and opening one shows an explanation instead of disappearing.
- **Terminal colour queries**: opencode probes the terminal with `OSC 10/11`, and the reply is delivered to whichever pane has focus — clicking the status bar could route it to the shell, which echoed it as `rgb:...` garbage. The shell pane sets `allow-passthrough off` (pane-scoped, so your global tmux setting is untouched).
- **Dashboard resilience**: window 0 alone keeps `remain-on-exit on` and is respawned by a `pane-died` hook, so a dashboard crash can never kill the session.
- **Hook scoping**: tmux silently ignores session-scoped `pane-died`/`pane-exited` hooks, so these are registered globally and guarded by a `@topencode` session marker — they can never act on your other tmux sessions.
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
