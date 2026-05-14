const express = require("express");
const fs = require("fs");
const cron = require("node-cron");
const multer = require("multer");
const os = require("os");
const path = require("path");
const { getConfig } = require("./config");
const { importMetaExport, refreshDashboard, runSync } = require("./syncService");

const upload = multer({
  dest: path.join(os.tmpdir(), "engagement-tracker-imports"),
  limits: {
    fileSize: 10 * 1024 * 1024
  }
});

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
    if (!config.enableApiSync) {
      return res.status(410).json({
        ok: false,
        error: "API post sync is disabled. Use /import-meta-export for the manual CSV workflow, or set ENABLE_API_SYNC=true."
      });
    }

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

  app.post("/refresh-dashboard", async (req, res) => {
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
      const result = await refreshDashboard(getConfig());
      return res.json(result);
    } catch (error) {
      console.error("[refresh-dashboard] Refresh failed:", error);
      return res.status(500).json({
        ok: false,
        error: error.message
      });
    } finally {
      syncInProgress = false;
    }
  });

  app.get("/import-meta-export", (req, res) => {
    res.type("html").send(buildImportFormHtml(config));
  });

  app.post("/import-meta-export", upload.single("metaExport"), async (req, res) => {
    if (config.importMetaExportRequireSecret && !isAuthorized(req, config)) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    if (!req.file) {
      return res.status(400).json({ ok: false, error: "Upload a Meta lifetime export CSV as metaExport." });
    }

    if (syncInProgress) {
      return res.status(409).json({
        ok: false,
        error: "A sync or import is already running. Try again in a few minutes."
      });
    }

    syncInProgress = true;
    try {
      const result = await importMetaExport(getConfig(), {
        filePath: req.file.path,
        sourceFileName: req.file.originalname,
        weekStart: req.body.weekStart,
        weekEnd: req.body.weekEnd,
        updateWeeklyRollups: booleanOption(req.body.updateWeeklyRollups) !== false,
        updateAnalyticsTabs: booleanOption(req.body.updateAnalyticsTabs) !== false
      });
      return res.json(result);
    } catch (error) {
      console.error("[import-meta-export] Import failed:", error);
      return res.status(500).json({
        ok: false,
        error: error.message
      });
    } finally {
      if (req.file && req.file.path) {
        fs.promises.unlink(req.file.path).catch(() => {});
      }
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
    console.log(`Dashboard refresh endpoint: POST http://localhost:${config.port}/refresh-dashboard`);
    console.log(`Meta export import page: http://localhost:${config.port}/import-meta-export`);
  });

  return server;
}

function startCron(config = getConfig({ requireSecrets: false })) {
  if (!config.enableCron) {
    console.log("[cron] Disabled. Set ENABLE_CRON=true to restore scheduled API syncs.");
    return null;
  }

  if (!config.enableApiSync) {
    console.log("[cron] Disabled because ENABLE_API_SYNC is false.");
    return null;
  }

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

  const provided = req.get("x-sync-secret") || req.query.secret || (req.body && req.body.secret) || "";
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
  if (Array.isArray(value)) return booleanOption(value[value.length - 1]);
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "y", "on"].includes(String(value).toLowerCase());
}

function buildImportFormHtml(config = {}) {
  const requireSecret = Boolean(config.importMetaExportRequireSecret);
  const secretField = requireSecret
    ? `<label>Webhook Secret</label>
    <input name="secret" type="password" autocomplete="off" required>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Import Meta Export</title>
  <style>
    body { font-family: Arial, sans-serif; max-width: 720px; margin: 40px auto; padding: 0 18px; line-height: 1.5; }
    label { display: block; font-weight: 700; margin-top: 18px; }
    input { box-sizing: border-box; width: 100%; padding: 10px; margin-top: 6px; }
    button { margin-top: 22px; padding: 10px 14px; font-weight: 700; cursor: pointer; }
    .hint { color: #555; font-size: 14px; }
    .checks label { font-weight: 400; }
    .checks input { width: auto; margin-right: 8px; }
  </style>
</head>
<body>
  <h1>Import Meta Lifetime Export</h1>
  <p>Upload the Meta Business Suite content export for one weekly range. The app will store it in Imported Content Metrics and refresh the dashboard tabs.</p>
  <form method="post" action="/import-meta-export" enctype="multipart/form-data">
    ${secretField}
    <label>Meta Lifetime CSV</label>
    <input name="metaExport" type="file" accept=".csv,text/csv" required>
    <div class="checks">
      <input type="hidden" name="updateWeeklyRollups" value="false">
      <label><input type="checkbox" name="updateWeeklyRollups" value="true" checked> Refresh Q-sheet weekly rollups</label>
      <input type="hidden" name="updateAnalyticsTabs" value="false">
      <label><input type="checkbox" name="updateAnalyticsTabs" value="true" checked> Refresh analytics tabs</label>
    </div>
    <button type="submit">Import Export</button>
  </form>
</body>
</html>`;
}

module.exports = {
  createApp,
  startServer,
  startCron,
  isAuthorized,
  syncOptionsFromRequest
};
