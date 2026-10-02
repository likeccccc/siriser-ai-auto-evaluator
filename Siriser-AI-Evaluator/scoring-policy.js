(function (g) {
  "use strict";
  // Caps are ceilings, not additive penalties. Only explicit, evidenced flags apply.
  const rules = {
    required_item_missing: ["要求遗漏", { alignment: 5 }],
    old_element_remaining: ["旧元素残留", { alignment: 6 }],
    forbidden_item_added: ["添加禁止元素", { alignment: 5 }],
    wrong_color: ["颜色不符", { alignment: 7 }],
    wrong_material: ["材质不符", { alignment: 7 }],
    wrong_garment_structure: ["服装结构不符", { alignment: 6 }],
    identity_changed: ["身份改变", { preservation: 4 }],
    face_or_hair_changed: ["脸部或发型改变", { preservation: 6 }],
    pose_or_hand_changed: ["姿势或手势改变", { preservation: 5 }],
    body_proportion_changed: ["身体比例改变", { preservation: 5, realism: 5 }],
    protected_item_changed: ["保留物体或配饰改变", { preservation: 5 }],
    background_changed: ["非编辑背景改变", { preservation: 5 }],
    background_replacement_incomplete: ["背景替换不完整", { alignment: 5, quality: 6 }],
    composition_changed: ["构图改变", { preservation: 6 }],
    lighting_mismatch: ["光照不一致", { consistency: 5, realism: 5 }],
    shadow_or_reflection_mismatch: ["阴影反射不一致", { consistency: 5, realism: 5 }],
    edge_or_contact_artifact: ["边缘或接触伪影", { quality: 5, realism: 5 }],
    texture_or_anatomy_artifact: ["纹理或人体结构伪影", { quality: 5, realism: 5 }],
    non_uniform_distortion: ["非等比挤压", { alignment: 6, quality: 5, preservation: 5, consistency: 5, realism: 4 }],
  };
  function normalize(flags) {
    const seen = new Set();
    return (Array.isArray(flags) ? flags : []).filter(f => {
      if (!f || !Object.hasOwn(rules, f.code) || !["minor", "major"].includes(f.severity) ||
          typeof f.evidence !== "string" || !f.evidence.trim() || seen.has(f.code)) return false;
      seen.add(f.code);
      return true;
    }).map(f => ({ code: f.code, severity: f.severity, evidence: f.evidence.trim().slice(0, 100) }));
  }
  function merge(a, b) {
    a = normalize(a); b = normalize(b);
    const flags = [], pendingFlags = [];
    for (const code of new Set([...a, ...b].map(f => f.code))) {
      const x = a.find(f => f.code === code), y = b.find(f => f.code === code);
      if (x && y) {
        flags.push({ ...x, severity: x.severity === y.severity ? x.severity : "minor" });
        if (x.severity !== y.severity) pendingFlags.push({ ...x, evidence: `严重程度有争议：${x.evidence}；${y.evidence}` });
      } else pendingFlags.push(x || y);
    }
    return { flags, pendingFlags };
  }
  const dims = ["alignment", "quality", "preservation", "consistency", "realism"];
  function normalizeEvidence(value) {
    const out = {};
    for (const dim of dims) {
      const text = value && value[dim];
      if (typeof text !== "string") continue;
      const s = text.trim().slice(0, 100);
      if (s.length < 8 || /无法|不确定|看不清|疑似|未核实/.test(s) || /^(?:无|良好|完美|符合要求|未见明显问题|无明显问题)[。！!\s]*$/.test(s)) continue;
      out[dim] = s;
    }
    return out;
  }
  function highScoreIssues(s) {
    const evidence = normalizeEvidence(s.highEvidence);
    return dims.filter(d => s[d] >= 9 && (!evidence[d] || (s[d] === 10 && !s._reviewed)));
  }
  function needsHighReview(s) {
    return !s._reviewed && (highScoreIssues(s).length > 0 || dims.filter(d => s[d] >= 9).length >= 4);
  }
  function reviewPriority(s) {
    const disputed = normalize(s.pendingFlags).some(f => f.severity === "major") ? 10 : 0;
    return disputed + highScoreIssues(s).length * 2 + (needsHighReview(s) ? 3 : 0) + (Number(s._diff) || 0);
  }
  function apply(list) {
    return list.map(s => {
      const out = { ...s, flags: normalize(s.flags), highEvidence: normalizeEvidence(s.highEvidence), appliedCaps: [], _scoreWarnings: [] };
      for (const dim of dims) {
        if (out[dim] < 9 || typeof out[dim] !== "number") continue;
        let cap = 10, reason = "";
        if (!out.highEvidence[dim]) { cap = 8; reason = "高分缺少逐维核查依据（暂定）"; }
        else if (out[dim] === 10 && !s._reviewed) { cap = 9; reason = "满分尚未独立复核"; }
        if (normalize(s.pendingFlags).some(f => Object.hasOwn(rules[f.code][1], dim))) {
          cap = 8; reason = "相关缺陷仍有争议（暂定）";
        }
        if (out[dim] > cap) {
          out[dim] = cap;
          out.appliedCaps.push({ code: "high_score_gate", dim, cap });
          out._scoreWarnings.push(`${dim}：${reason}`);
        }
      }
      for (const f of out.flags) {
        for (const [dim, majorCap] of Object.entries(rules[f.code][1])) {
          const cap = f.severity === "major" ? majorCap : 8;
          if (typeof out[dim] === "number" && out[dim] > cap) {
            out[dim] = cap;
            out.appliedCaps.push({ code: f.code, dim, cap });
          }
        }
      }
      return out;
    });
  }
  function describe(s) {
    const confirmed = normalize(s.flags).map(f => `${rules[f.code][0]}（${f.severity === "major" ? "明显" : "轻微"}）：${f.evidence}`);
    const pending = normalize(s.pendingFlags).map(f => `待复核·${rules[f.code][0]}：${f.evidence}`);
    const caps = (s.appliedCaps || []).map(c => `${c.dim}≤${c.cap}`);
    const evidence = Object.entries(normalizeEvidence(s.highEvidence)).filter(([d]) => s[d] >= 9).map(([d,v]) => `高分核查·${d}：${v}`);
    return [...confirmed, ...pending, ...evidence, ...(s._scoreWarnings || []), ...(caps.length ? [`规则上限：${[...new Set(caps)].join("、")}`] : [])].join("；");
  }
  const prompt = `逐项核对提示词：要改什么、必须保留什么、禁止什么、目标尺寸。只按可见证据评分，允许同分，不为拉开差距捏造缺陷。
服装编辑检查颜色、材质、领袖扣袋、长短廓形、鞋包配饰、旧元素残留；背景编辑检查替换完整性、透视、主体保持、光向、反射和接触阴影。商品编辑检查产品形状、标识、材质保持；风格转换按目标风格评估，不因插画不是照片而扣分。检查多指、融合、塑料皮肤、纹理涂抹等可见伪影，不凭主观AI感扣分。只检查本题适用要求。
指令允许的光照/反射调整不算保持失败；画布比例变化不等于内容挤压；合理裁切/扩图不自动扣分，但不得违反明确的全身和构图保持。指令冲突或不可见细节标注不确定，不猜测。CSS显示变形不等于原图变形，实际像素未知时不猜尺寸；精确分辨率不能从压缩预览推断。
flags只列有证据的缺陷，最多4条最重要项，无缺陷为[]；每条{code,severity:"minor"或"major",evidence:"位置+要求与实际差异，≤30字"}。minor为轻微偏差，major为明显/核心失败；同一根因不重复列旗标。未见、疑似、不确定的缺陷不要放flags。
可用code：${Object.entries(rules).map(([k,v]) => `${k}=${v[0]}`).join("；")}。
颜色/材质/款式不符主要扣指令遵循；非编辑保持只扣未经允许的改变；质量/一致/真实感必须有独立可见问题才扣。明显非等比挤压需对照参考图中人物和背景几何，不凭画布比例猜测。notes简短写结论，可写未见明显问题。`;
  const rubric = `先列明本题主要编辑要求、必须保持项及禁止项，逐项判断完成/部分完成/未完成/不可确认，再独立定五维分档；整体好看不代表细项全部完成。原图已有且未加重的问题不扣分。
alignment：1–3方向错误/多数核心失败；4–5部分核心实现但重要遗漏；6–7主体改对但多项具体属性不符；8主要要求完成但仍有轻微偏差；9关键及细项均核实、仅极小偏差；10全部明确要求逐项核实无偏差。不得只看服装类别或颜色。
quality：查领袖扣袋、边界、手物接触、纹理与细节结构；preservation：逐一对照脸/头发/配饰/姿势/身体比例/背景构图中明确保留项；consistency：查透视、尺度、光向、阴影、反射、融合；realism：按目标风格查人体结构、材质、纹理与美学自然程度。这四维1–3严重破坏，4–5明显缺陷，6–7多处局部问题或一处中等问题，8轻微问题，9细节核实后近乎无瑕，10充分核实且无可见问题。
9/10必须为该维返回highEvidence对象条目（键为维度名，值为≤25字的具体核对结果，写位置和对应属性；不是复述“符合/很好/无问题”）。看不清≠确认正确：不能给9/10，不捏造缺陷；缺乏足够依据暂不进入高分档。未到9的维度无需highEvidence。flags为空不等于满分。不要按模型字母、历史排名、固定分布给分；有证据的优秀结果仍可高分。`;
  g.SiriserScoringPolicy = { normalize, normalizeEvidence, highScoreIssues, needsHighReview, reviewPriority, merge, apply, describe, prompt: prompt + "\n" + rubric };
})(typeof self !== "undefined" ? self : window);
