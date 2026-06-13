import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { isTruthy, parseTemplate, renderTemplate } from "../services/template-engine.ts";
import { resolveVariables } from "../services/variable-resolve.ts";
import { parsePrompt } from "../services/prompt-parse.ts";
import { PromptRegistry } from "../services/PromptRegistry.ts";
import { PromptService } from "../services/PromptService.ts";
import { NotFoundError } from "../errors/index.ts";
import type { Logger } from "../ports/Logger.ts";
import type { PromptSource } from "../ports/PromptSource.ts";
import type { VariableProvider } from "../ports/VariableProvider.ts";
import type { RawPrompt } from "../domain/prompt.ts";

const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return noopLogger;
  },
};

function source(prompts: RawPrompt[]): PromptSource {
  return { list: () => prompts };
}

describe("parseTemplate", () => {
  it("splits literal text from interpolation", () => {
    const { nodes, referenced } = parseTemplate("Hello {{NAME}}!");
    assert.deepEqual(nodes, [
      { kind: "text", value: "Hello " },
      { kind: "interp", path: "NAME" },
      { kind: "text", value: "!" },
    ]);
    assert.deepEqual(referenced, ["NAME"]);
  });

  it("nests conditional blocks", () => {
    const { nodes } = parseTemplate("{{#if A}}X{{#unless B}}Y{{/unless}}{{/if}}");
    assert.equal(nodes.length, 1);
    const cond = nodes[0];
    assert.equal(cond.kind, "cond");
    if (cond.kind === "cond") {
      assert.equal(cond.path, "A");
      assert.equal(cond.negate, false);
      assert.equal(cond.body.length, 2); // text "X" + nested unless-cond
    }
  });

  it("collects referenced roots (dotted path → root name)", () => {
    const { referenced } = parseTemplate("{{GIT.BRANCH}} {{#if READY}}ok{{/if}}");
    assert.deepEqual(referenced.sort(), ["GIT", "READY"]);
  });
});

describe("renderTemplate", () => {
  const tpl = (s: string) => parseTemplate(s).nodes;

  it("interpolates and honors truthy conditionals", () => {
    assert.equal(renderTemplate(tpl("Hi {{NAME}}"), { NAME: "Eos" }), "Hi Eos");
    assert.equal(renderTemplate(tpl("{{#if X}}yes{{/if}}"), { X: true }), "yes");
    assert.equal(renderTemplate(tpl("{{#if X}}yes{{/if}}"), { X: false }), "");
    assert.equal(renderTemplate(tpl("{{#unless X}}no{{/unless}}"), { X: false }), "no");
  });

  it("renders missing/empty variables as empty string", () => {
    assert.equal(renderTemplate(tpl("[{{MISSING}}]"), {}), "[]");
  });

  it("treats empty string/array and 0/false as falsy", () => {
    assert.equal(isTruthy(""), false);
    assert.equal(isTruthy([]), false);
    assert.equal(isTruthy(0), false);
    assert.equal(isTruthy(false), false);
    assert.equal(isTruthy(["a"]), true);
    assert.equal(isTruthy("x"), true);
  });

  it("joins array values with newlines", () => {
    assert.equal(renderTemplate(tpl("{{ITEMS}}"), { ITEMS: ["a", "b"] }), "a\nb");
  });
});

describe("resolveVariables precedence", () => {
  it("local beats global", () => {
    const scope = resolveVariables({
      referenced: ["A", "B"],
      locals: { A: "LA" },
      globals: { A: "GA", B: "GB" },
    });
    assert.equal(scope.A, "LA");
    assert.equal(scope.B, "GB");
  });

  it("unresolved name → undefined (renders empty)", () => {
    const scope = resolveVariables({ referenced: ["X"], locals: {}, globals: {} });
    assert.equal(scope.X, undefined);
  });
});

describe("parsePrompt", () => {
  it("validates frontmatter and warns on undeclared variables", () => {
    const parsed = parsePrompt({
      id: "x",
      body: "{{DECLARED}} {{UNDECLARED}}",
      frontmatter: { variables: ["DECLARED"] },
    });
    assert.equal(parsed.frontmatter.variables.length, 1);
    assert.ok(parsed.warnings.some((w) => w.includes("UNDECLARED")));
  });

  it("warns on a non-uppercase declared variable", () => {
    const parsed = parsePrompt({ id: "y", body: "", frontmatter: { variables: ["lowercase"] } });
    assert.ok(parsed.warnings.some((w) => w.includes("UPPER_SNAKE")));
  });

  it("throws on invalid frontmatter shape", () => {
    assert.throws(() => parsePrompt({ id: "bad", body: "", frontmatter: { variables: "nope" } }));
  });
});

describe("PromptRegistry", () => {
  it("loads, gets, and skips unparseable prompts without throwing", () => {
    const reg = new PromptRegistry(
      source([
        { id: "ok", body: "hi", frontmatter: {} },
        { id: "bad", body: "", frontmatter: { variables: 5 } },
      ]),
      noopLogger,
    );
    assert.ok(reg.has("ok"));
    assert.equal(reg.has("bad"), false); // skipped, not fatal
    assert.throws(() => reg.get("missing"), NotFoundError);
  });

  it("exposes only prompts carrying a dpi block as fragments", () => {
    const reg = new PromptRegistry(
      source([
        { id: "plain", body: "", frontmatter: {} },
        { id: "frag", body: "", frontmatter: { dpi: { layer: "core" } } },
      ]),
      noopLogger,
    );
    const frags = reg.fragments();
    assert.equal(frags.length, 1);
    assert.equal(frags[0].prompt.id, "frag");
    assert.equal(frags[0].dpi.layer, "core");
    assert.equal(frags[0].dpi.priority, 100); // schema default
  });
});

describe("PromptService", () => {
  it("renders with locals — the action-template call shape", async () => {
    const reg = new PromptRegistry(
      source([{ id: "commit", body: "PUSH: {{PUSH}}", frontmatter: { variables: ["PUSH"] } }]),
      noopLogger,
    );
    const svc = new PromptService(reg);
    assert.equal(await svc.render("commit", { PUSH: "true" }), "PUSH: true");
  });

  it("auto-fills from static globals when no local is given", async () => {
    const reg = new PromptRegistry(
      source([{ id: "h", body: "OS={{OS}}", frontmatter: { variables: ["OS"] } }]),
      noopLogger,
    );
    const svc = new PromptService(reg, [], { OS: "darwin" });
    assert.equal(await svc.render("h"), "OS=darwin");
  });

  it("auto-fills from session vars (ctx.vars)", async () => {
    const reg = new PromptRegistry(
      source([{ id: "b", body: "{{BRANCH}}", frontmatter: { variables: ["BRANCH"] } }]),
      noopLogger,
    );
    const svc = new PromptService(reg);
    assert.equal(await svc.render("b", {}, { vars: { BRANCH: "feature" } }), "feature");
  });

  it("invokes a provider only when its key is referenced (lazy)", async () => {
    let gitCalls = 0;
    const gitProvider: VariableProvider = {
      keys: ["BRANCH"],
      provide() {
        gitCalls++;
        return { BRANCH: "main" };
      },
    };
    const reg = new PromptRegistry(
      source([
        { id: "uses-git", body: "on {{BRANCH}}", frontmatter: { variables: ["BRANCH"] } },
        { id: "no-git", body: "hello", frontmatter: {} },
      ]),
      noopLogger,
    );
    const svc = new PromptService(reg, [gitProvider]);

    assert.equal(await svc.render("no-git"), "hello");
    assert.equal(gitCalls, 0); // not invoked — no key referenced

    assert.equal(await svc.render("uses-git"), "on main");
    assert.equal(gitCalls, 1); // invoked once
  });

  it("lets locals override session/provider values", async () => {
    const gitProvider: VariableProvider = { keys: ["BRANCH"], provide: () => ({ BRANCH: "main" }) };
    const reg = new PromptRegistry(
      source([{ id: "b", body: "{{BRANCH}}", frontmatter: { variables: ["BRANCH"] } }]),
      noopLogger,
    );
    const svc = new PromptService(reg, [gitProvider]);
    assert.equal(await svc.render("b", { BRANCH: "local" }, { vars: { BRANCH: "session" } }), "local");
  });
});
