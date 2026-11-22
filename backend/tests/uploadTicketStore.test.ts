// backend/tests/uploadTicketStore.test.ts
//
// Phase 2B.3 — Reliability tests for the persistent upload-ticket store.
//
// These tests use two independent UploadTicketStore instances that share one
// Redis mock, which simulates a presign on serverless instance A and a
// confirmation on instance B. No process-local Map is involved.

import RedisMock from 'ioredis-mock';
import {
  UploadTicketStore,
  UploadTicketError,
  PresignedUploadTicket,
} from '../src/services/uploadTicketStore';

const future = () => Date.now() + 5 * 60 * 1000;

function ticket(overrides: Partial<PresignedUploadTicket> = {}): PresignedUploadTicket {
  return {
    complaintId: 1,
    userId: 777,
    storageKey: 'staging/complaints/1/ticket.jpg',
    mimeType: 'image/jpeg',
    fileSizeBytes: 1024,
    expiresAt: future(),
    status: 'issued',
    ...overrides,
  };
}

async function expectTicketError(promise: Promise<unknown>, statusCode: number, code: string) {
  await expect(promise).rejects.toBeInstanceOf(UploadTicketError);
  await promise.catch((err: UploadTicketError) => {
    expect(err.statusCode).toBe(statusCode);
    expect(err.code).toBe(code);
  });
}

describe('UploadTicketStore — persistent shared tickets', () => {
  let redis: any;
  let instanceA: UploadTicketStore;
  let instanceB: UploadTicketStore;

  beforeEach(() => {
    redis = new RedisMock();
    instanceA = new UploadTicketStore(redis);
    instanceB = new UploadTicketStore(redis);
  });

  afterEach(async () => {
    await redis.quit();
  });

  it('presign on instance A can be confirmed by instance B (no local memory)', async () => {
    const key = 'staging/complaints/1/cross-instance.jpg';
    await instanceA.register(key, ticket({ storageKey: key }));

    const result = await instanceB.claim(key, 1, 777, 'claim-b');
    expect(result).toBe('claimed');

    const stored = await instanceB.get(key);
    expect(stored).not.toBeNull();
    expect(stored?.status).toBe('processing');
    expect(stored?.storageKey).toBe(key);
    expect(stored?.complaintId).toBe(1);
    expect(stored?.userId).toBe(777);
    expect(stored?.mimeType).toBe('image/jpeg');
    expect(stored?.fileSizeBytes).toBe(1024);
  });

  it('rejects an expired ticket and removes it', async () => {
    const key = 'staging/complaints/1/expired.jpg';
    await instanceA.register(key, ticket({ storageKey: key, expiresAt: Date.now() - 1000 }));

    await expectTicketError(instanceB.claim(key, 1, 777, 'claim-1'), 410, 'expired');
    expect(await instanceB.get(key)).toBeNull();
  });

  it('rejects a ticket bound to a different complaint or user', async () => {
    const key = 'staging/complaints/1/wrong-owner.jpg';
    await instanceA.register(key, ticket({ storageKey: key }));

    await expectTicketError(instanceB.claim(key, 2, 777, 'claim-1'), 403, 'forbidden');
    await expectTicketError(instanceB.claim(key, 1, 5, 'claim-1'), 403, 'forbidden');
  });

  it('allows only one concurrent claim (atomic single-use)', async () => {
    const key = 'staging/complaints/1/race.jpg';
    await instanceA.register(key, ticket({ storageKey: key }));

    const results = await Promise.allSettled([
      instanceA.claim(key, 1, 777, 'claim-a'),
      instanceB.claim(key, 1, 777, 'claim-b'),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0].reason as UploadTicketError).statusCode).toBe(409);
    expect((rejected[0].reason as UploadTicketError).code).toBe('in_progress');
  });

  it('releases a failed claim so confirmation can be retried', async () => {
    const key = 'staging/complaints/1/retry.jpg';
    await instanceA.register(key, ticket({ storageKey: key }));

    await instanceA.claim(key, 1, 777, 'claim-1');
    expect(await instanceA.release(key, 'claim-1')).toBe(true);

    const retry = await instanceB.claim(key, 1, 777, 'claim-2');
    expect(retry).toBe('claimed');

    expect(await instanceB.confirm(key, 'claim-2')).toBe(true);

    // Duplicate confirmation after success is idempotent.
    expect(await instanceA.claim(key, 1, 777, 'claim-3')).toBe('confirmed');
    expect(await instanceA.confirm(key, 'claim-3')).toBe(true);
  });

  it('does not allow a stale claim id to release or confirm a newer claim', async () => {
    const key = 'staging/complaints/1/stale-claim.jpg';
    await instanceA.register(key, ticket({ storageKey: key }));

    await instanceA.claim(key, 1, 777, 'claim-1');
    await instanceA.release(key, 'claim-1');
    await instanceB.claim(key, 1, 777, 'claim-2');

    expect(await instanceA.confirm(key, 'claim-1')).toBe(false);
    expect(await instanceA.release(key, 'claim-1')).toBe(false);

    const stored = await instanceA.get(key);
    expect(stored?.status).toBe('processing');
    expect(stored?.claimId).toBe('claim-2');
  });

  it('fails closed when shared Redis is not configured (no in-memory fallback)', async () => {
    const store = new UploadTicketStore(null);
    await expectTicketError(
      store.register('staging/complaints/1/no-redis.jpg', ticket()),
      503,
      'store_unavailable'
    );
  });
});
