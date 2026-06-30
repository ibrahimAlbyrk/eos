// M6 — Agent Skills on the in-process API lane (§5c). End-to-end through the REAL
// in-process env factory + InProcessBackend with a REAL FileSkillCatalog over a temp
// project skill:
//   • metadata-in-prompt — the assembled system prompt lists the skill's name +
//     description (the §5h slot), so the model knows the skill exists.
//   • manual invoke — the model calls the Skill tool; the SKILL.md body comes back as
//     the tool_result AND surfaces as a canonical `skill` block correlated by callId.
//   • resource path — the tool result carries the skill's absolute dir, and a bundled
//     asset under it is reachable (what Bash/Read would use).
//
// v1 scope (deliberate): discovery + metadata + MANUAL invoke — NOT auto-trigger.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createInProcessEnvFactory } from "../backends/in-process-env.ts";
import { createInProcessBackend } from "../../infra/src/backends/InProcessBackend.ts";
import { createFileSkillCatalog } from "../../infra/src/skills/FileSkillCatalog.ts";
import { SKILL_TOOL_NAME, skillToolItem, buildSkillTool, renderAvailableSkills } from "../backends/skill-tooling.ts";
import type { ModelClient, ModelTurn } from "../../core/src/ports/ModelClient.ts";
import type { RuntimeTool, ToolGate } from "../../core/src/use-cases/ToolRuntime.ts";
import type { AgentEvent, AgentLaunchSpec } from "../../core/src/ports/AgentBackend.ts";

let root: string;
let cwd: string;
let skillDir: string;

before(() => {
  root = mkdtempSync(join(tmpdir(), "eos-lane-skills-"));
  cwd = join(root, "project");
  skillDir = join(cwd, ".claude", "skills", "greet");
  mkdirSync(join(skillDir, "assets"), { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "---\nname: greet\ndescription: Greet a user warmly in their language\n---\nGREET BODY — read assets/template.txt and personalize it.");
  writeFileSync(join(skillDir, "assets", "template.txt"), "Hello, {{name}}!\n");
});

after(() => rmSync(root, { recursive: true, force: true }));

const allowGate: ToolGate = { async decide() { return { allow: true }; } };
function fakeModel(turns: ModelTurn[]): ModelClient {
  let i = 0;
  return { async createTurn() { return turns[Math.min(i++, turns.length - 1)]; } };
}
function spec(workerId: string): AgentLaunchSpec {
  return { workerId, cwd, model: "fake", prompt: "greet the user", persistent: false, parentId: null, isOrchestrator: false };
}

describe("API-lane skills — discovery, metadata-in-prompt, manual invoke, resource path", () => {
  const turns: ModelTurn[] = [
    { toolCalls: [{ callId: "c1", name: SKILL_TOOL_NAME, input: { name: "greet" } }], stopReason: "tool_use" },
    { text: "greeted", toolCalls: [], stopReason: "end_turn" },
  ];

  function startWorker() {
    const catalog = createFileSkillCatalog();
    const events: AgentEvent[] = [];
    let capturedSystem: string | undefined;
    let offered: { name: string }[] = [];
    const factory = createInProcessEnvFactory({
      // Mirror the container: fold the skill metadata block into the system prompt.
      assembleSystem: (s) => {
        const block = renderAvailableSkills(catalog.listSkills(s.cwd));
        return block ? `BASE INSTRUCTIONS.\n\n${block}` : "BASE INSTRUCTIONS.";
      },
      buildLaneTooling: (s) => ({
        items: [skillToolItem({})],
        tools: new Map<string, RuntimeTool>([[SKILL_TOOL_NAME, buildSkillTool(catalog, s.cwd)]]),
      }),
      authResolver: { async resolve() { return { apiKey: "" }; } },
      makeGate: () => allowGate,
      skillToolName: SKILL_TOOL_NAME,
      buildModelClient: ({ system, items }) => { capturedSystem = system; offered = items; return fakeModel(turns); },
    });
    const be = createInProcessBackend("anthropic-api", factory);
    return { be, events, started: be.start(spec("w-skill"), { onEvent: (e) => events.push(e) }), sys: () => capturedSystem, offered: () => offered };
  }

  it("injects skill metadata (name + description) into the assembled system prompt", async () => {
    const { be, started, sys, offered } = startWorker();
    await started;
    await be.whenSettled("w-skill");
    assert.ok(sys()!.includes("greet"), "skill name is in the prompt");
    assert.ok(sys()!.includes("Greet a user warmly in their language"), "skill description is in the prompt");
    // The model is offered the Skill tool on its surface.
    assert.ok(offered().some((i) => i.name === SKILL_TOOL_NAME), "Skill tool offered");
  });

  it("manual invoke returns the SKILL.md body + the skill dir, and surfaces a skill block", async () => {
    const { be, started, events } = startWorker();
    await started;
    await be.whenSettled("w-skill");

    // The tool_result carries the body + the resource dir.
    const result = events.find((e) => e.type === "message" && e.role === "tool" && e.blocks.some((b) => b.type === "tool_result"));
    assert.ok(result, "a tool_result was emitted");
    const resultText = (result as Extract<AgentEvent, { type: "message" }>).blocks.find((b) => b.type === "tool_result") as { content: string };
    assert.match(resultText.content, /GREET BODY/, "body returned to the model");
    assert.match(resultText.content, new RegExp(`Directory: ${skillDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`), "skill dir surfaced");

    // The canonical skill block is emitted, correlated by the tool call id.
    const skillBlock = events.find((e) => e.type === "message" && e.blocks.some((b) => b.type === "skill"));
    assert.ok(skillBlock, "a skill block was emitted");
    const block = (skillBlock as Extract<AgentEvent, { type: "message" }>).blocks.find((b) => b.type === "skill") as { callId: string; text: string };
    assert.equal(block.callId, "c1", "skill block correlated by the tool call id");
    assert.match(block.text, /GREET BODY/);
  });

  it("the surfaced dir is reachable — a bundled asset resolves under it (Bash/Read path)", async () => {
    const { be, started, events } = startWorker();
    await started;
    await be.whenSettled("w-skill");
    const result = events.find((e) => e.type === "message" && e.role === "tool" && e.blocks.some((b) => b.type === "tool_result")) as Extract<AgentEvent, { type: "message" }>;
    const content = (result.blocks.find((b) => b.type === "tool_result") as { content: string }).content;
    const dir = content.match(/Directory: (.+)/)![1];
    const asset = join(dir, "assets", "template.txt");
    assert.ok(existsSync(asset), "bundled asset reachable under the surfaced dir");
    assert.match(readFileSync(asset, "utf8"), /Hello, \{\{name\}\}/);
  });

  it("an unknown skill returns an error string, not a throw", async () => {
    const catalog = createFileSkillCatalog();
    const out = await buildSkillTool(catalog, cwd).execute({ name: "no-such-skill" });
    assert.match(out, /Unknown skill: no-such-skill/);
  });
});
