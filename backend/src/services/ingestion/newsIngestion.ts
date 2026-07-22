// backend/src/services/ingestion/newsIngestion.ts
//
// Fetches civic-relevant complaints from public Indian news RSS feeds,
// filters them by keyword matching, and feeds them into the existing
// embed → cluster → score pipeline via insertAndCluster().
//
// ── RSS Feed URLs (swap freely) ─────────────────────────────────────────────
// 1. NDTV Top Stories       — https://feeds.feedburner.com/ndtvnews-top-stories
// 2. The Hindu Bangalore    — https://www.thehindu.com/news/cities/bangalore/feeder/default.rss
// 3. Indian Express India   — https://indianexpress.com/section/india/feed/
//
// These are public RSS feeds. For a production deployment you would pin
// city-specific feeds for your target region (e.g. BBMP/Bangalore).

import { XMLParser } from 'fast-xml-parser';
import { getSourceId, generateIdempotencyKey, insertAndCluster } from './common';

// ── Feed configuration ──────────────────────────────────────────────────────
const RSS_FEEDS = [
  // NDTV general — broad coverage of civic issues across India
  'https://feeds.feedburner.com/ndtvnews-top-stories',
  // The Hindu Bangalore — city-level coverage relevant to BBMP/metro area
  'https://www.thehindu.com/news/cities/bangalore/feeder/default.rss',
  // Indian Express national — supplement for wider civic issue coverage
  'https://indianexpress.com/section/india/feed/',
];

// ── Civic relevance keywords ────────────────────────────────────────────────
// Articles must contain at least one keyword to pass the relevance filter.
// This prevents ingesting entertainment, politics-only, or sports news.
const CIVIC_KEYWORDS: string[] = [
  'water', 'road', 'pothole', 'electricity', 'power', 'garbage', 'waste',
  'health', 'hospital', 'safety', 'accident', 'crime', 'fire', 'drainage',
  'sewage', 'flooding', 'flood', 'traffic', 'streetlight', 'bus', 'metro',
  'transport', 'construction', 'bridge', 'pollution', 'litter', 'civic',
  'municipality', 'corporation', 'bbmp', 'nagar', 'ward', 'pipeline',
  'drinking', 'sanitation', 'encroachment', 'footpath', 'pavement',
  'street', 'noise', 'women', 'child', 'pedestrian', 'overflow',
];

// ── Category inference from text ────────────────────────────────────────────
// Maps keyword hits to complaint categories matching the existing enum:
// infrastructure | sanitation | utility | noise | safety | other
const CATEGORY_RULES: Array<{ keywords: string[]; category: string }> = [
  { keywords: ['road', 'pothole', 'traffic', 'bridge', 'construction', 'bus', 'metro', 'transport', 'footpath', 'pavement', 'encroachment', 'pedestrian'], category: 'infrastructure' },
  { keywords: ['garbage', 'waste', 'drainage', 'sewage', 'pollution', 'litter', 'sanitation', 'overflow'], category: 'sanitation' },
  { keywords: ['water', 'electricity', 'power', 'pipeline', 'drinking', 'streetlight'], category: 'utility' },
  { keywords: ['noise', 'loud', 'music', 'decibel'], category: 'noise' },
  { keywords: ['safety', 'accident', 'crime', 'fire', 'women', 'child', 'assault'], category: 'safety' },
];

export const inferCategory = (text: string): string => {
  const lower = text.toLowerCase();
  for (const rule of CATEGORY_RULES) {
    if (rule.keywords.some((kw) => lower.includes(kw))) {
      return rule.category;
    }
  }
  return 'other';
};

// ── Civic relevance check ───────────────────────────────────────────────────
export const isCivicRelevant = (text: string): boolean => {
  const lower = text.toLowerCase();
  return CIVIC_KEYWORDS.some((kw) => lower.includes(kw));
};

// ── RSS fetch + parse ───────────────────────────────────────────────────────
interface RssItem {
  title: string;
  description: string;
  link: string;
  pubDate?: string;
}

const fetchFeed = async (url: string): Promise<RssItem[]> => {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    const response = await fetch(url, {
      headers: { 'User-Agent': 'CivicMind-Ingestion/1.0 (civic RSS reader)' },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      console.warn(`[NEWS] RSS fetch failed for ${url}: HTTP ${response.status}`);
      return [];
    }

    const xml = await response.text();
    const parser = new XMLParser({
      ignoreAttributes: false,
      // RSS items are inside <channel><item>
    });
    const parsed = parser.parse(xml);

    // Navigate to items — handles both RSS 2.0 and Atom-ish formats
    const channel = parsed?.rss?.channel ?? parsed?.feed;
    const rawItems = channel?.item ?? [];
    const items: RssItem[] = Array.isArray(rawItems) ? rawItems : [rawItems];

    return items
      .filter((item: any) => item.title && (item.description || item['content:encoded']))
      .map((item: any) => ({
        title: String(item.title).trim(),
        description: String(item.description ?? item['content:encoded'] ?? '').replace(/<[^>]*>/g, '').trim(),
        link: String(item.link ?? item.guid ?? '').trim(),
        pubDate: item.pubDate ?? item.published ?? undefined,
      }));
  } catch (err: any) {
    if (err.name === 'AbortError') {
      console.warn(`[NEWS] RSS fetch timed out for ${url}`);
    } else {
      console.warn(`[NEWS] RSS fetch error for ${url}:`, err.message);
    }
    return [];
  }
};

// ── Main ingestion entry point ──────────────────────────────────────────────
export interface NewsIngestionResult {
  totalFetched: number;
  relevantCount: number;
  insertedCount: number;
  skippedDuplicate: number;
  errors: string[];
}

export const ingestNewsFeeds = async (): Promise<NewsIngestionResult> => {
  const result: NewsIngestionResult = {
    totalFetched: 0,
    relevantCount: 0,
    insertedCount: 0,
    skippedDuplicate: 0,
    errors: [],
  };

  const sourceId = await getSourceId('news_rss');
  if (!sourceId) {
    result.errors.push('Source "news_rss" not found in database.');
    return result;
  }

  // Fetch all feeds in parallel
  const feedResults = await Promise.all(RSS_FEEDS.map(fetchFeed));
  const allItems = feedResults.flat();
  result.totalFetched = allItems.length;

  console.log(`[NEWS] Fetched ${allItems.length} total RSS items from ${RSS_FEEDS.length} feeds`);

  // Deduplicate across feeds (same URL or title can appear in multiple feeds)
  const seenTitles = new Set<string>();

  for (const item of allItems) {
    // Dedup within this batch
    const titleKey = item.title.toLowerCase().slice(0, 120);
    if (seenTitles.has(titleKey)) continue;
    seenTitles.add(titleKey);

    // Relevance filter
    const combinedText = `${item.title} ${item.description}`;
    if (!isCivicRelevant(combinedText)) continue;
    result.relevantCount++;

    // Category inference
    const category = inferCategory(combinedText);

    // Deterministic idempotency key from URL (or title if URL missing)
    const dedupSource = item.link || item.title;
    const idempotencyKey = generateIdempotencyKey(dedupSource);

    try {
      const complaintId = await insertAndCluster({
        sourceId,
        text: `${item.title}. ${item.description}`.slice(0, 5000),
        category,
        idempotencyKey,
        latitude: null,
        longitude: null,
        metaData: {
          source: 'news_rss',
          articleUrl: item.link,
          publishedAt: item.pubDate ?? null,
          feedTitle: item.title,
        },
      });

      if (complaintId !== null) {
        result.insertedCount++;
      } else {
        result.skippedDuplicate++;
      }
    } catch (err: any) {
      result.errors.push(`Failed to process "${item.title.slice(0, 60)}": ${err.message}`);
    }
  }

  console.log(
    `[NEWS] Ingestion complete: ${result.insertedCount} new, ` +
    `${result.skippedDuplicate} duplicate-skipped, ` +
    `${result.relevantCount} relevant of ${result.totalFetched} fetched`
  );

  return result;
};
