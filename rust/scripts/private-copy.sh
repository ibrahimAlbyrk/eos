#!/usr/bin/env bash
# Makes a working copy of a real data folder that no run can turn against the
# user's own disk, then marks it REAL_DATA (fixtures/README.md, "Real data stays private").
#
#   private-copy.sh <source> <copy>
#
# - every path under the user's home ($EOS_PRIVATE_FROM_HOME, default $HOME) — in
#   state.db's text columns and in the folder's text files — is moved into
#   <copy>-sb, and the user's data folder (<home>/.eos) into <copy>: a route that
#   reads a chat's folder, runs git in it or sweeps a scratch folder meets a
#   throwaway repository, never the user's;
# - each project folder the data names becomes a small git repository with a
#   fixed history (a branch, a stash, an uncommitted change), so git reads answer
#   the same on every copy;
# - archive retention off and dreaming off (nothing ages out or runs at boot);
#   worktree origins cleared (no boot prune of worktrees);
# - the chats the private scenarios read are picked (scripts/private-vars.sh).
#
# Two copies whose paths have the same length answer byte-for-byte alike, which is
# what a recording on one and a replay on the other need.
set -euo pipefail

src="$(cd "${1:?source data folder}" && pwd -P)"
dest="${2:?copy to make}"
from="${EOS_PRIVATE_FROM_HOME:-$HOME}"
[ -f "$src/state.db" ] || { echo "no state.db in $src" >&2; exit 1; }
if [ -e "$dest" ]; then
  [ -f "$dest/REAL_DATA" ] || { echo "$dest exists and is not a copy made here" >&2; exit 1; }
  rm -rf "$dest" "$dest-sb" "$dest.vars"
fi
cp -R "$src" "$dest"
dest="$(cd "$dest" && pwd -P)"
sandbox="$dest-sb"
mkdir -p "$sandbox"
touch "$dest/REAL_DATA"

# The data folder first (it lies inside the home), then the rest of the home.
db="$dest/state.db"
sqlite3 "$db" "select name from sqlite_master where type = 'table' and name not like 'sqlite_%'" |
  while read -r table; do
    sqlite3 "$db" "select name from pragma_table_info('$table') where type in ('TEXT', '')" |
      while read -r column; do
        # One pass: the copy itself lies under the home, so the data folder goes
        # through a placeholder that the home's own rewrite cannot meet.
        printf "update \"%s\" set \"%s\" = replace(replace(replace(\"%s\", '%s/.eos', char(1)), '%s/', '%s/'), char(1), '%s') where \"%s\" like '%%%s/%%';\n" \
          "$table" "$column" "$column" "$from" "$from" "$sandbox" "$dest" "$column" "$from"
      done
  done >"$dest/.rewrite.sql"
{ echo "begin;"; cat "$dest/.rewrite.sql"; echo "update workers set worktree_from = null;"; echo "commit;"; } |
  sqlite3 "$db"
rm -f "$dest/.rewrite.sql"
grep -rlI --exclude='state.db*' -- "$from/" "$dest" | while read -r file; do
  FROM="$from" DEST="$dest" SB="$sandbox" perl -pi -e 's{\Q$ENV{FROM}\E/(\.eos(?![\w.-]))?}{$1 ? $ENV{DEST} : "$ENV{SB}/"}ge' "$file"
done

# Nothing ages out, nothing dreams.
cfg="$dest/config.json"
sqlite3 :memory: "select json_set(readfile('$cfg'), '$.archive.retention', 'off')" >"$cfg.new" && mv "$cfg.new" "$cfg"
prof="$dest/profile/profile.json"
if [ -f "$prof" ]; then
  sqlite3 :memory: "select json_set(readfile('$prof'), '$.dreaming.enabled', json('false'))" >"$prof.new" && mv "$prof.new" "$prof"
fi

# Every project folder the data names, as a throwaway repository.
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
export GIT_AUTHOR_NAME="Wire Fixture" GIT_AUTHOR_EMAIL="wire@example.invalid"
export GIT_COMMITTER_NAME="Wire Fixture" GIT_COMMITTER_EMAIL="wire@example.invalid"
repo() {
  local dir="$1"
  [ -d "$dir/.git" ] && return
  mkdir -p "$dir/src"
  (
    cd "$dir"
    commit() { GIT_AUTHOR_DATE="$1" GIT_COMMITTER_DATE="$1" git commit -q -m "$2"; }
    git init -q -b main
    git config commit.gpgsign false
    printf '# project\n\nA throwaway repository standing in for a real one.\n' >README.md
    printf 'one\ntwo\n' >src/list.txt
    git add -A && commit "2026-09-01T10:00:00Z" "feat: first files"
    printf 'one\ntwo\nthree\n' >src/list.txt
    git add -A && commit "2026-09-02T10:00:00Z" "fix: add the third line"
    git checkout -q -b feature/side
    printf 'side\n' >src/side.txt
    git add -A && commit "2026-09-03T10:00:00Z" "feat: a side file"
    git checkout -q main
    printf '\nStashed line.\n' >>README.md
    GIT_AUTHOR_DATE="2026-09-04T10:00:00Z" GIT_COMMITTER_DATE="2026-09-04T10:00:00Z" git stash push -q -m "wip readme"
    printf '\nAn uncommitted line.\n' >>README.md
    printf 'scratch\n' >notes.txt
  )
}
{
  sqlite3 "$db" "select cwd from workers union select worktree_dir from workers where worktree_dir is not null"
  sqlite3 :memory: "select f.value from json_each(readfile('$dest/projects.json')) p, json_each(p.value, '$.folders') f" 2>/dev/null || true
  sqlite3 :memory: "select value from json_each(readfile('$dest/recents.json'))" 2>/dev/null || true
  grep -h '^project: /' "$dest"/pages/*.md 2>/dev/null | sed 's/^project: //' || true
} | sort -u | while read -r dir; do
  case "$dir" in
    "$dest"/*) mkdir -p "$dir" ;;
    "$sandbox"/*) repo "$dir" ;;
  esac
done
# What the private scenarios read, picked now, before any boot rewrites rows.
"$(dirname "$0")/private-vars.sh" "$dest" >"$dest.vars.new" && mv "$dest.vars.new" "$dest.vars"
echo "$dest"
