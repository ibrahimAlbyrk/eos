// What the app's own memory reads answer in the gallery, so Memory › About you
// draws as it does in the app: eleven kept memories in each group and two
// projects (the twelve the tab counts with the one waiting), an
// agent's suggestion waiting for a yes, the prompt budget and Dreaming on.
const HOUR = 60 * 60 * 1000;

const memory = (id, text, category, hoursAgo, over = {}) => ({
  id, text, category, scope: { kind: "global" }, tier: "always", status: "active",
  source: { kind: "user" }, rev: 1, createdAt: hoursAgo, updatedAt: hoursAgo, ...over,
});

// The answers by path, times counted back from `now`.
export function aboutYouReads(now) {
  const at = (h) => now - h * HOUR;
  const memories = [
    memory("um-1", "Works on a Unity game and its live-ops tools.", "about", at(400)),
    memory("um-2", "Based in Istanbul; writes in English at work.", "about", at(380)),
    memory("um-3", "Prefers small pull requests with one change each.", "work-style", at(120)),
    memory("um-4", "Wants a plan before a large refactor starts.", "work-style", at(90), { source: { kind: "agent", agentId: "w-1", agentName: "planner", why: "asked for a plan twice" } }),
    memory("um-5", "Review comments as code suggestions where possible.", "work-style", at(30), { tier: "on-demand" }),
    memory("um-6", "C# with Unity 2022 LTS; TypeScript for the tools.", "stack", at(300)),
    memory("um-7", "Addressables for every asset load.", "stack", at(200), { scope: { kind: "project", path: "/Users/sample/game-client" } }),
    memory("um-9", "Keeps meetings out of the morning.", "about", at(500)),
    memory("um-10", "Runs the game's tests in batch mode, never in the editor.", "stack", at(150), { scope: { kind: "project", path: "/Users/sample/game-client" } }),
    memory("um-11", "Writes commit messages as Conventional Commits.", "work-style", at(60)),
    memory("um-12", "Uses pnpm in the tools repository.", "stack", at(40), { scope: { kind: "project", path: "/Users/sample/liveops-tools" } }),
    memory("um-8", "Asks for four or five directions before choosing a design.", "work-style", at(2), { status: "suggested", source: { kind: "agent", agentId: "w-2", agentName: "design", why: "asked for variations three times" } }),
  ];
  return {
    "/api/user-memories": { memories },
    "/api/memory/stated": { rules: [] },
    "/api/profile": { profile: { rev: 1, dreaming: { enabled: true, schedule: "nightly", nightlyAt: "03:00" } } },
    "/api/profile/preview": { text: "", tokens: 412, budgetTokens: 1200, overflow: 0 },
    "/api/dreams/status": { running: false, nextAt: at(-9), lastRun: null },
    "/api/dreams": { runs: [] },
    "/projects": { projects: [] },
  };
}

// Four nights of dreaming, newest first: one that proposed two memories (one
// still waiting), one that found nothing new, one skipped and one that failed;
// one chat is kept out of every dream.
export function dreamRuns(now) {
  const at = (h) => now - h * HOUR;
  const night = (id, h, over) => ({
    id, trigger: "nightly", status: "done", reason: null, startedAt: at(h), finishedAt: at(h - 0.2), model: "opus",
    chatsRead: 0, observations: 0, candidates: 0, proposed: 0, tokens: 0, dropped: {}, chats: [], rejected: [], ...over,
  });
  return [
    night("dr-n4", 7, {
      chatsRead: 9, observations: 23, candidates: 2, proposed: 2, tokens: 48_000,
      dropped: { oneOff: 8, known: 5, declined: 1, weak: 3, secret: 1 },
      chats: [
        { workerId: "w-2", name: "design", project: "/Users/sample/studio-site", userTurns: 14, observations: 7 },
        { workerId: "w-1", name: "planner", project: "/Users/sample/game-client", userTurns: 9, observations: 6 },
        { workerId: "w-4", name: "shader-fix", project: "/Users/sample/game-client", userTurns: 6, observations: 4 },
        { workerId: "w-3", name: "tax-forms", project: null, userTurns: 4, observations: 0 },
      ],
      rejected: [{ text: "Uses dark mode everywhere.", reason: "Said once, about one screen" }],
    }),
    night("dr-n3", 31, { chatsRead: 4, observations: 9, tokens: 21_000, dropped: { known: 6, oneOff: 3 } }),
    night("dr-n2", 55, { status: "skipped", reason: "Nothing new since the last dream." }),
    night("dr-n1", 79, { status: "failed", reason: "The model did not answer in time. The next night tries again." }),
  ];
}

// About you's reads with Dreaming's log filled in.
export function withDreams(now) {
  return (reads) => {
    const runs = dreamRuns(now);
    const waiting = { ...reads["/api/user-memories"].memories[0], id: "um-dp1", text: "Wants four or five directions before a design is chosen.", status: "suggested", category: "work-style",
      source: { kind: "dream", dreamId: "dr-n4", evidence: [] }, proposal: { kind: "new", targets: [], confidence: 3 }, rev: 0 };
    return {
      ...reads,
      "/api/user-memories": { memories: [...reads["/api/user-memories"].memories, waiting] },
      "/api/dreams/status": { ...reads["/api/dreams/status"], lastRun: runs[0] },
      "/api/dreams": { runs, excluded: ["w-3"] },
    };
  };
}
