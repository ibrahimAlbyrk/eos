// Whole phone sessions against today's gateway, run as a library: the real
// GatewayConnection, WsBridge, StatePatcher, LiveText and tier table, with a
// scripted bus, scripted route answers and scripted phones. The Rust gateway
// replays the same steps and must hand each phone the same frames.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inflateRawSync } from "node:zlib";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../..");
const load = (rel) => import(pathToFileURL(path.join(REPO, rel)).href);

const NOW = 1731400000000;
const ROOM = "Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXV4";
const DEVICES = { A: "a1".repeat(16), B: "b2".repeat(16) };
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const lorem = (n) => "the quick brown fox jumps over the lazy dog ".repeat(Math.ceil(n / 44)).slice(0, n);

const control = (n, method, target, body) => ({
  t: "control", correlationId: uuid(n), method, path: target, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

// A route answer: { status, body } (JSON), { status, text, type } or { status, base64, type }.
// `slowMs` holds the answer back, to prove what is ordered and what is not.
const BASE_ROUTES = {
  "GET /workers": { status: 200, body: [{ id: "w1", name: "One", state: "IDLE" }, { id: "w2", name: "Two", state: "WORKING" }] },
  "GET /pending": { status: 200, body: [{ id: "p1", workerId: "w1", tool: "Bash" }] },
  "GET /pty": { status: 200, body: { sessions: [{ sessionId: "pty1", title: "zsh" }] } },
  "GET /api/ui-config": { status: 200, body: { features: { remote: true, posixShell: true }, theme: "dark" } },
};

const SCENARIOS = [
  {
    name: "join, hello and controls",
    about: "The snapshot on join, the first hello riding it, replies, an asset, refusals, a bad body, what the audit log keeps.",
    routes: {
      ...BASE_ROUTES,
      "GET /workers/w1": { status: 200, body: { id: "w1", name: "One", state: "IDLE" } },
      "GET /workers/w1/events?limit=2&order=desc": { status: 200, body: [{ id: 9, type: "assistant", payload: "{\"text\":\"hi\"}" }, { id: 8, type: "user", payload: "{\"text\":\"yo\"}" }] },
      "POST /workers/w1/message": { status: 202, body: { queued: false, messageId: "m-1" } },
      "POST /workers/gone/message": { status: 404, body: { error: "worker not found: gone" } },
      "PUT /workers/w1/permission": { status: 403, body: { error: "not allowed" } },
      "POST /workers/w1/interrupt": { status: 500, body: { error: "boom" } },
      "GET /fs/image?path=%2Ftmp%2Fa.png": { status: 200, base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", type: "image/png" },
      "GET /fs/read?path=%2Ftmp%2Fnotes.txt": { status: 200, body: { content: "line one\nline two\n", truncated: false } },
      "GET /health": { status: 200, text: "", type: "application/json" },
      "POST /pty": { status: 201, body: { sessionId: "pty2" } },
    },
    steps: [
      { join: "A" },
      { phone: "A", frame: { t: "hello", lastContentId: 0, caps: ["focus", "rows"] } },
      { phone: "A", frame: control(1, "GET", "/workers") },
      { phone: "A", frame: control(2, "GET", "/workers/w1/events?limit=2&order=desc") },
      { phone: "A", frame: control(3, "POST", "/workers/w1/message", { text: "hello there" }) },
      { phone: "A", frame: control(4, "POST", "/workers/gone/message", { text: "x" }) },
      { phone: "A", frame: control(5, "PUT", "/workers/w1/permission", { mode: "plan" }) },
      { phone: "A", frame: control(6, "POST", "/workers/w1/interrupt") },
      { phone: "A", frame: control(7, "GET", "/fs/image?path=%2Ftmp%2Fa.png") },
      { phone: "A", frame: control(8, "GET", "/fs/read?path=%2Ftmp%2Fnotes.txt") },
      { phone: "A", frame: control(9, "POST", "/policy/decide", { tool: "Bash" }) },
      { phone: "A", frame: control(10, "GET", "/stream") },
      { phone: "A", frame: control(11, "DELETE", "/api/remote/config") },
      { phone: "A", frame: { ...control(12, "POST", "/workers/w1/message"), body: "{not json" } },
      { phone: "A", frame: control(13, "GET", "/health") },
      { phone: "A", frame: control(14, "POST", "/pty", { cwd: "/tmp" }) },
      { phone: "A", frame: { t: "ka", ts: 0 } },
      { phone: "A", frame: { t: "control", correlationId: "nope", method: "GET", path: "/workers" } },
      { phone: "A", raw: "not json at all" },
      { phone: "A", frame: { t: "hello", lastContentId: 3, caps: ["focus", "rows"] } },
      { leave: "A" },
    ],
  },
  {
    name: "events, focus and pushed rows",
    about: "Everything until the phone says what it shows; then the open worker's live events, its rows and live text; another Mac on screen gets patches only.",
    routes: {
      ...BASE_ROUTES,
      "GET /workers/w1/events?afterId=5&limit=500": { status: 200, body: [{ id: 6, type: "user" }, { id: 7, type: "assistant" }] },
      "GET /workers/w1/events?afterId=7&limit=500": { status: 200, body: [{ id: 8, type: "tool_use" }] },
      "GET /workers/w1/events?afterId=8&limit=500": { status: 200, body: [] },
      "GET /workers/w2/events?afterId=40&limit=500": { status: 200, body: [{ id: 41, type: "assistant" }] },
      "GET /workers/w2/events?afterId=41&limit=500": { status: 200, body: [] },
    },
    steps: [
      { join: "A" },
      { publish: "fs:change", payload: { dir: "/x" } },
      { publish: "agent:delta", payload: { workerId: "w1", blockId: "b1", channel: "text", phase: "start", text: "so" } },
      { publish: "agent:delta", payload: { workerId: "w1", blockId: "b1", channel: "text", phase: "append", text: " far" } },
      { publish: "agent:delta", payload: { workerId: "w2", blockId: "c1", channel: "reasoning", phase: "append", text: "hm" } },
      { phone: "A", frame: { t: "hello", caps: ["focus", "rows"] } },
      { phone: "A", frame: { t: "focus", active: true, worker: "w1", afterId: 5 } },
      { publish: "agent:delta", payload: { workerId: "w1", blockId: "b1", channel: "text", phase: "append", text: "!" } },
      { publish: "agent:delta", payload: { workerId: "w2", blockId: "c1", channel: "reasoning", phase: "append", text: "?" } },
      { publish: "worker:change", payload: { workerId: "w1" } },
      { publish: "worker:change", payload: { workerId: "w2" } },
      { publish: "git:change", payload: { dir: "/x" } },
      { publish: "terminal:chunk", payload: { workerId: "w1", runId: "r1", data: "ls\n" } },
      { publish: "terminal:done", payload: { workerId: "w2", runId: "r2" } },
      { publish: "pty:session", payload: { sessionId: "pty1" } },
      { publish: "pty:exit", payload: { sessionId: "pty1" } },
      { publish: "pty:conversation", payload: { sessionId: "pty1" } },
      { publish: "state:patch", payload: { changes: [] } },
      { phone: "A", frame: { t: "focus", active: true, worker: "w2", afterId: null, pty: "pty1" } },
      { publish: "pty:conversation", payload: { sessionId: "pty1" } },
      { publish: "pty:conversation", payload: { sessionId: "pty9" } },
      { phone: "A", frame: { t: "focus", active: true, worker: "w2", afterId: 40, pty: "pty1" } },
      { publish: "agent:delta", payload: { workerId: "w2", blockId: "c1", channel: "reasoning", phase: "stop" } },
      { phone: "A", frame: { t: "hello", lastContentId: 0, caps: ["focus", "rows"] } },
      { phone: "A", frame: { t: "focus", active: false } },
      { publish: "agent:delta", payload: { workerId: "w2", blockId: "c2", channel: "text", phase: "start", text: "x" } },
      { publish: "pty:session", payload: { sessionId: "pty1" } },
      { publish: "worker:exit", payload: { workerId: "w2" } },
      { phone: "A", frame: { t: "focus", active: true, worker: "w2", afterId: 41 } },
      { leave: "A" },
    ],
  },
  {
    name: "row patches",
    about: "Change topics become one patch per changed row, read from the list routes; nothing is read while no phone is connected.",
    routes: { ...BASE_ROUTES },
    steps: [
      { publish: "worker:change", payload: { workerId: "w1" } },
      { join: "A" },
      { publish: "worker:change", payload: { workerId: "w1" } },
      { route: "GET /workers", answer: { status: 200, body: [{ id: "w1", name: "One", state: "WORKING" }, { id: "w3", name: "Three", state: "IDLE" }] } },
      { publish: "worker:spawn", payload: { workerId: "w3" }, hold: true },
      { publish: "worker:removed", payload: { workerId: "w2" }, hold: true },
      { publish: "usage:recorded", payload: { workerId: "w1" }, hold: true },
      { publish: "worker:change", payload: { state: "IDLE" } },
      { route: "GET /pending", answer: { status: 200, body: [{ id: "p2", workerId: "w3", tool: "Edit" }] } },
      { publish: "pending:created", payload: { id: "p2", workerId: "w3" }, hold: true },
      { publish: "pending:resolved", payload: { id: "p1", workerId: "w1" }, hold: true },
      { publish: "pending:ttl_expired", payload: { id: "p0", workerId: "w1" } },
      { phone: "A", frame: { t: "hello", lastContentId: 0 } },
      { phone: "A", frame: { t: "hello", lastContentId: 0 } },
      { leave: "A" },
      { publish: "worker:change", payload: { workerId: "w1" } },
    ],
  },
  {
    name: "two phones",
    about: "An event only some phones get does not take a new seq; terminal output goes to the phones showing that terminal; a deflate phone gets large frames packed.",
    routes: { ...BASE_ROUTES, "GET /workers/w1": { status: 200, body: { id: "w1", notes: lorem(3000) } } },
    steps: [
      { join: "A" },
      { join: "B" },
      { phone: "A", frame: { t: "hello", caps: ["focus", "deflate"] } },
      { phone: "B", frame: { t: "hello", caps: [] } },
      { publish: "fs:change", payload: { dir: "/both" } },
      { phone: "A", frame: { t: "focus", active: true, worker: "w1" } },
      { publish: "agent:delta", payload: { workerId: "w2", blockId: "c1", channel: "text", phase: "append", text: "only B" } },
      { publish: "agent:delta", payload: { workerId: "w1", blockId: "b1", channel: "text", phase: "append", text: "both" } },
      { publish: "fs:change", payload: { dir: "/only-b" } },
      { publish: "pty:data", payload: { sessionId: "pty1", seq: 1, data: "nobody" } },
      { phone: "B", frame: { t: "sub", pty: ["pty1"] } },
      { publish: "pty:data", payload: { sessionId: "pty1", seq: 2, data: "B sees this" } },
      { publish: "pty:data", payload: { sessionId: "pty2", seq: 1, data: "nobody" } },
      { phone: "A", frame: { t: "sub", pty: ["pty1", "pty2"] } },
      { phone: "B", frame: { t: "sub", pty: [] } },
      { publish: "pty:data", payload: { sessionId: "pty2", seq: 2, data: lorem(2000) } },
      { publish: "worker:change", payload: { workerId: "w1" } },
      { phone: "A", frame: control(1, "GET", "/workers/w1") },
      { phone: "B", frame: control(2, "GET", "/workers/w1") },
      { leave: "B" },
      { publish: "fs:change", payload: { dir: "/after-b-left" } },
      { leave: "A" },
    ],
  },
  {
    name: "terminal input keeps its order",
    about: "Keystrokes are written in arrival order although the first write is slow; other controls are not held behind them.",
    routes: {
      ...BASE_ROUTES,
      "POST /pty/pty1/input": { status: 200, body: {}, slowFirstMs: 60 },
      "POST /pty/pty1/input?x=1": { status: 200, body: {} },
      "GET /pty/pty1/buffer": { status: 200, body: { seq: 4, data: "$ " } },
    },
    steps: [
      { join: "A" },
      { phone: "A", frame: control(1, "POST", "/pty/pty1/input", { data: "a" }), hold: true },
      { phone: "A", frame: control(2, "POST", "/pty/pty1/input", { data: "b" }), hold: true },
      { phone: "A", frame: control(3, "GET", "/pty/pty1/buffer"), hold: true },
      { phone: "A", frame: control(4, "POST", "/pty/pty1/input?x=1", { data: "c" }) },
      { leave: "A" },
    ],
  },
];

async function runScenario(mods, scenario) {
  const { GatewayConnection, WsBridge, StatePatcher, bridgeSink, LiveText, RemoteAuditLog, classifyTier, env } = mods;
  const dir = mkdtempSync(path.join(tmpdir(), "eos-relay-vectors-"));
  const subs = new Map();
  const bus = {
    publish(topic, payload) {
      for (const fn of [...(subs.get(topic) ?? []), ...(subs.get("*") ?? [])]) fn({ topic, payload, ts: NOW });
    },
    subscribe(topic, fn) {
      subs.set(topic, [...(subs.get(topic) ?? []), fn]);
      return () => subs.set(topic, (subs.get(topic) ?? []).filter((f) => f !== fn));
    },
  };
  const now = () => NOW;
  const routes = { ...scenario.routes };
  const seen = new Map();
  const calls = [];
  const routeDispatch = async ({ method, path: target, body, uiToken }) => {
    const key = `${method} ${target}`;
    calls.push({ call: key, body, user: uiToken !== undefined });
    const answer = routes[key];
    // What makeRouteDispatch answers when the router has no such route.
    if (!answer) return { status: 404, body: { error: "not found", path: target } };
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    if (answer.slowFirstMs && count === 1) await new Promise((r) => setTimeout(r, answer.slowFirstMs));
    if (answer.base64 !== undefined) return { status: answer.status, binary: { mime: answer.type, bytes: Buffer.from(answer.base64, "base64") } };
    // The virtual response's text rule: JSON content, or text that looks like it, is parsed; an empty JSON body reads {}.
    if (answer.text !== undefined) return { status: answer.status, body: answer.text === "" ? {} : answer.text };
    return { status: answer.status, body: structuredClone(answer.body) };
  };

  const liveText = new LiveText(bus, now);
  liveText.start();
  const bridge = new WsBridge({ bus, now });
  bridge.start();
  const patcher = new StatePatcher({ bus, sink: bridgeSink(bridge), routeDispatch, debounceMs: 5 });
  patcher.start();
  const audit = new RemoteAuditLog(dir);
  const deps = { audit, uiToken: "UITOK", routeDispatch, classify: classifyTier, bus, room: ROOM, now, liveText };

  const conns = new Map();
  const received = Object.fromEntries(Object.keys(DEVICES).map((d) => [d, []]));
  const mark = Object.fromEntries(Object.keys(DEVICES).map((d) => [d, 0]));
  const epoch = bridge.epoch();
  const record = (device, buf) => {
    const payload = env.parseEnvelope(buf).payload;
    const deflated = payload[0] === 0x01;
    const json = (deflated ? inflateRawSync(payload.subarray(1)) : payload).toString("utf8").replaceAll(epoch, "<epoch>");
    received[device].push({ json, deflated });
  };

  const steps = [];
  for (const step of scenario.steps) {
    if (step.join) {
      const clientId = Buffer.from(DEVICES[step.join], "hex");
      const conn = new GatewayConnection({
        deps, bridge, clientId, joinAck: false,
        send: (buf) => record(step.join, buf),
        close: () => { conns.get(step.join)?.dispose(); conns.delete(step.join); },
      });
      conns.set(step.join, conn);
      conn.start();
    } else if (step.leave) {
      conns.get(step.leave)?.dispose();
      conns.delete(step.leave);
    } else if (step.phone) {
      const payload = step.raw !== undefined ? Buffer.from(step.raw, "utf8") : Buffer.from(JSON.stringify(step.frame), "utf8");
      const clientId = Buffer.from(DEVICES[step.phone], "hex");
      conns.get(step.phone)?.onEnvelope(env.parseEnvelope(env.encodeEnvelope({ type: env.FrameType.data, dir: env.Dir.c2s, room: ROOM, clientId, payload })));
    } else if (step.publish) {
      bus.publish(step.publish, structuredClone(step.payload));
    } else if (step.route) {
      routes[step.route] = step.answer;
    }
    // `hold`: the next step follows at once, inside the same burst.
    if (!step.hold) await new Promise((r) => setTimeout(r, step.phone && scenario.name.startsWith("terminal") ? 150 : 40));
    const got = {};
    for (const device of Object.keys(DEVICES)) {
      const fresh = received[device].slice(mark[device]);
      mark[device] = received[device].length;
      if (fresh.length > 0) got[device] = fresh;
    }
    steps.push({ ...step, frames: got });
  }

  patcher.stop();
  liveText.stop();
  bridge.stop();
  const log = readAudit(dir);
  rmSync(dir, { recursive: true, force: true });
  return { name: scenario.name, about: scenario.about, routes: scenario.routes, steps, calls, audit: log };
}

function readAudit(dir) {
  try {
    return readFileSync(path.join(dir, "remote-audit.log"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

export async function runGatewayScenarios() {
  const gw = await load("manager/remote/gateway.ts");
  const { WsBridge } = await load("manager/remote/WsBridge.ts");
  const { StatePatcher, bridgeSink } = await load("manager/remote/patcher.ts");
  const { LiveText } = await load("manager/remote/LiveText.ts");
  const { RemoteAuditLog } = await load("manager/remote/audit.ts");
  const { classifyTier } = await load("manager/remote/tiers.ts");
  const env = await load("manager/remote/envelope.ts");
  const mods = { GatewayConnection: gw.GatewayConnection, WsBridge, StatePatcher, bridgeSink, LiveText, RemoteAuditLog, classifyTier, env };
  const scenarios = [];
  for (const scenario of SCENARIOS) scenarios.push(await runScenario(mods, scenario));
  return {
    about: "Sessions against the TypeScript gateway. A step is join/leave (a device), phone (a frame it sends; raw = bytes that are not a frame), publish (a bus event), route (a new answer); hold = the next step follows in the same burst. frames: what each device received before the next step, as the frame's JSON text (the bridge's random epoch written <epoch>) and whether it travelled deflated. calls: every route read, in order, and whether it carried the user's token. audit: the audit log at the end.",
    now: NOW, room: ROOM, uiToken: "UITOK", devices: DEVICES, patchDebounceMs: 5,
    scenarios,
  };
}
