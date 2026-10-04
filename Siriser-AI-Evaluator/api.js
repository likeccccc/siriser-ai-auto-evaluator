/**
 * 评分 API：自定义 HTTP 或 OpenAI 兼容（含通义 qwen-vl-*）
 * 要点：跨域图走 background；分批送模型；兼容无 response_format 的服务
 */
(function (global) {
  "use strict";

  async function fetchWithTimeout(url, options, timeoutMs) {
    const ctrl = new AbortController();
    const cancel = () => ctrl.abort();
    if (options.signal?.aborted) cancel();
    options.signal?.addEventListener("abort", cancel, { once: true });
    const t = setTimeout(() => ctrl.abort(), timeoutMs || 90000);
    try {
      const res = await fetch(url, { ...options, signal: ctrl.signal });
      return res;
    } finally {
      clearTimeout(t);
      options.signal?.removeEventListener("abort", cancel);
    }
  }

  // 只重试明确的传输故障，不重试认证、请求格式或评分内容错误。
  async function fetchWithRetry(url, options, timeoutMs, label) {
    for (let attempt = 0; ; attempt++) {
      if (options.signal?.aborted) throw new Error("评分已取消");
      try {
        const res = await fetchWithTimeout(url, options, timeoutMs);
        if (res.status !== 502 && res.status !== 503) return res;
        await res.body?.cancel().catch(() => {});
        const err = new Error("API失败 HTTP " + res.status);
        err.networkFailure = true;
        throw err;
      } catch (e) {
        if (options.signal?.aborted) throw e;
        const transient = e.networkFailure || e.name === "AbortError" ||
          /failed to fetch|networkerror|network error|load failed|timeout|timed out|超时/i.test(String(e.message));
        if (!transient || e.fatal) throw e;
        if (attempt >= 2) {
          e.channelFailure = true;
          slog(`${label} 网络重试2次仍失败 → 标记 missing，继续后续任务`, "err");
          throw e;
        }
        const delay = (attempt + 1) * 5000;
        slog(`${label} 网络故障，${delay / 1000}s后重试 ${attempt + 1}/2`);
        await new Promise((resolve, reject) => {
          const signal = options.signal;
          const cancel = () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", cancel);
            reject(new Error("评分已取消"));
          };
          const timer = setTimeout(() => {
            signal?.removeEventListener("abort", cancel);
            resolve();
          }, delay);
          signal?.addEventListener("abort", cancel, { once: true });
          if (signal?.aborted) cancel();
        });
      }
    }
  }

  function clampScore(v) {
    if (v == null || v === "na" || v === "无") return null;
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return null;
    return Math.max(1, Math.min(10, n));
  }

  function normModelId(s) {
    return String(s || "")
      .replace(/^\s*\*?\s*/, "")
      .replace(/^(?:模型|model|Model)\s*[-–—_：: ]*/i, "")
      .trim()
      .toUpperCase();
  }

  const DIM_KEYS = [
    "alignment",
    "quality",
    "preservation",
    "consistency",
    "realism",
  ];

  /**
   * 状态条专用：从日志里提炼用户能看懂的短句。
   * 不要透传原始日志（含 超时=300s / model=xxx 等，容易误判）。
   */
  function friendlyDetail(msg) {
    const s = String(msg || "");
    let m;
    if ((m = s.match(/进度\s*(\d+)\s*\/\s*(\d+)/))) {
      return `进度 ${m[1]}/${m[2]}`;
    }
    if ((m = s.match(/请求\s+([A-Za-z0-9]+(?:\s*,\s*[A-Za-z0-9]+)*)\s/))) {
      return `正在评 ${m[1].replace(/\s+/g, "")}`;
    }
    if (/响应\s+/.test(s)) {
      if ((m = s.match(/→\s*(\d+)\s*条/))) return `已出 ${m[1]} 个模型分`;
      return "已收到打分";
    }
    if (/审核/.test(s)) {
      return "审核分歧中";
    }
    if (/ref 压缩|img\s+/.test(s) || /压缩/.test(s)) {
      return "处理图片中";
    }
    if (/致命|无权限|API失败|HTTP\s*[45]|拒收|403|400|429|失败/.test(s)) {
      return s
        .replace(/model=[^\s]+/gi, "")
        .replace(/超时=\S+/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 36);
    }
    return "";
  }

  function slog(msg) {
    try {
      if (global.SIRISER_PAGE_LOG) global.SIRISER_PAGE_LOG(msg);
      else console.log("[Siriser]", msg);
    } catch (_) {}
    // 状态条只同步「阶段 + 友好短句」
    try {
      if (global.SIRISER_SET_STATUS) {
        const s = String(msg || "");
        const detail = friendlyDetail(s);
        if (/进度\s*\d+\s*\/\s*\d+/.test(s) || /\[\s*\S+\s*\]\s*进度/.test(s)) {
          global.SIRISER_SET_STATUS("大模型打分", detail || "打分中", "");
        } else if (/^请求\s+/.test(s)) {
          global.SIRISER_SET_STATUS("大模型打分", detail || "请求中", "");
        } else if (/^响应\s+/.test(s)) {
          global.SIRISER_SET_STATUS("大模型打分", detail || "已出分", "");
        } else if (/审核\s+\S+\s*→/.test(s) || /待审|审核完成|审核失败|审核超|审核裁剪/.test(s)) {
          global.SIRISER_SET_STATUS("审核分歧", detail || "审核中", "");
        } else if (/ref 压缩|img\s+\S+\s+(ok|FAIL|图过小)/.test(s)) {
          global.SIRISER_SET_STATUS("压缩图片", "处理图片中", "");
        } else if (/致命|无权限|API失败|HTTP\s*[45]|拒收|本批失败|超时：/.test(s)) {
          global.SIRISER_SET_STATUS("API 异常", detail || "评分出错", "err");
        }
      }
    } catch (_) {}
  }

  function scoreAvg(s) {
    const v = DIM_KEYS.map((k) => s[k]).filter((x) => typeof x === "number");
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  }

  /**
   * 单条轻量校正：只处理「五维完全相同」和无说明的 10
   * 不要套固定模板，否则全题都变成 9/8/9/8/8
   */
  function applyScorePolicy(s) {
    if (!s) return s;
    const nums = DIM_KEYS.map((k) => s[k]).filter((v) => typeof v === "number");
    if (!nums.length) return s;

    DIM_KEYS.forEach((k) => {
      if (s[k] === 10) {
        const notes = String(s.notes || "");
        const ok = /放大|无问题|完美|未见|难找|no\s*issue|perfect/i.test(notes);
        if (!ok) {
          s[k] = 8;
          s.notes = (s.notes ? s.notes + " " : "") + "[10→8]";
        }
      }
    });

    // 最多 3 个 ≥9（放宽一点，避免过度压成清一色 8）
    const highs = DIM_KEYS.filter((k) => typeof s[k] === "number" && s[k] >= 9);
    if (highs.length > 3) {
      highs
        .slice()
        .sort((a, b) => s[b] - s[a])
        .slice(3)
        .forEach((k) => {
          s[k] = Math.min(s[k], 8);
        });
      s.notes = (s.notes ? s.notes + " " : "") + "[9+限3]";
    }

    // 仅当五维完全相同时，按 model id 哈希错开，避免全题同一模板
    const now = DIM_KEYS.map((k) => s[k]);
    const allSame =
      now.length === 5 && now.every((v) => typeof v === "number" && v === now[0]);
    if (allSame) {
      const base = now[0];
      const h = (String(s.model || "").charCodeAt(0) || 65) % 4;
      const drops = [
        [0, -1, -1, -1, -2],
        [0, -1, -2, -1, -1],
        [+1, -1, -1, -2, -1],
        [0, -2, -1, -1, -1],
      ][h];
      DIM_KEYS.forEach((k, i) => {
        s[k] = Math.max(1, Math.min(10, base + drops[i]));
      });
      s.notes = (s.notes ? s.notes + " " : "") + "[同分校正]";
    }

    return s;
  }

  /**
   * 整批判分（保序、拉开差距）
   * 不要统一平移，否则人人变成同一套 7/6/7/6/6
   */
  function calibrateBatch(list) {
    const scored = list.filter((s) => scoreAvg(s) != null);
    if (scored.length < 3) return list;

    const avgs = scored.map(scoreAvg);
    const mean = avgs.reduce((a, b) => a + b, 0) / avgs.length;
    const min = Math.min(...avgs);
    const max = Math.max(...avgs);
    const range = Math.max(0.4, max - min);

    // 目标：均值 ~6.5，模型间极差至少 3.5
    const targetMean = 6.5;
    const targetRange = Math.max(3.5, Math.min(6, range * 1.35));

    scored.forEach((s, idx) => {
      const a = avgs[idx];
      // 相对位置 -1..1（保留排序）
      const rel = (a - mean) / (range / 2);
      const newAvg = targetMean + rel * (targetRange / 2);
      const oldAvg = a;

      DIM_KEYS.forEach((k) => {
        if (typeof s[k] !== "number") return;
        // 保留该维相对本模型均值的偏移，并放大一点
        const dimOff = s[k] - oldAvg;
        let v = newAvg + dimOff * 1.25;
        // 按「模型字母+维度」微抖，打破整数并列（确定性，非随机）
        const code = (String(s.model || "X").charCodeAt(0) || 88) + k.length * 3;
        v += ((code % 5) - 2) * 0.12;
        s[k] = Math.max(1, Math.min(10, Math.round(v)));
      });

      // 五维仍完全相同则只微调 quality/preservation
      const now = DIM_KEYS.map((k) => s[k]);
      if (now.every((v) => v === now[0])) {
        const c = (String(s.model || "").charCodeAt(0) || 65) % 2;
        if (c) s.quality = Math.max(1, s.quality - 1);
        else s.consistency = Math.max(1, s.consistency - 1);
      }
    });

    // 强制拉开「平均分并列」的模型：按原 avg 次序微调
    const order = scored
      .map((s, i) => ({ s, a: avgs[i] }))
      .sort((x, y) => y.a - x.a);
    for (let i = 1; i < order.length; i++) {
      const prev = scoreAvg(order[i - 1].s);
      const cur = scoreAvg(order[i].s);
      if (prev != null && cur != null && Math.abs(prev - cur) < 0.05) {
        // 并列：名次靠后的 quality -1
        order[i].s.quality = Math.max(1, order[i].s.quality - 1);
      }
    }

    const avgs2 = scored.map(scoreAvg);
    const mean2 = avgs2.reduce((x, y) => x + y, 0) / avgs2.length;
    slog(
      `校准(保序)：均值 ${mean.toFixed(2)}→${mean2.toFixed(2)} 极差 ${range.toFixed(2)}→${(
        Math.max(...avgs2) - Math.min(...avgs2)
      ).toFixed(2)}`
    );
    return list;
  }

  function normalizeScores(raw) {
    const list = raw && raw.scores ? raw.scores : Array.isArray(raw) ? raw : [];
    // 不做校准/同分改写：只规范 id 与 1–10 整数
    return list.map((s) => ({
      model: normModelId(s.model || s.id),
      alignment: clampScore(s.alignment),
      quality: clampScore(s.quality),
      preservation: clampScore(s.preservation),
      consistency: clampScore(s.consistency),
      realism: clampScore(s.realism),
      rcr: s.rcr,
      notes: s.notes || "",
      defects: s.defects || [],
    }));
  }

  function safeJson(text) {
    try {
      const cleaned = String(text)
        .replace(/^```(?:json)?/i, "")
        .replace(/```$/i, "")
        .trim();
      return JSON.parse(cleaned);
    } catch {
      // 尝试截取第一个 { 到最后一个 }
      const s = String(text);
      const a = s.indexOf("{");
      const b = s.lastIndexOf("}");
      if (a >= 0 && b > a) {
        try {
          return JSON.parse(s.slice(a, b + 1));
        } catch (_) {}
      }
      return {};
    }
  }

  /** 把任意 src 压成小 JPEG data URL（默认长边 768） */
  async function toImagePayload(src, max, quality) {
    if (!src) return null;
    max = max || 768;
    quality = quality == null ? 0.72 : quality;

    const compressViaBg = async (url) => {
      try {
        if (!(global.chrome && chrome.runtime && chrome.runtime.sendMessage)) {
          slog("bg 不可用 chrome.runtime 为空");
          return null;
        }
        // 先 ping，确认 service worker 活着（只在第一次）
        if (!compressViaBg._pinged) {
          compressViaBg._pinged = true;
        }
        const res = await chrome.runtime.sendMessage({
          type: "SIRISER_FETCH_IMAGE",
          url: url,
          max: max,
          quality: quality,
        });
        if (!res) {
          slog("bg 无响应（请重新加载扩展）");
          return null;
        }
        if (res.ok && res.dataUrl && String(res.dataUrl).startsWith("data:")) {
          return res.dataUrl;
        }
        slog("bg 压图失败:" + (res.error || "no dataUrl"));
        return null;
      } catch (e) {
        slog("bg 压图异常:" + (e && e.message));
        return null;
      }
    };

    const bg = await compressViaBg(src);
    if (bg) return bg;

    // 页面内 canvas 最后再试；绝不再把未压缩原图当成功
    try {
      const res = await fetch(src, { credentials: "include" });
      const blob = await res.blob();
      const bitmap = await createImageBitmap(blob);
      const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
      const w = Math.max(1, Math.round(bitmap.width * scale));
      const h = Math.max(1, Math.round(bitmap.height * scale));
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      c.getContext("2d").drawImage(bitmap, 0, 0, w, h);
      let dataUrl = c.toDataURL("image/jpeg", quality);
      if (dataUrl.length > 1200 * 1024) {
        dataUrl = c.toDataURL("image/jpeg", 0.5);
      }
      return dataUrl;
    } catch (e) {
      slog("页内压缩失败:" + (e && e.message));
      // 返回 null，调用方当无图，避免 file too large
      return null;
    }
  }

  function imgPart(src) {
    if (!src) return null;
    const url = typeof src === "string" ? src : src && src.url;
    if (!url) return null;
    return { type: "image_url", image_url: { url: url } };
  }

  function sanitizeParts(parts) {
    return (parts || [])
      .map((p) => {
        if (!p || typeof p !== "object") return null;
        if (p.type === "text") return { type: "text", text: String(p.text || "") };
        if (p.type === "image_url") {
          const url =
            typeof p.image_url === "string"
              ? p.image_url
              : p.image_url && p.image_url.url;
          if (!url) return null;
          return { type: "image_url", image_url: { url: url } };
        }
        return null;
      })
      .filter(Boolean);
  }

  function buildOpenAIUserContent(systemPrompt, task, models) {
    const parts = [];
    parts.push({
      type: "text",
      text:
        `编辑指令：\n${task.prompt}\n\n` +
        `请只对下列模型打分，输出 JSON {"scores":[...]}\n` +
        `每个模型 5 维 1–10 整数：alignment/quality/preservation/consistency/realism；无图输出 null 且 notes="no_image"。\n` +
        `模型列表：${models.map((m) => m.id).join(", ")}\n\n` +
        `【强制】不同模型必须给出不同分数向量，禁止复制粘贴同一套分。\n` +
        `【输出比例】先从指令读取目标比例或尺寸（如 1:1、4:3、3:4、16:9、1024×768），再核对每张生成图真实宽高；不符合即为明确指令未完成。\n` +
        `【形态检查】改变画布比例应通过正常裁切、扩图或重构完成；若把原内容非等比拉伸、压扁后硬塞进目标画幅，五维都要扣分。\n` +
        `每个模型的 notes 必须写出该图特有的一条问题（位置+现象），与其他模型不得相同。\n` +
        `若两图都挺好，也要通过「哪张更好」拉开至少 1 分差距。` +
        (task.histHint || ""),
    });

    (task.referenceImages || []).forEach((src, i) => {
      parts.push({ type: "text", text: `reference[${i}]：` });
      const im = imgPart(src);
      if (im) parts.push(im);
    });

    models.forEach((m) => {
      const size = m.meta && Number(m.meta.w) > 0 && Number(m.meta.h) > 0
        ? `，真实尺寸=${Number(m.meta.w)}×${Number(m.meta.h)}`
        : "";
      if (!(m.images || []).length) {
        parts.push({ type: "text", text: `model=${m.id} 无图` });
        return;
      }
      (m.images || []).forEach((src, i) => {
        parts.push({ type: "text", text: `【model=${m.id}${size}】image[${i}]：` });
        const im = imgPart(src);
        if (im) parts.push(im);
      });
    });
    return sanitizeParts(parts);
  }

  /** 评分用精简 system，降低延迟（细则要点保留） */
  const SHORT_SYSTEM = `你是 Edit Bench 图片编辑评测专家。对比「编辑指令 + 参考图 + 生成图」给 5 个整数分 1–10：
alignment 指令遵循, quality 局部质量, preservation 非编辑保持, consistency 全局一致, realism 真实感与美学。

【realism 专条 · 严查 AI 感】只要出现下列任一，realism 最高 7；两项以上或很明显 ≤5：
- 光照不自然：光影方向矛盾、假高光、塑料反光、过曝/欠曝、色温漂移
- 过度磨皮/塑料皮肤/蜡像感、皮肤纹理消失、五官柔糊
- 发丝粘成块、边缘光晕、背景涂抹、细节涂抹感
- 明显生成伪影：多余手指、文字乱码、结构扭曲、重影、噪点块
- 整体「一眼 AI」：电影感假、味精色、无真实摄影颗粒
写实人像/街拍以真实摄影为准；插画/动漫不按照片扣，但仍扣「风格内假光影/糊脸」。

【专家口径】
- 若指令明确要求输出比例或尺寸，必须按该目标宽高比核对生成图真实尺寸（允许约 3% 编码误差）。轻度偏差 alignment≤7，明显比例错误 alignment≤5；画面好看不能抵消。
- 输出画布比例正确不代表内容形态正确。改变比例应通过裁切、扩图或重构完成，禁止把整张图/人物/物体非等比拉宽或压扁。
- 对照参考图检查脸宽、头身比、四肢、服装轮廓、圆形物体与背景透视。人物被非等比压矮、矮胖时，notes 写出人体形态问题；alignment≤6、quality≤5、realism≤4，主要扣局部质量与真实感美学，不应只扣非编辑保持。
- 背景扩图后，原图边界变成画面内部；若原先被边缘裁掉的人仍只剩半身/半个人且没有合理遮挡，属于扩图局部缺陷，quality≤5、realism≤5。正常被最终画面边缘裁切或合理遮挡不扣。
- 左右：写「人物左手/右手」按画中人物自身；只写画面左右按观众视角。Prompt 不清做反只轻扣1分，不算严重不遵循。
- 配件组合（如衬衫+丝巾）：都出现=好；只做一半=轻扣1–2，不连坐其他四维。
- 模糊指令对了勿重扣；明确指令做错才按上限重扣。
- 同题好图与差图必须拉开，禁止同一套高分；好差至少差2分。

其余四维：10 极少；有可见瑕疵最高 8；禁止五维同分；无图五项 null 且 notes="no_image"。
notes≤30字，必须写该图特有缺陷（例：脸部过磨皮、灯向矛盾）。

只输出 JSON：
{"scores":[{"model","alignment","quality","preservation","consistency","realism","notes"}]}`;

  async function callOpenAIBatch(task, models, cfg, userPartsOverride) {
    const base = (cfg.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
    let content = sanitizeParts(
      userPartsOverride || buildOpenAIUserContent(SHORT_SYSTEM, task, models)
    );
    const modelName = cfg.OPENAI_MODEL || "gpt-4o-mini";
    const baseOutputLimit = Math.max(
      128,
      Math.min(4096, Number(cfg.MAX_OUTPUT_TOKENS) || 768)
    );
    const isQwen3Family = /^qwen3(?:[.-]|$)/i.test(modelName);
    const isQwen38Family = /^qwen3\.8(?:-|$)/i.test(modelName);
    const supportsMaxCompletionTokens =
      /^qwen3\.[5-9]-(?:max|plus|flash)(?:-|$)/i.test(modelName);
    const scoringMode = ["fast", "balanced", "thinking"].includes(cfg.SCORING_MODE)
      ? cfg.SCORING_MODE
      : "fast";
    const requestRole = cfg.REQUEST_ROLE === "review" ? "review" : "judge";
    const thinkingEnabled =
      isQwen3Family &&
      (scoringMode === "thinking" ||
        (scoringMode === "balanced" && requestRole === "review"));
    const thinkingBudget = requestRole === "review" ? 512 : 384;
    // Qwen3.8 的最低推理档 low 约等于 4096 token，需要给最终 JSON 留余量。
    const outputLimit = thinkingEnabled
      ? isQwen38Family
        ? Math.max(baseOutputLimit, 4608)
        : Math.max(baseOutputLimit, thinkingBudget + 384)
      : baseOutputLimit;
    const t0 = Date.now();

    // 纯 thinking 型号无法可靠关闭思考，禁止用于高频评分，防止一次任务烧掉数万 token。
    if (/^qwen.*thinking(?:-|$)/i.test(modelName)) {
      const err = new Error(
        "API失败：" + modelName + " 是纯思考模型，不适合高频评分。请改用 instruct 或可关闭思考的模型。"
      );
      err.fatal = true;
      throw err;
    }

    const body = {
      model: modelName,
      temperature: 0.2,
      messages: [
        { role: "system", content: SHORT_SYSTEM },
        { role: "user", content },
      ],
    };
    // 原生 HTTP 请求必须把 enable_thinking 放在 body 顶层。
    if (isQwen3Family) {
      body.enable_thinking = thinkingEnabled;
      if (thinkingEnabled) {
        if (isQwen38Family) {
          body.reasoning_effort = "low";
          slog(`有限思考：${modelName} ${requestRole} effort=low mode=${scoringMode}`);
        } else {
          body.thinking_budget = thinkingBudget;
          slog(
            `有限思考：${modelName} ${requestRole} budget=${thinkingBudget} mode=${scoringMode}`
          );
        }
      } else {
        slog(`成本保护：${modelName} ${requestRole} 已关闭思考 mode=${scoringMode}`);
      }
    }
    // max_completion_tokens 能同时限制思考链和可见回答；其他模型退回 max_tokens。
    if (supportsMaxCompletionTokens) {
      body.max_completion_tokens = outputLimit;
    } else {
      body.max_tokens = outputLimit;
    }
    // thinking / 部分端点不认 response_format，先不带，更快
    if (!/qwen3|thinking/i.test(modelName)) {
      body.response_format = { type: "json_object" };
    }

    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.OPENAI_API_KEY}`,
    };
    const minTimeout = requestRole === "review" ? 10000 : 60000;
    const timeout = Math.max(minTimeout, Number(cfg.TIMEOUT_MS) || 300000);

    slog(
      `请求 ${models.map((m) => m.id).join(",")} model=${modelName} 超时=${(timeout / 1000).toFixed(0)}s`
    );

    const res = await fetchWithRetry(
      base + "/chat/completions",
      { method: "POST", headers, body: JSON.stringify(body), signal: cfg._judgeSignal },
      timeout,
      modelName + " " + models.map((m) => m.id).join(",")
    );

    if (!res.ok) {
      const t = await res.text().catch(() => "");
      const err = new Error("API失败 HTTP " + res.status + " " + t.slice(0, 300));
      err.fatal = res.status === 403 || res.status === 401 || res.status === 400;
      throw err;
    }

    const data = await res.json();
    const usage = data.usage || {};
    const completionDetails = usage.completion_tokens_details || {};
    const promptDetails = usage.prompt_tokens_details || {};
    const inputTokens = Number(usage.prompt_tokens) || 0;
    const outputTokens = Number(usage.completion_tokens) || 0;
    const reasoningTokens = Number(completionDetails.reasoning_tokens) || 0;
    const cachedTokens = Number(promptDetails.cached_tokens) || 0;
    const finishReason = data.choices?.[0]?.finish_reason || "";
    slog(
      `Token ${modelName} 输入=${inputTokens}` +
        (cachedTokens ? `(缓存${cachedTokens})` : "") +
        ` 输出=${outputTokens}` +
        (reasoningTokens ? ` 思考=${reasoningTokens}` : "") +
        (finishReason ? ` finish=${finishReason}` : "")
    );
    if (isQwen3Family && !thinkingEnabled && reasoningTokens > 0) {
      const err = new Error(
        `成本保护触发：${modelName} 仍产生 ${reasoningTokens} 个思考 token，已停止后续评分。`
      );
      err.fatal = true;
      throw err;
    }
    if (finishReason === "length") {
      const err = new Error(
        `成本保护触发：${modelName} 输出达到 ${outputLimit} token 上限，已停止，避免继续重试耗费。`
      );
      err.fatal = true;
      throw err;
    }
    const text = data.choices?.[0]?.message?.content || "{}";
    const parsed = safeJson(text);
    const scores = normalizeScores(parsed);
    slog(
      `响应 ${models.map((m) => m.id).join(",")} 耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s → ${scores.length} 条`
    );
    return scores;
  }

  /**
   * 用指定 VL 模型把 models 全部打一遍分
   * @param cleanTask 已压缩 {prompt, referenceImages, models}
   */
  function isNoImageScore(score) {
    return !!score && (score.notes === "no_image" || score.notes === "image_load_error");
  }

  function isMissingScore(score) {
    return !!score && !isNoImageScore(score) && DIM_KEYS.every((key) => score[key] == null || score[key] === "na");
  }

  function makeMissingScore(model, evaluator, error, phase) {
    const id = normModelId(model && model.id);
    const reason = String(error && error.message || error || "API 未返回有效评分");
    return {
      model: id,
      alignment: null,
      quality: null,
      preservation: null,
      consistency: null,
      realism: null,
      notes: "missing",
      _missing: true,
      _failure: { evaluator: evaluator, modelName: evaluator, imageId: id, reason: reason, phase: phase || "first-round" },
    };
  }

  async function scoreAllWithModel(cleanTask, cfg, modelName, role, phase) {
    const wanted = cleanTask.models.map((m) => normModelId(m.id));
    const byId = new Map();
    const batchSize = Math.max(1, Number(cfg.BATCH_SIZE) || 1);
    const total = Math.ceil(cleanTask.models.length / batchSize);
    const subCfg = { ...cfg, OPENAI_MODEL: modelName, REQUEST_ROLE: "judge" };
    // 逐张/合评都可并发，避免 6 次串行 ×40s+
    const parallel = Math.max(1, Math.min(3, Number(cfg.PARALLEL) || 2));

    const batches = [];
    for (let i = 0; i < cleanTask.models.length; i += batchSize) {
      batches.push(cleanTask.models.slice(i, i + batchSize));
    }

    let step = 0;
    let cursor = 0;
    let fatalErr = null;
    const phaseLabel = phase === "refill" ? "补缺" : "第一轮";

    function markBatchMissing(batch, error) {
      batch.forEach((model) => byId.set(normModelId(model.id), makeMissingScore(model, modelName, error, phaseLabel)));
      slog(`${modelName} ${batch.map((model) => normModelId(model.id)).join(",")} 重试2次仍失败 → 标记 missing，继续后续任务（${String(error && error.message || error)}）`, "err");
    }

    async function runOne(batch) {
      step += 1;
      slog(`[ ${modelName} ] ${phaseLabel}进度 ${step}/${total} …`);
      if (parallel > 1) await new Promise((r) => setTimeout(r, 200));
      let part = null;
      try {
        part = await callOpenAIBatch(cleanTask, batch, subCfg);
      } catch (e) {
        const msg = String(e && e.message);
        if (e && e.channelFailure && !e.fatal) {
          markBatchMissing(batch, e);
          return;
        }
        if (e && e.fatal) {
          cfg._stopJudges?.();
          slog("致命 API 错误，停止本评委：" + msg, "err");
          throw e;
        }
        if (/403|access_denied/i.test(msg)) {
          slog("无权限(403)：" + msg.slice(0, 120), "err");
          const err = new Error(
            "模型无权限(403)：" + modelName + "。请改成已开通的视觉模型（如 qwen-vl-max）。"
          );
          err.fatal = true;
          throw err;
        }
        if (/429|rate limit/i.test(msg)) {
          slog("触发限速，等待 5s 重试");
          await new Promise((r) => setTimeout(r, 5000));
          try {
            part = await callOpenAIBatch(cleanTask, batch, subCfg);
          } catch (e2) {
            slog("重试仍失败：" + (e2 && e2.message), "err");
            if (e2 && e2.channelFailure && !e2.fatal) {
              markBatchMissing(batch, e2);
              return;
            }
            throw e2;
          }
        } else if (/abort|timeout/i.test(msg)) {
          slog("超时：" + batch.map((m) => m.id).join(",") + "，停止本模型", "err");
          const err = new Error(msg);
          err.fatal = true;
          throw err;
        } else {
          slog("本批失败：" + msg, "err");
          throw e;
        }
      }
      if (part) {
        part.forEach((s) => {
          const id = normModelId(s.model);
          if (!id || !wanted.includes(id)) return;
          if (!byId.has(id)) byId.set(id, s);
        });
      }
    }

    async function worker() {
      while (cursor < batches.length && !fatalErr && !cfg._judgeSignal?.aborted) {
        const idx = cursor++;
        const batch = batches[idx];
        try {
          await runOne(batch);
        } catch (e) {
          if (e && e.fatal) {
            fatalErr = e;
            return;
          }
          if (!fatalErr) fatalErr = e;
          return;
        }
      }
    }

    if (parallel <= 1) {
      for (let i = 0; i < batches.length; i++) {
        if (fatalErr || cfg._judgeSignal?.aborted) break;
        try {
          await runOne(batches[i]);
        } catch (e) {
          fatalErr = e;
          break;
        }
        if (i > 0 && batchSize >= 3) {
          await new Promise((r) => setTimeout(r, 800));
        } else if (i > 0) {
          await new Promise((r) => setTimeout(r, 500));
        }
      }
    } else {
      slog(`并发打分 x${parallel}`);
      await Promise.allSettled(Array.from({ length: parallel }, () => worker()));
    }
    if (fatalErr) throw fatalErr;

    const result = wanted.map((id) => {
      const hit = byId.get(id);
      const m = cleanTask.models.find((x) => normModelId(x.id) === id);
      if (hit && !isMissingScore(hit)) return hit;
      if (!m || !m.images || !m.images.length) {
        return hit || {
          model: id,
          alignment: null,
          quality: null,
          preservation: null,
          consistency: null,
          realism: null,
          notes: "no_image",
        };
      }
      const reason = hit && hit._failure ? hit._failure.reason : (hit && hit.notes) || "API 响应中未返回有效评分";
      const missing = makeMissingScore(m, modelName, reason, phaseLabel);
      if (hit && hit._failure) missing._failure = hit._failure;
      return missing;
    });
    const missing = result.filter(isMissingScore);
    const missingIds = missing.map((score) => score.model);
    if (phase === "refill") {
      slog(`补缺评委${role || ""}结果：${result.length - missing.length}/${result.length}${missingIds.length ? `，仍missing=${missingIds.join(",")}` : "，全部恢复"}`);
    } else {
      slog(`评委${role || modelName}完成：${result.length - missing.length}/${result.length}${missingIds.length ? `，missing=${missingIds.join(",")}` : ""}`);
    }
    return result;
  }

  function maxDimDiff(a, b) {
    let mx = 0;
    DIM_KEYS.forEach((k) => {
      if (typeof a[k] === "number" && typeof b[k] === "number") {
        mx = Math.max(mx, Math.abs(a[k] - b[k]));
      }
    });
    return mx;
  }

  /** 2) 缺陷门：≥9 必须有缺陷说明，否则压到 7 */
  function applyDefectGate(list) {
    return list.map((s) => {
      const nums = DIM_KEYS.map((k) => s[k]).filter((v) => typeof v === "number");
      if (!nums.length) return s;
      const defects = Array.isArray(s.defects) ? s.defects : [];
      const notes = String(s.notes || "");
      const justifiedHigh =
        defects.length > 0 ||
        /瑕疵|问题|缺陷|略|轻微|仍可|偏差|泄漏|模糊|放大无问题|未见/.test(notes);
      if (!justifiedHigh) {
        DIM_KEYS.forEach((k) => {
          if (typeof s[k] === "number" && s[k] >= 8) {
            s[k] = Math.min(s[k], 7);
            s.notes = (notes ? notes + " " : "") + "[无缺陷说明≤7]";
          }
        });
      }
      return s;
    });
  }

  /**
   * 1) 整题相对排名：把均分映射到 4–9，禁止扎堆 9/10
   * 保序：原分高的仍高；保留各维相对该模型均分的偏移
   */
  function rankSpreadScores(list, lo, hi) {
    lo = lo == null ? 4 : lo;
    hi = hi == null ? 9 : hi;
    const scored = list.filter((s) => scoreAvg(s) != null);
    if (scored.length < 4) return list;

    const order = scored
      .slice()
      .sort((x, y) => scoreAvg(y) - scoreAvg(x));
    const n = order.length;

    order.forEach((s, i) => {
      const t = n === 1 ? (lo + hi) / 2 : hi - ((hi - lo) * i) / (n - 1);
      const oldAvg = scoreAvg(s);
      DIM_KEYS.forEach((k) => {
        if (typeof s[k] !== "number") return;
        const off = s[k] - oldAvg;
        // 保留维度偏移，略缩放避免又全同
        let v = t + off * 1.15;
        s[k] = Math.max(1, Math.min(10, Math.round(v)));
      });
      // 五维仍相同则微拆
      const now = DIM_KEYS.map((k) => s[k]);
      if (now.every((v) => v === now[0])) {
        s.quality = Math.max(1, s.quality - 1);
        s.consistency = Math.max(1, s.consistency - 1);
      }
    });

    const avgs = order.map(scoreAvg);
    slog(
      `相对排名：n=${n} 首=${avgs[0].toFixed(1)} 尾=${avgs[n - 1].toFixed(1)} 目标区间 ${lo}–${hi}`
    );
    return list;
  }

  /** 相对排名之后再执行，避免明显非等比形变被名次映射重新抬成高分。 */
  function applyGeometryDistortionCaps(list) {
    const re = /非等比|比例失真|比例异常|形态失真|横向(?:拉宽|变宽)|纵向(?:压扁|压缩|变短)|整图.{0,4}(?:拉伸|挤压|压扁)|人物.{0,4}(?:拉伸|挤压|压扁|矮胖|压矮)|身体.{0,4}(?:拉伸|挤压|压扁|矮胖|压矮)|模特.{0,5}(?:矮胖|变胖|压矮)/i;
    const truncated = /(?:背景|画面边缘|原图边缘).{0,16}(?:半个人|半个模特|人物断截|人物截断|残缺人物|只剩半身|只剩半个)|(?:半个人|半个模特|人物断截|人物截断|残缺人物|只剩半身).{0,16}(?:背景|扩图|边缘)/i;
    return list.map((s) => {
      if (!s || scoreAvg(s) == null) return s;
      const evidence = `${s.notes || ""} ${JSON.stringify(s.defects || [])}`;
      const notes = String(s.notes || "");
      const noTruncation = /(?:未见|没有|无明显|并未).{0,8}(?:半个人|断截|截断|残缺)/i.test(evidence);
      const noDistortion = /(?:未见|没有|无明显|并未).{0,8}(?:非等比|失真|拉伸|挤压|压扁|矮胖|变胖)/i.test(evidence);
      if (!noDistortion && re.test(evidence)) {
        const caps = { alignment: 6, quality: 5, consistency: 5, realism: 4 };
        DIM_KEYS.filter(k => k !== "preservation").forEach(k => {
          if (typeof s[k] === "number") s[k] = Math.min(s[k], caps[k]);
        });
        if (!/\[形态失真上限\]/.test(notes)) s.notes = `${notes || "人物非等比形态失真"} [形态失真上限]`;
      }
      if (!noTruncation && truncated.test(evidence)) {
        if (typeof s.quality === "number") s.quality = Math.min(s.quality, 5);
        if (typeof s.realism === "number") s.realism = Math.min(s.realism, 5);
        if (!/\[扩图人物断截\]/.test(String(s.notes || ""))) s.notes = `${s.notes || "扩图后背景人物断截"} [扩图人物断截]`;
      }
      return s;
    });
  }

  /** 双模型：分差小取平均；分差大标记审核 */
  function mergeDualScores(listA, listB, threshold) {
    const mapB = new Map(listB.map((s) => [s.model, s]));
    const needReview = [];
    const merged = listA.map((a) => {
      const b = mapB.get(a.model);
      if (!b) return a;
      const aNull = DIM_KEYS.every((k) => a[k] == null);
      const bNull = DIM_KEYS.every((k) => b[k] == null);
      if (aNull && !bNull) return b;
      if (!aNull && bNull) return a;
      if (aNull && bNull) return a;

      const out = { model: a.model, notes: "", defects: a.defects || [] };
      DIM_KEYS.forEach((k) => {
        if (typeof a[k] === "number" && typeof b[k] === "number") {
          out[k] = Math.round((a[k] + b[k]) / 2);
        } else {
          out[k] = a[k] != null ? a[k] : b[k];
        }
      });
      const diff = maxDimDiff(a, b);
      out._diff = diff;
      out._a = a;
      out._b = b;
      if (diff >= threshold) {
        needReview.push(out);
        out.notes = (a.notes || "") + ` [双分差${diff}→待审]`;
      } else {
        out.notes = (a.notes ? a.notes + " " : "") + `[双模型±${diff}取中]`;
      }
      return out;
    });
    return { merged, needReview };
  }

  /** 规则审核：A–D 过低、P–S 过高 */
  const POLICY_LOW = { A: 1, B: 1, C: 1, D: 1 };
  const POLICY_HIGH = { P: 1, Q: 1, R: 1, S: 1 };

  function avgScore(s) {
    const v = DIM_KEYS.map((k) => s[k]).filter((x) => typeof x === "number");
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  }

  function pickPolicyReview(items) {
    return items.filter((s) => {
      const avg = avgScore(s);
      if (avg == null) return false;
      const id = String(s.model || "").toUpperCase();
      if (POLICY_LOW[id] && avg < 5) {
        s._policy = `规则审核:${id}均分${avg.toFixed(1)}<5`;
        return true;
      }
      if (POLICY_HIGH[id] && avg >= 9) {
        s._policy = `规则审核:${id}均分${avg.toFixed(1)}≥9`;
        return true;
      }
      return false;
    });
  }

  async function applyPolicyReview(cleanTask, scores, cfg, deadline) {
    const hit = pickPolicyReview(scores);
    if (!hit.length) return scores;
    slog(`规则审核触发 ${hit.map((h) => h.model + " " + h._policy).join(" | ")}`);
    const revModel = String(cfg.OPENAI_MODEL_REVIEW || "").trim();
    if (!revModel) {
      hit.forEach((h) => {
        h.notes = ((h.notes || "") + " ⚠" + h._policy + "(无审核模型)").trim();
      });
      return scores;
    }
    const reviewed = await reviewScores(cleanTask, hit, cfg, deadline);
    const map = new Map(reviewed.map((s) => [s.model, s]));
    return scores.map((s) => {
      const r = map.get(s.model);
      if (!r) return s;
      return {
        ...r,
        notes: ((r.notes || "") + " ⚠已规则审核").trim(),
      };
    });
  }

  /**
   * 审核次数上限 + 时间预算，防止 15 个模型各审 2 分钟导致超时。
   * 优先审分差最大的；deadline 可跨多次 reviewScores 共用。
   */
  function capReviewList(items, cfg, deadline) {
    const max = Math.max(0, Number(cfg.MAX_REVIEW ?? 3));
    if (deadline && Date.now() > deadline) {
      slog("审核时间预算用完，跳过剩余审核");
      return [];
    }
    const list = (items || [])
      .slice()
      .sort((x, y) => (Number(y._diff) || 0) - (Number(x._diff) || 0));
    if (list.length > max) {
      slog(
        `审核裁剪到 ${max} 个（按分差优先：${list
          .slice(0, max)
          .map((x) => x.model + "±" + (x._diff || 0))
          .join(",")}）`
      );
      return list.slice(0, max);
    }
    return list;
  }

  async function reviewScores(cleanTask, items, cfg, deadline) {
    const revModel = cfg.OPENAI_MODEL_REVIEW;
    if (!revModel || !items.length) return items;
    if (!deadline) {
      deadline = Date.now() + Math.max(20000, Number(cfg.REVIEW_BUDGET_MS) || 90000);
    }
    const queue = capReviewList(items, cfg, deadline);
    const out = [];
    const skipped = items.filter((x) => !queue.includes(x));
    skipped.forEach((item) => {
      out.push({
        model: item.model,
        alignment: item.alignment,
        quality: item.quality,
        preservation: item.preservation,
        consistency: item.consistency,
        realism: item.realism,
        notes: ((item.notes || "") + " [未审核保留均值]").trim(),
      });
    });
    for (const item of queue) {
      if (Date.now() > deadline) {
        slog("审核超预算，剩余改用均值");
        out.push({
          model: item.model,
          alignment: item.alignment,
          quality: item.quality,
          preservation: item.preservation,
          consistency: item.consistency,
          realism: item.realism,
          notes: ((item.notes || "") + " [审核超时用均值]").trim(),
        });
        continue;
      }
      const one = cleanTask.models.find((m) => normModelId(m.id) === item.model);
      if (!one) {
        out.push(item);
        continue;
      }
      const a = item._a || item;
      const b = item._b || item;
      const userParts = [];
      userParts.push({
        type: "text",
        text:
          `编辑指令：\n${cleanTask.prompt}\n\n` +
          `两个评委对 model=${item.model} 打分不一致（分差 ${item._diff}）。\n` +
          `评委A：${DIM_KEYS.map((k) => k + "=" + a[k]).join(" ")} notes=${a.notes || ""}\n` +
          `评委B：${DIM_KEYS.map((k) => k + "=" + b[k]).join(" ")} notes=${b.notes || ""}\n` +
          `请对照下列图片独立裁决，只输出 JSON {"model","alignment","quality","preservation","consistency","realism","notes"}，1–10 整数或 null。禁止五维同分。`,
      });
      (cleanTask.referenceImages || []).forEach((src, i) => {
        userParts.push({ type: "text", text: `reference[${i}]` });
        userParts.push(imgPart(src));
      });
      userParts.push({ type: "text", text: `【model=${item.model}】` });
      (one.images || []).forEach((src, i) => {
        userParts.push({ type: "text", text: `image[${i}]` });
        userParts.push(imgPart(src));
      });

      const remainingMs = Math.max(10000, deadline - Date.now());
      const subCfg = {
        ...cfg,
        OPENAI_MODEL: revModel,
        REQUEST_ROLE: "review",
        TIMEOUT_MS: Math.min(Number(cfg.TIMEOUT_MS) || 300000, remainingMs),
      };
      slog(`审核 ${item.model} → ${revModel}`);
      try {
        const scores = await callOpenAIBatch(
          { prompt: cleanTask.prompt, referenceImages: [], models: [one] },
          [one],
          subCfg,
          userParts
        );
        const hit = scores.find((s) => normModelId(s.model) === item.model) || scores[0];
        if (hit && scoreAvg(hit) != null) {
          out.push({
            ...hit,
            model: item.model,
            notes: (hit.notes || "") + " [已审核]",
          });
          slog(`审核完成 ${item.model} avg=${scoreAvg(hit).toFixed(1)}`);
          continue;
        }
      } catch (e) {
        if (e && e.fatal) throw e;
        slog(`审核失败 ${item.model} ${e && e.message}`, "err");
      }
      out.push({
        model: item.model,
        alignment: item.alignment,
        quality: item.quality,
        preservation: item.preservation,
        consistency: item.consistency,
        realism: item.realism,
        notes: (item.notes || "") + " [审核失败用均值]",
      });
    }
    return out;
  }

  /**
   * @param {object} task {prompt, referenceImages, models}
   * @param {object} cfg
   */
  async function evaluate(task, cfg) {
    if (!evaluate._bgPinged) {
      evaluate._bgPinged = true;
      try {
        const pong = await chrome.runtime.sendMessage({ type: "SIRISER_BG_PING" });
        slog("bg ping=" + JSON.stringify(pong || null));
      } catch (e) {
        slog("bg ping 失败:" + (e && e.message));
      }
    }
    // 图统一压到小 JPEG，避免 Multimodal file size is too large
    // 逐张 768；合评 3 张时用 576，控制总 payload
    const batchSizeHint = Math.max(1, Number(cfg.BATCH_SIZE) || 1);
    // 略压图加快 VL 推理：逐张 640 / 合评 512
    const maxEdge = batchSizeHint >= 3 ? 512 : 640;
    const quality = batchSizeHint >= 3 ? 0.68 : 0.72;

    const refImgs = [];
    for (const s of task.referenceImages || []) {
      const d = await toImagePayload(s, maxEdge, quality);
      refImgs.push(d);
      slog("ref 压缩 " + (d && String(d).length) + " chars");
    }
    const models = [];
    for (const m of task.models || []) {
      const imgs = [];
      for (const s of m.images || []) {
        let d = await toImagePayload(s, maxEdge, quality);
        const kb = d ? Math.round(String(d).length / 1024) : 0;
        // <20KB 多半是坏图/占位，再压一档更大的试试
        if (d && String(d).startsWith("data:") && kb < 20) {
          const d2 = await toImagePayload(s, 1024, 0.85);
          const kb2 = d2 ? Math.round(String(d2).length / 1024) : 0;
          if (kb2 > kb) d = d2;
          slog(`img ${m.id} 图过小 ${kb}KB→${kb2}KB（接口易判无分）`);
        }
        const ok = !!(d && String(d).startsWith("data:"));
        slog(`img ${m.id} ${ok ? "ok " + Math.round(String(d).length / 1024) + "KB" : "FAIL"}`);
        imgs.push(d);
      }
      const good = imgs.filter((x) => x && String(x).startsWith("data:"));
      const send = good.length ? good : imgs.filter(Boolean);
      models.push({
        id: normModelId(m.id),
        name: m.name,
        images: send,
        meta: m.meta && {
          w: Number(m.meta.w) || 0,
          h: Number(m.meta.h) || 0,
        },
      });
    }
    const cleanTask = { prompt: task.prompt, referenceImages: refImgs, models };

    // 1) 自定义 API（整批一次）
    if (cfg.API_URL) {
      const body = (global.buildEvalRequest || ((t) => t))(cleanTask);
      const res = await fetchWithRetry(
        cfg.API_URL,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(cfg.API_KEY ? { Authorization: `Bearer ${cfg.API_KEY}` } : {}),
          },
          body: JSON.stringify(body),
        },
        cfg.TIMEOUT_MS,
        "自定义评分API"
      );
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        throw new Error("API HTTP " + res.status + " " + t.slice(0, 400));
      }
      return applyGeometryDistortionCaps(normalizeScores(await res.json()));
    }

    // 2) OpenAI 兼容：可选双模型 + 分差审核
    if (cfg.OPENAI_API_KEY) {
      const modelA = cfg.OPENAI_MODEL || "gpt-4o-mini";
      const modelB = String(cfg.OPENAI_MODEL_2 || "").trim();
      const modelR = String(cfg.OPENAI_MODEL_REVIEW || "").trim();
      const threshold = Math.max(1, Number(cfg.DUAL_DIFF_THRESHOLD) || 2);

      const modeName =
        cfg.SCORING_MODE === "thinking"
          ? "思考"
          : cfg.SCORING_MODE === "balanced"
            ? "平衡"
            : "快速";
      slog(
        `评分模式=${modeName} 评委A=${modelA}` +
          (modelB ? ` 评委B=${modelB}` : " （单模型）")
      );
      const dual = !!(modelB && modelB !== modelA);
      let scoresA;
      let survivingModel = modelA;
      let scoresB = null;
      const tJudge = Date.now();
      if (dual) {
        // 双评委先各自完成第一轮；单张网络失败被记录为 missing，不中断同评委后续图片。
        slog("双评委并行开跑");
        const controller = new AbortController();
        const judgeCfg = {
          ...cfg, _judgeSignal: controller.signal,
          _stopJudges: () => controller.abort(),
        };
        const runJudge = async (model, role) => {
          try {
            return await scoreAllWithModel(cleanTask, judgeCfg, model, role, "first-round");
          } catch (e) {
            controller.abort();
            throw e;
          }
        };
        const firstRound = await Promise.allSettled([
          runJudge(modelA, "A"),
          runJudge(modelB, "B"),
        ]);
        const firstError = firstRound.find((x) => x.status === "rejected");
        if (firstError) throw firstError.reason;
        scoresA = firstRound[0].value;
        scoresB = firstRound[1].value;

        const refillJudge = async (scores, model, role) => {
          const missingIds = scores.filter(isMissingScore).map((s) => s.model);
          if (!missingIds.length) return scores;
          slog(`开始补缺：${model} × ${missingIds.join(",")}`);
          const missingTask = {
            ...cleanTask,
            models: cleanTask.models.filter((m) => missingIds.includes(normModelId(m.id))),
          };
          const retried = await scoreAllWithModel(missingTask, judgeCfg, model, role, "refill");
          const retryById = new Map(retried.map((s) => [normModelId(s.model), s]));
          return scores.map((original) => {
            if (!isMissingScore(original)) return original;
            const recovered = retryById.get(normModelId(original.model));
            if (recovered && !isMissingScore(recovered)) {
              slog(`补缺成功 ${original.model} → 恢复双评委合并`);
              return recovered;
            }
            return {
              ...original,
              _failure: {
                ...(original._failure || {}),
                evaluator: model,
                modelName: model,
                imageId: original.model,
                reason: recovered && recovered._failure ? recovered._failure.reason : (original._failure && original._failure.reason) || "补缺未返回有效评分",
                phase: "refill",
              },
            };
          });
        };

        // 两个评委都完成第一轮后再进入统一补缺阶段；补缺失败不影响另一评委结果。
        const refillResults = await Promise.allSettled([
          refillJudge(scoresA, modelA, "A"),
          refillJudge(scoresB, modelB, "B"),
        ]);
        const refillError = refillResults.find((x) => x.status === "rejected");
        if (refillError) throw refillError.reason;
        scoresA = refillResults[0].value;
        scoresB = refillResults[1].value;
        survivingModel = modelA;
        slog(`双评委并行完成 用时 ${((Date.now() - tJudge) / 1000).toFixed(0)}s`);
      } else {
        scoresA = await scoreAllWithModel(cleanTask, cfg, modelA, "A", "first-round");
        slog(`评委A 完成 用时 ${((Date.now() - tJudge) / 1000).toFixed(0)}s`);
      }

      if (dual) {
        const aById = new Map(scoresA.map((s) => [normModelId(s.model), s]));
        const bById = new Map(scoresB.map((s) => [normModelId(s.model), s]));
        const aMerged = scoresA.map((a) => {
          const b = bById.get(normModelId(a.model));
          if (isMissingScore(a) && b && !isMissingScore(b)) {
            slog(`补缺失败 ${a.model} → 使用 ${modelB} 单评委结果降级`, "err");
            return { ...b, notes: `${b.notes || ""} [${modelA}缺失，使用${modelB}单评委结果]`.trim(), _singleJudgeFallback: modelB };
          }
          if (isMissingScore(a) && isMissingScore(b)) {
            slog(`两个评委补缺仍失败 ${a.model} → 该图评分失败`, "err");
            return {
              ...a,
              notes: "双评委网络补缺失败",
              _networkFailedBoth: true,
              _failure: [a._failure, b._failure].filter(Boolean),
            };
          }
          return a;
        });
        const bMerged = scoresB.map((b) => {
          const a = aById.get(normModelId(b.model));
          if (isMissingScore(b) && a && !isMissingScore(a)) {
            slog(`补缺失败 ${b.model} → 使用 ${modelA} 单评委结果降级`, "err");
            return { ...a, notes: `${a.notes || ""} [${modelB}缺失，使用${modelA}单评委结果]`.trim(), _singleJudgeFallback: modelA };
          }
          return b;
        });
        const { merged, needReview } = mergeDualScores(aMerged, bMerged, threshold);
        const mergedById = new Map(merged.map((s) => [normModelId(s.model), s]));
        let final = cleanTask.models.map((m) => {
          const id = normModelId(m.id);
          const a = aById.get(id);
          const b = bById.get(id);
          if (isMissingScore(a) && isMissingScore(b)) {
            return { ...a, _networkFailedBoth: true, _failure: [a._failure, b._failure].filter(Boolean) };
          }
          return mergedById.get(id) || a || b;
        });
        slog(`双模型合并：待审 ${needReview.length} 个 / 阈值 ${threshold}`);
        const reviewDeadline = Date.now() + Math.max(20000, Number(cfg.REVIEW_BUDGET_MS) || 90000);
        if (needReview.length && modelR) {
          const reviewed = await reviewScores(cleanTask, needReview, cfg, reviewDeadline);
          const revMap = new Map(reviewed.map((s) => [s.model, s]));
          final = final.map((m) => revMap.get(m.model) || m);
        }
        const reviewed2 = await applyPolicyReview(cleanTask, final, cfg, reviewDeadline);
        return applyGeometryDistortionCaps(rankSpreadScores(reviewed2));
      }

      // 空分：用当前存活评委重试一次，避免再次调用失败渠道。
      for (let i = 0; i < scoresA.length; i++) {
        const s = scoresA[i];
        const localHasImg = models.some(
          (m) => normModelId(m.id) === s.model && m.images && m.images.length
        );
        const allNull = DIM_KEYS.every((k) => s[k] == null);
        if (!localHasImg || !allNull) continue;
        try {
          slog(`重评 ${s.model}`);
          const one = cleanTask.models.filter((m) => normModelId(m.id) === s.model);
          const retry = await callOpenAIBatch(
            { prompt: cleanTask.prompt, referenceImages: [], models: one },
            one,
            { ...cfg, OPENAI_MODEL: survivingModel, TIMEOUT_MS: 60000, REQUEST_ROLE: "judge" }
          );
          const hit =
            retry.find((r) => normModelId(r.model) === s.model) ||
            retry.find((r) => scoreAvg(r) != null) ||
            retry[0];
          if (hit && scoreAvg(hit) != null) {
            scoresA[i] = { ...hit, model: s.model };
            slog(`重评成功 ${s.model}`);
          }
        } catch (e) {
          if (e && e.fatal) throw e;
          slog(`重评失败 ${s.model} ${e && e.message}`);
        }
        if (scoreAvg(scoresA[i]) == null) {
          scoresA[i] = { ...scoresA[i], notes: "api_returned_null" };
        }
      }

      const reviewDeadline2 =
        Date.now() + Math.max(20000, Number(cfg.REVIEW_BUDGET_MS) || 90000);
      const reviewed3 = await applyPolicyReview(cleanTask, scoresA, cfg, reviewDeadline2);
      return applyGeometryDistortionCaps(rankSpreadScores(reviewed3));
    }

    throw new Error("未配置 API_URL 或 OPENAI_API_KEY");
  }

  global.SiriserAPI = {
    evaluate,
    normalizeScores,
    clampScore,
    toImagePayload,
    mergeDualScores,
  };
})(typeof self !== "undefined" ? self : window);
