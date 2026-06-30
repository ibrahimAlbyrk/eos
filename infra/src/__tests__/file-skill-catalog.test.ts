// M6 — FileSkillCatalog (§5c): generalizes scanSkills into a reusable catalog.
// Asserts discovery (project + user scope, project wins), metadata (name +
// description from SKILL.md frontmatter), body load (frontmatter stripped), and the
// resource-path contract — loadBody returns the skill's absolute dir so bundled
// scripts/assets are reachable.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createFileSkillCatalog } from "../skills/FileSkillCatalog.ts";

let root: string;
let cwd: string;
let home: string;

function writeSkill(base: string, name: string, frontmatter: string, body: string): string {
  const dir = join(base, ".claude", "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n${body}`);
  return dir;
}

before(() => {
  root = mkdtempSync(join(tmpdir(), "eos-skills-"));
  cwd = join(root, "project");
  home = join(root, "home");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(home, { recursive: true });

  // A project skill with a bundled asset (the resource-path case).
  const dir = writeSkill(cwd, "pdf-filler", "name: pdf-filler\ndescription: Fill PDF forms from data", "Run scripts/fill.py with the data.");
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(join(dir, "scripts", "fill.py"), "print('filled')\n");

  // A user skill, plus a same-named skill at user scope to prove project wins.
  writeSkill(home, "reviewer", "name: reviewer\ndescription: Review code", "Review the diff.");
  writeSkill(home, "pdf-filler", "name: pdf-filler\ndescription: USER SCOPE — should lose to project", "user body");
});

after(() => rmSync(root, { recursive: true, force: true }));

describe("FileSkillCatalog", () => {
  it("lists skills across project + user scopes with name + description", () => {
    const cat = createFileSkillCatalog({ home });
    const skills = cat.listSkills(cwd);
    const byName = new Map(skills.map((s) => [s.name, s.description]));
    assert.equal(byName.get("pdf-filler"), "Fill PDF forms from data", "project description wins");
    assert.equal(byName.get("reviewer"), "Review code");
  });

  it("de-duplicates by name (project scope wins over user scope)", () => {
    const cat = createFileSkillCatalog({ home });
    const filler = cat.listSkills(cwd).filter((s) => s.name === "pdf-filler");
    assert.equal(filler.length, 1, "no duplicate entry");
    assert.equal(filler[0].description, "Fill PDF forms from data");
  });

  it("loadBody returns the frontmatter-stripped body AND the skill's absolute dir", () => {
    const cat = createFileSkillCatalog({ home });
    const loaded = cat.loadBody("pdf-filler", cwd);
    assert.ok(loaded, "skill found");
    assert.equal(loaded!.body, "Run scripts/fill.py with the data.");
    assert.equal(loaded!.dir, join(cwd, ".claude", "skills", "pdf-filler"));
  });

  it("the returned dir is reachable — bundled scripts/assets resolve under it", () => {
    const cat = createFileSkillCatalog({ home });
    const loaded = cat.loadBody("pdf-filler", cwd)!;
    const asset = join(loaded.dir, "scripts", "fill.py");
    assert.ok(existsSync(asset), "bundled asset exists under the surfaced dir");
    assert.match(readFileSync(asset, "utf8"), /filled/);
  });

  it("returns null for an unknown skill", () => {
    const cat = createFileSkillCatalog({ home });
    assert.equal(cat.loadBody("does-not-exist", cwd), null);
  });

  it("a null cwd skips the project scope (user/plugin only)", () => {
    const cat = createFileSkillCatalog({ home });
    const names = cat.listSkills(null).map((s) => s.name);
    assert.ok(names.includes("reviewer"));
    // pdf-filler exists at user scope too (the loser copy), so it still appears —
    // but its description is the USER one, proving the project scope was skipped.
    const filler = cat.listSkills(null).find((s) => s.name === "pdf-filler");
    assert.match(filler!.description, /USER SCOPE/);
  });
});
