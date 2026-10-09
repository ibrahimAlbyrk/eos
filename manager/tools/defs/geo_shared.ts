// Shared by find_places / current_location: a daemon refusal as the sentence the
// model should relay ("Location sharing is off. …"), not "daemon 403: {…}".

export async function callDaemon<T>(op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (e) {
    throw new Error(daemonReason(e), { cause: e });
  }
}

export function daemonReason(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  const body = /^daemon \d+: (.*)$/s.exec(msg)?.[1];
  try {
    const err = (JSON.parse(body ?? "") as { error?: unknown }).error;
    if (typeof err === "string") return err.replace(/^invalid request: /, "");
  } catch {
    // not the daemon's JSON — keep the message as it is
  }
  return msg;
}

export function formatAccuracy(m: number): string {
  if (m < 1000) return `±${Math.max(1, Math.round(m))} m`;
  return `±${(m / 1000).toFixed(m < 10_000 ? 1 : 0)} km`;
}

export function formatAge(ms: number): string {
  if (ms < 60_000) return "just now";
  const min = Math.round(ms / 60_000);
  return min < 60 ? `${min} min ago` : `${Math.round(min / 60)} h ago`;
}

export function areaLine(area: { district?: string; city?: string; country?: string } | undefined): string {
  if (!area) return "";
  return [area.district, area.city, area.country].filter((s, i, all) => s && all.indexOf(s) === i).join(", ");
}
