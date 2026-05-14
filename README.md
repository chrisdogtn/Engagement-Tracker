# Engagement Tracker

A modular Node.js reporting bridge that imports weekly Meta Business Suite CSV exports, categorizes posts, calculates business metrics, and refreshes Google Sheets dashboards from one clean reporting dataset.

## What It Does

- Runs an Express server with a browser upload page at `GET /import-meta-export`.
- Imports weekly Meta Business Suite **Lifetime** content exports into `Imported Content Metrics`.
- Writes one row per imported week into `Weekly Metrics Summary`.
- Uses optional API supplements only for data the CSV cannot provide, such as weekly follower activity and ad spend/leads mapping.
- Uses app-level content rules from `config/content-rules.default.json` or `CONTENT_RULES_FILE`.
- Applies filters to source/reporting tabs so you can filter by week, content type, boosted status, and metrics directly.
- Updates weekly rollup tabs such as `Q2 Socials`, `Q3 Socials`, and `Q4 Socials`.
- Maintains downstream analytics tabs with live formulas and optional start/end date controls.
- Calculates:
  - `Total Engagements = Reactions + Comments + Shares`
  - `Engagement Rate = Total Engagements / Reach`
  - `Estimated Lead Value = Link Clicks * 0.04 * 79`
- Leaves the old Meta post API sync available only if you explicitly set `ENABLE_API_SYNC=true`.

## Project Structure

```text
src/
  cli/import-meta-export.js    # Manual Meta Business Suite CSV import
  cli/sync-now.js              # Optional legacy API sync
  logic/contentParser.js       # Auto-tagging and calculations
  services/googleSheets.js     # Google Sheets API append handler
  services/metaExportImporter.js # Meta Business Suite CSV parser
  services/metaApi.js          # Optional Meta Graph API supplement fetcher
  utils/dateRange.js           # Date range parsing
  config.js                    # Environment loading and validation
  index.js                     # App entrypoint
  server.js                    # Express webhook and cron scheduler
  syncService.js               # End-to-end orchestration
docs/
  apps-script-sync-now.gs      # Google Sheets menu/button script
config/
  content-rules.default.json   # App-level content type keyword rules
```

## Setup

1. Install Node.js 20 or newer.
2. Install dependencies:

```bash
npm install
```

3. Fill in these required `.env` values:

```bash
META_PAGE_ID=your-facebook-page-id
META_PAGE_ACCESS_TOKEN=your-long-lived-page-access-token
GOOGLE_SPREADSHEET_ID=your-google-sheet-id
GOOGLE_APPLICATION_CREDENTIALS=./service-account.json
WEBHOOK_SECRET=replace-with-a-long-random-secret
IMPORT_META_EXPORT_REQUIRE_SECRET=false
ENABLE_API_SYNC=false
ENABLE_CRON=false
WEEKLY_SUMMARY_SHEET_NAME=Weekly Metrics Summary
```

4. Share the Google Sheet with the service account email from your JSON key file. Give it Editor access.

The app creates/updates `Imported Content Metrics`, `Weekly Metrics Summary`, `Content Performance Breakdown`, and `Ad + Boost Tracking` as needed. Existing `Q1 Socials` / `Q2 Socials` / `Q3 Socials` / `Q4 Socials` dashboard tabs are preserved and updated in place.

## Run It

Start the server:

```bash
npm start
```

Open the upload page:

```text
http://localhost:3000/import-meta-export
```

Import a Meta Business Suite Lifetime content export:

```bash
node src/cli/import-meta-export.js --file="C:\Users\Chris\Downloads\May-04-2026_May-10-2026_1299243185022610.csv"
```

Legacy API sync webhook test:

```bash
curl -X POST http://localhost:3000/sync-socials \
  -H "Content-Type: application/json" \
  -H "x-sync-secret: replace-with-the-same-secret-from-env" \
  -d "{\"startDate\":\"2026-04-05\",\"endDate\":\"2026-04-12\",\"updateWeeklyRollups\":true}"
```

The importer usually infers `weekStart` and `weekEnd` from Meta's exported file name. If needed, pass them explicitly:

```bash
node src/cli/import-meta-export.js --file="C:\path\to\export.csv" --weekStart=5/4/2026 --weekEnd=5/10/2026
```

Legacy API sync is off by default. To restore it, set `ENABLE_API_SYNC=true`; to restore scheduled syncs, also set `ENABLE_CRON=true`.

Run one legacy API sync from the terminal:

```bash
npm run sync
```

Refresh dashboard/rollup tabs without pulling Meta:

```bash
curl -X POST http://localhost:3000/refresh-dashboard \
  -H "Content-Type: application/json" \
  -H "x-sync-secret: replace-with-the-same-secret-from-env" \
  -d "{\"source\":\"manual-test\"}"
```

Open the upload page for drag-and-drop/manual import:

```text
https://your-public-url/import-meta-export
```

Upload the Meta Business Suite **Lifetime** CSV. The page imports the file, updates `Imported Content Metrics`, updates `Weekly Metrics Summary`, and refreshes the dashboard tabs.

By default, the import page is public and does not require the webhook secret. Set `IMPORT_META_EXPORT_REQUIRE_SECRET=true` if you want the upload form to require `WEBHOOK_SECRET`.

## Meta Graph API Token Setup

You need a Page access token for the Facebook Page you own or manage.

1. Go to [Meta for Developers](https://developers.facebook.com/apps/) and create or select an app.
2. Add Facebook Login or use Graph API Explorer for a one-owner/admin setup.
3. Generate a User access token for a Facebook account that has admin access to the Page.
4. Request these permissions:
   - `pages_show_list`
   - `pages_read_engagement`
   - `read_insights`
5. Exchange the short-lived User token for a long-lived User token:

```text
https://graph.facebook.com/v24.0/oauth/access_token
  ?grant_type=fb_exchange_token
  &client_id={APP_ID}
  &client_secret={APP_SECRET}
  &fb_exchange_token={SHORT_LIVED_USER_TOKEN}
```

6. Get the Page token from the long-lived User token:

```text
https://graph.facebook.com/v24.0/{USER_ID}/accounts
  ?access_token={LONG_LIVED_USER_TOKEN}
```

7. Copy the `access_token` for your Page into `.env` as `META_PAGE_ACCESS_TOKEN`.
8. Copy the Page `id` into `.env` as `META_PAGE_ID`.
9. Confirm the token works with:

```text
https://graph.facebook.com/v24.0/{PAGE_ID}/posts
  ?fields=id,message,created_time
  &access_token={PAGE_ACCESS_TOKEN}
```

Notes:

- The default `.env` value should use `META_GRAPH_VERSION=v24.0`. If your Meta app is pinned to another version, update that value.
- If the app is used only by people with roles on the app/Page, App Review may not be needed for local/admin usage. For production or broader users, submit the permissions for Meta App Review.
- `read_insights` is needed for post insight metrics such as reach and click breakdowns.

### Easier Persistent Page Token Helper

Meta still requires a human login/consent step. The helper can now perform that login locally, exchange the returned OAuth code immediately, save `META_LONG_LIVED_USER_TOKEN`, and then save the Page token into the existing `.env`.

Add these to `.env`:

```bash
META_APP_ID=your-meta-app-id
META_APP_SECRET=your-meta-app-secret
```

Then run:

```bash
npm run token:page
```

The command opens Facebook Login in your browser. If Meta rejects the callback, add this exact URL in the Meta app under Facebook Login > Settings > Valid OAuth Redirect URIs:

```text
http://localhost:3456/auth/meta/callback
```

Or pass values directly:

```bash
npm run token:page -- --shortToken=PASTE_TOKEN --pageId=YOUR_PAGE_ID
```

Force a fresh browser login even if `.env` already has a long-lived token:

```bash
npm run token:page -- --forceLogin=true
```

The helper will:

1. Open Facebook Login and request Page/insights permissions, unless a usable token already exists.
2. Exchange the OAuth code for a short-lived User token.
3. Exchange that token for a long-lived User token.
4. Search `/me/accounts`, Business Portfolio `owned_pages`, and Business Portfolio `client_pages`.
5. Write `META_LONG_LIVED_USER_TOKEN`, `META_PAGE_ID`, and `META_PAGE_ACCESS_TOKEN` into your existing `.env`.

Important: this is not a true refresh-token system. Meta does not issue a standard permanent refresh token for this flow. Page tokens often show no fixed expiration, but Meta can still invalidate them if the user changes password, loses Page access, removes the app, changes Business asset permissions, or Meta requires reauthorization.

## Google Cloud Service Account Setup

1. Go to [Google Cloud Console](https://console.cloud.google.com/).
2. Create or select a project.
3. Enable the Google Sheets API.
4. Go to IAM & Admin > Service Accounts.
5. Create a service account.
6. Open the service account, go to Keys, and create a JSON key.
7. Save the downloaded JSON as `service-account.json` in this project folder or somewhere secure.
8. Set `.env`:

```bash
GOOGLE_APPLICATION_CREDENTIALS=./service-account.json
GOOGLE_SPREADSHEET_ID=your-google-sheet-id
GOOGLE_SHEET_TAB_NAME=Post-Level Tracking
```

9. Open your Google Sheet and share it with the service account email, usually:

```text
service-account-name@project-id.iam.gserviceaccount.com
```

Give it Editor access.

## Google Sheets Refresh Script

Paste the contents of `docs/apps-script-sync-now.gs` into Extensions > Apps Script in your Google Sheet.

Update these constants:

```js
const ENGAGEMENT_TRACKER_WEBHOOK_URL = 'https://YOUR_HOST_OR_NGROK_URL/sync-socials';
const ENGAGEMENT_TRACKER_WEBHOOK_SECRET = 'replace-with-the-same-secret-from-env';
```

Reload the spreadsheet. The most important menu items for the manual workflow are `Refresh Dashboard` and `Install Date Auto-Refresh`. `Sync Now` is legacy and only works if `ENABLE_API_SYNC=true`.

For Q1/Q2/Q3/Q4 dashboard auto-refresh:

1. Paste the latest `docs/apps-script-sync-now.gs`.
2. Reload the sheet.
3. Choose `Engagement Tracker > Install Date Auto-Refresh`.
4. Approve permissions.

After that, entering a date in column `A` on `Q1 Socials`, `Q2 Socials`, `Q3 Socials`, or `Q4 Socials` calls `/refresh-dashboard` and fills the matching weekly sections from `Weekly Metrics Summary` / `Imported Content Metrics`.

## Filtering Reports by Week or Date Range

`Imported Content Metrics` is the post-level source of truth for the manual workflow. It has one row per post per imported week, plus native filter controls for week, content type, boosted status, reach, engagements, clicks, and video metrics.

`Weekly Metrics Summary` is the week-level source of truth for dashboard rollups. It has one row per imported week and stores totals for reach, engagements, reactions, comments, shares, views, clicks, optional ad data, and optional follower fields.

The generated analytics tabs also include editable date controls:

- `Content Performance Breakdown`
- `Ad + Boost Tracking`

On either tab:

1. Put a date in `B2` for `Start Date`.
2. Put a date in `B3` for `End Date`.
3. Leave either date blank to make that side of the range open-ended.
4. Leave both dates blank to show all available rows.

The table below the controls recalculates automatically from imported weekly metrics. For a specific week, enter the Monday/Sunday range you want to analyze, such as `5/4/2026` through `5/10/2026`.

The Q1/Q2/Q3/Q4 Socials tabs still work as week-ending dashboards. A row date like `5/10` represents the week ending on `5/10`.

When `Weekly Metrics Summary` has a row for a week-ending date, the Q-sheet weekly rollups use that summary row first. If no summary row exists but imported post rows exist, the app summarizes `Imported Content Metrics`. Legacy snapshot/Post-Level fallback exists only for old API-sync workflows.

### Weekly Meta Export Workflow

Every Monday:

1. In Meta Business Suite, export Content data for the prior Monday-Sunday reporting week.
2. Choose **Lifetime** export, not Daily.
3. Turn on the columns for Views, Reach, Reactions, Comments, Shares, Total Clicks, organic/boosted breakdowns, and video metrics.
4. Upload the CSV at `/import-meta-export`, or run the CLI import command.
5. Confirm `Imported Content Metrics` has one row per post for that week and `Weekly Metrics Summary` has one row for that week.

The imported weekly rows become the locked reporting source for that week. Re-importing the same week updates the existing rows instead of creating duplicates.

The edited date cell gets a note with the refresh status. If no note appears, the Apps Script edit trigger did not run.

## Desktop Executable Packaging

This project includes `pkg` scripts for lightweight standalone executables.

Build for Windows:

```bash
npm run package:win
```

Run the executable from the project folder so it can read `.env` and `service-account.json`:

```bash
dist\engagement-tracker.exe
```

Important desktop notes:

- Keep `.env` next to where you launch the executable, or launch it from this project folder.
- Keep `service-account.json` outside source control.
- For Google Sheets to call a local desktop app, your local server must be reachable from Apps Script. Use a tunnel such as ngrok or Cloudflare Tunnel and put that public URL in the Apps Script webhook constant.

## Source Tables

Manual imports write post-level rows to `Imported Content Metrics`:

```text
Imported At, Source File, Import ID, Week Start, Week End, Post ID,
Publish Time, Post Title / Description, Content Type, Format, Views,
Reach, Total Engagements, Reactions, Comments, Shares, Total Clicks,
3-second Video Views, 1-minute Video Views, Seconds Viewed,
Avg Seconds Viewed, Organic Views, Boosted Views, Organic Reach,
Boosted Reach, Boosted?, Engagement Rate, Estimated Lead Value,
Permalink, Ad Spend ($), Ad Leads, Paid Reach, Paid Clicks, Paid Ad IDs
```

Manual imports also write week-level rows to `Weekly Metrics Summary`:

```text
Imported At, Source File, Import ID, Week Start, Week End,
Followers Start, Followers End, Follower Growth, Posts, Reach,
Engagements, Reactions, Comments, Shares, Views, Clicks,
Video Views (3s), Engagement Rate, Ad Spend ($), Ad Leads,
Paid Reach, Paid Clicks, Follower Source, Notes
```

## Content Type Rules

Content rules are app-level only. The workbook is not used as the rules editor.

Edit [config/content-rules.default.json](</D:/Lumberjacks Marketing/Engagement Tracker/config/content-rules.default.json>) or point `.env` to another JSON file:

```bash
CONTENT_RULES_FILE=./config/content-rules.default.json
```

Rule format:

```text
Content Type        Keywords
Storm / Emergency  storm, emergency, fallen
Before & After     before, after, transformation
Educational        learn, did you know, sign
Crew               crew, team, climber, groundsman
Promo              free estimate, special, discount, call today
```

The `Content Type` values in `Imported Content Metrics` are assigned from those app-level rules during CSV import.

## Downstream Analytics Tabs

The app maintains two additional formula-driven tabs from `Imported Content Metrics`:

```text
Content Performance Breakdown
Ad + Boost Tracking
```

These are not static app-generated summaries. The app writes formulas into the tabs, and the formulas spill/update from `Imported Content Metrics`.

`Content Performance Breakdown` uses a `QUERY()` formula to create a pivot-style summary by content type:

```text
Content Type, # of Posts, Avg Reach, Avg Engagements,
Avg Engagement Rate, Total Shares, Total Comments
```

`Ad + Boost Tracking` uses `FILTER()`/`HSTACK()`/`VSTACK()` formulas to show imported post-level rows marked `Boosted? = Yes` or rows with `Ad Spend ($)` greater than zero:

```text
Date, Post Title, Type, Objective, Amount Spent, Reach,
Engagements, Cost per Engagement, Leads, Cost per Lead, Notes,
Post ID, Permalink
```

Important: the CSV can identify boosted organic content when the boosted columns are exported, but it does not always include ad spend or leads. If Marketing API settings are not configured or Meta cannot map an ad creative back to a post, `Ad Spend ($)` and `Ad Leads` stay blank and can be filled in `Imported Content Metrics` or `Weekly Metrics Summary`.

Optional automatic ad spend requires the Meta Marketing API:

```bash
META_FETCH_ADS=true
META_AD_ACCOUNT_ID=act_your-ad-account-id
META_AD_ACCESS_TOKEN=token-with-ads-read
```

The token must have access to that ad account and include `ads_read`. The app pulls ad-level insights for the exact uploaded week and maps ads back to posts through the ad creative story ID. If Meta cannot provide a story ID that matches the imported post IDs, that ad cannot be matched automatically.

To rename the generated tabs, set these in `.env`:

```bash
CONTENT_PERFORMANCE_SHEET_NAME=Content Performance Breakdown
AD_BOOST_SHEET_NAME=Ad + Boost Tracking
UPDATE_ANALYTICS_TABS=true
```

## Weekly Rollups

By default the app auto-detects tabs named like:

```text
Q1 Socials
Q2 Socials
Q3 Socials
Q4 Socials
```

You can force a list in `.env`:

```bash
WEEKLY_ROLLUP_SHEETS=Q2 Socials,Q3 Socials,Q4 Socials
```

For the section-style layout in your screenshot, the app scans column `A` for dates and uses the nearest section title above each date.

Supported automatic sections:

- `Facebook Followers` / any section title containing `Follower`: fills `Weekly Actual` from `Weekly Metrics Summary > Follower Growth` when that value exists.
- `Total Reach`: fills `Weekly Actual`.
- `Total Engagements`: fills `Weekly Actual`, plus `Total Reactions`, `Total Comments`, `Total Shares`, `Total Video Views`, and `Total Clicks` when those headers exist in the section row.
- `Engagement Rate`: fills `Weekly Actual` as total engagements divided by total reach for that week.

The week window uses the date in column `A` as the week end date. By default, Sunday boundary dates are excluded, so `4/12` summarizes posts after `4/5` and before `4/12`, which means Monday through Saturday for a Sunday-ended week.

You can change the boundary behavior in `.env`:

```bash
# include-boundaries, exclude-start, exclude-end, or exclude-boundaries
WEEKLY_ROLLUP_BOUNDARY_MODE=exclude-boundaries
```

Legacy API sync can still store snapshot deltas if you re-enable it:

```bash
WEEKLY_ROLLUP_SOURCE=snapshots
METRIC_SNAPSHOT_SHEET_NAME=Post Metric Snapshots
```

The manual CSV workflow does not need snapshots. The uploaded weekly export is treated as the reporting source for that week.

Set the year used for `M/D` dashboard dates:

```bash
DASHBOARD_YEAR=2026
```

The manual CSV export does not include follower activity. During each import, the app calls Page Insights for the same weekly date range using `page_daily_follows_unique`, `page_daily_unfollows_unique`, and `page_follows`. `Follower Growth` is filled from the summed daily unique follows; `Followers Start` and `Followers End` are calculated from the follower count snapshot and unfollows when available.

## Useful Commands

```bash
npm run check
npm run sync
npm start
```
