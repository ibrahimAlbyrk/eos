// DreamOverChats — one dream. Durability is counted, not guessed:
//   recall      one call per chat → signals (what the user asked for, how they said it)
//   filter      code drops signals about the product, one task, or an accepted option
//   match       one call files the rest into the candidate ledger, which outlives the
//               night; watermarks move once the ledger holds tonight's signals
//   consolidate one call, only when a candidate is ready (dream-ledger.ts) — at most
//               a few proposals, written as rules that open with their situation
//   critic      one call in its own context tries to refute each proposal
//   file        the survivors go to the suggestion sink (dedupe, tombstones, cap)
// Most nights end before consolidate: nothing new is ready, and that is a good night.

import type { ConversationSummarizer } from "../ports/ConversationSummarizer.ts";
import type { Clock } from "../ports/Clock.ts";
import type { DreamRepo } from "../ports/DreamRepo.ts";
import type { PromptRenderer } from "../ports/PromptRenderer.ts";
import type { UserMemoryReader, UserMemorySuggestionSink } from "../services/UserMemoryService.ts";
import type { UserProfileReader } from "../services/UserProfileService.ts";
import { LimitExceededError } from "../errors/index.ts";
import { estimateTokens } from "../domain/compaction.ts";
import {
  applyVerdicts, checkProposals, emptyDreamDropped, filterSignals, looksSecret, parseConsolidation, parseCritic, parseMatch, parseRecall,
  pickChats, renderChatForDream, type CheckedProposal, type DreamLine, type DreamSession,
} from "../domain/dream.ts";
import {
  applyMatches, decayLedger, groundedMarker, isCandidateReady, summarizeSupport, type NightSignal,
} from "../domain/dream-ledger.ts";
import { formatCandidates, formatMemories, formatProposals, formatSignals } from "../domain/dream-prompt-data.ts";
import type {
  DreamCandidate, DreamChatRead, DreamProgress, DreamRejected, DreamRun, DreamTrigger,
} from "../../../contracts/src/dream.ts";
import type { DreamEvidence } from "../../../contracts/src/profile.ts";

const QUOTE_CHARS = 300;
const FILED_EVIDENCE_MAX = 8;
const REJECTED_MAX = 12;

export interface DreamDeps {
  readonly repo: DreamRepo;
  readonly summarizer: Pick<ConversationSummarizer, "summarizeStructured">;
  // JSON Schemas of the four structured answers (from the contracts' zod schemas).
  readonly schemas: {
    readonly recall: Record<string, unknown>;
    readonly match: Record<string, unknown>;
    readonly consolidate: Record<string, unknown>;
    readonly critic: Record<string, unknown>;
  };
  readonly prompts: PromptRenderer;
  readonly sessions: () => readonly DreamSession[];
  // A chat's messages after `afterId`, oldest first, ids kept.
  readonly lines: (workerId: string, afterId: number) => DreamLine[];
  readonly memories: UserMemoryReader & UserMemorySuggestionSink;
  readonly profile: UserProfileReader;
  // What agents are already told about the user (the rendered profile block).
  readonly profileDigest: () => string;
  readonly clock: Clock;
  readonly newId: () => string;
  readonly timeoutMs: number;
  readonly shouldStop: () => boolean;
  readonly onProgress?: (p: DreamProgress) => void;
}

type Step = "recall" | "match" | "consolidate" | "critic";

export async function dreamOverChats(deps: DreamDeps, input: { trigger: DreamTrigger }): Promise<DreamRun> {
  const s = deps.profile.get().dreaming;
  const chats = pickChats(deps.sessions(), {
    maxChats: s.maxChats,
    excludedProjects: s.excludedProjects,
    includeNoFolder: s.includeNoFolder,
    excludedChats: new Set(deps.repo.excluded()),
    watermark: (id) => deps.repo.watermark(id),
  });
  let run: DreamRun = {
    id: deps.newId(), trigger: input.trigger, status: "running", reason: null,
    startedAt: deps.clock.now(), finishedAt: null, model: s.model,
    chatsRead: 0, observations: 0, proposed: 0, tokens: 0, narrative: null, dropped: emptyDreamDropped(), chats: [],
    candidates: 0, rejected: [],
  };
  const finish = (patch: Partial<DreamRun>): DreamRun => {
    run = { ...run, ...patch, finishedAt: deps.clock.now() };
    deps.repo.save(run);
    return run;
  };
  if (!chats.length) return finish({ status: "skipped", reason: "Nothing new since the last dream" });
  deps.repo.save(run);

  let tokens = 0;
  const ask = async (step: Step, vars: Record<string, string>): Promise<unknown> => {
    const system = deps.prompts.render(`dream/${step}-system`);
    const prompt = deps.prompts.render(`dream/${step}`, vars);
    const out = await deps.summarizer.summarizeStructured({ system, prompt, model: s.model, timeoutMs: deps.timeoutMs, schema: deps.schemas[step] });
    tokens += estimateTokens(system + prompt + JSON.stringify(out));
    return out;
  };
  const dropped = emptyDreamDropped();

  // ---- recall + filter ----
  const night: NightSignal[] = [];
  const read: DreamChatRead[] = [];
  const readChats: DreamSession[] = [];
  let noted = 0;
  let stopped = false;
  const progress = (done: number, chat: string | null): void => deps.onProgress?.({
    done, total: chats.length, chat, noticed: night.slice(-3).map((n) => n.signal.ask),
  });

  for (const [i, chat] of chats.entries()) {
    if (deps.shouldStop()) { stopped = true; break; }
    progress(i, chat.name);
    const rendered = renderChatForDream(deps.lines(chat.workerId, deps.repo.watermark(chat.workerId)));
    if (!rendered.userTurns) {
      read.push({ workerId: chat.workerId, name: chat.name, project: chat.project, userTurns: 0, observations: 0 });
      readChats.push(chat);
      continue;
    }
    let signals;
    try {
      signals = parseRecall(await ask("recall", { CHAT: chat.name, PROJECT: chat.project ?? "no folder", TRANSCRIPT: rendered.text }))
        .filter((x) => !looksSecret(x.ask));
    } catch {
      continue; // this chat stays unread — its watermark doesn't move, the next dream retries it
    }
    noted += signals.length;
    const f = filterSignals(signals);
    dropped.product += f.product;
    dropped.taskBound += f.taskBound;
    dropped.choice += f.choice;
    for (const sig of f.kept) {
      // Evidence must be the user's own lines.
      const lines = sig.evidence.map((id) => rendered.lines.get(id)).filter((l): l is DreamLine => l?.role === "user");
      if (!lines.length) { dropped.invalid++; continue; }
      night.push({
        signal: { ...sig, marker: groundedMarker(sig.marker, lines.map((l) => l.text)) },
        workerId: chat.workerId, chat: chat.name, project: chat.project,
        at: Math.min(...lines.map((l) => l.at)),
        evidence: lines.map((l): DreamEvidence => ({ quote: clip(l.text), workerId: chat.workerId, chat: chat.name, eventId: l.id, by: "user" })),
      });
    }
    read.push({ workerId: chat.workerId, name: chat.name, project: chat.project, userTurns: rendered.userTurns, observations: signals.length });
    readChats.push(chat);
  }
  progress(read.length, null);
  run = { ...run, chatsRead: read.length, observations: noted, chats: read, tokens };
  const ended = stopped ? { status: "stopped" as const, reason: "Stopped — you came back. The rest waits for the next dream." } : { status: "done" as const, reason: null };
  const fail = (step: string, e?: unknown): DreamRun => finish({
    status: "failed", tokens, dropped,
    reason: `Couldn't ${step}${e === undefined ? " — the answer didn't fit its schema" : `: ${e instanceof Error ? e.message : String(e)}`}`,
  });

  // ---- match → ledger ----
  const memories = deps.memories.list();
  let ledger = decayLedger(deps.repo.candidates(), deps.clock.now());
  if (night.length) {
    let groups;
    try {
      groups = parseMatch(await ask("match", {
        SIGNALS: formatSignals(night), CANDIDATES: formatCandidates(ledger, { quotes: false }), MEMORIES: formatMemories(memories),
      }));
    } catch (e) {
      return fail("file tonight's signals", e);
    }
    if (!groups) return fail("file tonight's signals");
    let n = 0;
    const m = applyMatches(ledger, night, groups, memories, () => `dc-${run.id.replace(/^dr-/, "")}-${++n}`);
    ledger = m.ledger;
    dropped.known += m.known;
    dropped.declined += m.declined;
    dropped.invalid += m.invalid;
  }
  deps.repo.replaceCandidates(ledger);
  for (const c of readChats) deps.repo.setWatermark(c.workerId, c.lastEventId);

  const ready = ledger.filter(isCandidateReady);
  if (!ready.length) {
    const reason = ended.reason ?? (ledger.length
      ? `Nothing ready yet — ${ledger.length} ${ledger.length === 1 ? "idea is" : "ideas are"} still gathering support`
      : "Nothing worth remembering this time");
    return finish({ ...ended, reason, tokens, dropped, candidates: ledger.length });
  }

  // ---- consolidate ----
  let parsed;
  try {
    parsed = parseConsolidation(await ask("consolidate", {
      CANDIDATES: formatCandidates(ready, { quotes: true }), MEMORIES: formatMemories(memories), PROFILE: deps.profileDigest(),
    }));
  } catch (e) {
    return fail("weigh what it noticed", e);
  }
  if (!parsed) return fail("weigh what it noticed");
  const settled = new Set<string>();
  for (const a of parsed.setAside) {
    if (!ready.some((c) => c.id === a.candidate)) continue;
    settled.add(a.candidate);
    dropped[a.why]++;
  }
  const check = checkProposals(parsed.proposals, memories, ready);
  dropped.invalid += check.invalid;
  dropped.secret += check.secret;
  dropped.style += check.style;
  for (const p of parsed.proposals) settled.add(p.candidate);
  const rejected: DreamRejected[] = [...check.rejected];

  // ---- critic ----
  let finalists: readonly CheckedProposal[] = [];
  if (check.accepted.length) {
    let verdicts;
    try {
      verdicts = parseCritic(await ask("critic", {
        PROPOSALS: formatProposals(check.accepted), MEMORIES: formatMemories(memories), PROFILE: deps.profileDigest(),
      }));
    } catch (e) {
      return fail("check its proposals", e);
    }
    if (!verdicts) return fail("check its proposals");
    const outcome = applyVerdicts(check.accepted, verdicts);
    finalists = outcome.kept;
    dropped.critic += outcome.rejected.length;
    rejected.push(...outcome.rejected);
  }

  // ---- file ----
  let filed = 0;
  for (const p of finalists) {
    const { irreversible: _irreversible, ...support } = summarizeSupport(p.candidate);
    try {
      const r = deps.memories.suggest(
        {
          text: p.draft.text, category: p.draft.category, domain: p.draft.domain, scope: p.scope,
          proposal: { kind: p.draft.kind, targets: [...p.targets], support },
        },
        { kind: "dream", dreamId: run.id, evidence: evidenceOf(p.candidate), why: p.draft.why },
      );
      if (r.declined) dropped.declined++;
      else if (r.duplicate) dropped.known++;
      else filed++;
    } catch (e) {
      if (e instanceof LimitExceededError) { dropped.capped++; settled.delete(p.candidate.id); } // waits for room
      else dropped.invalid++;
    }
  }
  // Settled candidates leave the ledger; one that truly recurs gathers support again.
  ledger = ledger.filter((c) => !settled.has(c.id));
  deps.repo.replaceCandidates(ledger);
  return finish({
    ...ended,
    tokens,
    proposed: filed,
    narrative: filed ? parsed.narrative || null : null,
    reason: ended.reason ?? (filed ? null : parsed.proposals.length ? "Nothing passed review this time" : "Nothing worth proposing this time"),
    dropped,
    candidates: ledger.length,
    rejected: rejected.slice(0, REJECTED_MAX),
  });
}

function clip(text: string): string {
  return text.length > QUOTE_CHARS ? `${text.slice(0, QUOTE_CHARS).trimEnd()}…` : text;
}

// The newest lines behind a candidate, one per event.
function evidenceOf(c: DreamCandidate): DreamEvidence[] {
  const seen = new Set<number | null>();
  return c.support.flatMap((s) => s.evidence).reverse()
    .filter((e) => (seen.has(e.eventId) ? false : (seen.add(e.eventId), true)))
    .slice(0, FILED_EVIDENCE_MAX);
}
