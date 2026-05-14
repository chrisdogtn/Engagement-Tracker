const crypto = require("crypto");
const { google } = require("googleapis");
const { normalizeRules } = require("../logic/contentParser");
const { formatDateOnly, parseDateInput, startOfDay, endOfDay } = require("../utils/dateRange");

const HEADER_ROW = [
  "Synced At",
  "Post ID",
  "Date",
  "Post Message/Text",
  "Content Type",
  "Total Reach",
  "Total Engagements",
  "Reactions",
  "Comments",
  "Shares",
  "Link Clicks",
  "Engagement Rate",
  "Estimated Lead Value",
  "Permalink",
  "Format",
  "Video Views (3s)",
  "Avg Watch Time",
  "Boosted?",
  "Ad Spend ($)",
  "Notes",
  "Ad Leads"
];

const CONTENT_PERFORMANCE_HEADER_ROW = [
  "Content Type",
  "# of Posts",
  "Avg Reach",
  "Avg Engagements",
  "Avg Engagement Rate",
  "Total Shares",
  "Total Comments"
];

const AD_BOOST_HEADER_ROW = [
  "Date",
  "Post Title",
  "Type",
  "Objective",
  "Amount Spent",
  "Reach",
  "Engagements",
  "Cost per Engagement",
  "Leads",
  "Cost per Lead",
  "Notes",
  "Post ID",
  "Permalink"
];

const METRIC_SNAPSHOT_HEADER_ROW = [
  "Snapshot At",
  "Post ID",
  "Post Date",
  "Total Reach",
  "Total Engagements",
  "Reactions",
  "Comments",
  "Shares",
  "Link Clicks",
  "Video Views (3s)"
];

const IMPORTED_CONTENT_HEADER_ROW = [
  "Imported At",
  "Source File",
  "Import ID",
  "Week Start",
  "Week End",
  "Post ID",
  "Publish Time",
  "Post Title / Description",
  "Content Type",
  "Format",
  "Views",
  "Reach",
  "Total Engagements",
  "Reactions",
  "Comments",
  "Shares",
  "Total Clicks",
  "3-second Video Views",
  "1-minute Video Views",
  "Seconds Viewed",
  "Avg Seconds Viewed",
  "Organic Views",
  "Boosted Views",
  "Organic Reach",
  "Boosted Reach",
  "Boosted?",
  "Engagement Rate",
  "Estimated Lead Value",
  "Permalink"
];

class GoogleSheetsClient {
  constructor({
    spreadsheetId,
    sheetTabName,
    weeklyRollupSheets,
    weeklyRollupSheetPattern,
    weeklyRollupBoundaryMode,
    dashboardYear,
    contentPerformanceSheetName,
    adBoostSheetName,
    metricSnapshotSheetName,
    importedContentSheetName,
    weeklyRollupSource,
    applicationCredentials,
    serviceAccountJson,
    clientEmail,
    privateKey
  }) {
    this.spreadsheetId = spreadsheetId;
    this.sheetTabName = sheetTabName;
    this.weeklyRollupSheets = weeklyRollupSheets || [];
    this.weeklyRollupSheetPattern = weeklyRollupSheetPattern || "^Q[1-4] Socials$";
    this.weeklyRollupBoundaryMode = weeklyRollupBoundaryMode || "exclude-boundaries";
    this.dashboardYear = dashboardYear || new Date().getFullYear();
    this.contentPerformanceSheetName = contentPerformanceSheetName || "Content Performance Breakdown";
    this.adBoostSheetName = adBoostSheetName || "Ad + Boost Tracking";
    this.metricSnapshotSheetName = metricSnapshotSheetName || "Post Metric Snapshots";
    this.importedContentSheetName = importedContentSheetName || "Imported Content Metrics";
    this.weeklyRollupSource = weeklyRollupSource || "snapshots";
    this.auth = buildAuth({ applicationCredentials, serviceAccountJson, clientEmail, privateKey });
    this.sheets = google.sheets({ version: "v4", auth: this.auth });
  }

  async ensureHeaderRow() {
    await this.ensureSheetExists(this.sheetTabName);

    const range = `${quoteSheetName(this.sheetTabName)}!A1:${columnToLetter(HEADER_ROW.length)}1`;
    const response = await this.sheets.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range
    });

    const existing = response.data.values && response.data.values[0] ? response.data.values[0] : [];
    const merged = [...existing];

    for (const header of HEADER_ROW) {
      if (!merged.includes(header)) {
        merged.push(header);
      }
    }

    if (!arraysEqual(existing, merged)) {
      await this.sheets.spreadsheets.values.update({
        spreadsheetId: this.spreadsheetId,
        range: `${quoteSheetName(this.sheetTabName)}!A1:${columnToLetter(merged.length)}1`,
        valueInputOption: "RAW",
        requestBody: {
          values: [merged]
        }
      });
    }

    return merged;
  }

  async upsertPosts(posts, contentRules = []) {
    const headers = await this.ensureHeaderRow();
    await this.applyPostLevelFormatting(headers, contentRules);

    if (!posts.length) {
      return { insertedRows: 0, updatedRows: 0, totalRowsTouched: 0 };
    }

    const existingRows = await this.readPostLevelRows(headers);
    const postIdIndex = headers.indexOf("Post ID");
    if (postIdIndex === -1) {
      throw new Error('Post-Level Tracking must include a "Post ID" column for upserts.');
    }

    const existingByPostId = new Map();
    existingRows.forEach((row, index) => {
      const postId = row[postIdIndex];
      if (postId) {
        existingByPostId.set(postId, index + 2);
      }
    });

    const syncedAt = new Date().toISOString();
    const updates = [];
    const inserts = [];

    for (const post of posts) {
      const row = postToRow(post, syncedAt, headers);
      const existingRowNumber = existingByPostId.get(post.postId);
      if (existingRowNumber) {
        const existingRow = existingRows[existingRowNumber - 2] || [];
        updates.push({
          range: `${quoteSheetName(this.sheetTabName)}!A${existingRowNumber}:${columnToLetter(headers.length)}${existingRowNumber}`,
          values: [preserveManualFields(headers, row, existingRow)]
        });
      } else {
        inserts.push(row);
      }
    }

    if (updates.length) {
      await this.sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: this.spreadsheetId,
        requestBody: {
          valueInputOption: "USER_ENTERED",
          data: updates
        }
      });
    }

    if (inserts.length) {
      await this.sheets.spreadsheets.values.append({
        spreadsheetId: this.spreadsheetId,
        range: `${quoteSheetName(this.sheetTabName)}!A:${columnToLetter(headers.length)}`,
        valueInputOption: "USER_ENTERED",
        insertDataOption: "INSERT_ROWS",
        requestBody: {
          values: inserts
        }
      });
    }

    return {
      insertedRows: inserts.length,
      updatedRows: updates.length,
      totalRowsTouched: inserts.length + updates.length
    };
  }

  async readPostLevelObjects() {
    const headers = await this.ensureHeaderRow();
    const rows = await this.readPostLevelRows(headers);
    return rows.map((row) => rowToObject(headers, row));
  }

  async recordPostMetricSnapshot(posts = null) {
    await this.ensureMetricSnapshotSheet();
    const snapshotPosts = posts || await this.readPostLevelObjects();
    if (!snapshotPosts.length) {
      return { sheetName: this.metricSnapshotSheetName, rowsInserted: 0 };
    }

    const snapshotAt = new Date().toISOString();
    const rows = snapshotPosts
      .filter((post) => post["Post ID"])
      .map((post) => metricSnapshotToRow(post, snapshotAt));

    await this.sheets.spreadsheets.values.append({
      spreadsheetId: this.spreadsheetId,
      range: `${quoteSheetName(this.metricSnapshotSheetName)}!A:${columnToLetter(METRIC_SNAPSHOT_HEADER_ROW.length)}`,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: {
        values: rows
      }
    });

    return {
      sheetName: this.metricSnapshotSheetName,
      rowsInserted: rows.length
    };
  }

  async ensureMetricSnapshotSheet() {
    const sheet = await this.ensureSheetExists(this.metricSnapshotSheetName);
    const range = `${quoteSheetName(this.metricSnapshotSheetName)}!A1:${columnToLetter(METRIC_SNAPSHOT_HEADER_ROW.length)}1`;
    const response = await this.sheets.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range
    });
    const existing = response.data.values && response.data.values[0] ? response.data.values[0] : [];

    if (!arraysEqual(existing, METRIC_SNAPSHOT_HEADER_ROW)) {
      await this.sheets.spreadsheets.values.update({
        spreadsheetId: this.spreadsheetId,
        range,
        valueInputOption: "RAW",
        requestBody: {
          values: [METRIC_SNAPSHOT_HEADER_ROW]
        }
      });
    }

    await this.hideSheetById(sheet.properties.sheetId);
  }

  async readMetricSnapshots() {
    await this.ensureMetricSnapshotSheet();
    const range = `${quoteSheetName(this.metricSnapshotSheetName)}!A2:${columnToLetter(METRIC_SNAPSHOT_HEADER_ROW.length)}`;
    const response = await this.sheets.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range
    });
    const rows = response.data.values || [];
    return rows.map((row) => rowToObject(METRIC_SNAPSHOT_HEADER_ROW, row));
  }

  async ensureImportedContentSheet() {
    const sheet = await this.ensureSheetExists(this.importedContentSheetName);
    const range = `${quoteSheetName(this.importedContentSheetName)}!A1:${columnToLetter(IMPORTED_CONTENT_HEADER_ROW.length)}1`;
    const response = await this.sheets.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range
    });
    const existing = response.data.values && response.data.values[0] ? response.data.values[0] : [];

    if (!arraysEqual(existing, IMPORTED_CONTENT_HEADER_ROW)) {
      await this.sheets.spreadsheets.values.update({
        spreadsheetId: this.spreadsheetId,
        range,
        valueInputOption: "RAW",
        requestBody: {
          values: [IMPORTED_CONTENT_HEADER_ROW]
        }
      });
    }

    await this.formatImportedContentSheet(sheet.properties.sheetId);
  }

  async upsertImportedContentMetrics(importResult) {
    await this.ensureImportedContentSheet();

    const existingRows = await this.readImportedContentRows();
    const existingByKey = new Map();
    existingRows.forEach((row, index) => {
      const object = rowToObject(IMPORTED_CONTENT_HEADER_ROW, row);
      const key = importedMetricKey(object);
      if (key) existingByKey.set(key, index + 2);
      const permalinkKey = importedMetricPermalinkKey(object);
      if (permalinkKey) existingByKey.set(permalinkKey, index + 2);
    });

    const updates = [];
    const inserts = [];

    for (const metric of importResult.rows) {
      const row = importedMetricToRow(metric);
      const key = importedMetricKey({
        "Week End": metric.weekEnd,
        "Post ID": metric.postId
      });
      const permalinkKey = importedMetricPermalinkKey({
        "Week End": metric.weekEnd,
        Permalink: metric.permalink
      });
      const existingRowNumber = existingByKey.get(key) || existingByKey.get(permalinkKey);

      if (existingRowNumber) {
        updates.push({
          range: `${quoteSheetName(this.importedContentSheetName)}!A${existingRowNumber}:${columnToLetter(IMPORTED_CONTENT_HEADER_ROW.length)}${existingRowNumber}`,
          values: [row]
        });
      } else {
        inserts.push(row);
      }
    }

    if (updates.length) {
      await this.sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: this.spreadsheetId,
        requestBody: {
          valueInputOption: "RAW",
          data: updates
        }
      });
    }

    if (inserts.length) {
      await this.sheets.spreadsheets.values.append({
        spreadsheetId: this.spreadsheetId,
        range: `${quoteSheetName(this.importedContentSheetName)}!A:${columnToLetter(IMPORTED_CONTENT_HEADER_ROW.length)}`,
        valueInputOption: "RAW",
        insertDataOption: "INSERT_ROWS",
        requestBody: {
          values: inserts
        }
      });
    }

    return {
      sheetName: this.importedContentSheetName,
      importId: importResult.importId,
      weekStart: importResult.weekStart,
      weekEnd: importResult.weekEnd,
      insertedRows: inserts.length,
      updatedRows: updates.length,
      totalRowsTouched: inserts.length + updates.length,
      totals: importResult.totals
    };
  }

  async readImportedContentObjects() {
    await this.ensureImportedContentSheet();
    const rows = await this.readImportedContentRows();
    return rows.map((row) => rowToObject(IMPORTED_CONTENT_HEADER_ROW, row));
  }

  async readImportedContentRows() {
    const range = `${quoteSheetName(this.importedContentSheetName)}!A2:${columnToLetter(IMPORTED_CONTENT_HEADER_ROW.length)}`;
    const response = await this.sheets.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range
    });

    return response.data.values || [];
  }

  async updateWeeklyRollupSheets() {
    const posts = await this.readPostLevelObjects();
    const importedMetrics = await this.readImportedContentObjects();
    const snapshots = this.weeklyRollupSource === "snapshots"
      ? await this.readMetricSnapshots()
      : [];
    const sheetNames = await this.resolveWeeklyRollupSheetNames();
    const results = [];

    for (const sheetName of sheetNames) {
      const result = await this.updateSectionStyleWeeklySheet(sheetName, posts, snapshots, importedMetrics);
      results.push(result);
    }

    return results;
  }

  async updateAnalyticsTabs() {
    const posts = await this.readPostLevelObjects();
    const performance = await this.updateContentPerformanceBreakdown();
    const adBoost = await this.updateAdBoostTracking(posts);

    return [performance, adBoost];
  }

  async removeLegacyContentRulesSheet() {
    const spreadsheet = await this.getSpreadsheet();
    const legacySheet = spreadsheet.sheets.find((sheet) => sheet.properties.title === "Content Rules");
    if (!legacySheet) {
      return false;
    }

    await this.sheets.spreadsheets.batchUpdate({
      spreadsheetId: this.spreadsheetId,
      requestBody: {
        requests: [
          {
            deleteSheet: {
              sheetId: legacySheet.properties.sheetId
            }
          }
        ]
      }
    });

    return true;
  }

  async updateContentPerformanceBreakdown() {
    await this.ensureImportedContentSheet();
    await this.ensureSheetExists(this.contentPerformanceSheetName);
    const controls = await this.readDateRangeControls(this.contentPerformanceSheetName);

    await this.sheets.spreadsheets.values.clear({
      spreadsheetId: this.spreadsheetId,
      range: `${quoteSheetName(this.contentPerformanceSheetName)}!A:G`
    });

    await this.sheets.spreadsheets.values.update({
      spreadsheetId: this.spreadsheetId,
      range: `${quoteSheetName(this.contentPerformanceSheetName)}!A1`,
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [
          ["Date Range Filter", "Leave either date blank to include all matching rows."],
          ["Start Date", controls.startDate],
          ["End Date", controls.endDate],
          [],
          [buildContentPerformanceFormula(this.importedContentSheetName)]
        ]
      }
    });

    await this.formatGeneratedAnalyticsSheet(this.contentPerformanceSheetName, {
      headerRows: [0, 4],
      filterStartRow: 4,
      filterColumnCount: CONTENT_PERFORMANCE_HEADER_ROW.length,
      numberColumns: [1, 2, 3, 5, 6],
      percentColumns: [4],
      moneyColumns: []
    });

    return {
      sheetName: this.contentPerformanceSheetName,
      mode: "formula"
    };
  }

  async updateAdBoostTracking(posts) {
    await this.ensureSheetExists(this.adBoostSheetName);
    const controls = await this.readDateRangeControls(this.adBoostSheetName);

    await this.sheets.spreadsheets.values.clear({
      spreadsheetId: this.spreadsheetId,
      range: `${quoteSheetName(this.adBoostSheetName)}!A:M`
    });

    await this.sheets.spreadsheets.values.update({
      spreadsheetId: this.spreadsheetId,
      range: `${quoteSheetName(this.adBoostSheetName)}!A1`,
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [
          ["Date Range Filter", "Leave either date blank to include all matching rows."],
          ["Start Date", controls.startDate],
          ["End Date", controls.endDate],
          [],
          [buildAdBoostFormula(this.sheetTabName)]
        ]
      }
    });

    await this.formatGeneratedAnalyticsSheet(this.adBoostSheetName, {
      headerRows: [0, 4],
      filterStartRow: 4,
      filterColumnCount: AD_BOOST_HEADER_ROW.length,
      percentColumns: [],
      moneyColumns: [4, 7, 9]
    });

    return {
      sheetName: this.adBoostSheetName,
      mode: "formula"
    };
  }

  async resolveWeeklyRollupSheetNames() {
    if (this.weeklyRollupSheets.length) {
      return this.weeklyRollupSheets;
    }

    const spreadsheet = await this.getSpreadsheet();
    const pattern = new RegExp(this.weeklyRollupSheetPattern, "i");
    return spreadsheet.sheets
      .map((sheet) => sheet.properties.title)
      .filter((title) => pattern.test(title));
  }

  async updateSectionStyleWeeklySheet(sheetName, posts, snapshots = [], importedMetrics = []) {
    const range = `${quoteSheetName(sheetName)}!A1:L250`;
    const response = await this.sheets.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range
    }).catch((error) => {
      if (error && error.code === 400) {
        return { data: { values: [] } };
      }
      throw error;
    });

    const values = response.data.values || [];
    const updates = buildWeeklySectionUpdates(values, posts, {
      sheetName,
      dashboardYear: this.dashboardYear,
      boundaryMode: this.weeklyRollupBoundaryMode,
      snapshots,
      importedMetrics,
      rollupSource: this.weeklyRollupSource
    });

    if (updates.length) {
      await this.sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: this.spreadsheetId,
        requestBody: {
          valueInputOption: "USER_ENTERED",
          data: updates
        }
      });
    }

    return {
      sheetName,
      updatedCells: updates.length
    };
  }

  async hideSheetById(sheetId) {
    const spreadsheet = await this.getSpreadsheet();
    const sheet = spreadsheet.sheets.find((candidate) => candidate.properties.sheetId === sheetId);
    if (!sheet || sheet.properties.hidden) return;

    await this.sheets.spreadsheets.batchUpdate({
      spreadsheetId: this.spreadsheetId,
      requestBody: {
        requests: [
          {
            updateSheetProperties: {
              properties: {
                sheetId,
                hidden: true
              },
              fields: "hidden"
            }
          }
        ]
      }
    });
  }

  async applyPostLevelFormatting(headers, contentRules) {
    const sheet = await this.getSheetProperty(this.sheetTabName);
    const contentTypes = normalizeRules(contentRules).map((rule) => rule.contentType);
    if (!contentTypes.includes("Other")) {
      contentTypes.push("Other");
    }

    const requests = [];
    const contentTypeIndex = headers.indexOf("Content Type");
    if (contentTypeIndex !== -1) {
      requests.push({
        setDataValidation: {
          range: gridRange(sheet.sheetId, contentTypeIndex, contentTypeIndex + 1, 1, 1000),
          rule: {
            condition: {
              type: "ONE_OF_LIST",
              values: contentTypes.map((type) => ({ userEnteredValue: type }))
            },
            strict: false,
            showCustomUi: true
          }
        }
      });
    }

    const boostedIndex = headers.indexOf("Boosted?");
    if (boostedIndex !== -1) {
      requests.push({
        setDataValidation: {
          range: gridRange(sheet.sheetId, boostedIndex, boostedIndex + 1, 1, 1000),
          rule: {
            condition: {
              type: "ONE_OF_LIST",
              values: ["Yes", "No"].map((value) => ({ userEnteredValue: value }))
            },
            strict: false,
            showCustomUi: true
          }
        }
      });
    }

    const percentIndex = headers.indexOf("Engagement Rate");
    if (percentIndex !== -1) {
      requests.push(formatColumnRequest(sheet.sheetId, percentIndex, "PERCENT", "0.00%"));
    }

    const moneyIndex = headers.indexOf("Estimated Lead Value");
    if (moneyIndex !== -1) {
      requests.push(formatColumnRequest(sheet.sheetId, moneyIndex, "CURRENCY", "$#,##0.00"));
    }

    requests.push({
      setBasicFilter: {
        filter: {
          range: gridRange(sheet.sheetId, 0, headers.length, 0)
        }
      }
    });

    if (requests.length) {
      await this.sheets.spreadsheets.batchUpdate({
        spreadsheetId: this.spreadsheetId,
        requestBody: {
          requests
        }
      });
    }
  }

  async formatGeneratedAnalyticsSheet(sheetName, {
    headerRows = [0],
    filterStartRow,
    filterColumnCount,
    numberColumns = [],
    percentColumns,
    moneyColumns
  }) {
    const sheet = await this.getSheetProperty(sheetName);
    const requests = [];

    for (const rowIndex of headerRows) {
      requests.push({
        repeatCell: {
          range: gridRange(sheet.sheetId, 0, 20, rowIndex, rowIndex + 1),
          cell: {
            userEnteredFormat: {
              textFormat: {
                bold: true
              }
            }
          },
          fields: "userEnteredFormat.textFormat.bold"
        }
      });
    }

    requests.push(formatRangeRequest(sheet.sheetId, 1, 2, 1, 3, "DATE", "m/d/yyyy"));

    const dataStartRow = Number.isInteger(filterStartRow) ? filterStartRow + 1 : 1;

    for (const columnIndex of numberColumns) {
      requests.push(formatColumnRequest(sheet.sheetId, columnIndex, "NUMBER", "#,##0.00", dataStartRow));
    }

    for (const columnIndex of percentColumns) {
      requests.push(formatColumnRequest(sheet.sheetId, columnIndex, "PERCENT", "0.00%", dataStartRow));
    }

    for (const columnIndex of moneyColumns) {
      requests.push(formatColumnRequest(sheet.sheetId, columnIndex, "CURRENCY", "$#,##0.00", dataStartRow));
    }

    if (Number.isInteger(filterStartRow) && Number.isInteger(filterColumnCount)) {
      requests.push({
        setBasicFilter: {
          filter: {
            range: gridRange(sheet.sheetId, 0, filterColumnCount, filterStartRow)
          }
        }
      });
    }

    await this.sheets.spreadsheets.batchUpdate({
      spreadsheetId: this.spreadsheetId,
      requestBody: {
        requests
      }
    });
  }

  async formatImportedContentSheet(sheetId) {
    const requests = [
      {
        setBasicFilter: {
          filter: {
            range: gridRange(sheetId, 0, IMPORTED_CONTENT_HEADER_ROW.length, 0)
          }
        }
      },
      formatColumnRequest(sheetId, 3, "DATE", "m/d/yyyy"),
      formatColumnRequest(sheetId, 4, "DATE", "m/d/yyyy"),
      formatColumnRequest(sheetId, 26, "PERCENT", "0.00%"),
      formatColumnRequest(sheetId, 27, "CURRENCY", "$#,##0.00")
    ];

    await this.sheets.spreadsheets.batchUpdate({
      spreadsheetId: this.spreadsheetId,
      requestBody: {
        requests
      }
    });
  }

  async readPostLevelRows(headers) {
    const range = `${quoteSheetName(this.sheetTabName)}!A2:${columnToLetter(headers.length)}`;
    const response = await this.sheets.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range
    });

    return response.data.values || [];
  }

  async readDateRangeControls(sheetName) {
    const range = `${quoteSheetName(sheetName)}!B2:B3`;
    const response = await this.sheets.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range
    }).catch((error) => {
      if (error && error.code === 400) {
        return { data: { values: [] } };
      }
      throw error;
    });

    const values = response.data.values || [];
    return {
      startDate: sanitizeDateControl(values[0] && values[0][0] ? values[0][0] : "", this.dashboardYear),
      endDate: sanitizeDateControl(values[1] && values[1][0] ? values[1][0] : "", this.dashboardYear)
    };
  }

  async ensureSheetExists(title) {
    const spreadsheet = await this.getSpreadsheet();
    const existingSheet = spreadsheet.sheets.find((sheet) => sheet.properties.title === title);
    if (existingSheet) {
      return existingSheet;
    }

    await this.sheets.spreadsheets.batchUpdate({
      spreadsheetId: this.spreadsheetId,
      requestBody: {
        requests: [
          {
            addSheet: {
              properties: {
                title
              }
            }
          }
        ]
      }
    });

    const refreshed = await this.getSpreadsheet();
    return refreshed.sheets.find((sheet) => sheet.properties.title === title);
  }

  async getSheetProperty(title) {
    const spreadsheet = await this.getSpreadsheet();
    const sheet = spreadsheet.sheets.find((item) => item.properties.title === title);
    if (!sheet) {
      throw new Error(`Could not find sheet tab "${title}".`);
    }
    return sheet.properties;
  }

  async getSpreadsheet() {
    const response = await this.sheets.spreadsheets.get({
      spreadsheetId: this.spreadsheetId,
      fields: "sheets.properties(sheetId,title,index)"
    });
    return response.data;
  }
}

function buildAuth({ applicationCredentials, serviceAccountJson, clientEmail, privateKey }) {
  const scopes = ["https://www.googleapis.com/auth/spreadsheets"];

  if (serviceAccountJson) {
    validatePrivateKey(serviceAccountJson.private_key, "GOOGLE_SERVICE_ACCOUNT_JSON.private_key");
    return new google.auth.GoogleAuth({
      credentials: serviceAccountJson,
      scopes
    });
  }

  if (clientEmail && privateKey) {
    validatePrivateKey(privateKey, "GOOGLE_PRIVATE_KEY");
    return new google.auth.JWT({
      email: clientEmail,
      key: privateKey,
      scopes
    });
  }

  if (applicationCredentials) {
    return new google.auth.GoogleAuth({
      keyFile: applicationCredentials,
      scopes
    });
  }

  throw new Error(
    "Missing Google credentials. Set GOOGLE_SERVICE_ACCOUNT_JSON, GOOGLE_CLIENT_EMAIL + GOOGLE_PRIVATE_KEY, or GOOGLE_APPLICATION_CREDENTIALS."
  );
}

function validatePrivateKey(privateKey, sourceName) {
  if (!privateKey || !String(privateKey).includes("BEGIN PRIVATE KEY")) {
    throw new Error(
      `${sourceName} is not a valid Google service-account private key. It must include -----BEGIN PRIVATE KEY----- and escaped \\n line breaks.`
    );
  }

  try {
    crypto.createPrivateKey(privateKey);
  } catch (error) {
    throw new Error(
      `${sourceName} could not be decoded by Node/OpenSSL. In Coolify, paste the full service-account JSON into GOOGLE_SERVICE_ACCOUNT_JSON, or use GOOGLE_SERVICE_ACCOUNT_JSON_BASE64. Original decoder error: ${error.message}`
    );
  }
}

function postToRow(post, syncedAt, headers = HEADER_ROW) {
  const byHeader = {
    "Synced At": syncedAt,
    "Post ID": post.postId,
    Date: post.date,
    "Post Message/Text": post.message,
    "Content Type": post.contentType,
    "Total Reach": post.reach,
    "Total Engagements": post.totalEngagements,
    Reactions: post.reactions,
    Comments: post.comments,
    Shares: post.shares,
    "Link Clicks": post.linkClicks,
    "Engagement Rate": post.engagementRate,
    "Estimated Lead Value": post.estimatedLeadValue,
    Permalink: post.permalinkUrl,
    Format: post.format,
    "Video Views (3s)": post.videoViews,
    "Avg Watch Time": post.avgWatchTime,
    "Boosted?": post.boosted,
    "Ad Spend ($)": post.adSpend || "",
    "Ad Leads": post.adLeads || "",
    Notes: ""
  };

  return headers.map((header) => byHeader[header] !== undefined ? byHeader[header] : "");
}

function preserveManualFields(headers, incomingRow, existingRow) {
  const merged = [...incomingRow];
  preserveIfIncomingBlank(headers, merged, existingRow, "Notes");
  preserveIfIncomingBlank(headers, merged, existingRow, "Ad Spend ($)");
  preserveIfIncomingBlank(headers, merged, existingRow, "Ad Leads");
  preserveBoostedValue(headers, merged, existingRow);
  return merged;
}

function preserveIfIncomingBlank(headers, incomingRow, existingRow, headerName) {
  const index = headers.indexOf(headerName);
  if (index === -1) return;

  const incoming = incomingRow[index];
  const existing = existingRow[index];
  const incomingBlank = incoming === "" || incoming === undefined || incoming === null || Number(incoming) === 0;
  if (incomingBlank && existing !== undefined && existing !== "") {
    incomingRow[index] = existing;
  }
}

function preserveBoostedValue(headers, incomingRow, existingRow) {
  const index = headers.indexOf("Boosted?");
  if (index === -1) return;

  const incoming = String(incomingRow[index] || "").toLowerCase();
  const existing = existingRow[index];
  if ((incoming === "" || incoming === "no") && existing) {
    incomingRow[index] = existing;
  }
}

function rowToObject(headers, row) {
  return headers.reduce((object, header, index) => {
    object[header] = row[index] !== undefined ? row[index] : "";
    return object;
  }, {});
}

function buildWeeklySectionUpdates(values, posts, {
  sheetName,
  dashboardYear,
  boundaryMode = "exclude-boundaries",
  snapshots = [],
  importedMetrics = [],
  rollupSource = "snapshots"
}) {
  const updates = [];
  let section = "";
  let sectionHeader = [];

  values.forEach((row, rowIndex) => {
    const firstCell = row[0] || "";
    const parsedDate = parseDashboardDate(firstCell, dashboardYear);

    if (!parsedDate && String(firstCell).trim() && !isKnownColumnLabel(firstCell)) {
      section = normalizeLabel(firstCell);
      sectionHeader = row;
      return;
    }

    if (!parsedDate || !section) {
      return;
    }

    const importedStats = summarizeImportedForWeek(importedMetrics, parsedDate);
    const fallbackStats = importedMetrics.length
      ? null
      : rollupSource === "snapshots" && snapshots.length
        ? summarizeSnapshotsForWeek(posts, snapshots, parsedDate, boundaryMode)
        : summarizePostsForWeek(posts, parsedDate, boundaryMode);
    const stats = importedStats || fallbackStats;
    const rowNumber = rowIndex + 1;
    const weeklyActualColumn = findColumnIndex(sectionHeader, "weekly actual", 2);

    if (!stats) return;

    if (section.includes("total reach")) {
      updates.push(cellUpdate(sheetName, rowNumber, weeklyActualColumn, stats.reach));
    } else if (section.includes("total engagement")) {
      updates.push(cellUpdate(sheetName, rowNumber, weeklyActualColumn, stats.engagements));
      addOptionalMetricUpdate(updates, sheetName, rowNumber, sectionHeader, "reaction", stats.reactions);
      addOptionalMetricUpdate(updates, sheetName, rowNumber, sectionHeader, "comment", stats.comments);
      addOptionalMetricUpdate(updates, sheetName, rowNumber, sectionHeader, "share", stats.shares);
      if (!addOptionalMetricUpdate(updates, sheetName, rowNumber, sectionHeader, "video", stats.videoViews)) {
        addOptionalMetricUpdate(updates, sheetName, rowNumber, sectionHeader, "view", stats.videoViews);
      }
      addOptionalMetricUpdate(updates, sheetName, rowNumber, sectionHeader, "click", stats.linkClicks);
    } else if (section.includes("engagement rate")) {
      updates.push(cellUpdate(sheetName, rowNumber, weeklyActualColumn, stats.engagementRate));
    }
  });

  return updates;
}

function metricSnapshotToRow(post, snapshotAt) {
  return [
    snapshotAt,
    post["Post ID"] || "",
    post.Date || "",
    toNumber(post["Total Reach"]),
    toNumber(post["Total Engagements"]),
    toNumber(post.Reactions),
    toNumber(post.Comments),
    toNumber(post.Shares),
    toNumber(post["Link Clicks"]),
    toNumber(post["Video Views (3s)"])
  ];
}

function importedMetricToRow(metric) {
  return [
    metric.importedAt,
    metric.sourceFileName,
    metric.importId,
    metric.weekStart,
    metric.weekEnd,
    metric.postId,
    metric.publishTime,
    metric.title,
    metric.contentType,
    metric.format,
    metric.views,
    metric.reach,
    metric.totalEngagements,
    metric.reactions,
    metric.comments,
    metric.shares,
    metric.totalClicks,
    metric.videoViews3s,
    metric.videoViews1m,
    metric.secondsViewed,
    metric.avgSecondsViewed,
    metric.organicViews,
    metric.boostedViews,
    metric.organicReach,
    metric.boostedReach,
    metric.boosted,
    metric.engagementRate,
    metric.estimatedLeadValue,
    metric.permalink
  ];
}

function importedMetricKey(metric) {
  const weekEnd = metric["Week End"] || metric.weekEnd;
  const postId = metric["Post ID"] || metric.postId;
  if (!weekEnd || !postId) return "";
  return `${formatDateKey(weekEnd)}|${postId}`;
}

function importedMetricPermalinkKey(metric) {
  const weekEnd = metric["Week End"] || metric.weekEnd;
  const permalink = metric.Permalink || metric.permalink;
  if (!weekEnd || !permalink) return "";
  return `${formatDateKey(weekEnd)}|${String(permalink).trim()}`;
}

function formatDateKey(value) {
  const parsed = parsePostDate(value);
  return parsed ? parsed.toISOString().slice(0, 10) : String(value || "").trim();
}

function summarizeImportedForWeek(importedMetrics, endDate) {
  const target = formatDateOnly(endDate);
  const rows = importedMetrics.filter((metric) => formatDateKey(metric["Week End"]) === target);
  if (!rows.length) return null;

  const totals = rows.reduce((summary, metric) => {
    summary.reach += toNumber(metric.Reach);
    summary.engagements += toNumber(metric["Total Engagements"]);
    summary.reactions += toNumber(metric.Reactions);
    summary.comments += toNumber(metric.Comments);
    summary.shares += toNumber(metric.Shares);
    summary.linkClicks += toNumber(metric["Total Clicks"]);
    summary.videoViews += toNumber(metric.Views);
    summary.videoViews3s += toNumber(metric["3-second Video Views"]);
    return summary;
  }, {
    reach: 0,
    engagements: 0,
    reactions: 0,
    comments: 0,
    shares: 0,
    linkClicks: 0,
    videoViews: 0,
    videoViews3s: 0,
    source: "imported"
  });

  totals.engagementRate = totals.reach ? totals.engagements / totals.reach : 0;
  return totals;
}

function summarizeSnapshotsForWeek(posts, snapshots, endDate, boundaryMode = "exclude-boundaries") {
  const normalizedBoundaryMode = normalizeBoundaryMode(boundaryMode);
  const start = startOfDay(new Date(endDate));
  start.setDate(start.getDate() - 7);
  const end = endOfDay(endDate);
  const includeStart = normalizedBoundaryMode === "include-boundaries" || normalizedBoundaryMode === "exclude-end";
  const includeEnd = normalizedBoundaryMode === "include-boundaries" || normalizedBoundaryMode === "exclude-start";
  const startBoundary = includeStart ? start : endOfDay(start);
  const endBoundary = includeEnd ? end : startOfDay(endDate);
  const snapshotsByPost = groupSnapshotsByPost(snapshots);
  const postDateById = new Map(posts.map((post) => [post["Post ID"], parsePostDate(post.Date)]));

  const totals = {
    reach: 0,
    engagements: 0,
    reactions: 0,
    comments: 0,
    shares: 0,
    linkClicks: 0,
    videoViews: 0
  };
  let coveredPosts = 0;

  for (const [postId, postSnapshots] of snapshotsByPost.entries()) {
    const endSnapshot = findSnapshotAtOrBefore(postSnapshots, endBoundary, includeEnd) ||
      findSnapshotAtOrAfter(postSnapshots, endBoundary, includeEnd, 2);
    if (!endSnapshot) continue;

    const startSnapshot = findSnapshotAtOrBefore(postSnapshots, startBoundary, includeStart) ||
      findSnapshotAtOrAfter(postSnapshots, startBoundary, includeStart, 2);
    const postDate = postDateById.get(postId);
    const createdInWindow = postDate && postDate > startBoundary && postDate < endBoundary;
    if (!startSnapshot && !createdInWindow) {
      continue;
    }

    coveredPosts += 1;
    addSnapshotDelta(totals, startSnapshot, endSnapshot);
  }

  if (!coveredPosts) return null;
  totals.engagementRate = totals.reach ? totals.engagements / totals.reach : 0;
  return totals;
}

function groupSnapshotsByPost(snapshots) {
  const groups = new Map();

  for (const snapshot of snapshots) {
    const postId = snapshot["Post ID"];
    const snapshotDate = parsePostDate(snapshot["Snapshot At"]);
    if (!postId || !snapshotDate) continue;

    const current = groups.get(postId) || [];
    current.push({
      snapshotAt: snapshotDate,
      reach: toNumber(snapshot["Total Reach"]),
      engagements: toNumber(snapshot["Total Engagements"]),
      reactions: toNumber(snapshot.Reactions),
      comments: toNumber(snapshot.Comments),
      shares: toNumber(snapshot.Shares),
      linkClicks: toNumber(snapshot["Link Clicks"]),
      videoViews: toNumber(snapshot["Video Views (3s)"])
    });
    groups.set(postId, current);
  }

  for (const group of groups.values()) {
    group.sort((left, right) => left.snapshotAt - right.snapshotAt);
  }

  return groups;
}

function findSnapshotAtOrBefore(snapshots, boundary, includeBoundary) {
  let match = null;

  for (const snapshot of snapshots) {
    const inRange = includeBoundary ? snapshot.snapshotAt <= boundary : snapshot.snapshotAt < boundary;
    if (inRange) {
      match = snapshot;
    } else {
      break;
    }
  }

  return match;
}

function findSnapshotAtOrAfter(snapshots, boundary, includeBoundary, maxDaysAfter = 0) {
  const maxTime = boundary.getTime() + maxDaysAfter * 24 * 60 * 60 * 1000;

  for (const snapshot of snapshots) {
    const timestamp = snapshot.snapshotAt.getTime();
    const inRange = includeBoundary ? timestamp >= boundary.getTime() : timestamp > boundary.getTime();
    if (inRange && timestamp <= maxTime) {
      return snapshot;
    }
  }

  return null;
}

function addSnapshotDelta(totals, startSnapshot, endSnapshot) {
  for (const key of ["reach", "engagements", "reactions", "comments", "shares", "linkClicks", "videoViews"]) {
    const startValue = startSnapshot ? startSnapshot[key] : 0;
    totals[key] += Math.max(0, endSnapshot[key] - startValue);
  }
}

function summarizePostsForWeek(posts, endDate, boundaryMode = "exclude-boundaries") {
  const normalizedBoundaryMode = normalizeBoundaryMode(boundaryMode);
  const start = startOfDay(new Date(endDate));
  start.setDate(start.getDate() - 7);
  const end = endOfDay(endDate);
  const includeStart = normalizedBoundaryMode === "include-boundaries" || normalizedBoundaryMode === "exclude-end";
  const includeEnd = normalizedBoundaryMode === "include-boundaries" || normalizedBoundaryMode === "exclude-start";
  const startBoundary = includeStart ? start : endOfDay(start);
  const endBoundary = includeEnd ? end : startOfDay(endDate);

  const inWindow = posts.filter((post) => {
    const postDate = parsePostDate(post.Date);
    if (!postDate) return false;
    const afterStart = includeStart ? postDate >= startBoundary : postDate > startBoundary;
    const beforeEnd = includeEnd ? postDate <= endBoundary : postDate < endBoundary;
    return afterStart && beforeEnd;
  });

  const totals = inWindow.reduce((summary, post) => {
    summary.reach += toNumber(post["Total Reach"]);
    summary.engagements += toNumber(post["Total Engagements"]);
    summary.reactions += toNumber(post.Reactions);
    summary.comments += toNumber(post.Comments);
    summary.shares += toNumber(post.Shares);
    summary.linkClicks += toNumber(post["Link Clicks"]);
    summary.videoViews += toNumber(post["Video Views (3s)"]);
    return summary;
  }, {
    reach: 0,
    engagements: 0,
    reactions: 0,
    comments: 0,
    shares: 0,
    linkClicks: 0,
    videoViews: 0
  });

  totals.engagementRate = totals.reach ? totals.engagements / totals.reach : 0;
  return totals;
}

function normalizeBoundaryMode(value) {
  const normalized = String(value || "exclude-boundaries").toLowerCase().trim();
  return [
    "include-boundaries",
    "exclude-start",
    "exclude-end",
    "exclude-boundaries"
  ].includes(normalized)
    ? normalized
    : "exclude-boundaries";
}

function buildContentPerformanceFormula(postLevelSheetName) {
  const source = quoteSheetNameForFormula(postLevelSheetName);
  const dateSerial = `IFERROR(DATEVALUE(${source}!E2:E),0)`;
  const filteredRows = `FILTER({${source}!I2:I,${source}!L2:L,${source}!M2:M,${source}!AA2:AA,${source}!P2:P,${source}!O2:O},LEN(${source}!I2:I),IF($B$2="",LEN(${source}!I2:I),${dateSerial}>=$B$2),IF($B$3="",LEN(${source}!I2:I),${dateSerial}<=$B$3))`;
  const query = `"select Col1, count(Col1), avg(Col2), avg(Col3), avg(Col4), sum(Col5), sum(Col6) group by Col1 label Col1 'Content Type', count(Col1) '# of Posts', avg(Col2) 'Avg Reach', avg(Col3) 'Avg Engagements', avg(Col4) 'Avg Engagement Rate', sum(Col5) 'Total Shares', sum(Col6) 'Total Comments'"`;
  const emptyTable = `{"Content Type","# of Posts","Avg Reach","Avg Engagements","Avg Engagement Rate","Total Shares","Total Comments";"No matching rows","","","","","",""}`;
  return `=IFNA(QUERY(${filteredRows},${query},0),${emptyTable})`;
}

function buildAdBoostFormula(postLevelSheetName) {
  const source = quoteSheetNameForFormula(postLevelSheetName);
  const headers = `{${AD_BOOST_HEADER_ROW.map((header) => `"${escapeFormulaString(header)}"`).join(",")}}`;
  const blankRow = `{${AD_BOOST_HEADER_ROW.map((header, index) => `"${index === 0 ? "No boosted/ad rows yet" : ""}"`).join(",")}}`;
  const blankColumn = `IF(LEN(${source}!B2:B),"","")`;
  const dateSerial = `IFERROR(DATEVALUE(LEFT(${source}!C2:C,10)),0)`;
  const dateFilters = `IF($B$2="",LEN(${source}!C2:C),${dateSerial}>=$B$2),IF($B$3="",LEN(${source}!C2:C),${dateSerial}<=$B$3)`;

  return `=VSTACK(${headers},IFNA(FILTER(HSTACK(${source}!C2:C,${source}!D2:D,IF(${source}!R2:R="Yes","Boosted","Ad"),${blankColumn},${source}!S2:S,${source}!F2:F,${source}!G2:G,IFERROR(${source}!S2:S/${source}!G2:G,),${source}!U2:U,IFERROR(${source}!S2:S/${source}!U2:U,),${source}!T2:T,${source}!B2:B,${source}!N2:N),((${source}!R2:R="Yes")+(${source}!S2:S>0))>0,${dateFilters}),${blankRow}))`;
}

function buildContentPerformanceRows(posts) {
  const grouped = new Map();

  for (const post of posts) {
    const contentType = post["Content Type"] || "Other";
    const current = grouped.get(contentType) || {
      contentType,
      posts: 0,
      reach: 0,
      engagements: 0,
      engagementRate: 0,
      shares: 0,
      comments: 0
    };

    current.posts += 1;
    current.reach += toNumber(post["Total Reach"]);
    current.engagements += toNumber(post["Total Engagements"]);
    current.engagementRate += toNumber(post["Engagement Rate"]);
    current.shares += toNumber(post.Shares);
    current.comments += toNumber(post.Comments);
    grouped.set(contentType, current);
  }

  return Array.from(grouped.values())
    .sort((left, right) => right.engagements - left.engagements)
    .map((item) => [
      item.contentType,
      item.posts,
      item.posts ? item.reach / item.posts : 0,
      item.posts ? item.engagements / item.posts : 0,
      item.posts ? item.engagementRate / item.posts : 0,
      item.shares,
      item.comments
    ]);
}

function buildAdBoostRows(posts) {
  return posts
    .filter((post) => isBoostedPost(post) || toNumber(post["Ad Spend ($)"]) > 0)
    .sort((left, right) => String(right.Date).localeCompare(String(left.Date)))
    .map((post) => {
      const amountSpent = toNumber(post["Ad Spend ($)"]);
      const engagements = toNumber(post["Total Engagements"]);
      const leads = toNumber(post["Ad Leads"]);

      return [
        post.Date || "",
        post["Post Message/Text"] || "",
        isBoostedPost(post) ? "Boosted" : "Ad",
        "",
        amountSpent,
        toNumber(post["Total Reach"]),
        engagements,
        amountSpent && engagements ? amountSpent / engagements : "",
        leads || "",
        amountSpent && leads ? amountSpent / leads : "",
        post.Notes || "",
        post["Post ID"] || "",
        post.Permalink || ""
      ];
    });
}

function isBoostedPost(post) {
  return String(post["Boosted?"] || "").toLowerCase() === "yes";
}

function addOptionalMetricUpdate(updates, sheetName, rowNumber, headerRow, label, value) {
  const columnIndex = findColumnIndex(headerRow, label, -1);
  if (columnIndex !== -1) {
    updates.push(cellUpdate(sheetName, rowNumber, columnIndex, value));
    return true;
  }
  return false;
}

function cellUpdate(sheetName, rowNumber, zeroBasedColumn, value) {
  const columnLetter = columnToLetter(zeroBasedColumn + 1);
  return {
    range: `${quoteSheetName(sheetName)}!${columnLetter}${rowNumber}`,
    values: [[value]]
  };
}

function parseDashboardDate(value, year) {
  try {
    return parseDateInput(value, year);
  } catch {
    return null;
  }
}

function parsePostDate(value) {
  if (!value) return null;
  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed;
  }

  try {
    return parseDateInput(value);
  } catch {
    return null;
  }
}

function sanitizeDateControl(value, fallbackYear) {
  if (!value) return "";

  try {
    const parsed = parseDateInput(value, fallbackYear);
    const year = parsed.getFullYear();
    if (year < 2000 || year > 2100) {
      return "";
    }
    return value;
  } catch {
    return "";
  }
}

function findColumnIndex(row, label, fallback) {
  const normalizedLabel = normalizeLabel(label);
  const index = row.findIndex((cell) => normalizeLabel(cell).includes(normalizedLabel));
  return index === -1 ? fallback : index;
}

function isKnownColumnLabel(value) {
  const normalized = normalizeLabel(value);
  return [
    "weekly goal",
    "weekly actual",
    "act track",
    "goal track",
    "notes",
    "total comments",
    "total shares",
    "total video views",
    "total clicks"
  ].some((label) => normalized.includes(label));
}

function normalizeLabel(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function toNumber(value) {
  if (typeof value === "number") return value;
  const parsed = Number(String(value || "").replace(/[$,%\s,]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function quoteSheetName(name) {
  return `'${String(name).replace(/'/g, "''")}'`;
}

function quoteSheetNameForFormula(name) {
  return `'${String(name).replace(/'/g, "''")}'`;
}

function escapeFormulaString(value) {
  return String(value).replace(/"/g, '""');
}

function columnToLetter(columnNumber) {
  let temp = columnNumber;
  let letter = "";
  while (temp > 0) {
    const remainder = (temp - 1) % 26;
    letter = String.fromCharCode(65 + remainder) + letter;
    temp = Math.floor((temp - remainder) / 26);
  }
  return letter;
}

function gridRange(sheetId, startColumnIndex, endColumnIndex, startRowIndex, endRowIndex) {
  return {
    sheetId,
    startRowIndex,
    endRowIndex,
    startColumnIndex,
    endColumnIndex
  };
}

function formatColumnRequest(sheetId, columnIndex, type, pattern, startRowIndex = 1, endRowIndex = 1000) {
  return formatRangeRequest(sheetId, columnIndex, columnIndex + 1, startRowIndex, endRowIndex, type, pattern);
}

function formatRangeRequest(sheetId, startColumnIndex, endColumnIndex, startRowIndex, endRowIndex, type, pattern) {
  return {
    repeatCell: {
      range: gridRange(sheetId, startColumnIndex, endColumnIndex, startRowIndex, endRowIndex),
      cell: {
        userEnteredFormat: {
          numberFormat: {
            type,
            pattern
          }
        }
      },
      fields: "userEnteredFormat.numberFormat"
    }
  };
}

function arraysEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

module.exports = {
  GoogleSheetsClient,
  HEADER_ROW,
  CONTENT_PERFORMANCE_HEADER_ROW,
  AD_BOOST_HEADER_ROW,
  METRIC_SNAPSHOT_HEADER_ROW,
  IMPORTED_CONTENT_HEADER_ROW,
  buildWeeklySectionUpdates,
  buildContentPerformanceFormula,
  buildAdBoostFormula,
  buildContentPerformanceRows,
  buildAdBoostRows,
  postToRow,
  quoteSheetName,
  summarizePostsForWeek,
  summarizeSnapshotsForWeek,
  summarizeImportedForWeek
};
