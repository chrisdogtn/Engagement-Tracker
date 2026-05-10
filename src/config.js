const fs = require("fs");
const path = require("path");
require("dotenv").config();

const DEFAULT_CRON_SCHEDULE = "0 2 * * 1"; // Every Monday at 2:00 AM.
const DEFAULT_TIMEZONE = "America/New_York";
const DEFAULT_DASHBOARD_PATTERN = "^Q[1-4] Socials$";
const DEFAULT_CONTENT_RULES_PATH = path.resolve(__dirname, "../config/content-rules.default.json");

function numberFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a valid number.`);
  }

  return parsed;
}

function requireConfig(value, name) {
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function getConfig({ requireSecrets = true } = {}) {
  const config = {
    port: numberFromEnv("PORT", 3000),
    nodeEnv: process.env.NODE_ENV || "development",
    webhookSecret: process.env.WEBHOOK_SECRET || "",
    meta: {
      graphVersion: process.env.META_GRAPH_VERSION || "v24.0",
      pageId: process.env.META_PAGE_ID || "",
      pageAccessToken: process.env.META_PAGE_ACCESS_TOKEN || "",
      lookbackDays: numberFromEnv("LOOKBACK_DAYS", 14)
    },
    google: {
      spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID || "",
      sheetTabName: process.env.GOOGLE_SHEET_TAB_NAME || "Post-Level Tracking",
      weeklyRollupSheets: csvFromEnv("WEEKLY_ROLLUP_SHEETS"),
      weeklyRollupSheetPattern: process.env.WEEKLY_ROLLUP_SHEET_PATTERN || DEFAULT_DASHBOARD_PATTERN,
      dashboardYear: numberFromEnv("DASHBOARD_YEAR", new Date().getFullYear()),
      updateWeeklyRollups: booleanFromEnv("UPDATE_WEEKLY_ROLLUPS", true),
      updateAnalyticsTabs: booleanFromEnv("UPDATE_ANALYTICS_TABS", true),
      contentPerformanceSheetName: process.env.CONTENT_PERFORMANCE_SHEET_NAME || "Content Performance Breakdown",
      adBoostSheetName: process.env.AD_BOOST_SHEET_NAME || "Ad + Boost Tracking",
      applicationCredentials: process.env.GOOGLE_APPLICATION_CREDENTIALS || "",
      clientEmail: process.env.GOOGLE_CLIENT_EMAIL || "",
      privateKey: normalizePrivateKey(process.env.GOOGLE_PRIVATE_KEY || "")
    },
    contentRules: loadContentRules(),
    cron: {
      schedule: process.env.CRON_SCHEDULE || DEFAULT_CRON_SCHEDULE,
      timezone: process.env.CRON_TIMEZONE || DEFAULT_TIMEZONE
    }
  };

  if (requireSecrets) {
    requireConfig(config.meta.pageId, "META_PAGE_ID");
    requireConfig(config.meta.pageAccessToken, "META_PAGE_ACCESS_TOKEN");
    requireConfig(config.google.spreadsheetId, "GOOGLE_SPREADSHEET_ID");

    if (!config.google.applicationCredentials && (!config.google.clientEmail || !config.google.privateKey)) {
      throw new Error(
        "Missing Google credentials. Set GOOGLE_APPLICATION_CREDENTIALS or GOOGLE_CLIENT_EMAIL + GOOGLE_PRIVATE_KEY."
      );
    }
  }

  if (config.meta.lookbackDays < 1 || config.meta.lookbackDays > 90) {
    throw new Error("LOOKBACK_DAYS must be between 1 and 90.");
  }

  return config;
}

function normalizePrivateKey(key) {
  return key.replace(/\\n/g, "\n");
}

function csvFromEnv(name) {
  return (process.env[name] || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function booleanFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return ["1", "true", "yes", "y", "on"].includes(String(raw).toLowerCase());
}

function loadContentRules() {
  if (process.env.CONTENT_RULES_JSON) {
    return JSON.parse(process.env.CONTENT_RULES_JSON);
  }

  const rulesPath = process.env.CONTENT_RULES_FILE
    ? path.resolve(process.cwd(), process.env.CONTENT_RULES_FILE)
    : DEFAULT_CONTENT_RULES_PATH;

  return JSON.parse(fs.readFileSync(rulesPath, "utf8"));
}

module.exports = {
  getConfig
};
