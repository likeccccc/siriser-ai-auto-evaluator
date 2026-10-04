/**
 * Siriser content script — 左右分栏适配
 * 左内容区：提示词 / 参考图 / 模型-X 图
 * 右回答区：模型-X 五维 radio 1–10 + 无
 */
(function () {
  "use strict";
  // all_frames 时只在顶层页工作，避免提交/日志重复
  try {
    if (window.top !== window.self) return;
  } catch (_) {
    return;
  }

  const CFG = Object.assign({}, window.SIRISER_CONFIG || {});

  /** popup 保存的配置在 chrome.storage，页面刷新后必须重新灌进 CFG */
  function loadConfigFromStorage() {
    return new Promise((resolve) => {
      try {
        if (!chrome?.storage?.sync) return resolve(CFG);
        chrome.storage.sync.get(["SIRISER_CONFIG"], (res) => {
          const saved = res && res.SIRISER_CONFIG;
          if (saved && typeof saved === "object") {
            Object.assign(CFG, saved);
            // SELECTORS/HEURISTIC 保留脚本默认，只覆盖 API 字段
            if (!saved.SELECTORS) {
              /* keep defaults */
            }
            log(
              "已加载存储配置 api=" +
                (CFG.API_URL ? "custom" : CFG.OPENAI_API_KEY ? "openai:" + (CFG.OPENAI_MODEL || "") : "未配置")
            );
          } else {
            log("存储中无 API 配置，仍用脚本默认", "err");
          }
          resolve(CFG);
        });
      } catch (e) {
        log("读取存储配置失败：" + e.message, "err");
        resolve(CFG);
      }
    });
  }
  const DIMS = ["alignment", "quality", "preservation", "consistency", "realism"];
  const HEU = CFG.HEURISTIC || {};

  const LOGS = [];
  function log(msg, kind) {
    const line = `[${new Date().toTimeString().slice(0, 8)}] ${msg}`;
    LOGS.push((kind ? kind + " " : "") + line);
    if (LOGS.length > 300) LOGS.shift();
    console.log("[Siriser]", kind || "", msg);
    try {
      chrome.runtime.sendMessage({ type: "SIRISER_LOG", msg, kind }).catch(() => {});
    } catch (_) {}
  }
  // 供 api.js 写日志
  try {
    window.SIRISER_PAGE_LOG = (msg) => log(msg);
  } catch (_) {}
  function dumpLogs() {
    return LOGS.join("\n");
  }

  function q(sel, root) {
    try {
      return (root || document).querySelector(sel);
    } catch {
      return null;
    }
  }
  function qa(sel, root) {
    try {
      return Array.from((root || document).querySelectorAll(sel));
    } catch {
      return [];
    }
  }

  function visible(el) {
    if (!el) return false;
    // Ant Design 原生 input 常 opacity:0 / 脱流，看外层 wrapper
    if (el.tagName === "INPUT") {
      const host = el.closest("label, .ant-radio-wrapper, .ant-checkbox-wrapper") || el.parentElement;
      if (host && visible(host)) return true;
      const r = el.getBoundingClientRect();
      return r.width > 0 || r.height > 0 || !!el.name;
    }
    const r = el.getBoundingClientRect();
    if (r.width < 3 && r.height < 3) {
      // 可能是图标壳，若子节点可见仍算
      const st = getComputedStyle(el);
      return st.display !== "none" && st.visibility !== "hidden";
    }
    const st = getComputedStyle(el);
    return st.display !== "none" && st.visibility !== "hidden" && Number(st.opacity) !== 0;
  }

  function textOf(el) {
    return ((el && (el.innerText || el.textContent)) || "").replace(/\s+/g, " ").trim();
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function fireClick(el) {
    if (!el) return false;
    // Ant Design：优先点 label.ant-radio-wrapper
    let target = el;
    if (el.tagName === "INPUT") {
      target =
        el.closest("label.ant-radio-wrapper, label.ant-checkbox-wrapper, label") ||
        el.parentElement ||
        el;
    } else {
      const input = el.querySelector?.('input[type="radio"], input[type="checkbox"]');
      if (input) {
        target =
          input.closest("label.ant-radio-wrapper, label.ant-checkbox-wrapper, label") ||
          el;
      }
    }
    const input =
      target.querySelector?.('input[type="radio"], input[type="checkbox"]') ||
      (target.tagName === "INPUT" ? target : null);

    // 轻量点击：先原生 click，大多数 Ant radio 即可选中
    try {
      target.click();
      if (input && !input.checked) input.click();
    } catch (_) {}

    // 兜底：合成事件（比完整 pointer 序列更轻）
    try {
      const opts = { bubbles: true, cancelable: true, view: window, composed: true };
      target.dispatchEvent(new MouseEvent("mousedown", opts));
      target.dispatchEvent(new MouseEvent("mouseup", opts));
      target.dispatchEvent(new MouseEvent("click", opts));
      if (input) {
        input.checked = true;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
    } catch (_) {}
    return true;
  }

  function imgToDataURL(img) {
    try {
      if (!img) return "";
      const src = img.currentSrc || img.src || "";
      if (src.startsWith("data:")) return src;
      // 跨域图会污染 canvas：先试 canvas，失败走 background 拉取
      try {
        const w = img.naturalWidth || img.width || 512;
        const h = img.naturalHeight || img.height || 512;
        const max = 1024;
        const scale = Math.min(1, max / Math.max(w, h));
        const c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(w * scale));
        c.height = Math.max(1, Math.round(h * scale));
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        return c.toDataURL("image/jpeg", 0.85);
      } catch (te) {
        // 跨域污染 canvas：只提示一次，交给 background/base64 管道
        if (!imgToDataURL._warned) {
          imgToDataURL._warned = true;
          log("图片跨域，统一走后台取图");
        }
        return src;
      }
    } catch (e) {
      log("取图失败：" + e.message, "err");
      return (img && (img.currentSrc || img.src)) || "";
    }
  }

  function pickLargestImg(root) {
    const imgs = qa("img", root).filter(visible);
    if (!imgs.length) return q("img", root);
    imgs.sort(
      (a, b) =>
        (b.naturalWidth || b.width) * (b.naturalHeight || b.height) -
        (a.naturalWidth || a.width) * (a.naturalHeight || a.height)
    );
    return imgs[0];
  }

  // ── 区域：内容区 / 回答区 ──
  function findArea(titleRe) {
    // 标题节点
    const heads = qa("div,span,h1,h2,h3,h4,h5,legend,label,p").filter((el) => {
      const t = textOf(el);
      return t.length < 12 && titleRe.test(t) && visible(el);
    });
    if (!heads.length) return null;
    // 取可见且较大的面板
    for (const h of heads) {
      let p = h;
      for (let i = 0; i < 6 && p && p !== document.body; i++) {
        const r = p.getBoundingClientRect();
        // 面板：宽/高足够
        if (r.width > 200 && r.height > 200) return p;
        p = p.parentElement;
      }
      if (h.parentElement) return h.parentElement;
    }
    return heads[0].parentElement || heads[0];
  }

  function getAreas() {
    const content = findArea(HEU.contentAreaText || /^内容区$/);
    const answer = findArea(HEU.answerAreaText || /^回答区$/);
    return { content: content || document.body, answer: answer || document.body };
  }

  // ── 文本标签扫描 ──
  function findTextLabels(re, root) {
    const scope = root || document.body;
    const hits = [];
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        const t = (n.nodeValue || "").trim();
        if (!t || t.length > 30) return NodeFilter.FILTER_REJECT;
        return re.test(t) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    let node;
    while ((node = walker.nextNode())) {
      const el = node.parentElement;
      if (!el || !visible(el)) continue;
      hits.push({ raw: node.nodeValue.trim(), el });
    }
    return hits;
  }

  function extractModelId(text) {
    const m = String(text || "").match(
      HEU.modelPattern || /(?:模型|model)\s*[-–—_：: ]*\s*([A-Za-z0-9]{1,4})/i
    );
    return m ? (m[1] || "").toUpperCase() : "";
  }

  // ── 左侧：图区 ──
  /**
   * 徽章「参考图」「模型-A」通常贴在图片旁/上
   * 策略：找标签 → 邻近 img
   */

  /** 页面上的「模型-X」标签 */
  function findModelLabels() {
    const re =
      HEU.modelPattern ||
      /(?:模型|model|Model)\s*[-–—_：: ]*\s*([A-Za-z0-9]{1,4})/i;
    return findTextLabels(re, document.body).filter((h) => {
      const id = extractModelId(h.raw || textOf(h.el));
      return id && /^[A-Z0-9]{1,4}$/.test(id);
    });
  }

  /** 图片本体已失败：不能用 CSS 渲染尺寸掩盖 naturalWidth=0 的破图 */
  function hasBrokenImageSignature(im) {
    if (!im) return false;
    const src = String(im.currentSrc || im.src || im.getAttribute("src") || "").toLowerCase();
    const lazySrc = String(
      im.getAttribute("data-src") || im.getAttribute("data-original") || ""
    ).toLowerCase();
    const hint = `${src} ${lazySrc} ${im.alt || ""} ${im.title || ""} ${im.className || ""}`.toLowerCase();
    if (/could not process|load[ _-]?error|image[ _-]?error|broken|placeholder|fail(?:ed|ure)?/.test(hint)) {
      return true;
    }
    const nw = Number(im.naturalWidth) || 0;
    const nh = Number(im.naturalHeight) || 0;
    return !!src && im.complete === true && (nw === 0 || nh === 0);
  }

  /** 只把占据图片槽位的破图作为模型候选，排除页面上零尺寸的小图标。 */
  function isBrokenModelImg(im) {
    if (!hasBrokenImageSignature(im)) return false;
    const r = im.getBoundingClientRect ? im.getBoundingClientRect() : null;
    const w = Math.max(Number(im.width) || 0, (r && r.width) || 0);
    const h = Math.max(Number(im.height) || 0, (r && r.height) || 0);
    return w >= 64 || h >= 64;
  }

  /** 真实生成图：排除错误占位图、icon、过小图 */
  function isRealGenImg(im) {
    if (!im) return false;
    if (hasBrokenImageSignature(im)) return false;
    const w = Number(im.naturalWidth) || 0;
    const h = Number(im.naturalHeight) || 0;
    const src = (im.currentSrc || im.src || "").toLowerCase();
    const alt = (im.alt || "").toLowerCase();
    if (im.complete === false || !src) return false;
    if (w < 80 || h < 80) return false;
    if (/could not|error|placeholder|broken|fail/i.test(src + " " + alt)) return false;
    if (/logo|icon|avatar|spinner/i.test(alt + " " + (im.className || ""))) return false;
    return true;
  }

  /** 站点图片加载异常（仅显式失败，不把「暂时没图」当异常） */
  function isImageBroken(labelEl, img) {
    // 文案明确写了加载失败
    const txt = textOf(labelEl && (labelEl.parentElement || labelEl));
    if (/图片加载异常|图片加载失败|图片错误|图裂|无法加载|加载不出/.test(txt)) {
      return true;
    }
    if (!img) return false; // 只是没找到 img，不算异常
    if (hasBrokenImageSignature(img)) return true;
    const w = Number(img.naturalWidth) || 0;
    const h = Number(img.naturalHeight) || 0;
    // 已加载完却只有占位图尺寸
    if (img.complete && w > 0 && h > 0 && w < 80 && h < 80) return true;
    const s = (img.currentSrc || img.src || "").toLowerCase();
    const a = (img.alt || "").toLowerCase();
    if (/could not process|load error|broken|placeholder/i.test(s + " " + a)) return true;
    return false;
  }

  /** 换题后图片可能未加载完（0×0）；等到有尺寸再采集 */
  async function waitForImagesReady(timeoutMs, opts) {
    try {
      const t0 = Date.now();
      const limit = timeoutMs || 15000;
      const notifyOnTimeout = !(opts && opts.notifyOnTimeout === false);
      for (;;) {
        const labels = findModelLabels();
        // 标签左右各一份会重复，必须按去重模型数判断，否则永远等不齐
        const ids = new Set(
          labels
            .map((h) => extractModelId(h.raw || textOf(h.el) || ""))
            .filter(Boolean)
        );
        const need = ids.size || labels.length || 1;
        const pageImgs = qa("img");
        const bigImgs = pageImgs.filter(isRealGenImg).length;
        const brokenImgs = pageImgs.filter(isBrokenModelImg).length;
        const resolvedImgs = bigImgs + brokenImgs;
        if (resolvedImgs >= need) {
          log(`图片就绪 models=${need} ok=${bigImgs} broken=${brokenImgs}`);
          return true;
        }
        if (Date.now() - t0 > limit) {
          log(`等图超时 models=${need} imgs=${bigImgs}`, "err");
          if (notifyOnTimeout) {
            notifyAbnormal(
              "等图超时",
              `模型 ${need} / 正常图 ${bigImgs} / 破图 ${brokenImgs}，${fmtDur(limit)} 内未就绪，将继续评分（可能缺图）`
            ).catch(() => {});
          }
          return false;
        }
        await sleep(400);
      }
    } catch (e) {
      log("等图异常(忽略)：" + (e && e.message));
      return true;
    }
  }
  // 挂到全局，避免打包/注入后作用域找不到
  try {
    window.__SIRISER_WAIT_IMAGES__ = waitForImagesReady;
    window.waitForImagesReady = waitForImagesReady;
  } catch (_) {}

  function collectVisuals() {
    const { content } = getAreas();
    const modelRe = HEU.modelLabel || /(?:模型|model)\s*[-–—_：: ]*\s*([A-Za-z0-9]{1,4})/i;
    const refRe = HEU.refLabel || /^(参考图|原图|参考)$/i;

    const labels = findTextLabels(modelRe, content).concat(
      // 内容区若过窄，退回全文再过滤含 img 的
      []
    );
    // 若内容区没扫到，全文再扫（标签可能不在我们以为的面板里）
    let useLabels = labels;
    if (!useLabels.length) {
      useLabels = findTextLabels(modelRe, document.body);
    }

    const refLabels = findTextLabels(refRe, content).concat(findTextLabels(refRe, document.body));

    function imgNear(labelEl) {
    const grab = (root) => {
      if (!root) return null;
      // 破图也必须与对应模型建立映射，后面才能可靠地五维置「无」。
      const imgs = qa("img", root).filter(
        (im) => isRealGenImg(im) || isBrokenModelImg(im)
      );
      if (!imgs.length) return null;
      if (imgs.length > 4) return null;
      imgs.sort(
        (a, b) =>
          Number(isRealGenImg(b)) - Number(isRealGenImg(a)) ||
          (b.naturalWidth || b.width || 0) * (b.naturalHeight || b.height || 0) -
          (a.naturalWidth || a.width || 0) * (a.naturalHeight || a.height || 0)
      );
      return imgs[0];
    };

    // 1) 祖先
    let p = labelEl;
    for (let i = 0; i < 6 && p; i++) {
      const img = grab(p);
      if (img) return img;
      p = p.parentElement;
    }
    // 2) 前后兄弟
    let sib = labelEl.nextElementSibling;
    for (let i = 0; i < 4 && sib; i++) {
      const img =
        grab(sib) ||
        (sib.tagName === "IMG" && (isRealGenImg(sib) || isBrokenModelImg(sib))
          ? sib
          : null);
      if (img) return img;
      sib = sib.nextElementSibling;
    }
    sib = labelEl.previousElementSibling;
    for (let i = 0; i < 4 && sib; i++) {
      const img =
        grab(sib) ||
        (sib.tagName === "IMG" && (isRealGenImg(sib) || isBrokenModelImg(sib))
          ? sib
          : null);
      if (img) return img;
      sib = sib.previousElementSibling;
    }
    // 3) 几何最近
    const allImgs = qa("img").filter(
      (im) => isRealGenImg(im) || isBrokenModelImg(im)
    );
    const lr = labelEl.getBoundingClientRect();
    let best = null;
    let bestD = 1e9;
    allImgs.forEach((im) => {
      const ir = im.getBoundingClientRect();
      const d = Math.hypot(
        ir.left + ir.width / 2 - (lr.left + lr.width / 2),
        ir.top + ir.height / 2 - (lr.top + lr.height / 2)
      );
      if (d < bestD && d < Math.max(360, ir.height * 1.5)) {
        bestD = d;
        best = im;
      }
    });
    return best;
  }

    function imgMeta(img) {
      if (!img) return { src: "", name: "", w: 0, h: 0 };
      const src = img.currentSrc || img.src || "";
      let name = "";
      try {
        const u = new URL(src, location.href);
        name = decodeURIComponent(u.pathname.split("/").pop() || u.hostname)
          .split("?")[0]
          .slice(0, 24);
      } catch {
        name = src.slice(0, 24);
      }
      return {
        src,
        name,
        w: img.naturalWidth || img.width || 0,
        h: img.naturalHeight || img.height || 0,
      };
    }

    // 参考图
    let refImg = null;
    for (const { el } of refLabels) {
      refImg = imgNear(el);
      if (refImg) break;
    }
    if (!refImg) {
      refImg = qa("img").find((im) =>
        /参考|原图|reference|source/i.test(im.alt || im.title || "")
      );
    }

    // 模型图
    const models = new Map();
    const usedImgs = new Set(refImg ? [refImg] : []);
    useLabels.forEach(({ raw, el }) => {
      const id = extractModelId(raw);
      if (!id) return;
      if (models.has(id)) return;
      let img = imgNear(el);
      if (img) usedImgs.add(img);
      models.set(id, {
        id,
        name: id,
        labelEl: el,
        imgEl: img,
        images: img ? [imgToDataURL(img)] : [],
        meta: imgMeta(img),
        strategy: "left-badge",
      });
    });

    // 漏图兜底：内容区剩余大图，按顺序补给无图模型
    const missing = Array.from(models.values()).filter((m) => !m.imgEl);
    if (missing.length) {
      const pool = qa("img", content === document.body ? document.body : content)
        .concat(qa("img"))
        .filter((im, i, arr) => arr.indexOf(im) === i)
        .filter((im) => !usedImgs.has(im) && isRealGenImg(im))
        .filter((im) => !/logo|icon|avatar/i.test(im.className + (im.alt || "")));
      // 按文档顺序
      pool.sort((a, b) => (domAfter(a, b) ? -1 : 1));
      // 数量不完全一致时无法证明一一对应；宁可置「无」，也不能拿别的模型图顶上。
      if (pool.length === missing.length) {
        missing.forEach((m) => {
          const img = pool.shift();
          if (!img) return;
          usedImgs.add(img);
          m.imgEl = img;
          m.images = [imgToDataURL(img)];
          m.meta = imgMeta(img);
          m.strategy = "pool-fill-exact";
          log(`补图 ${m.id} ← ${m.meta.name} ${m.meta.w}x${m.meta.h}`);
        });
      } else {
        log(
          `补图取消：缺模型 ${missing.length} / 候选图 ${pool.length}，映射不唯一，将按无图处理`,
          "err"
        );
      }
    }

    // 图片加载异常 → 标记 broken，后面五维打「无」
    Array.from(models.values()).forEach((m) => {
      const broken = isImageBroken(m.labelEl, m.imgEl);
      m.broken = broken;
      if (broken) {
        m.images = [];
        m.brokenNote = "image_load_error";
        log(`图 ${m.id} 加载异常 → 五维将勾「无」`, "err");
      }
    });

    Array.from(models.values()).forEach((m) => {
      if (m.broken) return;
      log(
        m.images.length
          ? `图 ${m.id} ${m.meta.name} ${m.meta.w}x${m.meta.h}`
          : `图 ${m.id} 无图`,
        m.images.length ? "" : "err"
      );
    });

    return {
      referenceImages: refImg ? [imgToDataURL(refImg)] : [],
      refImg,
      refMeta: imgMeta(refImg),
      models: Array.from(models.values()).sort((a, b) =>
        a.id.localeCompare(b.id, undefined, { numeric: true })
      ),
    };
  }

  /** 模型↔图片 对照预览：可拖动、可滚动、点图放大 */
  function showMappingPreview() {
    const visual = collectVisuals();
    let panel = document.getElementById("siriser-map");
    if (!panel) {
      panel = document.createElement("div");
      panel.id = "siriser-map";
      panel.innerHTML = `
        <div class="sir-r-h sir-drag">
          <strong>模型 ↔ 图片 对照</strong>
          <span class="sir-r-acts">
            <button type="button" data-r="close">关闭</button>
          </span>
        </div>
        <div class="sir-r-b sir-map-grid" id="siriser-map-body"></div>`;
      document.body.appendChild(panel);
      panel.addEventListener("click", (e) => {
        if (e.target.closest('[data-r="close"]')) {
          panel.classList.remove("open");
          return;
        }
        if (e.target.tagName === "IMG") {
          const cell = e.target.closest(".sir-map-cell");
          openLightbox(
            e.target.src,
            (cell && cell.querySelector(".sir-map-id")?.textContent) || "预览"
          );
        }
      });
      makeDraggable(panel, panel.querySelector(".sir-drag"));
    }
    const body = panel.querySelector("#siriser-map-body");
    const cell = (id, imgEl, meta, isRef) => {
      const src = imgEl ? imgEl.currentSrc || imgEl.src || "" : "";
      const has = !!imgEl;
      const thumb = has
        ? `<img src="${escapeHtml(src)}" alt="${escapeHtml(id)}" loading="lazy" draggable="false" />`
        : `<div class="sir-noimg">无图</div>`;
      const size = meta && meta.w ? `${meta.w}×${meta.h}` : "";
      return `<div class="sir-map-cell${isRef ? " ref" : ""}${has ? "" : " miss"}">
        <div class="sir-map-id"><span>${escapeHtml(id)}</span><span style="color:#8a98a3;font-weight:500">${has ? "有图" : "缺"}</span></div>
        ${thumb}
        <div class="sir-map-meta">${escapeHtml(size)}</div>
      </div>`;
    };
    body.innerHTML =
      cell("参考图", visual.refImg, visual.refMeta, true) +
      visual.models.map((m) => cell("模型-" + m.id, m.imgEl, m.meta)).join("");
    panel.classList.add("open");
    const miss = visual.models.filter((m) => !m.imgEl).map((m) => m.id);
    log(
      miss.length
        ? "对照预览：缺图 " + miss.join(",")
        : "对照预览：全部有图 · n=" + visual.models.length,
      miss.length ? "err" : "ok"
    );
  }

  function openLightbox(src, title) {
    let box = document.getElementById("siriser-lightbox");
    if (!box) {
      box = document.createElement("div");
      box.id = "siriser-lightbox";
      box.innerHTML = `
        <div class="sir-lb-inner">
          <div class="sir-lb-bar">
            <strong id="siriser-lb-title"></strong>
            <button type="button" data-lb="close">关闭</button>
          </div>
          <img id="siriser-lb-img" alt="preview" draggable="false" />
        </div>`;
      document.body.appendChild(box);
      box.addEventListener("click", (e) => {
        if (e.target === box || e.target.closest('[data-lb="close"]')) {
          box.classList.remove("open");
        }
      });
    }
    box.querySelector("#siriser-lb-title").textContent = title || "预览";
    box.querySelector("#siriser-lb-img").src = src;
    box.classList.add("open");
  }

  function makeDraggable(root, handle) {
    if (!root || !handle) return;
    let dr = false,
      sx = 0,
      sy = 0,
      ox = 0,
      oy = 0;
    handle.style.cursor = "grab";
    handle.addEventListener("pointerdown", (e) => {
      if (e.target.closest("button")) return;
      dr = true;
      sx = e.clientX;
      sy = e.clientY;
      const r = root.getBoundingClientRect();
      ox = r.left;
      oy = r.top;
      root.style.right = "auto";
      root.style.bottom = "auto";
      handle.style.cursor = "grabbing";
      try {
        handle.setPointerCapture(e.pointerId);
      } catch (_) {}
    });
    handle.addEventListener("pointermove", (e) => {
      if (!dr) return;
      root.style.left = ox + (e.clientX - sx) + "px";
      root.style.top = oy + (e.clientY - sy) + "px";
    });
    handle.addEventListener("pointerup", (e) => {
      dr = false;
      handle.style.cursor = "grab";
      try {
        handle.releasePointerCapture(e.pointerId);
      } catch (_) {}
    });
  }

  // ── 右侧：评分区 ──
  function dimKeyFromText(t) {
    const aliases = HEU.dimAliases || {};
    for (const key of DIMS) {
      for (const a of aliases[key] || []) {
        if (t.includes(a)) return key;
      }
    }
    if (/Alignment/i.test(t)) return "alignment";
    if (/Region Quality/i.test(t)) return "quality";
    if (/Preservation/i.test(t)) return "preservation";
    if (/Consistency/i.test(t)) return "consistency";
    if (/Realism|Aesthetic/i.test(t)) return "realism";
    return "";
  }

  function isScoreLeaf(el) {
    if (!el) return false;
    if (el.tagName === "INPUT") {
      const v = el.value;
      return v === "na" || v === "无" || (Number(v) >= 0 && Number(v) <= 10);
    }
    // label 里包着 radio
    if (el.querySelector?.('input[type="radio"], input[type="checkbox"]')) {
      const t = textOf(el);
      return t === "无" || t === "N/A" || /^\d{1,2}$/.test(t);
    }
    if (el.children.length > 2 && /^(DIV|UL|OL|SECTION)$/.test(el.tagName)) return false;
    const t = textOf(el);
    if (t === "无" || t === "N/A" || t === "无图") return true;
    if (/^\d{1,2}$/.test(t)) {
      const n = Number(t);
      return n >= 1 && n <= 10;
    }
    return false;
  }

  function scoreKeyFromEl(el) {
    const input = el.tagName === "INPUT" ? el : el.querySelector?.("input");
    const t = textOf(el) || (input && input.value) || "";
    if (t === "无" || t === "N/A" || t === "无图" || (input && input.value === "na"))
      return "na";
    const m = t.match(/^(\d{1,2})$/);
    if (m) {
      const n = Number(m[1]);
      if (n >= 1 && n <= 10) return String(n);
    }
    if (input && /^\d{1,2}$/.test(input.value)) {
      const n = Number(input.value);
      if (n >= 1 && n <= 10) return String(n);
    }
    // label「○ 8」只取第一个数字
    const m2 = t.match(/(?:^|\s)(\d{1,2})(?:\s|$)/);
    if (m2) {
      const n = Number(m2[1]);
      if (n >= 1 && n <= 10) return String(n);
    }
    return "";
  }

  function domAfter(a, b) {
    return !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
  }

  function getAllDimHeaders() {
    return getAllDimHeadersIn(
      getAreas().answer && getAreas().answer !== document.body
        ? getAreas().answer
        : document.body
    );
  }

  function scoreKeyFromRadio(input) {
    const v = input.value;
    if (v === "na" || v === "无") return "na";
    if (/^\d{1,2}$/.test(v)) {
      const n = Number(v);
      if (n >= 1 && n <= 10) return String(n);
    }
    const host = input.closest("label, .ant-radio-wrapper, .ant-checkbox-wrapper") || input.parentElement;
    return scoreKeyFromEl(host) || scoreKeyFromEl(input);
  }

  function radioHost(input) {
    return (
      input.closest(
        "label.ant-radio-wrapper, label.ant-radio-button-wrapper, label.ant-checkbox-wrapper, label"
      ) ||
      input.closest(".ant-radio-button-wrapper, .ant-radio-wrapper, .ant-radio, .ant-checkbox") ||
      input.parentElement ||
      input
    );
  }

  function scoreKeyFromHost(host) {
    if (!host) return "";
    const input = host.querySelector?.('input[type="radio"], input[type="checkbox"]');
    const v = input && input.value;
    if (v === "na" || v === "无") return "na";
    if (v && /^\d{1,2}$/.test(v)) {
      const n = Number(v);
      if (n >= 1 && n <= 10) return String(n);
    }
    // Ant：分数在文案里，value 常为空
    const t = textOf(host).replace(/^\s*\*?\s*/, "");
    if (t === "无" || t === "N/A" || t === "无图") return "na";
    // 「8」「○ 8」「8分」
    const m = t.match(/(?:^|\s)(\d{1,2})(?:\s*$|\s|分)/);
    if (m) {
      const n = Number(m[1]);
      if (n >= 1 && n <= 10) return String(n);
    }
    if (/^\d{1,2}$/.test(t)) {
      const n = Number(t);
      if (n >= 1 && n <= 10) return String(n);
    }
    return "";
  }

  function allRadioLike() {
    const sels = [
      'input[type="radio"]',
      'input[type="checkbox"]',
      "label.ant-radio-wrapper",
      "label.ant-radio-button-wrapper",
      ".ant-radio-button-wrapper",
      ".ant-radio-wrapper",
      '[role="radio"]',
      '[class*="radio-wrapper" i]',
    ];
    const out = [];
    const seen = new Set();
    sels.forEach((sel) => {
      qa(sel).forEach((el) => {
        if (seen.has(el)) return;
        // wrapper 与内部 input 都收时，统一到 host
        let node = el;
        if (el.tagName === "INPUT") node = radioHost(el);
        if (seen.has(node)) return;
        seen.add(node);
        out.push(node);
      });
    });
    return out;
  }

  /**
   * radio 行：每行 = 一个维度的 1–10 + 无
   */
  function collectRadioRows() {
    const hosts = allRadioLike().filter((h) => {
      return visible(h) || (h.tagName === "INPUT" && visible(radioHost(h)));
    });

    // 填 map：同一父级/同一 name 聚成一行
    const rows = [];
    const byName = new Map();
    const byParent = new Map();

    hosts.forEach((host) => {
      const input =
        host.tagName === "INPUT" ? host : host.querySelector('input[type="radio"], input[type="checkbox"]');
      const key = scoreKeyFromHost(host);
      if (!key) return;
      const name = (input && input.name) || "";
      if (name) {
        if (!byName.has(name)) byName.set(name, {});
        if (!byName.get(name)[key]) byName.get(name)[key] = host;
      }
      // 父级聚类
      let p = host.parentElement;
      for (let i = 0; i < 5 && p; i++) {
        const kids = allRadioLike().filter((x) => p.contains(x) || x.contains(p));
        // 更稳：p 下所有 host
        const inP = hosts.filter((x) => p.contains(x));
        const uniq = new Set();
        inP.forEach((x) => {
          const k = scoreKeyFromHost(x);
          if (k) uniq.add(k);
        });
        if (uniq.size >= 6 && uniq.size <= 12) {
          if (!byParent.has(p)) byParent.set(p, {});
          inP.forEach((x) => {
            const k = scoreKeyFromHost(x);
            if (k && !byParent.get(p)[k]) byParent.get(p)[k] = x;
          });
          break;
        }
        p = p.parentElement;
      }
    });

    byName.forEach((map, name) => {
      if (Object.keys(map).length >= 6) {
        const sample = map["1"] || map[Object.keys(map)[0]];
        rows.push({ key: "name:" + name, options: map, sample });
      }
    });
    byParent.forEach((map, el) => {
      if (Object.keys(map).length >= 6) {
        const sample = map["1"] || map[Object.keys(map)[0]];
        // 避免与 name 行重复：sample 已存在则跳过
        const dup = rows.some((r) => r.sample === sample);
        if (!dup) rows.push({ key: "parent:" + rows.length, options: map, sample: el });
      }
    });

    rows.sort((a, b) => (domAfter(a.sample, b.sample) ? -1 : 1));
    return rows;
  }

  function dumpRadioDebug() {
    const hosts = allRadioLike();
    const lines = [];
    lines.push("radio-like nodes: " + hosts.length);
    hosts.slice(0, 8).forEach((h, i) => {
      const tag = h.tagName.toLowerCase();
      const cls = (h.className || "").toString().slice(0, 80);
      const key = scoreKeyFromHost(h);
      const input = h.querySelector?.("input");
      lines.push(
        `  [${i}] <${tag} class="${cls}"> key=${key || "-"} input=${input ? input.type + "/" + (input.name || "") + "/v=" + (input.value || "") : "无"}`
      );
      try {
        lines.push("      " + h.outerHTML.slice(0, 180).replace(/\s+/g, " "));
      } catch (_) {}
    });
    const rows = collectRadioRows();
    lines.push("radio rows: " + rows.length);
    rows.slice(0, 6).forEach((r, i) => {
      lines.push(
        `  row${i} keys=${Object.keys(r.options).join(",")} sample=${r.sample && r.sample.tagName}`
      );
    });
    return lines.join("\n");
  }

  function nearestModelId(el, labels) {
    // 文本可能不是块首，不能用 ^ 锚定
    const re = /(?:^|[\s*·•\-–—_：:])(?:模型|model|Model)\s*[-–—_：: ]*\s*([A-Za-z0-9]{1,4})\b/;
    let p = el;
    for (let i = 0; i < 10 && p && p !== document.body; i++) {
      const t = textOf(p);
      const m = t.match(re);
      if (m) return m[1].toUpperCase();
      p = p.parentElement;
    }
    let owner = "";
    for (const { raw, el: lab } of labels || []) {
      const id = extractModelId(raw);
      if (!id) continue;
      if (lab.contains(el) || domAfter(lab, el)) owner = id;
    }
    return owner;
  }

  function nearestDimKey(el) {
    // 全文找维度标题，不限 answer 面板
    const heads = getAllDimHeadersIn(document.body);
    let best = "";
    let bestEl = null;
    for (const h of heads) {
      const before = h.el.contains(el) || domAfter(h.el, el);
      if (!before) continue;
      if (!bestEl || domAfter(bestEl, h.el) || h.el.contains(el)) {
        // 取「在 el 之前且最近」的标题；标题包含 el 时优先
        if (h.el.contains(el)) {
          return h.dim;
        }
        best = h.dim;
        bestEl = h.el;
      }
    }
    return best;
  }

  function getAllDimHeadersIn(root) {
    const heads = qa(
      "div,span,p,td,th,label,legend,h1,h2,h3,h4,h5,h6,section,li",
      root
    )
      .filter((el) => {
        const t = textOf(el);
        return t && t.length <= 80 && !!dimKeyFromText(t) && visible(el);
      })
      .filter((el) => {
        const selfDim = dimKeyFromText(textOf(el));
        const kids = qa("div,span,p,li,label,h1,h2,h3,h4", el);
        return !kids.some(
          (k) =>
            k !== el &&
            dimKeyFromText(textOf(k)) === selfDim &&
            textOf(k).length < textOf(el).length
        );
      });
    heads.sort((a, b) => (domAfter(a, b) ? -1 : 1));
    return heads.map((el) => ({ el, dim: dimKeyFromText(textOf(el)) }));
  }

  /** 兜底：旧的按标题区间找（修正了边界方向） */
  function findScoreOptionsNear(headerEl) {
    const ordered = getAllDimHeaders();
    const idx = ordered.findIndex((h) => h.el === headerEl);
    const nextHeader =
      idx >= 0 && idx + 1 < ordered.length ? ordered[idx + 1].el : null;
    const modelRe = HEU.modelLabel || /(?:模型|model)\s*[-–—_：: ]*\s*([A-Za-z0-9]{1,4})/i;
    let nextModel = null;
    findTextLabels(modelRe, document.body).forEach(({ el }) => {
      if (domAfter(headerEl, el)) {
        if (!nextModel || domAfter(el, nextModel)) nextModel = el;
      }
    });
    let end = null;
    if (nextHeader && nextModel) end = domAfter(nextModel, nextHeader) ? nextHeader : nextModel;
    else end = nextHeader || nextModel || null;

    function inSection(el) {
      if (headerEl.contains(el)) return true;
      if (!domAfter(headerEl, el)) return false;
      if (end) {
        if (el === end || end.contains(el)) return false;
        // el 必须在 end 之前：end 在 el 之后
        if (!domAfter(el, end)) return false;
      }
      let p = headerEl.parentElement;
      for (let d = 0; d < 6 && p; d++) {
        if (p.contains(el)) return true;
        p = p.parentElement;
      }
      return false;
    }

    const map = {};
    const place = (key, el) => {
      if (key && !map[key]) map[key] = el;
    };
    qa('input[type="radio"], input[type="checkbox"]').forEach((input) => {
      if (!inSection(input) || !visible(input)) return;
      const host = input.closest("label") || input.parentElement || input;
      place(scoreKeyFromRadio(input) || scoreKeyFromEl(host), host);
    });
    return map;
  }

  /**
   * Map modelId -> { dimKey -> { header, options } }
   */
  function collectScoreGroups() {
    const modelRe = HEU.modelLabel || /(?:模型|model)\s*[-–—_：: ]*\s*([A-Za-z0-9]{1,4})/i;
    let labels = findTextLabels(modelRe, getAreas().answer);
    if (!labels.length) labels = findTextLabels(modelRe, document.body);

    const groups = new Map();
    labels.forEach(({ raw }) => {
      const id = extractModelId(raw);
      if (id && !groups.has(id)) groups.set(id, {});
    });

    // 策略 A：radio 行（主）
    const rows = collectRadioRows();
    rows.forEach((row) => {
      const owner = nearestModelId(row.sample, labels);
      const dim = nearestDimKey(row.sample);
      if (!owner || !dim) {
        log(`行未归属 owner=${owner || "-"} dim=${dim || "-"}`);
        return;
      }
      if (!groups.has(owner)) groups.set(owner, {});
      const bag = groups.get(owner);
      if (!bag[dim]) bag[dim] = { header: null, options: row.options, source: "radio-row" };
    });

    // 策略 B：标题启发式补齐
    const heads = getAllDimHeadersIn(document.body);
    heads.forEach((h) => {
      const owner = nearestModelId(h.el, labels);
      const dim = h.dim;
      if (!owner || !dim) return;
      if (!groups.has(owner)) groups.set(owner, {});
      const bag = groups.get(owner);
      if (bag[dim] && Object.keys(bag[dim].options).length >= 8) return;
      const options = findScoreOptionsNear(h.el);
      if (Object.keys(options).length >= 6) {
        bag[dim] = { header: h.el, options, source: "header" };
      }
    });

    // 策略 C：90 行按文档顺序，每 5 行 = 一个模型的五维（保底）
    const need = [];
    groups.forEach((bag, id) => {
      if (id === "_orphan") return;
      DIMS.forEach((d) => {
        if (!bag[d]) need.push({ id, dim: d });
      });
    });
    if (need.length && rows.length >= need.length) {
      // 按模型在 labels 中的顺序 + 维序，对齐 rows 文档顺序
      const orderedModels = (labels || [])
        .map((l) => extractModelId(l.raw))
        .filter(Boolean)
        .filter((id, i, arr) => arr.indexOf(id) === i);
      if (!orderedModels.length) {
        Array.from(groups.keys()).forEach((k) => {
          if (k !== "_orphan") orderedModels.push(k);
        });
      }
      let ri = 0;
      orderedModels.forEach((id) => {
        const bag = groups.get(id) || {};
        DIMS.forEach((d) => {
          if (bag[d]) {
            // 已有则跳过对应行
            const r = rows[ri];
            if (r && r.options === bag[d].options) ri += 1;
            return;
          }
          const row = rows[ri];
          ri += 1;
          if (!row) return;
          if (!groups.has(id)) groups.set(id, {});
          groups.get(id)[d] = {
            header: null,
            options: row.options,
            source: "row-seq",
          };
        });
      });
      log(`按行序补齐 ${need.length} 个维度`);
    }

    return { groups, labels, rows };
  }

  function pickTargetEl(options, value) {
    const key = value === "na" || value == null ? "na" : String(value);
    return options[key] || null;
  }

  function markSelected(el) {
    try {
      const input = el.tagName === "INPUT" ? el : el.querySelector?.("input");
      // 同一行去掉旧高亮，避免 8、9 同时亮
      const row =
        el.closest?.('[class*="dim"], [class*="radio"], [class*="score"]') ||
        el.parentElement ||
        el;
      qa(".siriser-picked", row).forEach((n) => {
        n.classList.remove("siriser-picked");
        n.style.outline = "";
        n.style.outlineOffset = "";
      });
      // 页面上其它误标也清
      qa(".siriser-picked").forEach((n) => {
        if (n === el) return;
        if (input && n.contains(input)) return;
        if (row.contains(n)) return;
        // 只清理同行：同父级
        if (n.parentElement === el.parentElement) {
          n.classList.remove("siriser-picked");
          n.style.outline = "";
          n.style.outlineOffset = "";
        }
      });

      el.classList.add("siriser-picked");
      el.style.outline = "2px solid #0f766e";
      el.style.outlineOffset = "1px";
      if (input) input.parentElement?.classList?.add("siriser-picked");
    } catch (_) {}
  }

  // ── 模型历史分统计 + 异常校验 ──
  const STATS_KEY = "SIRISER_MODEL_STATS";

  function loadModelStats() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get([STATS_KEY], (r) => resolve(r[STATS_KEY] || {}));
      } catch (_) {
        resolve({});
      }
    });
  }
  function saveModelStats(st) {
    try {
      chrome.storage.local.set({ [STATS_KEY]: st });
    } catch (_) {}
  }

  function scoreDims(s) {
    return DIMS.map((k) => s[k]).filter((v) => typeof v === "number");
  }

  /** 更新历史：n, avg, 低分率(均分≤4), 高分率(≥9), 每维均值 */
  async function updateModelStats(scores) {
    const st = await loadModelStats();
    (scores || []).forEach((s) => {
      const vals = scoreDims(s);
      if (!vals.length) return;
      const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
      const id = s.model;
      const row = st[id] || {
        n: 0,
        sum: 0,
        low: 0,
        high: 0,
        dimSum: { alignment: 0, quality: 0, preservation: 0, consistency: 0, realism: 0 },
      };
      row.n += 1;
      row.sum += avg;
      if (avg <= 4) row.low += 1;
      if (avg >= 9) row.high += 1;
      DIMS.forEach((k) => {
        if (typeof s[k] === "number") row.dimSum[k] = (row.dimSum[k] || 0) + s[k];
      });
      st[id] = row;
    });
    saveModelStats(st);
    return st;
  }

  function modelHistAvg(row) {
    return row && row.n > 0 ? row.sum / row.n : null;
  }
  function modelLowRate(row) {
    return row && row.n > 0 ? row.low / row.n : null;
  }

  /**
   * 异常判断（只标注，不改分）：
   * - 对比历史史均；偏差过大
   * - 与历史强弱排序相反
   */
  async function flagAnomalousScores(scores) {
    const st = await loadModelStats();
    const flags = {};
    const histAvgs = {};
    (scores || []).forEach((s) => {
      const vals = scoreDims(s);
      if (!vals.length) return;
      const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
      const row = st[s.model];
      if (!row || row.n < 3) return;
      const hist = modelHistAvg(row);
      histAvgs[s.model] = hist;
      const notes = [];
      if (avg <= hist - 1.5) notes.push(`低于史均${hist.toFixed(1)}`);
      if (avg >= hist + 1.5) notes.push(`高于史均${hist.toFixed(1)}`);
      const lowR = modelLowRate(row);
      if (lowR != null && avg <= 4 && lowR < 0.15) notes.push("罕见低分");
      if (lowR != null && avg >= 9 && row.high / row.n < 0.15) notes.push("罕见高分");
      if (notes.length) {
        flags[s.model] = notes.join("、");
        s.notes = ((s.notes || "") + " ⚠" + notes.join("、")).trim();
        s._anomaly = notes.join("、");
        log(`异常标记 ${s.model} avg=${avg.toFixed(1)} hist=${hist.toFixed(1)} ${notes.join("、")}`, "err");
      }
    });

    // 排序：历史明显更好却这次更差
    const scored = (scores || []).filter((s) => scoreDims(s).length);
    for (let i = 0; i < scored.length; i++) {
      for (let j = 0; j < scored.length; j++) {
        if (i === j) continue;
        const a = scored[i];
        const b = scored[j];
        const ha = histAvgs[a.model];
        const hb = histAvgs[b.model];
        if (ha == null || hb == null) continue;
        const avgA = scoreDims(a).reduce((x, y) => x + y, 0) / scoreDims(a).length;
        const avgB = scoreDims(b).reduce((x, y) => x + y, 0) / scoreDims(b).length;
        // 历史 A 比 B 高 1.5+，这次却低 1.5+
        if (ha >= hb + 1.5 && avgA <= avgB - 1.5) {
          const tag = `排序反常(${a.model}史${ha.toFixed(1)}<${b.model}史${hb.toFixed(1)}却本次反)`;
          a._anomaly = ((a._anomaly || "") + " " + tag).trim();
          a.notes = ((a.notes || "") + " ⚠" + tag).trim();
          log(tag, "err");
          break; // 每模型标一次即可
        }
      }
    }
    return flags;
  }

  /** 把历史史均写进评分请求；史均不足则用基础先验 */
  async function buildHistHint(models) {
    const st = await loadModelStats();
    const prior = (CFG && CFG.MODEL_PRIOR) || {};
    const parts = [];
    (models || []).forEach((m) => {
      const row = st[m.id];
      if (row && row.n >= 3) {
        const hist = modelHistAvg(row);
        parts.push(`${m.id}史均${hist.toFixed(1)}(n=${row.n})`);
      } else if (prior[m.id] != null) {
        parts.push(`${m.id}先验${Number(prior[m.id]).toFixed(1)}`);
      }
    });
    if (!parts.length) return "";
    return (
      "\n【历史史均/先验参考】" +
      parts.join("，") +
      "\n说明：一般 A–D 往往更好、靠后模型略弱；此为先验，仍以本图视觉为准。若本次与先验趋势相反，请更谨慎核对。"
    );
  }

  /** 左侧内容区滚到指定模型图（只滚图片列，不碰答题区） */
  function scrollToModelImage(modelId) {
    try {
      const id = String(modelId || "").trim();
      if (!id) return false;
      const labels = findModelLabels();
      const hit = labels.find((h) => extractModelId(h.raw || textOf(h.el)) === id);
      if (!hit || !hit.el) return false;

      // 在「内容区」里找该徽章旁的图
      const { content } = (typeof getAreas === "function" ? getAreas() : {}) || {};
      let scope = hit.el;
      for (let i = 0; i < 6 && scope; i++) {
        const img = pickLargestImg(scope);
        if (img && isRealGenImg(img)) {
          // 只滚内容区滚动容器
          let scroller = content;
          if (!scroller || !scroller.contains(img)) {
            scroller = img.parentElement;
            while (scroller && scroller !== document.body) {
              const st = getComputedStyle(scroller);
              if (
                (st.overflowY === "auto" || st.overflowY === "scroll") &&
                scroller.scrollHeight > scroller.clientHeight + 20
              ) {
                break;
              }
              scroller = scroller.parentElement;
            }
          }
          const target = scroller && scroller !== document.body ? scroller : img;
          if (target.scrollIntoView) {
            target.scrollIntoView({ block: "center", behavior: "auto" });
          }
          // 徽章也保证可见
          hit.el.scrollIntoView({ block: "center", behavior: "auto" });
          log(`已滚到 ${id}`);
          return true;
        }
        scope = scope.parentElement;
      }
      hit.el.scrollIntoView({ block: "center", behavior: "auto" });
      log(`已滚到徽章 ${id}（未找到旁侧图片）`);
      return true;
    } catch (e) {
      log("滚动到模型图失败：" + (e && e.message));
      return false;
    }
  }

  async function applyScores(scores, meta) {
    // 先做异常标记（不改分），再勾选
    try {
      await flagAnomalousScores(scores);
    } catch (e) {
      log("异常校验失败(忽略)：" + (e && e.message));
    }
    const { groups } = collectScoreGroups();
    const report = [];
    let clicked = 0;
    const clickT0 = Date.now();
    setStatusDock("勾选分数", `共 ${scores.length} 个模型`);
    if (_humanModeCached == null) {
      _humanModeCached = await loadHumanMode();
    }
    const pacedClicks = !!_humanModeCached;
    const plannedClicks = scores.reduce((count, s) => {
      if (s._skipClick) return count;
      const bag = groups.get(s.model) || {};
      return count + DIMS.filter((dim) => {
        const cell = bag[dim];
        return cell && pickTargetEl(cell.options, s[dim]);
      }).length;
    }, 0);
    // 90 格完整题约 5–6 分钟；只评少量模型时按实际格数缩短。
    const fullTask = scores.length >= 15;
    const humanTargetMs = pacedClicks && plannedClicks
      ? Math.round(
          (5 * 60 * 1000 + Math.random() * 60 * 1000) *
            (fullTask ? 1 : plannedClicks / 90)
        )
      : 0;
    const weights = Array.from(
      { length: plannedClicks },
      () => 0.75 + Math.random() * 0.5
    );
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
    let completedWeight = 0;
    log(
      "点击节奏：" +
        (!pacedClicks
          ? "拟人关闭（60ms/格）"
          : `拟人开启（计划 ${plannedClicks} 格 / ${fmtDur(humanTargetMs)}）`)
    );

    for (const s of scores) {
      // 勾选前左侧同步到该模型图
      if (s && s.model) {
        setStatusDock("勾选分数", `当前 ${s.model}`);
        scrollToModelImage(s.model);
        await sleep(200);
      }
      const bag = groups.get(s.model) || {};
      const line = { model: s.model, filled: [], miss: [] };
      if (s._skipClick) {
        line.miss.push("API 无分，未勾选");
        report.push(line);
        continue;
      }
      if (!Object.keys(bag).length) {
        line.miss.push("无该模型评分组");
        report.push(line);
        continue;
      }
      for (const dim of DIMS) {
        const v = s[dim];
        const cell = bag[dim];
        if (!cell) {
          line.miss.push(dim + ":无控件");
          continue;
        }
        const target = pickTargetEl(cell.options, v);
        if (!target) {
          line.miss.push(dim + ":" + v + "无选项");
          continue;
        }
        // 点之前确认五维目标不是同一个元素
        fireClick(target);
        markSelected(target);
        completedWeight += weights[clicked] || 0;
        const dueAt = pacedClicks
          ? clickT0 + Math.round(humanTargetMs * completedWeight / totalWeight)
          : 0;
        await humanClickDelay(dueAt, pacedClicks);
        log(`点击 ${s.model} ${dim}→${v}`);
        line.filled.push(dim + "=" + (v == null ? "无" : v));
        line._targets = line._targets || [];
        line._targets.push(dim);
        clicked += 1;
      }
      // 自检：五维若指向同一节点则报警
      if (line._targets && line._targets.length >= 2) {
        const opts = DIMS.map((d) => bag[d] && pickTargetEl(bag[d].options, s[d]));
        const set = new Set(opts.filter(Boolean));
        if (set.size === 1 && opts.filter(Boolean).length >= 2) {
          line.miss.push("五维指向同一控件");
          log(`${s.model} 五维指向同一控件，勾选可能串行`, "err");
        }
      }
      report.push(line);
      log(`勾选 ${s.model}: ${line.filled.join(" ")} ${line.miss.join(",")}`);
    }

    const clickMs = Date.now() - clickT0;
    showResultPanel(scores, report, clicked, { ...(meta || {}), clickMs });
    // 写入历史后再刷新统计摘要
    try {
      await updateModelStats(scores);
    } catch (_) {}
    try {
      await appendStatsSummary(scores);
    } catch (_) {}
    return clicked;
  }

  /** 结果窗底部附加历史低分率摘要 */
  async function appendStatsSummary(scores) {
    const st = await loadModelStats();
    const body = document.getElementById("siriser-result-body");
    if (!body) return;
    let el = document.getElementById("siriser-stats");
    if (!el) {
      el = document.createElement("div");
      el.id = "siriser-stats";
      body.appendChild(el);
    }
    const rows = (scores || []).map((s) => {
      const row = st[s.model];
      const n = row ? row.n : 0;
      const hist = modelHistAvg(row);
      const low = modelLowRate(row);
      const prior =
        (CFG && CFG.MODEL_PRIOR && CFG.MODEL_PRIOR[s.model] != null)
          ? Number(CFG.MODEL_PRIOR[s.model]).toFixed(1)
          : "—";
      const cur = scoreDims(s);
      const curAvg = cur.length
        ? (cur.reduce((a, b) => a + b, 0) / cur.length).toFixed(1)
        : "—";
      return `<div class="sir-st-row">
        <b>${escapeHtml(s.model)}</b>
        <span>本次 ${curAvg}</span>
        <span>${n >= 3 ? "史均" : "先验"} ${n >= 3 && hist != null ? hist.toFixed(1) : prior}</span>
        <span>n=${n}</span>
        <span>低分率 ${low == null ? "—" : (low * 100).toFixed(0)}%</span>
        ${s._anomaly ? `<span class="err">⚠${escapeHtml(s._anomaly)}</span>` : ""}
      </div>`;
    });
    el.innerHTML = `<div class="sir-st-sum"><strong>历史统计</strong>（低分=均分≤4）</div>` + rows.join("");
  }

  /** 打开模型统计面板 */
  async function showStatsPanel() {
    const st = await loadModelStats();
    let panel = document.getElementById("siriser-stats-panel");
    if (!panel) {
      panel = document.createElement("div");
      panel.id = "siriser-stats-panel";
      panel.innerHTML = `
        <div class="sir-r-h sir-drag">
          <strong>模型历史统计</strong>
          <span class="sir-r-acts">
            <button type="button" data-s="export">导出CSV</button>
            <button type="button" data-s="reset">重置</button>
            <button type="button" data-s="close">关闭</button>
          </span>
        </div>
        <div class="sir-r-b" id="siriser-stats-body"></div>`;
      document.body.appendChild(panel);
      panel.addEventListener("click", async (e) => {
        const b = e.target.closest("[data-s]");
        if (!b) return;
        const k = b.dataset.s;
        if (k === "close") {
          panel.classList.remove("open");
          return;
        }
        if (k === "reset") {
          if (confirm("确认清空全部模型历史统计？此操作不可恢复。")) {
            saveModelStats({});
            log("模型统计已重置");
            await showStatsPanel();
          }
          return;
        }
        if (k === "export") {
          const s2 = await loadModelStats();
          const lines = ["model,n,hist_avg,low_rate,high_rate"];
          Object.keys(s2).forEach((id) => {
            const r = s2[id];
            const avg = modelHistAvg(r);
            const low = modelLowRate(r);
            const high = r.n ? r.high / r.n : 0;
            lines.push(
              [id, r.n, avg == null ? "" : avg.toFixed(2), low == null ? "" : (low * 100).toFixed(1) + "%", (high * 100).toFixed(1) + "%"].join(",")
            );
          });
          const blob = new Blob([lines.join("\n")], { type: "text/csv" });
          const a = document.createElement("a");
          a.href = URL.createObjectURL(blob);
          a.download = "siriser-model-stats.csv";
          a.click();
          toastMsg("已导出 CSV");
        }
      });
      try {
        makeDraggable(panel, panel.querySelector(".sir-drag"));
      } catch (_) {}
    }
    const body = panel.querySelector("#siriser-stats-body");
    const ids = Object.keys(st).sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true })
    );
    if (!ids.length) {
      body.innerHTML = `<div class="sir-st-empty">还没有历史数据。跑过评分后这里会显示各模型史均与低分率。</div>`;
    } else {
      body.innerHTML =
        `<div class="sir-st-head"><span>模型</span><span>次数</span><span>史均</span><span>低分率</span><span>高分率</span></div>` +
        ids
          .map((id) => {
            const r = st[id];
            const avg = modelHistAvg(r);
            const low = modelLowRate(r);
            const high = r.n ? r.high / r.n : 0;
            return `<div class="sir-st-row2">
              <b>${escapeHtml(id)}</b>
              <span>${r.n}</span>
              <span>${avg == null ? "—" : avg.toFixed(2)}</span>
              <span>${low == null ? "—" : (low * 100).toFixed(0)}%</span>
              <span>${(high * 100).toFixed(0)}%</span>
            </div>`;
          })
          .join("");
    }
    panel.classList.add("open");
  }

  function findTextButton(re) {
    return qa(
      "button, [role=button], a.btn, input[type=submit], .el-button, [class*=btn]"
    )
      .filter(visible)
      .find((b) => re.test(textOf(b) || b.value || ""));
  }

  let _lastSubmitAt = 0;
  function submitAndNext() {
    const now = Date.now();
    if (now - _lastSubmitAt < 1500) {
      log("提交过频，已忽略");
      return false;
    }
    _lastSubmitAt = now;
    // 定时到点：只提交当前题，不点「提交并下一题」再领新题
    const atStop = _schedStopAt > 0 && Date.now() >= _schedStopAt;
    let btn = atStop
      ? findTextButton(/^(提交当前题|提交)$/)
      : findTextButton(HEU.submitText || /^(提交并下一题|提交当前题|提交)$/i);
    if (atStop) {
      if (btn) {
        log("定时到点：仅提交当前题，不再领取下一题", "ok");
      } else {
        // 安全优先：绝不能回退点击「提交并下一题」，留给人工处理当前题。
        log("定时到点但未找到安全提交按钮，为避免领取下一题，本题留待人工提交", "err");
        return false;
      }
    }
    if (btn) {
      fireClick(btn);
      log("已提交：" + textOf(btn));
    } else {
      log("未找到提交按钮", "err");
    }
    return !!btn;
  }

  function readPrompt() {
    // 「提示词」标签旁
    const heads = findTextLabels(HEU.promptLabel || /^(提示词|编辑指令)$/, document.body);
    for (const { el } of heads) {
      const scope = el.parentElement;
      if (!scope) continue;
      const cands = qa("p,div,span,textarea,pre,[contenteditable]", scope)
        .map(textOf)
        .filter((t) => t.length >= 8 && t.length <= 600 && !/编辑指令遵循|评分细则/.test(t));
      if (cands.length) {
        cands.sort((a, b) => b.length - a.length);
        return cands[0];
      }
      // 下一个兄弟
      let n = scope.nextElementSibling;
      for (let i = 0; i < 3 && n; i++) {
        const t = textOf(n);
        if (t.length >= 8 && t.length <= 600) return t;
        n = n.nextElementSibling;
      }
    }
    return "";
  }

  function collectTask() {
    const visual = collectVisuals();
    const prompt = readPrompt();
    const { groups } = collectScoreGroups();
    groups.forEach((_, id) => {
      if (id === "_orphan") return;
      if (!visual.models.find((m) => m.id === id)) {
        visual.models.push({
          id,
          name: id,
          labelEl: null,
          imgEl: null,
          images: [],
          meta: { src: "", name: "", w: 0, h: 0 },
          strategy: "score-only",
        });
      }
    });
    visual.models.sort((a, b) =>
      a.id.localeCompare(b.id, undefined, { numeric: true })
    );
    const task = {
      prompt,
      referenceImages: visual.referenceImages,
      models: visual.models.map((m) => ({
        id: m.id,
        name: m.name,
        images: m.images,
        meta: { w: Number(m.meta && m.meta.w) || 0, h: Number(m.meta && m.meta.h) || 0 },
      })),
      _cards: visual.models,
      _meta: {
        promptLen: prompt.length,
        hasRef: !!visual.refImg,
        modelCount: visual.models.length,
        withImg: visual.models.filter((m) => m.images.length).length,
        strategy: "split-columns",
      },
    };
    window.__SIRISER_LAST_TASK__ = task;
    return task;
  }

  const IMAGE_RECHECK_WAIT_MS = 12000;
  let _lastImageAlertKey = "";

  function normalizeWorkbenchCellText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function findActiveWorkbenchPackageId(headers, rows) {
    const normalizedHeaders = (headers || []).map(normalizeWorkbenchCellText);
    const idIndex = normalizedHeaders.findIndex((h) => /题目\s*ID/i.test(h));
    const statusIndex = normalizedHeaders.findIndex((h) => /题目状态|状态/.test(h));
    const actionIndex = normalizedHeaders.findIndex((h) => /操作/.test(h));
    if (idIndex < 0 || statusIndex < 0 || actionIndex < 0) {
      return { ok: false, error: "工作台项目表未找到「题目状态 / 题目ID / 操作」列" };
    }
    const activeCandidates = (rows || []).map((row) => {
      const cells = (row || []).map(normalizeWorkbenchCellText);
      return {
        id: normalizeWorkbenchCellText((row || [])[idIndex]),
        status: cells[statusIndex] || "",
        actions: cells[actionIndex] || "",
      };
    }).filter((candidate) => /进行中/.test(candidate.status) && candidate.id && candidate.id !== "-");
    // 「进行中」是任务包已锁定的主状态。操作文案会随页面版本/权限变化；
    // 有多个进行中任务时才用「回答 + 释放」操作组合进一步消歧。
    const actionable = activeCandidates.filter((candidate) => /回答|答题|作答/.test(candidate.actions) && /释放/.test(candidate.actions));
    const selected = actionable.length === 1 ? actionable : activeCandidates.length === 1 ? activeCandidates : [];
    const ids = selected.map((candidate) => candidate.id);
    if (ids.length !== 1) {
      return {
        ok: false,
        error: ids.length
          ? `工作台有 ${ids.length} 个候选进行中任务包，无法安全确定目标`
          : activeCandidates.length > 1
            ? `工作台有 ${activeCandidates.length} 个进行中任务包，且操作列文案不足以安全区分`
            : "工作台没有找到唯一的「进行中」任务包题目 ID",
      };
    }
    return { ok: true, taskId: ids[0] };
  }

  function readActiveWorkbenchPackageId(doc) {
    doc = doc || document;
    const wrappers = Array.from(doc.querySelectorAll(".ant-table-wrapper"));
    const scopes = wrappers.length ? wrappers : [doc];
    const readHeaders = (table) => {
      const row = table.querySelector("thead tr");
      return row ? Array.from(row.querySelectorAll("th,td")).map((cell) => normalizeWorkbenchCellText(cell.innerText || cell.textContent)) : [];
    };
    const readRows = (table) => Array.from(table.querySelectorAll("tbody tr"));
    const readRowValues = (row) => Array.from(row.querySelectorAll("td")).map((cell) => normalizeWorkbenchCellText(cell.innerText || cell.textContent));
    const readActionText = (row) => {
      const cells = Array.from(row.querySelectorAll("td"));
      const cell = cells[cells.length - 1];
      if (!cell) return "";
      const labels = Array.from(cell.querySelectorAll("button,a,[role=button]"))
        .map((el) => [el.innerText, el.textContent, el.getAttribute("aria-label"), el.getAttribute("title")].filter(Boolean).join(" "));
      return `${cell.innerText || cell.textContent || ""} ${labels.join(" ")}`;
    };

    for (const scope of scopes) {
      const tables = Array.from(scope.querySelectorAll("table"));
      const parts = tables.map((table) => ({ table, headers: readHeaders(table), rows: readRows(table) }));
      const questionPart = parts.find((part) => part.headers.some((h) => /题目\s*ID/i.test(h)));
      if (!questionPart) continue;
      const actionPart = parts.find((part) => part.headers.some((h) => /操作/.test(h)));
      const questionHeaders = questionPart.headers;
      const idIndex = questionHeaders.findIndex((h) => /题目\s*ID/i.test(h));
      const statusIndex = questionHeaders.findIndex((h) => /题目状态|状态/.test(h));
      const inlineActionIndex = questionHeaders.findIndex((h) => /操作/.test(h));
      if (idIndex < 0 || statusIndex < 0 || (!actionPart && inlineActionIndex < 0)) {
        return { ok: false, error: "工作台找到题目 ID 表头，但状态列或操作列在单独的固定列中，无法配对" };
      }

      const chooseRows = (part, excludedTable) => {
        if (part && part.rows.length) return part.rows;
        const width = (part && part.headers.length) || 0;
        const candidates = parts.filter((candidate) => candidate.table !== excludedTable && candidate.rows.length)
          .map((candidate) => ({ rows: candidate.rows, widthDiff: Math.abs(candidate.rows[0].querySelectorAll("td").length - width) }))
          .sort((a, b) => a.widthDiff - b.widthDiff);
        return candidates.length && candidates[0].widthDiff <= 1 ? candidates[0].rows : [];
      };
      const questionRows = chooseRows(questionPart);
      const actionRows = inlineActionIndex >= 0 ? questionRows : chooseRows(actionPart, questionPart.table);
      if (!questionRows.length || !actionRows.length) {
        return { ok: false, error: "工作台已找到列标题，但题目数据行没有加载或固定操作列无法配对" };
      }
      const headers = questionHeaders.slice();
      const actionIndex = inlineActionIndex >= 0 ? inlineActionIndex : headers.push("操作") - 1;
      const rows = questionRows.map((row, index) => {
        const values = readRowValues(row);
        if (inlineActionIndex >= 0) {
          values[inlineActionIndex] = `${values[inlineActionIndex] || ""} ${readActionText(row)}`;
        } else if (actionRows[index]) {
          values[actionIndex] = readActionText(actionRows[index]);
        }
        return values;
      });
      return findActiveWorkbenchPackageId(headers, rows);
    }
    return { ok: false, error: `工作台表格结构未匹配（检测到 ${doc.querySelectorAll("table").length} 个 table），未能配对题目 ID 与操作列` };
  }

  /** 图片复查仍失败时，从工作台当前已锁定任务包读取题目 ID 并推送。 */
  async function notifyImageIssueTaskId() {
    try {
      await loadConfigFromStorage();
      const hook = String((CFG && CFG.DINGTALK_WEBHOOK) || "").trim();
      if (!hook || !/^https?:\/\//i.test(hook)) {
        log("未配置钉钉 Webhook，跳过分包 ID 推送", "err");
        return false;
      }
      const res = await sendRuntimeMsg({
        type: "SIRISER_GET_WORKBENCH_PACKAGE_ID",
        webhook: hook,
        activateWorkbench: true,
      });
      if (!res || !res.ok) {
        log(`工作台分包 ID 获取/推送失败：${(res && res.error) || (res && res.body) || "后台无响应"}`, "err");
        return false;
      }
      log(`工作台题目 ID ${res.taskId} 已发送到钉钉`, "ok");
      return true;
    } catch (e) {
      log("分包 ID 钉钉推送失败：" + (e && e.message), "err");
      return false;
    }
  }

  function taskImageIssues(task) {
    return ((task && task._cards) || []).filter(
      (m) => m && (m.broken || !(m.images && m.images.length))
    );
  }

  function wakeImageLoading(issues) {
    (issues || []).forEach((m) => {
      const img = m && m.imgEl;
      const target = img || (m && m.labelEl);
      if (img) {
        try {
          img.loading = "eager";
          img.fetchPriority = "high";
          if (m.broken) {
            const retrySrc =
              img.getAttribute("data-src") ||
              img.getAttribute("data-original") ||
              img.getAttribute("src") ||
              img.currentSrc ||
              img.src ||
              "";
            if (retrySrc) {
              img.src = retrySrc;
              log(`重试加载图片 ${m.id}`);
            }
          }
        } catch (_) {}
      }
      try {
        target && target.scrollIntoView({ block: "center", behavior: "auto" });
      } catch (_) {}
    });
    try {
      window.dispatchEvent(new Event("scroll"));
    } catch (_) {}
  }

  /** 首次缺图/破图先等待网络并重采一次；复查仍失败才进入置无和通知。 */
  async function collectTaskWithImageRecheck() {
    let task = collectTask();
    let issues = taskImageIssues(task);
    if (!issues.length) return task;

    const firstIds = issues.map((m) => m.id).join(",");
    log(`图片初检异常 ${firstIds} → 等待 ${fmtDur(IMAGE_RECHECK_WAIT_MS)} 后复查`, "err");
    setStatusDock("复查图片", `${firstIds} · 等待网络加载`);
    wakeImageLoading(issues);
    await sleep(IMAGE_RECHECK_WAIT_MS);

    task = collectTask();
    issues = taskImageIssues(task);
    if (!issues.length) {
      log(`图片复查恢复 ${firstIds}，继续评分`, "ok");
      toastMsg(`图片已恢复：${firstIds}`);
      return task;
    }

    const brokenIds = issues.filter((m) => m.broken).map((m) => m.id);
    const missingIds = issues.filter((m) => !m.broken).map((m) => m.id);
    const detail = [
      brokenIds.length ? `破图：${brokenIds.join(",")}` : "",
      missingIds.length ? `无图：${missingIds.join(",")}` : "",
    ]
      .filter(Boolean)
      .join("；");
    log(`图片复查仍异常 ${detail} → 五维将勾「无」`, "err");
    setStatusDock("图片异常", `${detail} · 将勾无`, "err");

    const alertKey = `${location.href}|${String(task.prompt || "").slice(0, 80)}`;
    if (_lastImageAlertKey !== alertKey) {
      _lastImageAlertKey = alertKey;
      await notifyImageIssueTaskId();
    }
    return task;
  }

  function gcd(a, b) {
    a = Math.abs(Math.round(a));
    b = Math.abs(Math.round(b));
    while (b) {
      const t = b;
      b = a % b;
      a = t;
    }
    return a || 1;
  }

  /** 从提示词提取目标宽高比：支持 1:1、4比3、16：9、1024×768、正方形等写法。 */
  function parseRequestedOutputAspect(prompt) {
    const s = String(prompt || "")
      .replace(/[０-９]/g, (ch) => String(ch.charCodeAt(0) - 0xff10))
      .replace(/一\s*比\s*一/g, "1比1")
      .replace(/\s+/g, " ");
    const context = /输出|生成|导出|目标|改为|设为|调整为|画布|画幅|尺寸|大小|分辨率|比例|宽高比|图片|图像|output|aspect|ratio|resolution|size/i;
    const candidates = [];
    const candidateScore = (start, end) => {
      const before = s.slice(Math.max(0, start - 36), start);
      const after = s.slice(end, Math.min(s.length, end + 36));
      let score = 0;
      if (/(?:输出|生成|导出|目标|改为|设为|调整为|画布|画幅|尺寸|大小|分辨率|比例|宽高比|output|aspect|ratio|resolution|size)[^。；\n]{0,14}$/i.test(before)) score += 5;
      if (/^[^。；\n]{0,14}(?:输出|图片|图像|画布|画幅|比例|尺寸|output|image)/i.test(after)) score += 2;
      if (/(?:原图|参考图|输入图|原始)[^。；\n]{0,14}$/i.test(before)) score -= 5;
      return score;
    };
    const collect = (re, kind) => {
      let match;
      while ((match = re.exec(s))) {
        const w = Number(match[1]);
        const h = Number(match[2]);
        if (!w || !h) continue;
        const nearby = s.slice(Math.max(0, match.index - 36), Math.min(s.length, re.lastIndex + 36));
        if (!context.test(nearby)) continue;
        candidates.push({
          index: match.index,
          w,
          h,
          kind,
          score: candidateScore(match.index, re.lastIndex),
        });
      }
    };
    collect(/(\d{1,5}(?:\.\d{1,3})?)\s*(?:[:：/／]|比)\s*(\d{1,5}(?:\.\d{1,3})?)/gi, "ratio");
    collect(/(\d{2,5})\s*(?:x|×|\*|＊)\s*(\d{2,5})/gi, "size");

    const wh = s.match(/(?:输出|生成|导出|目标|尺寸|大小|分辨率)[^。；\n]{0,24}宽(?:度)?\s*[:：为]?\s*(\d{2,5})[^。；\n]{0,16}高(?:度)?\s*[:：为]?\s*(\d{2,5})/i);
    if (wh) candidates.push({ index: wh.index || 0, w: Number(wh[1]), h: Number(wh[2]), kind: "size", score: 8 });

    if (!candidates.length && /(?:输出|生成|导出|目标|画布|画幅)[^。；\n]{0,20}(?:正方形|方形|square)/i.test(s)) {
      candidates.push({ index: s.length, w: 1, h: 1, kind: "shape", score: 8 });
    }
    if (!candidates.length) return null;

    // 优先“输出/目标/改为”附近的比例，降低“原图/参考图”附近比例的优先级。
    const picked = candidates.sort((a, b) => a.score - b.score || a.index - b.index).pop();
    const integers = Number.isInteger(picked.w) && Number.isInteger(picked.h);
    const d = integers ? gcd(picked.w, picked.h) : 1;
    return {
      ratio: picked.w / picked.h,
      label: `${picked.w / d}:${picked.h / d}`,
      source: picked.kind,
    };
  }

  /** 按提示词指定的目标比例校验真实像素，避免视觉模型忽略画布比例。 */
  function applyRequestedAspectPolicy(scores, task, models) {
    const expected = parseRequestedOutputAspect(task && task.prompt);
    if (!expected) return scores;
    const byId = new Map((models || []).map((m) => [String(m.id || "").toUpperCase(), m]));
    return (scores || []).map((s) => {
      if (!s || s._forceNa || s._skipClick || typeof s.alignment !== "number") return s;
      const id = String(s.model || "")
        .replace(/^(?:模型|model)\s*[-–—_：: ]*/i, "")
        .toUpperCase();
      const card = byId.get(id);
      const w = Number(card && card.meta && card.meta.w) || 0;
      const h = Number(card && card.meta && card.meta.h) || 0;
      if (!w || !h) return s;
      const actualRatio = w / h;
      const ratioError = Math.max(actualRatio / expected.ratio, expected.ratio / actualRatio);
      if (ratioError <= 1.03) return s;

      const severe = ratioError >= 1.12;
      const cap = severe ? 5 : 7;
      s.alignment = Math.min(s.alignment, cap);
      const tag = `[输出${w}×${h}，未达${expected.label}]`;
      if (!String(s.notes || "").includes(`未达${expected.label}`)) {
        s.notes = `${s.notes ? s.notes + " " : ""}${tag}`;
      }
      s._aspectMismatch = { expected: expected.label, width: w, height: h, cap };
      log(`比例校验 ${id}: ${w}x${h} 未达 ${expected.label} → alignment≤${cap}`, "err");
      return s;
    });
  }

  async function runAutoScore(onlyCurrent, opts) {
    const t0 = Date.now();
    await loadConfigFromStorage();
    setStatusDock("准备任务", "加载配置 / 识别页面");
    const batchSize = Math.max(1, Number((opts && opts.batchSize) || CFG.BATCH_SIZE || 1));
    const task = await collectTaskWithImageRecheck();
    log(
      `采集 models=${task.models.length} 有图=${task._meta.withImg} ref=${task._meta.hasRef} 批大小=${batchSize} prompt=${task.prompt.slice(0, 24)}…`
    );
    if (!task.models.length) throw new Error("未识别到模型");

    const modelsToEval = onlyCurrent
      ? [task._cards.find((m) => m.images.length) || task._cards[0]]
      : task._cards;

    const payloadModels = modelsToEval.map((m) => ({
      id: m.id,
      name: m.name,
      images: m.images,
      meta: { w: Number(m.meta && m.meta.w) || 0, h: Number(m.meta && m.meta.h) || 0 },
    }));

    log(
      "调用评分 API… url=" +
        (CFG.API_URL || "(openai " + (CFG.OPENAI_MODEL || "?") + ")") +
        " models=" +
        payloadModels.length +
        " batch=" +
        batchSize
    );
    setStatusDock("调用 API", `模型 ${payloadModels.length} 个 · 批 ${batchSize}`);
    const histHint = await buildHistHint(payloadModels).catch(() => "");
    if (histHint) log("已附历史史均提示");
    let scores;
    try {
      scores = await window.SiriserAPI.evaluate(
        {
          prompt: task.prompt,
          referenceImages: task.referenceImages,
          models: payloadModels,
          histHint,
        },
        { ...CFG, BATCH_SIZE: batchSize }
      );
    } catch (e) {
      log("API 失败：" + e.message, "err");
      setStatusDock("API 失败", shortErr(e.message), "err");
      // 不在此处推钉钉：由外层（自动循环 / 悬浮球 / popup）统一推一次，避免重复
      throw e;
    }
    if (!Array.isArray(scores) || !scores.length) {
      log("API 返回空 scores", "err");
      throw new Error("API 返回空评分列表");
    }
    log("API 返回 " + scores.length + " 条：" + scores.slice(0, 3).map((s) => s.model + ":" + s.alignment).join(", ") + "…");

    // 有图却拿到 null：不要勾「无」，记下来让人看
    scores = scores.map((s) => {
      const sid = String(s.model || "")
        .replace(/^(?:模型|model)\s*[-–—_：: ]*/i, "")
        .toUpperCase();
      const src =
        modelsToEval.find((m) => m.id === sid) ||
        modelsToEval.find((m) => m.id === s.model);
      const hasLocalImg = src && src.images && src.images.length > 0 && !src.broken;
      const allNull = [s.alignment, s.quality, s.preservation, s.consistency, s.realism].every(
        (v) => v == null
      );

      // 站点图片加载异常 → 五维全部「无」
      if (src && src.broken) {
        log(`${src.id} 图片加载异常 → 勾「无」`);
        return {
          model: src.id,
          alignment: null,
          quality: null,
          preservation: null,
          consistency: null,
          realism: null,
          notes: "image_load_error",
          _forceNa: true,
        };
      }
      if (!hasLocalImg) {
        return {
          model: src ? src.id : s.model,
          alignment: null,
          quality: null,
          preservation: null,
          consistency: null,
          realism: null,
          notes: "no_image",
          _forceNa: true,
        };
      }
      if (allNull) {
        log(`${src.id} 本地有图但 API 无分，跳过勾选`, "err");
        return {
          ...s,
          model: src.id,
          notes: s.notes || "api_returned_null",
          _skipClick: true,
        };
      }
      return { ...s, model: src ? src.id : s.model };
    });

    scores = applyRequestedAspectPolicy(scores, task, modelsToEval);

    await applyScores(scores, {
      elapsedMs: Date.now() - t0,
      batchSize,
      apiMs: Date.now() - t0,
    });
    log("完成 · 用时 " + fmtDur(Date.now() - t0), "ok");
    setStatusDock("本题完成", `用时 ${fmtDur(Date.now() - t0)}`, "ok");
    beepDone();
    return scores;
  }

  // ── 全自动模式 ──
  const AUTO_KEY = "SIRISER_AUTO";
  let _autoRunning = false;
  let _cancelSubmit = false;
  let _autoGen = 0;
  let _firstTaskDone = false;

  function loadAutoState() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get([AUTO_KEY], (r) => resolve(r[AUTO_KEY] || { on: false }));
      } catch (_) {
        resolve({ on: false });
      }
    });
  }
  function saveAutoState(st) {
    try {
      chrome.storage.local.set({ [AUTO_KEY]: st });
    } catch (_) {}
  }

  // ── 定时自动停止：独立 storage key，避免被 saveAutoState 整块覆盖冲掉，且跨刷新保留 ──
  const SESSION_KEY = "SIRISER_SESSION";
  function loadSessionDeadline() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get([SESSION_KEY], (r) => resolve((r && r[SESSION_KEY]) || null));
      } catch (_) {
        resolve(null);
      }
    });
  }
  function saveSessionDeadline(obj) {
    try {
      chrome.storage.local.set({ [SESSION_KEY]: obj });
    } catch (_) {}
  }
  function clearSessionDeadline() {
    try {
      chrome.storage.local.remove([SESSION_KEY]);
    } catch (_) {}
  }
  /** 定时停止时刻缓存（submitAndNext 需要同步读取） */
  let _schedStopAt = 0;
  async function refreshSchedStopAt() {
    try {
      const s = await loadSessionDeadline();
      _schedStopAt = (s && s.endAt) || 0;
    } catch (_) {
      _schedStopAt = 0;
    }
  }
  /** 定时到点时先关掉站点「提交后自动领取下一题」勾选，避免提交动作领走下一题 */
  function tryDisableAutoClaim() {
    try {
      const lbl = qa("label, .ant-checkbox-wrapper, [class*=checkbox]")
        .filter(visible)
        .find((el) => /领取下一题|自动领取/.test(textOf(el) || ""));
      if (!lbl) return false;
      const inp =
        lbl.querySelector?.('input[type="checkbox"]') ||
        (lbl.tagName === "INPUT" ? lbl : null);
      if (inp && !inp.checked) return true;
      fireClick(lbl);
      log("定时到点：已取消「提交后自动领取下一题」");
      return true;
    } catch (_) {
      return false;
    }
  }
  /** 自动流程专用提交：到点则先关自动领取，再只提交当前题 */
  async function submitAutoForDeadline() {
    await refreshSchedStopAt();
    if (_schedStopAt > 0 && Date.now() >= _schedStopAt) {
      log("定时已到点：本题提交后停止，不领取下一题", "ok");
      tryDisableAutoClaim();
      await sleep(400); // 等站点把按钮文案从「提交并下一题」刷回「提交当前题」
    }
    return submitAndNext();
  }
  /** 依据配置算出本次会话的绝对停止时刻(ms)：到点 AUTO_STOP_TIME(HH:MM)，已过点顺延次日；未启用/无效返回 null */
  function computeSessionEndAt(cfg) {
    if (!cfg || !cfg.AUTO_STOP_ENABLED) return null;
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(cfg.AUTO_STOP_TIME || "").trim());
    if (!m) return null;
    const hh = Math.min(23, Math.max(0, Number(m[1])));
    const mm = Math.min(59, Math.max(0, Number(m[2])));
    const d = new Date();
    d.setHours(hh, mm, 0, 0);
    let endAt = d.getTime();
    if (endAt <= Date.now()) endAt += 24 * 3600 * 1000; // 已过点 → 顺延到次日同一时刻
    return endAt;
  }
  function stopLabelFor(cfg) {
    return "到点 " + ((cfg && cfg.AUTO_STOP_TIME) || "") + " 停";
  }

  function missingScoreIds(scores) {
    return (scores || [])
      .filter((s) => {
        if (s._skipClick) return true;
        if (s.notes === "no_image" || s.notes === "image_load_error" || s._forceNa) return false;
        return DIMS.every((k) => s[k] == null || s[k] === "na");
      })
      .map((s) => s.model);
  }

  /** 本地是否算「有可用图」：排除 0×0 / 未加载 */
  function hasUsableImage(card) {
    if (!card) return false;
    if (card.imgEl && isRealGenImg(card.imgEl)) return true;
    if (card.images && card.images.length) {
      // data URL 或 http 都算有，但空串不算
      return card.images.some((x) => x && String(x).length > 80);
    }
    return false;
  }

  /** 底部常驻状态条（后台运行时可见） */
  function ensureStatusDock() {
    let dock = document.getElementById("siriser-status-dock");
    if (dock) return dock;
    dock = document.createElement("div");
    dock.id = "siriser-status-dock";
    dock.innerHTML = `
      <span class="sir-sd-dot" id="siriser-sd-dot"></span>
      <span class="sir-sd-stage" id="siriser-sd-stage">待命</span>
      <span class="sir-sd-detail" id="siriser-sd-detail">未开始</span>
      <button type="button" class="sir-sd-min" id="siriser-sd-min" title="收起">—</button>
    `;
    document.body.appendChild(dock);
    dock.querySelector("#siriser-sd-min").addEventListener("click", () => {
      dock.classList.toggle("mini");
      dock.querySelector("#siriser-sd-min").textContent = dock.classList.contains("mini")
        ? "+"
        : "—";
    });
    return dock;
  }

  /** 状态条错误文案：短、人话，不甩完整堆栈/参数 */
  function shortErr(msg) {
    const s = String(msg || "").replace(/\s+/g, " ").trim();
    if (!s) return "出错了";
    if (/未配置 API|OPENAI_API_KEY/.test(s)) return "未配置 API";
    if (/拒收多模态|Unexpected item type/i.test(s)) return "模型不支持看图";
    if (/无权限|403|401|Access denied/i.test(s)) return "无权限或 Key 无效";
    if (/超时|timeout|abort/i.test(s)) return "请求超时";
    if (/429|限速|rate limit/i.test(s)) return "触发限速";
    if (/缺分|missing/i.test(s)) return "有模型缺分";
    return s.slice(0, 24);
  }

  function setStatusDock(stage, detail, tone) {
    const dock = ensureStatusDock();
    dock.classList.add("show", "live");
    dock.classList.remove("err", "ok");
    if (tone === "err") dock.classList.add("err");
    if (tone === "ok") dock.classList.add("ok");
    const st = dock.querySelector("#siriser-sd-stage");
    const dt = dock.querySelector("#siriser-sd-detail");
    if (st) st.textContent = stage || "运行中";
    if (dt) dt.textContent = detail || "";
  }

  function hideStatusDock() {
    const dock = document.getElementById("siriser-status-dock");
    if (dock) {
      dock.classList.remove("live", "err", "ok");
      dock.classList.add("show");
      dock.classList.remove("show");
    }
  }

  // 供 api.js 回写阶段
  try {
    window.SIRISER_SET_STATUS = setStatusDock;
    window.SIRISER_STATUS_HIDE = hideStatusDock;
  } catch (_) {}

  function sendRuntimeMsg(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          const err = chrome.runtime.lastError;
          if (err) {
            log("runtime: " + err.message, "err");
            resolve(null);
            return;
          }
          resolve(res || null);
        });
      } catch (e) {
        log("runtime 异常：" + (e && e.message), "err");
        resolve(null);
      }
    });
  }

  /**
   * 统一异常钉钉出口：所有「非用户主动取消」的停止/超时/失败都必须 await 调这里。
   * 用户手动关自动、取消倒计时 → 不要调用。
   */
  async function notifyAbnormal(title, reason) {
    const text =
      String(title || "异常") +
      "\n" +
      String(reason || "") +
      "\n请打开标注页核对/处理";
    try {
      return await notifyDingTalk(text);
    } catch (e) {
      log("异常推送失败：" + (e && e.message), "err");
      return false;
    }
  }

  async function notifyDingTalk(text, prefix) {
    try {
      await loadConfigFromStorage();
      const hook = String((CFG && CFG.DINGTALK_WEBHOOK) || "").trim();
      if (!hook || !/^https?:\/\//i.test(hook)) {
        log("未配置钉钉 Webhook，跳过推送", "err");
        return false;
      }
      const body =
        (prefix || "【Siriser 标注异常】") +
        "\n" +
        text.slice(0, 800) +
        "\n页面：" +
        location.href.slice(0, 120) +
        "\n时间：" +
        new Date().toLocaleString();

      let res = await sendRuntimeMsg({
        type: "SIRISER_DINGTALK",
        webhook: hook,
        text: body,
      });
      if (!res) {
        log("钉钉：后台无响应，再试一次", "err");
        await sleep(300);
        res = await sendRuntimeMsg({
          type: "SIRISER_DINGTALK",
          webhook: hook,
          text: body,
        });
      }
      if (!res) {
        log(
          "钉钉推送失败：后台无响应。请在 chrome://extensions 移除扩展后重新「加载已解压」",
          "err"
        );
        return false;
      }
      const ok = !!res.ok;
      log(
        ok
          ? "钉钉已推送"
          : "钉钉推送失败：" +
              (res.error || res.body || res.status || JSON.stringify(res)),
        ok ? "ok" : "err"
      );
      return ok;
    } catch (e) {
      log("钉钉推送失败：" + (e && e.message), "err");
      return false;
    }
  }

  /** 定时到点正常停止 → 中性标题钉钉推送（非异常） */
  async function notifyScheduledStop(sess) {
    const label = (sess && sess.label) || "定时停止";
    const endStr = sess && sess.endAt ? new Date(sess.endAt).toLocaleString() : "";
    const text =
      "定时自动停止已触发（" +
      label +
      (endStr ? "，计划 " + endStr : "") +
      "）。当前题已按正常流程处理，自动模式已停止，不再领取新题。";
    try {
      return await notifyDingTalk(text, "【Siriser 定时停止】");
    } catch (e) {
      log("定时停止推送失败：" + (e && e.message), "err");
      return false;
    }
  }

  async function stopAuto(reason, opts) {
    const silent = !!(opts && opts.silent);
    _autoGen += 1;
    _autoRunning = false;
    _cancelSubmit = false;
    saveAutoState({ on: false, phase: "off", submitAt: null, reason: reason || "stopped", at: Date.now() });
    clearSessionDeadline();
    _schedStopAt = 0;
    log("全自动停止：" + (reason || ""));
    // 用户手动关不推送；异常停止才推钉钉（必须 await）
    if (!silent) {
      try {
        await notifyAbnormal("全自动已停止", reason || "异常");
      } catch (_) {}
      try {
        alert("Siriser 全自动已停止：\n" + (reason || "异常"));
      } catch (_) {}
    }
  }

  /** 开始新一轮前清掉旧倒计时，避免重载后串表 */
  async function clearStoredCountdown() {
    const st = await loadAutoState();
    saveAutoState({
      on: !!(st && st.on),
      phase: "idle",
      submitAt: null,
      taskKey: null,
      batchSize: (st && st.batchSize) || 3,
    });
    _cancelSubmit = true;
    clearCountdownInPanel();
    await sleep(50);
    _cancelSubmit = false;
  }

  async function waitImagesSafe(ms, opts) {
    const fn =
      typeof waitForImagesReady === "function"
        ? waitForImagesReady
        : window.__SIRISER_WAIT_IMAGES__ || window.waitForImagesReady;
    if (typeof fn !== "function") {
      log("waitForImagesReady 不可用，跳过等图", "err");
      return true;
    }
    try {
      return await fn(ms, opts);
    } catch (e) {
      log("等图失败(忽略)：" + (e && e.message));
      return true;
    }
  }

  /** 开评前倒计时：全屏半透明 + 居中数字 + 右下角取消 */
  function ensureCountdownOverlay() {
    let box = document.getElementById("siriser-countdown-overlay");
    if (box) return box;
    box = document.createElement("div");
    box.id = "siriser-countdown-overlay";
    box.innerHTML = `
      <div class="sir-cd-center">
        <div class="sir-cd-label" id="siriser-cd-label">即将开始评分</div>
        <div class="sir-cd-num" id="siriser-cd-num">5</div>
        <div class="sir-cd-sub">任务包已就绪，可随时取消</div>
      </div>
      <button type="button" class="sir-cd-cancel" id="siriser-cd-cancel">取消倒计时</button>
    `;
    document.body.appendChild(box);
    return box;
  }

  async function countdownBeforeScore(seconds, label) {
    const total = Math.max(1, Number(seconds) || 5);
    const box = ensureCountdownOverlay();
    const numEl = box.querySelector("#siriser-cd-num");
    const labelEl = box.querySelector("#siriser-cd-label");
    const cancelBtn = box.querySelector("#siriser-cd-cancel");
    if (labelEl) labelEl.textContent = `即将开始${label || "评分"}`;
    box.classList.add("show");
    document.documentElement.classList.add("siriser-dim");

    let cancelled = false;
    const onCancel = () => {
      cancelled = true;
    };
    if (cancelBtn) cancelBtn.addEventListener("click", onCancel, { once: true });

    try {
      for (let i = total; i >= 1; i--) {
        if (cancelled || _cancelSubmit) break;
        if (numEl) numEl.textContent = String(i);
        await sleep(1000);
      }
    } finally {
      if (cancelBtn) cancelBtn.removeEventListener("click", onCancel);
      box.classList.remove("show");
      document.documentElement.classList.remove("siriser-dim");
    }

    if (cancelled || _cancelSubmit) {
      log("开评倒计时已取消");
      toastMsg("已取消，未开始本题评分");
      return false;
    }
    return true;
  }

  function planAutoSubmitTiming(elapsedMs, targetMs, hardCapMs, extensionMs) {
    const elapsed = Math.max(0, Number(elapsedMs) || 0);
    const target = Math.max(0, Number(targetMs) || 0);
    const hardCap = Math.max(0, Number(hardCapMs) || 0);
    if (elapsed >= hardCap) {
      return { effectiveTargetMs: elapsed, waitMs: 0, submitImmediately: true };
    }
    if (elapsed < target) {
      return { effectiveTargetMs: target, waitMs: target - elapsed, submitImmediately: false };
    }
    const extension = Math.max(0, Number(extensionMs) || 0);
    const effectiveTargetMs = Math.min(hardCap, elapsed + extension);
    return {
      effectiveTargetMs,
      waitMs: Math.max(0, effectiveTargetMs - elapsed),
      submitImmediately: false,
    };
  }

  async function autoOneTask(gen) {
    const myGen = gen == null ? _autoGen : gen;
    await clearStoredCountdown();
    // 新任务包：5 秒全屏倒计时后再开评（可取消）
    const go = await countdownBeforeScore(5, "评分");
    if (!go || _autoGen !== myGen) {
      // 取消倒计时 = 停掉整段自动，避免死循环
      await stopAuto("用户取消开评倒计时", { silent: true });
      toastMsg("已取消开评，自动模式已停止");
      return false;
    }

    // 本题目标：从开始评分到提交，总时长随机 6–8 分钟
    const t0 = Date.now();
    const targetMs = randTotalMs();
    log(`本题目标总时长 ${fmtDur(targetMs)}（含评分+勾选+等待）`);

    await waitImagesSafe(20000, { notifyOnTimeout: false });
    await sleep(800);

    let scores = null;
    let missing = [];
    let retries = 0;
    try {
      for (;;) {
        if (_autoGen !== myGen) return false;
        if (retries > 0) {
          await waitImagesSafe(10000, { notifyOnTimeout: false });
          await sleep(600);
        }
        scores = await runAutoScore(false, {
          batchSize: Number(CFG.AUTO_BATCH) || 3,
          autoMode: true,
        });
        missing = missingScoreIds(scores);
        if (!missing.length) {
          log("全自动：分数齐全", "ok");
          break;
        }
        retries += 1;
        log(`全自动：缺分 ${missing.join(",")} → 最多再重评 1 次`, "err");
        if (retries >= 2) {
          clearCountdownInPanel();
          await stopAuto(`重评后仍缺分：${missing.join(",")}`);
          return false;
        }
        await sleep(2500);
      }
    } catch (e) {
      // API/执行异常：整段停止，不再循环下一题（防死循环）
      clearCountdownInPanel();
      log("API/执行异常，自动已停止：" + (e && e.message), "err");
      toastMsg("API 异常，自动已停止，请改配置后再启动");
      setStatusDock("已停止", shortErr((e && e.message) || ""), "err");
      await stopAuto("API/执行异常：" + ((e && e.message) || "未知错误"));
      return false;
    }

    if (_autoGen !== myGen) return false;

    const elapsed = Date.now() - t0;
    const wait = targetMs - elapsed;
    setStatusDock("等待提交", `已用 ${fmtDur(elapsed)} / ${fmtDur(targetMs)}`, "ok");

    // 15 分钟只限制评分完成后的额外等待，不得阻止已完成评分的自动提交。
    const extend = wait <= 0 ? 45000 + Math.floor(Math.random() * 45001) : 0;
    const submitPlan = planAutoSubmitTiming(elapsed, targetMs, TOTAL_HARD_CAP_MS, extend);
    const effectiveTarget = submitPlan.effectiveTargetMs;
    const wait2 = submitPlan.waitMs;
    if (submitPlan.submitImmediately) {
      log(
        `评分/勾选用时 ${fmtDur(elapsed)}，已超过 ${fmtDur(TOTAL_HARD_CAP_MS)}；评分完成，立即自动提交`,
        "err"
      );
      toastMsg("评分耗时较长，正在立即自动提交");
      setStatusDock("立即提交", `已用 ${fmtDur(elapsed)} · 评分已完成`, "ok");
    } else if (wait <= 0) {
      log(
        `评分/勾选已用 ${fmtDur(elapsed)} 超过原目标 ${fmtDur(targetMs)}，顺延到 ${fmtDur(effectiveTarget)} 后提交（不中断）`
      );
      toastMsg("评分较慢，总时长已顺延，稍后自动提交");
      setStatusDock("等待提交", `顺延 · 已用 ${fmtDur(elapsed)}`, "ok");
    }

    const deadline = Date.now() + wait2;
    const taskKey = (taskPromptKey() || "t") + "@" + Date.now();
    _cancelSubmit = false;
    saveAutoState({
      on: true,
      phase: "countdown",
      submitAt: deadline,
      taskKey,
      batchSize: Number(CFG.AUTO_BATCH) || 3,
    });
    log(
      `全自动：评分+勾选用时 ${fmtDur(elapsed)}，再等 ${fmtDur(wait2)} 提交（合计约 ${fmtDur(effectiveTarget)}）`
    );

    while (Date.now() < deadline) {
      if (_autoGen !== myGen) return false;
      const st = await loadAutoState();
      if (!st.on || _cancelSubmit) {
        clearCountdownInPanel();
        saveAutoState({ ...st, phase: "idle", submitAt: null, taskKey: null });
        log("倒计时已取消，不提交");
        return false;
      }
      if (st.taskKey && st.taskKey !== taskKey) {
        clearCountdownInPanel();
        log("倒计时被新任务替换，旧闹钟作废");
        return false;
      }
      const left = deadline - Date.now();
      const totalUsed = Date.now() - t0;
      updateCountdownInPanel(
        `${fmtDur(left)} 后自动提交 · 已用 ${fmtDur(totalUsed)}/${fmtDur(effectiveTarget)}`,
        left < 30 * 1000
      );
      await sleep(1000);
    }

    if (_cancelSubmit || _autoGen !== myGen) {
      clearCountdownInPanel();
      return false;
    }
    updateCountdownInPanel("正在提交…", true);
    // 提交可能触发整页跳转：提交前先把 phase 记成 running，刷新后才能续跑
    saveAutoState({
      on: true,
      phase: "running",
      submitAt: null,
      taskKey: null,
      batchSize: Number(CFG.AUTO_BATCH) || 3,
    });
    const ok = await submitAutoForDeadline();
    clearCountdownInPanel();
    // 未跳转则继续等 2s 跑下一题；已跳转则由加载页续跑
    saveAutoState({
      on: true,
      phase: "running",
      submitAt: null,
      taskKey: null,
      batchSize: Number(CFG.AUTO_BATCH) || 3,
    });
    if (!ok) {
      log("全自动：提交按钮未找到", "err");
      setStatusDock("提交失败", "未找到提交按钮", "err");
      await stopAuto("提交按钮未找到，未自动提交，请人工提交本题");
      return false;
    }
    log(`全自动：已提交 · 总用时 ${fmtDur(Date.now() - t0)}`, "ok");
    return ok;
  }

  function taskPromptKey() {
    try {
      return String(readPrompt() || "").slice(0, 40);
    } catch (_) {
      return "";
    }
  }

  /**
   * 本题总时长目标：随机 6–8 分钟（含评分+勾选+等待）。
   * 硬上限 15 分钟：评分模型慢时仍尽量在「像人」的窗口内交，而不是直接判超时。
   */
  function randTotalMs() {
    return 6 * 60 * 1000 + Math.floor(Math.random() * 2 * 60 * 1000 + 1);
  }
  const TOTAL_HARD_CAP_MS = 15 * 60 * 1000;

  async function autoLoop() {
    if (_autoRunning) return;
    const st = await loadAutoState();
    if (!st.on) return;
    const myGen = ++_autoGen;
    _autoRunning = true;
    const batchSize = Number(st.batchSize) || 3;
    CFG.AUTO_BATCH = batchSize;
    log("自动循环启动 batch=" + batchSize + " gen=" + myGen);
    await refreshSchedStopAt();

    while (_autoRunning && _autoGen === myGen) {
      const st2 = await loadAutoState();
      if (!st2.on || _autoGen !== myGen) break;
      try {
        // 仅恢复「仍有效的」倒计时（时间够长 + taskKey 对得上）
        if (st2.phase === "countdown" && st2.submitAt && st2.taskKey) {
          const left = st2.submitAt - Date.now();
          const keyNow = taskPromptKey();
          const sameTask = !keyNow || !st2.taskKey || st2.taskKey.indexOf(keyNow) === 0;
          if (left > 45 * 1000 && sameTask) {
            log(`续跑：恢复倒计时 ${fmtDur(left)}`);
            const deadline = st2.submitAt;
            const taskKey = st2.taskKey;
            _cancelSubmit = false;
            while (Date.now() < deadline && _autoGen === myGen) {
              const stc = await loadAutoState();
              if (!stc.on || _cancelSubmit || (stc.taskKey && stc.taskKey !== taskKey)) break;
              updateCountdownInPanel(
                `${fmtDur(deadline - Date.now())} 后自动提交`,
                deadline - Date.now() < 30000
              );
              await sleep(1000);
            }
            clearCountdownInPanel();
            if (!_cancelSubmit && _autoGen === myGen) {
              updateCountdownInPanel("正在提交…", true);
              await submitAutoForDeadline();
            } else {
              log("倒计时已取消/作废，不提交");
            }
            clearCountdownInPanel();
            saveAutoState({ on: true, phase: "idle", submitAt: null, taskKey: null });
            await sleep(1500);
            continue;
          }
          // 过期或不是本题 → 作废
          log("旧倒计时作废（已过期或非本题），重新评分");
          saveAutoState({ on: true, phase: "idle", submitAt: null, taskKey: null });
        }

        // 定时自动停止：只在「准备开始一道新题」的边界判定，
        // 因此正在进行的题会先正常打完/提交，到点也不打断它 → 打完当前题再停。
        const sess = await loadSessionDeadline();
        if (sess && sess.endAt && Date.now() >= sess.endAt) {
          log("定时已到（" + (sess.label || "") + "），打完当前题后停止自动", "ok");
          clearSessionDeadline();
          await stopAuto("定时自动停止：" + (sess.label || ""), { silent: true });
          toastMsg("定时到点，已停止自动（当前题已提交）");
          try {
            await notifyScheduledStop(sess);
          } catch (_) {}
          break;
        }

        const ok = await autoOneTask(myGen);
        if (!_autoRunning || _autoGen !== myGen) break;
        if (!ok) {
          // 失败且开关已关 → 退出；否则才是继续下一题
          const stx = await loadAutoState();
          if (!stx.on) break;
          log("本题未完成，按当前开关决定是否继续");
        }
        await sleep(2000);
        if (!_autoRunning || _autoGen !== myGen) break;
      } catch (e) {
        log("全自动异常：" + (e && e.message), "err");
        await stopAuto("执行异常：" + (e && e.message));
        break;
      }
    }
    _autoRunning = false;
    log("自动循环结束 gen=" + myGen);
  }

  /** 只切换模式，不启动评分 */
  async function setAutoMode(on) {
    const prev = await loadAutoState();
    saveAutoState({
      on: !!on,
      phase: on ? "idle" : "off",
      startedAt: Date.now(),
      batchSize: prev.batchSize || 3,
    });
    if (!on) {
      _autoRunning = false;
      clearSessionDeadline();
    }
    log(on ? "自动模式=开（未启动，待点逐张/3张评）" : "自动模式=关");
  }

  /** 由「逐张/3张评」启动：真正跑起来 */
  async function startAuto(batchSize) {
    await loadConfigFromStorage();
    if (!CFG.API_URL && !CFG.OPENAI_API_KEY) {
      toastMsg("请先配置 API");
      await notifyAbnormal("启动失败", "未配置 API（Base URL / API Key）");
      throw new Error("未配置 API");
    }
    const prev = await loadAutoState();
    saveAutoState({
      on: true,
      phase: "running",
      startedAt: Date.now(),
      batchSize: batchSize || prev.batchSize || 3,
    });
    setAutoSwitchUI(true);
    _autoRunning = false; // allow loop

    // 定时自动停止：按当前配置算出本次会话绝对停止时刻并持久化（跨刷新保留）
    let timerNote = "";
    try {
      await loadConfigFromStorage();
      const endAt = computeSessionEndAt(CFG);
      if (endAt) {
        saveSessionDeadline({
          endAt,
          mode: "clock",
          label: stopLabelFor(CFG),
          setAt: Date.now(),
        });
        const leftH = (endAt - Date.now()) / 3600000;
        timerNote = ` · 定时：${stopLabelFor(CFG)}（约剩 ${leftH.toFixed(1)} 小时，到点打完当前题再停）`;
        log("定时停止已设定 " + stopLabelFor(CFG) + " → " + new Date(endAt).toLocaleString(), "ok");
      } else {
        clearSessionDeadline();
      }
    } catch (e) {
      log("设定定时停止失败(忽略)：" + (e && e.message), "err");
    }

    toastMsg(`自动已启动（${batchSize || prev.batchSize || 3}张/批 · 倒计时后提交）${timerNote}`);
    log("启动自动循环 batch=" + (batchSize || prev.batchSize || 3), "ok");
    autoLoop();
  }

  function toastMsg(msg) {
    const el = document.getElementById("siriser-toast");
    if (!el) {
      try {
        alert(msg);
      } catch (_) {}
      return;
    }
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove("show"), 3200);
  }

  /** 评完分提示音（Web Audio，无外部文件） */
  function beepDone() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      const ctx = beepDone._ctx || (beepDone._ctx = new AC());
      if (ctx.state === "suspended") ctx.resume();
      const t = ctx.currentTime;
      const play = (freq, start, dur, vol) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = "sine";
        o.frequency.value = freq;
        g.gain.setValueAtTime(0.0001, t + start);
        g.gain.exponentialRampToValueAtTime(vol, t + start + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + start + dur);
        o.connect(g);
        g.connect(ctx.destination);
        o.start(t + start);
        o.stop(t + start + dur + 0.05);
      };
      // 两声轻响：叮-咚
      play(880, 0, 0.18, 0.22);
      play(1174.66, 0.22, 0.22, 0.2);
      log("提示音：评分完成");
    } catch (e) {
      log("提示音失败(忽略)：" + (e && e.message));
    }
  }

  // ── 结果面板 ──
  function fmtDur(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return m > 0 ? `${m}:${String(r).padStart(2, "0")}` : `${r}s`;
  }

  function updateCountdownInPanel(text, urgent) {
    let el = document.getElementById("siriser-countdown");
    if (!el) {
      const panel = document.getElementById("siriser-result");
      if (!panel) return;
      const body = document.getElementById("siriser-result-body");
      if (!body) return;
      el = document.createElement("div");
      el.id = "siriser-countdown";
      panel.querySelector(".sir-r-h")?.insertAdjacentElement("afterend", el);
      el.addEventListener("click", (e) => {
        if (e.target.closest("[data-cd='cancel']")) {
          _cancelSubmit = true;
          log("用户取消倒计时提交 → 停止自动，避免再弹开评倒计时");
          clearCountdownInPanel();
          toastMsg("已取消自动提交，自动模式已停止");
          saveAutoState({
            on: false,
            phase: "off",
            submitAt: null,
            taskKey: null,
          });
          setAutoSwitchUI(false);
          _autoGen += 1;
          _autoRunning = false;
        }
      });
    }
    el.innerHTML =
      `<strong>倒计时提交</strong> <b class="sir-cd${urgent ? " urgent" : ""}">${escapeHtml(text)}</b>` +
      `<button type="button" class="sir-cd-btn" data-cd="cancel">取消提交</button>`;
    el.classList.add("show");
    document.getElementById("siriser-result")?._resultControls?.clamp();
  }

  function clearCountdownInPanel() {
    const el = document.getElementById("siriser-countdown");
    if (el) el.classList.remove("show");
  }

  // Presentation only: dragging/collapsing does not affect score submission.
  function bindResultPanelControls(panel) {
    const header = panel.querySelector(".sir-r-h");
    header.title = "拖动标题栏移动窗口";
    const toggle = panel.querySelector('[data-r="collapse"]');
    const title = header.querySelector("strong");
    let drag = null;
    function place(left, top) {
      const rect = panel.getBoundingClientRect();
      panel.style.right = "auto"; panel.style.bottom = "auto";
      panel.style.left = Math.max(8, Math.min(left, Math.max(8, window.innerWidth - rect.width - 8))) + "px";
      panel.style.top = Math.max(8, Math.min(top, Math.max(8, window.innerHeight - rect.height - 8))) + "px";
    }
    function clamp() {
      if (!panel.classList.contains("open")) return;
      const r = panel.getBoundingClientRect(); place(r.left, r.top);
    }
    function collapse(value) {
      const r = panel.getBoundingClientRect();
      panel.classList.toggle("collapsed", value);
      toggle.textContent = value ? "展开" : "收起";
      toggle.setAttribute("aria-expanded", String(!value));
      title.textContent = value ? "评分结果" : "评分结果（请核对后提交）";
      place(r.left, r.top);
    }
    toggle.addEventListener("click", () => collapse(!panel.classList.contains("collapsed")));
    header.addEventListener("pointerdown", e => {
      if (e.button !== 0 || e.isPrimary === false || e.target.closest("button,a,input,select,textarea")) return;
      const r = panel.getBoundingClientRect();
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, left: r.left, top: r.top };
      header.setPointerCapture(e.pointerId); header.classList.add("dragging"); e.preventDefault();
    });
    header.addEventListener("pointermove", e => {
      if (drag && drag.id === e.pointerId) place(drag.left + e.clientX - drag.x, drag.top + e.clientY - drag.y);
    });
    function end(e) {
      if (!drag || drag.id !== e.pointerId) return;
      drag = null; header.classList.remove("dragging");
      if (header.hasPointerCapture(e.pointerId)) header.releasePointerCapture(e.pointerId);
    }
    header.addEventListener("pointerup", end); header.addEventListener("pointercancel", end);
    header.addEventListener("lostpointercapture", end); window.addEventListener("resize", clamp);
    panel._resultControls = { clamp, expand: () => { panel.classList.add("open"); collapse(false); } };
  }

  function showResultPanel(scores, report, clicked, meta) {
    const dur = meta && meta.elapsedMs != null ? fmtDur(meta.elapsedMs) : "—";
    const clickDur = meta && meta.clickMs != null ? fmtDur(meta.clickMs) : "—";
    const mode = (meta && meta.batchSize) || 1;
    const modeLabel = mode >= 3 ? `${mode}张合评` : "逐张评";
    let panel = document.getElementById("siriser-result");
    if (!panel) {
      panel = document.createElement("div");
      panel.id = "siriser-result";
      panel.innerHTML = `
        <div class="sir-r-h">
          <strong>评分结果（请核对后提交）</strong>
          <span class="sir-r-acts">
            <button type="button" data-r="submit">提交当前题</button>
            <button type="button" data-r="collapse" aria-expanded="true" aria-controls="siriser-result-body">收起</button>
          </span>
        </div>
        <div class="sir-r-b" id="siriser-result-body"></div>`;
      document.body.appendChild(panel);
      panel.addEventListener("click", (e) => {
        const b = e.target.closest("button[data-r]");
        if (!b) return;
        if (b.dataset.r === "submit") {
          if (submitAndNext()) panel.classList.remove("open");
        }
      });
    }
    if (!panel._resultControls) bindResultPanelControls(panel);
    const body = panel.querySelector("#siriser-result-body");
    const fmt = (v) => (v == null || v === "na" ? "无" : v);
    const taskCards = (window.__SIRISER_LAST_TASK__ && window.__SIRISER_LAST_TASK__._cards) || [];
    body.innerHTML =
      `<div class="sir-r-sum">运行时间 <b class="sir-dur">${dur}</b> · 勾选耗时 <b class="sir-dur">${clickDur}</b> · ${modeLabel} · 勾选 ${clicked} 次 · 请对照左侧徽章</div>` +
      scores
        .map((s, i) => {
          const r = report[i] || { filled: [], miss: [] };
          const card = taskCards.find((c) => c.id === s.model);
          const thumb = card && card.imgEl
            ? `<img class="sir-thumb" src="${escapeHtml(
                card.imgEl.currentSrc || card.imgEl.src || ""
              )}" alt="${escapeHtml(s.model)}" />`
            : `<span class="sir-thumb sir-noimg">无图</span>`;
          return `<div class="sir-r-row">
            <b>${escapeHtml(s.model)}</b>
            ${thumb}
            <span class="sir-r-scores">指${fmt(s.alignment)} 局${fmt(s.quality)} 保${fmt(
              s.preservation
            )} 全${fmt(s.consistency)} 真${fmt(s.realism)}</span>
            <span class="sir-r-note">${escapeHtml(s.notes || "")}</span>
            <span class="sir-r-meta">${
              r.miss.length
                ? '<span class="err">' + escapeHtml(r.miss.join(", ")) + "</span>"
                : '<span class="ok">已勾选</span>'
            }</span>
          </div>`;
        })
        .join("");
    panel.classList.add("open");
    panel._resultControls.clamp();
  }

  // ── 诊断 ──
  function structureDigest() {
    const t = collectTask();
    const { groups, rows } = collectScoreGroups();
    const lines = [];
    lines.push("URL: " + location.href);
    lines.push("prompt(" + t.prompt.length + "): " + t.prompt.slice(0, 80));
    lines.push("ref: " + (t.referenceImages.length ? "yes" : "no"));
    lines.push("radio_rows: " + (rows || []).length);
    lines.push("models:");
    t.models.forEach((m) => {
      const bag = groups.get(m.id) || {};
      const dims = DIMS.map((d) => {
        const n = bag[d] ? Object.keys(bag[d].options).length : 0;
        const src = bag[d] && bag[d].source ? bag[d].source : "-";
        return d.slice(0, 3) + (n || "×") + (src === "radio-row" ? "" : "/" + src);
      }).join(" ");
      lines.push(
        "  " +
          m.id +
          " img=" +
          (m.images.length ? "1" : "0") +
          "  " +
          dims
      );
    });
    const btns = qa("button,[role=button]")
      .filter(visible)
      .map(textOf)
      .filter(Boolean)
      .slice(0, 12);
    lines.push("buttons: " + btns.join(" | "));
    return lines.join("\n");
  }

  function diagnose() {
    const t = collectTask();
    const { groups, rows } = collectScoreGroups();
    const digest = structureDigest();
    const lines = [];
    lines.push(`<span class="muted">URL</span> ${escapeHtml(location.href)}`);
    lines.push(
      `图 ${t._meta.withImg}/${t.models.length} · 参考图 ${
        t._meta.hasRef ? '<span class="ok">有</span>' : '<span class="err">无</span>'
      } · Prompt ${t.prompt.length} 字`
    );
    if (t.prompt) lines.push(`  ${escapeHtml(t.prompt.slice(0, 70))}…`);
    lines.push("模型（图 + 五维选项数）：");
    t.models.forEach((m) => {
      const bag = groups.get(m.id) || {};
      const parts = DIMS.map((d) => {
        const n = bag[d] ? Object.keys(bag[d].options).length : 0;
        const src = bag[d] ? bag[d].source || "?" : "-";
        return (n ? n : "×") + (src === "radio-row" ? "" : src);
      });
      const okN = parts.filter((p) => parseInt(p, 10) >= 8).length;
      lines.push(
        `  ${m.id}: img=${m.images.length ? "1" : "0"} 选项[${parts.join(",")}] ${
          okN === 5 && m.images.length
            ? '<span class="ok">就绪</span>'
            : okN === 5
              ? '<span class="err">缺图</span>'
              : '<span class="err">' + okN + "/5 控件</span>"
        }`
      );
    });
    lines.push(`<span class="muted">radio 行</span> ${(rows || []).length} 组`);
    const btn = findTextButton(HEU.submitText || /提交/);
    lines.push(
      `提交按钮 ${
        btn ? '<span class="ok">' + escapeHtml(textOf(btn)) + "</span>" : '<span class="err">无</span>'
      }`
    );
    lines.push(`<span class="muted">结构摘要可点下方复制</span>`);
    return {
      ok: t._meta.withImg > 0 && t.models.length > 0,
      html: lines.join("\n"),
      text: lines.map((l) => l.replace(/<[^>]+>/g, "")).join("\n") + "\n\n" + digest,
      digest,
      meta: t._meta,
      models: t.models.map((m) => ({ id: m.id, imgs: m.images.length })),
    };
  }

  // ── 消息 ──
  window.__SIRISER_CONTENT__ = {
    collectTask,
    runAutoScore,
    applyScores,
    submitAndNext,
    diagnose,
    collectScoreGroups,
    collectVisuals,
    structureDigest,
    dumpLogs,
  };

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !msg.type) return;
    (async () => {
      try {
        if (msg.type === "SIRISER_PING") {
          sendResponse({ ok: true, url: location.href });
          return;
        }
        if (msg.type === "SIRISER_GET_TASK_ID") {
          sendResponse({ ok: false, error: "答题页 URL 不作为分包 ID 来源，请从标注工作台读取。" });
          return;
        }
        if (msg.type === "SIRISER_GET_ACTIVE_PACKAGE_ID") {
          const result = readActiveWorkbenchPackageId(document);
          if (result.ok) {
            log(`工作台识别到题目 ID：${result.taskId}`, "ok");
            toastMsg(`识别到题目 ID：${result.taskId}`);
          } else {
            log(`工作台题目 ID 识别失败：${result.error}`, "err");
            toastMsg(`题目 ID 识别失败：${result.error}`);
          }
          sendResponse(result);
          return;
        }
        if (msg.type === "SIRISER_COLLECT") {
          const t = collectTask();
          sendResponse({
            ok: true,
            task: {
              prompt: t.prompt,
              referenceImages: t.referenceImages,
              models: t.models,
              meta: t._meta,
            },
          });
          return;
        }
        if (msg.type === "SIRISER_EVAL") {
          try {
            const scores = await runAutoScore(!!msg.onlyCurrent, {
              batchSize: msg.batchSize || 1,
            });
            sendResponse({ ok: true, scores });
          } catch (e) {
            await notifyAbnormal("评分失败（popup）", e && e.message);
            throw e;
          }
          return;
        }
        if (msg.type === "SIRISER_SUBMIT") {
          sendResponse({ ok: true, submitted: submitAndNext() });
          return;
        }
        if (msg.type === "SIRISER_DIAGNOSE") {
          const d = diagnose();
          sendResponse({
            ok: true,
            ...d,
            logs: dumpLogs(),
            radioDebug: typeof dumpRadioDebug === "function" ? dumpRadioDebug() : "",
          });
          return;
        }
        if (msg.type === "SIRISER_GET_LOGS") {
          sendResponse({ ok: true, logs: dumpLogs(), config: {
            hasApiUrl: !!(CFG && CFG.API_URL),
            hasApiKey: !!(CFG && CFG.API_KEY),
            hasOaKey: !!(CFG && CFG.OPENAI_API_KEY),
            oaModel: (CFG && CFG.OPENAI_MODEL) || "",
          } });
          return;
        }
      } catch (e) {
        sendResponse({ ok: false, error: String(e.message || e) });
      }
    })();
    return true;
  });

  function setAutoSwitchUI(on) {
    const sw = document.getElementById("siriser-auto-switch");
    const lb = document.getElementById("siriser-auto-label");
    if (sw) sw.classList.toggle("on", !!on);
    if (lb) lb.textContent = on ? "已开启自动模式" : "已关闭自动模式";
  }

  const HUMAN_KEY = "SIRISER_HUMAN_CLICK";
  function loadHumanMode() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get([HUMAN_KEY], (r) => resolve(!!r[HUMAN_KEY]));
      } catch (_) {
        resolve(false);
      }
    });
  }
  function saveHumanMode(on) {
    _humanModeCached = !!on;
    try {
      chrome.storage.local.set({ [HUMAN_KEY]: !!on });
    } catch (_) {}
  }
  function setHumanSwitchUI(on) {
    const sw = document.getElementById("siriser-human-switch");
    const lb = document.getElementById("siriser-human-label");
    if (sw) sw.classList.toggle("on", !!on);
    if (lb) lb.textContent = on ? "已开启拟人点击（全题5–6分钟）" : "已关闭拟人点击";
  }

  /** 用随机权重分配总时长，并按累计时间校准，避免页面滚动导致越点越慢。 */
  let _humanModeCached = null;
  async function humanClickDelay(dueAt, pacedClicks) {
    if (!pacedClicks) {
      await sleep(60);
      return 60;
    }
    const ms = Math.max(0, Math.round(dueAt - Date.now()));
    await sleep(ms);
    return ms;
  }

  // ── 悬浮球 ──
  function mountFab() {
    if (document.getElementById("siriser-root")) return;
    const root = document.createElement("div");
    root.id = "siriser-root";
    root.innerHTML = `
      <div id="siriser-menu" role="menu">
        <div class="sir-title">Siriser · 评分</div>
        <div class="sir-toggle-row" data-act="auto-toggle" role="button" tabindex="0" title="模式开关；点「逐张/3张」才启动">
          <span class="sir-toggle-label" id="siriser-auto-label">已关闭自动模式</span>
          <span class="sir-switch" id="siriser-auto-switch"><i></i></span>
        </div>
        <div class="sir-toggle-row" data-act="human-toggle" role="button" tabindex="0" title="完整一题约 90 格，勾选用时 5–6 分钟">
          <span class="sir-toggle-label" id="siriser-human-label">已关闭拟人点击</span>
          <span class="sir-switch" id="siriser-human-switch"><i></i></span>
        </div>
        <button type="button" class="primary" data-act="eval-1"><svg class="sir-ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h10M4 18h7"/></svg>逐张评全部</button>
        <button type="button" class="primary" data-act="eval-3"><svg class="sir-ic" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="7" height="7" rx="1.5"/><rect x="14" y="4" width="7" height="7" rx="1.5"/><rect x="3" y="13" width="7" height="7" rx="1.5"/></svg>3张合评全部</button>
        <button type="button" data-act="eval-one"><svg class="sir-ic" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="3.2"/><path d="M5 19c1.5-3.5 4-5 7-5s5.5 1.5 7 5"/></svg>只评当前模型</button>
        <div class="sir-title">工具</div>
        <button type="button" data-act="map"><svg class="sir-ic" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="8" height="8" rx="1.5"/><rect x="13" y="5" width="8" height="8" rx="1.5"/><rect x="3" y="15" width="8" height="5" rx="1.5"/></svg>对照预览</button>
        <button type="button" data-act="stats"><svg class="sir-ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 19V10M12 19V5M19 19v-7"/></svg>模型统计</button>
        <button type="button" data-act="results">评分结果 · 展开</button>
        <button type="button" data-act="fill-demo"><svg class="sir-ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12l4 4L20 6"/></svg>自检勾选</button>
        <button type="button" data-act="submit"><svg class="sir-ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>提交当前题</button>
        <button type="button" data-act="diag"><svg class="sir-ic" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6"/><path d="M20 20l-3.5-3.5"/></svg>诊断识别</button>
        <button type="button" data-act="copy-logs"><svg class="sir-ic" viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="4" width="12" height="14" rx="2"/><path d="M6 8H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-1"/></svg>复制运行日志</button>
        <div class="sir-hint">拖动球移动 · 点击展开<br/>开关≠启动，点评分按钮才开跑</div>
      </div>
      <div id="siriser-diag" role="dialog">
        <div class="sir-d-h"><span>诊断</span><button type="button" class="sir-close" data-act="close-diag" aria-label="关闭">×</button></div>
        <div class="sir-d-b" id="siriser-diag-body"></div>
      </div>
      <button type="button" id="siriser-fab" title="Siriser">AI</button>`;
    document.body.appendChild(root);

    // 提示条挂在 body 底部，不受悬浮球位置影响
    let toastEl = document.getElementById("siriser-toast");
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.id = "siriser-toast";
      document.body.appendChild(toastEl);
    }

    const fab = root.querySelector("#siriser-fab");
    const menu = root.querySelector("#siriser-menu");
    const diag = root.querySelector("#siriser-diag");
    const diagBody = root.querySelector("#siriser-diag-body");

    let dragging = false,
      moved = false,
      sx = 0,
      sy = 0,
      ox = 0,
      oy = 0;

    function placeRoot(x, y) {
      const w = window.innerWidth;
      const h = window.innerHeight;
      x = Math.max(8, Math.min(w - 60, x));
      y = Math.max(8, Math.min(h - 60, y));
      root.style.right = "auto";
      root.style.bottom = "auto";
      root.style.left = x + "px";
      root.style.top = y + "px";
    }

    fab.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      dragging = true;
      moved = false;
      sx = e.clientX;
      sy = e.clientY;
      const rect = root.getBoundingClientRect();
      ox = rect.left;
      oy = rect.top;
      try {
        fab.setPointerCapture(e.pointerId);
      } catch (_) {}
    });
    fab.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const dx = e.clientX - sx;
      const dy = e.clientY - sy;
      if (!moved && Math.hypot(dx, dy) < 6) return;
      moved = true;
      placeRoot(ox + dx, oy + dy);
    });
    fab.addEventListener("pointerup", (e) => {
      if (!dragging) return;
      dragging = false;
      try {
        fab.releasePointerCapture(e.pointerId);
      } catch (_) {}
      if (moved) {
        const rect = root.getBoundingClientRect();
        try {
          localStorage.setItem(
            "siriser_fab_pos",
            JSON.stringify({ x: rect.left, y: rect.top })
          );
        } catch (_) {}
        return;
      }
      const open = menu.classList.toggle("open");
      fab.classList.toggle("open", open);
      if (!open) diag.classList.remove("open");
    });

    try {
      const saved = JSON.parse(localStorage.getItem("siriser_fab_pos") || "null");
      if (saved && typeof saved.x === "number") placeRoot(saved.x, saved.y);
    } catch (_) {}

    function toast(msg) {
      toastEl.textContent = msg;
      toastEl.classList.add("show");
      clearTimeout(toast._t);
      toast._t = setTimeout(() => toastEl.classList.remove("show"), 3200);
    }

    function setBusy(b, label) {
      fab.classList.toggle("busy", b);
      fab.textContent = b ? "…" : "AI";
      menu.querySelectorAll("button").forEach((x) => (x.disabled = b));
      if (label) toast(label);
    }

    async function selfTestClick() {
      const { groups, labels, rows } = collectScoreGroups();
      const rowCount = (rows || []).length;
      log(`自检 radio 行=${rowCount} 模型=${labels.length}`);
      let n = 0;
      // 1) 最稳：直接点每一行的「1」
      (rows || []).forEach((row) => {
        const t = row.options["1"] || row.options[1] || row.options["01"];
        if (t) {
          fireClick(t);
          markSelected(t);
          n += 1;
        }
      });
      // 2) 若按行点仍为 0，再按模型/维点
      if (n === 0) {
        labels.forEach(({ id }) => {
          const bag = groups.get(id) || {};
          DIMS.forEach((d) => {
            const cell = bag[d];
            if (!cell) return;
            const t = pickTargetEl(cell.options, 1);
            if (t) {
              fireClick(t);
              markSelected(t);
              n += 1;
            }
          });
        });
      }
      log(`自检点击 ${n}（每行应点「1」）`);
      if (n === 0) {
        toast(`自检 0 次 · v4。已打开诊断，请复制运行日志`);
        const d = diagnose();
        const radioDbg = typeof dumpRadioDebug === "function" ? dumpRadioDebug() : "";
        diagBody.innerHTML =
          d.html + '\n\n<span class="muted">RADIO DEBUG</span>\n' + escapeHtml(radioDbg);
        diag.classList.add("open");
        menu.classList.remove("open");
        log("RADIO DEBUG\n" + radioDbg);
      } else {
        toast(`自检点击 ${n} 次。应看到每个模型 5 行的「1」都亮 · v4`);
      }
    }

    async function copyDigest() {
      const d = structureDigest();
      try {
        await navigator.clipboard.writeText(d);
        toast("结构摘要已复制，可粘贴给我");
      } catch {
        // 兜底
        const ta = document.createElement("textarea");
        ta.value = d;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
        toast("结构摘要已复制");
      }
    }

    menu.addEventListener("click", async (e) => {
      const btn = e.target.closest("[data-act]");
      if (!btn || (btn.tagName === "BUTTON" && btn.disabled)) return;
      const act = btn.dataset.act;

      if (act === "results") {
        menu.classList.remove("open");
        const panel = document.getElementById("siriser-result");
        if (panel && panel._resultControls) panel._resultControls.expand();
        else toastMsg("本页暂无评分结果，请先完成评分");
        return;
      }
      if (act === "map") {
        menu.classList.remove("open");
        showMappingPreview();
        return;
      }
      if (act === "human-toggle") {
        const on = !(await loadHumanMode());
        saveHumanMode(on);
        setHumanSwitchUI(on);
        toastMsg(on ? "已开启拟人点击：完整一题勾选约 5–6 分钟" : "已关闭拟人点击（瞬时点完）");
        log("拟人点击=" + (on ? "开" : "关"));
        return;
      }
      if (act === "auto-toggle") {
        try {
          const st = await loadAutoState();
          const on = !(st && st.on);
          await setAutoMode(on);
          setAutoSwitchUI(on);
          toastMsg(
            on
              ? "已开启自动模式（开关）· 请点「逐张评 / 3张合评」启动"
              : "已关闭自动模式"
          );
        } catch (e) {
          setAutoSwitchUI(false);
          toastMsg("自动模式：" + e.message);
        }
        return;
      }
      if (act === "stats") {
        menu.classList.remove("open");
        await showStatsPanel();
        return;
      }
      if (act === "diag") {
        const d = diagnose();
        diagBody.innerHTML = d.html;
        diag.classList.add("open");
        menu.classList.remove("open");
        return;
      }
      if (act === "copy") {
        menu.classList.remove("open");
        await copyDigest();
        return;
      }
      if (act === "copy-logs") {
        menu.classList.remove("open");
        const cfgHint = !CFG.API_URL && !CFG.OPENAI_API_KEY
          ? "【未配置 API】请在扩展 popup 填 API_URL 或 OPENAI_API_KEY 并保存\n"
          : CFG.API_URL
            ? "API_URL=" + CFG.API_URL + "\n"
            : "OPENAI_MODEL=" + CFG.OPENAI_MODEL + "\n";
        const text =
          location.href +
          "\n" +
          cfgHint +
          "---- LOGS ----\n" +
          dumpLogs() +
          "\n---- RADIO DEBUG ----\n" +
          (typeof dumpRadioDebug === "function" ? dumpRadioDebug() : "");
        try {
          await navigator.clipboard.writeText(text);
          toast("运行日志已复制，可直接粘贴给我");
        } catch {
          const ta = document.createElement("textarea");
          ta.value = text;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          ta.remove();
          toast("运行日志已复制");
        }
        return;
      }
      if (act === "fill-demo") {
        menu.classList.remove("open");
        await selfTestClick();
        return;
      }
      if (act === "submit") {
        const ok = submitAndNext();
        toast(ok ? "已点击提交当前题" : "没找到「提交当前题」");
        return;
      }

      setBusy(true, act === "eval-3" ? "3张合评中…" : act === "eval-1" ? "逐张评分中…" : "评分当前模型…");
      log("开始：" + act);
      try {
        if (!CFG.API_URL && !CFG.OPENAI_API_KEY) {
          throw new Error(
            "未配置 API：点右上角扩展图标 → 填 Base URL + Model + API Key →「保存配置」。注意：刷新插件后可能要重新填一次。"
          );
        }
        if (/thinking/i.test(String(CFG.OPENAI_MODEL || ""))) {
          log("当前模型含 thinking，可能很慢；建议改成 …-instruct", "err");
        }
        const onlyCurrent = act === "eval-one";
        const batchSize = act === "eval-3" ? 3 : 1;

        // 自动模式只作开关；这里才是启动
        const autoSt = await loadAutoState();
        if (autoSt && autoSt.on && !onlyCurrent) {
          setBusy(false, "自动已启动");
          await startAuto(batchSize);
          return;
        }

        await runAutoScore(onlyCurrent, { batchSize });
        setBusy(false, "已勾选，请看结果面板");
        log("完成", "ok");
      } catch (err) {
        setBusy(false, "");
        const msg = String(err.message || err);
        log("失败：" + msg, "err");
        setStatusDock("评分失败", shortErr(msg), "err");
        try {
          await notifyAbnormal("评分失败", msg);
        } catch (_) {}
        const d = diagnose();
        const logTail = dumpLogs().split("\n").slice(-20).join("\n");
        diagBody.innerHTML =
          d.html +
          '<br><span class="err">最近日志</span>\n' +
          escapeHtml(logTail);
        diag.classList.add("open");
        menu.classList.remove("open");
        toast("失败：" + msg);
      }
    });

    diag.addEventListener("click", (e) => {
      if (e.target.closest('[data-act="close-diag"]')) diag.classList.remove("open");
    });

    // 初始化开关状态
    loadAutoState().then((st) => setAutoSwitchUI(!!(st && st.on)));
    loadHumanMode().then((on) => setHumanSwitchUI(on));

    document.addEventListener(
      "pointerdown",
      (e) => {
        if (!root.contains(e.target)) {
          menu.classList.remove("open");
          fab.classList.remove("open");
          diag.classList.remove("open");
        }
      },
      true
    );
    log("悬浮球已挂载 v4-rowseq");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      loadConfigFromStorage().then(mountFab).then(() => {
        loadAutoState().then((st) => {
          // 提交后换题会整页刷新：只要开关开着且在跑，就继续下一题
          if (st && st.on && (st.phase === "running" || st.phase === "countdown")) {
            log("自动进行中，续跑 phase=" + st.phase);
            // 等新任务图/题面稳定一点再开
            setTimeout(() => {
              autoLoop();
            }, 1200);
          }
        });
      });
    });
  } else {
    loadConfigFromStorage()
      .then(mountFab)
      .then(() =>
        loadAutoState().then((st) => {
          if (st && st.on && (st.phase === "running" || st.phase === "countdown")) {
            log("自动进行中，续跑 phase=" + st.phase);
            setTimeout(() => {
              autoLoop();
            }, 1200);
          }
        })
      );
  }
})();
