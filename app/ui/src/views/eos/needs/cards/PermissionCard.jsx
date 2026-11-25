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

// A run's permission ask, worded as the Agents banner words one: what the
// tool counts as over its target, the target as the run wrote it. Who asks
// for which tool is the lead's.
export function PermissionCard({ detail }) {
  const { toolName, input } = detail.payload ?? {};
  const { detail: target } = permissionTarget(toolName, typeof input === "object" && input ? input : {});
  const kind = toolClass(toolName);
  return (
    <div className="eos-needs-card eos-needs-ask">
      <p className="eos-label eos-needs-ask__tool">{toolName}{kind && <span className="eos-needs-card__class">{kind}</span>}</p>
      {target && <pre className="eos-needs-ask__target">{target}</pre>}
    </div>
  );
}
