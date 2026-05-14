const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const {
  calculateEngagementRate,
  calculateEstimatedLeadValue,
  categorizeContent
} = require("../logic/contentParser");
const { formatDateOnly, parseDateInput, startOfDay } = require("../utils/dateRange");

const REQUIRED_LIFETIME_COLUMNS = [
  "Post ID",
  "Title",
  "Publish time",
  "Permalink",
  "Post type",
  "Date",
  "Views",
  "Reach",
  "Reactions",
  "Comments",
  "Shares",
  "Total clicks"
];

function parseMetaExportFile(filePath, {
  contentRules = [],
  weekStart,
  weekEnd,
  sourceFileName
} = {}) {
  const csvText = fs.readFileSync(filePath, "utf8");
  return parseMetaExportCsv(csvText, {
    contentRules,
    weekStart,
    weekEnd,
    sourceFileName: sourceFileName || path.basename(filePath)
  });
}

function parseMetaExportCsv(csvText, {
  contentRules = [],
  weekStart,
  weekEnd,
  sourceFileName = ""
} = {}) {
  const rows = parseCsv(csvText);
  if (!rows.length) {
    throw new Error("Meta export CSV is empty.");
  }

  const headers = rows[0].map((header) => stripBom(header).trim());
  const dataRows = rows.slice(1).filter((row) => row.some((cell) => String(cell || "").trim()));
  const objects = dataRows.map((row) => rowToObject(headers, row));

  assertLifetimeExport(headers, objects);

  const inferredRange = inferDateRange({ sourceFileName, objects, weekStart, weekEnd });
  const importId = buildImportId(sourceFileName, inferredRange.weekStart, inferredRange.weekEnd);
  const importedAt = new Date().toISOString();

  const importedRows = objects
    .filter((row) => String(row.Date || "").toLowerCase() === "lifetime")
    .filter((row) => row["Post ID"])
    .map((row) => buildImportedMetric(row, {
      contentRules,
      importedAt,
      importId,
      sourceFileName,
      weekStart: inferredRange.weekStart,
      weekEnd: inferredRange.weekEnd
    }));

  if (!importedRows.length) {
    throw new Error("No lifetime rows with Post ID were found in the Meta export.");
  }

  return {
    importId,
    sourceFileName,
    weekStart: inferredRange.weekStart,
    weekEnd: inferredRange.weekEnd,
    rows: importedRows,
    rowCount: importedRows.length,
    totals: summarizeImportedMetrics(importedRows)
  };
}

function buildImportedMetric(row, {
  contentRules,
  importedAt,
  importId,
  sourceFileName,
  weekStart,
  weekEnd
}) {
  const reactions = toNumber(row.Reactions);
  const comments = toNumber(row.Comments);
  const shares = toNumber(row.Shares);
  const totalEngagements = reactions + comments + shares;
  const reach = toNumber(row.Reach);
  const totalClicks = toNumber(row["Total clicks"]);
  const title = row.Title || row.Description || "";
  const views = toNumber(row.Views);

  return {
    importedAt,
    sourceFileName,
    importId,
    weekStart,
    weekEnd,
    postId: row["Post ID"] || "",
    publishTime: normalizeExportDate(row["Publish time"]),
    title,
    contentType: categorizeContent(title, contentRules),
    format: row["Post type"] || "",
    views,
    reach,
    totalEngagements,
    reactions,
    comments,
    shares,
    totalClicks,
    videoViews3s: toNumber(row["3-second video views"]),
    videoViews1m: toNumber(row["1-minute video views"]),
    secondsViewed: toNumber(row["Seconds viewed"]),
    avgSecondsViewed: toNumber(row["Average Seconds viewed"]),
    organicViews: toNumber(row["Views from Organic posts"]),
    boostedViews: toNumber(row["Views from Boosted posts"]),
    organicReach: toNumber(row["Reach from Organic posts"]),
    boostedReach: toNumber(row["Reach from Boosted posts"]),
    boosted: isBoosted(row) ? "Yes" : "No",
    engagementRate: calculateEngagementRate(totalEngagements, reach),
    estimatedLeadValue: calculateEstimatedLeadValue(totalClicks),
    permalink: row.Permalink || ""
  };
}

function assertLifetimeExport(headers, objects) {
  const missing = REQUIRED_LIFETIME_COLUMNS.filter((column) => !headers.includes(column));
  if (missing.length) {
    throw new Error(`Meta export is missing required lifetime column(s): ${missing.join(", ")}`);
  }

  const hasLifetimeRows = objects.some((row) => String(row.Date || "").toLowerCase() === "lifetime");
  if (!hasLifetimeRows) {
    throw new Error("This looks like a Daily export. Use the Lifetime export for the weekly import workflow.");
  }
}

function inferDateRange({ sourceFileName, objects, weekStart, weekEnd }) {
  if (weekStart && weekEnd) {
    return {
      weekStart: formatDateOnly(parseDateInput(weekStart)),
      weekEnd: formatDateOnly(parseDateInput(weekEnd))
    };
  }

  const filenameRange = parseDateRangeFromFilename(sourceFileName);
  if (filenameRange) {
    return filenameRange;
  }

  const publishDates = objects
    .map((row) => parseLooseDate(row["Publish time"]))
    .filter(Boolean)
    .sort((left, right) => left - right);

  if (!publishDates.length) {
    throw new Error("Could not infer week range from the file name or publish dates. Pass weekStart and weekEnd.");
  }

  return {
    weekStart: formatDateOnly(startOfDay(publishDates[0])),
    weekEnd: formatDateOnly(startOfDay(publishDates[publishDates.length - 1]))
  };
}

function parseDateRangeFromFilename(fileName) {
  const match = String(fileName || "").match(/([A-Za-z]+-\d{1,2}-\d{4})_([A-Za-z]+-\d{1,2}-\d{4})/);
  if (!match) return null;

  return {
    weekStart: formatDateOnly(parseDateInput(match[1].replace(/-/g, " "))),
    weekEnd: formatDateOnly(parseDateInput(match[2].replace(/-/g, " ")))
  };
}

function normalizeExportDate(value) {
  const parsed = parseLooseDate(value);
  return parsed ? parsed.toISOString() : value || "";
}

function parseLooseDate(value) {
  if (!value) return null;
  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) return parsed;

  const match = String(value).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (!match) return null;

  return new Date(
    Number(match[3]),
    Number(match[1]) - 1,
    Number(match[2]),
    Number(match[4] || 0),
    Number(match[5] || 0)
  );
}

function buildImportId(sourceFileName, weekStart, weekEnd) {
  const hash = crypto
    .createHash("sha1")
    .update(`${sourceFileName}|${weekStart}|${weekEnd}`)
    .digest("hex")
    .slice(0, 10);
  return `${weekStart}_${weekEnd}_${hash}`;
}

function summarizeImportedMetrics(rows) {
  const totals = rows.reduce((summary, row) => {
    summary.posts += 1;
    summary.views += toNumber(row.views);
    summary.reach += toNumber(row.reach);
    summary.engagements += toNumber(row.totalEngagements);
    summary.reactions += toNumber(row.reactions);
    summary.comments += toNumber(row.comments);
    summary.shares += toNumber(row.shares);
    summary.linkClicks += toNumber(row.totalClicks);
    summary.videoViews += toNumber(row.views);
    summary.videoViews3s += toNumber(row.videoViews3s);
    return summary;
  }, {
    posts: 0,
    views: 0,
    reach: 0,
    engagements: 0,
    reactions: 0,
    comments: 0,
    shares: 0,
    linkClicks: 0,
    videoViews: 0,
    videoViews3s: 0
  });

  totals.engagementRate = totals.reach ? totals.engagements / totals.reach : 0;
  return totals;
}

function isBoosted(row) {
  return toNumber(row["Views from Boosted posts"]) > 0 ||
    toNumber(row["Reach from Boosted posts"]) > 0 ||
    toNumber(row["3-second video views from Boosted posts"]) > 0;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        cell += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      row.push(cell);
      cell = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") {
        index += 1;
      }
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }

    cell += char;
  }

  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }

  return rows;
}

function rowToObject(headers, row) {
  return headers.reduce((object, header, index) => {
    object[header] = row[index] !== undefined ? row[index] : "";
    return object;
  }, {});
}

function stripBom(value) {
  return String(value || "").replace(/^\uFEFF/, "");
}

function toNumber(value) {
  if (typeof value === "number") return value;
  const parsed = Number(String(value || "").replace(/[$,%\s,]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

module.exports = {
  parseMetaExportCsv,
  parseMetaExportFile,
  summarizeImportedMetrics
};
