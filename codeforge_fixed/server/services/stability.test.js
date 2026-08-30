import test from "node:test";
import assert from "node:assert/strict";
import { withChatWriteLock } from "./chatWriteLock.js";
import { splitToolCalls } from "./toolExecution.js";
import { classifyTask, getMaxLoops, getMaxTokens, autoRouteModel } from "./taskComplexity.js";
import { renderMemoryForPrompt } from "./memoryService.js";

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

test("auto model routing: cheap tiers get cheap/fast models, big tier gets the strongest model", () => {
  assert.equal(autoRouteModel("поменяй цвет кнопки на красный"), "ministral-8b-latest");
  assert.equal(autoRouteModel("поправь баг в форме"), "ministral-14b-latest");
  assert.equal(autoRouteModel("сделай большой сложный интернет магазин"), "mistral-large-latest");
});

test("memory prompt rendering is capped: recent entries kept, old ones dropped once the block gets big", () => {
  // Well under the caps: everything should come through untouched.
  const small = [
    { text: "use zustand not redux", category: "convention", createdAt: "2024-01-01" },
    { text: "api expects snake_case", category: "constraint", createdAt: "2024-01-02" }
  ];
  const smallRendered = renderMemoryForPrompt(small);
  assert.match(smallRendered, /use zustand not redux/);
  assert.match(smallRendered, /api expects snake_case/);
  assert.doesNotMatch(smallRendered, /omitted/);

  // Way over both caps (entry count AND char budget): must not silently
  // balloon the prompt — older entries get dropped and it says so.
  const big = Array.from({ length: 80 }, (_, i) => ({
    text: `note number ${i} `.repeat(20), // long entry, well over MAX_ENTRY_LEN territory combined
    category: "note",
    createdAt: `2024-01-${(i % 28) + 1}`
  }));
  const bigRendered = renderMemoryForPrompt(big);
  assert.ok(bigRendered.length < 4000, `rendered memory block should stay bounded, got ${bigRendered.length} chars`);
  assert.match(bigRendered, /omitted/);
  // Most recent entry (highest index) must survive the cut, not the oldest.
  assert.match(bigRendered, /note number 79/);
  assert.doesNotMatch(bigRendered, /note number 0 /);
});
