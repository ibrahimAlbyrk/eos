#!/usr/bin/env bash
# install.sh — one-shot Eos installer (curl | bash).
#
#   curl -fsSL https://raw.githubusercontent.com/ibrahimAlbyrk/eos/main/install.sh | bash
#
# Installs the signed + notarized Eos.app from the latest GitHub release (needs
# only git, via Xcode CLT). Re-running updates it. Eos runs on Apple Silicon
# Macs only: there is no Intel, Linux or Windows build.
#
# --from-source: installs the toolchain (Xcode CLT / git, Rust via rustup at the
# checkout's rust-toolchain.toml, Node for the dashboard), clones the source to
# ~/eos, then runs the checkout's own `eos build`, which builds, signs and
# installs /Applications/Eos.app, opens it and links `eos` into ~/.local/bin.
# The agent engine is a private repository: the build needs git access to it.
# Re-running is safe.
set -euo pipefail

EOS_REPO="${EOS_REPO:-https://github.com/ibrahimAlbyrk/eos}"
EOS_BRANCH="${EOS_BRANCH:-main}"
EOS_DIR="${EOS_DIR:-$HOME/eos}"
EOS_RELEASE_URL="${EOS_RELEASE_URL:-$EOS_REPO/releases/latest/download/Eos-darwin-arm64.zip}"
APP_PATH="/Applications/Eos.app"
DAEMON_LABEL="com.ibrahimalbyrk.eos.daemon"
# What the dashboard's build needs (host/scripts/setup.sh): 20.19, or 22.12 or later.
NODE_WANTED="20.19 or 22.12+"
DO_BUILD=1
FROM_SOURCE="${EOS_FROM_SOURCE:-0}"

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

Installs the signed Eos.app from the latest release. Eos runs on Apple Silicon
Macs only (no Intel, Linux or Windows build).

Options (env or flags):
  --from-source        clone + build instead      (env EOS_FROM_SOURCE=1)
  --no-build           from source: set up the toolchain and checkout and link
                       \`eos\`; don't build or install the app
  --dir DIR            source location            (env EOS_DIR,    default ~/eos)
  --branch BRANCH      branch to clone            (env EOS_BRANCH, default main)
  -h, --help           this help

A source build needs git access to the private agent engine
(github.com/ibrahimAlbyrk/eos-agent-sdk), e.g. through \`gh auth setup-git\`.

After a source install:  eos build   (rebuild + reinstall)   ·   eos help
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --from-source) FROM_SOURCE=1 ;;
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
    bash) rc="$HOME/.bash_profile" ;;
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

# ── platform ─────────────────────────────────────────────────────────────────
# The app, its helpers and the screen saver are built for Apple Silicon macOS
# only (host/scripts/bundle.sh), so a source build cannot work anywhere else.
require_apple_silicon() {
  local arch
  arch="$(uname -m)"
  [ "$OS" = "Darwin" ] && [ "$arch" = "arm64" ] && return 0
  case "$OS" in
    Darwin) die "Eos runs on Apple Silicon Macs only; this Mac is $arch. There is no Intel build, from a release or from source." ;;
    *)      die "Eos is a macOS app for Apple Silicon Macs; $OS is not supported, from a release or from source." ;;
  esac
}

# ── toolchain ────────────────────────────────────────────────────────────────
# Node new enough for the dashboard's build (the rule host/scripts/setup.sh applies).
node_ok() {
  has node && node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 12) || (a === 20 && b >= 19) ? 0 : 1)' 2>/dev/null
}

ensure_xcode_clt() {
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

install_node_userspace() {
  local ver tgz url dest
  # Newest current/LTS line ≥22 from the official dist index (no jq dependency).
  # grep -m1 (not | head) so pipefail can't trip on head closing the pipe early.
  ver="$(curl -fsSL https://nodejs.org/dist/index.json \
        | grep -m1 -oE '"v(2[2-9]|[3-9][0-9])[0-9.]*"' | tr -d '"')" \
    || die "could not resolve a Node version from nodejs.org — install Node ${NODE_WANTED} manually"
  [ -n "$ver" ] || die "could not resolve a Node version from nodejs.org"
  tgz="node-${ver}-darwin-arm64.tar.gz"
  url="https://nodejs.org/dist/${ver}/${tgz}"
  dest="$HOME/.local/eos-node"
  log "Downloading $url"
  rm -rf "$dest"; mkdir -p "$dest"
  curl -fsSL "$url" | tar -xz -C "$dest" --strip-components=1
  use_dir "$dest/bin"
}

ensure_node() {
  if node_ok; then ok "node $(node -v)"; return 0; fi
  log "Installing Node ${NODE_WANTED}…"
  has brew && { brew install node || true; }
  if node_ok; then ok "node $(node -v)"; return 0; fi
  install_node_userspace
  node_ok || die "could not install Node ${NODE_WANTED} — install it from https://nodejs.org and re-run"
  ok "node $(node -v)"
}

# rustup, not a packaged Rust: the checkout's rust-toolchain.toml picks the
# toolchain, and rustup installs it on the first cargo call in the checkout.
ensure_rustup() {
  use_dir "$HOME/.cargo/bin"
  if has rustup; then ok "rustup $(rustup --version 2>/dev/null | awk '{print $2; exit}')"; return 0; fi
  if has cargo; then
    die "cargo is installed without rustup ($(command -v cargo)); Eos's checkout pins its toolchain through rustup — install rustup from https://rustup.rs and re-run"
  fi
  log "Installing rustup…"
  curl --proto '=https' --tlsv1.2 -fsSL https://sh.rustup.rs \
    | sh -s -- -y --no-modify-path --default-toolchain none \
    || die "rustup install failed — see https://rustup.rs"
  has rustup || die "rustup install failed — see https://rustup.rs"
  ok "rustup installed"
}

# The toolchain the checkout's rust-toolchain.toml names (with its components).
ensure_toolchain() {
  log "Installing the Rust toolchain rust-toolchain.toml names…"
  (cd "$EOS_DIR" && { rustup toolchain install >/dev/null 2>&1 || rustup show active-toolchain >/dev/null; }) \
    || die "rustup could not install the toolchain of $EOS_DIR/rust-toolchain.toml"
  ok "rust $(cd "$EOS_DIR" && rustc --version | awk '{print $2}')"
}

# ── source ───────────────────────────────────────────────────────────────────
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
  [ -x "$EOS_DIR/scripts/eos" ] && [ -f "$EOS_DIR/rust-toolchain.toml" ] \
    || die "$EOS_DIR ($EOS_BRANCH) is not the Rust app's source (no scripts/eos) — pick another --branch"
}

# The agent engine is a private git dependency (Cargo.toml), fetched by cargo
# with the git command line and the user's own credentials. Ask git before the
# long build, so a missing access is one clear message, not a failed build.
check_engine_access() {
  local engine
  engine="$(grep -m1 -oE 'git = "https://github.com/[^"]*eos-agent-sdk[^"]*"' "$EOS_DIR/Cargo.toml" | sed -E 's/git = "(.*)"/\1/')" || true
  [ -n "$engine" ] || { warn "no agent engine dependency found in $EOS_DIR/Cargo.toml — skipping the access check"; return 0; }
  if GIT_TERMINAL_PROMPT=0 git ls-remote "$engine" HEAD >/dev/null 2>&1; then
    ok "agent engine reachable ($engine)"
    return 0
  fi
  die "$(cat <<EOF
cannot reach the agent engine, $engine.
  It is a private repository: building Eos from source needs read access to it
  with your git credentials (with the GitHub CLI signed in: gh auth setup-git).
  Without access, install the release app instead (run this script without --from-source).
EOF
)"
}

# What `eos build` links itself; done here for --no-build. A link to another Eos
# launcher is replaced, anything else is left alone (xtask/src/install/link.rs).
link_eos() {
  local bin link target
  bin="${EOS_BIN_DIR:-$HOME/.local/bin}"
  link="$bin/eos"
  mkdir -p "$bin"
  if [ -L "$link" ]; then
    target="$(readlink "$link")"
    case "$target" in /*) ;; *) target="$bin/$target" ;; esac
    if [ "$target" -ef "$EOS_DIR/scripts/eos" ]; then ok "eos already links to $EOS_DIR/scripts/eos"; return 0; fi
    case "$target" in
      */manager/bin/eos) ;;
      *) grep -q eos-launcher "$target" 2>/dev/null || { warn "$link links to $target, not to an Eos launcher — left alone"; return 0; } ;;
    esac
    ln -sfn "$EOS_DIR/scripts/eos" "$link"
  elif [ -e "$link" ]; then
    warn "$link is not a link — left alone"; return 0
  else
    ln -s "$EOS_DIR/scripts/eos" "$link"
  fi
  ok "linked $link → $EOS_DIR/scripts/eos"
}

# ── prebuilt app (macOS) ─────────────────────────────────────────────────────
# The release app carries Eos's Developer ID signature, which is what lets macOS
# keep its privacy grants (files, screen recording, …) across updates.
install_release() {
  local tmp
  tmp="$(mktemp -d)"
  log "Downloading $EOS_RELEASE_URL"
  curl -fSL --progress-bar "$EOS_RELEASE_URL" -o "$tmp/Eos.zip" \
    || die "download failed — is a release published? (or use --from-source)"
  ditto -x -k "$tmp/Eos.zip" "$tmp" || die "could not unpack the release"
  spctl -a "$tmp/Eos.app" 2>/dev/null || die "downloaded Eos.app failed Gatekeeper verification — not installing it"

  if [ -d "$APP_PATH" ]; then
    log "Updating $APP_PATH — quitting Eos and stopping its daemon (running agents stop)"
    osascript -e 'if application "Eos" is running then tell application "Eos" to quit' >/dev/null 2>&1 || true
    launchctl bootout "gui/$(id -u)/$DAEMON_LABEL" >/dev/null 2>&1 || true
    mv "$APP_PATH" "$tmp/Eos.old.app"
  fi
  ditto "$tmp/Eos.app" "$APP_PATH" || { mv "$tmp/Eos.old.app" "$APP_PATH" 2>/dev/null; die "could not install to $APP_PATH"; }
  rm -rf "$tmp"
  ok "installed $APP_PATH"
  open "$APP_PATH"
}

# ── main ─────────────────────────────────────────────────────────────────────
main() {
  require_apple_silicon

  if [ "$FROM_SOURCE" != "1" ]; then
    log "Eos installer · release app"
    ensure_xcode_clt
    install_release
    log "Done."
    return 0
  fi

  log "Eos installer · from source · ${EOS_DIR}"
  ensure_xcode_clt
  ensure_node
  ensure_rustup
  use_dir "${EOS_BIN_DIR:-$HOME/.local/bin}"    # the eos link lands here

  clone_or_update
  ensure_toolchain
  check_engine_access
  log "Setting up the build (tools, esbuild, the dashboard)…"
  "$EOS_DIR/host/scripts/setup.sh"
  persist_path

  if [ "$DO_BUILD" = "1" ]; then
    log "Building and installing Eos (eos build)…"
    "$EOS_DIR/scripts/eos" build
  else
    link_eos
  fi

  echo ""
  log "Done."
  ok "source:  $EOS_DIR"
  ok "cli:     eos help"
  [ "$DO_BUILD" = "1" ] || ok "next:    eos build        (build, install and open /Applications/Eos.app)"
  if [ -n "${EOS_RC:-}" ]; then
    warn "open a new terminal (or: source ${EOS_RC}) so 'eos' and cargo are on PATH"
  fi
}

main "$@"
