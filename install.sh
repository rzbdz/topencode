#!/usr/bin/env bash
# Install topencode locally: bootstrap Bun if needed, build, and install to ~/.local/bin.
#
# Usage:
#   ./install.sh                  # install (auto-detects everything)
#   ./install.sh --mirror         # force the China (npmmirror) download mirror
#   ./install.sh --no-mirror      # force the official bun.sh installer
#   ./install.sh --prefix DIR     # install somewhere other than ~/.local/bin
#   ./install.sh --skip-shell-rc  # do not touch shell rc files
#   ./install.sh --dry-run        # report what would happen, change nothing
set -euo pipefail

BUN_MIN="1.3.0"
TMUX_MIN="3.0"
MIRROR_BASE="https://registry.npmmirror.com/-/binary/bun"
MIRROR_HOSTS="registry.npmmirror.com,npmmirror.com"

PREFIX="${HOME}/.local/bin"
MIRROR_MODE="auto"
SKIP_SHELL_RC=0
DRY_RUN=0

C_OK=$'\033[32m'; C_WARN=$'\033[33m'; C_ERR=$'\033[31m'; C_DIM=$'\033[2m'; C_OFF=$'\033[0m'
[ -t 1 ] || { C_OK=""; C_WARN=""; C_ERR=""; C_DIM=""; C_OFF=""; }

ok()   { printf '%s✓%s %s\n' "$C_OK" "$C_OFF" "$*"; }
warn() { printf '%s!%s %s\n' "$C_WARN" "$C_OFF" "$*"; }
err()  { printf '%s✗%s %s\n' "$C_ERR" "$C_OFF" "$*" >&2; }
info() { printf '  %s%s%s\n' "$C_DIM" "$*" "$C_OFF"; }
step() { printf '\n%s\n' "$*"; }
die()  { err "$*"; exit 1; }

run() {
  if [ "$DRY_RUN" = 1 ]; then info "would run: $*"; return 0; fi
  "$@"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --mirror)        MIRROR_MODE="force" ;;
    --no-mirror)     MIRROR_MODE="never" ;;
    --prefix)        [ $# -ge 2 ] || die "--prefix needs a directory"; PREFIX="$2"; shift ;;
    --skip-shell-rc) SKIP_SHELL_RC=1 ;;
    --dry-run)       DRY_RUN=1 ;;
    -h|--help)       sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)               die "unknown option: $1 (try --help)" ;;
  esac
  shift
done

cd "$(dirname "$0")"
[ -f package.json ] || die "run this from the topencode repo root (package.json not found)"

# Compare dotted versions: returns 0 if $1 >= $2.
version_ge() {
  [ "$1" = "$2" ] && return 0
  local w
  w=$(printf '%s\n%s\n' "$1" "$2" | sort -V 2>/dev/null | head -1) || return 1
  [ "$w" = "$2" ]
}

# tmux reports things like "tmux 3.4a" or "tmux next-3.7"; keep only digits and dots.
normalize_version() { printf '%s' "$1" | sed 's/[^0-9.]//g; s/\.$//'; }

step "Checking prerequisites"

missing=""
command -v tmux >/dev/null 2>&1 || missing="$missing tmux"
command -v unzip >/dev/null 2>&1 || missing="$missing unzip"
command -v curl >/dev/null 2>&1 || missing="$missing curl"
if [ -n "$missing" ]; then
  err "missing required command(s):$missing"
  info "Debian/Ubuntu: sudo apt install$missing"
  info "Fedora:        sudo dnf install$missing"
  info "macOS:         brew install$missing"
  exit 1
fi

TMUX_RAW=$(tmux -V 2>/dev/null | awk '{print $2}')
TMUX_VER=$(normalize_version "$TMUX_RAW")
if version_ge "$TMUX_VER" "$TMUX_MIN"; then
  ok "tmux $TMUX_RAW"
else
  die "tmux >= $TMUX_MIN required (found ${TMUX_RAW:-none})"
fi

SHELL_BIN_NAME="${TOPENCODE_SHELL:-zsh}"
if command -v "$SHELL_BIN_NAME" >/dev/null 2>&1; then
  ok "$SHELL_BIN_NAME present"
else
  warn "$SHELL_BIN_NAME not found — topencode uses it for the right-hand pane"
  info "install it, or set TOPENCODE_SHELL to a shell you have (e.g. bash)"
fi

# opencode may be a real binary or a shim; search PATH then common install roots.
find_opencode() {
  if command -v opencode >/dev/null 2>&1; then command -v opencode; return; fi
  local c
  for c in \
    "$HOME/.opencode/bin/opencode" \
    "$HOME/.local/bin/opencode" \
    "$HOME/.bun/bin/opencode" \
    "$HOME/.hermes/node/bin/opencode" \
    "/usr/local/bin/opencode" \
    "/opt/homebrew/bin/opencode"
  do
    [ -x "$c" ] && { printf '%s' "$c"; return; }
  done
  return 1
}

OPENCODE_PATH="$(find_opencode || true)"
if [ -n "$OPENCODE_PATH" ]; then
  ok "opencode at $OPENCODE_PATH"
else
  warn "opencode not found — topencode needs it at runtime"
  info "install: https://github.com/sst/opencode"
fi

step "Checking Bun"

bun_version() { "$1" --version 2>/dev/null | head -1 | tr -d '[:space:]'; }

BUN_CMD=""
for cand in bun "$HOME/.bun/bin/bun"; do
  if command -v "$cand" >/dev/null 2>&1 || [ -x "$cand" ]; then
    v=$(bun_version "$cand" || true)
    if [ -n "$v" ] && version_ge "$v" "$BUN_MIN"; then
      BUN_CMD="$cand"; ok "bun $v ($cand)"; break
    elif [ -n "$v" ]; then
      warn "bun $v at $cand is older than $BUN_MIN"
    fi
  fi
done

# Decide whether to use the mirror. "auto" probes the official installer and
# falls back when it is unreachable or slow, which is the common case in CN.
should_use_mirror() {
  case "$MIRROR_MODE" in
    force) return 0 ;;
    never) return 1 ;;
  esac
  info "probing bun.sh reachability..."
  if curl -fsSL --max-time 8 -o /dev/null "https://bun.sh/install"; then
    info "bun.sh reachable"
    return 1
  fi
  info "bun.sh unreachable — using npmmirror"
  return 0
}

install_bun_official() {
  info "installing bun via bun.sh"
  curl -fsSL https://bun.sh/install | bash
}

install_bun_mirror() {
  # npmmirror hosts the same release zips as GitHub. Bypass any proxy for these
  # hosts, since a foreign proxy defeats the point of a domestic mirror.
  local no_proxy_all="${no_proxy:-},${MIRROR_HOSTS}"
  export no_proxy="$no_proxy_all" NO_PROXY="$no_proxy_all"

  local arch target
  arch="$(uname -m)"
  case "$(uname -s)" in
    Linux)  case "$arch" in
              x86_64|amd64) target="bun-linux-x64" ;;
              aarch64|arm64) target="bun-linux-aarch64" ;;
              *) die "unsupported Linux arch for mirror install: $arch" ;;
            esac ;;
    Darwin) case "$arch" in
              x86_64) target="bun-darwin-x64" ;;
              arm64)  target="bun-darwin-aarch64" ;;
              *) die "unsupported macOS arch for mirror install: $arch" ;;
            esac ;;
    *) die "unsupported OS for mirror install: $(uname -s)" ;;
  esac

  info "resolving latest bun from npmmirror"
  local latest
  latest=$(curl -fsSL --max-time 20 "$MIRROR_BASE/" \
    | grep -oE 'bun-v[0-9]+\.[0-9]+\.[0-9]+/' \
    | tr -d '/' | sed 's/^bun-v//' \
    | sort -V | tail -1)
  [ -n "$latest" ] || die "could not determine latest bun version from npmmirror"
  info "latest is $latest ($target)"

  local tmpd
  tmpd=$(mktemp -d)
  # shellcheck disable=SC2064
  trap "rm -rf '$tmpd'" RETURN

  curl -fsSL --max-time 300 \
    "$MIRROR_BASE/bun-v$latest/$target.zip" -o "$tmpd/bun.zip" \
    || die "download failed from npmmirror"

  ( cd "$tmpd" && unzip -oq bun.zip ) || die "unzip failed"
  mkdir -p "$HOME/.bun/bin"
  mv -f "$tmpd/$target/bun" "$HOME/.bun/bin/bun" || die "could not install bun binary"
  chmod +x "$HOME/.bun/bin/bun"
  ln -sf "$HOME/.bun/bin/bun" "$HOME/.bun/bin/bunx"
  ok "bun $latest installed to ~/.bun/bin/bun"
}

if [ -z "$BUN_CMD" ]; then
  if [ "$DRY_RUN" = 1 ]; then
    info "would install bun (mode: $MIRROR_MODE)"
    BUN_CMD="bun"
  else
    if should_use_mirror; then
      install_bun_mirror
    else
      install_bun_official || { warn "official installer failed, trying npmmirror"; install_bun_mirror; }
    fi
    BUN_CMD="$HOME/.bun/bin/bun"
    [ -x "$BUN_CMD" ] || die "bun install appeared to succeed but $BUN_CMD is missing"
    ok "bun $("$BUN_CMD" --version)"
  fi
fi

export PATH="$HOME/.bun/bin:$PATH"

step "Installing dependencies"

# Point bun at npmmirror for this build only when the mirror is warranted.
BUN_ENV=()
if [ "$MIRROR_MODE" = "force" ] || { [ "$MIRROR_MODE" = "auto" ] && ! curl -fsSL --max-time 8 -o /dev/null https://registry.npmjs.org 2>/dev/null; }; then
  info "using npmmirror registry for bun install"
  BUN_ENV=(env "BUN_CONFIG_REGISTRY=https://registry.npmmirror.com" "no_proxy=${no_proxy:-},$MIRROR_HOSTS" "NO_PROXY=${NO_PROXY:-},$MIRROR_HOSTS")
fi

if [ "$DRY_RUN" = 1 ]; then
  info "would run: ${BUN_ENV[*]:-} $BUN_CMD install"
else
  "${BUN_ENV[@]}" "$BUN_CMD" install || die "bun install failed"
  ok "dependencies installed"
fi

step "Building"

if [ "$DRY_RUN" = 1 ]; then
  info "would run: $BUN_CMD run build"
else
  "$BUN_CMD" run build || die "build failed"
  [ -f dist/topencode ] || die "build reported success but dist/topencode is missing"
  ok "built dist/topencode ($(du -h dist/topencode | cut -f1))"
fi

step "Installing to $PREFIX"

run mkdir -p "$PREFIX"
if [ "$DRY_RUN" = 1 ]; then
  info "would install dist/topencode -> $PREFIX/topencode"
else
  # mv(2) is atomic within a filesystem; cp directly onto a running binary is not.
  staged="$PREFIX/.topencode.staged"
  cp dist/topencode "$staged" || die "copy failed"
  chmod +x "$staged"
  mv -f "$staged" "$PREFIX/topencode" || die "install failed"
  ok "installed $PREFIX/topencode"
fi

step "Environment"

case ":$PATH:" in
  *":$PREFIX:"*) ok "$PREFIX is on PATH" ;;
  *)
    warn "$PREFIX is NOT on PATH"
    info "add this to your shell rc:"
    info "  export PATH=\"$PREFIX:\$PATH\""
    ;;
esac

# topencode defaults to ~/.opencode/bin/opencode. If the real binary lives
# elsewhere, record it so the user does not have to export it by hand.
if [ -n "$OPENCODE_PATH" ] && [ "$OPENCODE_PATH" != "$HOME/.opencode/bin/opencode" ]; then
  if [ "$SKIP_SHELL_RC" = 1 ]; then
    warn "opencode is at a non-default path; set this yourself:"
    info "  export TOPENCODE_OPENCODE_BIN=\"$OPENCODE_PATH\""
  else
    rc=""
    case "$(basename "${SHELL:-}")" in
      zsh)  rc="$HOME/.zshrc" ;;
      bash) rc="$HOME/.bashrc" ;;
    esac
    if [ -n "$rc" ]; then
      if [ -f "$rc" ] && grep -q "TOPENCODE_OPENCODE_BIN" "$rc" 2>/dev/null; then
        ok "TOPENCODE_OPENCODE_BIN already set in $(basename "$rc")"
      elif [ "$DRY_RUN" = 1 ]; then
        info "would append TOPENCODE_OPENCODE_BIN=$OPENCODE_PATH to $rc"
      else
        {
          printf '\n# topencode: path to the opencode binary\n'
          printf 'export TOPENCODE_OPENCODE_BIN="%s"\n' "$OPENCODE_PATH"
        } >> "$rc"
        ok "added TOPENCODE_OPENCODE_BIN to $(basename "$rc")"
        info "run: source $rc"
      fi
    else
      warn "unknown shell; set this yourself:"
      info "  export TOPENCODE_OPENCODE_BIN=\"$OPENCODE_PATH\""
    fi
  fi
fi

# Older builds left tab windows with remain-on-exit=on, which stranded dead
# panes. A running session picks up the new hooks on the next command.
if [ "$DRY_RUN" != 1 ] && tmux has-session -t "${TOPENCODE_SESSION:-topencode}" 2>/dev/null; then
  step "Existing session detected"
  if "$PREFIX/topencode" clean >/dev/null 2>&1; then
    ok "refreshed hooks and cleaned dead panes in the running session"
  else
    warn "could not refresh the running session; run 'topencode clean' yourself"
  fi
fi

step "Done"
if [ "$DRY_RUN" = 1 ]; then
  info "dry run only — nothing was changed"
else
  printf '  run %stopencode%s to start\n' "$C_OK" "$C_OFF"
fi
