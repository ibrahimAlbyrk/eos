#!/usr/bin/env bash
# Makes the compiled stand-in for Claude Code (<bin>/claude) the `claude` a synthetic run's
# terminals start, and proves it. A pane runs `claude` in the user's login shell, and on
# macOS a login shell puts the system's paths (/etc/paths, /etc/paths.d: Homebrew's among
# them) ahead of the PATH it was given, so a real Claude Code installed there would win.
# The run's own home gets shell profiles that put <bin> first again, and the shell is asked
# what `claude` is: anything but the stand-in stops the run.
#
#   usage: stand-in-claude.sh <the run's home folder> <bin folder holding the stand-in>
set -euo pipefail
user="${1:?the home folder of the run}"
bin="${2:?the folder holding the stand-in}"
[ -x "$bin/claude" ] || { echo "stand-in-claude: no stand-in at $bin/claude" >&2; exit 1; }
line="PATH=\"$bin:\$PATH\"; export PATH"
for profile in .zprofile .zshrc .bash_profile .profile; do
  printf '%s\n' "$line" > "$user/$profile"
done
shell="${SHELL:-/bin/sh}"
case "$(basename "$shell")" in
  zsh) flags=(-i -l -c) ;;
  *) flags=(-l -c) ;;
esac
probe="command -v claude"
found="$(env -i PATH="$PATH" HOME="$user" SHELL="$shell" TERM=dumb "$shell" "${flags[@]}" "$probe" 2>/dev/null | tail -1)"
if [ "$found" != "$bin/claude" ]; then
  printf 'stand-in-claude: a terminal here would start %s, not the stand-in; refusing to run\n' "${found:-nothing}" >&2
  exit 1
fi
