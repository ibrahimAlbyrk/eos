import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PlanLoginService } from "../services/PlanLoginService.ts";
import { NotFoundError } from "../errors/index.ts";
import {
  EMPTY_PLAN_LOGINS, sessionLoginOf, withoutLogin, type PlanLoginRegistry,
} from "../domain/plan-logins.ts";

function service(initial: PlanLoginRegistry = EMPTY_PLAN_LOGINS) {
  let reg = initial;
  let n = 0;
  const dirs = { discarded: [] as string[], trashed: [] as string[] };
  const svc = new PlanLoginService({
    store: { load: () => reg, save: (r) => { reg = r; } },
    dirs: {
      create: (_p, id) => `/acc/claude-${id}`,
      discard: (d) => { dirs.discarded.push(d); },
      trash: (d) => { dirs.trashed.push(d); },
    },
    clock: { now: () => Date.UTC(2026, 9, 28) },
    newId: () => `l${++n}`,
  });
  const add = (email?: string) => svc.commit(svc.prepare("anthropic"), { email }).login;
  return { svc, dirs, add, get reg() { return reg; } };
}

describe("PlanLoginService", () => {
  it("records sign-ins in order; the first becomes the default", () => {
    const t = service();
    const a = t.add("me@example.com");
    const b = t.add();
    assert.deepEqual(t.svc.list("anthropic").map((l) => [l.id, l.label, l.storeDir]), [
      ["l1", "me@example.com", "/acc/claude-l1"],
      ["l2", "Account 2", "/acc/claude-l2"],
    ]);
    assert.equal(a.createdAt, "2026-10-28T00:00:00.000Z");
    assert.equal(b.email, undefined);
    assert.equal(t.svc.defaultId("anthropic"), "l1");
    assert.deepEqual(t.svc.list("openai"), []);
  });

  it("an abandoned fresh sign-in discards its store; a renewal keeps it", () => {
    const t = service();
    t.svc.abandon(t.svc.prepare("anthropic"));
    t.add();
    t.svc.abandon(t.svc.prepare("anthropic", "l2"));
    assert.deepEqual(t.dirs.discarded, ["/acc/claude-l1"]);
  });

  it("renewing records the email it signed in with", () => {
    const t = service();
    t.add();
    const { login, replaced } = t.svc.commit(t.svc.prepare("anthropic", "l1"), { email: "me@example.com" });
    assert.equal(login.email, "me@example.com");
    assert.equal(replaced, null);
  });

  it("a fresh sign-in to a listed email replaces that sign-in's store", () => {
    const t = service();
    t.add("me@example.com");
    t.svc.rename("anthropic", "l1", "Personal");
    const { login, replaced } = t.svc.commit(t.svc.prepare("anthropic"), { email: "Me@Example.com " });
    assert.deepEqual([login.id, login.label, login.storeDir], ["l1", "Personal", "/acc/claude-l2"]);
    assert.equal(replaced, "/acc/claude-l1");
    assert.equal(t.svc.list("anthropic").length, 1);
  });

  it("removing the default hands it to the oldest left, and trashes the store", () => {
    const t = service();
    t.add("a@x");
    t.add("b@x");
    t.add("c@x");
    t.svc.setDefault("anthropic", "l1");
    t.svc.remove("anthropic", "l1");
    assert.equal(t.svc.defaultId("anthropic"), "l2");
    assert.deepEqual(t.dirs.trashed, ["/acc/claude-l1"]);
  });

  it("unknown sign-ins are NotFound, also across providers", () => {
    const t = service();
    t.add();
    assert.throws(() => t.svc.prepare("anthropic", "nope"), NotFoundError);
    assert.throws(() => t.svc.rename("openai", "l1", "x"), NotFoundError);
    assert.throws(() => t.svc.setDefault("anthropic", "nope"), NotFoundError);
  });

  it("adopts the sign-in from before only while the provider lists none", () => {
    const t = service();
    assert.equal(t.svc.adopt("anthropic", "/acc/claude", "me@example.com")?.storeDir, "/acc/claude");
    assert.equal(t.svc.adopt("anthropic", "/acc/claude"), null);
    assert.equal(t.svc.defaultId("anthropic"), "l1");
  });

  it("new sessions take the default while it works, else the oldest that does", () => {
    const t = service();
    t.add("a@x");
    t.add("b@x");
    t.add("c@x");
    t.svc.setDefault("anthropic", "l2");
    assert.equal(t.svc.sessionLogin("anthropic", () => true)?.id, "l2");
    assert.equal(t.svc.sessionLogin("anthropic", (l) => l.id !== "l2")?.id, "l1");
    assert.equal(t.svc.sessionLogin("anthropic", () => false), null);
  });
});

describe("plan-logins domain", () => {
  it("withoutLogin of an unknown id changes nothing; of the last login drops the default", () => {
    const reg: PlanLoginRegistry = {
      logins: [{ id: "a", provider: "anthropic", label: "a", storeDir: "/a", createdAt: "t" }],
      defaults: { anthropic: "a" },
    };
    assert.equal(withoutLogin(reg, "zz"), reg);
    assert.deepEqual(withoutLogin(reg, "a"), EMPTY_PLAN_LOGINS);
    assert.equal(sessionLoginOf(EMPTY_PLAN_LOGINS, "anthropic", () => true), null);
  });
});
