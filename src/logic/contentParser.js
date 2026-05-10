const DEFAULT_CONTENT_RULES = [
  {
    contentType: "Storm / Emergency",
    keywords: ["storm", "emergency", "fallen"]
  },
  {
    contentType: "Before & After",
    keywords: ["before", "after", "transformation"]
  },
  {
    contentType: "Educational",
    keywords: ["learn", "did you know", "sign"]
  }
];

function categorizeContent(message = "", rules = DEFAULT_CONTENT_RULES) {
  const normalized = String(message).toLowerCase();

  for (const rule of normalizeRules(rules)) {
    if (rule.keywords.some((keyword) => normalized.includes(keyword))) {
      return rule.contentType;
    }
  }

  return "Other";
}

function calculateEngagementRate(totalEngagements, reach) {
  if (!reach) return 0;
  return totalEngagements / reach;
}

function calculateEstimatedLeadValue(linkClicks) {
  return linkClicks * 0.04 * 79;
}

function processPost(post, rules = DEFAULT_CONTENT_RULES) {
  const reach = asNumber(post.reach);
  const reactions = asNumber(post.reactions);
  const comments = asNumber(post.comments);
  const shares = asNumber(post.shares);
  const linkClicks = asNumber(post.linkClicks);
  const videoViews = asNumber(post.videoViews);
  const totalEngagements = reactions + comments + shares;

  return {
    postId: post.id,
    date: post.createdTime,
    message: post.message || "",
    permalinkUrl: post.permalinkUrl || "",
    contentType: categorizeContent(post.message || "", rules),
    format: post.format || "Unknown",
    reach,
    reactions,
    comments,
    shares,
    linkClicks,
    videoViews,
    avgWatchTime: asNumber(post.avgWatchTime),
    totalEngagements,
    engagementRate: calculateEngagementRate(totalEngagements, reach),
    estimatedLeadValue: calculateEstimatedLeadValue(linkClicks),
    boosted: post.boosted || "No",
    adSpend: asNumber(post.adSpend)
  };
}

function asNumber(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeRules(rules = DEFAULT_CONTENT_RULES) {
  return rules
    .map((rule) => ({
      contentType: String(rule.contentType || "").trim(),
      keywords: Array.isArray(rule.keywords)
        ? rule.keywords.map((keyword) => String(keyword).trim().toLowerCase()).filter(Boolean)
        : String(rule.keywords || "")
          .split(",")
          .map((keyword) => keyword.trim().toLowerCase())
          .filter(Boolean)
    }))
    .filter((rule) => rule.contentType && rule.keywords.length);
}

module.exports = {
  DEFAULT_CONTENT_RULES,
  categorizeContent,
  calculateEngagementRate,
  calculateEstimatedLeadValue,
  normalizeRules,
  processPost
};
