# Siriser AI Auto Evaluator

Chrome Manifest V3 插件：自动读取 Image Benchmark 任务 → 调用自定义视觉 API → 回填五维 1–10 分 → 可选提交并下一题。

## 安装

1. `chrome://extensions` → 开发者模式 → 加载已解压 → 选本目录
2. 点扩展图标，填 API 后「保存配置」

## 文件

- `manifest.json` — MV3
- `popup.html/js/css` — 控制面板与配置
- `content.js/css` — 页面采集与自动填分（含浮标）
- `api.js` — 自定义 API / OpenAI 兼容调用
- `scoring-prompt.js` — Edit Bench 系统提示词
- `config.js` — API 与 DOM 选择器
- `background.js` — 安装初始化、日志

## API 契约

`POST API_URL`，鉴权 `Authorization: Bearer <API_KEY>`：

请求见根目录 `README.md`。响应：

```json
{ "scores": [ { "model": "A", "alignment": 9, "quality": 8, "preservation": 9, "consistency": 8, "realism": 8, "notes": "…" } ] }
```

分数 1–10 整数；无图用 `null` + `notes: "no_image"`。

若配置 OpenAI 兼容接口，走 `POST {base}/chat/completions`，模型需支持图片输入。

## 真实站点适配

只改 `config.js` 里的 `SELECTORS` / `HEURISTIC`。默认匹配演示页 `data-testid` 与常见 class。
