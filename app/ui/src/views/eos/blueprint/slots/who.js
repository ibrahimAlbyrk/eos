// The Who slot: one chip per agent, its name and model; a chip opens the
// agent's brief and model. A script is said as one.

export const MODELS = ["haiku", "sonnet", "opus"];

export const modelOptions = (model) => [...new Set([...MODELS, model])].map((m) => ({ value: m, label: m.charAt(0).toUpperCase() + m.slice(1) }));

export function whoParts(who) {
  const w = who ?? {};
  if (w.depth === "script") return ["A script"];
  const agents = w.agents ?? [];
  if (agents.length === 0) return ["No one yet"];
  return agents.map((agent, n) => ({
    key: `agent.${n}`,
    label: agent.name,
    editor: "agent",
    chip: true,
    text: agent.name,
    sub: agent.model,
    value: { brief: agent.brief ?? "", model: agent.model ?? "sonnet" },
    options: modelOptions(agent.model ?? "sonnet"),
    apply: ({ brief, model }) => ({ ...w, agents: agents.map((a, i) => (i === n ? { ...a, brief, model } : a)) }),
  }));
}
