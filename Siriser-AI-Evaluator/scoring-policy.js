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
  function apply(list) {
    return list.map(s => {
      const out = { ...s, flags: normalize(s.flags), appliedCaps: [] };
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
    return [...confirmed, ...pending, ...(caps.length ? [`规则上限：${[...new Set(caps)].join("、")}`] : [])].join("；");
  }
  const prompt = `逐项核对提示词：要改什么、必须保留什么、禁止什么、目标尺寸。只按可见证据评分，允许同分，不为拉开差距捏造缺陷。
服装编辑检查颜色、材质、领袖扣袋、长短廓形、鞋包配饰、旧元素残留；背景编辑检查替换完整性、透视、主体保持、光向、反射和接触阴影。商品编辑检查产品形状、标识、材质保持；风格转换按目标风格评估，不因插画不是照片而扣分。检查多指、融合、塑料皮肤、纹理涂抹等可见伪影，不凭主观AI感扣分。只检查本题适用要求。
指令允许的光照/反射调整不算保持失败；画布比例变化不等于内容挤压；合理裁切/扩图不自动扣分，但不得违反明确的全身和构图保持。指令冲突或不可见细节标注不确定，不猜测。CSS显示变形不等于原图变形，实际像素未知时不猜尺寸；精确分辨率不能从压缩预览推断。
flags只列有证据的缺陷，最多4条最重要项，无缺陷为[]；每条{code,severity:"minor"或"major",evidence:"位置+要求与实际差异，≤30字"}。minor为轻微偏差，major为明显/核心失败；同一根因不重复列旗标。未见、疑似、不确定的缺陷不要放flags。
可用code：${Object.entries(rules).map(([k,v]) => `${k}=${v[0]}`).join("；")}。
颜色/材质/款式不符主要扣指令遵循；非编辑保持只扣未经允许的改变；质量/一致/真实感必须有独立可见问题才扣。明显非等比挤压需对照参考图中人物和背景几何，不凭画布比例猜测。notes简短写结论，可写未见明显问题。`;
  g.SiriserScoringPolicy = { normalize, merge, apply, describe, prompt };
})(typeof self !== "undefined" ? self : window);
