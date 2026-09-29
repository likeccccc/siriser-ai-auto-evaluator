# Siriser AI Auto Evaluator 插件需求文档

## 1. 项目目标

开发一个 Chrome Manifest V3 插件，用于自动完成 Siriser Image Benchmark
图片评测任务。

当前流程： - 查看 Prompt - 对比参考图和生成图 - 按 5 个维度评分 -
手动填写网页评分

目标： - 自动读取任务信息 - 调用用户自定义 AI API - 获取评分 JSON -
自动填写网页评分 - 自动进入下一题

------------------------------------------------------------------------

## 2. 评分维度

插件需要支持：

1.  Edit Instruction Alignment
2.  Edit Region Quality
3.  Content Preservation
4.  Global Consistency
5.  Realism & Aesthetic

每项评分范围：1-10。

------------------------------------------------------------------------

## 3. 数据读取

需要读取：

-   Prompt
-   Reference Image
-   Model A/B/C/D/E/F 生成图片

发送给用户自定义 API：

``` json
{
  "prompt": "",
  "referenceImages": [],
  "models": []
}
```

------------------------------------------------------------------------

## 4. API 接口

API 地址由用户配置。

config.js:

``` javascript
const CONFIG = {
  API_URL: "YOUR_API_ENDPOINT",
  API_KEY: ""
}
```

API 返回：

``` json
{
  "scores":[
    {
      "model":"A",
      "alignment":9,
      "quality":9,
      "preservation":9,
      "consistency":9,
      "realism":9
    }
  ]
}
```

------------------------------------------------------------------------

## 5. 自动评分

插件根据 API 返回结果：

自动点击网页评分按钮：

-   Alignment
-   Quality
-   Preservation
-   Consistency
-   Realism

------------------------------------------------------------------------

## 6. 自动流程

点击：

开始自动评分

执行：

1.  获取当前页面数据
2.  调用 AI API
3.  接收评分
4.  自动填写
5.  提交
6.  下一题

------------------------------------------------------------------------

## 7. 技术方案

Chrome Extension:

    Siriser-AI-Evaluator

    manifest.json
    popup.html
    popup.js
    content.js
    background.js
    api.js
    config.js
    style.css
    README.md

技术： - Manifest V3 - Content Script - Background Service Worker -
Chrome Storage

------------------------------------------------------------------------

## 8. 开发要求

输出：

-   完整插件源码
-   可直接 Load unpacked 安装
-   README
-   API 配置说明
-   测试说明

------------------------------------------------------------------------

## 9. 第二阶段优化

支持：

-   DOM 智能识别
-   React/Vue 动态按钮点击
-   图片区域自动识别
-   批量任务运行
-   自动保存评分日志

------------------------------------------------------------------------

## 给 Coding Agent 的任务

请根据以上需求开发 Chrome 插件 Siriser AI Auto Evaluator，实现自动读取
Siriser Image Benchmark 页面，通过用户自定义 API
获取视觉评分，并自动完成网页评分流程。
