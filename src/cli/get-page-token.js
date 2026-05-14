#!/usr/bin/env node

const fs = require("fs");
const http = require("http");
const crypto = require("crypto");
const path = require("path");
const { execFile } = require("child_process");
const { getConfig } = require("../config");

const GRAPH_BASE_URL = "https://graph.facebook.com";
const DEFAULT_OAUTH_PORT = 3456;
const DEFAULT_SCOPES = [
  "pages_show_list",
  "pages_read_engagement",
  "read_insights",
  "pages_manage_metadata",
  "business_management",
  "ads_read"
];

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
  const savedLongToken = args.longToken || process.env.META_LONG_LIVED_USER_TOKEN;
  const pageId = args.pageId || config.meta.pageId;

  if (!appId || !appSecret) {
    throw new Error(
      "Missing META_APP_ID or META_APP_SECRET. You can also pass --appId and --appSecret."
    );
  }

  const graphVersion = config.meta.graphVersion;
  let tokenResult = await getLongLivedUserToken({
    args,
    graphVersion,
    appId,
    appSecret,
    shortToken,
    savedLongToken
  });
  let longLivedUserToken = tokenResult.token;

  let { pages, pagesWithoutTokens, warnings } = await fetchManagedPages({
    graphVersion,
    longLivedUserToken
  });

  if (
    tokenResult.source === "saved" &&
    warnings.some(isExpiredTokenError) &&
    args.forceLogin !== "false"
  ) {
    console.log("The saved long-lived user token is no longer valid. Starting a fresh Facebook Login flow.");
    tokenResult = await runLocalOAuthLogin({
      args,
      graphVersion,
      appId,
      appSecret
    });
    longLivedUserToken = tokenResult.token;
    ({ pages, pagesWithoutTokens, warnings } = await fetchManagedPages({
      graphVersion,
      longLivedUserToken
    }));
  }

  const page = pageId
    ? pages.find((candidate) => String(candidate.id) === String(pageId))
    : pages[0];

  if (!page) {
    const available = pages.map(formatPageForMessage).join(", ");
    const unavailable = pagesWithoutTokens.map(formatPageForMessage).join(", ");
    const warningText = warnings.length ? ` Warnings: ${warnings.join(" | ")}` : "";
    const unavailableText = unavailable
      ? ` Pages found without usable page tokens: ${unavailable}.`
      : "";
    throw new Error(
      `Could not find page ${pageId || ""} with a usable Page access token. Available token pages: ${
        available || "none"
      }.${unavailableText}${warningText}`
    );
  }

  updateEnvFile({
    META_LONG_LIVED_USER_TOKEN: longLivedUserToken,
    META_PAGE_ID: page.id,
    META_PAGE_ACCESS_TOKEN: page.access_token
  });

  console.log(`Updated .env with Page token for "${page.name}" (${page.id}).`);
  console.log("The app will use META_PAGE_ACCESS_TOKEN for page metrics.");
  console.log("Check it in Meta Access Token Debugger. Page tokens often show no fixed expiration, but Meta can still invalidate them after password, permission, app, or Business asset changes.");
}

async function getLongLivedUserToken({ args, graphVersion, appId, appSecret, shortToken, savedLongToken }) {
  if (savedLongToken && args.forceLogin !== "true") {
    console.log("Using existing META_LONG_LIVED_USER_TOKEN from .env. Pass --forceLogin=true to reauthorize.");
    return {
      token: savedLongToken,
      source: "saved"
    };
  }

  if (shortToken) {
    try {
      console.log("Exchanging META_SHORT_LIVED_USER_TOKEN for a long-lived user token...");
      return {
        token: await exchangeForLongLivedUserToken({
          graphVersion,
          appId,
          appSecret,
          shortToken
        }),
        source: "short-token"
      };
    } catch (error) {
      if (!isExpiredTokenError(error)) {
        throw error;
      }
      console.log("The saved short-lived user token is expired. Starting the local Facebook Login flow instead.");
    }
  }

  return runLocalOAuthLogin({
    args,
    graphVersion,
    appId,
    appSecret
  });
}

async function runLocalOAuthLogin({ args, graphVersion, appId, appSecret }) {
  const port = Number(args.port || process.env.META_OAUTH_PORT || DEFAULT_OAUTH_PORT);
  const redirectUri =
    args.redirectUri ||
    process.env.META_OAUTH_REDIRECT_URI ||
    `http://localhost:${port}/auth/meta/callback`;
  const scopes = getScopes(args);
  const state = crypto.randomBytes(24).toString("hex");

  const serverResult = waitForOAuthCallback({ port, redirectUri, state });
  const authUrl = buildFacebookLoginUrl({
    graphVersion,
    appId,
    redirectUri,
    scopes,
    state
  });

  console.log("");
  console.log("Opening Facebook Login to create a fresh token.");
  console.log(`If Meta blocks the redirect, add this exact URI to Facebook Login > Settings > Valid OAuth Redirect URIs: ${redirectUri}`);
  console.log(`Requested permissions: ${scopes.join(", ")}`);
  console.log("");
  console.log(authUrl);
  console.log("");

  openUrl(authUrl);

  const code = await serverResult;
  const shortLivedToken = await exchangeCodeForShortLivedUserToken({
    graphVersion,
    appId,
    appSecret,
    redirectUri,
    code
  });

  return {
    token: await exchangeForLongLivedUserToken({
      graphVersion,
      appId,
      appSecret,
      shortToken: shortLivedToken
    }),
    source: "oauth"
  };
}

function waitForOAuthCallback({ port, redirectUri, state }) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((request, response) => {
      try {
        const requestUrl = new URL(request.url, redirectUri);

        if (requestUrl.pathname !== new URL(redirectUri).pathname) {
          response.writeHead(404, { "Content-Type": "text/plain" });
          response.end("Not found.");
          return;
        }

        const error = requestUrl.searchParams.get("error_description") || requestUrl.searchParams.get("error");
        if (error) {
          response.writeHead(400, { "Content-Type": "text/plain" });
          response.end(`Facebook Login failed: ${error}`);
          closeServer(server);
          reject(new Error(`Facebook Login failed: ${error}`));
          return;
        }

        if (requestUrl.searchParams.get("state") !== state) {
          response.writeHead(400, { "Content-Type": "text/plain" });
          response.end("State mismatch. Close this tab and run the token command again.");
          closeServer(server);
          reject(new Error("Facebook Login state mismatch."));
          return;
        }

        const code = requestUrl.searchParams.get("code");
        if (!code) {
          response.writeHead(400, { "Content-Type": "text/plain" });
          response.end("Missing authorization code.");
          closeServer(server);
          reject(new Error("Facebook Login did not return an authorization code."));
          return;
        }

        response.writeHead(200, { "Content-Type": "text/html" });
        response.end("<h1>Token received</h1><p>You can close this browser tab and return to the terminal.</p>");
        closeServer(server);
        resolve(code);
      } catch (error) {
        closeServer(server);
        reject(error);
      }
    });

    server.on("error", reject);
    server.listen(port, "localhost");
  });
}

function buildFacebookLoginUrl({ graphVersion, appId, redirectUri, scopes, state }) {
  const url = new URL(`https://www.facebook.com/${graphVersion}/dialog/oauth`);
  url.searchParams.set("client_id", appId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("scope", scopes.join(","));
  url.searchParams.set("response_type", "code");
  return url.toString();
}

async function exchangeCodeForShortLivedUserToken({ graphVersion, appId, appSecret, redirectUri, code }) {
  const url = new URL(`${GRAPH_BASE_URL}/${graphVersion}/oauth/access_token`);
  url.searchParams.set("client_id", appId);
  url.searchParams.set("client_secret", appSecret);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("code", code);

  const response = await fetchJson(url);
  if (!response.access_token) {
    throw new Error("Meta did not return a short-lived User token from the OAuth code.");
  }

  return response.access_token;
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
  const warnings = [];
  const allPages = [];

  try {
    allPages.push(
      ...(await fetchUserPages({
        graphVersion,
        longLivedUserToken
      }))
    );
  } catch (error) {
    warnings.push(`/me/accounts failed: ${error.message}`);
  }

  try {
    const businessLookup = await fetchBusinessPages({
      graphVersion,
      longLivedUserToken
    });
    allPages.push(...businessLookup.pages);
    warnings.push(...businessLookup.warnings);
  } catch (error) {
    warnings.push(`Business Portfolio page lookup failed: ${error.message}`);
  }

  const uniquePages = dedupePages(allPages);

  return {
    pages: uniquePages.filter((page) => page.access_token),
    pagesWithoutTokens: uniquePages.filter((page) => !page.access_token),
    warnings
  };
}

async function fetchUserPages({ graphVersion, longLivedUserToken }) {
  const url = buildGraphUrl({
    graphVersion,
    path: "/me/accounts",
    accessToken: longLivedUserToken,
    params: {
      fields: "id,name,access_token",
      limit: "100"
    }
  });

  const pages = await fetchPaginated(url);
  return pages.map((page) => ({ ...page, source: "/me/accounts" }));
}

async function fetchBusinessPages({ graphVersion, longLivedUserToken }) {
  const businessesUrl = buildGraphUrl({
    graphVersion,
    path: "/me/businesses",
    accessToken: longLivedUserToken,
    params: {
      fields: "id,name",
      limit: "100"
    }
  });

  const businesses = await fetchPaginated(businessesUrl);
  const pages = [];
  const warnings = [];

  for (const business of businesses) {
    for (const edge of ["owned_pages", "client_pages"]) {
      try {
        pages.push(
          ...(await fetchBusinessPageEdge({
            graphVersion,
            longLivedUserToken,
            business,
            edge
          }))
        );
      } catch (error) {
        warnings.push(`${business.name || business.id}/${edge}: ${error.message}`);
      }
    }
  }

  return { pages, warnings };
}

async function fetchBusinessPageEdge({ graphVersion, longLivedUserToken, business, edge }) {
  const url = buildGraphUrl({
    graphVersion,
    path: `/${business.id}/${edge}`,
    accessToken: longLivedUserToken,
    params: {
      fields: "id,name,access_token",
      limit: "100"
    }
  });

  const pages = await fetchPaginated(url);
  return pages.map((page) => ({
    ...page,
    source: `${business.name || business.id}/${edge}`
  }));
}

async function fetchPaginated(initialUrl) {
  const rows = [];
  let nextUrl = initialUrl;

  while (nextUrl) {
    const response = await fetchJson(nextUrl);
    rows.push(...(response.data || []));
    nextUrl = response.paging && response.paging.next ? response.paging.next : "";
  }

  return rows;
}

function buildGraphUrl({ graphVersion, path: graphPath, accessToken, params = {} }) {
  const url = new URL(`${GRAPH_BASE_URL}/${graphVersion}${graphPath}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  url.searchParams.set("access_token", accessToken);
  return url.toString();
}

function dedupePages(pages) {
  const byId = new Map();

  for (const page of pages) {
    const existing = byId.get(String(page.id));
    if (!existing || (!existing.access_token && page.access_token)) {
      byId.set(String(page.id), page);
    }
  }

  return Array.from(byId.values());
}

function formatPageForMessage(page) {
  return `${page.name} (${page.id}${page.source ? ` from ${page.source}` : ""})`;
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

function getScopes(args) {
  const raw = args.scopes || process.env.META_LOGIN_SCOPES;
  if (!raw) return DEFAULT_SCOPES;
  return raw
    .split(",")
    .map((scope) => scope.trim())
    .filter(Boolean);
}

function openUrl(url) {
  if (process.env.CI || process.env.NO_BROWSER) return;

  const platform = process.platform;
  if (platform === "win32") {
    execFile("powershell.exe", ["-NoProfile", "-Command", "Start-Process", url], { windowsHide: true });
    return;
  }
  if (platform === "darwin") {
    execFile("open", [url]);
    return;
  }
  execFile("xdg-open", [url]);
}

function closeServer(server) {
  server.close(() => {});
}

function isExpiredTokenError(error) {
  const value = typeof error === "string" ? error : error.message || "";
  return /session has expired|error validating access token|invalid oauth access token/i.test(value);
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
