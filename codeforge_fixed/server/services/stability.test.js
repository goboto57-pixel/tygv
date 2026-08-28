import test from "node:test";
import assert from "node:assert/strict";
import { withChatWriteLock } from "./chatWriteLock.js";
import { splitToolCalls } from "./toolExecution.js";

test("chat write lock serializes writes for one chat", async () => {
  const events = [];
  const a = withChatWriteLock("chat-a", async () => { events.push("a-start"); await new Promise((r) => setTimeout(r, 15)); events.push("a-end"); });
  const b = withChatWriteLock("chat-a", async () => events.push("b"));
  await Promise.all([a, b]);
  assert.deepEqual(events, ["a-start", "a-end", "b"]);
});

test("agent tool scheduler separates read-only calls from ordered mutations", () => {
  const calls = [
    { function: { name: "read_file" } },
    { function: { name: "search_code" } },
    { function: { name: "write_file" } },
    { function: { name: "run_tests" } }
  ];
  const result = splitToolCalls(calls);
  assert.equal(result.readOnly.length, 2);
  assert.equal(result.ordered.length, 2);
  assert.equal(result.ordered[0].call, calls[2]);
  assert.equal(result.ordered[1].call, calls[3]);
});
