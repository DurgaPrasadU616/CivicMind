// backend/src/services/ingestion/socialIngestion.ts
//
// SIMULATED social media ingestion — generates realistic mock civic-complaint
// posts that mimic what a live Twitter/X or Facebook API integration would
// produce. This is NOT connected to a real social media API.
// Writes audit records to ingestion_log table after every run.

import { getSourceId, generateIdempotencyKey, insertAndCluster } from './common';
import { logIngestionRun } from './ingestionLogService';

interface MockSocialPost {
  author: string;
  platform: string;
  text: string;
  region?: string;
  postedAt: string;
}

const MOCK_POSTS: MockSocialPost[] = [
  // ── Infrastructure (6 posts) ──
  {
    author: '@rahul_techie',
    platform: 'twitter',
    text: 'Massive pothole on Outer Ring Road near Silk Board junction. Bikes are skidding every hour. @BBMPCOMM please fix this! #Bangalore #RoadSafety',
    region: 'East',
    postedAt: '2026-07-20T08:30:00Z',
  },
  {
    author: '@meera_journo',
    platform: 'twitter',
    text: 'The flyover near Hebbal is showing visible cracks. Commuters are terrified. Is anyone from BBMP monitoring structural safety? #Infrastructure #Bangalore',
    region: 'North',
    postedAt: '2026-07-19T14:15:00Z',
  },
  {
    author: '@priya_kumar_',
    platform: 'facebook',
    text: 'Footpath on MG Road completely encroached by vendors and parked bikes. Pedestrians forced to walk on the road. Dangerous for elderly and children.',
    region: 'Downtown',
    postedAt: '2026-07-20T10:00:00Z',
  },
  {
    author: '@anil_redddy',
    platform: 'twitter',
    text: 'Main Road in JP Nagar 5th Phase has not been resurfaced in 5 years. Completely broken during monsoon. @BBMP Commissioner please take note.',
    region: 'South',
    postedAt: '2026-07-18T16:45:00Z',
  },
  {
    author: '@deepa_suresh',
    platform: 'twitter',
    text: 'Construction debris dumped illegally on the service road near Electronic City. Heavy vehicles can barely pass. Accident waiting to happen.',
    region: 'South',
    postedAt: '2026-07-21T07:20:00Z',
  },
  {
    author: '@vijay_citizen',
    platform: 'facebook',
    text: 'Bus shelter on Residency Road has been broken for 3 months. No roof, no seating. People stand in rain waiting for BMTC buses.',
    region: 'Downtown',
    postedAt: '2026-07-17T09:10:00Z',
  },

  // ── Sanitation (4 posts) ──
  {
    author: '@nisha_env',
    platform: 'twitter',
    text: 'Garbage overflow at the Koramangala 4th Block collection point. It has been 4 days since last pickup. Stench is unbearable. @BBMP #GarbageCrisis',
    region: 'South',
    postedAt: '2026-07-20T06:50:00Z',
  },
  {
    author: '@suresh_kumar',
    platform: 'twitter',
    text: 'Open sewage drain running through Indiranagar 12th Main. Raw sewage flowing onto the street. Health hazard for residents and pets.',
    region: 'East',
    postedAt: '2026-07-19T11:30:00Z',
  },
  {
    author: '@anjali_dev',
    platform: 'facebook',
    text: 'Plastic waste dumped near Ulsoor Lake is killing birds. Spotted 3 dead egrets today. Where is the pollution control board? #Environment #Bangalore',
    region: 'East',
    postedAt: '2026-07-20T15:40:00Z',
  },
  {
    author: '@raj_manchanda',
    platform: 'twitter',
    text: 'Dairy Circle area has become a garbage dumping spot. Municipal bins are always overflowing. Stray dogs scatter waste everywhere. #Sanitation',
    region: 'South',
    postedAt: '2026-07-21T08:05:00Z',
  },

  // ── Utility (4 posts) ──
  {
    author: '@farhan_ahmed',
    platform: 'twitter',
    text: 'No water supply in HSR Layout Sector 2 for the past 3 days. BWSSB says pipe repair but no timeline given. Families are struggling. #BangaloreWater',
    region: 'South',
    postedAt: '2026-07-20T07:00:00Z',
  },
  {
    author: '@lakshmi_r',
    platform: 'twitter',
    text: 'Streetlights completely dead on the stretch between Jayanagar 4th Block and Banashankari. Pitch dark after 7 PM. Women feel unsafe walking.',
    region: 'South',
    postedAt: '2026-07-19T19:30:00Z',
  },
  {
    author: '@pradeep_n',
    platform: 'facebook',
    text: 'Frequent power cuts in Rajajinagar — 6 times in the last 24 hours. BESCOM not responding to complaints. Small businesses suffering.',
    region: 'West',
    postedAt: '2026-07-21T06:15:00Z',
  },
  {
    author: '@shruti_gowda',
    platform: 'twitter',
    text: 'Contaminated brown water coming from taps in BTM Layout Phase 1. Multiple households affected. BWSSB helpline is unreachable. #DrinkingWater',
    region: 'South',
    postedAt: '2026-07-20T12:45:00Z',
  },

  // ── Safety (3 posts) ──
  {
    author: '@kavitha_s',
    platform: 'twitter',
    text: 'Hit-and-run on Old Airport Road near Domlur. No traffic signal, no speed breaker, no pedestrian crossing. This road is a death trap. #RoadSafety',
    region: 'East',
    postedAt: '2026-07-20T18:20:00Z',
  },
  {
    author: '@arun_patil',
    platform: 'facebook',
    text: 'Unattended electrical wire hanging low near Majestic bus stand. Bare copper visible. Risk of electrocution for pedestrians and vendors.',
    region: 'Downtown',
    postedAt: '2026-07-19T08:55:00Z',
  },
  {
    author: '@divya_ns',
    platform: 'twitter',
    text: 'Women safety concern near KR Puram railway station after dark. No police patrol, no streetlights, deserted stretch. @BaborPolice please increase patrolling.',
    region: 'East',
    postedAt: '2026-07-21T21:10:00Z',
  },

  // ── Noise (2 posts) ──
  {
    author: '@rohan_mehta',
    platform: 'twitter',
    text: 'Construction noise from a high-rise project in Bellandur starting at 5:30 AM. Weekday and weekend. Residents cannot sleep. BBMP noise rules?',
    region: 'East',
    postedAt: '2026-07-20T05:45:00Z',
  },
  {
    author: '@fatima_b',
    platform: 'facebook',
    text: 'Loudspeaker blaring from a political rally near Commercial Street. It has been going on for 4 hours. No police intervention. #NoisePollution',
    region: 'Downtown',
    postedAt: '2026-07-18T20:30:00Z',
  },

  // ── Other (1 post) ──
  {
    author: '@manoj_sharma',
    platform: 'twitter',
    text: 'Stray cattle roaming freely on Bellary Road causing traffic jams and near-misses. BBMP animal control not responding. Who is responsible?',
    region: 'North',
    postedAt: '2026-07-21T10:20:00Z',
  },
];

const CATEGORY_RULES: Array<{ keywords: string[]; category: string }> = [
  { keywords: ['road', 'pothole', 'traffic', 'bridge', 'construction', 'bus', 'metro', 'transport', 'footpath', 'pavement', 'encroachment', 'pedestrian', 'flyover', 'resurface'], category: 'infrastructure' },
  { keywords: ['garbage', 'waste', 'drainage', 'sewage', 'pollution', 'litter', 'sanitation', 'overflow', 'plastic', 'dump'], category: 'sanitation' },
  { keywords: ['water', 'electricity', 'power', 'pipeline', 'drinking', 'streetlight', 'light', 'bescom', 'bwssb'], category: 'utility' },
  { keywords: ['noise', 'loud', 'loudspeaker', 'construction noise', 'decibel'], category: 'noise' },
  { keywords: ['safety', 'accident', 'crime', 'fire', 'women', 'child', 'assault', 'hit-and-run', 'electrocution', 'wire'], category: 'safety' },
];

const inferCategory = (text: string): string => {
  const lower = text.toLowerCase();
  for (const rule of CATEGORY_RULES) {
    if (rule.keywords.some((kw) => lower.includes(kw))) {
      return rule.category;
    }
  }
  return 'other';
};

const REGION_COORDS: Record<string, { lat: number; lng: number }> = {
  Downtown: { lat: 12.9716, lng: 77.5946 },
  North:    { lat: 12.9850, lng: 77.5900 },
  South:    { lat: 12.9520, lng: 77.6050 },
  East:     { lat: 12.9700, lng: 77.6350 },
  West:     { lat: 12.9750, lng: 77.5650 },
};

export interface SocialIngestionResult {
  totalPosts: number;
  insertedCount: number;
  skippedDuplicate: number;
  errors: string[];
  status: 'success' | 'partial' | 'failed';
  logId?: number | null;
}

export const ingestSocialMediaPosts = async (posts?: MockSocialPost[]): Promise<SocialIngestionResult> => {
  const postsToUse = posts ?? MOCK_POSTS;

  const result: SocialIngestionResult = {
    totalPosts: postsToUse.length,
    insertedCount: 0,
    skippedDuplicate: 0,
    errors: [],
    status: 'success',
  };

  const sourceId = await getSourceId('social_media');
  if (!sourceId) {
    const errMsg = 'Source "social_media" not found in database.';
    result.errors.push(errMsg);
    result.status = 'failed';
    result.logId = await logIngestionRun({
      sourceType: 'social_media',
      processed: 0,
      created: 0,
      duplicates: 0,
      errors: 1,
      status: 'failed',
    });
    return result;
  }

  console.log(`[SOCIAL] Ingesting ${postsToUse.length} simulated social media posts...`);

  for (const post of postsToUse) {
    const category = inferCategory(post.text);
    const idempotencyKey = generateIdempotencyKey(`${post.platform}:${post.author}:${post.postedAt}`);
    const region = post.region ?? 'Downtown';
    const coords = REGION_COORDS[region] ?? REGION_COORDS.Downtown;

    try {
      const complaintId = await insertAndCluster({
        sourceId,
        text: post.text.slice(0, 5000),
        category,
        idempotencyKey,
        latitude: coords.lat,
        longitude: coords.lng,
        metaData: {
          source: 'social_media',
          platform: post.platform,
          author: post.author,
          postedAt: post.postedAt,
          simulated: true,
        },
      });

      if (complaintId !== null) {
        result.insertedCount++;
      } else {
        result.skippedDuplicate++;
      }
    } catch (err: any) {
      result.errors.push(`Failed to process post by ${post.author}: ${err.message}`);
    }
  }

  if (result.errors.length === postsToUse.length && postsToUse.length > 0) {
    result.status = 'failed';
  } else if (result.errors.length > 0) {
    result.status = 'partial';
  } else {
    result.status = 'success';
  }

  result.logId = await logIngestionRun({
    sourceType: 'social_media',
    processed: postsToUse.length,
    created: result.insertedCount,
    duplicates: result.skippedDuplicate,
    errors: result.errors.length,
    status: result.status,
  });

  console.log(
    `[SOCIAL] Ingestion complete (status: ${result.status}): ${result.insertedCount} new, ` +
    `${result.skippedDuplicate} duplicate-skipped out of ${result.totalPosts} posts`
  );

  return result;
};
