// backend/src/services/uploadTicketStore.ts
//
// Phase 2B.3 — Persistent, atomic upload-ticket storage.
//
// Presigned upload tickets are stored in shared Redis (Upstash/Redis) as a
// hash with a TTL. There is intentionally NO process-local fallback in
// production: a serverless instance must never treat its own memory as the
// source of truth for a ticket that another instance will confirm.
//
// Lifecycle:
//   issued      → ticket created by /presign
//   processing  → atomically claimed by one confirmation request
//   confirmed   → confirmation completed (duplicate confirmations are idempotent)
//
// If a confirmation fails before the media record is persisted, the route
// releases the claim back to `issued` so the client can safely retry.

import redisClient from '../utils/cache';
import logger from '../utils/logger';

const KEY_PREFIX = 'civicmind:upload-ticket:';
const CLAIM_LEASE_MS = 5 * 60 * 1000; // reclaim a crashed claim only after the ticket window

export interface PresignedUploadTicket {
  complaintId: number;
  userId: number;
  /** Storage key this ticket was issued for (bound to the ticket). */
  storageKey?: string;
  mimeType: string;
  fileSizeBytes: number;
  /** Unix timestamp in milliseconds. */
  expiresAt: number;
  status?: 'issued' | 'processing' | 'confirmed';
  claimId?: string;
  claimedAt?: number;
  /** Backwards-compatible alias retained for existing callers. */
  confirmed?: boolean;
}

export type TicketClaimResult = 'claimed' | 'confirmed';

export class UploadTicketError extends Error {
  statusCode: number;
  code: string;

  constructor(message: string, statusCode: number, code: string) {
    super(message);
    this.name = 'UploadTicketError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

type RedisLike = {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<any>;
  hgetall(key: string): Promise<Record<string, string>>;
  del(...keys: string[]): Promise<number>;
  keys(pattern: string): Promise<string[]>;
};

const REGISTER_SCRIPT = `
local status = redis.call('HGET', KEYS[1], 'status')
if status == 'confirmed' then return 0 end
redis.call('DEL', KEYS[1])
redis.call('HSET', KEYS[1],
  'complaintId', ARGV[1],
  'userId', ARGV[2],
  'storageKey', ARGV[3],
  'mimeType', ARGV[4],
  'fileSizeBytes', ARGV[5],
  'expiresAt', ARGV[6],
  'status', 'issued',
  'createdAt', ARGV[7])
redis.call('EXPIRE', KEYS[1], ARGV[8])
return 1
`;

const CLAIM_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then return {0, 'not_found'} end
local now = tonumber(ARGV[1])
local expiresAt = tonumber(redis.call('HGET', KEYS[1], 'expiresAt') or '0')
if expiresAt <= now then
  redis.call('DEL', KEYS[1])
  return {0, 'expired'}
end
local complaintId = tonumber(redis.call('HGET', KEYS[1], 'complaintId') or '0')
local userId = tonumber(redis.call('HGET', KEYS[1], 'userId') or '0')
if complaintId ~= tonumber(ARGV[2]) or userId ~= tonumber(ARGV[3]) then
  return {0, 'forbidden'}
end
local status = redis.call('HGET', KEYS[1], 'status')
if status == 'confirmed' then return {1, 'confirmed'} end
if status == 'processing' then
  local claimedAt = tonumber(redis.call('HGET', KEYS[1], 'claimedAt') or '0')
  if claimedAt + tonumber(ARGV[5]) > now then return {0, 'in_progress'} end
end
redis.call('HSET', KEYS[1],
  'status', 'processing',
  'claimId', ARGV[4],
  'claimedAt', ARGV[1])
return {1, 'claimed'}
`;

const CONFIRM_SCRIPT = `
local status = redis.call('HGET', KEYS[1], 'status')
if status == 'confirmed' then return 1 end
if status ~= 'processing' then return 0 end
if redis.call('HGET', KEYS[1], 'claimId') ~= ARGV[1] then return 0 end
redis.call('HSET', KEYS[1], 'status', 'confirmed')
redis.call('HDEL', KEYS[1], 'claimId', 'claimedAt')
return 1
`;

const RELEASE_SCRIPT = `
local status = redis.call('HGET', KEYS[1], 'status')
if status ~= 'processing' then return 0 end
if redis.call('HGET', KEYS[1], 'claimId') ~= ARGV[1] then return 0 end
redis.call('HSET', KEYS[1], 'status', 'issued')
redis.call('HDEL', KEYS[1], 'claimId', 'claimedAt')
return 1
`;

function ticketKey(storageKey: string): string {
  return `${KEY_PREFIX}${storageKey}`;
}

function parseTicket(raw: Record<string, string> | null): PresignedUploadTicket | null {
  if (!raw || !raw.complaintId) return null;
  return {
    complaintId: Number(raw.complaintId),
    userId: Number(raw.userId),
    storageKey: raw.storageKey,
    mimeType: raw.mimeType,
    fileSizeBytes: Number(raw.fileSizeBytes),
    expiresAt: Number(raw.expiresAt),
    status: (raw.status as PresignedUploadTicket['status']) || 'issued',
    claimId: raw.claimId,
    claimedAt: raw.claimedAt ? Number(raw.claimedAt) : undefined,
  };
}

export class UploadTicketStore {
  constructor(private readonly client: RedisLike | null) {}

  private requireClient(): RedisLike {
    if (!this.client) {
      throw new UploadTicketError(
        'Shared ticket storage is not configured. REDIS_URL is required for presigned uploads.',
        503,
        'store_unavailable'
      );
    }
    return this.client;
  }

  async register(storageKey: string, ticket: PresignedUploadTicket): Promise<void> {
    const client = this.requireClient();
    const ttlSeconds = Math.max(1, Math.ceil((ticket.expiresAt - Date.now()) / 1000));
    const boundStorageKey = ticket.storageKey || storageKey;

    const result = await client.eval(
      REGISTER_SCRIPT,
      1,
      ticketKey(storageKey),
      String(ticket.complaintId),
      String(ticket.userId),
      boundStorageKey,
      ticket.mimeType,
      String(ticket.fileSizeBytes),
      String(ticket.expiresAt),
      String(Date.now()),
      String(ttlSeconds)
    );

    if (Number(result) !== 1) {
      throw new UploadTicketError(
        'Upload ticket has already been confirmed and cannot be reissued.',
        409,
        'already_confirmed'
      );
    }
  }

  async claim(
    storageKey: string,
    complaintId: number,
    userId: number,
    claimId: string
  ): Promise<TicketClaimResult> {
    const client = this.requireClient();
    const result = await client.eval(
      CLAIM_SCRIPT,
      1,
      ticketKey(storageKey),
      String(Date.now()),
      String(complaintId),
      String(userId),
      claimId,
      String(CLAIM_LEASE_MS)
    );

    const ok = Number(result?.[0]) === 1;
    const outcome = String(result?.[1] || 'unknown');

    if (ok) {
      return outcome === 'confirmed' ? 'confirmed' : 'claimed';
    }

    switch (outcome) {
      case 'not_found':
        throw new UploadTicketError(
          'Unauthorized upload confirmation: Storage key was not issued by presign, has expired, or has already been confirmed.',
          403,
          'not_found'
        );
      case 'expired':
        throw new UploadTicketError(
          'Upload ticket has expired. Please request a new upload URL.',
          410,
          'expired'
        );
      case 'forbidden':
        throw new UploadTicketError(
          'Unauthorized upload confirmation: Upload ticket was issued for a different complaint or user.',
          403,
          'forbidden'
        );
      case 'in_progress':
        throw new UploadTicketError(
          'Upload confirmation is already in progress. Please retry shortly.',
          409,
          'in_progress'
        );
      default:
        throw new UploadTicketError('Upload ticket could not be claimed.', 500, 'claim_failed');
    }
  }

  async confirm(storageKey: string, claimId: string): Promise<boolean> {
    const client = this.requireClient();
    const result = await client.eval(
      CONFIRM_SCRIPT,
      1,
      ticketKey(storageKey),
      claimId
    );
    return Number(result) === 1;
  }

  async release(storageKey: string, claimId: string): Promise<boolean> {
    const client = this.requireClient();
    const result = await client.eval(
      RELEASE_SCRIPT,
      1,
      ticketKey(storageKey),
      claimId
    );
    return Number(result) === 1;
  }

  async get(storageKey: string): Promise<PresignedUploadTicket | null> {
    const client = this.requireClient();
    return parseTicket(await client.hgetall(ticketKey(storageKey)));
  }

  async reset(): Promise<void> {
    if (!this.client) return;
    const keys = await this.client.keys(`${KEY_PREFIX}*`);
    if (keys.length > 0) {
      await this.client.del(...keys);
    }
  }
}

const hasSharedRedis = Boolean(process.env.REDIS_URL);
const isTestEnvironment = process.env.NODE_ENV === 'test' || Boolean(process.env.JEST_WORKER_ID);

// In production a real REDIS_URL is mandatory for presigned uploads. In tests
// the shared ioredis-mock instance stands in for Redis.
export const uploadTicketStore = new UploadTicketStore(
  hasSharedRedis || isTestEnvironment ? (redisClient as unknown as RedisLike) : null
);

export const registerPresignedTicket = (storageKey: string, ticket: PresignedUploadTicket) =>
  uploadTicketStore.register(storageKey, ticket);

export const claimPresignedTicket = (
  storageKey: string,
  complaintId: number,
  userId: number,
  claimId: string
) => uploadTicketStore.claim(storageKey, complaintId, userId, claimId);

export const confirmPresignedTicket = (storageKey: string, claimId: string) =>
  uploadTicketStore.confirm(storageKey, claimId);

export const releasePresignedTicket = (storageKey: string, claimId: string) =>
  uploadTicketStore.release(storageKey, claimId);

export const getPresignedTicket = (storageKey: string) => uploadTicketStore.get(storageKey);

export const _resetPresignedTickets = async (): Promise<void> => {
  try {
    await uploadTicketStore.reset();
  } catch (err: any) {
    logger.warn('[UPLOAD_TICKET] Failed to reset upload tickets:', err?.message || err);
  }
};
