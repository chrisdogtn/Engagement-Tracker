const ENGAGEMENT_TRACKER_WEBHOOK_URL =
  "https://YOUR_HOST_OR_NGROK_URL/sync-socials";
const ENGAGEMENT_TRACKER_WEBHOOK_SECRET = "69696969";

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("Engagement Tracker")
    .addItem("Sync Now", "syncSocialsNow")
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
