import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("../../api/client.js", () => ({
  api: { listUserMemories: vi.fn(), getDreamStatus: vi.fn(), listDreams: vi.fn(), profileAvatarUrl: () => "" },
}));

import { api } from "../../api/client.js";
import { UiProvider } from "../../state/ui.jsx";
import { _resetUserMemories, refreshUserMemories } from "../../state/userMemoryStore.js";
import { _resetDreams, refreshDreamLog, refreshDreamStatus } from "../../state/dreamStore.js";
import { DreamJournal } from "./DreamJournal.jsx";
import { DreamLog } from "./DreamLog.jsx";
import { DreamingNow } from "./DreamingCard.jsx";
import { DreamReview } from "../../components/profile/DreamReview.jsx";

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const render = (el) => renderToStaticMarkup(<UiProvider>{el}</UiProvider>);

const kept = { id: "um-old00001", text: "Verify with lint + tests; never restart the daemon mid-session.", category: "work-style", scope: { kind: "project", path: "/Users/me/eos" }, tier: "always", status: "active", source: { kind: "user" }, rev: 0, createdAt: 1, updatedAt: 1 };
const ev = { quote: "eosu yeniden başlattım check et", workerId: "w-1", chat: "profile-system", eventId: 7, by: "user" };
const proposal = (id, kind, text, targets = [], over = {}) => ({
  id, text, category: "work-style", scope: { kind: "global" }, tier: "always", status: "suggested",
  source: { kind: "dream", dreamId: "dr-night1", evidence: [ev] }, proposal: { kind, targets, confidence: 3 }, rev: 0, createdAt: 2, updatedAt: 2, ...over,
});
const P = [
  proposal("um-p1", "new", "Wants a deep think-through before any design or plan."),
  proposal("um-p2", "update", "Verify with lint + tests and never run eos build — the user restarts Eos.", ["um-old00001"]),
  proposal("um-p3", "retire", "No longer true — removed in 368cc14f.", ["um-old00001"]),
];
const RUN = {
  id: "dr-night1", trigger: "nightly", status: "done", reason: null, startedAt: Date.now() - 3_600_000, finishedAt: Date.now(), model: "opus",
  chatsRead: 14, observations: 31, proposed: 3, tokens: 52_000, narrative: "You asked for a deep think-through three times.",
  dropped: { oneOff: 12, known: 6, declined: 2, secret: 1, weak: 0, invalid: 0 },
  chats: [{ workerId: "w-1", name: "profile-system", project: "/Users/me/eos", userTurns: 11, observations: 5 }],
};

beforeEach(async () => {
  _resetUserMemories();
  _resetDreams();
  api.listUserMemories.mockResolvedValue([kept, ...P]);
  api.getDreamStatus.mockResolvedValue({ running: false, runId: null, progress: null, lastRun: RUN, nextAt: null, blocked: null });
  api.listDreams.mockResolvedValue({ runs: [RUN], excluded: [] });
  await refreshUserMemories();
  await refreshDreamStatus();
});

describe("A · DreamJournal", () => {
  it("tells the night's story and lists every proposal with its change", () => {
    const html = render(<DreamJournal proposals={P} memories={[kept, ...P]} lastRun={RUN} />);
    expect(html).toContain("Eos reread 14 chats and noticed 3 things");
    expect(html).toContain("You asked for a deep think-through three times.");
    expect(html).toContain("Opus");
    expect(html).toContain("1 new");
    expect(html).toContain("21 set aside");
    expect(html).toContain("dr-old"); // the update shows what it replaces
    expect(html).toContain("is-retired"); // the retire strikes the memory
    expect(html).toContain(">Update it<");
    expect(html).toContain(">Retire it<");
    expect(html).toContain("eosu yeniden başlattım check et");
    expect(html).toContain("Review one by one");
  });

  it("nothing pending → nothing rendered", () => {
    expect(render(<DreamJournal proposals={[]} memories={[]} lastRun={RUN} />)).toBe("");
  });
});

describe("B · DreamReview", () => {
  it("opens on the first proposal with keyboard hints and its evidence", () => {
    const html = render(<DreamReview onClose={() => {}} />);
    expect(html).toContain("Morning review");
    expect(html).toContain("1 of 3");
    expect(html).toContain("Wants a deep think-through before any design or plan.");
    expect(html).toMatch(/>K<\/kbd>/);
    expect(html).toMatch(/>D<\/kbd>/);
    expect(html).toContain("in your own words");
    expect(html).toContain("Open in chat");
  });
});

describe("Dream log + live", () => {
  it("the log lists runs, what was read and why things were dropped", async () => {
    await refreshDreamLog();
    const html = render(<DreamLog />);
    expect(html).toContain("14</b>chats read");
    expect(html).toContain("profile-system");
    expect(html).toContain("Looked like a secret");
    expect(html).toContain("3 waiting");
  });

  it("dreaming-now shows only while a dream runs", async () => {
    expect(render(<DreamingNow />)).toBe("");
    api.getDreamStatus.mockResolvedValue({ running: true, runId: null, progress: { done: 3, total: 12, chat: "profile-design", noticed: ["Wants depth."] }, lastRun: RUN, nextAt: null, blocked: null });
    await refreshDreamStatus();
    const html = render(<DreamingNow />);
    expect(html).toContain("Reading chat 4 of 12");
    expect(html).toContain("Wants depth.");
    expect(html).toContain(">Stop<");
  });
});
