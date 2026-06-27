import { describe, it, expect } from "vitest";
import {
  wasRevealed, markRevealed, revealedWords, setRevealedWords, dropWorker,
} from "./animationLedger.js";

// Module-level state — keep session ids unique per assertion to avoid bleed.
let n = 0;
const sid = () => `s${n++}`;

describe("animationLedger", () => {
  it("markRevealed flips wasRevealed for that (session, block) only", () => {
    const s = sid();
    expect(wasRevealed(s, "b0")).toBe(false);
    markRevealed(s, "b0");
    expect(wasRevealed(s, "b0")).toBe(true);
    expect(wasRevealed(s, "b1")).toBe(false);
  });

  it("keys by both session and block — same block id in another session is independent", () => {
    const a = sid();
    const b = sid();
    markRevealed(a, "shared");
    expect(wasRevealed(a, "shared")).toBe(true);
    expect(wasRevealed(b, "shared")).toBe(false);
  });

  it("word count defaults to 0 and survives as a module-scope value", () => {
    const s = sid();
    expect(revealedWords(s, "b0")).toBe(0);
    setRevealedWords(s, "b0", 12);
    expect(revealedWords(s, "b0")).toBe(12);
    setRevealedWords(s, "b0", 20);
    expect(revealedWords(s, "b0")).toBe(20);
  });

  it("dropWorker clears reveal + word-count entries for one session, not others", () => {
    const gone = sid();
    const keep = sid();
    markRevealed(gone, "b0");
    setRevealedWords(gone, "b0", 5);
    markRevealed(keep, "b0");
    setRevealedWords(keep, "b0", 7);
    dropWorker(gone);
    expect(wasRevealed(gone, "b0")).toBe(false);
    expect(revealedWords(gone, "b0")).toBe(0);
    expect(wasRevealed(keep, "b0")).toBe(true);
    expect(revealedWords(keep, "b0")).toBe(7);
  });

  it("dropWorker does not affect a session whose id is a prefix of another", () => {
    const short = "abc";
    const long = "abcd";
    markRevealed(short, "b0");
    markRevealed(long, "b0");
    dropWorker(short);
    expect(wasRevealed(short, "b0")).toBe(false);
    expect(wasRevealed(long, "b0")).toBe(true);
  });
});
