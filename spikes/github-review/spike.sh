#!/usr/bin/env bash
# What GitHub answers to the review calls Eos's GitHub delivery stands on, where its
# documentation is silent: one pending review per user, a marker found again after a crash, a
# line comment outside the diff, and an author reviewing their own pull request.
#
#   spikes/github-review/spike.sh <owner>/<repository>
#
# It runs against real GitHub with the `gh` sign-in, so the token never leaves `gh`, and it
# touches only the repository named here: it creates it, private, when it is missing, and stops
# when it is not private. Each run adds two branches, two commits and one pull request there,
# reviews that pull request as the signed-in user, who is also its author, prints what GitHub
# answered, and closes the pull request. Needs `gh` and `jq`.
set -euo pipefail

repo=${1:?usage: spike.sh <owner>/<repository>}
run=$(date -u +%Y%m%d%H%M%S)
file="spike/$run.txt"

# Sets $status and $body. It never fails, because most points are about the errors.
call() { # METHOD PATH [JSON]
  local out
  if [[ $# -ge 3 ]]; then
    out=$(printf '%s' "$3" | gh api --method "$1" --include "$2" --input - 2>/dev/null) || true
  else
    out=$(gh api --method "$1" --include "$2" 2>/dev/null) || true
  fi
  status=$(printf '%s\n' "$out" | head -1 | awk '{ print $2 }')
  body=$(printf '%s\n' "$out" | awk 'f { print; next } { sub(/\r$/, "") } $0 == "" { f = 1 }')
}

field() { jq -r "$@" <<<"$body" 2>/dev/null || true; }

# The review's state on success, otherwise GitHub's whole error body.
said() {
  if [[ $status == 2* ]]; then
    field '"state=\(.state)"'
  else
    jq -c . <<<"$body" 2>/dev/null || printf '%s' "$body"
  fi
}

must() {
  [[ $status == "$1" ]] && return
  echo "setup step answered $status, expected $1: $(said)" >&2
  exit 1
}

ends_with() { field --arg m "$1" '.body | endswith($m)'; }

marker() { printf '<!-- eos:d:dl-%s-%s -->' "$run" "$1"; }

review() { # BODY [EVENT] [COMMENTS]
  jq -nc --arg commit "$head_sha" --arg body "$1" --arg event "${2:-}" --argjson comments "${3:-[]}" \
    '{commit_id: $commit, body: $body}
     + (if $event == "" then {} else {event: $event} end)
     + (if $comments == [] then {} else {comments: $comments} end)'
}

post_review() { call POST "repos/$repo/pulls/$pr/reviews" "$(review "$@")"; }

submit() { # ID EVENT [BODY]
  call POST "repos/$repo/pulls/$pr/reviews/$1/events" "$(jq -nc --arg event "$2" --arg body "${3:-}" \
    '{event: $event} + (if $body == "" then {} else {body: $body} end)')"
}

drop() { call DELETE "repos/$repo/pulls/$pr/reviews/$1"; }

comment_at() { # PATH LINE
  jq -nc --arg path "$1" --argjson line "$2" \
    '[{path: $path, line: $line, side: "RIGHT", body: "Spike: a line comment."}]'
}

# The signed-in user's reviews on the pull request whose body carries MARKER, as "id state" lines.
reviews_with() {
  call GET "repos/$repo/pulls/$pr/reviews?per_page=100"
  jq -r --arg login "$login" --arg m "$1" \
    '.[] | select(.user.login == $login and (.body | contains($m))) | "\(.id) \(.state)"' <<<"$body"
}

count_lines() { grep -c . <<<"$1" || true; }

# --- The repository, a branch with a forty-line file, and a pull request that changes line 30.

call GET "repos/$repo"
if [[ $status == 404 ]]; then
  gh repo create "$repo" --private --add-readme >/dev/null 2>&1
  call GET "repos/$repo"
fi
must 200
if [[ $(field .private) != true ]]; then
  echo "the repository is not private: stopping" >&2
  exit 1
fi
default=$(field .default_branch)
login=$(gh api user --jq .login)

# A repository made a moment ago may not show its first branch yet.
for _ in 1 2 3 4 5; do
  call GET "repos/$repo/git/ref/heads/$default"
  [[ $status == 200 ]] && break
  sleep 2
done
must 200
main_sha=$(field .object.sha)

branch() { # NAME SHA
  call POST "repos/$repo/git/refs" \
    "$(jq -nc --arg ref "refs/heads/$1" --arg sha "$2" '{ref: $ref, sha: $sha}')"
  must 201
}

put_file() { # BRANCH TEXT MESSAGE [BLOB]
  call PUT "repos/$repo/contents/$file" "$(jq -nc --arg b "$1" --arg m "$3" --arg sha "${4:-}" \
    --arg c "$(printf '%s\n' "$2" | base64 | tr -d '\n')" \
    '{message: $m, content: $c, branch: $b} + (if $sha == "" then {} else {sha: $sha} end)')"
}

lines=$(seq -f 'line %g' 1 40)
branch "spike/$run-base" "$main_sha"
put_file "spike/$run-base" "$lines" "Add a forty-line file"
must 201
blob=$(field .content.sha)
branch "spike/$run-head" "$(field .commit.sha)"
put_file "spike/$run-head" "$(sed 's/^line 30$/line 30 changed/' <<<"$lines")" "Change line 30" "$blob"
must 200
head_sha=$(field .commit.sha)
call POST "repos/$repo/pulls" "$(jq -nc --arg h "spike/$run-head" --arg b "spike/$run-base" \
  '{title: "Review rules spike", body: "A test pull request for review calls.", head: $h, base: $b}')"
must 201
pr=$(field .number)
echo "pull request #$pr: $file, line 30 changed, the diff's hunk covers lines 27-33"

echo
echo "== 2. A pending review with a marker, submitted with COMMENT, appears once"
m=$(marker 2)
post_review "Spike: pending, then COMMENT.

$m"
echo "create pending: $status $(said), body ends with the marker: $(ends_with "$m")"
echo "a review's fields: $(field 'keys_unsorted | join(" ")'), submitted_at: $(field .submitted_at)"
id=$(field .id)
submit "$id" COMMENT
echo "submit with event COMMENT and no body: $status $(said), body ends with the marker: $(ends_with "$m")"
if [[ $status != 200 ]]; then
  submit "$id" COMMENT "Spike: pending, then COMMENT.

$m"
  echo "submit with event COMMENT and the body again: $status $(said), body ends with the marker: $(ends_with "$m")"
fi
found=$(reviews_with "$m")
echo "the user's reviews carrying the marker: $(count_lines "$found") ($(cut -d' ' -f2 <<<"$found" | xargs))"

echo
echo "== 3. A second pending review by the same user on the same pull request"
post_review "Spike: the first pending review.

$(marker 3a)"
echo "first pending: $status $(said)"
first=$(field .id)
post_review "Spike: a second pending review.

$(marker 3b)"
echo "second pending: $status $(said)"
post_review "Spike: COMMENT in one request while a pending review exists.

$(marker 3c)" COMMENT
echo "one-request COMMENT while the first is pending: $status $(said)"
call GET "repos/$repo/pulls/$pr/reviews?per_page=100"
echo "the user's pending reviews: $(field --arg login "$login" '[.[] | select(.user.login == $login and .state == "PENDING")] | length')"
drop "$first"
echo "delete the first pending: $status $(said)"

echo
echo "== 4. A crash between creating the pending review and storing its id"
m=$(marker 4)
post_review "Spike: a crash between create and store.

$m"
echo "create pending: $status $(said); its id is dropped here, as in a crash"
created=$(field .id)
found=$(reviews_with "$m")
recovered=$(head -1 <<<"$found" | cut -d' ' -f1)
echo "after the restart, the user's reviews carrying the marker: $(count_lines "$found") ($(cut -d' ' -f2 <<<"$found" | xargs)), the one created: $([[ $recovered == "$created" ]] && echo yes || echo no)"
submit "$recovered" COMMENT
echo "submit the review found with COMMENT: $status $(said)"
found=$(reviews_with "$m")
echo "after a crash between submit and receipt, the marker finds: $(count_lines "$found") ($(cut -d' ' -f2 <<<"$found" | xargs))"

echo
echo "== 5. A line comment outside the diff"
post_review "Spike: a comment inside the diff.

$(marker 5a)" COMMENT "$(comment_at "$file" 30)"
echo "COMMENT with a comment on line 30, in the diff: $status $(said)"
m=$(marker 5b)
post_review "Spike: a comment outside the diff.

$m" COMMENT "$(comment_at "$file" 5)"
echo "COMMENT with a comment on line 5, outside the diff: $status $(said)"
echo "reviews carrying that marker afterwards: $(count_lines "$(reviews_with "$m")")"
post_review "Spike: a pending review with a comment outside the diff.

$(marker 5c)" "" "$(comment_at "$file" 5)"
echo "pending with a comment on line 5: $status $(said)"
[[ $status == 200 ]] && drop "$(field .id)"
post_review "Spike: a comment on a file the pull request does not change.

$(marker 5d)" COMMENT "$(comment_at README.md 1)"
echo "COMMENT with a comment on README.md line 1, not in the pull request: $status $(said)"

echo
echo "== 6. The author reviews their own pull request"
post_review "Spike: APPROVE in one request.

$(marker 6a)" APPROVE
echo "one-request APPROVE: $status $(said)"
post_review "Spike: REQUEST_CHANGES in one request.

$(marker 6b)" REQUEST_CHANGES
echo "one-request REQUEST_CHANGES: $status $(said)"
post_review "Spike: pending, then APPROVE or REQUEST_CHANGES.

$(marker 6c)"
echo "create pending: $status $(said)"
id=$(field .id)
submit "$id" APPROVE
echo "submit the pending review with APPROVE: $status $(said)"
submit "$id" REQUEST_CHANGES
echo "submit the pending review with REQUEST_CHANGES: $status $(said)"
drop "$id"
echo "delete that pending review: $status $(said)"

echo
call GET "repos/$repo/pulls/$pr/reviews?per_page=100"
echo "reviews left on the pull request, by state: $(field '[group_by(.state)[] | "\(.[0].state)=\(length)"] | join(" ")')"
call PATCH "repos/$repo/pulls/$pr" '{"state":"closed"}'
echo "close the pull request: $status $(field .state)"
