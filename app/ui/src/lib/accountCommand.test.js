import { describe, it, expect } from "vitest";
import { parseAccountCommand, accountArgContext, accountCommandText, matchLogins, resolveLogin } from "./accountCommand.js";

const personal = { id: "lg-1", label: "Personal", email: "me@home.dev" };
const work = { id: "lg-2", label: "Work Max", email: "me@work.dev" };
const logins = [personal, work];

describe("parseAccountCommand", () => {
  it("reads the name after the command", () => {
    expect(parseAccountCommand("/account")).toEqual({ query: "" });
    expect(parseAccountCommand("  /account  Work Max ")).toEqual({ query: "Work Max" });
  });
  it("ignores other text", () => {
    expect(parseAccountCommand("/accounts")).toBeNull();
    expect(parseAccountCommand("see /account work")).toBeNull();
    expect(parseAccountCommand("/account work\nand more")).toBeNull();
  });
});

describe("accountArgContext", () => {
  it("is open only while the caret is in the argument", () => {
    expect(accountArgContext("/account ", 9)).toEqual({ query: "" });
    expect(accountArgContext("/account Wo", 11)).toEqual({ query: "wo" });
    expect(accountArgContext("/account", 8)).toBeNull();
    expect(accountArgContext("/account wo", 4)).toBeNull();
    expect(accountArgContext("hi /account wo", 14)).toBeNull();
  });
});

describe("matchLogins", () => {
  it("offers every sign-in before anything is typed", () => {
    expect(matchLogins(logins, "")).toEqual(logins);
  });
  it("filters by label or email", () => {
    expect(matchLogins(logins, "max")).toEqual([work]);
    expect(matchLogins(logins, "home")).toEqual([personal]);
    expect(matchLogins(logins, "me@")).toEqual(logins);
  });
  it("closes once a sign-in is named exactly", () => {
    expect(matchLogins(logins, "work max")).toEqual([]);
    expect(matchLogins(logins, "me@home.dev")).toEqual([]);
  });
});

describe("resolveLogin", () => {
  it("takes an exact name or the only match", () => {
    expect(resolveLogin(logins, "Work Max")).toEqual({ login: work });
    expect(resolveLogin(logins, "pers")).toEqual({ login: personal });
    expect(resolveLogin(logins, accountCommandText(work).slice(9))).toEqual({ login: work });
  });
  it("says why nothing was picked", () => {
    expect(resolveLogin(logins, "")).toEqual({ error: "Type an account's name after /account." });
    expect(resolveLogin(logins, "me@").error).toMatch(/Several accounts match/);
    expect(resolveLogin(logins, "nobody").error).toMatch(/No account matches/);
  });
});
