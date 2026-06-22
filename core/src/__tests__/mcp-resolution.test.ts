import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveMcpServers,
  isFilterActive,
  type AgentMcpConfig,
} from "../domain/mcp-resolution.ts";

const INHERIT_ALL: AgentMcpConfig = { inheritDefaults: true, include: ["*"], exclude: [], extra: {} };
const inherited = { context7: { command: "c7" }, gmail: { command: "gm" } };
const builtins = { gateway: { command: "bun" }, worker: { command: "node" } };

describe("isFilterActive", () => {
  it("is false for the inherit-all default", () => {
    assert.equal(isFilterActive(INHERIT_ALL), false);
  });
  it("is true when include narrows", () => {
    assert.equal(isFilterActive({ ...INHERIT_ALL, include: ["context7"] }), true);
  });
  it("is true when exclude is non-empty", () => {
    assert.equal(isFilterActive({ ...INHERIT_ALL, exclude: ["gmail"] }), true);
  });
  it("is true when defaults are disabled", () => {
    assert.equal(isFilterActive({ ...INHERIT_ALL, inheritDefaults: false }), true);
  });
});

describe("resolveMcpServers — additive (no filter)", () => {
  it("emits only builtins + extra and leaves inheritance to claude (strict=false)", () => {
    const { servers, strict } = resolveMcpServers({ inherited, builtins, config: INHERIT_ALL });
    assert.equal(strict, false);
    assert.deepEqual(Object.keys(servers).sort(), ["gateway", "worker"]);
    assert.equal("context7" in servers, false); // claude discovers these natively
  });

  it("includes user-defined extra servers", () => {
    const cfg: AgentMcpConfig = { ...INHERIT_ALL, extra: { playwright: { command: "pw" } } };
    const { servers, strict } = resolveMcpServers({ inherited, builtins: {}, config: cfg });
    assert.equal(strict, false);
    assert.deepEqual(Object.keys(servers), ["playwright"]);
  });

  it("returns an empty additive map when nothing of ours to add", () => {
    const { servers, strict } = resolveMcpServers({ inherited, builtins: {}, config: INHERIT_ALL });
    assert.equal(strict, false);
    assert.deepEqual(servers, {});
  });
});

describe("resolveMcpServers — strict (filter active)", () => {
  it("include allowlist keeps only named inherited + builtins (strict=true)", () => {
    const cfg: AgentMcpConfig = { ...INHERIT_ALL, include: ["context7"] };
    const { servers, strict } = resolveMcpServers({ inherited, builtins, config: cfg });
    assert.equal(strict, true);
    assert.deepEqual(Object.keys(servers).sort(), ["context7", "gateway", "worker"]);
  });

  it("exclude drops the named inherited server", () => {
    const cfg: AgentMcpConfig = { ...INHERIT_ALL, exclude: ["gmail"] };
    const { servers } = resolveMcpServers({ inherited, builtins: {}, config: cfg });
    assert.deepEqual(Object.keys(servers), ["context7"]);
  });

  it("inheritDefaults=false drops every inherited server but keeps builtins+extra", () => {
    const cfg: AgentMcpConfig = { inheritDefaults: false, include: ["*"], exclude: [], extra: { x: { command: "x" } } };
    const { servers, strict } = resolveMcpServers({ inherited, builtins, config: cfg });
    assert.equal(strict, true);
    assert.deepEqual(Object.keys(servers).sort(), ["gateway", "worker", "x"]);
  });

  it("builtins win over an inherited/extra server of the same name", () => {
    const cfg: AgentMcpConfig = { ...INHERIT_ALL, include: ["gateway"], extra: { gateway: { command: "evil" } } };
    const { servers } = resolveMcpServers({
      inherited: { gateway: { command: "inherited" } },
      builtins: { gateway: { command: "real" } },
      config: cfg,
    });
    assert.deepEqual(servers.gateway, { command: "real" });
  });
});

// The claude-sdk lane runs with settingSources:[] so the binary discovers no MCP
// scopes itself — nativeDiscovery:false makes the resolver materialize the
// inherited set instead of relying on a discovery that lane lacks.
describe("resolveMcpServers — nativeDiscovery:false (claude-sdk lane)", () => {
  it("materializes inherited + builtins under the inherit-all default (NOT the additive omit)", () => {
    const { servers, strict } = resolveMcpServers({ inherited, builtins, config: INHERIT_ALL, nativeDiscovery: false });
    assert.equal(strict, true);
    assert.deepEqual(Object.keys(servers).sort(), ["context7", "gateway", "gmail", "worker"]);
  });

  it("builtins still win on name collision", () => {
    const { servers } = resolveMcpServers({
      inherited: { gateway: { command: "inherited" } },
      builtins: { gateway: { command: "real" } },
      config: INHERIT_ALL,
      nativeDiscovery: false,
    });
    assert.deepEqual(servers.gateway, { command: "real" });
  });

  it("honors include/exclude/inheritDefaults like the strict path", () => {
    const { servers } = resolveMcpServers({ inherited, builtins: {}, config: { ...INHERIT_ALL, exclude: ["gmail"] }, nativeDiscovery: false });
    assert.deepEqual(Object.keys(servers), ["context7"]);
    const off = resolveMcpServers({ inherited, builtins, config: { ...INHERIT_ALL, inheritDefaults: false }, nativeDiscovery: false });
    assert.deepEqual(Object.keys(off.servers).sort(), ["gateway", "worker"]);
  });

  it("regression: omitting nativeDiscovery leaves the cli additive behavior unchanged", () => {
    const { servers, strict } = resolveMcpServers({ inherited, builtins, config: INHERIT_ALL });
    assert.equal(strict, false);
    assert.deepEqual(Object.keys(servers).sort(), ["gateway", "worker"]);
  });
});
