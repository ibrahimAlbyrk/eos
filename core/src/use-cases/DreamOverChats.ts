// DreamOverChats — one dream. Recall: read each chat the filter picks (one
// summarizer call per chat) and note what it shows about the user. Consolidate:
// weigh everything noticed against what's already known — kept, pending and
// declined memories plus the profile (one call). File: hand each proposal to the
// suggestion sink, which dedupes and remembers declined ideas. Watermarks move only
// for chats actually read, so a stopped or failed dream picks up next time.

import type { ConversationSummarizer } from "../ports/ConversationSummarizer.ts";
import type { Clock } from "../ports/Clock.ts";
import type { DreamRepo } from "../ports/DreamRepo.ts";
import type { PromptRenderer } from "../ports/PromptRenderer.ts";
import type { UserMemoryReader, UserMemorySuggestionSink } from "../services/UserMemoryService.ts";
import type { UserProfileReader } from "../services/UserProfileService.ts";
import { estimateTokens } from "../domain/compaction.ts";
import {
  checkProposals, looksSecret, parseConsolidation, parseRecall, pickChats, renderChatForDream,
  type DreamLine, type DreamSession,
} from "../domain/dream.ts";
import type {
  DreamChatRead, DreamDropped, DreamObservation, DreamProgress, DreamRun, DreamTrigger,
} from "../../../contracts/src/dream.ts";
import type { DreamEvidence, UserMemory } from "../../../contracts/src/profile.ts";

const QUOTE_CHARS = 300;
const MEMORY_LIST_MAX = 200;

export interface DreamDeps {
  readonly repo: DreamRepo;
  readonly summarizer: ConversationSummarizer;
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

interface Noticed {
  readonly o: DreamObservation;
  readonly chat: DreamSession;
}

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
    chatsRead: 0, observations: 0, proposed: 0, tokens: 0, narrative: null, dropped: emptyDropped(), chats: [],
  };
  const finish = (patch: Partial<DreamRun>): DreamRun => {
    run = { ...run, ...patch, finishedAt: deps.clock.now() };
    deps.repo.save(run);
    return run;
  };
  if (!chats.length) return finish({ status: "skipped", reason: "Nothing new since the last dream" });
  deps.repo.save(run);

  // ---- recall ----
  const evidence = new Map<number, DreamEvidence>();
  const noticed: Noticed[] = [];
  const read: DreamChatRead[] = [];
  const readChats: DreamSession[] = [];
  let tokens = 0;
  let stopped = false;
  const progress = (done: number, chat: string | null): void => deps.onProgress?.({
    done, total: chats.length, chat, noticed: noticed.slice(-3).map((n) => n.o.statement),
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
    const system = deps.prompts.render("dream/recall-system");
    const prompt = deps.prompts.render("dream/recall", {
      CHAT: chat.name, PROJECT: chat.project ?? "no folder", TRANSCRIPT: rendered.text,
    });
    try {
      const out = await deps.summarizer.summarize({ system, prompt, model: s.model, timeoutMs: deps.timeoutMs });
      tokens += estimateTokens(system + prompt + out);
      const obs = parseRecall(out).filter((o) => !looksSecret(o.statement));
      for (const [id, line] of rendered.lines) {
        evidence.set(id, { quote: clip(line.text), workerId: chat.workerId, chat: chat.name, eventId: id, by: line.role === "user" ? "user" : "agent" });
      }
      noticed.push(...obs.map((o) => ({ o, chat })));
      read.push({ workerId: chat.workerId, name: chat.name, project: chat.project, userTurns: rendered.userTurns, observations: obs.length });
      readChats.push(chat);
    } catch {
      // This chat stays unread — its watermark doesn't move, the next dream retries it.
    }
  }
  progress(read.length, null);
  run = { ...run, chatsRead: read.length, observations: noticed.length, chats: read, tokens };
  const advance = (): void => { for (const c of readChats) deps.repo.setWatermark(c.workerId, c.lastEventId); };
  const ended = stopped ? { status: "stopped" as const, reason: "Stopped — you came back. The rest waits for the next dream." } : { status: "done" as const };

  if (!noticed.length) {
    advance();
    return finish({ ...ended, reason: ended.status === "done" ? "Nothing worth remembering this time" : ended.reason });
  }

  // ---- consolidate ----
  const memories = deps.memories.list();
  const projects = [...new Set(read.map((c) => c.project).filter((p): p is string => p !== null))];
  const system = deps.prompts.render("dream/consolidate-system");
  const prompt = deps.prompts.render("dream/consolidate", {
    OBSERVATIONS: formatNoticed(noticed, evidence),
    MEMORIES: formatMemories(memories),
    PROFILE: deps.profileDigest(),
    PROJECTS: projects.join("\n") || "(none — only no-folder chats)",
  });
  let out: string;
  try {
    out = await deps.summarizer.summarize({ system, prompt, model: s.model, timeoutMs: deps.timeoutMs });
  } catch (e) {
    return finish({ status: "failed", reason: `Couldn't weigh what it noticed: ${e instanceof Error ? e.message : String(e)}` });
  }
  tokens += estimateTokens(system + prompt + out);
  const parsed = parseConsolidation(out);
  if (!parsed) return finish({ status: "failed", reason: "The dream's answer didn't parse — nothing was filed.", tokens });

  // ---- file ----
  const check = checkProposals(parsed.proposals, memories, projects);
  let filed = 0;
  let known = 0;
  let declined = 0;
  let invalid = check.invalid;
  for (const p of check.accepted) {
    const ev = p.draft.evidence.map((id) => evidence.get(id)).filter((x): x is DreamEvidence => Boolean(x)).slice(0, 4);
    try {
      const r = deps.memories.suggest(
        {
          text: p.draft.text, category: p.draft.category, scope: p.scope,
          proposal: { kind: p.draft.kind, targets: [...p.targets], confidence: p.draft.confidence },
        },
        { kind: "dream", dreamId: run.id, evidence: ev },
      );
      if (r.declined) declined++;
      else if (r.duplicate) known++;
      else filed++;
    } catch {
      invalid++;
    }
  }
  advance();
  const d = parsed.dropped;
  return finish({
    ...ended,
    tokens,
    proposed: filed,
    narrative: parsed.narrative || null,
    dropped: {
      oneOff: d.oneOff ?? 0,
      known: (d.known ?? 0) + known,
      declined: (d.declined ?? 0) + declined,
      secret: (d.secret ?? 0) + check.secret,
      weak: d.weak ?? 0,
      invalid,
    },
  });
}

function emptyDropped(): DreamDropped {
  return { oneOff: 0, known: 0, declined: 0, secret: 0, weak: 0, invalid: 0 };
}

function clip(text: string): string {
  return text.length > QUOTE_CHARS ? `${text.slice(0, QUOTE_CHARS).trimEnd()}…` : text;
}

// o<N> · kind · scope · chat (project) · evidence ids, then the statement and the
// user's own words it rests on.
function formatNoticed(noticed: readonly Noticed[], evidence: ReadonlyMap<number, DreamEvidence>): string {
  return noticed.map(({ o, chat }, i) => {
    const quotes = o.evidence.map((id) => evidence.get(id)).filter((e): e is DreamEvidence => Boolean(e))
      .slice(0, 3).map((e) => `    [e${e.eventId}] ${e.by}: “${e.quote}”`);
    return [
      `o${i + 1} · ${o.kind} · ${o.scope} · chat ${chat.name} (${chat.project ?? "no folder"}) · evidence ${o.evidence.map((id) => `e${id}`).join(", ") || "none"}`,
      `  ${o.statement}`,
      ...quotes,
    ].join("\n");
  }).join("\n");
}

// Kept memories first (they're what update/merge/promote/retire can target), then
// pending, then declined — the model must not propose those again.
function formatMemories(memories: readonly UserMemory[]): string {
  const rank = { active: 0, suggested: 1, dismissed: 2 } as const;
  const label = { active: "kept", suggested: "pending", dismissed: "declined" } as const;
  const rows = [...memories].sort((a, b) => rank[a.status] - rank[b.status]).slice(0, MEMORY_LIST_MAX)
    .map((m) => `${m.id} · ${label[m.status]} · ${m.scope.kind === "global" ? "global" : `project ${m.scope.path}`} · ${m.category}\n  ${m.text}`);
  return rows.join("\n") || "(none yet)";
}
