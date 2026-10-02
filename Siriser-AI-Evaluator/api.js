/**
 * 评分 API：自定义 HTTP 或 OpenAI 兼容（含通义 qwen-vl-*）
 * 要点：跨域图走 background；分批送模型；兼容无 response_format 的服务
 */
(function (global) {
  "use strict";

  async function fetchWithTimeout(url, options, timeoutMs) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs || 90000);
    try {
      const res = await fetch(url, { ...options, signal: ctrl.signal });
      return res;
    } finally {
      clearTimeout(t);
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
      flags: global.SiriserScoringPolicy.normalize(s.flags),
      highEvidence: global.SiriserScoringPolicy.normalizeEvidence(s.highEvidence),
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
        `逐张独立按证据打分，同质量允许同分。\n` +
        `【输出比例】先从指令读取目标比例或尺寸（如 1:1、4:3、3:4、16:9、1024×768），再核对每张生成图真实宽高；不符合即为明确指令未完成。\n` +
        `【形态检查】改变画布比例应通过正常裁切、扩图或重构完成；若把原内容非等比拉伸、压扁后硬塞进目标画幅，五维都要扣分。\n` +
        `每个模型返回flags及简短notes；9/10的维度须返回highEvidence:{维度名:"具体核查结果"}，每条尽量≤16字。不强行找问题；本次响应所有模型合计最多4条flags，优先严重缺陷，证据尽量≤20字，避免重复notes。` +
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


  const EVIDENCE_SYSTEM = `你是图片编辑评测专家，对照指令、参考图与生成图，独立给五维1–10整数分：alignment指令遵循、quality局部质量、preservation非编辑保持、consistency全局一致、realism真实感与美学。1–3严重失败，4–5明显问题，6–7部分完成，8轻微问题，9–10高度完成。按各维实际表现打分，允许五维同分；无图五维null，notes="no_image"，flags=[]。只输出JSON {"scores":[{"model":"A","alignment":8,"quality":8,"preservation":9,"consistency":9,"realism":8,"notes":"简短结论","flags":[]}]}。\n` + global.SiriserScoringPolicy.prompt;

  async function callOpenAIBatch(task, models, cfg, userPartsOverride) {
    const base = (cfg.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
    let content = sanitizeParts(
      userPartsOverride || buildOpenAIUserContent(EVIDENCE_SYSTEM, task, models)
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
        { role: "system", content: EVIDENCE_SYSTEM },
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

    const doPost = (b) =>
      fetchWithTimeout(
        base + "/chat/completions",
        { method: "POST", headers, body: JSON.stringify(b) },
        timeout
      );

    let res;
    try {
      res = await doPost(body);
    } catch (e) {
      if (/abort/i.test(String(e && e.message))) {
        throw new Error(
          `请求超时(${(timeout / 1000).toFixed(0)}s) ${models.map((m) => m.id).join(",")} model=${modelName}`
        );
      }
      throw e;
    }

    if (res.status === 400) {
      const errText = await res.text().catch(() => "");
      slog("HTTP400 " + errText.slice(0, 140));
      // 模型根本不认图片：立刻失败，禁止纯文本瞎猜（浪费 token）
      if (/unexpected item type|invalid.*content/i.test(errText)) {
        const err = new Error(
          "API失败：模型" + modelName + " 拒收多模态内容（Unexpected item type）。请换带 vl 的视觉模型。"
        );
        err.fatal = true;
        throw err;
      }
      let canRetrySafely = false;
      if (/response_format|json_object|json_schema/i.test(errText) && body.response_format) {
        delete body.response_format;
        canRetrySafely = true;
        slog("端点不支持 response_format，保留成本保护后重试");
      }
      if (/max_completion_tokens/i.test(errText) && body.max_completion_tokens) {
        delete body.max_completion_tokens;
        body.max_tokens = outputLimit;
        canRetrySafely = true;
        slog("端点不支持 max_completion_tokens，改用 max_tokens 重试");
      }
      // 对已知支持关闭思考的 Qwen3，绝不删除此参数后裸跑。
      if (/enable_thinking/i.test(errText) && !isQwen3Family) {
        delete body.enable_thinking;
        canRetrySafely = true;
      }
      if (!canRetrySafely) {
        const err = new Error("API失败 HTTP 400 " + errText.slice(0, 300));
        err.fatal = true;
        throw err;
      }
      res = await doPost(body);
      if (!res.ok) {
        const t2 = await res.text().catch(() => "");
        const err = new Error("API失败 HTTP " + res.status + " " + t2.slice(0, 300));
        err.fatal = true;
        throw err;
      }
    }

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
  async function scoreAllWithModel(cleanTask, cfg, modelName) {
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

    async function runOne(batch) {
      step += 1;
      slog(`[ ${modelName} ] 进度 ${step}/${total} …`);
      if (parallel > 1) await new Promise((r) => setTimeout(r, 200));
      let part = null;
      try {
        part = await callOpenAIBatch(cleanTask, batch, subCfg);
      } catch (e) {
        const msg = String(e && e.message);
        if (e && e.fatal) {
          slog("致命错误，停止评分：" + msg, "err");
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
      while (cursor < batches.length && !fatalErr) {
        const idx = cursor++;
        const batch = batches[idx];
        try {
          await runOne(batch);
        } catch (e) {
          if (e && e.fatal) {
            fatalErr = e;
            return;
          }
          fatalErr = e;
          return;
        }
      }
    }

    if (parallel <= 1) {
      for (let i = 0; i < batches.length; i++) {
        if (fatalErr) break;
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
      await Promise.all(Array.from({ length: parallel }, () => worker()));
    }
    if (fatalErr) throw fatalErr;

    return wanted.map((id) => {
      const hit = byId.get(id);
      if (hit) return hit;
      const m = cleanTask.models.find((x) => normModelId(x.id) === id);
      return {
        model: id,
        alignment: null,
        quality: null,
        preservation: null,
        consistency: null,
        realism: null,
        notes: m && m.images.length ? "missing_in_response" : "no_image",
      };
    });
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

      const out = { model: a.model, notes: "", defects: a.defects || [], ...global.SiriserScoringPolicy.merge(a.flags, b.flags) };
      DIM_KEYS.forEach((k) => {
        if (typeof a[k] === "number" && typeof b[k] === "number") {
          out[k] = Math.floor((a[k] + b[k]) / 2);
        } else {
          out[k] = a[k] != null ? a[k] : b[k];
        }
      });
      const diff = maxDimDiff(a, b);
      out._diff = diff;
      out._a = a;
      out._b = b;
      out.highEvidence = {};
      const ea = global.SiriserScoringPolicy.normalizeEvidence(a.highEvidence);
      const eb = global.SiriserScoringPolicy.normalizeEvidence(b.highEvidence);
      DIM_KEYS.forEach(k => { if (ea[k] && eb[k]) out.highEvidence[k] = ea[k]; });
      if (diff >= threshold || out.pendingFlags.length || global.SiriserScoringPolicy.needsHighReview(out)) {
        needReview.push(out);
        out.notes = (a.notes || "") + ` [分差${diff}/缺陷或高分核查→待审]`;
      } else {
        out.notes = (a.notes ? a.notes + " " : "") + `[双模型±${diff}取中]`;
      }
      return out;
    });
    return { merged, needReview };
  }


  function pickPolicyReview(items) {
    return items.filter((s) => {
      // Dual disagreements have already entered the shared review queue.
      if (s._a || s._reviewed) return false;
      const capped = global.SiriserScoringPolicy.apply([s])[0];
      const conflict = global.SiriserScoringPolicy.needsHighReview(s) || capped.appliedCaps.some(c => s[c.dim] - c.cap >= 2);
      if (conflict) s._policy = "高分依据不足、满分待核查或缺陷与高分冲突";
      return conflict;
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
        notes: ((r.notes || "") + (r._reviewed ? " ⚠已规则审核" : " ⚠规则审核未完成")).trim(),
      };
    });
  }

  /**
   * 审核次数上限 + 时间预算，防止 15 个模型各审 2 分钟导致超时。
   * 优先审严重争议及无依据高分；deadline 可跨多次 reviewScores 共用。
   */
  function capReviewList(items, cfg, deadline) {
    const max = Math.max(0, Number(cfg.MAX_REVIEW ?? 3));
    if (deadline && Date.now() > deadline) {
      slog("审核时间预算用完，跳过剩余审核");
      return [];
    }
    const list = (items || [])
      .slice()
      .sort((x, y) => global.SiriserScoringPolicy.reviewPriority(y) - global.SiriserScoringPolicy.reviewPriority(x));
    if (list.length > max) {
      slog(
        `审核裁剪到 ${max} 个（按缺陷争议/高分风险/分差：${list
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
        ...item,
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
          ...item,
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
          `请复核 model=${item.model} 的评分与缺陷证据（分差 ${item._diff || 0}，${item._policy || "评委结论存在争议"}）。\n` +
          `评委A：${DIM_KEYS.map((k) => k + "=" + a[k]).join(" ")} notes=${a.notes || ""}\n` +
          `评委B：${DIM_KEYS.map((k) => k + "=" + b[k]).join(" ")} notes=${b.notes || ""}\n` +
          `评委A缺陷：${JSON.stringify(a.flags || [])}\n评委B缺陷：${JSON.stringify(b.flags || [])}\n` +
          `本次重点复核高分维度：逐项对照具体属性和保持区域，不沿用评委结论；9/10必须返回对应highEvidence。没有足够可见依据时不进入高分档。\n` +
          `请独立核查争议与证据，仅保留确认的flags，排除不成立项。只输出JSON {"scores":[{"model":"${item.model}","alignment":8,"quality":8,"preservation":8,"consistency":8,"realism":8,"notes":"结论","flags":[]}]}，分数为1–10整数或null，允许同分。`,
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
        const hit = scores.find((s) => normModelId(s.model) === item.model);
        if (hit && scoreAvg(hit) != null) {
          out.push({
            ...hit,
            _reviewed: true,
            model: item.model,
            notes: (hit.notes || "") + " [已审核]",
          });
          slog(`审核完成 ${item.model} avg=${scoreAvg(hit).toFixed(1)}`);
          continue;
        }
      } catch (e) {
        slog(`审核失败 ${item.model} ${e && e.message}`, "err");
      }
      out.push({
        ...item,
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
      const res = await fetchWithTimeout(
        cfg.API_URL,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(cfg.API_KEY ? { Authorization: `Bearer ${cfg.API_KEY}` } : {}),
          },
          body: JSON.stringify(body),
        },
        cfg.TIMEOUT_MS
      );
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        throw new Error("API HTTP " + res.status + " " + t.slice(0, 400));
      }
      return global.SiriserScoringPolicy.apply(normalizeScores(await res.json()));
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
      let scoresB = null;
      const tJudge = Date.now();
      if (dual) {
        // 双评委并行，墙钟时间约减半
        slog("双评委并行开跑");
        const [a, b] = await Promise.all([
          scoreAllWithModel(cleanTask, cfg, modelA),
          scoreAllWithModel(cleanTask, cfg, modelB),
        ]);
        scoresA = a;
        scoresB = b;
        slog(`双评委并行完成 用时 ${((Date.now() - tJudge) / 1000).toFixed(0)}s`);
      } else {
        scoresA = await scoreAllWithModel(cleanTask, cfg, modelA);
        slog(`评委A 完成 用时 ${((Date.now() - tJudge) / 1000).toFixed(0)}s`);
      }

      // 空分：用评委 A 重试一次（保持旧行为）
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
            { prompt: cleanTask.prompt, referenceImages: cleanTask.referenceImages, models: one },
            one,
            { ...cfg, OPENAI_MODEL: modelA, TIMEOUT_MS: 60000, REQUEST_ROLE: "judge" }
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
          slog(`重评失败 ${s.model} ${e && e.message}`);
        }
        if (scoreAvg(scoresA[i]) == null) {
          scoresA[i] = { ...scoresA[i], notes: "api_returned_null" };
        }
      }

      // 双模型
      if (dual) {
        const { merged, needReview } = mergeDualScores(scoresA, scoresB, threshold);
        slog(`双模型合并：待审 ${needReview.length} 个 / 阈值 ${threshold}`);
        let final = merged;
        // 双分差审核 + 规则审核共用同一时间预算，防止叠成 2×90s
        const reviewDeadline =
          Date.now() + Math.max(20000, Number(cfg.REVIEW_BUDGET_MS) || 90000);
        if (needReview.length && modelR) {
          const reviewed = await reviewScores(cleanTask, needReview, cfg, reviewDeadline);
          const revMap = new Map(reviewed.map((s) => [s.model, s]));
          final = merged.map((m) => revMap.get(m.model) || m);
        }
        const reviewed2 = await applyPolicyReview(cleanTask, final, cfg, reviewDeadline);
        // 最终按证据执行上限，不再按相对名次重写绝对分数。
        return global.SiriserScoringPolicy.apply(reviewed2);
      }

      const reviewDeadline2 =
        Date.now() + Math.max(20000, Number(cfg.REVIEW_BUDGET_MS) || 90000);
      const reviewed3 = await applyPolicyReview(cleanTask, scoresA, cfg, reviewDeadline2);
      return global.SiriserScoringPolicy.apply(reviewed3);
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
