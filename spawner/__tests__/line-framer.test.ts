import { test } from "node:test";
import assert from "node:assert/strict";
import { LineFramer } from "../line-framer.ts";

test("emits complete lines from a single chunk", () => {
  const f = new LineFramer();
  assert.deepEqual(f.push(Buffer.from('{"a":1}\n{"b":2}\n')), ['{"a":1}', '{"b":2}']);
});

test("holds an unterminated tail until its newline arrives", () => {
  const f = new LineFramer();
  assert.deepEqual(f.push(Buffer.from('{"a":1}\n{"b"')), ['{"a":1}']);
  assert.deepEqual(f.push(Buffer.from(":2}\n")), ['{"b":2}']);
});

test("reassembles a line split across many reads", () => {
  const f = new LineFramer();
  const line = JSON.stringify({ text: "x".repeat(1000) });
  const bytes = Buffer.from(line + "\n");
  const out: string[] = [];
  for (let i = 0; i < bytes.length; i += 7) {
    out.push(...f.push(bytes.subarray(i, i + 7)));
  }
  assert.deepEqual(out, [line]);
});

test("survives a multi-byte UTF-8 character split across reads", () => {
  const f = new LineFramer();
  const line = '{"t":"şğüöçİ🚀"}';
  const bytes = Buffer.from(line + "\n");
  // split inside the rocket emoji (4-byte sequence near the end)
  const cut = bytes.length - 4;
  const first = f.push(bytes.subarray(0, cut));
  assert.deepEqual(first, []);
  assert.deepEqual(f.push(bytes.subarray(cut)), [line]);
});

test("skips empty lines", () => {
  const f = new LineFramer();
  assert.deepEqual(f.push(Buffer.from("\n\n{\"a\":1}\n\n")), ['{"a":1}']);
});

test("never emits a line that is never terminated, without corrupting the next", () => {
  const f = new LineFramer();
  assert.deepEqual(f.push(Buffer.from("abc")), []);
  assert.deepEqual(f.push(Buffer.from("def\n{\"ok\":1}\n")), ["abcdef", '{"ok":1}']);
});
