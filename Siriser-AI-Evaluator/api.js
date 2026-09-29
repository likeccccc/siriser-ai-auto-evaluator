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

  function slog(msg) {
    try {
      if (global.SIRISER_PAGE_LOG) global.SIRISER_PAGE_LOG(msg);
      else console.log("[Siriser]", msg);
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
    return { type: "image_url", image_url: { url: src } };
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
        `每个模型的 notes 必须写出该图特有的一条问题（位置+现象），与其他模型不得相同。\n` +
        `若两图都挺好，也要通过「哪张更好」拉开至少 1 分差距。`,
    });

    (task.referenceImages || []).forEach((src, i) => {
      parts.push({ type: "text", text: `reference[${i}]：` });
      parts.push(imgPart(src));
    });

    models.forEach((m) => {
      if (!(m.images || []).length) {
        parts.push({ type: "text", text: `model=${m.id} 无图` });
        return;
      }
      (m.images || []).forEach((src, i) => {
        parts.push({ type: "text", text: `【model=${m.id}】image[${i}]：` });
        parts.push(imgPart(src));
      });
    });
    return parts;
  }

  /** 评分用精简 system，降低延迟（细则要点保留） */
  const SHORT_SYSTEM = `你是 Edit Bench 图片编辑评测专家。对比「编辑指令 + 参考图 + 生成图」给 5 个整数分 1–10：
alignment 指令遵循, quality 局部质量, preservation 非编辑保持, consistency 全局一致, realism 真实美学。
只给 JSON {"scores":[{"model","alignment","quality","preservation","consistency","realism","notes"}]}。
无图五项 null 且 notes="no_image"。从严：10 极少；有可见瑕疵最高 8；禁止五维同分。
若一次评多个模型：必须拉开相对差距，禁止人人同一套高分。notes≤30字写该图特有问题。`;

  async function callOpenAIBatch(task, models, cfg, userPartsOverride) {
    const base = (cfg.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
    const content =
        userPartsOverride ||
        buildOpenAIUserContent(SHORT_SYSTEM, task, models);
    const modelName = cfg.OPENAI_MODEL || "gpt-4o-mini";
    const t0 = Date.now();

    const body = {
      model: modelName,
      temperature: 0.2,
      messages: [
        { role: "system", content: SHORT_SYSTEM },
        { role: "user", content },
      ],
    };
    // Qwen3 thinking 模型默认会「想」很久；评分任务必须关思考
    const isThinkingName = /thinking/i.test(modelName);
    if (/qwen3|thinking/i.test(modelName)) {
      body.enable_thinking = false;
      body.thinking = { type: "disabled" };
      // 部分网关要放在 extra_body
      body.extra_body = { enable_thinking: false };
    }
    if (isThinkingName) {
      slog("警告：模型名含 thinking，已强制 enable_thinking=false；建议改用 …-instruct");
    }
    // thinking / 部分端点不认 response_format，先不带，更快
    if (!/qwen3|thinking/i.test(modelName)) {
      body.response_format = { type: "json_object" };
    }

    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.OPENAI_API_KEY}`,
    };
    const timeout = Math.max(60000, Number(cfg.TIMEOUT_MS) || 300000);

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
      slog("HTTP400 " + errText.slice(0, 120));
      delete body.response_format;
      delete body.enable_thinking;
      delete body.thinking;
      res = await doPost(body);
      if (!res.ok) {
        const t2 = await res.text().catch(() => "");
        throw new Error("OpenAI HTTP " + res.status + " " + t2.slice(0, 400));
      }
    }

    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error("OpenAI HTTP " + res.status + " " + t.slice(0, 400));
    }

    const data = await res.json();
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
    const subCfg = { ...cfg, OPENAI_MODEL: modelName };
    let step = 0;
    for (let i = 0; i < cleanTask.models.length; i += batchSize) {
      const batch = cleanTask.models.slice(i, i + batchSize);
      step += 1;
      if (i > 0) await new Promise((r) => setTimeout(r, batchSize >= 3 ? 800 : 500));
      slog(`[ ${modelName} ] 进度 ${step}/${total} …`);
      let part = null;
      try {
        part = await callOpenAIBatch(cleanTask, batch, subCfg);
      } catch (e) {
        const msg = String(e && e.message);
        if (/403|access_denied/i.test(msg)) {
          slog("无权限(403)：" + msg.slice(0, 120), "err");
          throw new Error(
            "模型无权限(403)：" + modelName + "。请改成已开通的视觉模型（如 qwen-vl-max）。"
          );
        }
        if (/429|rate limit/i.test(msg)) {
          slog("触发限速，等待 5s 重试");
          await new Promise((r) => setTimeout(r, 5000));
          try {
            part = await callOpenAIBatch(cleanTask, batch, subCfg);
          } catch (e2) {
            slog("重试仍失败：" + (e2 && e2.message), "err");
          }
        } else if (/abort|timeout/i.test(msg)) {
          slog("超时：" + batch.map((m) => m.id).join(",") + "，跳过本批", "err");
        } else {
          slog("本批失败：" + msg, "err");
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

  /** 分差大时：审核模型在两套分里裁决 */
  async function reviewScores(cleanTask, items, cfg) {
    const revModel = cfg.OPENAI_MODEL_REVIEW;
    if (!revModel || !items.length) return items;
    const out = [];
    for (const item of items) {
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

      const subCfg = { ...cfg, OPENAI_MODEL: revModel };
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
    const maxEdge = batchSizeHint >= 3 ? 576 : 768;
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
      return normalizeScores(await res.json());
    }

    // 2) OpenAI 兼容：可选双模型 + 分差审核
    if (cfg.OPENAI_API_KEY) {
      const modelA = cfg.OPENAI_MODEL || "gpt-4o-mini";
      const modelB = String(cfg.OPENAI_MODEL_2 || "").trim();
      const modelR = String(cfg.OPENAI_MODEL_REVIEW || "").trim();
      const threshold = Math.max(1, Number(cfg.DUAL_DIFF_THRESHOLD) || 2);

      slog(`评委A=${modelA}` + (modelB ? ` 评委B=${modelB}` : " （单模型）"));
      const scoresA = await scoreAllWithModel(cleanTask, cfg, modelA);

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
            { prompt: cleanTask.prompt, referenceImages: [], models: one },
            one,
            { ...cfg, OPENAI_MODEL: modelA, TIMEOUT_MS: 60000 }
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
      if (modelB && modelB !== modelA) {
        slog(`评委B 开跑 ${modelB}`);
        const scoresB = await scoreAllWithModel(cleanTask, cfg, modelB);
        const { merged, needReview } = mergeDualScores(scoresA, scoresB, threshold);
        slog(`双模型合并：待审 ${needReview.length} 个 / 阈值 ${threshold}`);
        if (needReview.length && modelR) {
          const reviewed = await reviewScores(cleanTask, needReview, cfg);
          const revMap = new Map(reviewed.map((s) => [s.model, s]));
          return rankSpreadScores(merged.map((m) => revMap.get(m.model) || m));
        }
        return rankSpreadScores(merged);
      }

      return rankSpreadScores(scoresA);
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
