const { getConfig } = require("./config");
const { processPost } = require("./logic/contentParser");
const { applyAdSpendToPosts, MetaAdsApiClient } = require("./services/metaAdsApi");
const { MetaApiClient } = require("./services/metaApi");
const { GoogleSheetsClient } = require("./services/googleSheets");
const { formatDateOnly, resolveSyncWindow } = require("./utils/dateRange");

async function runSync(config = getConfig(), options = {}) {
  const meta = new MetaApiClient(config.meta);
  const sheets = new GoogleSheetsClient(config.google);
  const syncWindow = resolveSyncWindow({
    startDate: options.startDate,
    endDate: options.endDate,
    lookbackDays: options.lookbackDays || config.meta.lookbackDays
  });
  const contentRules = config.contentRules;
  const removedLegacyRuleSheet = await sheets.removeLegacyContentRulesSheet();

  const rawPosts = await meta.fetchRecentPosts({
    startDate: syncWindow.startDate,
    endDate: syncWindow.endDate
  });
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
    fetchedPosts: rawPosts.length,
    insertedRows: upsertResult.insertedRows,
    updatedRows: upsertResult.updatedRows,
    totalRowsTouched: upsertResult.totalRowsTouched,
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

module.exports = {
  refreshDashboard,
  runSync
};
