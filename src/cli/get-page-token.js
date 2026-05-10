#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { getConfig } = require("../config");

const GRAPH_BASE_URL = "https://graph.facebook.com";

main().catch((error) => {
  console.error("Page token setup failed:", error.message);
  process.exitCode = 1;
});

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = getConfig({ requireSecrets: false });
  const appId = args.appId || process.env.META_APP_ID;
  const appSecret = args.appSecret || process.env.META_APP_SECRET;
  const shortToken = args.shortToken || process.env.META_SHORT_LIVED_USER_TOKEN;
  const pageId = args.pageId || config.meta.pageId;

  if (!appId || !appSecret || !shortToken) {
    throw new Error(
      "Missing META_APP_ID, META_APP_SECRET, or META_SHORT_LIVED_USER_TOKEN. You can also pass --appId, --appSecret, and --shortToken."
    );
  }

  const longLivedUserToken = await exchangeForLongLivedUserToken({
    graphVersion: config.meta.graphVersion,
    appId,
    appSecret,
    shortToken
  });

  const pages = await fetchManagedPages({
    graphVersion: config.meta.graphVersion,
    longLivedUserToken
  });

  const page = pageId
    ? pages.find((candidate) => String(candidate.id) === String(pageId))
    : pages[0];

  if (!page) {
    const available = pages.map((candidate) => `${candidate.name} (${candidate.id})`).join(", ");
    throw new Error(`Could not find page ${pageId || ""}. Available pages: ${available || "none"}`);
  }

  updateEnvFile({
    META_PAGE_ID: page.id,
    META_PAGE_ACCESS_TOKEN: page.access_token
  });

  console.log(`Updated .env with Page token for "${page.name}" (${page.id}).`);
  console.log("Check it in Meta Access Token Debugger. It should show type Page and a long/no-expiration value.");
}

async function exchangeForLongLivedUserToken({ graphVersion, appId, appSecret, shortToken }) {
  const url = new URL(`${GRAPH_BASE_URL}/${graphVersion}/oauth/access_token`);
  url.searchParams.set("grant_type", "fb_exchange_token");
  url.searchParams.set("client_id", appId);
  url.searchParams.set("client_secret", appSecret);
  url.searchParams.set("fb_exchange_token", shortToken);

  const response = await fetchJson(url);
  if (!response.access_token) {
    throw new Error("Meta did not return a long-lived User token.");
  }

  return response.access_token;
}

async function fetchManagedPages({ graphVersion, longLivedUserToken }) {
  const pages = [];
  let nextUrl = `${GRAPH_BASE_URL}/${graphVersion}/me/accounts?fields=id,name,access_token&limit=100&access_token=${encodeURIComponent(longLivedUserToken)}`;

  while (nextUrl) {
    const response = await fetchJson(nextUrl);
    pages.push(...(response.data || []));
    nextUrl = response.paging && response.paging.next ? response.paging.next : "";
  }

  return pages.filter((page) => page.access_token);
}

async function fetchJson(url) {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json"
    }
  });
  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message = body.error && body.error.message ? body.error.message : response.statusText;
    throw new Error(`Meta Graph API error ${response.status}: ${message}`);
  }

  return body;
}

function updateEnvFile(updates) {
  const envPath = path.resolve(process.cwd(), ".env");
  const current = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
  let next = current;

  for (const [key, value] of Object.entries(updates)) {
    const line = `${key}=${value}`;
    const pattern = new RegExp(`^${escapeRegExp(key)}=.*$`, "m");
    if (pattern.test(next)) {
      next = next.replace(pattern, line);
    } else {
      next += `${next.endsWith("\n") || !next ? "" : "\n"}${line}\n`;
    }
  }

  fs.writeFileSync(envPath, next);
}

function parseArgs(args) {
  const options = {};
  for (const arg of args) {
    const [rawKey, ...rest] = arg.replace(/^--/, "").split("=");
    const value = rest.join("=");
    if (rawKey && value) {
      options[rawKey] = value;
    }
  }
  return options;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
