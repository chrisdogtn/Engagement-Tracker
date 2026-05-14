# Engagement Tracker

A modular Node.js automation bridge that pulls Facebook Page post metrics from the Meta Graph API, categorizes each post, calculates business metrics, and appends clean rows into a Google Sheet tab named `Post-Level Tracking`.

## What It Does

- Runs an Express server with `POST /sync-socials` for on-demand syncs from Google Sheets.
- Runs a weekly cron sync every Monday at 2:00 AM.
- Pulls recent Facebook Page posts for the last `LOOKBACK_DAYS`, defaulting to 14 days, or a specific requested date range.
- Fetches post reach and click insights from Meta.
- Upserts rows by `Post ID`, so repeated syncs update existing posts instead of duplicating them.
- Uses app-level content rules from `config/content-rules.default.json` or `CONTENT_RULES_FILE`.
- Applies a dropdown to the Post-Level `Content Type` column.
- Updates weekly rollup tabs such as `Q2 Socials`, `Q3 Socials`, and `Q4 Socials`.
- Maintains downstream analytics tabs with live formulas that reference `Post-Level Tracking`.
- Calculates:
  - `Total Engagements = Reactions + Comments + Shares`
  - `Engagement Rate = Total Engagements / Reach`
  - `Estimated Lead Value = Link Clicks * 0.04 * 79`
- Appends processed rows to Google Sheets.

## Project Structure

```text
src/
  cli/sync-now.js              # Manual command-line sync
  logic/contentParser.js       # Auto-tagging and calculations
  services/googleSheets.js     # Google Sheets API append handler
  services/metaApi.js          # Meta Graph API post/insight fetcher
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
```

4. In your Google Sheet, create a tab named:

```text
Post-Level Tracking
```

5. Share the Google Sheet with the service account email from your JSON key file. Give it Editor access.

## Run It

Start the server and weekly cron:

```bash
npm start
```

Run one sync from the terminal:

```bash
npm run sync
```

Run one sync for a specific range:

```bash
npm run sync -- --start=2026-04-05 --end=2026-04-12
```

Test the webhook locally:

```bash
curl -X POST http://localhost:3000/sync-socials \
  -H "Content-Type: application/json" \
  -H "x-sync-secret: replace-with-the-same-secret-from-env" \
  -d "{\"source\":\"manual-test\"}"
```

Test the webhook with a specific range:

```bash
curl -X POST http://localhost:3000/sync-socials \
  -H "Content-Type: application/json" \
  -H "x-sync-secret: replace-with-the-same-secret-from-env" \
  -d "{\"startDate\":\"2026-04-05\",\"endDate\":\"2026-04-12\",\"updateWeeklyRollups\":true}"
```

If no range is supplied, the app uses `LOOKBACK_DAYS`.

Refresh dashboard/rollup tabs without pulling Meta:

```bash
curl -X POST http://localhost:3000/refresh-dashboard \
  -H "Content-Type: application/json" \
  -H "x-sync-secret: replace-with-the-same-secret-from-env" \
  -d "{\"source\":\"manual-test\"}"
```

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

## Google Sheets "Sync Now" Script

Paste the contents of `docs/apps-script-sync-now.gs` into Extensions > Apps Script in your Google Sheet.

Update these constants:

```js
const ENGAGEMENT_TRACKER_WEBHOOK_URL = 'https://YOUR_HOST_OR_NGROK_URL/sync-socials';
const ENGAGEMENT_TRACKER_WEBHOOK_SECRET = 'replace-with-the-same-secret-from-env';
```

Reload the spreadsheet. You will see a new `Engagement Tracker > Sync Now` menu item.

When you click it, the script asks whether you want a specific date range. If you choose no, the app uses `LOOKBACK_DAYS`.

For a button-style experience, insert a Drawing or Image in the sheet, label it `Sync Now`, click the three-dot menu on the image/drawing, choose Assign script, and enter:

```text
syncSocialsNow
```

For Q1/Q2/Q3/Q4 dashboard auto-refresh:

1. Paste the latest `docs/apps-script-sync-now.gs`.
2. Reload the sheet.
3. Choose `Engagement Tracker > Install Date Auto-Refresh`.
4. Approve permissions.

After that, entering a date in column `A` on `Q1 Socials`, `Q2 Socials`, `Q3 Socials`, or `Q4 Socials` calls `/refresh-dashboard` and fills the matching weekly sections from `Post-Level Tracking`.

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

## Output Columns

The app writes these columns to `Post-Level Tracking`:

```text
Synced At, Post ID, Date, Post Message/Text, Content Type, Total Reach,
Total Engagements, Reactions, Comments, Shares, Link Clicks,
Engagement Rate, Estimated Lead Value, Permalink, Format, Video Views (3s),
Avg Watch Time, Boosted?, Ad Spend ($), Notes
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

The `Content Type` dropdown on `Post-Level Tracking` is rebuilt from those app-level rules during sync.

## Downstream Analytics Tabs

The app maintains two additional tabs from the main `Post-Level Tracking` sheet:

```text
Content Performance Breakdown
Ad + Boost Tracking
```

These are not static app-generated summaries. The app writes formulas into the tabs, and the formulas spill/update from `Post-Level Tracking`.

`Content Performance Breakdown` uses a `QUERY()` formula to create a pivot-style summary by content type:

```text
Content Type, # of Posts, Avg Reach, Avg Engagements,
Avg Engagement Rate, Total Shares, Total Comments
```

`Ad + Boost Tracking` uses `FILTER()`/`HSTACK()`/`VSTACK()` formulas to show post-level rows marked `Boosted? = Yes` or rows with `Ad Spend ($)` greater than zero:

```text
Date, Post Title, Type, Objective, Amount Spent, Reach,
Engagements, Cost per Engagement, Leads, Cost per Lead, Notes,
Post ID, Permalink
```

Important: the basic Page/post API does not supply ad spend or boosted-post status. If Marketing API settings are not configured, those two fields must be filled manually on `Post-Level Tracking`. Once you mark `Boosted?` or enter `Ad Spend ($)`, the `Ad + Boost Tracking` formula tab updates automatically.

Optional automatic ad spend requires the Meta Marketing API:

```bash
META_FETCH_ADS=true
META_AD_ACCOUNT_ID=act_your-ad-account-id
META_AD_ACCESS_TOKEN=token-with-ads-read
```

The token must have access to that ad account and include `ads_read`. The app pulls ad-level insights and maps ads back to posts through the ad creative story ID. If Meta cannot provide a story ID for an ad, that ad cannot be matched to a row in `Post-Level Tracking` automatically.

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

- `Total Reach`: fills `Weekly Actual`.
- `Total Engagements`: fills `Weekly Actual`, plus `Total Comments`, `Total Shares`, `Total Video Views`, and `Total Clicks` when those headers exist in the section row.
- `Engagement Rate`: fills `Weekly Actual` as total engagements divided by total reach for that week.

The week window uses the date in column `A` as the week end date. Example: `4/12` summarizes posts from `4/5` through `4/12`.

Set the year used for `M/D` dashboard dates:

```bash
DASHBOARD_YEAR=2026
```

Follower sections are intentionally left alone for now because the current app is only pulling post-level data. They can be added later with Page-level follower insights.

## Useful Commands

```bash
npm run check
npm run sync
npm start
```
