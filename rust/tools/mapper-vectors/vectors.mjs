// Runs today's event mapper (manager/backends/sdk/SdkEventMapper.ts) over scripted
// Claude Agent SDK message streams and writes what it produced. The Rust mapper is
// tested against these files (crates/eos-engine/src/mapper/tests.rs): the same
// conversation, fed as the engine reports it, must come out as the same events.
//
//   node rust/tools/mapper-vectors/vectors.mjs        (needs `npm ci` in contracts/)
//
// A message may carry `_at` (ms): the clock when it arrives, for the pacing of a
// followed tool's input. It is not part of the message.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSdkEventMapper } from "../../../manager/backends/sdk/SdkEventMapper.ts";
import { scenarios } from "./scenarios.mjs";

const out = join(dirname(fileURLToPath(import.meta.url)), "../../crates/eos-engine/tests/vectors");
mkdirSync(out, { recursive: true });

for (const scenario of scenarios) {
  let clock = 0;
  const side = { toolInput: [], workflow: [], tasks: [] };
  const follows = new Set(scenario.follows ?? []);
  const mapper = createSdkEventMapper({
    streamsToolInput: (name) => follows.has(name),
    onToolInputDelta: (d) => side.toolInput.push(d),
    onWorkflowProgress: (p) => side.workflow.push(p),
    onBackgroundTask: (u) => side.tasks.push(u),
    now: () => clock,
  });
  const events = [];
  for (const message of scenario.messages) {
    const { _at, ...msg } = message;
    if (typeof _at === "number") clock = _at;
    events.push(...mapper.map(msg));
  }
  const vector = { ...scenario, expected: { events, ...side } };
  writeFileSync(join(out, `${scenario.name}.json`), JSON.stringify(vector, null, 2) + "\n");
}
console.log(`wrote ${scenarios.length} vectors to ${out}`);
