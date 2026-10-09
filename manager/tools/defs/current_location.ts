import type { ToolDefinition } from "../types.ts";
import { ROUTES } from "../../../contracts/src/http.ts";
import type { LocationResponse } from "../../../contracts/src/genui/spec.ts";
import { safeStringify } from "../../../infra/src/util/json.ts";
import { areaLine, callDaemon, formatAccuracy, formatAge } from "./geo_shared.ts";

export const currentLocationDef: ToolDefinition = {
  name: "current_location",
  visibility: "orchestrator",
  inputSchema: {},
  handler: async (ctx) => {
    const loc = (await callDaemon(() => ctx.api("GET", ROUTES.location))) as LocationResponse;
    const where = areaLine(loc.area) || "Area unknown (no reverse-geocode answer)";
    const age = Number.isFinite(loc.at) ? formatAge(Math.max(0, Date.now() - loc.at)) : "time unknown";
    const head = `${where} · ${formatAccuracy(loc.accuracy)} · ${age}`;
    const out: LocationResponse = { lat: loc.lat, lon: loc.lon, accuracy: Math.round(loc.accuracy), at: loc.at };
    if (loc.area) out.area = loc.area;
    return `${head}\n${safeStringify(out)}`;
  },
};
