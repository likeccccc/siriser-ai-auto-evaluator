# Siriser Edit Bench · 图像编辑评测标注 + AI 自动评分

当前人工流程：看 Prompt → 对比参考图与生成图 → 按 5 个维度 1–10 打分 → 网页填分 → 下一题。  
本项目用 **Chrome 插件**把中间的「读题 → 调视觉 API → 回填 → 提交」自动化，演示页用于熟悉五维评分与联调。

## 目录

| 路径 | 说明 |
|------|------|
| `index.html` | 演示标注台（指令 / 参考图 / 模型网格 / 五维刻度尺评分） |
| `js/scoring-prompt.js` | Edit Bench 专家细则压缩后的系统提示词 + 请求体构造 |
| `js/app.js` · `css/styles.css` | 演示台逻辑与样式 |
| `assets/` | 样例参考图与生成图 |
| `Siriser-AI-Evaluator/` | Chrome Manifest V3 插件源码 |
| `mock-api/server.py` | 可选：本地评分 mock 服务 |

## 五个评分维度

1. **alignment** — Edit Instruction Alignment 指令遵循（可配 RCR 完成率）
2. **quality** — Edit Region Quality 编辑局部质量
3. **preservation** — Content Preservation 非编辑区保持
4. **consistency** — Global Consistency 全局一致性
5. **realism** — Realism & Aesthetic 视觉真实感与美学

范围均为 **1–10 整数**；无图模型五维统一「无 / null」。细则见 `Edit Bench 专家评分细则.md`。

## 快速开始

### 1. 打开演示标注台

直接用浏览器打开 `index.html`（或经本地静态服务）。可：

- 点选模型卡片 / 按键 `1–6`
- 在右侧刻度尺上给分（悬停可看档位锚点）
- 点「AI 评全部模型」——默认走 **本地 Mock**；若在 `localStorage` 设置了 `SIRISER_API_URL` 则真调接口
- 快捷键：`A` 评当前，`S` 提交

### 2. 安装 Chrome 插件

1. 打开 `chrome://extensions`
2. 打开「开发者模式」
3. 「加载已解压的扩展程序」→ 选择 `Siriser-AI-Evaluator/`
4. 点工具栏图标，配置 API 后「保存配置」

### 3. 配置评分 API

两种方式任选：

**A. 自定义 HTTP API（推荐）**

`API_URL` 填你的服务地址。插件 `POST` JSON：

```json
{
  "system": "…Edit Bench 系统提示词…",
  "constraints": "本轮整数分…",
  "prompt": "把女孩的红裙子改成淡粉色…",
  "referenceImages": ["data:image/jpeg;base64,…"],
  "models": [
    { "id": "A", "name": "A", "images": ["data:image/jpeg;base64,…"] },
    { "id": "D", "name": "D", "images": [] }
  ]
}
```

期望返回：

```json
{
  "scores": [
    {
      "model": "A",
      "alignment": 9,
      "quality": 8,
      "preservation": 9,
      "consistency": 8,
      "realism": 8,
      "rcr": 0.92,
      "notes": "淡粉略偏玫粉",
      "defects": []
    },
    {
      "model": "D",
      "alignment": null,
      "quality": null,
      "preservation": null,
      "consistency": null,
      "realism": null,
      "notes": "no_image"
    }
  ]
}
```

**B. OpenAI 兼容视觉接口**

填 `Base URL` + `Model` + `API Key`（如 `gpt-4o-mini` / 多模态模型）。插件会走 `/chat/completions`，系统提示词来自 `scoring-prompt.js`。

评分模式：

- **快速模式**：评委和审核均关闭思考，最快、最省 Token。
- **平衡模式（推荐）**：评委 A/B 关闭思考，只让分歧最大的审核请求有限思考；建议审核模型填 `qwen3.7-plus`。
- **思考模式**：评委与审核均开启有限思考，准确性优先，但时间和 Token 消耗最高。

三个模式都有输出上限和审核总时限；纯 `*-thinking` 模型仍会被阻止，避免失控消耗。

本地 mock 示例：

```powershell
$env:MIMO_PYTHON; & $env:MIMO_PYTHON mock-api/server.py
# 然后把 API_URL 设为 http://127.0.0.1:8787/evaluate
```

## 插件自动流程

1. 读取当前页 Prompt、参考图、模型 A–F 生成图（canvas 转 base64）
2. 调用配置的评分 API
3. 按返回 JSON 点击五维刻度（无图点「无」）
4. 可选：自动提交 → 自动下一题

页面右下角有 **「AI 评分」** 浮标，也可从 popup 操作。

### DOM 约定（真实站点请改 `config.js`）

演示页与默认选择器使用：

- 指令：`[data-testid="prompt"]`
- 参考图：`[data-testid="reference-image"] img`
- 模型卡：`[data-testid="model-card-A"]` 或 `[data-model="A"]`
- 评分钮：`[data-dim="alignment"] button[data-score="8"]`，无图 `[data-dim="alignment"] button.na`

真实 Siriser 若结构不同，只改 `Siriser-AI-Evaluator/config.js` 的 `SELECTORS` 即可，无需改业务代码。

## 测试说明

1. 打开 `index.html`，点「AI 评全部模型」，确认五个刻度被填、无图模型为「无」、日志有输出。
2. Load unpacked 插件 → 在演示页点浮标或 popup「AI 评全部模型」，应能读题、填分、（可选）提交。
3. 把 `API_URL` 指向 `mock-api/server.py`，验证真实 HTTP 链路。
4. 换真实标注站：先 popup「仅读取任务」，看预览里 models/prompt 是否正确；不对就改 `config.js` 选择器。

## 开发要求对照（PRD）

- [x] 完整插件源码，可 Load unpacked
- [x] README / API 配置 / 测试说明
- [x] 五维 1–10 自动填分
- [x] 自动流程：读取 → 评分 → 填写 → 提交 → 下一题
- [ ] 第二阶段：更稳的 React/Vue 点击、批量队列、评分日志导出（见 PRD §9）
