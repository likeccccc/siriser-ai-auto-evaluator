# DESIGN — Siriser Edit Bench 标注台

## Mode
Convention（内部标注/工具台）。熟悉度优先，不做营销式视觉。

## Anchor
实验室仪器面板 + 专家评分表：细线分区、等宽数据、刻度尺量表。类似 Label Studio / 测量台，而不是 SaaS 落地页。

## Tokens
| token | value | use |
|-------|-------|-----|
| --ink | #1c2329 | 正文 |
| --paper | #f0f3f5 | 页面底 |
| --panel | #ffffff | 卡片 |
| --rule | #d5dde3 | 分割线 |
| --accent | #0f766e | 主操作/得分（青瓷） |
| --warn | #c2410c | 缺陷/失败 |
| --muted | #6b7a85 | 次要文字 |
| --mono | Cascadia Code / Consolas | 分数、维度码、日志 |
| --ui | system-ui / Segoe UI / PingFang SC | 界面 |

## Type
- UI 14px system 栈
- 分数仪表 22px mono bold
- 日志 11px mono 深色底

## Layout
三栏：`左 Prompt+参考图 | 中 生成图网格 | 右 五维评分 + AI 面板`  
顶栏 52px 仪表条；底栏上一题/下一题。

## Signature
右侧五维 **刻度尺 1–10**（非圆角滑条卡片）：点格打分，悬停显示细则锚点；AI 回填后分数变色（低分 warn / 中分 amber）。

## Risk
量表用刻数格而非 slider；无圆角卡片堆叠营销感。只保留 8px 圆角工具卡。
