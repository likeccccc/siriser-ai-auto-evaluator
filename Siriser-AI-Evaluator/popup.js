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
  SCORING_MODE: "fast",
  DUAL_DIFF_THRESHOLD: 3,
  MAX_REVIEW: 1,
  REVIEW_BUDGET_MS: 45000,
  MAX_OUTPUT_TOKENS: 768,
  DINGTALK_WEBHOOK: "",
  AUTO_SUBMIT: false,
  AUTO_NEXT: true,
};

const SCORING_PROFILES = {
  fast: {
    maxReview: 1,
    reviewBudgetMs: 45000,
    hint: "评委与审核均关闭思考；速度最快、Token 最省。",
  },
  balanced: {
    maxReview: 3,
    reviewBudgetMs: 90000,
    hint: "评委 A/B 快速评分，只让高风险审核有限思考；需填写审核模型，推荐 qwen3.7-plus。",
  },
  thinking: {
    maxReview: 2,
    reviewBudgetMs: 120000,
    hint: "评委与审核均有限思考；准确性优先，时间和 Token 消耗最高。",
  },
};

function scoringProfile(mode) {
  return SCORING_PROFILES[mode] || SCORING_PROFILES.fast;
}

function updateScoringModeHint() {
  const mode = $("scoringMode").value || "fast";
  $("scoringModeHint").textContent = scoringProfile(mode).hint;
}

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
    files: ["config.js", "scoring-policy.js", "scoring-prompt.js", "api.js", "content.js"],
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
  // 合并已有配置，避免覆盖掉 MAX_REVIEW / TIMEOUT_MS 等未暴露字段
  const prev = await loadConfig();
  const scoringMode = $("scoringMode").value || "fast";
  const profile = scoringProfile(scoringMode);
  const cfg = {
    ...prev,
    API_URL: "",
    API_KEY: "",
    OPENAI_BASE_URL: $("oaBase").value.trim() || DEFAULTS.OPENAI_BASE_URL,
    OPENAI_MODEL: $("oaModel").value.trim() || DEFAULTS.OPENAI_MODEL,
    OPENAI_MODEL_2: $("oaModel2").value.trim(),
    OPENAI_MODEL_REVIEW: $("oaModelReview").value.trim(),
    SCORING_MODE: scoringMode,
    MAX_REVIEW: profile.maxReview,
    REVIEW_BUDGET_MS: profile.reviewBudgetMs,
    DUAL_DIFF_THRESHOLD: Number($("dualThreshold").value) || 3,
    DINGTALK_WEBHOOK: $("dingWebhook").value.trim(),
    OPENAI_API_KEY: $("oaKey").value.trim(),
    AUTO_SUBMIT: false,
    AUTO_NEXT: true,
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
  $("oaBase").value = cfg.OPENAI_BASE_URL || "";
  $("oaModel").value = cfg.OPENAI_MODEL || "";
  $("oaModel2").value = cfg.OPENAI_MODEL_2 || "";
  $("oaModelReview").value = cfg.OPENAI_MODEL_REVIEW || "";
  $("scoringMode").value = SCORING_PROFILES[cfg.SCORING_MODE]
    ? cfg.SCORING_MODE
    : "fast";
  updateScoringModeHint();
  $("dualThreshold").value = cfg.DUAL_DIFF_THRESHOLD != null ? cfg.DUAL_DIFF_THRESHOLD : 3;
  $("dingWebhook").value = cfg.DINGTALK_WEBHOOK || "";
  $("oaKey").value = cfg.OPENAI_API_KEY || "";
}

$("scoringMode").addEventListener("change", updateScoringModeHint);

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

/** 导出配置 JSON（含 Key，便于移除扩展后恢复） */
$("btnExportCfg").addEventListener("click", async () => {
  try {
    const cfg = await loadConfig();
    const blob = new Blob([JSON.stringify(cfg, null, 2)], {
      type: "application/json",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "siriser-evaluator-config.json";
    a.click();
    URL.revokeObjectURL(a.href);
    setStatus("配置已导出", "ok");
  } catch (e) {
    setStatus("导出失败：" + e.message, "err");
  }
});

$("btnImportCfg").addEventListener("click", () => $("cfgFile").click());

$("cfgFile").addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new Error("不是有效的配置 JSON");
    }
    const cfg = {
      ...DEFAULTS,
      ...data,
      // 导入后仍走 OpenAI 兼容路径
      API_URL: "",
      API_KEY: "",
      AUTO_SUBMIT: false,
      AUTO_NEXT: true,
    };
    await chrome.storage.sync.set({ SIRISER_CONFIG: cfg });
    await initForm();
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
    setStatus("配置已导入", "ok");
  } catch (err) {
    setStatus("导入失败：" + err.message, "err");
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

/** 生成一张可辨识的测试图（蓝底+红圆+黄方块），用于验证模型能收图 */
function makeTestImage() {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 256;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#1a4a8a";
  ctx.fillRect(0, 0, 256, 256);
  ctx.fillStyle = "#e23b2e";
  ctx.beginPath();
  ctx.arc(128, 128, 72, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#f5c518";
  ctx.fillRect(16, 16, 48, 48);
  return c.toDataURL("image/jpeg", 0.85);
}

function parseTestJson(text) {
  const raw = String(text || "").trim();
  try {
    return JSON.parse(raw);
  } catch (_) {}
  const m = raw.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      return JSON.parse(m[0]);
    } catch (_) {}
  }
  return null;
}

/** 测试指定模型：发一张测试图，看能否收图并返回打分 JSON */
async function testConfiguredModel(configKey, roleLabel) {
  try {
    await saveConfig();
    const cfg = await loadConfig();
    const key = String(cfg.OPENAI_API_KEY || "").trim();
    const model = String(cfg[configKey] || "").trim();
    const base = String(cfg.OPENAI_BASE_URL || "").trim().replace(/\/+$/, "");
    const modeLabel =
      cfg.SCORING_MODE === "thinking"
        ? "思考模式"
        : cfg.SCORING_MODE === "balanced"
          ? "平衡模式"
          : "快速模式";
    if (!key) {
      setStatus("请先填写 API Key 并保存", "err");
      $("preview").textContent = "缺少 OPENAI_API_KEY";
      return;
    }
    if (!model) {
      setStatus(`请先填写${roleLabel}`, "err");
      $("preview").textContent = `${roleLabel}未配置（${configKey} 为空）`;
      return;
    }
    if (/^qwen.*thinking(?:-|$)/i.test(model)) {
      setStatus("已阻止纯思考模型测试", "err");
      $("preview").textContent =
        `${model} 是纯思考模型，可能产生大量输出 Token。\n` +
        "请改用 instruct 或可关闭思考的 Qwen 3.7/3.8 模型。";
      return;
    }
    setStatus(`测试${roleLabel} ${model} 收图打分…`, "busy");
    setProg(25);

    const img = makeTestImage();
    const isQwen3Family = /^qwen3(?:[.-]|$)/i.test(model);
    const supportsMaxCompletionTokens =
      /^qwen3\.[5-9]-(?:max|plus|flash)(?:-|$)/i.test(model);
    const body = {
      model,
      temperature: 0,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text:
                "这是评分接口连通性测试图。请确认能否看到图片，然后按评分格式输出。\n" +
                '只输出 JSON：{"see_image":true,"main_color":"图中最显眼的颜色","score":1-10,"note":"一句话"}\n' +
                "若看不到图片，see_image 填 false，score 填 null。",
            },
            { type: "image_url", image_url: { url: img } },
          ],
        },
      ],
    };
    if (supportsMaxCompletionTokens) body.max_completion_tokens = 300;
    else body.max_tokens = 300;
    if (isQwen3Family) {
      body.enable_thinking = false;
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60000);
    let res;
    try {
      res = await fetch(base + "/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + key,
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    const rawText = await res.text().catch(() => "");
    setProg(70);
    if (!res.ok) {
      const short = rawText.slice(0, 280);
      let hint = "";
      if (/unexpected item type|invalid.*content/i.test(rawText)) {
        hint = "→ 该模型拒收图片（非视觉模型）。请换成带 vl 的模型，例如 qwen-vl-max / qwen3-vl-32b-instruct。";
      } else if (res.status === 403 || res.status === 401) {
        hint = "→ 无权限/Key 不对。请检查 API Key 与已开通的模型。";
      } else if (res.status === 429) {
        hint = "→ 触发限速，稍后再试。";
      } else if (res.status === 400) {
        hint = "→ 参数被拒。若模型名写错或不是 chat/completions 兼容接口，会出这个错。";
      }
      setStatus(`测试失败 HTTP ${res.status}`, "err");
      $("preview").textContent =
        `角色：${roleLabel}\n模型：${model}\nBase：${base}\nHTTP ${res.status}\n${short}\n${hint}`;
      return;
    }

    let data;
    try {
      data = JSON.parse(rawText);
    } catch (_) {
      setStatus("响应不是 JSON", "err");
      $("preview").textContent = rawText.slice(0, 400);
      return;
    }
    const content =
      (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) ||
      "";
    const parsed = parseTestJson(content);
    const see = parsed && (parsed.see_image === true || parsed.see_image === "true");
    const score = parsed && parsed.score != null ? parsed.score : "—";
    const color = (parsed && parsed.main_color) || "—";
    const note = (parsed && parsed.note) || "";
    const usage = data.usage || {};
    const details = usage.completion_tokens_details || {};
    const inputTokens = Number(usage.prompt_tokens) || 0;
    const outputTokens = Number(usage.completion_tokens) || 0;
    const reasoningTokens = Number(details.reasoning_tokens) || 0;
    const finishReason = data.choices?.[0]?.finish_reason || "";

    if (reasoningTokens > 0) {
      setStatus(`成本保护：仍产生 ${reasoningTokens} 思考 Token`, "err");
      setProg(100);
    } else if (finishReason === "length") {
      setStatus("成本保护：测试输出达到上限", "err");
      setProg(100);
    } else if (see) {
      setStatus(`模型可用 · 出分 ${score}`, "ok");
      setProg(100);
    } else {
      setStatus("模型回了 JSON 但未看到图", "err");
      setProg(100);
    }
    $("preview").textContent = [
      `角色：${roleLabel}`,
      `模型：${model}`,
      `评分模式：${modeLabel}（连通测试固定关闭思考）`,
      `Base：${base}`,
      `见图：${see ? "是" : "否"}`,
      `主色：${color}`,
      `测试分：${score}`,
      `Token：输入 ${inputTokens} / 输出 ${outputTokens} / 思考 ${reasoningTokens}`,
      finishReason ? `结束原因：${finishReason}` : "",
      note ? `备注：${note}` : "",
      "",
      "---- 原始回复 ----",
      String(content).slice(0, 500),
    ]
      .filter(Boolean)
      .join("\n");
  } catch (e) {
    setProg(0);
    const msg = String(e && e.message) || String(e);
    if (/abort/i.test(msg)) {
      setStatus("测试超时（60s）", "err");
      $("preview").textContent =
        "请求超时。模型可能过慢，或 Base URL 不通。\n" + msg;
    } else {
      setStatus("测试失败：" + msg, "err");
      $("preview").textContent = msg;
    }
  }
}

[
  ["btnTestModelA", "OPENAI_MODEL", "评委 A"],
  ["btnTestModelB", "OPENAI_MODEL_2", "评委 B"],
  ["btnTestModelReview", "OPENAI_MODEL_REVIEW", "审核模型"],
].forEach(([buttonId, configKey, roleLabel]) => {
  $(buttonId).addEventListener("click", () => testConfiguredModel(configKey, roleLabel));
});

$("btnTestDing").addEventListener("click", async () => {
  try {
    const hook = ($("dingWebhook").value || "").trim();
    if (!hook || !/^https?:\/\//i.test(hook)) {
      setStatus("请填写完整 Webhook（http 开头）", "err");
      $("preview").textContent = "当前值：" + (hook || "（空）");
      return;
    }
    await saveConfig();
    setStatus("测试钉钉…", "busy");
    const text =
      "【Siriser 标注异常】\n测试消息：配置正常\n时间：" + new Date().toLocaleString();
    // popup 可直接跨域（host_permissions 含 https://*/*）
    try {
      const res = await fetch(hook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ msgtype: "text", text: { content: text } }),
      });
      const body = await res.text();
      if (res.ok && /ok|success/i.test(body)) {
        setStatus("钉钉已发送", "ok");
        $("preview").textContent = body;
      } else {
        setStatus("钉钉拒绝：" + body.slice(0, 120), "err");
        $("preview").textContent = body;
      }
      return;
    } catch (e1) {
      $("preview").textContent =
        "直接 fetch 失败：" + e1.message + "\n改走后台重试…";
    }
    // 后备：background
    const res = await chrome.runtime.sendMessage({
      type: "SIRISER_DINGTALK",
      webhook: hook,
      text: text,
    });
    if (!res) {
      setStatus("后台无响应，请重新加载扩展", "err");
      $("preview").textContent += "\n后台无响应";
      return;
    }
    if (res.ok) {
      setStatus("钉钉已发送（后台）", "ok");
      $("preview").textContent = res.body || "ok";
    } else {
      setStatus("钉钉失败：" + (res.error || res.body || res.status), "err");
      $("preview").textContent += "\n" + JSON.stringify(res);
    }
  } catch (e) {
    setStatus(e.message, "err");
    $("preview").textContent = String(e);
  }
});

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

$("versionText").textContent = "v" + chrome.runtime.getManifest().version;
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
