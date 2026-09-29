/**
 * www.siriser.com 标注台配置
 * 布局：左「内容区」提示词+参考图+模型图；右「回答区」模型-X 五维单选
 */
window.SIRISER_CONFIG = {
  API_URL: "",
  API_KEY: "",
  OPENAI_BASE_URL: "https://api.openai.com/v1",
  OPENAI_MODEL: "gpt-4o-mini",
  OPENAI_API_KEY: "",
  /** 双模型：填第二模型则开启「两套分取中」；分差≥DUAL_DIFF_THRESHOLD 再审 */
  OPENAI_MODEL_2: "",
  OPENAI_MODEL_REVIEW: "",
  DUAL_DIFF_THRESHOLD: 2,
  /** 每批评分的模型数：1 更稳（避免串图），2 更快 */
  BATCH_SIZE: 1,
  AUTO_SUBMIT: false,
  AUTO_NEXT: false,
  /** 单次 API 超时（ms）。通义偶发很慢，给到 5 分钟 */
  TIMEOUT_MS: 300000,

  SELECTORS: {
    prompt:
      '[data-testid="prompt"], #promptText, [class*="prompt" i], [class*="instruction" i]',
    referenceImage: '[data-testid="reference-image"] img',
    modelCard: '[data-model], [data-testid^="model-card-"]',
    scoreButton: () => "",
    scoreNa: "",
    submit: "",
    next: "",
  },

  HEURISTIC: {
    /** 左右分栏标题 */
    contentAreaText: /^(内容区|图片区|素材区|预览区)$/,
    answerAreaText: /^(回答区|答题区|评分区|打分区)$/,
    refLabel: /^(参考图|原图|参考|Reference|Source)$/i,
    modelLabel: /^(?:\*?\s*)?(?:模型|model|Model)\s*[-–—_：: ]*\s*([A-Za-z0-9]{1,4})\s*$/i,
    modelPattern: /(?:模型|model)\s*[-–—_：: ]*\s*([A-Za-z0-9]{1,4})\b/i,
    promptLabel: /^(提示词|编辑指令|指令|Prompt)$/i,
    dimAliases: {
      alignment: ["编辑指令遵循", "指令遵循", "Edit Instruction Alignment", "Instruction Alignment"],
      quality: ["编辑局部质量", "局部质量", "Edit Region Quality", "Region Quality"],
      preservation: [
        "非编辑区域保持",
        "非编辑区保持",
        "内容保持",
        "Content Preservation",
        "Preservation",
      ],
      consistency: ["全局一致性", "Global Consistency", "Consistency"],
      realism: [
        "视觉真实感与美学",
        "真实感与美学",
        "真实美学",
        "Realism & Aesthetic",
        "Realism and Aesthetic",
        "Realism",
      ],
    },
    /** 勾选「提交后自动领取下一题」后，按钮会变成「提交并下一题」 */
    submitText: /^(提交并下一题|提交当前题|提交当前|确认提交|提交|Submit)$/i,
    nextText: /^(下一题|下一|下一个|Next|Next Task)$/i,
  },
};
