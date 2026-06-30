// M6 — prompt-template command expansion (§5c). The pure substitution grammar:
// $ARGUMENTS/$1…$N, @file includes, and !`cmd` execution, plus the ordering safety
// property (arguments are substituted LAST, so an argument value can't inject a
// command run or a file read).

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { expandCommandTemplate, type CommandTemplateContext } from "../domain/command-template.ts";

function ctx(over: Partial<CommandTemplateContext> = {}): CommandTemplateContext {
  return {
    async run(cmd) { return `ran(${cmd})`; },
    async readFile(path) { return `<contents of ${path}>`; },
    ...over,
  };
}

describe("expandCommandTemplate", () => {
  it("substitutes $ARGUMENTS with the full argument string", async () => {
    const out = await expandCommandTemplate("Review this: $ARGUMENTS", "the auth module carefully", ctx());
    assert.equal(out, "Review this: the auth module carefully");
  });

  it("substitutes positional $1…$N (whitespace-split); missing positions become empty", async () => {
    const out = await expandCommandTemplate("first=$1 second=$2 third=$3", "alpha beta", ctx());
    assert.equal(out, "first=alpha second=beta third=");
  });

  it("resolves @file includes via ctx.readFile", async () => {
    const reads: string[] = [];
    const out = await expandCommandTemplate("See @docs/spec.md for details", "", ctx({
      async readFile(p) { reads.push(p); return "SPEC BODY"; },
    }));
    assert.equal(out, "See SPEC BODY for details");
    assert.deepEqual(reads, ["docs/spec.md"]);
  });

  it("runs !`cmd` and splices its trimmed stdout via ctx.run", async () => {
    const ran: string[] = [];
    const out = await expandCommandTemplate("On branch: !`git branch --show-current`", "", ctx({
      async run(c) { ran.push(c); return "feat/x\n"; },
    }));
    assert.equal(out, "On branch: feat/x");
    assert.deepEqual(ran, ["git branch --show-current"]);
  });

  it("combines all three: !`cmd`, @file, then arguments", async () => {
    const out = await expandCommandTemplate(
      "branch=!`git branch` file @a.txt args=$ARGUMENTS",
      "go now",
      ctx({ async run() { return "main"; }, async readFile() { return "AAA"; } }),
    );
    assert.equal(out, "branch=main file AAA args=go now");
  });

  it("@ only triggers an include at a word boundary (start/whitespace), not mid-token", async () => {
    let read = false;
    const out = await expandCommandTemplate("contact user@host.com directly", "", ctx({
      async readFile() { read = true; return "X"; },
    }));
    assert.equal(read, false, "user@host is not a file include");
    assert.equal(out, "contact user@host.com directly");
  });

  it("does NOT execute commands or includes injected through arguments (ordering safety)", async () => {
    let ran = false;
    let read = false;
    const out = await expandCommandTemplate("payload: $ARGUMENTS", "!`rm -rf /` @secret", ctx({
      async run() { ran = true; return "PWNED"; },
      async readFile() { read = true; return "SECRET"; },
    }));
    assert.equal(ran, false, "an argument-supplied !`cmd` is NOT executed");
    assert.equal(read, false, "an argument-supplied @file is NOT read");
    assert.equal(out, "payload: !`rm -rf /` @secret");
  });

  it("leaves an unresolved @include verbatim and notes a failed command (never throws)", async () => {
    const out = await expandCommandTemplate("a=@missing.md b=!`boom`", "", ctx({
      async run() { throw new Error("nope"); },
      async readFile() { throw new Error("ENOENT"); },
    }));
    assert.match(out, /a=@missing\.md/);
    assert.match(out, /b=\[command failed: nope\]/);
  });
});
