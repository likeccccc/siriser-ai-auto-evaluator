/**
 * Background (classic service worker) — 跨域取图并压缩
 * 不要写 export / import，manifest 不设 type:module，保证一定能加载
 */

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
};
const LAST_VER_KEY = "SIRISER_LAST_NOTIFIED_VER";
const SIRISER_WORKBENCH_URL = "https://www.siriser.com/siriser/workbench";

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
  for (let attempt = 0; attempt < 24; attempt += 1) {
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
