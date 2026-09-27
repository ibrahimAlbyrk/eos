import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { renderPlist, type LaunchAgentSpec } from "../daemon/launchd.ts";

const spec = (env: LaunchAgentSpec["env"]): LaunchAgentSpec => ({
  label: "com.example.daemon",
  plistPath: "/unused",
  programArguments: ["/bin/bash", "-c", `ulimit -n; exec node "a&b.ts"`],
  env,
  logPath: "/tmp/daemon.log",
});

describe("renderPlist", () => {
  it("escapes XML specials in args and env values", () => {
    const xml = renderPlist(spec({ PATH: "/usr/bin", Q: "<a & b>" }));
    assert.match(xml, /exec node "a&amp;b\.ts"<\/string>/);
    assert.match(xml, /<key>Q<\/key><string>&lt;a &amp; b&gt;<\/string>/);
  });

  it("drops undefined env values and values XML cannot carry", () => {
    const xml = renderPlist(spec({ KEEP: "1", GONE: undefined, BAD: "a\u0001b" }));
    assert.match(xml, /<key>KEEP<\/key>/);
    assert.doesNotMatch(xml, /GONE|BAD/);
  });

  it("restarts after any death except a clean exit", () => {
    const xml = renderPlist(spec({}));
    assert.match(xml, /<key>KeepAlive<\/key><dict><key>SuccessfulExit<\/key><false\/><\/dict>/);
  });

  it("is a valid property list", { skip: process.platform !== "darwin" }, () => {
    const dir = mkdtempSync(join(tmpdir(), "plist-test-"));
    try {
      const file = join(dir, "a.plist");
      writeFileSync(file, renderPlist(spec({ PATH: "/usr/bin", Q: "<a & b>" })));
      execFileSync("plutil", ["-lint", file]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
