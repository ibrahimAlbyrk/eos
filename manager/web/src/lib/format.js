// Pure formatters used across the UI.

export function fmtCost(n) {
  if (n == null) return "$0.00";
  return "$" + Number(n).toFixed(n >= 1 ? 2 : 3);
}

export function fmtElapsed(ms) {
  if (!ms || ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

export function fmtTokens(n) {
  if (!n) return "0";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(n);
}

export function modelShort(model) {
  if (!model) return "—";
  return String(model).replace(/^claude-/, "");
}

export function statusFromState(state) {
  switch (state) {
    case "WORKING":  return { dot: "run",   label: "running" };
    case "SPAWNING": return { dot: "think", label: "spawning" };
    case "IDLE":     return { dot: "wait",  label: "idle" };
    case "ENDING":   return { dot: "wait",  label: "ending" };
    case "DONE":     return { dot: "wait",  label: "done" };
    case "KILLING":  return { dot: "queue", label: "killing" };
    // Drafts haven't been spawned yet, but the UI treats them as idle/ready
    // so the user doesn't get the impression the agent failed to start.
    case "DRAFT":    return { dot: "wait",  label: "idle" };
    default:         return { dot: "wait",  label: String(state || "idle").toLowerCase() };
  }
}
