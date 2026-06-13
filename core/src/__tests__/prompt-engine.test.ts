import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseTemplate, renderTemplate } from "../services/template-engine.ts";
import { isTruthy } from "../domain/prompt.ts";
import { resolveVariables } from "../services/variable-resolve.ts";
import { parsePrompt } from "../services/prompt-parse.ts";
import { PromptRegistry } from "../services/PromptRegistry.ts";
import { PromptService } from "../services/PromptService.ts";
import { NotFoundError } from "../errors/index.ts";
import type { Logger } from "../ports/Logger.ts";
import type { PromptSource } from "../ports/PromptSource.ts";
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

describe("parseTemplate validation (fail loud, never silently corrupt)", () => {
  it("throws on a mismatched closer ({{#if}}…{{/unless}})", () => {
    assert.throws(() => parseTemplate("{{#if A}}x{{/unless}}"), /no matching/);
  });
  it("throws on an unclosed block", () => {
    assert.throws(() => parseTemplate("{{#if A}}x"), /unclosed/);
  });
  it("throws on a closer with no opener", () => {
    assert.throws(() => parseTemplate("x{{/if}}"));
  });
  it("throws on a malformed token (literal braces in prose)", () => {
    assert.throws(() => parseTemplate('{{ "k": {{V}} }}'));
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

describe("PromptService (synchronous; locals > session vars > static globals)", () => {
  it("renders with locals — the action-template call shape", () => {
    const reg = new PromptRegistry(
      source([{ id: "commit", body: "PUSH: {{PUSH}}", frontmatter: { variables: ["PUSH"] } }]),
      noopLogger,
    );
    assert.equal(new PromptService(reg).render("commit", { PUSH: "true" }), "PUSH: true");
  });

  it("auto-fills from static globals when no local/var is given", () => {
    const reg = new PromptRegistry(
      source([{ id: "h", body: "OS={{OS}}", frontmatter: { variables: ["OS"] } }]),
      noopLogger,
    );
    assert.equal(new PromptService(reg, { OS: "darwin" }).render("h"), "OS=darwin");
  });

  it("auto-fills from session vars, with locals overriding them", () => {
    const reg = new PromptRegistry(
      source([{ id: "b", body: "{{BRANCH}}", frontmatter: { variables: ["BRANCH"] } }]),
      noopLogger,
    );
    const svc = new PromptService(reg);
    assert.equal(svc.render("b", {}, { BRANCH: "feature" }), "feature"); // session var
    assert.equal(svc.render("b", { BRANCH: "local" }, { BRANCH: "session" }), "local"); // local wins
  });
});
