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

chrome.runtime.onInstalled.addListener(function () {
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
});

chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
  if (!msg || !msg.type) return false;

  if (msg.type === "SIRISER_BG_PING") {
    sendResponse({ ok: true, alive: true, v: "bg-classic" });
    return false;
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
