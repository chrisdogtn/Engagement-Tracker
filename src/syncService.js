const { getConfig } = require("./config");
const { processPost } = require("./logic/contentParser");
const { applyAdSpendToPosts, MetaAdsApiClient } = require("./services/metaAdsApi");
const { MetaApiClient } = require("./services/metaApi");
const { parseMetaExportFile } = require("./services/metaExportImporter");
const { GoogleSheetsClient } = require("./services/googleSheets");
const { formatDateOnly, parseDateInput, resolveSyncWindow } = require("./utils/dateRange");

async function runSync(config = getConfig(), options = {}) {
  const meta = new MetaApiClient(config.meta);
  const sheets = new GoogleSheetsClient(config.google);
  const syncWindow = resolveSyncWindow({
    startDate: options.startDate,
    endDate: options.endDate,
    lookbackDays: options.lookbackDays
  });
  const contentRules = config.contentRules;
  const removedLegacyRuleSheet = await sheets.removeLegacyContentRulesSheet();

  const existingPosts = await sheets.readPostLevelObjects();
  const rawRecentPosts = await meta.fetchRecentPosts({
    startDate: syncWindow.startDate,
    endDate: syncWindow.endDate
  });
  const rawPosts = await refreshKnownPosts(meta, rawRecentPosts, existingPosts);
  let adSync = { configured: false, adRows: 0, mappedPosts: 0 };
  let hydratedPosts = rawPosts;
  if (config.meta.fetchAds) {
    const ads = new MetaAdsApiClient(config.meta);
    adSync = await ads.fetchAdSpendByPost({
      startDate: syncWindow.startDate,
      endDate: syncWindow.endDate
    });
    hydratedPosts = applyAdSpendToPosts(rawPosts, adSync.spendByPostId);
  }

  const processedPosts = hydratedPosts.map((post) => processPost(post, contentRules));
  const upsertResult = await sheets.upsertPosts(processedPosts, contentRules);
  const snapshotResult = await sheets.recordPostMetricSnapshot();

  let weeklyRollups = [];
  const shouldUpdateWeeklyRollups = options.updateWeeklyRollups !== undefined
    ? Boolean(options.updateWeeklyRollups)
    : config.google.updateWeeklyRollups;

  if (shouldUpdateWeeklyRollups) {
    weeklyRollups = await sheets.updateWeeklyRollupSheets();
  }

  let analyticsTabs = [];
  if (config.google.updateAnalyticsTabs) {
    analyticsTabs = await sheets.updateAnalyticsTabs();
  }

  return {
    ok: true,
    syncWindow: syncWindow.label,
    startDate: formatDateOnly(syncWindow.startDate),
    endDate: formatDateOnly(syncWindow.endDate),
    fetchedPosts: rawRecentPosts.length,
    refreshedKnownPosts: rawPosts.length - rawRecentPosts.length,
    insertedRows: upsertResult.insertedRows,
    updatedRows: upsertResult.updatedRows,
    totalRowsTouched: upsertResult.totalRowsTouched,
    metricSnapshot: snapshotResult,
    contentRules: contentRules.length,
    removedLegacyRuleSheet,
    adSync: {
      configured: adSync.configured,
      adRows: adSync.adRows,
      mappedPosts: adSync.mappedPosts
    },
    weeklyRollups,
    analyticsTabs,
    syncedAt: new Date().toISOString()
  };
}

async function refreshKnownPosts(meta, rawRecentPosts, existingPosts) {
  const recentById = new Map(rawRecentPosts.map((post) => [post.id, post]));
  const knownIds = existingPosts
    .map((post) => post["Post ID"])
    .filter((postId) => postId && !recentById.has(postId));

  if (!knownIds.length) {
    return rawRecentPosts;
  }

  const knownPosts = await meta.fetchPostsByIds(knownIds);
  return [...rawRecentPosts, ...knownPosts];
}

async function refreshDashboard(config = getConfig()) {
  const sheets = new GoogleSheetsClient(config.google);
  const weeklyRollups = await sheets.updateWeeklyRollupSheets();
  const analyticsTabs = config.google.updateAnalyticsTabs
    ? await sheets.updateAnalyticsTabs()
    : [];

  return {
    ok: true,
    weeklyRollups,
    analyticsTabs,
    refreshedAt: new Date().toISOString()
  };
}

async function importMetaExport(config = getConfig(), {
  filePath,
  sourceFileName,
  weekStart,
  weekEnd,
  followerGrowth,
  followersStart,
  followersEnd,
  updateWeeklyRollups = true,
  updateAnalyticsTabs = true
} = {}) {
  if (!filePath) {
    throw new Error("filePath is required for Meta export import.");
  }

  const sheets = new GoogleSheetsClient(config.google);
  const importResult = parseMetaExportFile(filePath, {
    contentRules: config.contentRules,
    sourceFileName,
    weekStart,
    weekEnd
  });
  const supplemental = await fetchImportSupplementalMetrics(config, importResult);
  applyFollowerOverrides(supplemental.followers, { followerGrowth, followersStart, followersEnd });
  applyImportAdSupplement(importResult, supplemental.adSync.spendByPostId, config.meta.pageId);
  const sheetImport = await sheets.upsertImportedContentMetrics(importResult);
  const weeklySummary = await sheets.upsertWeeklyMetricsSummary(importResult, supplemental);

  const weeklyRollups = updateWeeklyRollups
    ? await sheets.updateWeeklyRollupSheets()
    : [];
  const analyticsTabs = updateAnalyticsTabs && config.google.updateAnalyticsTabs
    ? await sheets.updateAnalyticsTabs()
    : [];

  return {
    ok: true,
    import: sheetImport,
    weeklySummary,
    supplemental: {
      followers: withoutSpendMap(supplemental.followers),
      adSync: withoutSpendMap(supplemental.adSync)
    },
    weeklyRollups,
    analyticsTabs,
    importedAt: new Date().toISOString()
  };
}

function applyFollowerOverrides(followers, overrides = {}) {
  const manualGrowth = numberOrBlank(overrides.followerGrowth);
  const manualStart = numberOrBlank(overrides.followersStart);
  const manualEnd = numberOrBlank(overrides.followersEnd);
  const hasManualValue = manualGrowth !== "" || manualStart !== "" || manualEnd !== "";
  if (!hasManualValue) return;

  if (manualGrowth !== "") followers.followerGrowth = manualGrowth;
  if (manualStart !== "") followers.followersStart = manualStart;
  if (manualEnd !== "") followers.followersEnd = manualEnd;
  followers.source = "Manual upload field";
}

async function fetchImportSupplementalMetrics(config, importResult) {
  const startDate = parseDateInput(importResult.weekStart);
  const endDate = parseDateInput(importResult.weekEnd);
  const supplemental = {
    followers: {
      configured: false,
      followerGrowth: "",
      followersStart: "",
      followersEnd: "",
      source: "Not configured"
    },
    adSync: {
      configured: false,
      adRows: 0,
      mappedPosts: 0,
      spendByPostId: new Map()
    }
  };

  if (config.meta.supplementFollowersOnImport && config.meta.pageId && config.meta.pageAccessToken) {
    const meta = new MetaApiClient(config.meta);
    supplemental.followers = await meta.fetchWeeklyFollowerMetrics({ startDate, endDate }).catch((error) => ({
      configured: true,
      followerGrowth: "",
      followersStart: "",
      followersEnd: "",
      source: "Meta follower metric unavailable",
      error: error.message
    }));
  }

  if (config.meta.supplementAdsOnImport) {
    const ads = new MetaAdsApiClient(config.meta);
    supplemental.adSync = await ads.fetchAdSpendByPost({ startDate, endDate }).catch((error) => ({
      configured: ads.isConfigured(),
      adRows: 0,
      mappedPosts: 0,
      spendByPostId: new Map(),
      error: error.message
    }));
  }

  return supplemental;
}

function applyImportAdSupplement(importResult, spendByPostId, pageId) {
  if (!spendByPostId || !spendByPostId.size) return;

  for (const row of importResult.rows) {
    const paid = findPaidMatch(row.postId, spendByPostId, pageId);
    if (!paid) continue;

    row.adSpend = paid.adSpend;
    row.adLeads = paid.adLeads;
    row.paidReach = paid.paidReach;
    row.paidClicks = paid.paidClicks;
    row.adIds = paid.adIds || [];
    row.boosted = "Yes";
  }

  importResult.totals = summarizeImportTotalsWithAds(importResult);
}

function findPaidMatch(postId, spendByPostId, pageId) {
  const rawPostId = String(postId || "").trim();
  if (!rawPostId) return null;

  const candidates = new Set([
    rawPostId,
    pageId ? `${pageId}_${rawPostId}` : ""
  ].filter(Boolean));

  for (const candidate of candidates) {
    const exact = spendByPostId.get(candidate);
    if (exact) return exact;
  }

  for (const [storyId, paid] of spendByPostId.entries()) {
    const normalizedStoryId = String(storyId || "").trim();
    if (
      normalizedStoryId.endsWith(`_${rawPostId}`) ||
      rawPostId.endsWith(`_${normalizedStoryId}`)
    ) {
      return paid;
    }
  }

  return null;
}

function summarizeImportTotalsWithAds(importResult) {
  const totals = { ...importResult.totals };
  totals.adSpend = importResult.rows.reduce((sum, row) => sum + toNumber(row.adSpend), 0);
  totals.adLeads = importResult.rows.reduce((sum, row) => sum + toNumber(row.adLeads), 0);
  totals.paidReach = importResult.rows.reduce((sum, row) => sum + toNumber(row.paidReach), 0);
  totals.paidClicks = importResult.rows.reduce((sum, row) => sum + toNumber(row.paidClicks), 0);
  return totals;
}

function withoutSpendMap(value) {
  if (!value || typeof value !== "object") return value;
  const copy = { ...value };
  delete copy.spendByPostId;
  return copy;
}

function toNumber(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function numberOrBlank(value) {
  if (value === undefined || value === null || value === "") return "";
  const parsed = Number(String(value).replace(/[$,%\s,]/g, ""));
  return Number.isFinite(parsed) ? parsed : "";
}

module.exports = {
  importMetaExport,
  refreshDashboard,
  runSync
};
