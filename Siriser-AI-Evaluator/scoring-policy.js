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
    body_proportion_changed: ["身体比例改变", { quality: 5, preservation: 5, realism: 4 }],
    protected_item_changed: ["保留物体或配饰改变", { preservation: 5 }],
    background_changed: ["非编辑背景改变", { preservation: 5 }],
    background_replacement_incomplete: ["背景替换不完整", { alignment: 5, quality: 6 }],
    composition_changed: ["构图改变", { preservation: 6 }],
    lighting_mismatch: ["光照不一致", { consistency: 5, realism: 5 }],
    shadow_or_reflection_mismatch: ["阴影反射不一致", { consistency: 5, realism: 5 }],
    edge_or_contact_artifact: ["边缘或接触伪影", { quality: 5, realism: 5 }],
    texture_or_anatomy_artifact: ["纹理或人体结构伪影", { quality: 5, realism: 5 }],
    non_uniform_distortion: ["非等比挤压", { alignment: 6, quality: 5, preservation: 5, consistency: 5, realism: 4 }],
    outpaint_subject_truncated: ["扩图人物或物体断截", { quality: 5, realism: 5 }],
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
  function normalizeChecks(value) {
    const seen = new Set();
    return (Array.isArray(value) ? value : []).filter(c => c && dims.includes(c.dim) &&
      ["pass", "partial", "fail", "unknown"].includes(c.status) &&
      typeof c.expected === "string" && c.expected.trim() && typeof c.observed === "string" && c.observed.trim())
      .slice(0, 12).map(c => ({ dim: c.dim, expected: c.expected.trim().slice(0, 70), observed: c.observed.trim().slice(0, 70), status: c.status }))
      .filter(c => { const key = JSON.stringify(c); if (seen.has(key)) return false; seen.add(key); return true; });
  }
  // A structured observation is still model testimony, not pixel-level verification.
  function observationEvidence(s) {
    if (s._a && s._b) {
      const a = observationEvidence(s._a), b = observationEvidence(s._b);
      return Object.fromEntries(dims.filter(d => a[d] && b[d]).map(d => [d, a[d]]));
    }
    const checks = normalizeChecks(s.checks), out = {};
    for (const dim of dims) {
      const items = checks.filter(c => c.dim === dim);
      if (!items.length || items.some(c => c.status !== "pass")) continue;
      if (items.some(c => c.observed.length < 6 || /无法|不确定|看不清|符合要求|未见明显问题|无明显问题|完美/.test(c.observed))) continue;
      if (items.some(c => checks.some(other => other.dim !== dim && other.observed === c.observed))) continue;
      out[dim] = items.map(c => `${c.expected}→${c.observed}`).join("；");
    }
    return out;
  }
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
    const evidence = observationEvidence(s);
    return dims.filter(d => s[d] >= 9 && (!evidence[d] || (s[d] === 10 && !s._reviewed)));
  }
  function needsHighReview(s) {
    return !s._reviewed && (highScoreIssues(s).length > 0 || dims.filter(d => s[d] >= 9).length >= 4);
  }
  function reviewPriority(s) {
    const disputed = normalize(s.pendingFlags).some(f => f.severity === "major") ? 10 : 0;
    return disputed + (s._observationConflict ? 5 : 0) + highScoreIssues(s).length * 2 + (needsHighReview(s) ? 3 : 0) + (Number(s._diff) || 0);
  }
  function apply(list) {
    return list.map(s => {
      const out = { ...s, checks: normalizeChecks(s.checks), flags: normalize(s.flags), highEvidence: observationEvidence(s), appliedCaps: [], _scoreWarnings: [] };
      // Each judge's observations are retained; unilateral findings remain disputed.
      for (const dim of dims) {
        const ceiling = list => {
          const rows = normalizeChecks(list).filter(c => c.dim === dim);
          if (rows.some(c => c.status === "fail")) return 6;
          const partial = rows.filter(c => c.status === "partial").length;
          return partial > 1 ? 7 : partial ? 8 : 10;
        };
        const cap = s._a && s._b ? Math.max(ceiling(s._a.checks), ceiling(s._b.checks)) : ceiling(out.checks);
        if (typeof out[dim] === "number" && out[dim] > cap) {
          out[dim] = cap;
          out.appliedCaps.push({ code: "observation_mismatch", dim, cap });
        }
      }
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
    const rows = s._a && s._b ? [...normalizeChecks(s._a.checks).map(c=>({...c,judge:"A"})), ...normalizeChecks(s._b.checks).map(c=>({...c,judge:"B"}))] : normalizeChecks(s.checks);
    const evidence = rows.map(c => `核查${c.judge || ""}·${c.dim}（${({pass:"完成",partial:"部分完成",fail:"未完成",unknown:"看不清"})[c.status]}）：${c.expected}→${c.observed}`);
    return [...confirmed, ...pending, ...evidence, ...(s._scoreWarnings || []), ...(caps.length ? [`规则上限：${[...new Set(caps)].join("、")}`] : [])].join("；");
  }
  const prompt = `逐项核对提示词：要改什么、必须保留什么、禁止什么、目标尺寸。只按可见证据评分，允许同分，不为拉开差距捏造缺陷。
服装编辑检查颜色、材质、领袖扣袋、长短廓形、鞋包配饰、旧元素残留；背景编辑检查替换完整性、透视、主体保持、光向、反射和接触阴影。商品编辑检查产品形状、标识、材质保持；风格转换按目标风格评估，不因插画不是照片而扣分。检查多指、融合、塑料皮肤、纹理涂抹等可见伪影，不凭主观AI感扣分。只检查本题适用要求。
指令允许的光照/反射调整不算保持失败；画布比例变化不等于内容挤压；合理裁切/扩图不自动扣分，但不得违反明确的全身和构图保持。指令冲突或不可见细节标注不确定，不猜测。CSS显示变形不等于原图变形，实际像素未知时不猜尺寸；精确分辨率不能从压缩预览推断。
【形态与扩图必查】不论目标是1:1还是其他比例，对比参考图的人物头身比、躯干宽高与四肢长度：整体拉宽压矮、矮胖化是non_uniform_distortion，明显时realism≤4、quality≤5，不能只扣preservation。若仅人体比例改变也须检查quality与realism；不得把原本体型、姿势透视差异或提示词明确要求的合理变形当缺陷。
扩图检查原画面边界内外：背景人物/物体原先被边框裁掉，扩图后该旧边框已位于新画面内部，仍残留半个人、躯干/肢体突兀断截且无合理遮挡，标outpaint_subject_truncated，明显时quality≤5、realism≤5。新生成区域及接缝属于编辑局部，不能仅扣非编辑保持。正常被最终画面边缘裁切、合理遮挡、原图已有且扩图未加重的问题不扣；无法确认断截位置不猜测。
flags只列有证据的缺陷，最多4条最重要项，无缺陷为[]；每条{code,severity:"minor"或"major",evidence:"位置+要求与实际差异，≤30字"}。minor为轻微偏差，major为明显/核心失败；同一根因不重复列旗标。未见、疑似、不确定的缺陷不要放flags。
可用code：${Object.entries(rules).map(([k,v]) => `${k}=${v[0]}`).join("；")}。
颜色/材质/款式不符主要扣指令遵循；非编辑保持只扣未经允许的改变；质量/一致/真实感必须有独立可见问题才扣。明显非等比挤压需对照参考图中人物和背景几何，不凭画布比例猜测。notes简短写结论，可写未见明显问题。`;
  const rubric = `先列明本题主要编辑要求、必须保持项及禁止项，逐项判断完成/部分完成/未完成/不可确认，再独立定五维分档；整体好看不代表细项全部完成。原图已有且未加重的问题不扣分。
alignment：1–3方向错误/多数核心失败；4–5部分核心实现但重要遗漏；6–7主体改对但多项具体属性不符；8主要要求完成但仍有轻微偏差；9关键及细项均核实、仅极小偏差；10全部明确要求逐项核实无偏差。不得只看服装类别或颜色。
quality：查领袖扣袋、边界、手物接触、纹理与细节结构；preservation：逐一对照脸/头发/配饰/姿势/身体比例/背景构图中明确保留项；consistency：查透视、尺度、光向、阴影、反射、融合；realism：按目标风格查人体结构、材质、纹理与美学自然程度。这四维1–3严重破坏，4–5明显缺陷，6–7多处局部问题或一处中等问题，8轻微问题，9细节核实后近乎无瑕，10充分核实且无可见问题。
9/10需要本维具体观察支持；看不清不是确认正确。flags为空不等于满分，不按字母或固定分布给分。`;
  const observationPrompt = `【输出协议，以本条为准】不要输出highEvidence。每个模型先返回checks数组，再给五维分数、flags和notes。checks每条{dim,expected,observed,status}，dim为五维键名；expected写本题具体要求或该区域应有的结构，observed写实际看见的位置和属性，各≤16字；status只能是pass/partial/fail/unknown。每维至少1条，主要编辑要求可拆2–4条，总计5–8条；不可见用unknown。禁止把提示词直接当观察结果，禁止五维复制同一句。先查主次对象、原图边界与扩图区、形态、材质、接触与光影，再定分，输出的是可核对事实而非思维过程。没有本维pass观察支持不得给9/10；partial按轻微或多处问题评分，fail按明确失败评分，unknown不伪装成缺陷。不凭旧评委分数判断。`;
  g.SiriserScoringPolicy = { normalize, normalizeChecks, observationEvidence, normalizeEvidence, highScoreIssues, needsHighReview, reviewPriority, merge, apply, describe, prompt: prompt + "\n" + rubric + "\n" + observationPrompt };
})(typeof self !== "undefined" ? self : window);
