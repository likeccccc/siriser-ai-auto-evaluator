/* Popup — 配置 + 遥控 content script */
const $ = (id) => document.getElementById(id);

/** 标注工作台；点扩展图标时自动打开 */
const WORKBENCH_URL = "https://www.siriser.com/siriser/workbench";
const SIRISER_RE = /siriser\.com\/siriser/i;

function openWorkbench() {
  return chrome.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
    const tab = tabs && tabs[0];
    if (tab && tab.id && SIRISER_RE.test(tab.url || "")) {
      // 已在标注站则刷新到 workbench 列表
      if (!/\/workbench/i.test(tab.url || "")) {
        return chrome.tabs.update(tab.id, { url: WORKBENCH_URL });
      }
      return tab;
    }
    if (tab && tab.id) {
      return chrome.tabs.update(tab.id, { url: WORKBENCH_URL });
    }
    return chrome.tabs.create({ url: WORKBENCH_URL });
  });
}

const DEFAULTS = {
  API_URL: "",
  API_KEY: "",
  OPENAI_BASE_URL: "https://api.openai.com/v1",
  OPENAI_MODEL: "gpt-4o-mini",
  OPENAI_API_KEY: "",
  OPENAI_MODEL_2: "",
  OPENAI_MODEL_REVIEW: "",
  DUAL_DIFF_THRESHOLD: 2,
  AUTO_SUBMIT: true,
  AUTO_NEXT: true,
};

function setStatus(text, kind) {
  $("statusText").textContent = text;
  const pill = $("statusPill");
  pill.textContent = kind || "idle";
  pill.className = "pill" + (kind ? " " + kind : "");
}

function setProg(p) {
  $("prog").style.width = Math.max(0, Math.min(100, p)) + "%";
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function ensureContent(tab) {
  if (!tab || !tab.id) throw new Error("无活动标签页");
  try {
    const pong = await chrome.tabs.sendMessage(tab.id, { type: "SIRISER_PING" });
    if (pong && pong.ok) return tab.id;
  } catch (_) {}
  // 注入脚本（页面已有 content script 时可能因刷新丢失）
  await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: false },
    files: ["config.js", "scoring-prompt.js", "api.js", "content.js"],
  });
  await chrome.scripting.insertCSS({
    target: { tabId: tab.id },
    files: ["content.css"],
  });
  const pong = await chrome.tabs.sendMessage(tab.id, { type: "SIRISER_PING" });
  if (!pong || !pong.ok) throw new Error("无法连接页面脚本");
  return tab.id;
}

async function loadConfig() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(["SIRISER_CONFIG"], (res) => {
      resolve({ ...DEFAULTS, ...(res.SIRISER_CONFIG || {}) });
    });
  });
}

async function saveConfig() {
  const cfg = {
    API_URL: $("apiUrl").value.trim(),
    API_KEY: $("apiKey").value.trim(),
    OPENAI_BASE_URL: $("oaBase").value.trim() || DEFAULTS.OPENAI_BASE_URL,
    OPENAI_MODEL: $("oaModel").value.trim() || DEFAULTS.OPENAI_MODEL,
    OPENAI_MODEL_2: $("oaModel2").value.trim(),
    OPENAI_MODEL_REVIEW: $("oaModelReview").value.trim(),
    DUAL_DIFF_THRESHOLD: Number($("dualThreshold").value) || 2,
    OPENAI_API_KEY: $("oaKey").value.trim(),
    AUTO_SUBMIT: $("autoSubmit").checked,
    AUTO_NEXT: $("autoNext").checked,
  };
  await chrome.storage.sync.set({ SIRISER_CONFIG: cfg });
  // 同步到 content 的 window.SIRISER_CONFIG
  try {
    const tab = await getActiveTab();
    if (tab && tab.id) {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (c) => {
          window.SIRISER_CONFIG = Object.assign(window.SIRISER_CONFIG || {}, c);
        },
        args: [cfg],
      });
    }
  } catch (_) {}
  setStatus("配置已保存", "ok");
  return cfg;
}

async function initForm() {
  const cfg = await loadConfig();
  $("apiUrl").value = cfg.API_URL || "";
  $("apiKey").value = cfg.API_KEY || "";
  $("oaBase").value = cfg.OPENAI_BASE_URL || "";
  $("oaModel").value = cfg.OPENAI_MODEL || "";
  $("oaModel2").value = cfg.OPENAI_MODEL_2 || "";
  $("oaModelReview").value = cfg.OPENAI_MODEL_REVIEW || "";
  $("dualThreshold").value = cfg.DUAL_DIFF_THRESHOLD != null ? cfg.DUAL_DIFF_THRESHOLD : 2;
  $("oaKey").value = cfg.OPENAI_API_KEY || "";
  $("autoSubmit").checked = !!cfg.AUTO_SUBMIT;
  $("autoNext").checked = !!cfg.AUTO_NEXT;
}

async function sendToPage(msg) {
  const tab = await getActiveTab();
  const tabId = await ensureContent(tab);
  return chrome.tabs.sendMessage(tabId, msg);
}

$("btnSave").addEventListener("click", async () => {
  try {
    await saveConfig();
  } catch (e) {
    setStatus("保存失败：" + e.message, "err");
  }
});

$("btnCollect").addEventListener("click", async () => {
  try {
    setStatus("读取页面任务…", "busy");
    setProg(20);
    const res = await sendToPage({ type: "SIRISER_COLLECT" });
    if (!res.ok) throw new Error(res.error || "collect failed");
    const t = res.task;
    $("preview").textContent = JSON.stringify(
      {
        prompt: (t.prompt || "").slice(0, 120),
        refs: t.referenceImages.length,
        models: t.models.map((m) => ({
          id: m.id,
          imgs: m.images.length,
        })),
      },
      null,
      2
    );
    setProg(100);
    setStatus(`已读取 ${t.models.length} 个模型`, "ok");
  } catch (e) {
    setProg(0);
    setStatus(e.message, "err");
  }
});

async function evalFlow(onlyCurrent, batchSize) {
  try {
    await saveConfig();
    const cfg = await loadConfig();
    if (!cfg.API_URL && !cfg.OPENAI_API_KEY) {
      setStatus("请先填写 API_URL 或 OPENAI API Key", "err");
      return;
    }
    const label = onlyCurrent
      ? "AI 评分当前模型…"
      : batchSize >= 3
        ? `3张合评（${batchSize}/次）…`
        : "逐张评分（1/次）…";
    setStatus(label, "busy");
    setProg(15);
    const res = await sendToPage({
      type: "SIRISER_EVAL",
      onlyCurrent,
      batchSize: batchSize || 1,
    });
    if (!res.ok) throw new Error(res.error || "eval failed");
    setProg(100);
    setStatus(`完成，返回 ${res.scores.length} 条评分`, "ok");
    $("preview").textContent = JSON.stringify(res.scores, null, 2);
  } catch (e) {
    setProg(0);
    setStatus(e.message, "err");
    try {
      const logs = await sendToPage({ type: "SIRISER_GET_LOGS" });
      if (logs && logs.logs) {
        $("preview").textContent = "---- LOGS ----\n" + logs.logs;
      }
    } catch (_) {}
  }
}

$("btnEval1").addEventListener("click", () => evalFlow(false, 1));
$("btnEval3").addEventListener("click", () => evalFlow(false, 3));
$("btnEvalOne").addEventListener("click", () => evalFlow(true, 1));

$("btnDiag").addEventListener("click", async () => {
  try {
    setStatus("诊断页面结构…", "busy");
    setProg(30);
    const res = await sendToPage({ type: "SIRISER_DIAGNOSE" });
    if (!res.ok) throw new Error(res.error || "diag failed");
    $("preview").textContent =
      (res.text || JSON.stringify(res.models, null, 2)) +
      "\n\n---- LOGS ----\n" +
      (res.logs || "");
    setProg(100);
    setStatus(
      res.ok ? `识别到 ${res.models.length} 个模型` : "未识别到模型卡片，看下方诊断",
      res.ok ? "ok" : "err"
    );
  } catch (e) {
    setProg(0);
    setStatus(e.message, "err");
  }
});

$("btnSubmit").addEventListener("click", async () => {
  try {
    setStatus("提交中…", "busy");
    const res = await sendToPage({ type: "SIRISER_SUBMIT" });
    if (!res.ok) throw new Error(res.error || "submit failed");
    setStatus("已提交 / 下一题", "ok");
  } catch (e) {
    setStatus(e.message, "err");
  }
});

initForm();

$("btnOpenWorkbench").addEventListener("click", async () => {
  try {
    setStatus("打开标注工作台…", "busy");
    await openWorkbench();
    setStatus("已打开标注工作台", "ok");
  } catch (e) {
    setStatus(e.message, "err");
  }
});

// 仅点击「打开标注工作台」时跳转，打开弹窗不再自动跳
