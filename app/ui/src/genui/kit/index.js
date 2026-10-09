// The kit: every group folder (layout, content, data, entities, geo, inputs)
// exports `components = { Name: Component, … }`; this joins them into the one
// name → component map the renderer reads. Groups are discovered, not listed,
// so a group that isn't there yet just leaves its tags unrendered.

// The kit's shared styles (wells, chips, tones).
import "./base.css";

const GROUPS = ["layout", "content", "data", "entities", "geo", "inputs"];

const modules = import.meta.glob("./*/index.js", { eager: true });

function join() {
  const out = {};
  for (const group of GROUPS) {
    const comps = modules[`./${group}/index.js`]?.components;
    if (!comps || typeof comps !== "object") continue;
    for (const [name, Comp] of Object.entries(comps)) {
      if (typeof Comp === "function" || (Comp && typeof Comp === "object")) out[name] = Comp;
    }
  }
  return out;
}

export const KIT = join();

export function kitHas(name) {
  return Object.prototype.hasOwnProperty.call(KIT, name);
}
