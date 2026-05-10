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

  async fetchPostInsights(postId) {
    const url = this.buildUrl(`/${postId}/insights`, {
      metric: INSIGHT_METRICS,
      period: "lifetime"
    });

    const response = await this.getJson(url);
    return response.data || [];
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
