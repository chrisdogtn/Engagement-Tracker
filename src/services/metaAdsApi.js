const META_BASE_URL = "https://graph.facebook.com";

const AD_INSIGHT_FIELDS = [
  "ad_id",
  "ad_name",
  "spend",
  "reach",
  "clicks",
  "actions",
  "date_start",
  "date_stop"
].join(",");

class MetaAdsApiClient {
  constructor({ graphVersion, adAccountId, adAccessToken, pageAccessToken, fetchImpl = fetch }) {
    this.graphVersion = graphVersion;
    this.adAccountId = adAccountId;
    this.accessToken = adAccessToken || pageAccessToken;
    this.fetchImpl = fetchImpl;
  }

  isConfigured() {
    return Boolean(this.adAccountId && this.accessToken);
  }

  async fetchAdSpendByPost({ startDate, endDate }) {
    if (!this.isConfigured()) {
      return {
        configured: false,
        adRows: 0,
        mappedPosts: 0,
        spendByPostId: new Map()
      };
    }

    const insights = await this.fetchAdInsights({ startDate, endDate });
    const spendByPostId = new Map();

    for (const insight of insights) {
      const creative = await this.fetchAdCreative(insight.ad_id);
      const postIds = extractPostIdsFromCreative(creative);
      const spend = toNumber(insight.spend);
      const leads = leadActionCount(insight.actions);

      for (const postId of postIds) {
        const existing = spendByPostId.get(postId) || {
          adSpend: 0,
          paidReach: 0,
          paidClicks: 0,
          adLeads: 0,
          adIds: []
        };

        existing.adSpend += spend;
        existing.paidReach += toNumber(insight.reach);
        existing.paidClicks += toNumber(insight.clicks);
        existing.adLeads += leads;
        existing.adIds.push(insight.ad_id);
        spendByPostId.set(postId, existing);
      }
    }

    return {
      configured: true,
      adRows: insights.length,
      mappedPosts: spendByPostId.size,
      spendByPostId
    };
  }

  async fetchAdInsights({ startDate, endDate }) {
    const timeRange = {
      since: formatDate(startDate),
      until: formatDate(endDate)
    };
    const insights = [];
    let nextUrl = this.buildUrl(`/${this.adAccountId}/insights`, {
      fields: AD_INSIGHT_FIELDS,
      level: "ad",
      limit: 100,
      time_range: JSON.stringify(timeRange)
    });

    while (nextUrl) {
      const page = await this.getJson(nextUrl);
      insights.push(...(page.data || []));
      nextUrl = page.paging && page.paging.next ? page.paging.next : "";
    }

    return insights;
  }

  async fetchAdCreative(adId) {
    const url = this.buildUrl(`/${adId}`, {
      fields: "creative{effective_object_story_id,object_story_id}"
    });
    const response = await this.getJson(url);
    return response.creative || {};
  }

  buildUrl(path, params = {}) {
    const url = new URL(`${META_BASE_URL}/${this.graphVersion}${path}`);
    url.searchParams.set("access_token", this.accessToken);

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
      throw new Error(`Meta Marketing API error ${response.status}: ${message}`);
    }

    return body;
  }
}

function applyAdSpendToPosts(posts, spendByPostId) {
  if (!spendByPostId || !spendByPostId.size) {
    return posts;
  }

  return posts.map((post) => {
    const paid = spendByPostId.get(post.id);
    if (!paid) return post;

    return {
      ...post,
      boosted: "Yes",
      adSpend: paid.adSpend,
      paidReach: paid.paidReach,
      paidClicks: paid.paidClicks,
      adLeads: paid.adLeads,
      adIds: paid.adIds
    };
  });
}

function extractPostIdsFromCreative(creative) {
  return [
    creative.effective_object_story_id,
    creative.object_story_id
  ].filter(Boolean);
}

function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function toNumber(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function leadActionCount(actions) {
  if (!Array.isArray(actions)) return 0;

  return actions.reduce((total, action) => {
    const type = String(action.action_type || "").toLowerCase();
    return isLeadAction(type) ? total + toNumber(action.value) : total;
  }, 0);
}

function isLeadAction(actionType) {
  return [
    "lead",
    "onsite_conversion.lead_grouped",
    "onsite_conversion.messaging_conversation_started_7d",
    "offsite_conversion.fb_pixel_lead",
    "offsite_conversion.lead",
    "leadgen_grouped"
  ].some((candidate) => actionType === candidate || actionType.endsWith(`.${candidate}`));
}

module.exports = {
  MetaAdsApiClient,
  applyAdSpendToPosts,
  extractPostIdsFromCreative,
  leadActionCount
};
