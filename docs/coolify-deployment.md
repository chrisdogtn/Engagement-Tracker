# Coolify Local Test Deployment

This app is ready to deploy in Coolify either as a normal Node.js Git app or as a Dockerfile app.

For your setup, use the normal Git/Nixpacks Node.js deployment. Docker is optional and not required.

## 1. Choose How Coolify Will Read This Project

Recommended options:

- Push this folder to a private GitHub/Git repository and connect it in Coolify.
- Or use Coolify's private Git/source upload flow if your install supports it.

The project includes:

```text
/src
/config/content-rules.default.json
nixpacks.toml
Dockerfile              optional only
.dockerignore           optional only
```

Secrets are intentionally excluded from the image. Do not upload `.env` or `service-account.json` into Git.

## 2. Create The Coolify Application Without Docker

In Coolify:

1. Go to your project.
2. Add New Resource.
3. Choose Application.
4. Select your Git repository/source.
5. Choose the Node/Nixpacks build pack if Coolify asks.
6. Use these commands:

```text
Install command: npm ci --omit=dev
Start command: npm start
```

7. Use port:

```text
3000
```

8. Set healthcheck path:

```text
/health
```

The included `nixpacks.toml` tells Coolify/Nixpacks the same thing:

```text
install: npm ci --omit=dev
start: npm start
PORT: 3000
```

## Optional Dockerfile Deployment

Only use this if you later decide you want a Dockerfile deployment.

1. Go to your project.
2. Add New Resource.
3. Choose Application.
4. Select your Git repository/source.
5. Set build pack/type to Dockerfile if Coolify does not auto-detect it.
6. Use port:

```text
3000
```

7. Set healthcheck path:

```text
/health
```

Coolify exposes Dockerfile apps by routing traffic to the container port. Ports must be exposed/routed for Docker/Coolify to know where traffic goes.

## 3. Environment Variables

Paste these into Coolify's Environment Variables screen. Use your real values from local `.env`.

```bash
PORT=3000
NODE_ENV=production
WEBHOOK_SECRET=your-long-random-secret

META_GRAPH_VERSION=v24.0
META_PAGE_ID=your-page-id
META_PAGE_ACCESS_TOKEN=your-page-token
# Optional. Only used when a sync request explicitly sends lookbackDays.
LOOKBACK_DAYS=14

# Optional, for automatic paid/boosted ad spend mapping.
META_FETCH_ADS=false
META_AD_ACCOUNT_ID=act_your-ad-account-id
META_AD_ACCESS_TOKEN=token-with-ads-read

GOOGLE_SPREADSHEET_ID=your-google-sheet-id
GOOGLE_SHEET_TAB_NAME=Post-Level Tracking

CONTENT_RULES_FILE=./config/content-rules.default.json
UPDATE_WEEKLY_ROLLUPS=true
WEEKLY_ROLLUP_SHEET_PATTERN=^Q[1-4] Socials$
WEEKLY_ROLLUP_BOUNDARY_MODE=exclude-boundaries
DASHBOARD_YEAR=2026
UPDATE_ANALYTICS_TABS=true
CONTENT_PERFORMANCE_SHEET_NAME=Content Performance Breakdown
AD_BOOST_SHEET_NAME=Ad + Boost Tracking
```

For Google credentials, prefer environment-only credentials in Coolify.

Option A, easiest: paste the entire service account JSON as one variable. This is usually the least fussy path in Coolify:

```bash
GOOGLE_SERVICE_ACCOUNT_JSON={"type":"service_account","project_id":"...","private_key":"-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n","client_email":"..."}
```

Option B, most reliable when the UI mangles quotes/newlines: base64 encode the entire JSON file and paste that:

```bash
GOOGLE_SERVICE_ACCOUNT_JSON_BASE64=base64-encoded-service-account-json
```

On Windows PowerShell:

```powershell
[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((Get-Content .\service-account.json -Raw)))
```

Option C: split the JSON into email and private key:

```bash
GOOGLE_CLIENT_EMAIL=your-service-account@project-id.iam.gserviceaccount.com
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
```

Keep the literal `\n` line breaks in the private key. The app converts them at runtime.

Important: if you use Option A, B, or C, do not set `GOOGLE_APPLICATION_CREDENTIALS` in Coolify. If it is already set to `/app/service-account.json`, remove that variable or leave it blank.

Alternative: mount `service-account.json` into the runtime and set:

```bash
GOOGLE_APPLICATION_CREDENTIALS=/app/service-account.json
```

The env-only options are simpler for Coolify testing.

## 4. Deploy And Test

After deployment, open the Coolify-generated domain or your configured domain:

```text
https://your-public-url/health
```

Expected response:

```json
{"ok":true,"service":"engagement-tracker","time":"..."}
```

Test the sync webhook:

```bash
curl -X POST https://your-public-url/sync-socials \
  -H "Content-Type: application/json" \
  -H "x-sync-secret: your-long-random-secret" \
  -d "{\"lookbackDays\":7,\"updateWeeklyRollups\":true}"
```

Test the dashboard-only refresh webhook:

```bash
curl -X POST https://your-public-url/refresh-dashboard \
  -H "Content-Type: application/json" \
  -H "x-sync-secret: your-long-random-secret" \
  -d "{\"source\":\"manual-test\"}"
```

## 5. Public URL Options For A Local Coolify Install

Google Apps Script must reach your app from Google's servers, so `localhost` and private LAN IPs will not work.

You need one of these:

### Option A: Coolify Public Domain

If your Coolify machine has a public IP:

1. Point a DNS record such as `engagement.yourdomain.com` to the Coolify server.
2. Add that domain to the app in Coolify.
3. Let Coolify/Traefik issue HTTPS.
4. Use:

```js
const ENGAGEMENT_TRACKER_WEBHOOK_URL = "https://engagement.yourdomain.com/sync-socials";
```

### Option B: Cloudflare Tunnel

If Coolify is on your local machine or home network, Cloudflare Tunnel is usually easier than router port forwarding.

In Cloudflare Zero Trust:

1. Create a Tunnel.
2. Install/run the connector on the same machine/network as Coolify.
3. Add a public hostname, for example:

```text
engagement.yourdomain.com
```

4. Point the service to the Coolify app's internal/local URL.

Depending on your Coolify routing, the service target is commonly one of:

```text
http://localhost:3000
http://127.0.0.1:3000
http://<coolify-app-generated-hostname>
```

Use the one that returns `/health` from the Coolify host.

### Option C: Temporary ngrok Test

For quick testing:

```bash
ngrok http 3000
```

Then use the generated HTTPS URL in Apps Script. This is fine for a temporary test but not ideal for a stable workflow unless you have a reserved ngrok domain.

## 6. Google Apps Script URL

Update:

```js
const ENGAGEMENT_TRACKER_WEBHOOK_URL = "https://your-public-url/sync-socials";
const ENGAGEMENT_TRACKER_WEBHOOK_SECRET = "same-value-as-WEBHOOK_SECRET";
```

Then run `Sync Now`.

To make Q1/Q2/Q3/Q4 date edits refresh automatically:

1. Paste the latest `docs/apps-script-sync-now.gs` into Apps Script.
2. Reload the spreadsheet.
3. Run `Engagement Tracker > Install Date Auto-Refresh` once.
4. Accept the Apps Script authorization prompt.

After that, editing a non-empty date in column `A` on a tab named `Q1 Socials`, `Q2 Socials`, `Q3 Socials`, or `Q4 Socials` calls `/refresh-dashboard`.

The edited date cell receives a note with the HTTP status and server response. If you type a date and see no note, the Apps Script edit trigger did not run. Re-run `Engagement Tracker > Install Date Auto-Refresh`.

## 7. Optional Meta Ads Spend Setup

`ads_read` permission alone is not enough. The app also needs:

```bash
META_FETCH_ADS=true
META_AD_ACCOUNT_ID=act_your-ad-account-id
META_AD_ACCESS_TOKEN=token-with-ads-read
```

Notes:

- `META_AD_ACCOUNT_ID` must be the ad account that paid for the boosts/ads.
- `META_AD_ACCESS_TOKEN` should be a User/System User token with ad account access and `ads_read`.
- A Page access token usually is not enough for ad account insights.
- The app pulls ad-level insights from the Marketing API and tries to map ads back to Page posts through the ad creative story ID.
- Some ads cannot be mapped back to an organic Page post. Those will not update the post row automatically.
