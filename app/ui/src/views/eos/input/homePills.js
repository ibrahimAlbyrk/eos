import { modelName, MODELS } from "../../../lib/models.js";

// The Home input's pills (08 G12): the rung a routine made from the text
// starts at, the project it works on, the model of its architect or of the
// one-off's agent. Home offers no more than Draft: more freedom is the
// blueprint's Freedom row, which asks first. A one-off always asks (01).

export const HOME_RUNGS = [
  { value: "draft", label: "Ask before sending" },
  { value: "ask", label: "Ask before each run" },
];

export const NO_CHOICES = { rung: "draft", project: null, model: null };

const FAMILIES = ["haiku", "sonnet", "opus"];

// The Claude models a pill offers, by the alias the core takes.
export const homeModels = () =>
  FAMILIES.map((alias) => MODELS.find((m) => !m.provider && m.aliases.includes(alias))).filter(Boolean).map((m) => ({ value: m.aliases[0], label: m.name }));

export const rungLabel = (intent, rung) =>
  intent === "once" ? HOME_RUNGS[0].label : (HOME_RUNGS.find((r) => r.value === rung) ?? HOME_RUNGS[0]).label;

// The model pill's words: an architect works at high effort.
export function modelLabel(intent, model) {
  const name = model ? modelName(model) : "Default model";
  return intent === "make" ? `${name} · High` : name;
}

// A project by its first folder, the one a request names.
export const projectFolder = (project) => project.folders?.[0] ?? null;
export const projectLabel = (projects, folder) => (folder && projects.find((p) => projectFolder(p) === folder)?.name) || "Any project";

// The fields a request takes from the pills: the rung only for Make, and
// only what the user changed from the defaults.
export function choiceFields(intent, choices) {
  const fields = {};
  if (intent === "make" && choices.rung !== NO_CHOICES.rung) fields.rung = choices.rung;
  if (choices.project) fields.project = choices.project;
  if (choices.model) fields.model = choices.model;
  return fields;
}
