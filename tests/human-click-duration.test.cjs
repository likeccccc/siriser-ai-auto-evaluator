const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const contentPath = path.join(__dirname, "../Siriser-AI-Evaluator/content.js");
const source = fs.readFileSync(contentPath, "utf8");

test("simulated click duration presets map to the three requested ranges", () => {
  const start = source.indexOf("  const HUMAN_DURATION_PRESETS = {");
  const end = source.indexOf("\n  function loadHumanDuration()", start);
  assert.ok(start >= 0 && end > start, "duration preset helpers should exist");
  const context = {};
  vm.runInNewContext(`${source.slice(start, end)}\nglobalThis.helpers = { calculateHumanClickTargetMs, formatHumanDuration };`, context);
  const { calculateHumanClickTargetMs, formatHumanDuration } = context.helpers;

  assert.equal(calculateHumanClickTargetMs("2-4", 90, true, 0), 120000);
  assert.ok(calculateHumanClickTargetMs("2-4", 90, true, 0.999) < 240000);
  assert.equal(calculateHumanClickTargetMs("3-5", 90, true, 0.5), 240000);
  assert.equal(calculateHumanClickTargetMs("4-6", 90, true, 0.5), 300000);
  assert.equal(calculateHumanClickTargetMs("4-6", 45, false, 0.5), 150000);
  assert.equal(calculateHumanClickTargetMs("4-6", 0, true, 0.5), 0);
  assert.equal(formatHumanDuration("3-5"), "3–5 分钟");
});

test("floating menu exposes all duration choices", () => {
  assert.match(source, /<select id="siriser-human-duration"/);
  assert.match(source, /<option value="2-4">2–4 分钟<\/option>/);
  assert.match(source, /<option value="3-5">3–5 分钟<\/option>/);
  assert.match(source, /<option value="4-6">4–6 分钟<\/option>/);
});
