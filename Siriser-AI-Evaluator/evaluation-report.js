// Shared local report helpers for the service worker and extension popup.
(function (global) {
  "use strict";

  function reportScoreAverage(scores) {
    const dimensions = ["alignment", "quality", "preservation", "consistency", "realism"];
    const values = dimensions.map(function (key) { return Number(scores && scores[key]); })
      .filter(function (value, index) { return scores && scores[dimensions[index]] != null && Number.isFinite(value); });
    return values.length ? values.reduce(function (sum, value) { return sum + value; }, 0) / values.length : null;
  }

  function reportDailySummary(records) {
    const daily = Object.create(null);
    (records || []).forEach(function (record) {
      const date = String(record.date || "未知日期");
      const row = daily[date] || (daily[date] = {
        date: date, packages: 0, identified: 0, pending: 0, autoPackages: 0, manualPackages: 0, ratings: 0,
        imageIssues: 0, sums: [0, 0, 0, 0, 0], counts: [0, 0, 0, 0, 0],
      });
      row.packages += 1;
      if (record.taskId) row.identified += 1;
      else row.pending += 1;
      if (record.runMode === "自动") row.autoPackages += 1;
      else row.manualPackages += 1;
      (record.scores || []).forEach(function (score) {
        row.ratings += 1;
        if (score.imageStatus === "broken" || score.imageStatus === "missing") row.imageIssues += 1;
        ["alignment", "quality", "preservation", "consistency", "realism"].forEach(function (key, index) {
          const value = Number(score[key]);
          if (score[key] != null && Number.isFinite(value)) {
            row.sums[index] += value;
            row.counts[index] += 1;
          }
        });
      });
    });
    return Object.keys(daily).sort().map(function (date) {
      const row = daily[date];
      row.averages = row.sums.map(function (sum, index) {
        return row.counts[index] ? Number((sum / row.counts[index]).toFixed(2)) : "";
      });
      delete row.sums;
      delete row.counts;
      return row;
    });
  }

  function xmlEscape(value) {
    return String(value == null ? "" : value)
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;").replace(/'/g, "&apos;");
  }

  function excelCell(value) {
    const numeric = typeof value === "number" && Number.isFinite(value);
    return `<Cell><Data ss:Type="${numeric ? "Number" : "String"}" xml:space="preserve">${xmlEscape(value == null ? "" : value)}</Data></Cell>`;
  }

  function excelWorksheet(name, rows) {
    const content = rows.map(function (row) {
      return `<Row>${row.map(excelCell).join("")}</Row>`;
    }).join("");
    return `<Worksheet ss:Name="${xmlEscape(name)}"><Table>${content}</Table></Worksheet>`;
  }

  function buildEvaluationWorkbookXml(records) {
    records = Array.isArray(records) ? records.slice() : [];
    records.sort(function (a, b) { return String(a.completedAt || "").localeCompare(String(b.completedAt || "")); });
    const dimNames = ["指令遵循", "局部质量", "非编辑区保持", "全局一致", "真实感与美学"];
    const dailyRows = [["日期", "完成分包数", "自动分包", "手动分包", "已获取题目ID", "待补ID", "模型评分条数", "图片异常模型数"].concat(dimNames.map(function (name) { return `${name}平均分`; }))];
    reportDailySummary(records).forEach(function (row) {
      dailyRows.push([row.date, row.packages, row.autoPackages, row.manualPackages, row.identified, row.pending, row.ratings, row.imageIssues].concat(row.averages));
    });

    const packageRows = [["日期", "题目ID（分包标识）", "ID状态", "ID获取说明", "评分完成时间", "任务模式", "评分模式", "评委A", "评委B", "审核模型", "模型数", "平均分", "图片异常模型", "评分耗时(秒)"]];
    records.forEach(function (record) {
      const scores = record.scores || [];
      const averages = scores.map(reportScoreAverage).filter(function (value) { return value != null; });
      const issues = scores.filter(function (score) { return score.imageStatus === "broken" || score.imageStatus === "missing"; })
        .map(function (score) { return score.modelId; }).join(", ");
      packageRows.push([
        record.date, record.taskId || "", record.taskId ? "已获取（工作台题目ID）" : "待补 ID",
        record.idError || "", record.completedAt || "", record.runMode || "", ({ fast: "快速", balanced: "平衡", thinking: "思考" })[record.scoringMode] || record.scoringMode || "",
        record.evaluatorA || "", record.evaluatorB || "", record.reviewer || "", scores.length,
        averages.length ? Number((averages.reduce(function (sum, value) { return sum + value; }, 0) / averages.length).toFixed(2)) : "",
        issues, record.elapsedMs == null ? "" : Number((record.elapsedMs / 1000).toFixed(1)),
      ]);
    });

    const detailRows = [["日期", "题目ID（分包标识）", "图片模型", "模型名称", "指令遵循", "局部质量", "非编辑区保持", "全局一致", "真实感与美学", "均分", "评分理由/备注", "图片状态", "任务模式", "评分模式", "评委A", "评委B", "审核模型", "评分完成时间"]];
    records.forEach(function (record) {
      (record.scores || []).forEach(function (score) {
        const average = reportScoreAverage(score);
        detailRows.push([
          record.date, record.taskId || "", score.modelId || "", score.modelName || "",
          score.alignment, score.quality, score.preservation, score.consistency, score.realism,
          average == null ? "" : Number(average.toFixed(2)), score.reason || "",
          ({ ok: "正常", broken: "破图", missing: "无图", "no-score": "未获得评分", unknown: "未知" })[score.imageStatus] || score.imageStatus || "未知",
          record.runMode || "", ({ fast: "快速", balanced: "平衡", thinking: "思考" })[record.scoringMode] || record.scoringMode || "",
          record.evaluatorA || "", record.evaluatorB || "", record.reviewer || "", record.completedAt || "",
        ]);
      });
    });

    return '<?xml version="1.0" encoding="UTF-8"?><?mso-application progid="Excel.Sheet"?>' +
      '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet" xmlns:html="http://www.w3.org/TR/REC-html40">' +
      excelWorksheet("每日统计", dailyRows) + excelWorksheet("分包汇总", packageRows) + excelWorksheet("模型评分明细", detailRows) + '</Workbook>';
  }

  function utf8Base64(value) {
    const bytes = new TextEncoder().encode(String(value));
    let binary = "";
    const size = 0x8000;
    for (let i = 0; i < bytes.length; i += size) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + size));
    }
    return btoa(binary);
  }

  global.SiriserEvaluationReport = {
    reportScoreAverage,
    reportDailySummary,
    buildEvaluationWorkbookXml,
    utf8Base64,
  };
})(globalThis);
