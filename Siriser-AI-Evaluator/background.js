/**
 * Background (classic service worker) — 跨域取图并压缩
 * 不要写 export / import，manifest 不设 type:module，保证一定能加载
 */
importScripts("evaluation-report.js");

const {
  reportScoreAverage,
  reportDailySummary,
  buildEvaluationWorkbookXml,
  utf8Base64,
} = SiriserEvaluationReport;

async function blobToDataUrl(blob, max, quality) {
  max = max || 768;
  quality = quality == null ? 0.72 : quality;
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0, w, h);
  let out = await canvas.convertToBlob({ type: "image/jpeg", quality });
  if (out.size > 800 * 1024) {
    out = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.5 });
  }
  const buf = await out.arrayBuffer();
  const bytes = new Uint8Array(buf);
  var bin = "";
  var CH = 0x8000;
  for (var i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  return "data:image/jpeg;base64," + btoa(bin);
}

async function fetchBlob(url) {
  var res = await fetch(url, { credentials: "include" });
  if (!res.ok) {
    res = await fetch(url);
  }
  if (!res.ok) throw new Error("fetch img HTTP " + res.status);
  return res.blob();
}

/** 各版本更新说明（键=版本号，值=多行文本），版本升级时随钉钉公告推送 */
const VERSION_NOTES = {
  "1.0.55": "拟人点击新增三档完整题时长：2–4、3–5、4–6 分钟；选择会保存在本地，未选择时沿用原 4–6 分钟节奏。",
  "1.0.54": "裂图钉钉告警现在直接标注工作台分包 ID；若 ID 推送失败，会把失败原因写进告警，并隐藏容易混淆的答题页 URL id。",
  "1.0.52": "修复本地评分台账偶发缺失题目 ID：延长工作台异步表格读取等待，并在评分结束、保存前对失败的 ID 捕获复查一次；记录后台消息的具体错误。",
  "1.0.53": "成本保护不再致命中断整题（思考token/输出撞上限改为警告并继续）；评分请求超时上限压到120s、内联重试2→1，卡住的候选更快标missing并由首轮后统一补评，减少长时间空等与频繁停机。",
  "1.0.28": "新增「定时自动停止」：到点先打完并提交当前题再停，可走钉钉推送。",
  "1.0.29": "定时停止精简为仅「到点时刻」一种（去掉按运行时长）；新增版本更新自动钉钉公告。",
  "1.0.30": "① 定时自动停止：到点先打完并提交当前题再停、不再领新题，到点走钉钉通知；② 版本更新自动钉钉公告：升级到新版本时自动推送「版本+更新内容」，同版本不重复；③ 修复钉钉推送中文乱码：请求头补 charset=utf-8（三处发送均已修正）。",
  "1.0.32": "修复定时到点后找不到安全提交按钮时仍回退点击「提交并下一题」的问题：现在会停止自动并等待人工提交，避免误领下一题。",
  "1.0.33": "图片缺失或裂图等待网络并复查仍异常时，钉钉仅发送当前分包 ID，便于人工转发到群里。",
  "1.0.34": "扩展弹窗新增「测试获取分包 ID」按钮，可在标注任务页验证当前 id 读取结果，不会发送钉钉。",
  "1.0.35": "测试获取分包 ID 按钮会直接显示 ID，并通过已配置的钉钉 Webhook 发送该 ID；未配置或推送失败时明确提示。",
  "1.0.36": "分包 ID 钉钉通知添加安全关键词 Siriser；校验钉钉 errcode，避免被安全设置拦截时误报推送成功。",
  "1.0.37": "图片异常时新开标注工作台，从唯一「进行中」任务行的「题目ID」读取分包 ID，推送钉钉后切回原答题页。",
  "1.0.38": "测试获取题目 ID 按钮改为前台打开并停留在工作台；增强拆分表头/数据区的识别。",
  "1.0.39": "兼容工作台表格将题目列与固定操作列拆成不同 table 的情况，并在工作台显示识别成功或失败原因。",
  "1.0.40": "修复测试 ID 时先切换标签导致弹窗提前关闭、收不到后台回复；读取和推送完成后再切到工作台。",
  "1.0.41": "测试按钮直接与后台工作台 content script 通信，读取和推送期间保持弹窗存活，成功后再切换标签。",
  "1.0.42": "工作台存在唯一进行中任务时不再依赖固定的「去回答 / 释放」按钮文案；有多个进行中任务才用操作文案消歧。",
  "1.0.43": "分包 ID 钉钉消息标题统一为「【Siriser 分包ID】」，并将 ID 放在下一行，便于识别和转发。",
  "1.0.44": "测试获取分包 ID 完成后自动关闭临时工作台标签并回到原答题页。",
  "1.0.46": "评分与拟人勾选耗时超过15分钟时不再停止并漏交；评分完成后立即自动提交。",
  "1.0.47": "图片异常时除【Siriser 分包ID】外，补发【Siriser 图片无加载】+破图/无图模型编号，便于直接定位问题模型。",
  "1.0.48": "新增本地评分台账：每题按工作台题目ID归档各模型分数与评分备注，自动更新含每日汇总的Excel工作簿。",
  "1.0.49": "双评委逐图容错：单张网络失败不再停止评委；两轮完成后只补缺失图，双补缺失败时使用另一评委结果或将该图标为无。",
  "1.0.50": "单模型评分时启用审核模型风险复核：每包至少抽检2张，优先异常分数/维度项，最多审核5张并提供独立审核提示。",
  "1.0.51": "本地评分统计改为弹窗直接读扩展本地存储并生成工作簿，避免后台消息通道断开；评分记录增加页面侧本地保存备用路径。",
};
const LAST_VER_KEY = "SIRISER_LAST_NOTIFIED_VER";
const SIRISER_WORKBENCH_URL = "https://www.siriser.com/siriser/workbench";
const EVALUATIONS_KEY = "SIRISER_EVALUATION_RECORDS";

let evaluationWriteQueue = Promise.resolve();

function localStorageGet(keys) {
  return new Promise(function (resolve, reject) {
    chrome.storage.local.get(keys, function (result) {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(result || {});
    });
  });
}

function localStorageSet(values) {
  return new Promise(function (resolve, reject) {
    chrome.storage.local.set(values, function () {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    });
  });
}

async function downloadEvaluationWorkbook(records) {
  const xml = buildEvaluationWorkbookXml(records);
  const url = "data:application/vnd.ms-excel;base64," + utf8Base64(xml);
  return new Promise(function (resolve, reject) {
    chrome.downloads.download({
      url: url,
      filename: "Siriser-评测统计/本地评分统计.xml",
      conflictAction: "overwrite",
      saveAs: false,
    }, function (downloadId) {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(downloadId);
    });
  });
}

async function exportEvaluationWorkbook() {
  const result = await localStorageGet([EVALUATIONS_KEY]);
  const records = Array.isArray(result[EVALUATIONS_KEY]) ? result[EVALUATIONS_KEY] : [];
  const downloadId = await downloadEvaluationWorkbook(records);
  return { ok: true, downloadId: downloadId, packages: records.length, daily: reportDailySummary(records) };
}

function persistEvaluationRecord(record) {
  const operation = evaluationWriteQueue.then(async function () {
    const result = await localStorageGet([EVALUATIONS_KEY]);
    const records = Array.isArray(result[EVALUATIONS_KEY]) ? result[EVALUATIONS_KEY] : [];
    let index = records.findIndex(function (item) { return item.recordKey === record.recordKey; });
    if (index < 0 && record.taskId && record.localTaskKey) {
      index = records.findIndex(function (item) {
        return !item.taskId && item.localTaskKey === record.localTaskKey;
      });
    }
    let saved = record;
    if (index >= 0) {
      const previous = records[index];
      const byModel = new Map((previous.scores || []).map(function (score) { return [score.modelId, score]; }));
      (record.scores || []).forEach(function (score) { byModel.set(score.modelId, score); });
      saved = Object.assign({}, previous, record, { scores: Array.from(byModel.values()) });
      records[index] = saved;
    } else {
      records.push(saved);
    }
    await localStorageSet({ [EVALUATIONS_KEY]: records });
    let exported = false;
    let exportError = "";
    try {
      await downloadEvaluationWorkbook(records);
      exported = true;
    } catch (error) {
      exportError = String(error && error.message || error);
    }
    return { ok: true, packages: records.length, exported: exported, exportError: exportError };
  });
  evaluationWriteQueue = operation.catch(function () {});
  return operation;
}

function isDingTalkAccepted(httpOk, responseBody) {
  if (!httpOk) return false;
  try {
    const result = JSON.parse(String(responseBody || ""));
    return Number(result.errcode) === 0;
  } catch (_) {
    return false;
  }
}

function postDingText(webhook, content) {
  return fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json;charset=utf-8" },
    body: JSON.stringify({ msgtype: "text", text: { content: String(content || "") } }),
  })
    .then(async function (r) { return isDingTalkAccepted(r.ok, await r.text()); })
    .catch(function () { return false; });
}

function delay(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function getSyncConfig() {
  return new Promise(function (resolve) {
    chrome.storage.sync.get(["SIRISER_CONFIG"], function (result) {
      resolve((result && result.SIRISER_CONFIG) || {});
    });
  });
}

async function readActiveWorkbenchPackageId(sourceTabId, windowId, activateWorkbench) {
  const options = { url: SIRISER_WORKBENCH_URL, active: activateWorkbench !== false };
  if (Number.isInteger(windowId) && windowId >= 0) options.windowId = windowId;
  const workbenchTab = await chrome.tabs.create(options);
  if (!workbenchTab || !Number.isInteger(workbenchTab.id)) throw new Error("无法打开标注工作台");

  let lastError = "工作台尚未显示唯一的进行中任务包";
  // 工作台列表由前端异步加载；仅读取，不点击「去回答」或「释放」。
  // 页面本身加载完成后，Ant Design 表格数据仍可能延迟到达；给慢速网络留出 25 秒。
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const result = await chrome.tabs.sendMessage(
        workbenchTab.id,
        { type: "SIRISER_GET_ACTIVE_PACKAGE_ID" },
        { frameId: 0 }
      );
      if (result && result.ok && result.taskId) {
        return { taskId: result.taskId, workbenchTabId: workbenchTab.id };
      }
      if (result && result.error) lastError = result.error;
    } catch (e) {
      lastError = String((e && e.message) || e);
    }
    await delay(500);
  }
  const error = new Error(lastError);
  error.workbenchTabId = workbenchTab.id;
  throw error;
}

async function lookupPackageIdForEvaluation(sourceTabId, windowId) {
  let workbenchTabId;
  try {
    const found = await readActiveWorkbenchPackageId(sourceTabId, windowId, false);
    workbenchTabId = found.workbenchTabId;
    return { ok: true, taskId: found.taskId, source: "workbench-question-id" };
  } catch (error) {
    workbenchTabId = error && error.workbenchTabId;
    return { ok: false, error: String(error && error.message || error) };
  } finally {
    if (Number.isInteger(workbenchTabId)) {
      try { await chrome.tabs.remove(workbenchTabId); } catch (_) {}
    }
  }
}

async function getWorkbenchPackageIdAndNotify(sourceTabId, windowId, webhook, activateWorkbench, returnToSource) {
  let workbenchTabId;
  try {
    const found = await readActiveWorkbenchPackageId(sourceTabId, windowId, activateWorkbench);
    workbenchTabId = found.workbenchTabId;
    const taskId = found.taskId;
    const hook = String(webhook || ((await getSyncConfig()).DINGTALK_WEBHOOK) || "").trim();
    if (!hook || !/^https?:\/\//i.test(hook)) {
      return { ok: false, taskId, workbenchTabId: found.workbenchTabId, error: "已读取题目 ID，但未配置有效的钉钉 Webhook" };
    }
    const text = `【Siriser 分包ID】\nID：${taskId}`;
    const res = await fetch(hook, {
      method: "POST",
      headers: { "Content-Type": "application/json;charset=utf-8" },
      body: JSON.stringify({ msgtype: "text", text: { content: text } }),
    });
    const body = await res.text();
    return { ok: isDingTalkAccepted(res.ok, body), taskId, workbenchTabId: found.workbenchTabId, status: res.status, body: body.slice(0, 200), text };
  } catch (e) {
    if (Number.isInteger(workbenchTabId) && !Number.isInteger(e && e.workbenchTabId)) {
      e.workbenchTabId = workbenchTabId;
    }
    throw e;
  } finally {
    // 推送结束后保留工作台标签，并切回原答题页继续评分。
    if (returnToSource !== false && Number.isInteger(sourceTabId)) {
      try { await chrome.tabs.update(sourceTabId, { active: true }); } catch (_) {}
    }
  }
}

chrome.runtime.onInstalled.addListener(function (details) {
  const cur = chrome.runtime.getManifest().version;
  const write = function (v) { const p = {}; p[LAST_VER_KEY] = v; chrome.storage.local.set(p); };

  // 首次安装：补默认配置
  if (details && details.reason === "install") {
    chrome.storage.sync.get(["SIRISER_CONFIG"], function (res) {
      if (!res || !res.SIRISER_CONFIG) {
        chrome.storage.sync.set({
          SIRISER_CONFIG: {
            API_URL: "",
            API_KEY: "",
            OPENAI_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
            OPENAI_MODEL: "qwen-vl-max",
            OPENAI_API_KEY: "",
            AUTO_SUBMIT: false,
            AUTO_NEXT: false,
          },
        });
      }
    });
  }

  // 仅「升级到新版本」且未就该版本通知过时，往已配置的钉钉 Webhook 推一条版本公告；
  // 安装/同版本重载只记录不推送，避免打扰。
  if (!details || details.reason !== "update") {
    write(cur);
    return;
  }
  chrome.storage.local.get([LAST_VER_KEY], function (r) {
    const last = r && r[LAST_VER_KEY];
    if (last === cur) return; // 同版本已通知过
    const notes = VERSION_NOTES[cur] || "（本版本无更新说明，详见 README）";
    const body =
      "【Siriser 扩展更新】\n" +
      "版本：" +
      (last ? last + " → " : "") +
      cur +
      "\n更新内容：\n" +
      notes +
      "\n时间：" +
      new Date().toLocaleString();
    chrome.storage.sync.get(["SIRISER_CONFIG"], function (cfg) {
      const hook = (((cfg || {}).SIRISER_CONFIG || {}).DINGTALK_WEBHOOK || "").trim();
      if (!hook) {
        write(cur);
        return;
      }
      postDingText(hook, body).then(function () { write(cur); });
    });
  });
});

chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
  if (!msg || !msg.type) return false;

  if (msg.type === "SIRISER_BG_PING") {
    sendResponse({ ok: true, alive: true, v: "bg-classic" });
    return false;
  }

  // 钉钉 Webhook：必须在后台发，页面 fetch 会被 CORS 拦
  if (msg.type === "SIRISER_DINGTALK") {
    (async function () {
      try {
        const res = await fetch(msg.webhook, {
          method: "POST",
          headers: { "Content-Type": "application/json;charset=utf-8" },
          body: JSON.stringify({
            msgtype: "text",
            text: { content: String(msg.text || "") },
          }),
        });
        const body = await res.text();
        sendResponse({ ok: isDingTalkAccepted(res.ok, body), status: res.status, body: body.slice(0, 200) });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true;
  }

  if (msg.type === "SIRISER_GET_WORKBENCH_PACKAGE_ID") {
    const sourceTabId = (_sender.tab && _sender.tab.id) || msg.sourceTabId;
    const windowId = (_sender.tab && _sender.tab.windowId != null) ? _sender.tab.windowId : msg.windowId;
    getWorkbenchPackageIdAndNotify(sourceTabId, windowId, msg.webhook, msg.activateWorkbench, msg.returnToSource)
      .then(sendResponse)
      .catch(function (e) {
        sendResponse({
          ok: false,
          error: String((e && e.message) || e),
          workbenchTabId: e && e.workbenchTabId,
        });
      });
    return true;
  }

  if (msg.type === "SIRISER_CAPTURE_PACKAGE_ID_FOR_STATS") {
    const sourceTabId = _sender.tab && _sender.tab.id;
    const windowId = _sender.tab && _sender.tab.windowId;
    const sourceUrl = String((_sender.tab && _sender.tab.url) || _sender.url || "");
    if (!Number.isInteger(sourceTabId) || !/^https:\/\/(?:www\.)?siriser\.com\//i.test(sourceUrl)) {
      sendResponse({ ok: false, error: "无法确认当前标注页标签" });
      return false;
    }
    lookupPackageIdForEvaluation(sourceTabId, windowId).then(sendResponse).catch(function (error) {
      sendResponse({ ok: false, error: String(error && error.message || error) });
    });
    return true;
  }

  if (msg.type === "SIRISER_SAVE_EVALUATION") {
    const sourceUrl = String((_sender.tab && _sender.tab.url) || _sender.url || "");
    if (!/^https:\/\/(?:www\.)?siriser\.com\//i.test(sourceUrl)) {
      sendResponse({ ok: false, error: "只接受 Siriser 标注页评分记录" });
      return false;
    }
    if (!msg.record || !msg.record.recordKey || !Array.isArray(msg.record.scores)) {
      sendResponse({ ok: false, error: "评分记录格式无效" });
      return false;
    }
    persistEvaluationRecord(msg.record).then(sendResponse).catch(function (error) {
      sendResponse({ ok: false, error: String(error && error.message || error) });
    });
    return true;
  }

  if (msg.type === "SIRISER_EXPORT_EVALUATION_REPORT") {
    exportEvaluationWorkbook().then(sendResponse).catch(function (error) {
      sendResponse({ ok: false, error: String(error && error.message || error) });
    });
    return true;
  }

  if (msg.type === "SIRISER_GET_EVALUATION_SUMMARY") {
    localStorageGet([EVALUATIONS_KEY]).then(function (result) {
      const records = Array.isArray(result[EVALUATIONS_KEY]) ? result[EVALUATIONS_KEY] : [];
      sendResponse({ ok: true, packages: records.length, daily: reportDailySummary(records) });
    }).catch(function (error) {
      sendResponse({ ok: false, error: String(error && error.message || error) });
    });
    return true;
  }

  if (msg.type === "SIRISER_FETCH_IMAGE") {
    (async function () {
      try {
        var max = Number(msg.max) || 768;
        var q = msg.quality == null ? 0.72 : msg.quality;
        var blob = await fetchBlob(msg.url);
        var dataUrl = await blobToDataUrl(blob, max, q);
        sendResponse({ ok: true, dataUrl: dataUrl, bytes: dataUrl.length });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true;
  }

  return false;
});
