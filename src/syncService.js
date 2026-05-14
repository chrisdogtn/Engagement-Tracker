const { getConfig } = require("./config");
const { processPost } = require("./logic/contentParser");
const { applyAdSpendToPosts, MetaAdsApiClient } = require("./services/metaAdsApi");
const { MetaApiClient } = require("./services/metaApi");
const { parseMetaExportFile } = require("./services/metaExportImporter");
const { GoogleSheetsClient } = require("./services/googleSheets");
const { formatDateOnly, resolveSyncWindow } = require("./utils/dateRange");

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
  const sheetImport = await sheets.upsertImportedContentMetrics(importResult);

  const weeklyRollups = updateWeeklyRollups
    ? await sheets.updateWeeklyRollupSheets()
    : [];
  const analyticsTabs = updateAnalyticsTabs && config.google.updateAnalyticsTabs
    ? await sheets.updateAnalyticsTabs()
    : [];

  return {
    ok: true,
    import: sheetImport,
    weeklyRollups,
    analyticsTabs,
    importedAt: new Date().toISOString()
  };
}

module.exports = {
  importMetaExport,
  refreshDashboard,
  runSync
};
