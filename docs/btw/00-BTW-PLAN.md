# /btw — side question

Ask an agent a quick question about its chat without touching the chat. The
answer comes from the agent's live conversation, a running turn keeps going,
and nothing is added to the transcript or the agent's context.

## How it answers

Claude Code's own `/btw`: `Query.askSideQuestion(question, { signal })` on the
worker's live SDK query. The binary answers from its live messages (a turn in
progress included), with no tools, sharing the main session's prompt cache, and
records nothing. The method ships in `@anthropic-ai/claude-agent-sdk` but not in
its typings, so `SdkQueryHandle` declares it and
`manager/backends/sdk/__tests__/sdk-side-question-pin.test.ts` fails an SDK bump
that drops it.

- A reply with `synthetic: true` is the binary's own text (an API error), and
  `null` means no answer; both reach the user as an error, never as an answer.
- Only a live session can answer: a suspended agent, or one mid-restart
  (compaction, `/clear`, rewind, recall), gets a 409.
- It bills the same subscription and limits as the agent.

## Layers

- **Port** (`core/src/ports/AgentBackend.ts`): `capabilities.sideQuestion` +
  `AgentSession.askSide(question, { signal }) → SideAnswer`. Callers gate on the
  flag, never on backend kind. Only the claude lane declares it.
- **Use-case** (`core/src/use-cases/AskSideQuestion.ts`): worker exists →
  question not empty → capability → live session → answer. A failure is a
  `ConflictError` (409).
- **Route** (`manager/routes/side-question.ts`): `POST /workers/:id/btw`
  `{ question }` → `{ answer }`, ui-token gated. The answer rides the response;
  a caller that goes away aborts it. No bus topic and nothing persisted. Shapes
  in `contracts/src/side-question.ts` (question ≤ 4000 chars).
- Claude Code's own `/btw` is hidden from the slash menu (`SdkCommandCatalog`
  `HIDDEN_BUILTINS`), since the dashboard drives it.

## UI

- `/btw <question>` in the composer asks the pane's agent and opens the `btw`
  side-panel tab. It is caught before dispatch, because a message to a working
  agent would wait in the queue. A bare `/btw` opens the tab focused. The
  command is listed only for an agent whose backend has `sideQuestion`.
- ⌘/ (⌘⇧7 on a Turkish keyboard) opens the tab with its field focused, except
  inside a code editor, where it stays toggle-comment.
- `views/btw/SideQuestionPanel.jsx`: the question small and quiet, the answer
  large (`MessageAssistant`, its paths clickable through `usePathLinks`),
  "Add to chat" + copy, a field at the foot to ask
  another. One question per agent; a new one replaces and cancels the last.
- "Add to chat" puts the exchange in the pane's composer as a quote
  (`pushTextHandoff`); the user decides whether to send it.
- State: `state/sideQuestionStore.js`, per agent and per window only — a reload
  forgets it, and agents that leave the live list are pruned
  (`useStorePrune`). Pure helpers in `lib/sideQuestion.js`.
