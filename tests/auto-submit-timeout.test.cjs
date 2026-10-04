const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../Siriser-AI-Evaluator/content.js"), "utf8");
const start = source.indexOf("  function planAutoSubmitTiming(");
const end = source.indexOf("\n  async function autoOneTask", start);
assert.ok(start >= 0 && end > start, "auto-submit timing planner should exist");
const context = {};
vm.runInNewContext(`${source.slice(start, end)}\nglobalThis.planAutoSubmitTiming = planAutoSubmitTiming;`, context);
const plan = (...args) => JSON.parse(JSON.stringify(context.planAutoSubmitTiming(...args)));

test("keeps the normal target countdown when scoring finishes early", () => {
  assert.deepEqual(plan(4 * 60_000, 7 * 60_000, 15 * 60_000, 60_000), {
    effectiveTargetMs: 7 * 60_000,
    waitMs: 3 * 60_000,
    submitImmediately: false,
  });
});

test("extends briefly when scoring runs past its target but stays below the cap", () => {
  assert.deepEqual(plan(9 * 60_000, 7 * 60_000, 15 * 60_000, 60_000), {
    effectiveTargetMs: 10 * 60_000,
    waitMs: 60_000,
    submitImmediately: false,
  });
});

test("submits immediately instead of stopping when scoring exceeds fifteen minutes", () => {
  assert.deepEqual(plan(16 * 60_000, 7 * 60_000, 15 * 60_000, 60_000), {
    effectiveTargetMs: 16 * 60_000,
    waitMs: 0,
    submitImmediately: true,
  });
});
