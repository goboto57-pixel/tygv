import test from "node:test";
import assert from "node:assert/strict";
import { withChatWriteLock } from "./chatWriteLock.js";
import { splitToolCalls } from "./toolExecution.js";
import { classifyTask, getMaxLoops, getMaxTokens } from "./taskComplexity.js";

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

test("lint_files and web_search are scheduled as read-only (parallel), not ordered", () => {
  const calls = [
    { function: { name: "lint_files" } },
    { function: { name: "web_search" } },
    { function: { name: "outline_file" } },
    { function: { name: "write_file" } }
  ];
  const result = splitToolCalls(calls);
  assert.equal(result.readOnly.length, 3);
  assert.equal(result.ordered.length, 1);
});

test("task classifier: cheap tiers stay cheap, structural/multi-part signals bump the budget", () => {
  assert.equal(classifyTask("поменяй цвет кнопки на красный"), "trivial");
  assert.equal(classifyTask("поправь баг в форме"), "fix");
  assert.equal(classifyTask("сделай лендинг для кофейни"), "simple");
  assert.equal(classifyTask("сделай большой сложный интернет магазин"), "big");
  // structural bump: auth/db work needs more room even if phrased as a "fix"
  assert.equal(classifyTask("поправь баг в авторизации и базе данных"), "general");
  // loop/token budgets stay monotonic across tiers
  const tiers = ["trivial", "fix", "simple", "general", "big"];
  const prompts = {
    trivial: "поменяй цвет кнопки на красный",
    fix: "поправь баг в форме",
    simple: "сделай лендинг для кофейни",
    general: "напиши функцию сортировки массива",
    big: "сделай большой сложный интернет магазин"
  };
  let prevLoops = 0, prevTokens = 0;
  for (const tier of tiers) {
    const loops = getMaxLoops(prompts[tier]);
    const tokens = getMaxTokens(prompts[tier]);
    assert.ok(loops >= prevLoops, `${tier} loops should not shrink vs previous tier`);
    assert.ok(tokens >= prevTokens, `${tier} tokens should not shrink vs previous tier`);
    prevLoops = loops; prevTokens = tokens;
  }
});
