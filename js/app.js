/* Siriser Edit Bench — 标注台交互 + Mock AI 评分 */
(function () {
  "use strict";

  const DIMS = [
    {
      key: "alignment",
      title: "指令遵循",
      en: "Edit Instruction Alignment",
      anchors: {
        10: "RCR 98–100% · 核心要求与次要约束全对，近乎完美",
        9: "RCR 90–97% · 关键目标属性正确，仅 1 处轻微偏差",
        8: "RCR 80–89% · 核心完成，1–2 处可见非致命问题",
        7: "RCR 70–79% · 基本完成，1 处重要属性偏差或多处次要遗漏",
        6: "RCR 60–69% · 核心已发生，多处明显问题或 1 条重要要求遗漏",
        5: "RCR 50–59% · 约一半核心要求完成",
        4: "RCR 40–49% · 多条核心遗漏，目标/属性明显错误",
        3: "RCR 20–39% · 大部分核心意图未实现",
        2: "RCR 1–19% · 几乎没有有效编辑",
        1: "RCR≈0% 或核心操作与指令相反",
      },
    },
    {
      key: "quality",
      title: "局部质量",
      en: "Edit Region Quality",
      anchors: {
        10: "专业级：边界干净、纹理连续、细节完整，放大也难找问题",
        9: "优秀：仅极少量轻微瑕疵，不影响观看与使用",
        8: "高质量：1–2 处可感知小问题（轻微模糊/细纹/边缘）",
        7: "良好：明显但局部的问题，仍可正常使用",
        6: "基本合格：边缘/纹理/几何/细节有多处可见缺陷",
        5: "中等：较大比例细节缺陷，目标仍可辨认",
        4: "较差：大量局部缺陷，明显影响使用",
        3: "很差：大范围生成失败，只能部分辨认",
        2: "严重失败：结构基本不可用",
        1: "几乎完全失败：无法形成可信编辑结果",
      },
    },
    {
      key: "preservation",
      title: "非编辑保持",
      en: "Content Preservation",
      anchors: {
        10: "几乎完全保持，无可见泄漏（指令要求的变化不算泄漏）",
        9: "优秀：仅极轻微局部变化，用户通常注意不到",
        8: "高质量：少量低语义位置变化，人脸/身份/关键物稳定",
        7: "良好：多处可见变化，主体身份与核心结构仍稳定",
        6: "基本保持：编辑范围明显超出必要",
        5: "中等：明显泄漏，非目标被重绘/移动，用户可感知",
        4: "较差：大量非目标变化，构图/对应关系显著破坏",
        3: "严重失败：难以视为受控编辑",
        2: "接近完全重绘",
        1: "失去原图对应关系",
      },
    },
    {
      key: "consistency",
      title: "全局一致",
      en: "Global Consistency",
      anchors: {
        10: "完全自然融合，看不出后期编辑",
        9: "优秀融合，仅极轻微光影/色彩/空间误差",
        8: "高质量：轻微可见偏差，普通距离下不突兀",
        7: "良好：一项较明显或多项轻微「有后期痕迹」",
        6: "基本融合：多项融合问题，不真实感明显",
        5: "中等：贴图感明显，至少一项严重不协调",
        4: "较差：与环境明显冲突",
        3: "很差：像来自另一张图",
        2: "严重失败：图层感，逻辑失效",
        1: "完全不可信",
      },
    },
    {
      key: "realism",
      title: "真实美学",
      en: "Realism & Aesthetic",
      anchors: {
        10: "卓越：生产级，几乎无伪影，风格与构图完美",
        9: "优秀：高度可信，极轻微瑕疵",
        8: "高质量：少量生成痕迹或局部清晰度不足",
        7: "良好：多个轻微缺陷，不明显影响整体",
        6: "基本合格：有 AI 生成感",
        5: "中等：问题突出，需后期修正",
        4: "较差：多个严重视觉缺陷",
        3: "很差：可信度很低",
        2: "严重失败：大面积结构错误",
        1: "几乎完全崩坏",
      },
    },
  ];

  const TASKS = [
    {
      id: "EB-001",
      prompt:
        "把女孩的红裙子改成淡粉色，并把背景换成科莫湖（Lake Como），同时保持女孩的脸和姿势不变。",
      reference: "assets/ref-01.jpg",
      models: [
        { id: "A", name: "Model A", image: "assets/gen-A-good.jpg" },
        { id: "B", name: "Model B", image: "assets/gen-B-flaws.jpg" },
        { id: "C", name: "Model C", image: "assets/gen-C-miss.jpg" },
        { id: "D", name: "Model D", image: null }, // 无图样例
        { id: "E", name: "Model E", image: "assets/gen-A-good.jpg" },
        { id: "F", name: "Model F", image: "assets/gen-C-miss.jpg" },
      ],
    },
    {
      id: "EB-002",
      prompt:
        "保持人物身份与构图不变，将裙子颜色改为淡粉色；背景保留湖畔与丝柏树；不要改变脸部、发型与手部。",
      reference: "assets/ref-01.jpg",
      models: [
        { id: "A", name: "Model A", image: "assets/gen-A-good.jpg" },
        { id: "B", name: "Model B", image: "assets/gen-B-flaws.jpg" },
        { id: "C", name: "Model C", image: "assets/gen-C-miss.jpg" },
        { id: "D", name: "Model D", image: "assets/gen-B-flaws.jpg" },
        { id: "E", name: "Model E", image: null },
        { id: "F", name: "Model F", image: "assets/gen-A-good.jpg" },
      ],
    },
  ];

  /** 存储：taskId -> modelId -> scores|null */
  const store = {
    load() {
      try {
        return JSON.parse(localStorage.getItem("siriser_scores") || "{}");
      } catch {
        return {};
      }
    },
    save(data) {
      localStorage.setItem("siriser_scores", JSON.stringify(data));
    },
  };

  const state = {
    taskIndex: 0,
    modelIndex: 0,
    data: store.load(),
  };

  // ── DOM ──
  const $ = (sel, root = document) => root.querySelector(sel);
  const els = {
    taskId: $("#taskId"),
    taskIndex: $("#taskIndex"),
    taskTotal: $("#taskTotal"),
    promptText: $("#promptText"),
    refImage: $("#refImage"),
    modelsGrid: $("#modelsGrid"),
    scoreForm: $("#scoreForm"),
    activeModelLabel: $("#activeModelLabel"),
    aiDot: $("#aiDot"),
    aiStatus: $("#aiStatus"),
    aiProgress: $("#aiProgress"),
    logBox: $("#logBox"),
    toast: $("#toast"),
    modePill: $("#modePill"),
    apiPill: $("#apiPill"),
  };

  function task() {
    return TASKS[state.taskIndex];
  }
  function model() {
    return task().models[state.modelIndex];
  }
  function scoreKey() {
    return task().id + "::" + model().id;
  }
  function getScores(mid) {
    const k = task().id + "::" + (mid || model().id);
    return state.data[k] || emptyScores();
  }
  function emptyScores() {
    return {
      alignment: null,
      quality: null,
      preservation: null,
      consistency: null,
      realism: null,
      notes: "",
    };
  }
  function setScore(dim, val) {
    const k = scoreKey();
    const cur = state.data[k] || emptyScores();
    cur[dim] = val;
    state.data[k] = cur;
    store.save(state.data);
    renderScores();
    renderModels();
  }

  function log(msg, kind) {
    const t = new Date().toTimeString().slice(0, 8);
    const line = document.createElement("div");
    line.innerHTML =
      `<span class="t">[${t}]</span> ` +
      `<span class="${kind || ""}">${escapeHtml(msg)}</span>`;
    els.logBox.appendChild(line);
    els.logBox.scrollTop = els.logBox.scrollHeight;
  }

  function toast(msg) {
    els.toast.textContent = msg;
    els.toast.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => els.toast.classList.remove("show"), 2200);
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  // ── Render ──
  function renderModels() {
    const t = task();
    els.modelsGrid.innerHTML = "";
    t.models.forEach((m, idx) => {
      const sc = getScores(m.id);
      const avg = average(sc);
      const card = document.createElement("article");
      card.className = "model-card" + (idx === state.modelIndex ? " active" : "");
      card.dataset.model = m.id;
      card.dataset.testid = "model-card-" + m.id;
      card.tabIndex = 0;
      card.innerHTML = `
        <div class="model-card-h">
          <span class="model-name">${m.id}</span>
          <span class="model-score-mini">${avg == null ? "—" : avg}</span>
        </div>
        <div class="model-card-b">
          <div class="img-frame">
            <span class="img-label">GEN · ${m.id}</span>
            ${
              m.image
                ? `<img src="${m.image}" alt="Model ${m.id} 生成图" data-testid="model-${m.id}-image" />`
                : `<div class="banner" style="border:none;height:100%;display:flex;align-items:center;justify-content:center;aspect-ratio:auto;min-height:180px">无图</div>`
            }
          </div>
          <p class="model-note ${sc.notes ? "filled" : ""}">${escapeHtml(sc.notes || "待评")}</p>
        </div>
      `;
      card.addEventListener("click", () => {
        state.modelIndex = idx;
        render();
      });
      card.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          state.modelIndex = idx;
          render();
        }
      });
      els.modelsGrid.appendChild(card);
    });
  }

  function average(sc) {
    const keys = DIMS.map((d) => d.key);
    const vals = keys.map((k) => sc[k]).filter((v) => typeof v === "number");
    if (!vals.length) return null;
    return (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1);
  }

  function renderScores() {
    const sc = getScores();
    els.scoreForm.innerHTML = "";
    DIMS.forEach((d) => {
      const val = sc[d.key];
      const box = document.createElement("div");
      box.className = "dim";
      box.dataset.dim = d.key;
      const scoreClass =
        val == null || val === "na"
          ? "null"
          : val <= 4
            ? "low"
            : val <= 6
              ? "mid"
              : "";
      box.innerHTML = `
        <div class="dim-h">
          <div>
            <div class="dim-title">${d.title}</div>
            <div class="dim-key">${d.en}</div>
          </div>
          <div class="dim-score ${scoreClass}" data-testid="score-${d.key}">${
            val == null || val === "na" ? "无" : val
          }</div>
        </div>
        <div class="gauge" role="group" aria-label="${d.title} 评分"></div>
        <div class="anchor-tip" data-role="tip">悬停刻度查看档位锚点。当前：${
          val == null || val === "na"
            ? "未评分"
            : `<strong>${val} 分</strong> — ${d.anchors[val]}`
        }</div>
      `;
      const gauge = box.querySelector(".gauge");
      for (let n = 1; n <= 10; n++) {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = n;
        b.dataset.score = n;
        b.setAttribute("aria-label", `${d.title} ${n} 分`);
        if (val === n) b.classList.add("on");
        b.addEventListener("click", () => setScore(d.key, n));
        b.addEventListener("mouseenter", () => {
          box.querySelector('[data-role="tip"]').innerHTML = `<strong>${n} 分</strong> — ${d.anchors[n]}`;
        });
        gauge.appendChild(b);
      }
      const na = document.createElement("button");
      na.type = "button";
      na.className = "na" + (val === "na" ? " on" : "");
      na.textContent = "无（该模型无图 / 不适用）";
      na.addEventListener("click", () => {
        state.data[scoreKey()] = {
          alignment: "na",
          quality: "na",
          preservation: "na",
          consistency: "na",
          realism: "na",
          notes: "no_image",
        };
        store.save(state.data);
        renderScores();
        renderModels();
        log(`模型 ${model().id} 标记为「无」`, "ok");
      });
      gauge.appendChild(na);
      els.scoreForm.appendChild(box);
    });
  }

  function render() {
    const t = task();
    const m = model();
    els.taskId.textContent = t.id;
    els.taskIndex.textContent = String(state.taskIndex + 1);
    els.taskTotal.textContent = String(TASKS.length);
    els.promptText.textContent = t.prompt;
    els.refImage.src = t.reference;
    els.activeModelLabel.textContent = m.id;
    renderModels();
    renderScores();
  }

  // ── Mock AI 评分（演示用；真实环境走自定义 API）──
  function mockEvaluate(m) {
    // 基于文件名/有无图的启发式演示分，便于走通自动填分流程
    if (!m.image) {
      return {
        model: m.id,
        alignment: "na",
        quality: "na",
        preservation: "na",
        consistency: "na",
        realism: "na",
        notes: "no_image",
        defects: [],
      };
    }
    const bag = m.image.includes("good")
      ? { base: [9, 9, 9, 8, 9], notes: "淡粉略偏玫粉；身份与姿势保持好", rcr: 0.93 }
      : m.image.includes("flaws")
        ? {
            base: [7, 5, 4, 5, 5],
            notes: "脸部身份改变；裙色过艳；背景过度平滑",
            rcr: 0.7,
          }
        : {
            base: [3, 6, 4, 4, 6],
            notes: "裙子未改色；背景被换成城市，语义冲突",
            rcr: 0.35,
          };
    const j = (i) => Math.max(1, Math.min(10, bag.base[i] + (Math.random() < 0.3 ? -1 : 0)));
    return {
      model: m.id,
      alignment: j(0),
      quality: j(1),
      preservation: j(2),
      consistency: j(3),
      realism: j(4),
      rcr: bag.rcr,
      notes: bag.notes,
      defects: [],
    };
  }

  /** 真实 API：POST {apiUrl}，body = buildEvalRequest */
  async function callApi(modelsSubset) {
    const t = task();
    const ref = toDataUrlSafe(t.reference);
    const payload = window.buildEvalRequest({
      prompt: t.prompt,
      referenceImages: [ref],
      models: modelsSubset.map((m) => ({
        id: m.id,
        name: m.name,
        images: m.image ? [toDataUrlSafe(m.image)] : [],
      })),
    });

    // 演示页默认走 mock；若 localStorage 配置了 API_URL 则真调
    const apiUrl = localStorage.getItem("SIRISER_API_URL") || "";
    if (!apiUrl) {
      log("未配置 API_URL，使用本地 Mock 评分器", "");
      return { scores: modelsSubset.map((m) => mockEvaluate(m)) };
    }
    log(`POST ${apiUrl}`, "");
    const res = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${localStorage.getItem("SIRISER_API_KEY") || ""}`,
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error("API " + res.status);
    return await res.json();
  }

  function toDataUrlSafe(src) {
    // 演示页图片是相对路径；真实 content script 会转 canvas/base64
    return src;
  }

  async function autoScore(onlyCurrent) {
    const models = onlyCurrent ? [model()] : task().models;
    els.aiDot.className = "dot live";
    els.aiStatus.textContent = "正在调用评分接口…";
    els.aiProgress.style.width = "10%";
    els.modePill.textContent = "AI 评分中";
    log(`开始自动评分：${models.map((m) => m.id).join(", ")}`);
    try {
      // 模拟延迟，便于观察 UI
      await new Promise((r) => setTimeout(r, 600));
      els.aiProgress.style.width = "45%";
      const result = await callApi(models);
      els.aiProgress.style.width = "80%";
      const scores = result.scores || [];
      scores.forEach((s) => {
        const k = task().id + "::" + s.model;
        state.data[k] = {
          alignment: s.alignment,
          quality: s.quality,
          preservation: s.preservation,
          consistency: s.consistency,
          realism: s.realism,
          notes: s.notes || "",
          rcr: s.rcr,
          defects: s.defects || [],
          source: "ai",
        };
        log(
          `模型 ${s.model}: A${fmt(s.alignment)} Q${fmt(s.quality)} P${fmt(s.preservation)} C${fmt(s.consistency)} R${fmt(s.realism)} · ${s.notes || ""}`,
          "ok"
        );
      });
      store.save(state.data);
      render();
      els.aiProgress.style.width = "100%";
      els.aiDot.className = "dot ok";
      els.aiStatus.textContent = `已完成 ${scores.length} 个模型的 AI 评分，可人工改分后提交。`;
      els.modePill.textContent = "AI 已填 · 待确认";
      toast(`AI 已填写 ${scores.length} 个模型`);
    } catch (e) {
      els.aiDot.className = "dot err";
      els.aiStatus.textContent = "评分失败：" + e.message;
      els.modePill.textContent = "人工评分";
      log("评分失败：" + e.message, "err");
      toast("评分失败：" + e.message);
      els.aiProgress.style.width = "0%";
    }
  }

  function fmt(v) {
    return v == null || v === "na" ? "—" : v;
  }

  // ── Actions ──
  $("#btnAutoAll").addEventListener("click", () => autoScore(false));
  $("#btnAutoOne").addEventListener("click", () => autoScore(true));
  $("#btnClear").addEventListener("click", () => {
    state.data[scoreKey()] = emptyScores();
    store.save(state.data);
    render();
    log(`已清空模型 ${model().id} 的评分`);
    toast("已清空当前模型评分");
  });
  $("#btnSubmit").addEventListener("click", () => {
    const t = task();
    const missing = t.models.filter((m) => {
      const s = getScores(m.id);
      return DIMS.some((d) => s[d.key] == null);
    });
    if (missing.length) {
      toast(`还有 ${missing.length} 个模型未完整评分：${missing.map((m) => m.id).join(", ")}`);
      log("提交被阻止：存在未评分模型", "err");
      return;
    }
    log(`本题 ${t.id} 已提交`, "ok");
    toast(`已提交 ${t.id}`);
    els.modePill.textContent = "已提交";
  });
  $("#btnPrev").addEventListener("click", () => {
    if (state.taskIndex > 0) {
      state.taskIndex -= 1;
      state.modelIndex = 0;
      render();
    }
  });
  $("#btnNext").addEventListener("click", () => {
    if (state.taskIndex < TASKS.length - 1) {
      state.taskIndex += 1;
      state.modelIndex = 0;
      render();
    } else {
      toast("已是最后一题");
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.target.matches("input,textarea,button")) return;
    const n = parseInt(e.key, 10);
    if (n >= 1 && n <= 6) {
      state.modelIndex = n - 1;
      render();
    }
    if (e.key === "a" || e.key === "A") autoScore(true);
    if (e.key === "s" || e.key === "S") $("#btnSubmit").click();
  });

  // 初始
  render();
  log("标注台就绪 · Edit Bench 五维整数分");
  log("快捷键：1–6 切换模型 · A 评当前 · S 提交");
})();
