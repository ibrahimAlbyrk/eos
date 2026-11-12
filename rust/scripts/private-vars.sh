#!/usr/bin/env bash
# Picks the chats and records the private scenarios (fixtures/wire/scenarios-private)
# read on a copy of a real data folder, and prints them as `--var NAME=VALUE`
# arguments, one per line. A boot rewrites rows (it cuts event logs), so the picks
# are made once, by private-copy.sh before anything opened the copy, and kept
# beside it in <copy>.vars: a recording made on one copy then replays against
# another copy of the same folder.
#
#   private-vars.sh <copy>
set -euo pipefail
home="$(cd "${1:?a copy of a real data folder}" && pwd -P)"
if [ -f "$home.vars" ]; then
  cat "$home.vars"
  exit 0
fi
db="file:$home/state.db?immutable=1"
q() { sqlite3 "$db" "$1"; }
taken="''"

# NAME QUERY: the first id of QUERY not picked yet, with the transcript cursors
# of that chat (the middle row's id and time).
pick() {
  local name="$1" id
  id="$(q "select id from ($2) where id not in ($taken) limit 1")"
  [ -n "$id" ] || return 0
  taken="$taken,'$id'"
  echo "--var" "$name=$id"
  local count
  count="$(q "select count(*) from events where worker_id = '$id'")"
  [ "$count" -gt 0 ] || return 0
  echo "--var" "${name}_mid=$(q "select id from events where worker_id = '$id' order by id limit 1 offset $((count / 2))")"
  echo "--var" "${name}_ts=$(q "select ts from events where worker_id = '$id' order by id limit 1 offset $((count / 2))")"
}
# Chats ranked by how many agent events of one kind (or rows of one type) they hold.
by_payload() { echo "select worker_id as id from events where type = 'agent_event' and json_extract(payload, '\$.type') = '$1' group by worker_id order by count(*) desc, worker_id"; }
by_type() { echo "select worker_id as id from events where type = '$1' group by worker_id order by count(*) desc, worker_id"; }

pick c_largest "select worker_id as id from events where type = 'agent_event' group by worker_id order by count(*) desc, worker_id"
pick c_newest "select id from workers where parent_id is null and archived_at is null order by started_at desc, id"
pick c_oldest "select id from workers order by started_at, id"
pick c_archived "select id from workers w where archived_at is not null order by (select count(*) from events e where e.worker_id = w.id) desc, id"
pick c_orch "select id from workers w where is_orchestrator = 1 order by (select count(*) from workers k where k.parent_id = w.id) desc, id"
orch="$(q "select id from workers w where is_orchestrator = 1 order by (select count(*) from workers k where k.parent_id = w.id) desc, id limit 1")"
pick c_kid "select id from workers w where parent_id = '$orch' order by (select count(*) from events e where e.worker_id = w.id) desc, id"
pick c_subagents "$(by_payload subagent_started)"
pick c_workflow "$(by_payload workflow_started)"
pick c_compaction "$(by_type compaction_completed)"
pick c_question "$(by_type question_pending)"
pick c_rewound "$(by_type conversation_rewound)"
pick c_switched "$(by_type account_switched)"
pick c_exhausted "$(by_type accounts_exhausted)"
pick c_permission "$(by_type permission_pending)"
pick c_browser "$(by_type browser_action)"
pick c_recalled "$(by_type message_recalled)"
pick c_working "select id from workers where state = 'WORKING' order by id"
pick c_scratch "select id from workers where scratch = 1 order by started_at desc, id"
pick c_done "select id from workers where state = 'DONE' order by started_at desc, id"

# Ids inside a chat: a workflow run and one of its agents, a subagent call.
wf="$(q "select json_extract(payload, '\$.callId') from events where type = 'agent_event' and json_extract(payload, '\$.type') = 'workflow_completed' order by id desc limit 1")"
if [ -n "$wf" ]; then
  echo "--var" "wf_chat=$(q "select worker_id from events where json_extract(payload, '\$.callId') = '$wf' and json_extract(payload, '\$.type') = 'workflow_completed' limit 1")"
  echo "--var" "wf_call=$wf"
  agent="$(q "select json_extract(a.value, '\$.agentId') from events, json_each(json_extract(payload, '\$.snapshot.agents')) a where json_extract(payload, '\$.callId') = '$wf' and json_extract(payload, '\$.type') = 'workflow_completed' and json_extract(a.value, '\$.agentId') is not null limit 1")"
  [ -z "$agent" ] || echo "--var" "wf_agent=$agent"
fi
view="$(q "select id from genui_views order by created_at desc, id limit 1")"
[ -z "$view" ] || echo "--var" "view=$view"
view="$(q "select v.id from genui_views v join genui_view_state s on s.id = v.id order by v.created_at desc limit 1")"
[ -z "$view" ] || echo "--var" "view_state=$view"
transfer="$(q "select id from transfers order by created_at desc, id limit 1")"
[ -z "$transfer" ] || echo "--var" "transfer=$transfer"

# Every chat, oldest first, for the scenario that reads each one's transcript ends.
n=0
for id in $(q "select id from workers order by started_at, id"); do
  n=$((n + 1))
  echo "--var" "w_$n=$id"
done
