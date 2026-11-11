// Conversations as the Claude Agent SDK streams them: partial messages
// (stream_event), then one `assistant` message per finished content block,
// tool results as `user` messages, a `result` at the end of the turn.

const start = (id) => ({ type: "stream_event", event: { type: "message_start", message: { id } } });
const open = (index, content_block) => ({ type: "stream_event", event: { type: "content_block_start", index, content_block } });
const delta = (index, d) => ({ type: "stream_event", event: { type: "content_block_delta", index, delta: d } });
const thinking = (index, text) => delta(index, { type: "thinking_delta", thinking: text });
const text = (index, t) => delta(index, { type: "text_delta", text: t });
const json = (index, partial_json) => delta(index, { type: "input_json_delta", partial_json });
const stop = (index) => ({ type: "stream_event", event: { type: "content_block_stop", index } });
const assistant = (id, block, usage) => ({ type: "assistant", uuid: `u-${id}`, message: { id, content: [block], ...(usage ? { usage } : {}) } });
const toolResult = (tool_use_id, content, extra = {}) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id, content, is_error: false }] }, ...extra });
const result = (usage = {}, subtype = "success") => ({ type: "result", subtype, usage });
const init = { type: "system", subtype: "init", session_id: "sess-1" };

// A whole text block: streamed, closed, then its durable message.
const textBlock = (id, index, pieces, usage) => [
  open(index, { type: "text", text: "" }),
  ...pieces.map((p) => text(index, p)),
  stop(index),
  assistant(id, { type: "text", text: pieces.join("") }, usage),
];
const thinkingBlock = (id, index, pieces) => [
  open(index, { type: "thinking", thinking: "" }),
  ...pieces.map((p) => thinking(index, p)),
  delta(index, { type: "signature_delta", signature: "sig" }),
  stop(index),
  assistant(id, { type: "thinking", thinking: pieces.join("") }),
];
const toolBlock = (id, index, call, usage) => [
  open(index, { type: "tool_use", id: call.id, name: call.name, input: {} }),
  json(index, JSON.stringify(call.input)),
  stop(index),
  assistant(id, { type: "tool_use", id: call.id, name: call.name, input: call.input }, usage),
];

export const scenarios = [
  {
    name: "text-and-thinking",
    messages: [
      init,
      start("msg_A"),
      ...thinkingBlock("msg_A", 0, ["", "let me ", "think"]),
      ...textBlock("msg_A", 1, ["ans", "wer"], { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2 }),
      result({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2 }),
    ],
  },
  {
    name: "tool-roundtrip",
    messages: [
      init,
      start("msg_A"),
      ...textBlock("msg_A", 0, ["calling tool"]),
      ...toolBlock("msg_A", 1, { id: "t1", name: "Read", input: { file_path: "/x" } }, {
        input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 20, cache_creation_input_tokens: 30,
        cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 20 },
      }),
      toolResult("t1", "data"),
      start("msg_B"),
      ...textBlock("msg_B", 0, ["done"], { input_tokens: 500, output_tokens: 7, cache_read_input_tokens: 400, cache_creation_input_tokens: 4 }),
      result({
        input_tokens: 600, output_tokens: 27, cache_read_input_tokens: 420, cache_creation_input_tokens: 34,
        cache_creation: { ephemeral_5m_input_tokens: 14, ephemeral_1h_input_tokens: 20 },
      }),
      // A second turn: block ids must not repeat.
      start("msg_C"),
      ...textBlock("msg_C", 0, ["again"], { input_tokens: 3, output_tokens: 1 }),
      result({ input_tokens: 3, output_tokens: 1 }),
    ],
  },
  {
    name: "edit-patch",
    messages: [
      init,
      start("msg_A"),
      ...toolBlock("msg_A", 0, { id: "e1", name: "Edit", input: { file_path: "/x", old_string: "old", new_string: "new" } }),
      toolResult("e1", "ok", { tool_use_result: { filePath: "/x", structuredPatch: [{ oldStart: 42, oldLines: 1, newStart: 42, newLines: 1, lines: ["-old", "+new"] }, { foo: 1 }] } }),
      start("msg_B"),
      ...toolBlock("msg_B", 0, { id: "r1", name: "Read", input: {} }),
      toolResult("r1", [{ type: "text", text: "part one, " }, { type: "text", text: "part two" }], { tool_use_result: { structuredPatch: "nope" } }),
      start("msg_C"),
      ...toolBlock("msg_C", 0, { id: "w1", name: "Write", input: { file_path: "/etc/hosts", content: "x" } }),
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "w1", content: "denied", is_error: true }] } },
      result(),
    ],
  },
  {
    // The user interrupts while a thought streams. The backend reports an
    // interrupted turn's `error_during_execution` as `aborted / interrupted`.
    name: "interrupt-reasoning",
    interrupt: true,
    messages: [
      start("msg_I"),
      ...thinkingBlock("msg_I", 0, ["done thought"]),
      open(1, { type: "thinking", thinking: "" }),
      thinking(1, "half a "),
      thinking(1, "thou"),
      result({}, "error_during_execution"),
      // The next turn starts clean.
      start("msg_J"),
      ...textBlock("msg_J", 0, ["ok"]),
      result(),
    ],
  },
  {
    // Interrupted while the answer streams. Today the partial answer is not
    // recorded; the Rust engine keeps it in the conversation and records it.
    name: "interrupt-text",
    interrupt: true,
    recordsCutText: true,
    messages: [
      start("msg_I"),
      open(0, { type: "text", text: "" }),
      text(0, "partial "),
      text(0, "answer"),
      result({}, "error_during_execution"),
    ],
  },
  {
    name: "subagent-foreground",
    messages: [
      init,
      start("msg_A"),
      ...toolBlock("msg_A", 0, { id: "agent_1", name: "Agent", input: { description: "sub", prompt: "look" } }, { input_tokens: 50, output_tokens: 9 }),
      { type: "assistant", parent_tool_use_id: "agent_1", message: { id: "msg_sub", model: "claude-haiku-5", content: [{ type: "tool_use", id: "inner_1", name: "Bash", input: { command: "find ." } }] } },
      { type: "user", parent_tool_use_id: "agent_1", message: { content: [{ type: "tool_result", tool_use_id: "inner_1", content: "found", is_error: false }] } },
      { type: "assistant", parent_tool_use_id: "agent_1", message: { id: "msg_sub2", model: "claude-haiku-5", content: [{ type: "text", text: "inner prose" }, { type: "tool_use", id: "inner_2", name: "Read", input: { file_path: "/y" } }] } },
      { type: "user", parent_tool_use_id: "agent_1", message: { content: [{ type: "tool_result", tool_use_id: "inner_2", content: "nope", is_error: true }] } },
      toolResult("agent_1", "report"),
      start("msg_B"),
      ...textBlock("msg_B", 0, ["all done"], { input_tokens: 80, output_tokens: 4 }),
      result({ input_tokens: 130, output_tokens: 13 }),
    ],
  },
  {
    name: "error-max-turns",
    messages: [
      init,
      start("msg_A"),
      ...textBlock("msg_A", 0, ["hi"]),
      result({}, "error_max_turns"),
    ],
  },
  {
    // A tool whose input a feature follows while the model writes it: pieces
    // are merged per 80 ms (or 4096 characters).
    name: "followed-tool-input",
    follows: ["mcp__worker__present"],
    messages: [
      init,
      { ...start("msg_A"), _at: 1000 },
      open(0, { type: "tool_use", id: "p1", name: "mcp__worker__present", input: {} }),
      { ...json(0, "{\"title\":"), _at: 1000 },
      { ...json(0, "\"Pl"), _at: 1010 },
      { ...json(0, "aces\","), _at: 1050 },
      { ...json(0, "\"ui\":\"<Card/>\""), _at: 1090 },
      { ...json(0, ""), _at: 1095 },
      { ...json(0, "}"), _at: 1100 },
      { ...stop(0), _at: 1101 },
      assistant("msg_A", { type: "tool_use", id: "p1", name: "mcp__worker__present", input: { title: "Places", ui: "<Card/>" } }),
      toolResult("p1", "view v_1 rendered"),
      // A tool nobody follows streams nothing.
      start("msg_B"),
      ...toolBlock("msg_B", 0, { id: "t2", name: "Read", input: { file_path: "/x" } }),
      toolResult("t2", "data"),
      result(),
    ],
  },
  {
    name: "workflow-run",
    messages: [
      init,
      start("msg_A"),
      ...toolBlock("msg_A", 0, { id: "wf_call", name: "Workflow", input: { script: "export const meta = {}" } }),
      { type: "system", subtype: "task_started", task_id: "task_w1", tool_use_id: "wf_call", task_type: "local_workflow", workflow_name: "review" },
      toolResult("wf_call", "Workflow launched in background. Task ID: task_w1", {
        tool_use_result: { status: "async_launched", taskId: "task_w1", runId: "wf_abc", workflowName: "review", summary: "Review the parser", transcriptDir: "/s/subagents/workflows/wf_abc" },
      }),
      start("msg_B"),
      ...textBlock("msg_B", 0, ["launched"]),
      result(),
      { type: "system", subtype: "task_progress", task_id: "task_w1", tool_use_id: "wf_call", _at: 5000, usage: { total_tokens: 100, tool_uses: 1, duration_ms: 900 }, workflow_progress: [
        { type: "workflow_phase", index: 1, title: "Explore" },
        { type: "workflow_agent", index: 1, label: "scan", phaseIndex: 1, state: "start", queuedAt: 10 },
        { type: "workflow_log", message: "starting" },
      ] },
      { type: "system", subtype: "task_progress", task_id: "task_w1", tool_use_id: "wf_call", _at: 6000, usage: { total_tokens: 400, tool_uses: 3, duration_ms: 2000 }, workflow_progress: [
        { type: "workflow_phase", index: 1, title: "Explore" },
        { type: "workflow_agent", index: 1, label: "scan", phaseIndex: 1, state: "progress", startedAt: 20, agentId: "a1", lastToolName: "Read", tokens: 300, toolCalls: 2 },
        { type: "workflow_agent", index: 2, label: "check", phaseIndex: 1, state: "start", queuedAt: 30 },
        { type: "workflow_log", message: "starting" },
        { type: "workflow_log", message: "half way" },
      ] },
      { type: "system", subtype: "task_notification", task_id: "task_w1", tool_use_id: "wf_call", status: "completed", summary: "Review finished", usage: { total_tokens: 900, tool_uses: 7, duration_ms: 4000 } },
    ],
  },
];
