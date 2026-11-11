#!/usr/bin/env bash
# Builds the invented projects the synthetic recordings read: `alpha` (a git
# repository with history, a branch, a stash and an uncommitted change) and
# `beta` (a plain folder). Every date and author is fixed so hashes repeat.
set -euo pipefail
sandbox="${1:?sandbox folder}"
rm -rf "$sandbox"
mkdir -p "$sandbox/alpha/src" "$sandbox/alpha/docs" "$sandbox/beta/sub"

export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
export GIT_AUTHOR_NAME="Wire Fixture" GIT_AUTHOR_EMAIL="wire@example.invalid"
export GIT_COMMITTER_NAME="Wire Fixture" GIT_COMMITTER_EMAIL="wire@example.invalid"
commit() {
  GIT_AUTHOR_DATE="$1" GIT_COMMITTER_DATE="$1" git -C "$sandbox/alpha" commit -q -m "$2"
}

cd "$sandbox/alpha"
git init -q -b main
git config user.name "Wire Fixture"
git config user.email "wire@example.invalid"
git config commit.gpgsign false
printf '# alpha\n\nA tiny CLI used by the wire fixtures.\n' >README.md
printf 'export function parse(text) {\n  return text.split(",");\n}\n' >src/parser.js
printf 'import { parse } from "./parser.js";\n\nconsole.log(parse(process.argv[2] ?? ""));\n' >src/cli.js
printf '# Usage\n\nRun `node src/cli.js a,b`.\n' >docs/usage.md
git add -A
commit "2026-09-01T10:00:00Z" "feat: add the parser and the cli"
printf 'export function parse(text) {\n  if (!text) return [];\n  return text.split(",");\n}\n' >src/parser.js
git add -A
commit "2026-09-02T10:00:00Z" "fix: return an empty list for empty input"

git checkout -q -b feature/json
printf 'import { parse } from "./parser.js";\n\nconst out = parse(process.argv[2] ?? "");\nconsole.log(process.argv.includes("--json") ? JSON.stringify(out) : out);\n' >src/cli.js
git add -A
commit "2026-09-03T10:00:00Z" "feat: add a --json flag"
git checkout -q main

# A stash, then an uncommitted change and an untracked file.
printf '\nStashed line.\n' >>README.md
GIT_AUTHOR_DATE="2026-09-04T10:00:00Z" GIT_COMMITTER_DATE="2026-09-04T10:00:00Z" git stash push -q -m "wip readme"
printf '\nSee docs/usage.md.\n' >>README.md
printf 'scratch\n' >notes.txt

# A plugin folder to install from.
mkdir -p "$sandbox/plugin-src"
cat >"$sandbox/plugin-src/plugin.json" <<'JSON'
{ "id": "wire-sample", "name": "Wire sample", "description": "Installed from a folder by the wire fixtures.", "version": "0.1.0" }
JSON

cd "$sandbox/beta"
printf '# Notes\n\n- first\n- second\n' >notes.md
printf 'plain text\n' >sub/inner.txt
# A 1x1 PNG.
printf '\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\rIDATx\x9cc\xf8\xcf\xc0\xf0\x1f\x00\x05\x00\x01\xff\x89\x99=\x1d\x00\x00\x00\x00IEND\xaeB`\x82' >pixel.png
