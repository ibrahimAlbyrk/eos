#!/usr/bin/env bash
# install.sh — one-shot Eos installer (curl | bash).
#
#   curl -fsSL https://raw.githubusercontent.com/ibrahimAlbyrk/eos/main/install.sh | bash
#
# Auto-installs the toolchain (Xcode CLT / git, Node 22+, Bun, claude), clones
# the source to ~/eos, installs every package dir, links `eos`, fixes PATH, then
# runs `eos build` to compile and launch the macOS app. Re-running is safe.
set -euo pipefail

EOS_REPO="${EOS_REPO:-https://github.com/ibrahimAlbyrk/eos}"
EOS_BRANCH="${EOS_BRANCH:-main}"
EOS_DIR="${EOS_DIR:-$HOME/eos}"
NODE_MIN=22
DO_BUILD=1

OS="$(uname -s)"
PERSIST_DIRS=()

# ── logging ──────────────────────────────────────────────────────────────────
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_B=$'\033[1m'; C_G=$'\033[32m'; C_Y=$'\033[33m'; C_R=$'\033[31m'; C_0=$'\033[0m'
else
  C_B=""; C_G=""; C_Y=""; C_R=""; C_0=""
fi
log()  { printf '%s==>%s %s\n' "$C_B" "$C_0" "$*"; }
ok()   { printf '  %s✓%s %s\n' "$C_G" "$C_0" "$*"; }
warn() { printf '  %s⚠%s %s\n' "$C_Y" "$C_0" "$*" >&2; }
die()  { printf '%serror:%s %s\n' "$C_R" "$C_0" "$*" >&2; exit 1; }
has()  { command -v "$1" >/dev/null 2>&1; }

usage() {
  cat <<EOF
Eos installer

  curl -fsSL <raw-url>/install.sh | bash

Options (env or flags):
  --no-build           set up only; don't compile the macOS app
  --dir DIR            install location           (env EOS_DIR,    default ~/eos)
  --branch BRANCH      branch to clone            (env EOS_BRANCH, default main)
  -h, --help           this help

After install:  eos build   (recompile + relaunch)   ·   eos help
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --no-build) DO_BUILD=0 ;;
    --dir) EOS_DIR="${2:?--dir needs a path}"; shift ;;
    --branch) EOS_BRANCH="${2:?--branch needs a name}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1 (try --help)" ;;
  esac
  shift
done

# ── PATH helpers ─────────────────────────────────────────────────────────────
# Put a dir on the current PATH and mark it for shell-profile persistence.
use_dir() {
  case ":$PATH:" in *":$1:"*) ;; *) export PATH="$1:$PATH" ;; esac
  PERSIST_DIRS+=("$1")
}

persist_path() {
  [ ${#PERSIST_DIRS[@]} -gt 0 ] || return 0
  local rc shellname
  shellname="$(basename "${SHELL:-bash}")"
  case "$shellname" in
    zsh)  rc="${ZDOTDIR:-$HOME}/.zshrc" ;;
    bash) [ "$OS" = "Darwin" ] && rc="$HOME/.bash_profile" || rc="$HOME/.bashrc" ;;
    *)    warn "add to your shell PATH manually: ${PERSIST_DIRS[*]}"; return 0 ;;
  esac
  touch "$rc"
  if grep -q '# >>> eos >>>' "$rc" 2>/dev/null; then
    ok "PATH already configured in $rc"
    return 0
  fi
  {
    echo ""
    echo "# >>> eos >>>"
    local d
    for d in "${PERSIST_DIRS[@]}"; do echo "export PATH=\"$d:\$PATH\""; done
    echo "# <<< eos <<<"
  } >> "$rc"
  ok "added Eos PATH to $rc"
  EOS_RC="$rc"
}

# ── toolchain ────────────────────────────────────────────────────────────────
node_major() { node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/' | grep -E '^[0-9]+$' || echo 0; }

ensure_xcode_clt() {
  [ "$OS" = "Darwin" ] || return 0
  if xcode-select -p >/dev/null 2>&1 && has git; then
    ok "Xcode Command Line Tools present (git + swiftc)"
    return 0
  fi
  log "Installing Xcode Command Line Tools (git + Swift compiler)…"
  xcode-select --install >/dev/null 2>&1 || true
  warn "A macOS dialog may appear — click Install and let it finish."
  local tries=0
  until xcode-select -p >/dev/null 2>&1 && has git; do
    sleep 10; tries=$((tries + 1))
    [ $tries -gt 120 ] && die "Xcode CLT not detected after 20 min — finish the installer, then re-run."
  done
  ok "Xcode Command Line Tools installed"
}

ensure_git_linux() {
  [ "$OS" = "Linux" ] || return 0
  has git && { ok "git present"; return 0; }
  log "Installing git…"
  if   has apt-get; then sudo apt-get update -y && sudo apt-get install -y git
  elif has dnf;     then sudo dnf install -y git
  elif has pacman;  then sudo pacman -S --noconfirm git
  else die "install git manually, then re-run"; fi
  ok "git installed"
}

install_node_userspace() {
  local os arch ver tgz url dest
  case "$OS" in Darwin) os=darwin ;; Linux) os=linux ;; *) die "unsupported OS: $OS" ;; esac
  case "$(uname -m)" in arm64|aarch64) arch=arm64 ;; x86_64) arch=x64 ;; *) die "unsupported arch: $(uname -m)" ;; esac
  # Newest current/LTS line ≥22 from the official dist index (no jq dependency).
  # grep -m1 (not | head) so pipefail can't trip on head closing the pipe early.
  ver="$(curl -fsSL https://nodejs.org/dist/index.json \
        | grep -m1 -oE '"v(2[2-9]|[3-9][0-9])[0-9.]*"' | tr -d '"')" \
    || die "could not resolve a Node ${NODE_MIN}+ version from nodejs.org — install it manually"
  [ -n "$ver" ] || die "could not resolve a Node ${NODE_MIN}+ version"
  tgz="node-${ver}-${os}-${arch}.tar.gz"
  url="https://nodejs.org/dist/${ver}/${tgz}"
  dest="$HOME/.local/eos-node"
  log "Downloading $url"
  rm -rf "$dest"; mkdir -p "$dest"
  curl -fsSL "$url" | tar -xz -C "$dest" --strip-components=1
  use_dir "$dest/bin"
}

ensure_node() {
  if has node && [ "$(node_major)" -ge "$NODE_MIN" ]; then ok "node $(node -v)"; return 0; fi
  log "Installing Node ${NODE_MIN}+…"
  has brew && { brew install node || true; }
  if has node && [ "$(node_major)" -ge "$NODE_MIN" ]; then ok "node $(node -v)"; return 0; fi
  install_node_userspace
  has node && [ "$(node_major)" -ge "$NODE_MIN" ] \
    || die "could not install Node ${NODE_MIN}+ — install from https://nodejs.org and re-run"
  ok "node $(node -v)"
}

ensure_bun() {
  if has bun; then ok "bun $(bun --version)"; return 0; fi
  log "Installing Bun…"
  has brew && { brew install bun >/dev/null 2>&1 || true; }
  if ! has bun; then
    curl -fsSL https://bun.sh/install | bash || true
    use_dir "$HOME/.bun/bin"
  fi
  has bun || die "bun install failed — see https://bun.sh"
  ok "bun $(bun --version)"
}

# claude is needed at runtime (to spawn workers), not to build. Best-effort.
ensure_claude() {
  if has claude; then ok "claude present — make sure it's signed in to your Max/Pro plan"; return 0; fi
  log "Installing the claude CLI…"
  if curl -fsSL https://claude.ai/install.sh | bash; then
    ok "claude installed — run 'claude' once to sign in to your Max/Pro plan"
  else
    warn "claude auto-install failed — install Claude Code from https://docs.anthropic.com/claude-code and run 'claude' to sign in"
  fi
}

# ── source + deps ────────────────────────────────────────────────────────────
clone_or_update() {
  if [ -d "$EOS_DIR/.git" ]; then
    log "Updating checkout at $EOS_DIR"
    git -C "$EOS_DIR" pull --ff-only 2>/dev/null || warn "pull skipped (local changes?) — using existing checkout"
  elif [ -e "$EOS_DIR" ] && [ -n "$(ls -A "$EOS_DIR" 2>/dev/null)" ]; then
    die "$EOS_DIR exists and is not an Eos checkout — set EOS_DIR=<empty path> and re-run"
  else
    log "Cloning $EOS_REPO ($EOS_BRANCH) → $EOS_DIR"
    git clone --branch "$EOS_BRANCH" "$EOS_REPO" "$EOS_DIR"
  fi
}

# Pin the absolute bun path so the claude-spawned permission gateway resolves it
# regardless of the inherited PATH (config merge is one level deep — this keeps
# every other paths.* default intact).
pin_bun_path() {
  local home bun_bin
  home="${EOS_HOME:-$HOME/.eos}"
  bun_bin="$(command -v bun || true)"
  [ -n "$bun_bin" ] || return 0
  mkdir -p "$home"
  EOS_CFG="$home/config.json" EOS_BUN="$bun_bin" node -e '
    const fs = require("fs"), p = process.env.EOS_CFG;
    let c = {}; try { c = JSON.parse(fs.readFileSync(p, "utf8")); } catch {}
    c.paths = c.paths || {};
    c.paths.bunBin = process.env.EOS_BUN;
    fs.writeFileSync(p, JSON.stringify(c, null, 2) + "\n");
  '
  ok "pinned bun → $bun_bin in $home/config.json"
}

# ── main ─────────────────────────────────────────────────────────────────────
main() {
  log "Eos installer · ${EOS_DIR}"
  [ "$OS" = "Darwin" ] || [ "$OS" = "Linux" ] || die "unsupported platform: $OS (macOS / Linux only)"
  [ "$OS" = "Linux" ] && warn "Linux: the macOS app step is skipped (no Swift compiler)."

  ensure_xcode_clt
  ensure_git_linux
  ensure_node
  ensure_bun
  ensure_claude

  use_dir "$HOME/.local/bin"          # eos symlink + claude land here

  clone_or_update
  log "Installing dependencies (8 package dirs)…"
  bash "$EOS_DIR/scripts/bootstrap.sh" --link
  pin_bun_path
  persist_path

  if [ "$DO_BUILD" = "1" ]; then
    log "Building Eos…"
    if [ "$OS" = "Darwin" ]; then
      "$EOS_DIR/manager/bin/eos" build --open
    else
      "$EOS_DIR/manager/bin/eos" build --no-app
    fi
  fi

  echo ""
  log "Done."
  ok "source:  $EOS_DIR"
  ok "cli:     eos help"
  [ "$DO_BUILD" = "1" ] || ok "next:    eos build        (compile + launch the macOS app)"
  if [ -n "${EOS_RC:-}" ]; then
    warn "open a new terminal (or: source ${EOS_RC}) so 'eos' is on PATH"
  fi
  has claude || warn "install + sign in to the claude CLI before spawning workers"
}

main "$@"
