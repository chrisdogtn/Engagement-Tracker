const META_BASE_URL = "https://graph.facebook.com";

const POST_FIELDS = [
  "id",
  "created_time",
  "message",
  "permalink_url",
  "shares",
  "comments.limit(0).summary(true)",
  "reactions.limit(0).summary(true)"
].join(",");

const INSIGHT_METRICS = [
  "post_impressions_unique",
  "post_clicks_by_type",
  "post_video_views"
].join(",");

class MetaApiClient {
  constructor({ graphVersion, pageId, pageAccessToken, fetchImpl = fetch }) {
    this.graphVersion = graphVersion;
    this.pageId = pageId;
    this.pageAccessToken = pageAccessToken;
    this.fetchImpl = fetchImpl;
  }

  async fetchRecentPosts({ startDate, endDate }) {
    const posts = [];
    let nextUrl = this.buildUrl(`/${this.pageId}/posts`, {
      fields: POST_FIELDS,
      since: Math.floor(startDate.getTime() / 1000),
      until: Math.floor(endDate.getTime() / 1000),
      limit: 100
    });

    while (nextUrl) {
      const page = await this.getJson(nextUrl);
      posts.push(...(page.data || []));
      nextUrl = page.paging && page.paging.next ? page.paging.next : "";
    }

    const hydrated = [];
    for (const post of posts) {
      const insights = await this.fetchPostInsights(post.id);
      hydrated.push(normalizePost(post, insights));
    }

    return hydrated;
  }

  async fetchPostById(postId) {
    const post = await this.getJson(this.buildUrl(`/${postId}`, {
      fields: POST_FIELDS
    }));
    const insights = await this.fetchPostInsights(post.id);
    return normalizePost(post, insights);
  }

  async fetchPostsByIds(postIds) {
    const posts = [];

    for (const postId of postIds) {
      try {
        posts.push(await this.fetchPostById(postId));
      } catch (error) {
        console.warn(`[meta] Could not refresh known post ${postId}: ${error.message}`);
      }
    }

    return posts;
  }

  async fetchPostInsights(postId) {
    const url = this.buildUrl(`/${postId}/insights`, {
      metric: INSIGHT_METRICS,
      period: "lifetime"
    });

    const response = await this.getJson(url);
    return response.data || [];
  }

  async fetchWeeklyFollowerMetrics({ startDate, endDate }) {
    const summary = await this.fetchPageSummary().catch((error) => ({
      error: error.message
    }));
    const insight = await this.fetchFollowerSnapshotInsight({ startDate, endDate }).catch((error) => ({
      error: error.message
    }));
    const followersEnd = firstNumber(insight.followersEnd, summary.followers_count, summary.fan_count);
    const followersStart = firstNumber(insight.followersStart);

    return {
      configured: Boolean(this.pageId && this.pageAccessToken),
      metric: insight.metric || "",
      followerGrowth: "",
      followersStart,
      followersEnd,
      pageName: summary.name || "",
      source: insight.metric
        ? `Meta Page Insights: ${insight.metric} count snapshot; weekly follower growth not filled`
        : summary.error || insight.error || "Meta follower metric unavailable",
      error: insight.error || summary.error || ""
    };
  }

  async fetchPageSummary() {
    const fieldSets = [
      "id,name,followers_count,fan_count",
      "id,name,fan_count",
      "id,name"
    ];

    let lastError = null;
    for (const fields of fieldSets) {
      try {
        return await this.getJson(this.buildUrl(`/${this.pageId}`, { fields }));
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError;
  }

  async fetchFollowerSnapshotInsight({ startDate, endDate }) {
    const metric = "page_follows";
    const url = this.buildUrl(`/${this.pageId}/insights`, {
      metric,
      period: "day",
      since: formatDate(startDate),
      until: formatDate(endDate)
    });
    const response = await this.getJson(url);
    const item = response.data && response.data[0] ? response.data[0] : null;
    const values = item && Array.isArray(item.values) ? item.values : [];
    if (!values.length) {
      return { metric, followersStart: "", followersEnd: "" };
    }

    return {
      metric,
      followersStart: numericInsightValue(values[0].value),
      followersEnd: numericInsightValue(values[values.length - 1].value)
    };
  }

  buildUrl(path, params = {}) {
    const url = new URL(`${META_BASE_URL}/${this.graphVersion}${path}`);
    url.searchParams.set("access_token", this.pageAccessToken);

    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }

    return url.toString();
  }

  async getJson(url) {
    const response = await this.fetchImpl(url, {
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
}

function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function normalizePost(post, insights) {
  const insightMap = buildInsightMap(insights);

  return {
    id: post.id,
    createdTime: post.created_time || "",
    message: post.message || "",
    permalinkUrl: post.permalink_url || "",
    reactions: nestedSummaryCount(post.reactions),
    comments: nestedSummaryCount(post.comments),
    shares: post.shares && post.shares.count ? Number(post.shares.count) : 0,
    reach: numericInsightValue(insightMap.post_impressions_unique),
    linkClicks: linkClickCount(insightMap.post_clicks_by_type),
    videoViews: numericInsightValue(insightMap.post_video_views)
  };
}

function buildInsightMap(insights) {
  const map = {};

  for (const item of insights || []) {
    const firstValue = Array.isArray(item.values) && item.values.length ? item.values[0].value : 0;
    map[item.name] = firstValue;
  }

  return map;
}

function nestedSummaryCount(edge) {
  if (!edge || !edge.summary) return 0;
  return Number(edge.summary.total_count || 0);
}

function numericInsightValue(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function firstNumber(...values) {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return "";
}

function linkClickCount(value) {
  if (!value || typeof value !== "object") {
    return numericInsightValue(value);
  }

  const candidates = [
    "link clicks",
    "link_clicks",
    "link click",
    "other clicks"
  ];

  for (const key of candidates) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      return numericInsightValue(value[key]);
    }
  }

  return Object.entries(value).reduce((total, [key, itemValue]) => {
    return key.toLowerCase().includes("link") ? total + numericInsightValue(itemValue) : total;
  }, 0);
}

module.exports = {
  MetaApiClient,
  normalizePost,
  linkClickCount
};
