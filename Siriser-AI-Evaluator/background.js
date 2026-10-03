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
};
const LAST_VER_KEY = "SIRISER_LAST_NOTIFIED_VER";

function postDingText(webhook, content) {
  return fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json;charset=utf-8" },
    body: JSON.stringify({ msgtype: "text", text: { content: String(content || "") } }),
  })
    .then(function (r) { return !!r.ok; })
    .catch(function () { return false; });
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
        sendResponse({ ok: res.ok, status: res.status, body: body.slice(0, 200) });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
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
