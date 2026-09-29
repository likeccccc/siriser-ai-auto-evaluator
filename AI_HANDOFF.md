# AI 交接文档 — Siriser 自动评分 Chrome 插件

> **读者**：接手本项目的另一位 AI / Coding Agent  
> **目的**：在最少追问的前提下，继续维护、修 bug、加功能  
> **工作区**：`F:\晓天衡宇\26.09.20 image-benchmark评测标注\`  
> **主交付物**：`Siriser-AI-Evaluator/`（Chrome MV3 扩展）

---

## 1. 业务背景（必读）

用户在 **www.siriser.com** 的 Image Benchmark 标注台上做专家评分：

- **左栏「内容区」**：编辑指令（提示词）+ 参考图 + 模型-A…S 的生成图（徽章标签 `参考图` / `模型-A`）
- **右栏「回答区」**：每个模型一组 5 个维度的 **Ant Design v5 radio**（`label.ant-v5-radio-wrapper`，分值 1–10 +「无」）
- 提交按钮文案：**「提交当前题」**
- 一题常见 **18 个模型**（A–H, J–S；**没有 I**）
- 前端 Ant Design v5，类名如 `css-yedj3a`（不稳定），图在阿里云 OSS（跨域、签名 URL）

### 五维（键名固定，对接 API/日志）

| key | 中文 | 英文 |
|-----|------|------|
| alignment | 编辑指令遵循 | Edit Instruction Alignment |
| quality | 编辑局部质量 | Edit Region Quality |
| preservation | 非编辑区域保持 | Content Preservation |
| consistency | 全局一致性 | Global Consistency |
| realism | 视觉真实感与美学 | Realism & Aesthetic |

分数 **1–10 整数**；无图模型五维均为「无」/ `null`，`notes="no_image"`。  
细则全文见根目录 `Edit Bench 专家评分细则.md`（关键失败上限、RCR、语义覆盖规则）。

### 产品目标

浏览器扩展自动完成：读题/读图 → 调视觉 API 打分 → 勾选网页 radio → （可选）提交。  
用户要 **快、能核对、不要瞎勾「无」**。

---

## 2. 目录结构

```text
F:\晓天衡宇\26.09.20 image-benchmark评测标注\
├── Siriser-AI-Evaluator/          # ★ 主交付：Chrome 扩展（Load unpacked 选这个文件夹）
│   ├── manifest.json              # MV3；background 是经典脚本（无 type:module）
│   ├── background.js              # 跨域 fetch 图 + OffscreenCanvas 压缩成 JPEG data URL
│   ├── content.js                 # 采集/勾选/悬浮球/诊断/结果面板（最大文件）
│   ├── content.css                # 悬浮球、菜单、对照预览、灯箱、结果窗
│   ├── api.js                     # OpenAI 兼容调用、压缩、重试、精简 system prompt
│   ├── config.js                  # API 默认值、选择器、HEURISTIC 关键词
│   ├── scoring-prompt.js          # Edit Bench 系统提示词（完整/严打规则）
│   ├── popup.html/css/js          # 扩展弹窗：API 配置、逐张/3张、诊断
│   └── README.md
├── README.md                      # 安装与使用说明
├── Siriser_AI_Auto_Evaluator_PRD.md
├── Edit Bench 专家评分细则.md
├── DESIGN_NOTES.md                # 演示页视觉方向（Convention）
├── index.html + css/ js/          # 本地演示标注台（非生产；练习/联调用）
├── mock-api/server.py             # 本地 mock 评分服务（127.0.0.1:8787）
├── assets/                        # 演示用样例图
└── AI_HANDOFF.md                  # 本文件
```

---

## 3. 架构要点

### 数据流

```text
content.js collectTask/collectVisuals
  → prompt + ref 图 + 模型 A…S 图（img 元素引用）
  → api.js evaluate()
       → toImagePayload()  // background 压缩，长边 768（逐张）/ 576（3合评）
       → callOpenAIBatch() // OpenAI 兼容 chat/completions，BATCH_SIZE 1 或 3
       → normalizeScores() // id 归一 + 1–10 整数（已去掉校准/同分改写）
  → applyScores()           // 按模型×维点 radio
  → showResultPanel()       // 分数 + 缩略图 + 运行时间
```

### 页面识别（关键）

- **左右分栏**：`内容区` 图 vs `回答区` 分，靠 **「模型-X」** 字母对齐  
- **模型标签**文本：`*模型-A` / `模型-A` → id `A`  
- **Ant Design radio**：原生 `input` 常 `opacity:0`，**必须点** `label.ant-v5-radio-wrapper`  
- 每维一行：`1…10` + `无`；`input.value` 常为 `1…10`（有效）  
- **radio 行**按 name 或父级聚类；18 模型 × 5 维 = **90 行**（诊断里 `radio rows: 90` 为健康值）

### 悬浮球（content.js `mountFab`）

- 可拖动；点击展开菜单  
- 按钮：逐张评全部 / 3张合评全部 / 只评当前 / 自检勾选(全点1) / 提交当前题 / 对照预览 / 诊断识别 / 复制结构摘要 / 复制运行日志  
- 日志环缓 300 条，一键复制（含 RADIO DEBUG）

### API 协议（OpenAI 兼容）

- Base URL 示例（百炼）：`https://dashscope.aliyuncs.com/compatible-mode/v1`  
- `POST /chat/completions`，多模态 `image_url` + **JPEG base64**  
- system 使用 **精简规则**（`SHORT_SYSTEM`，api.js），不是完整细则（完整版在 `scoring-prompt.js`）  
- Qwen3：带 `enable_thinking: false` / `thinking: {type:"disabled"}` / `extra_body`  
- 单批超时默认 **300s**；429 等 5s 重试；**403 立即失败不重试**

---

## 4. 已验证可用 / 不可用的模型

用户在百炼（DashScope）+ 本插件上实测：

| 模型 | 结果 | 备注 |
|------|------|------|
| `qwen3-vl-30b-a3b-instruct` | ✅ 快（~1s/次） | 曾批量出分 |
| `qwen3-vl-32b-instruct` | ✅ 推荐 | 非 thinking |
| `qwen3.7-plus` | ✅ 用户称「还不错」 | 以用户账号为准 |
| `qwen-vl-max` | ✅ 文档推荐 | 未在本会话日志里完整跑通确认 |
| `deepseek-v4-pro` | ⚠️ 能出分但慢 | 单次 3–26s；部分模型空分要重评 |
| `qwen3-vl-*-thinking` | ⚠️ 极慢/像卡死 | 已强制关思考；**仍建议别用** |
| `qwen2.5-vl-72b-instruct` | ❌ 403 Access denied | 该 Key 无权限 |
| `qwen3.7-max` | ❌ 用户报「API 无分」 | 可能非 VL / 无权限 / 解析失败 |
| `qwen-image-2.0-pro` | ❌ 不要用来评分 | **生成图**模型 |
| `wan2.6-i2v-flash` | ❌ | **生成视频**模型 |

**选型口诀**：名字里要有 **vl / vision / multimodal**；避开 **image / i2v / t2i / thinking**。

---

## 5. 踩过的坑（改代码前必读）

1. **Ant Design radio 点不动**  
   点隐藏 `input` 无效；必须 `fireClick` 到 `label.ant-v5-radio-wrapper`。

2. **五维全点到第一行**  
   找选项时范围过大，五个维度抢同一行 radio。必须 **按「本维标题 → 下一维」区间** 或 **radio 行聚类**。

3. **跨域图 canvas 污染**  
   `toDataURL` 报 `Tainted canvases…`。只能 **background 里 fetch + OffscreenCanvas 压缩**。  
   页面内 `fetch` OSS 会 `Failed to fetch`（CORS），属预期。

4. **`background.js` 与 `type: module`**  
   曾设 `"type": "module"` 但脚本非 ES module → SW 起不来 → 全图 `bg 无响应`。  
   **现状**：manifest **不要** `type: module`，background 为经典脚本。有 `SIRISER_BG_PING`。

5. **Multimodal file size is too large**  
   2048 原图 base64 会 400。必须压缩（逐张 768 / 3合评 576，JPEG q≈0.7）。

6. **「本地有图却 API 无分」→ 禁止勾「无」**  
   只 skip 并标 `api_returned_null`，避免整页误勾「无」。

7. **评分校准会毁掉区分度**  
   统一平移/同分模板会把所有模型打成 `7/6/7/6/6`。  
   **现状**：**已去掉** applyScorePolicy / calibrateBatch 改写，只保留 id 归一 + 1–10 clamp。若用户再嫌「太松/太挤」，优先改 **提示词或换模型**，不要轻易加全局校准。

8. **thinking 模型**  
   会拖十几分钟然后 `signal is aborted`。  
   已 `enable_thinking: false`；用户侧应使用 **instruct**。

9. **配置易丢**  
   重载扩展/刷新后 content 可能读不到 Key。  
   **现状**：启动与 `runAutoScore` 前会 `loadConfigFromStorage()`（chrome.storage.sync）。  
   改代码后请用户 **移除再 Load unpacked**，不要只点刷新。

10. **日志是唯一远程调试手段**  
    用户会贴「复制运行日志」。关键行：`bg ping=`、`img X ok xxxKB`、`进度 i/n`、`请求/响应`、`403`、`本批失败`、`完成 · 用时`。

---

## 6. 用户工作流（产品行为约定）

1. 打开标注页 → 悬浮球  
2. **对照预览**（图↔模型徽章核对，可拖、点图放大）  
3. **逐张评** 或 **3张合评**（3合评更快；分数偶更「抄」）  
4. 结果面板核对（含缩略图、运行时间、`[同分校正]` 等备注）  
5. **提交当前题**  
6. 不对就手点 radio 覆盖；或换模型重跑  

**默认不自动提交**（`AUTO_SUBMIT: false`），避免误交。

---

## 7. 已知问题 / 待办

| 优先级 | 项 | 说明 |
|--------|----|------|
| 高 | 分数仍可能偏松、模型间差不够 | 用更强 VL 或加强 `SHORT_SYSTEM`；勿用全局校准 |
| 高 | `qwen3.7-max` 无分 | 需日志：403 / 解析 0 条 / 非 VL |
| 中 | 部分模型（如 G/N）反复 `api_returned_null` | 重试 3 次仍失败；可查图是否异常 |
| 中 | 完整细则 vs 精简提示词 | 严打用 `scoring-prompt.js` 全文会更准但更慢；现用 SHORT_SYSTEM |
| 低 | `popup` 与悬浮球功能对齐 | 基本已对齐 |
| 低 | 批量连做多题 | 需人工点下一题；未做全自动队列 |
| 低 | 评分日志导出 CSV | 未做 |
| — | 演示台 `index.html` | 用户明确「没让你做这个」；可忽略或删，勿当主需求 |

---

## 8. 排障速查

| 现象 | 先查日志关键字 | 处理 |
|------|----------------|------|
| 未配置 API | `未配置 API` / `已加载存储配置 api=` | popup 填 Key 保存；重载扩展 |
| 全「无」 | `API 返回 … null` / `file size` | 是否压缩失败、是否真无图 |
| 勾不上 / 只勾第一维 | `radio rows` / `五维指向同一控件` | 修 findScoreOptionsNear / radio 行 |
| 超时 `signal is aborted` | `请求 … 超时=` / 是否 thinking | 换 instruct；调大 TIMEOUT_MS |
| 400 file too large | `img X ok xxxKB` | 检查是否仍送原图；调小 maxEdge |
| 403 Access denied | `无权限(403)` | 换已开通的 VL 模型名 |
| 429 | `触发限速` | 降速、换 Key、用 3合评减少次数 |
| bg 无响应 | `bg ping=` | 重载扩展；manifest 勿设 type:module |
| 预览对不上图 | 对照预览缩略图 | 改 imgNear / isRealGenImg |

### 诊断 API

content 消息：`SIRISER_PING` / `SIRISER_COLLECT` / `SIRISER_EVAL`（`onlyCurrent`,`batchSize`）/ `SIRISER_SUBMIT` / `SIRISER_DIAGNOSE` / `SIRISER_GET_LOGS`  
background：`SIRISER_BG_PING` / `SIRISER_FETCH_IMAGE`（`url`,`max`,`quality`）

---

## 9. 改代码时的约束

- 改 `Siriser-AI-Evaluator/**` 后：让用户 **移除扩展再 Load unpacked**  
- 不要再引入「分数校准/同分强制模板」除非用户明确要求  
- 图片送 API **必须** base64 压缩，禁止把 2048 原图 URL 当成功路径  
- 403 **不要** 重试 3 次 ×18 模型  
- 保持：`完成 · 用时`、结果窗运行时间、radio 勾选可见（`siriser-picked`）  
- 真实站选择器不稳时优先 **radio 行 + 模型文案**，少依赖 `css-xxxxxx`  

### 真实站 URL 形态

```text
https://www.siriser.com/siriser/labeling/task?domainId=1007&id=…&missionType=label&subtaskId=…
```

改选择器请用用户粘贴的 **「复制运行日志」/「复制结构摘要」**，不要盲猜 class。

---

## 10. 用户偏好（协作方式）

- 语言：**中文**；要短、直接、可操作  
- 喜欢用 **「复制运行日志」** 排障；请要日志时指明要看哪几行  
- 嫌「校准把分打成一样」；评分以 **模型原分** 为准  
- 要 **3张/逐张** 两个按钮；结果窗要 **运行时间**  
- 不要过度发挥（演示标注台就曾被吐槽「我没让你做」）  

---

## 11. 建议的下一步（按优先级）

1. 用 `qwen3.7-plus` 或 `qwen3-vl-32b-instruct` + **3张合评** 固化日常流程  
2. 拿 `qwen3.7-max` 的 `请求/响应/本批失败` 日志定位无分原因  
3. 若仍「分数长一样」：加强 `SHORT_SYSTEM`（禁止抄分、notes 写特有缺陷），或改回完整细则并接受略慢  
4. 可选：CSV 导出评分日志、多题连跑  

---

## 12. 快速验证清单

- [ ] Load unpacked 后悬浮球出现，日志有 `已加载存储配置` / `bg ping=alive`  
- [ ] 对照预览 18 张有图且与徽章一致  
- [ ] 自检勾选 → 每维「1」亮起（90 次）  
- [ ] 3合评 → 日志 `进度 1/6`…`响应 … → 3 条` → radio 被勾  
- [ ] 结果窗显示分数、缩略图、**运行时间**  
- [ ] 提交当前题可点  

—— 交接结束 ——
