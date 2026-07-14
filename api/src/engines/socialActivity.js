// socialActivity.js
// Pure computation helpers for the Social Activity Monitor (v3.14). No network
// calls happen in this file - it only turns normalized post lists into the
// metrics, status thresholds, and customer-safe wording used by
// GET /hotels/:id/social and POST /hotels/:id/social/sync.

const DAY_MS = 24 * 60 * 60 * 1000;

function daysBetween(fromDate, toDate) {
return Math.floor((toDate.getTime() - fromDate.getTime()) / DAY_MS);
}

function round1(value) {
return Math.round(value * 10) / 10;
}

// posts: [{ id, date: Date, likeCount, commentCount, shareCount, url, mediaType, captionPreview }]
// Returns the metrics block used for both social_activity_snapshots rows and the
// customer-safe API response.
export function computeActivityMetrics(posts, now = new Date()) {
const withDates = (posts || []).filter((p) => p && p.date instanceof Date && !isNaN(p.date));
const sorted = [...withDates].sort((a, b) => b.date - a.date);

const last30 = sorted.filter((p) => daysBetween(p.date, now) <= 30);
const last14 = sorted.filter((p) => daysBetween(p.date, now) <= 14);
const last7 = sorted.filter((p) => daysBetween(p.date, now) <= 7);

const likes30 = last30.reduce((sum, p) => sum + (p.likeCount || 0), 0);
const comments30 = last30.reduce((sum, p) => sum + (p.commentCount || 0), 0);
const lastPost = sorted[0] || null;

let bestPost = null;
for (const p of last30) {
if (!bestPost || (p.likeCount || 0) > (bestPost.likeCount || 0)) bestPost = p;
}

return {
posts_last_7_days: last7.length,
posts_last_14_days: last14.length,
posts_last_30_days: last30.length,
likes_last_30_days: likes30,
comments_last_30_days: comments30,
avg_likes_per_post_30_days: last30.length ? round1(likes30 / last30.length) : 0,
avg_comments_per_post_30_days: last30.length ? round1(comments30 / last30.length) : 0,
last_post_date: lastPost ? lastPost.date.toISOString() : null,
days_since_last_post: lastPost ? daysBetween(lastPost.date, now) : null,
best_post_url: bestPost ? bestPost.url || null : null,
best_post_likes: bestPost ? bestPost.likeCount || 0 : null
};
}

// Thresholds exactly as specified for v3.14.
export function instagramStatus(metrics) {
if (metrics.days_since_last_post === null || metrics.days_since_last_post === undefined) return 'critical';
if (metrics.days_since_last_post >= 30) return 'critical';
if (metrics.days_since_last_post >= 14 || metrics.posts_last_30_days < 2) return 'warning';
if (metrics.posts_last_14_days >= 2 || metrics.posts_last_30_days >= 4) return 'ok';
return 'warning';
}

export function facebookStatus(metrics) {
if (metrics.days_since_last_post === null || metrics.days_since_last_post === undefined) return 'critical';
if (metrics.days_since_last_post >= 45) return 'critical';
if (metrics.days_since_last_post >= 21) return 'warning';
if (metrics.posts_last_14_days >= 1 || metrics.posts_last_30_days >= 2) return 'ok';
return 'warning';
}

// Customer-safe recommended_action text. Never mentions OAuth/token/Graph API/scopes/permissions.
export function recommendedAction(provider, status) {
if (status === 'ok') return null;
if (provider === 'instagram') {
if (status === 'critical') return 'Instagram has had no recent activity - ask the social partner to publish new content urgently.';
if (status === 'access_needed' || status === 'permission_needed') return 'Connect Instagram to start monitoring activity.';
return 'Publish fresh Instagram content this week.';
}
if (provider === 'facebook') {
if (status === 'critical') return 'The Facebook Page has been inactive for a long time - urgent social partner follow-up needed.';
if (status === 'access_needed' || status === 'permission_needed') return 'Connect Facebook to start monitoring activity.';
return 'Ask the social partner to schedule a new Facebook post soon.';
}
return 'Social partner follow-up needed.';
}

// Builds one customer-safe alert entry, or null if no alert is warranted.
export function alertForProvider(provider, status) {
if (!status || status === 'ok') return null;
const label = provider === 'instagram' ? 'Instagram' : 'Facebook';
let title;
let message;
if (status === 'critical') {
title = `${label} posting has stopped`;
message = `No ${label} post was published recently.`;
} else if (status === 'warning') {
title = `${label} posting frequency is low`;
message = provider === 'instagram'
? 'No Instagram post was published in the last 14 days.'
: 'Facebook posting has slowed down recently.';
} else {
title = `${label} needs attention`;
message = `${label} monitoring needs attention.`;
}
return {
severity: status,
source: provider,
title,
message,
recommended_action: recommendedAction(provider, status)
};
}
