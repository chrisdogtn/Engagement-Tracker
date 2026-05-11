const ENGAGEMENT_TRACKER_WEBHOOK_URL =
  "https://YOUR_HOST_OR_NGROK_URL/sync-socials";
const ENGAGEMENT_TRACKER_WEBHOOK_SECRET = "69696969";

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("Engagement Tracker")
    .addItem("Sync Now", "syncSocialsNow")
    .addItem("Refresh Dashboard", "refreshEngagementDashboard")
    .addItem("Install Date Auto-Refresh", "installDashboardEditTrigger")
    .addToUi();
}

function syncSocialsNow() {
  const ui = SpreadsheetApp.getUi();
  const useCustomRange = ui.alert(
    "Sync date range",
    "Do you want to sync a specific date range?",
    ui.ButtonSet.YES_NO,
  );

  const payload = {
    source: "google-sheets",
    spreadsheetId: SpreadsheetApp.getActiveSpreadsheet().getId(),
    updateWeeklyRollups: true,
  };

  if (useCustomRange === ui.Button.YES) {
    const startResponse = ui.prompt(
      "Start date",
      "Enter start date as YYYY-MM-DD or M/D/YYYY.",
      ui.ButtonSet.OK_CANCEL,
    );
    if (startResponse.getSelectedButton() !== ui.Button.OK) return;

    const endResponse = ui.prompt(
      "End date",
      "Enter end date as YYYY-MM-DD or M/D/YYYY.",
      ui.ButtonSet.OK_CANCEL,
    );
    if (endResponse.getSelectedButton() !== ui.Button.OK) return;

    payload.startDate = startResponse.getResponseText();
    payload.endDate = endResponse.getResponseText();
  }

  const response = UrlFetchApp.fetch(ENGAGEMENT_TRACKER_WEBHOOK_URL, {
    method: "post",
    contentType: "application/json",
    headers: {
      "x-sync-secret": ENGAGEMENT_TRACKER_WEBHOOK_SECRET,
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });

  const status = response.getResponseCode();
  const body = response.getContentText();

  if (status >= 200 && status < 300) {
    ui.alert(
      "Engagement Tracker sync started/completed successfully.\n\n" + body,
    );
    return;
  }

  ui.alert(
    "Engagement Tracker sync failed with HTTP " + status + ".\n\n" + body,
  );
}

function refreshEngagementDashboard() {
  const ui = SpreadsheetApp.getUi();
  const result = postToEngagementTracker_("/refresh-dashboard", {
    source: "google-sheets-menu",
    spreadsheetId: SpreadsheetApp.getActiveSpreadsheet().getId(),
  });

  if (result.status >= 200 && result.status < 300) {
    ui.alert("Dashboard refresh completed.\n\n" + result.body);
    return;
  }

  ui.alert("Dashboard refresh failed with HTTP " + result.status + ".\n\n" + result.body);
}

function installDashboardEditTrigger() {
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(function (trigger) {
    if (trigger.getHandlerFunction() === "handleDashboardDateEdit") {
      ScriptApp.deleteTrigger(trigger);
    }
  });

  ScriptApp.newTrigger("handleDashboardDateEdit")
    .forSpreadsheet(SpreadsheetApp.getActiveSpreadsheet())
    .onEdit()
    .create();

  SpreadsheetApp.getUi().alert(
    "Installed. Editing a date in column A on Q1/Q2/Q3/Q4 Socials tabs will refresh the dashboard sections.",
  );
}

function handleDashboardDateEdit(e) {
  if (!e || !e.range) return;

  const sheet = e.range.getSheet();
  const sheetName = sheet.getName();
  const isDashboardSheet = /^Q[1-4] Socials$/i.test(sheetName);
  const editedColumnA = e.range.getColumn() === 1;
  const hasValue = String(e.value || "").trim() !== "";

  if (!isDashboardSheet || !editedColumnA || !hasValue) {
    return;
  }

  postToEngagementTracker_("/refresh-dashboard", {
    source: "google-sheets-on-edit",
    spreadsheetId: SpreadsheetApp.getActiveSpreadsheet().getId(),
    sheetName: sheetName,
    row: e.range.getRow(),
    value: e.value,
  });
}

function postToEngagementTracker_(path, payload) {
  const baseUrl = ENGAGEMENT_TRACKER_WEBHOOK_URL.replace(/\/sync-socials\/?$/, "");
  const response = UrlFetchApp.fetch(baseUrl + path, {
    method: "post",
    contentType: "application/json",
    headers: {
      "x-sync-secret": ENGAGEMENT_TRACKER_WEBHOOK_SECRET,
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });

  return {
    status: response.getResponseCode(),
    body: response.getContentText(),
  };
}
