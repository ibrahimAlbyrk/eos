// DPI immutable-`when` guard — enforces the rule that was previously discipline-only
// (00-PLAN.md §9; CLAUDE.md "DPI prompts"): a fragment's `when` may gate ONLY on
// session-IMMUTABLE facts (captured once at spawn and never changing), NEVER on a
// MUTABLE fact (model/effort/permission/backend/git). The fragment SET is frozen at
// spawn; gating it on a fact that drifts at runtime is a latent bug (the prompt would
// silently mismatch the live session). This scans every built-in prompt fragment and
// fails if any `when` references a mutable fact, or an unclassified one.
//
// Lane-specific prompt text (e.g. the in-process base harness) must flow through the
// assembly `extra`/lane parameter, never a `when` gate — so a clean scan also proves
// no lane/backend gating crept into a fragment.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// core/src/__tests__ → repo root is three levels up, then into manager/prompts.
const PROMPTS_DIR = join(import.meta.dirname, "..", "..", "..", "manager", "prompts");

// MUTABLE facts: snapshotted once but drift during a session → illegal in a `when`.
// model/effort/permission/backend (00-PLAN.md §10); git (CLAUDE.md). Aliases included
// so a renamed-but-equivalent gate is still caught.
const MUTABLE_FACTS = new Set([
  "model",
  "effort",
  "permissionMode",
  "permission",
  "backend",
  "backendKind",
  "backendProfile",
  "kind",
  "isGitRepo",
]);

// IMMUTABLE facts: set once at spawn (role/isSubagent/isWorktree/workerDefinition per
// the rule, plus canCollaborate + isAttached which are spawn-fixed in container.ts and
// already gate real fragments). Legal in a `when`. A fact in neither set is a NEW fact
// that the author must deliberately classify before gating on it — the test fails loud
// rather than letting an unreviewed gate slip through.
const IMMUTABLE_FACTS = new Set([
  "role",
  "isSubagent",
  "isWorktree",
  "workerDefinition",
  "canCollaborate",
  "isAttached",
]);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile() && entry.name.endsWith(".prompt.md")) out.push(full);
  }
  return out;
}

// The YAML frontmatter block only — `fact:` appears exclusively inside a `when`
// condition there, so scanning the frontmatter (never the body) yields exactly the
// gated facts with no false positives from prose. Mirrors FilePromptSource's split.
function frontmatterOf(text: string): string {
  if (!text.startsWith("---\n")) return "";
  const end = text.indexOf("\n---\n", 4);
  return end === -1 ? "" : text.slice(4, end);
}

function factsIn(frontmatter: string): string[] {
  const facts: string[] = [];
  const re = /\bfact\s*:\s*["']?([A-Za-z_][A-Za-z0-9_]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(frontmatter)) !== null) facts.push(m[1]);
  return facts;
}

describe("DPI immutable-`when` guard — no fragment gates on a mutable fact", () => {
  const files = walk(PROMPTS_DIR);
  const seenFacts = new Set<string>();
  let fragmentsWithGate = 0;

  for (const file of files) {
    const fm = frontmatterOf(readFileSync(file, "utf8"));
    const facts = factsIn(fm);
    if (facts.length > 0) fragmentsWithGate++;
    for (const f of facts) seenFacts.add(f);
    const rel = file.slice(PROMPTS_DIR.length + 1);

    for (const fact of facts) {
      it(`${rel} — when-fact "${fact}" is session-immutable`, () => {
        assert.ok(
          !MUTABLE_FACTS.has(fact),
          `${rel}: \`when\` gates on session-MUTABLE fact "${fact}". A fragment's \`when\` is evaluated once at spawn but this fact drifts at runtime — gate only on immutable facts (role/isSubagent/isWorktree/workerDefinition/...), and route lane/backend/model-specific text through the assembly lane parameter instead.`,
        );
        assert.ok(
          IMMUTABLE_FACTS.has(fact),
          `${rel}: \`when\` references unclassified fact "${fact}". Classify it: add to IMMUTABLE_FACTS if it is set-once-at-spawn, or to MUTABLE_FACTS (and remove the gate) if it drifts.`,
        );
      });
    }
  }

  // Guard against a vacuous pass (a wrong path / empty scan would otherwise be green).
  it("actually scanned the real fragment library", () => {
    assert.ok(files.length >= 50, `expected to scan the built-in fragments, found ${files.length}`);
    assert.ok(fragmentsWithGate >= 5, `expected several gated fragments, found ${fragmentsWithGate}`);
    assert.ok(seenFacts.has("role"), "the `role` fact is gated by many fragments — its absence means the scan missed the frontmatter");
  });
});
