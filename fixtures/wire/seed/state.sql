-- Invented rows for the synthetic data folder. Applied to an empty state.db
-- (schema already migrated) while no daemon runs. `{sandbox}` is replaced by
-- the folder that holds the seeded projects. Times are fixed.
--
-- Workers
--   w-CHAT  a top-level chat with a full transcript (every block and row kind)
--   w-LONG  a chat with 620 rows, for transcript paging
--   o-ORCH    an orchestrator with two workers (w-KID1 done, w-KID2 at rest)
--   w-ARCH  an archived chat
--   w-BARE  a finished chat with no folder
--   w-BUSY  was WORKING when the daemon "died": boot turns it into a resumable chat
BEGIN;

INSERT INTO workers (id, state, cwd, worktree_from, branch, prompt, name, started_at, ended_at, exit_code, parent_id, model,
  tokens_in, tokens_out, tokens_cache_read, tokens_cache_create, cost_usd, is_orchestrator, tool_calls, permission_mode, effort,
  backend_kind, agent_role, session_id, with_gateway, workspace_ready, last_context_tokens, tasks, collaborate, worker_definition,
  tool_scope, name_source, archived_at, scratch)
VALUES
 ('w-CHAT', 'SUSPENDED', '{sandbox}/alpha', NULL, NULL, 'Fix the parser so empty input returns an empty list.', 'Fix the parser',
  1790000000000, NULL, NULL, NULL, 'opus', 1200, 340, 5600, 800, 0.4321, 0, 3, 'bypassPermissions', 'high',
  'claude', 'focused', '11111111-1111-4111-8111-111111111111', 0, 1, 7600, NULL, 0, NULL, NULL, 'auto', NULL, 0),
 ('w-LONG', 'SUSPENDED', '{sandbox}/alpha', NULL, NULL, 'Count to a thousand.', 'Long chat',
  1790000100000, NULL, NULL, NULL, 'sonnet', 90000, 12000, 400000, 3000, 2.5, 0, 0, 'default', 'medium',
  'claude', 'focused', '22222222-2222-4222-8222-222222222222', 0, 1, 150000, NULL, 0, NULL, NULL, 'user', NULL, 0),
 ('o-ORCH', 'SUSPENDED', '{sandbox}/alpha', NULL, NULL, 'Add a --json flag and document it.', 'JSON flag',
  1790000200000, NULL, NULL, NULL, 'opus', 5000, 900, 20000, 1500, 1.25, 1, 4, 'acceptEdits', 'xhigh',
  'claude', NULL, '33333333-3333-4333-8333-333333333333', 0, 1, 26500, NULL, 0, NULL, NULL, 'auto', NULL, 0),
 ('w-KID1', 'DONE', '{sandbox}/alpha', NULL, NULL, 'Implement the --json flag in cli.js.', 'json flag impl',
  1790000210000, 1790000290000, 0, 'o-ORCH', 'opus', 2000, 500, 9000, 700, 0.5, 0, 6, 'acceptEdits', 'high',
  'claude', NULL, '44444444-4444-4444-8444-444444444444', 1, 1, 11700,
  '[{"id":"1","subject":"Add flag","status":"completed"},{"id":"2","subject":"Write test","status":"completed"}]',
  0, 'general-purpose', NULL, 'user', NULL, 0),
 ('w-KID2', 'SUSPENDED', '{sandbox}/alpha', NULL, NULL, 'Find where the README documents flags.', 'readme scout',
  1790000220000, NULL, NULL, 'o-ORCH', 'sonnet', 800, 200, 3000, 100, 0.05, 0, 2, 'acceptEdits', 'medium',
  'claude', NULL, '55555555-5555-4555-8555-555555555555', 1, 1, 3900, NULL, 1, 'explorer',
  '{"allow":["Read","Grep","Glob","Task","Bash(rg:*)"],"deny":[],"editRegex":null}', 'user', NULL, 0),
 ('w-ARCH', 'DONE', '{sandbox}/beta', NULL, NULL, 'What is in this folder?', 'Old question',
  1789990000000, 1789990060000, 0, NULL, 'haiku', 300, 80, 0, 0, 0.001, 0, 1, 'default', 'low',
  'claude', 'focused', '66666666-6666-4666-8666-666666666666', 0, 1, 300, NULL, 0, NULL, NULL, 'auto', 1789995000000, 0),
 ('w-BARE', 'DONE', NULL, NULL, NULL, 'Explain what a monad is in two sentences.', NULL,
  1790000300000, 1790000330000, 0, NULL, 'opus', 150, 60, 0, 0, 0.01, 0, 0, 'default', 'medium',
  'claude', 'focused', NULL, 0, 1, 150, NULL, 0, NULL, NULL, 'default', NULL, 1),
 ('w-BUSY', 'WORKING', '{sandbox}/beta', NULL, NULL, 'Summarize notes.md.', 'Summarize notes',
  1790000400000, NULL, NULL, NULL, 'opus', 400, 20, 0, 0, 0.02, 0, 1, 'plan', 'high',
  'claude', 'focused', '77777777-7777-4777-8777-777777777777', 0, 1, 400, NULL, 0, NULL, NULL, 'auto', NULL, 0);

UPDATE workers SET turn_started_at = 1790000401000 WHERE id = 'w-BUSY';

-- w-CHAT: one of every row kind the transcript knows.
INSERT INTO events (worker_id, ts, type, payload) VALUES
 ('w-CHAT', 1790000000000, 'spawn', '{"resumed":false,"sessionId":"11111111-1111-4111-8111-111111111111","pid":null}'),
 ('w-CHAT', 1790000000100, 'state', '{"state":"WORKING","from":"SPAWNING","reason":"turn started"}'),
 ('w-CHAT', 1790000000200, 'user_message', '{"text":"Fix the parser so empty input returns an empty list.\n\n<attachment path=\"{sandbox}/alpha/src/parser.js\" kind=\"file\" />","msgId":"m-0001","clientMsgIds":["c-0001"]}'),
 ('w-CHAT', 1790000000300, 'agent_event', '{"type":"session","phase":"started","sessionId":"11111111-1111-4111-8111-111111111111"}'),
 ('w-CHAT', 1790000000400, 'agent_event', '{"type":"turn","phase":"started"}'),
 ('w-CHAT', 1790000001000, 'agent_event', '{"type":"message","role":"assistant","model":"claude-opus-5-5","blocks":[{"type":"reasoning","text":"The parser throws on empty input. I should look at parse() first.","blockId":"b-1"},{"type":"text","text":"I''ll read the parser first.","blockId":"b-2","msgId":"msg_01"}]}'),
 ('w-CHAT', 1790000001100, 'agent_event', '{"type":"message","role":"assistant","model":"claude-opus-5-5","blocks":[{"type":"tool_call","callId":"call_read_1","name":"Read","input":{"file_path":"{sandbox}/alpha/src/parser.js"}}]}'),
 ('w-CHAT', 1790000001150, 'policy', '{"tool":"Read","decision":"allow"}'),
 ('w-CHAT', 1790000001200, 'agent_event', '{"type":"activity","kind":"tool_started","callId":"call_read_1","toolName":"Read","input":{"file_path":"{sandbox}/alpha/src/parser.js"}}'),
 ('w-CHAT', 1790000001400, 'agent_event', '{"type":"activity","kind":"tool_finished","callId":"call_read_1","result":"export function parse(text) {\n  return text.split(\",\");\n}\n","isError":false}'),
 ('w-CHAT', 1790000001500, 'agent_event', '{"type":"message","role":"tool","blocks":[{"type":"tool_result","callId":"call_read_1","isError":false,"content":"export function parse(text) {\n  return text.split(\",\");\n}\n"}]}'),
 ('w-CHAT', 1790000002000, 'agent_event', '{"type":"message","role":"assistant","model":"claude-opus-5-5","blocks":[{"type":"tool_call","callId":"call_edit_1","name":"Edit","input":{"file_path":"{sandbox}/alpha/src/parser.js","old_string":"  return text.split(\",\");","new_string":"  if (!text) return [];\n  return text.split(\",\");"}}]}'),
 ('w-CHAT', 1790000002100, 'agent_event', '{"type":"activity","kind":"tool_started","callId":"call_edit_1","toolName":"Edit"}'),
 ('w-CHAT', 1790000002300, 'agent_event', '{"type":"message","role":"tool","blocks":[{"type":"tool_result","callId":"call_edit_1","isError":false,"content":"The file was updated.","patch":[{"oldStart":1,"newStart":1,"lines":[" export function parse(text) {","+  if (!text) return [];","   return text.split(\",\");"," }"]}]}]}'),
 ('w-CHAT', 1790000002400, 'agent_event', '{"type":"activity","kind":"tool_finished","callId":"call_edit_1","result":"The file was updated.","isError":false}'),
 ('w-CHAT', 1790000003000, 'agent_event', '{"type":"message","role":"assistant","model":"claude-opus-5-5","blocks":[{"type":"tool_call","callId":"call_bash_1","name":"Bash","input":{"command":"node --test","description":"Run the tests"}}]}'),
 ('w-CHAT', 1790000003050, 'permission_pending', '{"id":"p-SEED1","tool":"Bash"}'),
 ('w-CHAT', 1790000003100, 'policy', '{"tool":"Bash","decision":"ask"}'),
 ('w-CHAT', 1790000003900, 'agent_event', '{"type":"message","role":"tool","blocks":[{"type":"tool_result","callId":"call_bash_1","isError":true,"content":"1 test failed"}]}'),
 ('w-CHAT', 1790000004000, 'agent_event', '{"type":"message","role":"assistant","model":"claude-opus-5-5","blocks":[{"type":"tool_call","callId":"call_task_1","name":"Task","input":{"description":"Check other callers","prompt":"Find callers of parse()","subagent_type":"Explore"},"spawnsSubagent":true}]}'),
 ('w-CHAT', 1790000004100, 'agent_event', '{"type":"subagent_started","callId":"call_task_1","agentId":"agent-aaaa1111","background":false,"description":"Check other callers"}'),
 ('w-CHAT', 1790000004150, 'agent_event', '{"type":"subagent_profile","callId":"call_task_1","model":"claude-haiku-5","effort":"low"}'),
 ('w-CHAT', 1790000004200, 'agent_event', '{"type":"message","role":"assistant","blocks":[{"type":"tool_call","callId":"call_grep_1","name":"Grep","input":{"pattern":"parse\\("},"parentCallId":"call_task_1"}]}'),
 ('w-CHAT', 1790000004300, 'agent_event', '{"type":"message","role":"tool","blocks":[{"type":"tool_result","callId":"call_grep_1","isError":false,"content":"src/cli.js:3"}]}'),
 ('w-CHAT', 1790000004400, 'agent_event', '{"type":"subagent_completed","agentId":"agent-aaaa1111","callId":"call_task_1","status":"completed","result":"One caller: src/cli.js:3","usage":{"totalTokens":1200,"toolUses":1,"durationMs":300}}'),
 ('w-CHAT', 1790000004500, 'question_pending', '{"toolUseId":"call_ask_1","questions":[{"question":"Should whitespace-only input also return an empty list?","header":"Whitespace","multiSelect":false,"options":[{"label":"Yes","description":"Trim first"},{"label":"No","description":"Keep as is"}]}]}'),
 ('w-CHAT', 1790000004600, 'state', '{"state":"IDLE","from":"WORKING","reason":"awaiting answer"}'),
 ('w-CHAT', 1790000005000, 'question_answered', '{"toolUseId":"call_ask_1","answers":{"Should whitespace-only input also return an empty list?":"Yes"}}'),
 ('w-CHAT', 1790000005100, 'state', '{"state":"WORKING","from":"IDLE","reason":"answer received"}'),
 ('w-CHAT', 1790000005200, 'terminal', '{"runId":"t-SEED1","command":"git status --short","cwd":"{sandbox}/alpha","output":" M src/parser.js\n","exitCode":0,"signal":null,"note":null,"truncated":false,"durationMs":41}'),
 ('w-CHAT', 1790000005300, 'browser_action', '{"tabId":"tab-1","verb":"navigate","url":"https://example.com/docs"}'),
 ('w-CHAT', 1790000005400, 'lifecycle', '{"kind":"model_changed","model":"opus","effort":"high","runtimeApplied":true}'),
 ('w-CHAT', 1790000005500, 'compaction_started', '{"trigger":"manual","beforeTokens":7600,"pct":4}'),
 ('w-CHAT', 1790000005900, 'compaction_completed', '{"trigger":"manual","beforeTokens":7600,"afterTokens":900,"pct":4,"turns":1,"summary":"The user asked to fix parse() for empty input; the fix is in and one test still fails.","durationMs":400}'),
 ('w-CHAT', 1790000006000, 'agent_event', '{"type":"message","role":"assistant","model":"claude-opus-5-5","blocks":[{"type":"text","text":"Done: `parse(\"\")` now returns `[]`. See `src/parser.js:2`.","blockId":"b-9","msgId":"msg_02"}]}'),
 ('w-CHAT', 1790000006100, 'agent_event', '{"type":"usage","inputTokens":1200,"outputTokens":340,"cacheReadTokens":5600,"cacheWriteTokens":{"5m":300,"1h":500},"model":"claude-opus-5-5","deltaCost":0.4321}'),
 ('w-CHAT', 1790000006200, 'agent_event', '{"type":"turn","phase":"ended"}'),
 ('w-CHAT', 1790000006300, 'state', '{"state":"IDLE","from":"WORKING","reason":"turn ended"}'),
 ('w-CHAT', 1790000007000, 'user_message', '{"text":"Thanks. Now handle null too.","msgId":"m-0002","clientMsgIds":["c-0002"]}'),
 ('w-CHAT', 1790000007100, 'message_recalled', '{"text":"Thanks. Now handle null too.","clientMsgId":"c-0002","recalledRowId":39}'),
 ('w-CHAT', 1790000008000, 'conversation_rewound', '{"uuid":"88888888-8888-4888-8888-888888888888","text":"Thanks. Now handle null too.","display":"Thanks. Now handle null too.","index":1,"mode":"conversation"}'),
 ('w-CHAT', 1790000009000, 'state', '{"state":"SUSPENDED","from":"IDLE","reason":"idle suspend"}');

-- w-LONG: 620 alternating rows.
WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 620)
INSERT INTO events (worker_id, ts, type, payload)
SELECT 'w-LONG', 1790000100000 + i * 1000,
  CASE WHEN i % 4 = 1 THEN 'user_message' ELSE 'agent_event' END,
  CASE WHEN i % 4 = 1 THEN json_object('text', 'Message number ' || i, 'msgId', 'm-long-' || i, 'clientMsgIds', json_array('c-long-' || i))
       ELSE json_object('type', 'message', 'role', 'assistant', 'blocks', json_array(json_object('type', 'text', 'text', 'Reply number ' || i, 'blockId', 'b-long-' || i))) END
FROM n;

-- The orchestrator and its two workers.
INSERT INTO events (worker_id, ts, type, payload) VALUES
 ('o-ORCH', 1790000200000, 'spawn', '{"resumed":false,"sessionId":"33333333-3333-4333-8333-333333333333","pid":null}'),
 ('o-ORCH', 1790000200100, 'user_message', '{"text":"Add a --json flag and document it.","msgId":"m-0101","clientMsgIds":["c-0101"]}'),
 ('o-ORCH', 1790000200200, 'agent_event', '{"type":"message","role":"assistant","model":"claude-opus-5-5","blocks":[{"type":"tool_call","callId":"call_spawn_1","name":"mcp__orchestrator__spawn_worker","input":{"from":"general-purpose","prompt":"Implement the --json flag in cli.js.","name":"json flag impl"}}]}'),
 ('o-ORCH', 1790000200300, 'agent_event', '{"type":"message","role":"tool","blocks":[{"type":"tool_result","callId":"call_spawn_1","isError":false,"content":"{\"id\":\"w-KID1\"}"}]}'),
 ('o-ORCH', 1790000291000, 'worker_report', '{"text":"Implemented --json in src/cli.js and added a test.","fromWorker":"w-KID1","workerName":"json flag impl"}'),
 ('o-ORCH', 1790000292000, 'agent_event', '{"type":"message","role":"assistant","model":"claude-opus-5-5","blocks":[{"type":"text","text":"The flag is in. The README still needs a line.","blockId":"b-o-1"}]}'),
 ('o-ORCH', 1790000293000, 'state', '{"state":"SUSPENDED","from":"IDLE","reason":"idle suspend"}'),
 ('w-KID1', 1790000210000, 'spawn', '{"resumed":false,"sessionId":"44444444-4444-4444-8444-444444444444","pid":null}'),
 ('w-KID1', 1790000210100, 'orchestrator_message', '{"text":"Implement the --json flag in cli.js.","fromParent":"o-ORCH","parentName":"JSON flag"}'),
 ('w-KID1', 1790000250000, 'agent_event', '{"type":"message","role":"assistant","model":"claude-opus-5-5","blocks":[{"type":"text","text":"Implemented --json in src/cli.js and added a test.","blockId":"b-k-1"}]}'),
 ('w-KID1', 1790000289000, 'git_push', '{"outcome":"no-remote","ok":false,"branch":"main","remote":null,"ahead":0,"behind":0,"message":"no remote configured","detail":""}'),
 ('w-KID1', 1790000290000, 'exit', '{"code":0}'),
 ('w-KID2', 1790000220000, 'spawn', '{"resumed":false,"sessionId":"55555555-5555-4555-8555-555555555555","pid":null}'),
 ('w-KID2', 1790000220100, 'orchestrator_message', '{"text":"Find where the README documents flags.","fromParent":"o-ORCH","parentName":"JSON flag"}'),
 ('w-KID2', 1790000225000, 'state', '{"state":"SUSPENDED","from":"IDLE","reason":"idle suspend"}'),
 ('w-ARCH', 1789990000000, 'user_message', '{"text":"What is in this folder?","msgId":"m-0201","clientMsgIds":["c-0201"]}'),
 ('w-ARCH', 1789990050000, 'agent_event', '{"type":"message","role":"assistant","blocks":[{"type":"text","text":"Two files: notes.md and pixel.png.","blockId":"b-a-1"}]}'),
 ('w-ARCH', 1789990060000, 'exit', '{"code":0}'),
 ('w-BARE', 1790000300000, 'user_message', '{"text":"Explain what a monad is in two sentences.","msgId":"m-0301","clientMsgIds":["c-0301"]}'),
 ('w-BARE', 1790000320000, 'agent_event', '{"type":"message","role":"assistant","blocks":[{"type":"text","text":"A monad wraps a value with a context. It lets you chain steps that each return a wrapped value.","blockId":"b-b-1"}]}'),
 ('w-BARE', 1790000330000, 'exit', '{"code":0}'),
 ('w-BUSY', 1790000400000, 'user_message', '{"text":"Summarize notes.md.","msgId":"m-0401","clientMsgIds":["c-0401"]}'),
 ('w-BUSY', 1790000401000, 'state', '{"state":"WORKING","from":"IDLE","reason":"turn started"}'),
 ('w-BUSY', 1790000402000, 'agent_event', '{"type":"message","role":"assistant","blocks":[{"type":"tool_call","callId":"call_read_9","name":"Read","input":{"file_path":"{sandbox}/beta/notes.md"}}]}');

-- Permission asks: one still open, one answered.
INSERT INTO pending_permissions (id, worker_id, tool_name, input, tool_use_id, created_at, expires_at, resolved, decision, reason, updated_input) VALUES
 ('p-SEED1', 'w-CHAT', 'Bash', '{"command":"node --test","description":"Run the tests"}', 'call_bash_1', 1790000003050, 4102444800000, 0, NULL, NULL, NULL),
 ('p-SEED2', 'w-KID1', 'Write', '{"file_path":"{sandbox}/alpha/test/cli.test.js","content":"// test"}', 'call_write_1', 1790000230000, 4102444800000, 1, 'allow', 'user', NULL);

INSERT INTO worker_loops (id, worker_id, parent_id, goal_json, strategy, status, attempt, max_attempts, held_report, last_reason, progress_ring, started_at, updated_at)
VALUES ('l-SEED1', 'w-KID1', 'o-ORCH', '{"summary":"tests pass","command":"node --test"}', 'command', 'passed', 2, 5, NULL, 'exit 0', '[]', 1790000260000, 1790000288000);

INSERT INTO worker_context_marks (worker_id, stage, marked_at) VALUES ('w-LONG', 'warn', 1790000900000);

COMMIT;
