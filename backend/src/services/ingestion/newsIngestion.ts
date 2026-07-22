// backend/src/services/ingestion/newsIngestion.ts
//
// Fetches civic-relevant complaints from public Indian news RSS feeds,
// filters them by keyword matching, and feeds them into the existing
// embed → cluster → score pipeline via insertAndCluster().
// Writes audit records to ingestion_log table after every run.

import { XMLParser } from 'fast-xml-parser';
import { getSourceId, generateIdempotencyKey, insertAndCluster } from './common';
import { logIngestionRun } from './ingestionLogService';

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

interface FetchFeedResult {
  url: string;
  success: boolean;
  items: RssItem[];
  error?: string;
}

const fetchFeed = async (url: string): Promise<FetchFeedResult> => {
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
      return { url, success: false, items: [], error: `HTTP ${response.status}` };
    }

    const xml = await response.text();
    const parser = new XMLParser({ ignoreAttributes: false });
    const parsed = parser.parse(xml);

    const channel = parsed?.rss?.channel ?? parsed?.feed;
    const rawItems = channel?.item ?? [];
    const items: RssItem[] = (Array.isArray(rawItems) ? rawItems : [rawItems])
      .filter((item: any) => item?.title && (item?.description || item?.['content:encoded']))
      .map((item: any) => ({
        title: String(item.title).trim(),
        description: String(item.description ?? item['content:encoded'] ?? '').replace(/<[^>]*>/g, '').trim(),
        link: String(item.link ?? item.guid ?? '').trim(),
        pubDate: item.pubDate ?? item.published ?? undefined,
      }));

    return { url, success: true, items };
  } catch (err: any) {
    const errorMsg = err.name === 'AbortError' ? 'Timeout' : err.message;
    console.warn(`[NEWS] RSS fetch error for ${url}: ${errorMsg}`);
    return { url, success: false, items: [], error: errorMsg };
  }
};

// ── Main ingestion entry point ──────────────────────────────────────────────
export interface NewsIngestionResult {
  totalFetched: number;
  relevantCount: number;
  insertedCount: number;
  skippedDuplicate: number;
  errors: string[];
  failedFeeds: string[];
  status: 'success' | 'partial' | 'failed';
  logId?: number | null;
}

export const ingestNewsFeeds = async (customFeeds?: string[]): Promise<NewsIngestionResult> => {
  const feedsToUse = customFeeds ?? RSS_FEEDS;

  const result: NewsIngestionResult = {
    totalFetched: 0,
    relevantCount: 0,
    insertedCount: 0,
    skippedDuplicate: 0,
    errors: [],
    failedFeeds: [],
    status: 'success',
  };

  const sourceId = await getSourceId('news_rss');
  if (!sourceId) {
    const errMsg = 'Source "news_rss" not found in database.';
    result.errors.push(errMsg);
    result.status = 'failed';
    result.logId = await logIngestionRun({
      sourceType: 'news_rss',
      processed: 0,
      created: 0,
      duplicates: 0,
      errors: 1,
      failedFeeds: feedsToUse,
      status: 'failed',
    });
    return result;
  }

  // Fetch all feeds in parallel
  const feedResults = await Promise.all(feedsToUse.map(fetchFeed));
  
  const successfulFeeds = feedResults.filter((f) => f.success);
  const failedFeeds = feedResults.filter((f) => !f.success);

  result.failedFeeds = failedFeeds.map((f) => f.url);

  const allItems = successfulFeeds.flatMap((f) => f.items);
  result.totalFetched = allItems.length;

  console.log(`[NEWS] Fetched ${allItems.length} RSS items from ${successfulFeeds.length}/${feedsToUse.length} feeds`);

  // Deduplicate across feeds
  const seenTitles = new Set<string>();

  for (const item of allItems) {
    const titleKey = item.title.toLowerCase().slice(0, 120);
    if (seenTitles.has(titleKey)) continue;
    seenTitles.add(titleKey);

    const combinedText = `${item.title} ${item.description}`;
    if (!isCivicRelevant(combinedText)) continue;
    result.relevantCount++;

    const category = inferCategory(combinedText);
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

  // Determine final status
  if (failedFeeds.length === feedsToUse.length && feedsToUse.length > 0) {
    result.status = 'failed';
  } else if (failedFeeds.length > 0 || result.errors.length > 0) {
    result.status = 'partial';
  } else {
    result.status = 'success';
  }

  // Write audit row to ingestion_log
  result.logId = await logIngestionRun({
    sourceType: 'news_rss',
    processed: result.relevantCount,
    created: result.insertedCount,
    duplicates: result.skippedDuplicate,
    errors: result.errors.length + result.failedFeeds.length,
    failedFeeds: result.failedFeeds,
    status: result.status,
  });

  console.log(
    `[NEWS] Ingestion complete (status: ${result.status}): ${result.insertedCount} new, ` +
    `${result.skippedDuplicate} duplicate-skipped, ${result.relevantCount} relevant`
  );

  return result;
};
