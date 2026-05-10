const express = require("express");
const cron = require("node-cron");
const { getConfig } = require("./config");
const { runSync } = require("./syncService");

function createApp(config = getConfig({ requireSecrets: false })) {
  const app = express();
  let syncInProgress = false;

  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (req, res) => {
    res.json({
      ok: true,
      service: "engagement-tracker",
      time: new Date().toISOString()
    });
  });

  app.post("/sync-socials", async (req, res) => {
    if (!isAuthorized(req, config)) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    if (syncInProgress) {
      return res.status(409).json({
        ok: false,
        error: "A sync is already running. Try again in a few minutes."
      });
    }

    syncInProgress = true;
    try {
      const runtimeConfig = getConfig();
      const result = await runSync(runtimeConfig, syncOptionsFromRequest(req));
      return res.json(result);
    } catch (error) {
      console.error("[sync-socials] Sync failed:", error);
      return res.status(500).json({
        ok: false,
        error: error.message
      });
    } finally {
      syncInProgress = false;
    }
  });

  return app;
}

function startServer(config = getConfig({ requireSecrets: false })) {
  const app = createApp(config);
  const server = app.listen(config.port, () => {
    console.log(`Engagement Tracker listening on http://localhost:${config.port}`);
    console.log(`Webhook endpoint: POST http://localhost:${config.port}/sync-socials`);
  });

  return server;
}

function startCron(config = getConfig({ requireSecrets: false })) {
  if (!cron.validate(config.cron.schedule)) {
    throw new Error(`Invalid CRON_SCHEDULE: ${config.cron.schedule}`);
  }

  const task = cron.schedule(
    config.cron.schedule,
    async () => {
      console.log(`[cron] Starting scheduled sync at ${new Date().toISOString()}`);
      try {
        const result = await runSync(getConfig());
        console.log("[cron] Scheduled sync complete:", result);
      } catch (error) {
        console.error("[cron] Scheduled sync failed:", error);
      }
    },
    {
      timezone: config.cron.timezone
    }
  );

  console.log(`[cron] Scheduled weekly sync: "${config.cron.schedule}" (${config.cron.timezone})`);
  return task;
}

function isAuthorized(req, config) {
  if (!config.webhookSecret) {
    return true;
  }

  const provided = req.get("x-sync-secret") || req.query.secret || "";
  return provided === config.webhookSecret;
}

function syncOptionsFromRequest(req) {
  const body = req.body || {};
  return {
    startDate: body.startDate || req.query.startDate,
    endDate: body.endDate || req.query.endDate,
    lookbackDays: body.lookbackDays || req.query.lookbackDays,
    updateWeeklyRollups: booleanOption(body.updateWeeklyRollups ?? req.query.updateWeeklyRollups)
  };
}

function booleanOption(value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "y", "on"].includes(String(value).toLowerCase());
}

module.exports = {
  createApp,
  startServer,
  startCron,
  isAuthorized,
  syncOptionsFromRequest
};
