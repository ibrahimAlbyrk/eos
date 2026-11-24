// `/run <routine> [item…] [--note …] [--show-only]` typed in a chat: the same
// words the core reads (eos-mod-routines chat/command.rs). The composer opens
// the run sheet with them; nothing starts until the user presses Run.

const SLUG = /^[a-z0-9-]+$/;

export function parseRunCommand(text) {
  const m = /^\/run\s+(\S+)(.*)$/s.exec((text ?? "").trim());
  if (!m || !SLUG.test(m[1])) return null;
  const item = [];
  const note = [];
  let showOnly = false;
  let inNote = false;
  for (const word of m[2].split(/\s+/).filter(Boolean)) {
    if (word === "--show-only") { showOnly = true; inNote = false; }
    else if (word === "--note") inNote = true;
    else (inNote ? note : item).push(word);
  }
  return { routine: m[1], item: item.join(" "), note: note.join(" "), showOnly };
}

// The routine a typed name means: its slug, its id, or its name in any case.
export function routineNamed(list, name) {
  const lower = (name ?? "").toLowerCase();
  return (list ?? []).find((r) => r.slug === name || r.id === name || r.name?.toLowerCase() === lower) ?? null;
}

// Which routine a parsed /run names, read only once the user's routines are
// known: sent on before that, a routine's name would start the run in the
// core without the sheet. `undefined` while the list cannot be read (keep
// the text), `null` when no routine has that name (the agent gets it).
export async function routineForCommand(asked, readList, load) {
  if (readList() === null) await load();
  const list = readList();
  return list === null ? undefined : routineNamed(list, asked.routine);
}
