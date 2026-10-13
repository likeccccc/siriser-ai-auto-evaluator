const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../Siriser-AI-Evaluator/content.js"), "utf8");

function loadWorkbenchHelpers() {
  const start = source.indexOf("  function normalizeWorkbenchCellText(value) {");
  const end = source.indexOf("\n  /** 图片复查仍失败时", start);
  assert.ok(start >= 0 && end > start, "workbench ID helpers should exist");
  const context = {};
  vm.runInNewContext(`${source.slice(start, end)}\nglobalThis.helpers = { findActiveWorkbenchPackageId };`, context);
  return context.helpers;
}

test("reads question ID from the unique in-progress workbench row", () => {
  const { findActiveWorkbenchPackageId } = loadWorkbenchHelpers();
  const headers = ["项目名称", "项目流程", "报酬金额", "领域", "题目状态", "状态更新时间", "题目ID", "分组ID", "操作"];
  const rows = [
    ["Image benchmark", "回答", "¥48/条", "艺术", "验收中", "2026-10-03", "REVIEW-ID", "-", "去查看"],
    ["Image benchmark", "回答", "¥48/条", "艺术", "进行中", "2026-10-03", "ACTIVE-PACKAGE-ID", "-", "去回答 释放"],
  ];
  const result = findActiveWorkbenchPackageId(headers, rows);
  assert.equal(result.ok, true);
  assert.equal(result.taskId, "ACTIVE-PACKAGE-ID");
});

test("uses a unique in-progress row even when action labels differ, but rejects ambiguity", () => {
  const { findActiveWorkbenchPackageId } = loadWorkbenchHelpers();
  const headers = ["题目状态", "题目ID", "操作"];
  assert.equal(findActiveWorkbenchPackageId(headers, [["验收中", "REVIEW-ID", "去查看"]]).ok, false);
  assert.equal(findActiveWorkbenchPackageId(headers, [["进行中", "ACTIVE-ID", "继续作答"]]).taskId, "ACTIVE-ID");
  assert.equal(findActiveWorkbenchPackageId(headers, [
    ["进行中", "ACTIVE-ID", "去回答 释放"],
    ["进行中", "OTHER-ID", "继续作答"],
  ]).taskId, "ACTIVE-ID");
  assert.equal(findActiveWorkbenchPackageId(headers, [
    ["进行中", "ID-1", "去回答 释放"],
    ["进行中", "ID-2", "去回答 释放"],
  ]).ok, false);
});

test("broken-image alerts and popup test use workbench lookup", () => {
  const popup = fs.readFileSync(path.join(__dirname, "../Siriser-AI-Evaluator/popup.js"), "utf8");
  assert.match(popup, /type: "SIRISER_GET_ACTIVE_PACKAGE_ID"/);
  assert.match(popup, /type: "SIRISER_DINGTALK"/);
  assert.match(popup, /【Siriser 分包ID】\\nID：\$\{result\.taskId\}/);
  assert.match(popup, /chrome\.tabs\.create\(options\)/);
  assert.match(popup, /chrome\.tabs\.remove\(workbenchTabId\)/);
  assert.match(popup, /chrome\.tabs\.update\(sourceTab\.id, \{ active: true \}\)/);
  assert.match(popup, /finally \{[\s\S]*?chrome\.tabs\.remove\(workbenchTabId\)/);
  assert.match(source, /type: "SIRISER_GET_WORKBENCH_PACKAGE_ID"/);
  assert.match(source, /activateWorkbench: true/);
  assert.match(source, /const packageIdResult = await notifyImageIssueTaskId\(\)/);
  assert.match(source, /分包ID：\$\{packageIdResult\.taskId\}/);
  assert.match(source, /分包ID获取失败：/);
  assert.match(source, /\{ includePage: false \}/);
  assert.doesNotMatch(source, /extractTaskIdFromUrl/);
});

test("DingTalk accepts only HTTP success with errcode zero", () => {
  const background = fs.readFileSync(path.join(__dirname, "../Siriser-AI-Evaluator/background.js"), "utf8");
  const start = background.indexOf("function isDingTalkAccepted(");
  const end = background.indexOf("\nfunction postDingText", start);
  assert.ok(start >= 0 && end > start, "DingTalk response validator should exist");
  const context = {};
  vm.runInNewContext(`${background.slice(start, end)}\nglobalThis.validate = isDingTalkAccepted;`, context);
  assert.equal(context.validate(true, '{"errcode":0,"errmsg":"ok"}'), true);
  assert.equal(context.validate(true, '{"errcode":310000,"errmsg":"关键词不匹配"}'), false);
  assert.equal(context.validate(false, '{"errcode":0}'), false);
});

test("automatic and manual package ID notifications use the bracketed title", () => {
  const background = fs.readFileSync(path.join(__dirname, "../Siriser-AI-Evaluator/background.js"), "utf8");
  assert.match(background, /const text = `【Siriser 分包ID】\\nID：\$\{taskId\}`/);
});
