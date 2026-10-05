const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const extensionDir = path.join(__dirname, "../Siriser-AI-Evaluator");
const backgroundSource = fs.readFileSync(path.join(extensionDir, "background.js"), "utf8");
const reportSource = fs.readFileSync(path.join(extensionDir, "evaluation-report.js"), "utf8");
const popupSource = fs.readFileSync(path.join(extensionDir, "popup.js"), "utf8");
const contentSource = fs.readFileSync(path.join(extensionDir, "content.js"), "utf8");

function loadReportHelpers() {
  const context = {};
  vm.runInNewContext(reportSource, context);
  return context.SiriserEvaluationReport;
}

function loadBackground(context) {
  context.importScripts = (...files) => {
    for (const file of files) {
      assert.equal(file, "evaluation-report.js");
      vm.runInNewContext(reportSource, context);
    }
  };
  vm.runInNewContext(backgroundSource, context);
}

function loadPopupReportHelpers(context) {
  vm.runInNewContext(reportSource, context);
  const start = popupSource.indexOf("const EVALUATIONS_KEY =");
  const end = popupSource.indexOf("async function refreshEvaluationSummary()", start);
  assert.ok(start >= 0 && end > start, "popup should read/export reports directly from local storage");
  vm.runInNewContext(`${popupSource.slice(start, end)}\nglobalThis.helpers = { readLocalEvaluationRecords, downloadLocalEvaluationWorkbook };`, context);
  return context.helpers;
}

test("daily statistics count packages, unresolved IDs, model scores, and image issues", () => {
  const { reportDailySummary } = loadReportHelpers();
  const daily = reportDailySummary([
    {
      date: "2026-10-04",
      taskId: "Q-1",
      scores: [
        { alignment: 8, quality: 7, preservation: 9, consistency: 8, realism: 7, imageStatus: "ok" },
        { alignment: null, quality: null, preservation: null, consistency: null, realism: null, imageStatus: "broken" },
      ],
    },
    { date: "2026-10-04", taskId: "", scores: [{ alignment: 6, quality: 6, preservation: 6, consistency: 6, realism: 6, imageStatus: "missing" }] },
  ]);

  assert.equal(daily.length, 1);
  assert.equal(daily[0].packages, 2);
  assert.equal(daily[0].identified, 1);
  assert.equal(daily[0].pending, 1);
  assert.equal(daily[0].ratings, 3);
  assert.equal(daily[0].imageIssues, 2);
  assert.equal(daily[0].averages[0], 7);
});

test("Excel-compatible workbook contains three sheets and escapes score reasons", () => {
  const { buildEvaluationWorkbookXml } = loadReportHelpers();
  const xml = buildEvaluationWorkbookXml([{
    date: "2026-10-04",
    taskId: "TASK-1",
    completedAt: "2026-10-04T12:00:00.000Z",
    elapsedMs: 180000,
    evaluatorA: "judge-a",
    evaluatorB: "judge-b",
    reviewer: "reviewer",
    scoringMode: "balanced",
    scores: [{
      modelId: "A",
      modelName: "Model & A",
      alignment: 8,
      quality: 7,
      preservation: 9,
      consistency: 8,
      realism: 7,
      reason: "边缘 <轻微> & 需检查",
      imageStatus: "ok",
    }],
  }]);

  assert.match(xml, /ss:Name="每日统计"/);
  assert.match(xml, /ss:Name="分包汇总"/);
  assert.match(xml, /ss:Name="模型评分明细"/);
  assert.match(xml, /TASK-1/);
  assert.match(xml, /Model &amp; A/);
  assert.match(xml, /边缘 &lt;轻微&gt; &amp; 需检查/);
  assert.match(xml, /评分理由\/备注/);
});

test("popup reads local stats and exports workbook without a background message round-trip", async () => {
  const saved = [{ date: "2026-10-05", taskId: "LOCAL-1", scores: [{ modelId: "A", alignment: 8 }] }];
  let downloadOptions;
  const context = {
    TextEncoder,
    btoa,
    chrome: {
      runtime: { lastError: null },
      storage: { local: { get(_keys, callback) { callback({ SIRISER_EVALUATION_RECORDS: saved }); } } },
      downloads: { download(options, callback) { downloadOptions = options; callback(9); } },
    },
  };
  const helpers = loadPopupReportHelpers(context);
  assert.equal((await helpers.readLocalEvaluationRecords()).length, 1);
  assert.equal(await helpers.downloadLocalEvaluationWorkbook(saved), 9);
  assert.equal(downloadOptions.filename, "Siriser-评测统计/本地评分统计.xml");
  assert.equal(downloadOptions.conflictAction, "overwrite");
  const xml = Buffer.from(downloadOptions.url.split(",")[1], "base64").toString("utf8");
  assert.match(xml, /LOCAL-1/);
});

test("content-side storage fallback merges a record when background messaging is unavailable", async () => {
  const saved = { SIRISER_EVALUATION_RECORDS: [{ recordKey: "pending:x", localTaskKey: "x", taskId: "", scores: [{ modelId: "A", alignment: 7 }] }] };
  const context = {
    chrome: {
      runtime: { lastError: null },
      storage: { local: {
        get(keys, callback) { callback(Object.fromEntries(keys.filter((key) => key in saved).map((key) => [key, saved[key]]))); },
        set(values, callback) { Object.assign(saved, values); callback(); },
      } },
    },
  };
  const start = contentSource.indexOf("  function saveEvaluationRecordDirect(record) {");
  const end = contentSource.indexOf("\n  function buildEvaluationRecord(", start);
  assert.ok(start >= 0 && end > start, "content script should have a local-save fallback");
  vm.runInNewContext(`${contentSource.slice(start, end)}\nglobalThis.saveRecord = saveEvaluationRecordDirect;`, context);
  const count = await context.saveRecord({ recordKey: "task:Q-1", localTaskKey: "x", taskId: "Q-1", scores: [{ modelId: "B", alignment: 9 }] });
  assert.equal(count, 1);
  assert.equal(saved.SIRISER_EVALUATION_RECORDS[0].taskId, "Q-1");
  assert.deepEqual(Array.from(saved.SIRISER_EVALUATION_RECORDS[0].scores, (score) => score.modelId).sort(), ["A", "B"]);
});

test("automatic package ID lookup reads in a background tab and closes it", async () => {
  const calls = [];
  const context = {
    chrome: {
      runtime: {
        lastError: null,
        onInstalled: { addListener() {} },
        onMessage: { addListener() {} },
      },
      tabs: {
        async create(options) { calls.push(["create", options]); return { id: 55 }; },
        async sendMessage(tabId, message) { calls.push(["message", tabId, message]); return { ok: true, taskId: "TASK-55" }; },
        async remove(tabId) { calls.push(["remove", tabId]); },
        async update(tabId, options) { calls.push(["update", tabId, options]); },
      },
    },
  };
  loadBackground(context);

  const result = await context.lookupPackageIdForEvaluation(12, 4);
  assert.equal(result.ok, true);
  assert.equal(result.taskId, "TASK-55");
  assert.equal(calls[0][1].active, false);
  assert.deepEqual(calls.at(-1), ["remove", 55]);
  assert.equal(calls.some((call) => call[0] === "update"), false);
});

test("later workbench ID promotes a pending record and partial model ratings merge", async () => {
  const local = {};
  const context = {
    TextEncoder,
    btoa,
    chrome: {
      runtime: {
        lastError: null,
        onInstalled: { addListener() {} },
        onMessage: { addListener() {} },
      },
      storage: {
        local: {
          get(keys, callback) { callback(Object.fromEntries(keys.filter((key) => key in local).map((key) => [key, local[key]]))); },
          set(values, callback) { Object.assign(local, values); callback(); },
        },
      },
      downloads: { download(_options, callback) { callback(1); } },
    },
    btoa,
  };
  loadBackground(context);
  await context.persistEvaluationRecord({
    recordKey: "pending:abc",
    localTaskKey: "abc",
    taskId: "",
    date: "2026-10-04",
    scores: [{ modelId: "A", alignment: 7 }],
  });
  await context.persistEvaluationRecord({
    recordKey: "task:Q-1",
    localTaskKey: "abc",
    taskId: "Q-1",
    date: "2026-10-04",
    scores: [{ modelId: "B", alignment: 9 }],
  });

  const records = local.SIRISER_EVALUATION_RECORDS;
  assert.equal(records.length, 1);
  assert.equal(records[0].taskId, "Q-1");
  assert.equal(JSON.stringify(Array.from(records[0].scores, (score) => score.modelId).sort()), '["A","B"]');
});

test("manifest grants automatic local workbook downloads and extension version is bumped", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(extensionDir, "manifest.json"), "utf8"));
  assert.equal(manifest.version, "1.0.51");
  assert.ok(manifest.permissions.includes("downloads"));
});
