import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compileRule, ruleMatches, evaluatePolicy, type PolicyRule, type Policy } from "../policy.ts";

const compile = (rules: PolicyRule[]): Policy => {
  const compiled = rules.map((r, i) => compileRule(r, i, "<test>"))
    .filter((c): c is NonNullable<typeof c> => c !== null);
  return { default: "ask", ttlMs: 30000, rules: compiled };
};

describe("compileRule", () => {
  it("returns null for invalid regex in a field matcher", () => {
    const c = compileRule({ tool: "Bash", action: "deny", command: "([invalid" } as PolicyRule, 0, "x");
    assert.equal(c, null);
  });

  it("returns null for rewrite without rewriteFrom/rewriteTo", () => {
    const c = compileRule({ tool: "Bash", action: "rewrite" }, 0, "x");
    assert.equal(c, null);
  });

  it("returns null for rewrite with bad rewriteFrom regex", () => {
    const c = compileRule({ tool: "Bash", action: "rewrite", rewriteFrom: "([bad", rewriteTo: "x" }, 0, "x");
    assert.equal(c, null);
  });

  it("compiles a valid rule", () => {
    const c = compileRule({ tool: "Bash", action: "allow", command: "ls" }, 0, "x");
    assert.notEqual(c, null);
    assert.equal(c!.toolSet?.size, 1);
    assert.equal(c!.fieldMatchers.length, 1);
  });

  it("logs via the injected logger", () => {
    const logs: string[] = [];
    compileRule({ tool: "Bash", action: "deny", command: "([bad" } as PolicyRule, 5, "policy.yaml", (m) => logs.push(m));
    assert.equal(logs.length, 1);
    assert.match(logs[0], /rule 5.*policy\.yaml.*invalid regex/);
  });
});

describe("ruleMatches", () => {
  it("matches when tool is in tool list", () => {
    const c = compileRule({ tool: ["Bash", "Read"], action: "allow" }, 0, "x")!;
    assert.equal(ruleMatches(c, "Bash", {}), true);
    assert.equal(ruleMatches(c, "Read", {}), true);
    assert.equal(ruleMatches(c, "Edit", {}), false);
  });

  it("matches on field regex", () => {
    const c = compileRule({ tool: "Bash", action: "deny", command: "^rm\\s" } as PolicyRule, 0, "x")!;
    assert.equal(ruleMatches(c, "Bash", { command: "rm -rf /" }), true);
    assert.equal(ruleMatches(c, "Bash", { command: "ls -la" }), false);
  });

  it("treats missing input field as empty string", () => {
    const c = compileRule({ tool: "Bash", action: "deny", command: ".+" } as PolicyRule, 0, "x")!;
    assert.equal(ruleMatches(c, "Bash", {}), false); // empty string doesn't match .+
  });
});

describe("evaluatePolicy", () => {
  it("returns allow when matching allow rule fires", () => {
    const p = compile([{ tool: "Read", action: "allow" }]);
    const d = evaluatePolicy(p, "Read", {});
    assert.equal(d.behavior, "allow");
  });

  it("returns deny with rule reason", () => {
    const p = compile([{ tool: "Bash", action: "deny", reason: "nope", command: "^rm" } as PolicyRule]);
    const d = evaluatePolicy(p, "Bash", { command: "rm -rf /" });
    assert.equal(d.behavior, "deny");
    assert.equal((d as { message: string }).message, "nope");
  });

  it("falls through to next rule when first does not match", () => {
    const p = compile([
      { tool: "Edit", action: "allow" },
      { tool: "Bash", action: "deny", reason: "block bash" },
    ]);
    const d = evaluatePolicy(p, "Bash", {});
    assert.equal(d.behavior, "deny");
  });

  it("applies default=allow when no rules match", () => {
    const p: Policy = { ...compile([{ tool: "Read", action: "allow" }]), default: "allow" };
    const d = evaluatePolicy(p, "Bash", {});
    assert.equal(d.behavior, "allow");
  });

  it("applies default=deny when no rules match", () => {
    const p: Policy = { ...compile([]), default: "deny" };
    const d = evaluatePolicy(p, "Bash", {});
    assert.equal(d.behavior, "deny");
  });

  it("returns ask when no rules match and default=ask", () => {
    const p: Policy = { ...compile([]), default: "ask" };
    const d = evaluatePolicy(p, "Bash", {});
    assert.equal(d.behavior, "ask");
  });

  it("rewrite rule produces updated input", () => {
    const p = compile([{
      tool: "Bash",
      action: "rewrite",
      command: "(^|\\s)curl(?!.*--max-time)",
      rewriteField: "command",
      rewriteFrom: "(^|\\s)curl\\b",
      rewriteTo: "$1curl --max-time 10",
    } as PolicyRule]);
    const d = evaluatePolicy(p, "Bash", { command: "curl https://example.com" });
    assert.equal(d.behavior, "allow");
    if (d.behavior === "allow") {
      assert.equal(d.updatedInput.command, "curl --max-time 10 https://example.com");
    }
  });

  it("invalid regex never reaches evaluatePolicy (compileRule drops it)", () => {
    // If compile drops the malformed rule, the policy has zero rules and falls
    // through to default — proving that runtime is shielded from bad regex.
    const p = compile([
      { tool: "Bash", action: "deny", command: "([invalid" } as PolicyRule,
      { tool: "Bash", action: "allow" },
    ]);
    assert.equal(p.rules.length, 1);
    const d = evaluatePolicy(p, "Bash", { command: "anything" });
    assert.equal(d.behavior, "allow");
  });
});
