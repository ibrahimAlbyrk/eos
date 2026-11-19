import { permissionTarget } from "../../../../lib/permissionTarget.js";
import { CLASSES } from "../../capabilities/words.js";

// What each built-in tool counts as (03 §7, D43); other tools name no class.
const TOOL_CLASSES = {
  Read: "read", Glob: "read", Grep: "read", LS: "read",
  Edit: "write_local", Write: "write_local", MultiEdit: "write_local", NotebookEdit: "write_local",
};
const OTHER_WORDS = { Bash: "Runs a command on this Mac", WebFetch: "Reads a page on the web", WebSearch: "Searches the web" };

export function toolClass(tool) {
  return CLASSES[TOOL_CLASSES[tool]] ?? OTHER_WORDS[tool] ?? null;
}

// A run's permission ask, worded as the Agents banner words one: the tool,
// what it counts as, and its target.
export function PermissionCard({ detail }) {
  const { toolName, input } = detail.payload ?? {};
  const { detail: target } = permissionTarget(toolName, typeof input === "object" && input ? input : {});
  const kind = toolClass(toolName);
  return (
    <div className="eos-needs-card">
      <p className="eos-needs-card__lead">A run wants to use <strong>{toolName}</strong>.</p>
      {kind && <p className="eos-needs-card__class">{kind}</p>}
      {target && <pre className="eos-code eos-needs-card__target">{target}</pre>}
    </div>
  );
}
