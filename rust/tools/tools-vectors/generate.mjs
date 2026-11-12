#!/usr/bin/env node
// Writes rust/fixtures/tools: what today's TypeScript tool registry gives
// agents, so the Rust port (crates/eos-tools) can be held to it.
//
//   node rust/tools/tools-vectors/generate.mjs            write
//   node rust/tools/tools-vectors/generate.mjs --check    fail when it would change
//
// Needs Node ≥ 23.6 (runs the .ts sources directly) and `npm install` in this
// folder: zod, zod-to-json-schema and the MCP SDK at the versions
// manager/package-lock.json pins. Every `zod` import of the sources is
// resolved to this folder's copy, so no other package needs an install.
//
// registry.json    every tool (name, input JSON Schema, alwaysLoad, searchHint,
//                  plugin), and the ordered tool list of each kind of session
//                  with built-in plugins on and off (sdkToolDefs).
// validation.json  inputs through the MCP server the SDK lane registers tools
//                  on: what the handler receives (defaults filled, unknown keys
//                  dropped) or the error text the model reads.
// handlers.json    each handler run over scripted daemon answers: the calls it
//                  makes and the text it hands the model.
//
// seeded.json      the handlers that read worker rows and transcripts, over what the
//                  daemon answered for the seeded data folder (fixtures/wire).
// datetime.json    the date and time current_datetime answers, for a clock and a zone.
//
// Descriptions are not written here: rust/fixtures/prompts/library.json
// (tools/prompt-vectors) already holds every `tool/<name>` rendered.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../..");
const OUT = path.join(REPO, "rust/fixtures/tools");
const local = (spec) => pathToFileURL(path.join(HERE, "node_modules", spec)).href;
const STUB = "data:text/javascript,export const createSdkMcpServer=()=>({});export const tool=()=>({});";
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "zod") return { url: local("zod/index.js"), shortCircuit: true };
    if (specifier === "zod-to-json-schema") return { url: local("zod-to-json-schema/dist/esm/index.js"), shortCircuit: true };
    // The SDK lane's module is read for sdkToolDefs only; the agent SDK itself is not needed.
    if (specifier === "@anthropic-ai/claude-agent-sdk") return { url: STUB, shortCircuit: true };
    return next(specifier, context);
  },
});
const load = (rel) => import(pathToFileURL(path.join(REPO, rel)).href);

const { orchestratorDefs, workerDefs, peerDefs, focusedDefs } = await load("manager/tools/registry.ts");
const { toolJsonSchema, mcpServerForRole, prefixedToolName } = await load("manager/tools/projections.ts");
const { sdkToolDefs } = await load("manager/backends/sdk/SdkToolHost.ts");
const { BUILTIN_PLUGINS } = await load("contracts/src/builtin-plugins.ts");
const { McpServer } = await import(local("@modelcontextprotocol/sdk/dist/esm/server/mcp.js"));
const { Client } = await import(local("@modelcontextprotocol/sdk/dist/esm/client/index.js"));
const { InMemoryTransport } = await import(local("@modelcontextprotocol/sdk/dist/esm/inMemory.js"));

// ---- the registry ---------------------------------------------------------------

const all = new Map();
for (const def of [...orchestratorDefs, ...workerDefs, ...peerDefs, ...focusedDefs]) all.set(def.name, def);

const tools = [...all.values()].map((def) => ({
  name: def.name,
  inputSchema: toolJsonSchema(def),
  alwaysLoad: def.alwaysLoad === true,
  searchHint: def.searchHint ?? null,
  plugin: def.plugin ?? null,
}));

const deps = { orchestratorDefs, workerDefs, peerDefs, focusedDefs };
const pluginIds = Object.values(BUILTIN_PLUGINS);
const PLUGINS_OFF = [[], [BUILTIN_PLUGINS.browser], [BUILTIN_PLUGINS.pages], pluginIds, [BUILTIN_PLUGINS.pages, "user.thing"]];
const KINDS = [
  { kind: "orchestrator", isOrchestrator: true, collaborate: false, focused: false },
  { kind: "worker", isOrchestrator: false, collaborate: false, focused: false },
  { kind: "peer", isOrchestrator: false, collaborate: true, focused: false },
  { kind: "focused", isOrchestrator: false, collaborate: false, focused: true },
  { kind: "focused-peer", isOrchestrator: false, collaborate: true, focused: true },
];
const sets = [];
for (const k of KINDS) {
  for (const off of PLUGINS_OFF) {
    const server = mcpServerForRole(k.isOrchestrator);
    const names = sdkToolDefs({ ...deps, disabledPlugins: () => off }, k).map((d) => prefixedToolName(server, d.name));
    sets.push({ ...k, pluginsOff: off, names });
  }
}

// ---- input validation -----------------------------------------------------------

// A value the schema accepts, from the JSON Schema alone: required keys only.
function sample(schema) {
  if (schema.anyOf) return sample(schema.anyOf[0]);
  if (schema.enum) return schema.enum[0];
  switch (schema.type) {
    case "string": return "x".repeat(Math.max(1, schema.minLength ?? 1));
    case "integer":
    case "number": return schema.minimum ?? (schema.exclusiveMinimum !== undefined ? schema.exclusiveMinimum + 1 : 1);
    case "boolean": return true;
    case "array": return Array.from({ length: Math.max(1, schema.minItems ?? 1) }, () => sample(schema.items ?? {}));
    case "object": {
      const out = {};
      for (const key of schema.required ?? []) out[key] = sample(schema.properties[key]);
      return out;
    }
    default: return { any: "thing" };
  }
}

// Values the schema refuses (or, for a few, accepts: the recording tells), each with a label.
function wrong(schema) {
  const out = [];
  if (schema.anyOf) {
    out.push(["union:number", 5], ["union:empty-object", {}], ["union:null", null]);
    return out;
  }
  if (schema.enum) out.push(["enum:other", "no-such-value"], ["enum:number", 3]);
  switch (schema.type) {
    case "string":
      out.push(["string:number", 7], ["string:null", null], ["string:array", ["a"]], ["string:object", {}], ["string:boolean", true]);
      if (schema.minLength !== undefined) out.push(["string:short", "x".repeat(schema.minLength - 1)]);
      if (schema.maxLength !== undefined) out.push(["string:long", "x".repeat(schema.maxLength + 1)]);
      break;
    case "integer":
    case "number":
      out.push(["number:string", "5"], ["number:null", null], ["number:boolean", false]);
      if (schema.type === "integer") out.push(["number:float", 2.5]);
      if (schema.minimum !== undefined) out.push(["number:low", schema.minimum - 1]);
      if (schema.exclusiveMinimum !== undefined) out.push(["number:low", schema.exclusiveMinimum]);
      if (schema.maximum !== undefined) out.push(["number:high", schema.maximum + 1]);
      break;
    case "boolean":
      out.push(["boolean:string", "true"], ["boolean:number", 1], ["boolean:null", null]);
      break;
    case "array":
      out.push(["array:string", "a"], ["array:object", {}], ["array:null", null]);
      if (schema.minItems !== undefined) out.push(["array:few", Array.from({ length: schema.minItems - 1 }, () => sample(schema.items ?? {}))]);
      if (schema.maxItems !== undefined) out.push(["array:many", Array.from({ length: schema.maxItems + 1 }, () => sample(schema.items ?? {}))]);
      for (const [label, bad] of wrong(schema.items ?? {}).slice(0, 4)) out.push([`item:${label}`, [sample(schema.items ?? {}), bad]]);
      break;
    case "object":
      if (schema.properties) {
        out.push(["object:string", "a"], ["object:array", []], ["object:null", null], ["object:empty", {}]);
        for (const [key, sub] of Object.entries(schema.properties)) {
          for (const [label, bad] of wrong(sub).slice(0, 3)) out.push([`${key}:${label}`, { ...sample(schema), [key]: bad }]);
        }
      } else {
        out.push(["record:string", "a"], ["record:array", [1]], ["record:null", null], ["record:number", 4]);
      }
      break;
    default:
      break;
  }
  return out;
}

function cases(schema) {
  const good = sample(schema);
  const list = [
    ["valid", good],
    ["valid+unknown-key", { ...good, zz_unknown: 1 }],
    ["empty", {}],
  ];
  // Every optional key filled too.
  const full = { ...good };
  for (const [key, sub] of Object.entries(schema.properties ?? {})) full[key] = sample(sub);
  list.push(["every-key", full]);
  for (const [key, sub] of Object.entries(schema.properties ?? {})) {
    for (const [label, bad] of wrong(sub)) list.push([`${key}=${label}`, { ...good, [key]: bad }]);
    if ((schema.required ?? []).includes(key)) {
      const without = { ...good };
      delete without[key];
      list.push([`${key}=missing`, without]);
    }
  }
  // Two things wrong at once: the order issues are listed in.
  const keys = Object.keys(schema.properties ?? {});
  if (keys.length >= 2) {
    const twice = { ...good };
    for (const key of keys.slice(0, 3)) {
      const bad = wrong(schema.properties[key])[0];
      if (bad) twice[key] = bad[1];
    }
    list.push(["several-wrong", twice]);
  }
  return list;
}

const received = new Map();
const server = new McpServer({ name: "worker", version: "1.0.0" });
for (const def of all.values()) {
  server.registerTool(def.name, { inputSchema: def.inputSchema }, async (args) => {
    received.set(def.name, args);
    return { content: [{ type: "text", text: "ok" }] };
  });
}
const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: "vectors", version: "1.0.0" });
await Promise.all([server.connect(serverSide), client.connect(clientSide)]);

const validation = [];
for (const tool of tools) {
  for (const [label, input] of cases(tool.inputSchema)) {
    received.delete(tool.name);
    const res = await client.callTool({ name: tool.name, arguments: input });
    const text = res.content?.[0]?.text ?? "";
    validation.push(res.isError
      ? { tool: tool.name, case: label, input, error: text }
      : { tool: tool.name, case: label, input, parsed: received.get(tool.name) });
  }
}
await client.close();

// ---- handlers -----------------------------------------------------------------

const { HANDLER_CASES } = await import("./handler-cases.mjs");
const handlers = [];
for (const c of HANDLER_CASES) {
  const def = all.get(c.tool);
  if (!def) throw new Error(`no tool ${c.tool}`);
  const script = [...(c.api ?? [])];
  const calls = [];
  const ctx = {
    selfId: c.selfId ?? "w-self0001",
    cwd: c.cwd ?? "/repo/app",
    isGitRepo: () => c.gitRepo ?? true,
    async api(method, apiPath, body) {
      calls.push(body === undefined ? { method, path: apiPath } : { method, path: apiPath, body });
      const next = script.shift();
      if (!next) throw new Error(`unscripted call ${method} ${apiPath} in ${c.tool}/${c.name}`);
      const status = next.status ?? 200;
      // What daemonApi does with a refusal (manager/shared/http.ts).
      if (status < 200 || status >= 300) throw new Error(`daemon ${status}: ${JSON.stringify(next.body)}`);
      return next.body;
    },
  };
  const realNow = Date.now;
  const realTimeout = globalThis.setTimeout;
  let now = c.now;
  if (c.now !== undefined) Date.now = () => (now += c.tick ?? 0);
  // The polling tools wait between reads; the script answers at once.
  globalThis.setTimeout = (fn, _ms, ...rest) => realTimeout(fn, 0, ...rest);
  let result;
  try {
    // The MCP server parses the input first: defaults filled, unknown keys dropped.
    const { z } = await import(local("zod/index.js"));
    const args = z.object(def.inputSchema).parse(c.args ?? {});
    const res = await def.handler(ctx, args);
    result = { text: typeof res === "string" ? res : JSON.stringify(res, null, 2), isError: false };
  } catch (e) {
    result = { text: e instanceof Error ? e.message : String(e), isError: true };
  } finally {
    Date.now = realNow;
    globalThis.setTimeout = realTimeout;
  }
  if (script.length) throw new Error(`${c.tool}/${c.name}: ${script.length} scripted answers were never asked for`);
  handlers.push({ tool: c.tool, name: c.name, selfId: ctx.selfId, cwd: ctx.cwd, gitRepo: c.gitRepo ?? true, ...(c.now !== undefined ? { now: c.now } : {}), args: c.args ?? {}, api: c.api ?? [], calls, result });
}

// ---- handlers over the recorded wire ---------------------------------------------

// The tools that read worker rows and transcripts, fed what today's daemon
// answered for the seeded data folder (rust/fixtures/wire/recordings): the Rust
// tools read the same seed from the database.
const recorded = (scenario, step) => {
  const file = path.join(REPO, "rust/fixtures/wire/recordings", `${scenario}.json`);
  const text = readFileSync(file, "utf8").replaceAll("{sandbox}", "/sandbox");
  const found = JSON.parse(text).exchanges.find((e) => e.step.name === step);
  if (!found) throw new Error(`${scenario} has no step ${step}`);
  return found.response;
};
// A recording sorts keys; the route writes a row's context as { used, limit, pct } (withContext).
const routeOrder = (row) => (row?.context ? { ...row, context: { used: row.context.used, limit: row.context.limit, pct: row.context.pct } } : row);
const answer = (res) => ({ status: res.status, body: Array.isArray(res.json) ? res.json.map(routeOrder) : routeOrder(res.json) });
// ?order=desc&limit=N answers the newest N rows, oldest first.
const newest = (res, n) => ({ status: 200, body: res.json.slice(-n) });
const pendingAsk = { id: "p-ask00001", worker_id: "w-KID2", tool_name: "Bash", input: "{\"command\":\"rm -rf build\"}", created_at: 1790000300000, expires_at: 1790000600000, resolved: 0, decision: null, reason: null };

const SEEDED_CASES = [
  { tool: "list_active_workers", name: "an orchestrator's workers", selfId: "o-ORCH", args: {}, api: [answer(recorded("11-chats", "list-children"))] },
  { tool: "get_worker", name: "its own worker", selfId: "o-ORCH", args: { id: "w-KID2" }, api: [answer(recorded("11-chats", "row-child-as-parent"))] },
  { tool: "get_worker", name: "someone else's worker", selfId: "w-KID2", args: { id: "w-BUSY" }, api: [answer(recorded("11-chats", "row-foreign-actor"))] },
  { tool: "get_worker", name: "an archived worker", selfId: "w-ARCH", args: { id: "w-ARCH" }, api: [answer(recorded("11-chats", "row-archived-for-agent"))] },
  { tool: "get_worker_messages", name: "the last five", selfId: "o-ORCH", args: { id: "w-CHAT" }, api: [newest(recorded("12-transcript", "full-transcript"), 40)] },
  { tool: "get_worker_messages", name: "the last two of a long chat", selfId: "o-ORCH", args: { id: "w-LONG", n: 2 }, api: [newest(recorded("12-transcript", "default-page"), 16)] },
  { tool: "get_worker_messages", name: "nothing said", selfId: "o-ORCH", args: { id: "w-nope0000", n: 50 }, api: [{ status: 200, body: [] }] },
  { tool: "list_pending_permissions", name: "one ask", selfId: "o-ORCH", args: {}, api: [{ status: 200, body: [pendingAsk] }], pending: pendingAsk },
  { tool: "list_pending_permissions", name: "none", selfId: "w-KID2", args: {}, api: [{ status: 200, body: [] }] },
];
const seeded = [];
for (const c of SEEDED_CASES) {
  const def = all.get(c.tool);
  const script = [...c.api];
  const calls = [];
  const ctx = {
    selfId: c.selfId, cwd: "/sandbox/alpha", isGitRepo: () => false,
    async api(method, apiPath) {
      calls.push({ method, path: apiPath });
      const next = script.shift();
      if (next.status < 200 || next.status >= 300) throw new Error(`daemon ${next.status}: ${JSON.stringify(next.body)}`);
      return next.body;
    },
  };
  let result;
  try {
    const { z } = await import(local("zod/index.js"));
    const res = await def.handler(ctx, z.object(def.inputSchema).parse(c.args));
    result = { text: typeof res === "string" ? res : JSON.stringify(res, null, 2), isError: false };
  } catch (e) {
    result = { text: e instanceof Error ? e.message : String(e), isError: true };
  }
  seeded.push({ tool: c.tool, name: c.name, selfId: c.selfId, args: c.args, ...(c.pending ? { pending: c.pending } : {}), calls, result });
}

// ---- the date and time ----------------------------------------------------------

const { currentDateTime } = await load("core/src/use-cases/CurrentDateTime.ts");
const datetime = [
  [1800000000000, "Europe/Istanbul", 180],
  [1800000000123, "UTC", 0],
  [1767225599999, "America/St_Johns", -150],
  [951782400000, "Asia/Kolkata", 330],
  [0, "Pacific/Kiritimati", 840],
  [1709251199000, "America/Los_Angeles", -480],
].map(([epochMs, name, offsetMinutes]) => ({
  epochMs, name, offsetMinutes,
  result: currentDateTime({ now: () => epochMs }, { name: () => name, offsetMinutesAt: () => offsetMinutes }),
}));

// ---- write --------------------------------------------------------------------

const files = {
  "registry.json": { tools, sets },
  "validation.json": validation,
  "handlers.json": handlers,
  "seeded.json": seeded,
  "datetime.json": datetime,
};
const check = process.argv.includes("--check");
let stale = false;
mkdirSync(OUT, { recursive: true });
for (const [name, value] of Object.entries(files)) {
  const file = path.join(OUT, name);
  const text = `${JSON.stringify(value, null, 1)}\n`;
  if (check) {
    if (!existsSync(file) || readFileSync(file, "utf8") !== text) {
      console.error(`stale: ${path.relative(REPO, file)}`);
      stale = true;
    }
  } else {
    writeFileSync(file, text);
    console.log(`wrote ${path.relative(REPO, file)} (${text.length} bytes)`);
  }
}
if (stale) process.exit(1);
