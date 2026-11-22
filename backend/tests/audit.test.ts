// backend/tests/audit.test.ts
//
// Tests for:
//   1. State machine — every legal transition succeeds + writes exactly 1 action_log row
//   2. State machine — every illegal transition is rejected with 400, no log row written
//   3. Concurrent status changes — two near-simultaneous requests on the same cluster
//   4. Immutability — no PUT/DELETE endpoint touches action_log
//   5. GET /api/clusters/:id/history — order, admin join, format
//   6. Role gating — citizen 403 on PATCH, 200 on GET /history

import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../src/index';
import { pool } from '../src/config/db';

process.env.JWT_SECRET = 'civicmind-super-secret-jwt-key-2026-secure';

const makeToken = (id: number, role: string) =>
  jwt.sign({ id, role }, process.env.JWT_SECRET!, { expiresIn: '1h' });

const govtToken    = makeToken(10, 'govt');
const adminToken   = makeToken(11, 'admin');
const ngoToken     = makeToken(12, 'ngo');
const citizenToken = makeToken(20, 'citizen');

// ─── DB mock ─────────────────────────────────────────────────────────────────
jest.mock('../src/config/db', () => {
  const mPool = {
    query: jest.fn(),
    connect: jest.fn(),
  };
  return { pool: mPool, checkDbConnection: jest.fn() };
});

// ─── Helpers ─────────────────────────────────────────────────────────────────
const mockPool = pool as unknown as { query: jest.Mock; connect: jest.Mock };

/**
 * Sets up pool.connect() to return a fake client that records calls
 * and replays pre-supplied query results in order.
 */
function setupTransactionMocks(results: Array<{ rows: any[] } | Error>) {
  const client = {
    query: jest.fn(),
    release: jest.fn(),
  };

  let callIndex = 0;
  client.query.mockImplementation(() => {
    const result = results[callIndex++];
    if (result instanceof Error) return Promise.reject(result);
    return Promise.resolve(result);
  });

  mockPool.connect.mockResolvedValue(client);
  return client;
}

// ─────────────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
});

// =============================================================================
// 1. LEGAL TRANSITIONS — must succeed and write exactly one action_log row
// =============================================================================

describe('State Machine — Legal transitions', () => {
  const legalCases: Array<[string, string]> = [
    ['open',        'in_progress'],
    ['in_progress', 'resolved'],
    ['in_progress', 'escalated'],
    ['escalated',   'in_progress'],
    ['resolved',    'open'],
  ];

  for (const [from, to] of legalCases) {
    it(`${from} → ${to} returns 200 and writes exactly one action_log row`, async () => {
      const client = setupTransactionMocks([
        { rows: [] },                                          // BEGIN
        { rows: [{ id: 1, status: from, title: 'Test', category: 'infrastructure', region: 'Downtown', severity_score: 50, complaint_count: 3, priority_score: 45, needs_review: false, recommended_action: null, created_at: new Date(), updated_at: new Date() }] }, // SELECT FOR UPDATE
        { rows: [{ id: 1, status: to,   title: 'Test', category: 'infrastructure', region: 'Downtown', severity_score: 50, complaint_count: 3, priority_score: 45, needs_review: to === 'open' ? false : false, updated_at: new Date() }] }, // UPDATE cluster
        { rows: [{ id: 99, cluster_id: 1, admin_id: 10, action_taken: 'status_change', previous_status: from, new_status: to, note: null, logged_at: new Date() }] }, // INSERT action_log
        { rows: [] },                                          // COMMIT
      ]);

      const res = await request(app)
        .patch('/api/clusters/CL-1/status')
        .set('Authorization', `Bearer ${govtToken}`)
        .send({ newStatus: to, note: 'Test note' });

      expect(res.status).toBe(200);
      expect(res.body.cluster.status).toBe(to);
      expect(res.body.logEntry).toBeDefined();
      expect(res.body.logEntry.previousStatus).toBe(from);
      expect(res.body.logEntry.newStatus).toBe(to);

      // Verify INSERT into action_log was called exactly once
      const insertCalls = (client.query.mock.calls as string[][]).filter(
        (call) => typeof call[0] === 'string' && call[0].includes('INSERT INTO action_log')
      );
      expect(insertCalls).toHaveLength(1);

      expect(client.release).toHaveBeenCalled();
    });
  }
});

// =============================================================================
// 2. ILLEGAL TRANSITIONS — must be rejected with 400, no log row written
// =============================================================================

describe('State Machine — Illegal transitions', () => {
  const illegalCases: Array<[string, string]> = [
    ['open',     'resolved'],    // skip in_progress step
    ['open',     'escalated'],   // can't escalate without starting first
    ['resolved', 'in_progress'], // must go resolved → open → in_progress
    ['resolved', 'escalated'],   // resolved can only reopen
    ['in_progress', 'open'],     // can't un-start without going through resolved
    ['escalated', 'resolved'],   // escalated → in_progress first
    ['escalated', 'open'],       // escalated → in_progress first
  ];

  for (const [from, to] of illegalCases) {
    it(`${from} → ${to} returns 400 with no action_log INSERT`, async () => {
      const client = setupTransactionMocks([
        { rows: [] }, // BEGIN
        { rows: [{ id: 1, status: from, title: 'Test', category: 'infrastructure', region: 'Downtown', severity_score: 50, complaint_count: 2, priority_score: 40, needs_review: false, recommended_action: null, created_at: new Date(), updated_at: new Date() }] }, // SELECT FOR UPDATE
        { rows: [] }, // ROLLBACK
      ]);

      const res = await request(app)
        .patch('/api/clusters/CL-1/status')
        .set('Authorization', `Bearer ${govtToken}`)
        .send({ newStatus: to });

      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();
      expect(res.body.currentStatus).toBe(from);
      expect(res.body.requestedStatus).toBe(to);

      // Verify NO INSERT into action_log was called
      const insertCalls = (client.query.mock.calls as string[][]).filter(
        (call) => typeof call[0] === 'string' && call[0].includes('INSERT INTO action_log')
      );
      expect(insertCalls).toHaveLength(0);
    });
  }
});

// =============================================================================
// 3. INVALID STATUS VALUES
// =============================================================================

describe('State Machine — Invalid status value', () => {
  it('returns 400 for completely unknown status "cancelled"', async () => {
    const res = await request(app)
      .patch('/api/clusters/CL-1/status')
      .set('Authorization', `Bearer ${govtToken}`)
      .send({ newStatus: 'cancelled' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Invalid status value');
    // No DB calls should happen before the status validation
  });

  it('returns 400 for old "pending" status value (renamed to "open")', async () => {
    const res = await request(app)
      .patch('/api/clusters/CL-1/status')
      .set('Authorization', `Bearer ${govtToken}`)
      .send({ newStatus: 'pending' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Invalid status value');
  });

  it('returns 400 for malformed cluster ID', async () => {
    const res = await request(app)
      .patch('/api/clusters/CL-abc/status')
      .set('Authorization', `Bearer ${govtToken}`)
      .send({ newStatus: 'in_progress' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Invalid cluster ID format');
  });

  it('returns 404 when cluster does not exist', async () => {
    setupTransactionMocks([
      { rows: [] }, // BEGIN
      { rows: [] }, // SELECT FOR UPDATE — no rows found
      { rows: [] }, // ROLLBACK
    ]);

    const res = await request(app)
      .patch('/api/clusters/CL-9999/status')
      .set('Authorization', `Bearer ${govtToken}`)
      .send({ newStatus: 'in_progress' });

    expect(res.status).toBe(404);
    expect(res.body.error).toContain('not found');
  });
});

// =============================================================================
// 4. CONCURRENT STATUS CHANGES
//    The second request sees the post-commit status (updated by the first) and
//    validates against that. Since we use SELECT FOR UPDATE, no partial writes occur.
// =============================================================================

describe('Concurrent status changes', () => {
  it('second concurrent request sees post-commit status and validates against it', async () => {
    // Simulate: cluster is 'open'. Two requests race.
    // First request: open → in_progress (legal) ✓
    // Second request: also tries open → in_progress but the row lock has committed;
    //   with our mock, the second sees 'in_progress' as current status
    //   and open → in_progress would be same-status → rejected.
    //
    // Here we simulate the second request seeing 'in_progress' after the lock releases.
    setupTransactionMocks([
      { rows: [] }, // BEGIN
      { rows: [{ id: 1, status: 'in_progress', title: 'Test', category: 'utility', region: 'North', severity_score: 60, complaint_count: 5, priority_score: 55, needs_review: false, recommended_action: null, created_at: new Date(), updated_at: new Date() }] }, // SELECT FOR UPDATE (sees post-commit state)
      { rows: [] }, // ROLLBACK (after transition validation fails)
    ]);

    const res = await request(app)
      .patch('/api/clusters/CL-1/status')
      .set('Authorization', `Bearer ${govtToken}`)
      .send({ newStatus: 'in_progress' }); // tries open → in_progress but sees in_progress

    // in_progress → in_progress is same-status: should be rejected
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('already in status');
  });

  it('after first request commits, second request with legal transition from new status succeeds', async () => {
    // Cluster is now 'in_progress' (first request already committed).
    // Second request tries in_progress → resolved (legal).
    const client = setupTransactionMocks([
      { rows: [] }, // BEGIN
      { rows: [{ id: 1, status: 'in_progress', title: 'Test', category: 'sanitation', region: 'South', severity_score: 70, complaint_count: 8, priority_score: 65, needs_review: false, recommended_action: null, created_at: new Date(), updated_at: new Date() }] }, // SELECT FOR UPDATE
      { rows: [{ id: 1, status: 'resolved', title: 'Test', category: 'sanitation', region: 'South', severity_score: 70, complaint_count: 8, priority_score: 65, needs_review: false, updated_at: new Date() }] }, // UPDATE cluster
      { rows: [{ id: 100, cluster_id: 1, admin_id: 10, action_taken: 'status_change', previous_status: 'in_progress', new_status: 'resolved', note: null, logged_at: new Date() }] }, // INSERT action_log
      { rows: [] }, // COMMIT
    ]);

    const res = await request(app)
      .patch('/api/clusters/CL-1/status')
      .set('Authorization', `Bearer ${govtToken}`)
      .send({ newStatus: 'resolved' });

    expect(res.status).toBe(200);
    expect(res.body.cluster.status).toBe('resolved');

    // Confirm single action_log insert
    const insertCalls = (client.query.mock.calls as any[][]).filter(
      (call) => typeof call[0] === 'string' && call[0].includes('INSERT INTO action_log')
    );
    expect(insertCalls).toHaveLength(1);
  });
});

// =============================================================================
// 5. IMMUTABILITY — action_log cannot be modified/deleted via any exposed endpoint
// =============================================================================

describe('action_log immutability', () => {
  it('PUT on action_log — no such route exists (404)', async () => {
    const res = await request(app)
      .put('/api/action_log/1')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ note: 'Tampered note' });

    expect(res.status).toBe(404);
  });

  it('DELETE on action_log — no such route exists (404)', async () => {
    const res = await request(app)
      .delete('/api/action_log/1')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(404);
  });

  it('PATCH on action_log — no such route exists (404)', async () => {
    const res = await request(app)
      .patch('/api/action_log/1')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ note: 'Tampered' });

    expect(res.status).toBe(404);
  });
});

// =============================================================================
// 6. GET /api/clusters/:id/history
//    — returns entries newest-first with admin name/role joined
// =============================================================================

describe('GET /api/clusters/:id/history', () => {
  const historyRows = [
    {
      id: 3, cluster_id: 1, action_taken: 'status_change',
      previous_status: 'in_progress', new_status: 'resolved',
      note: 'Issue fixed by contractor', logged_at: new Date('2026-07-25T10:00:00Z'),
      admin_id: 10, admin_name: 'Alice Govt',  admin_role: 'govt',
    },
    {
      id: 2, cluster_id: 1, action_taken: 'status_change',
      previous_status: 'open', new_status: 'in_progress',
      note: null, logged_at: new Date('2026-07-24T09:00:00Z'),
      admin_id: 11, admin_name: 'Bob Admin', admin_role: 'admin',
    },
  ];

  it('returns 200 with history ordered newest-first for govt user', async () => {
    // Cluster check
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ id: 1, title: 'Road Damage', status: 'resolved' }] })
      .mockResolvedValueOnce({ rows: historyRows });

    const res = await request(app)
      .get('/api/clusters/CL-1/history')
      .set('Authorization', `Bearer ${govtToken}`);

    expect(res.status).toBe(200);
    expect(res.body.clusterId).toBe('CL-1');
    expect(res.body.currentStatus).toBe('resolved');
    expect(res.body.history).toHaveLength(2);

    // Newest first
    expect(res.body.history[0].id).toBe(3);
    expect(res.body.history[1].id).toBe(2);

    // Admin name and role are present
    expect(res.body.history[0].admin.name).toBe('Alice Govt');
    expect(res.body.history[0].admin.role).toBe('govt');
    expect(res.body.history[0].note).toBe('Issue fixed by contractor');

    // Null note for second entry
    expect(res.body.history[1].admin.name).toBe('Bob Admin');
    expect(res.body.history[1].note).toBeNull();
  });

  it('returns 200 with empty history array when no actions logged yet', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ id: 2, title: 'Park Issue', status: 'open' }] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .get('/api/clusters/CL-2/history')
      .set('Authorization', `Bearer ${ngoToken}`);

    expect(res.status).toBe(200);
    expect(res.body.history).toHaveLength(0);
  });

  it('returns 404 when cluster does not exist', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .get('/api/clusters/CL-9999/history')
      .set('Authorization', `Bearer ${govtToken}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toContain('not found');
  });

  it('returns 400 for malformed cluster ID', async () => {
    const res = await request(app)
      .get('/api/clusters/CL-abc/history')
      .set('Authorization', `Bearer ${govtToken}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Invalid cluster ID format');
  });

  it('citizen can GET /history (read-only access)', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ id: 1, title: 'Road Damage', status: 'resolved' }] })
      .mockResolvedValueOnce({ rows: historyRows });

    const res = await request(app)
      .get('/api/clusters/CL-1/history')
      .set('Authorization', `Bearer ${citizenToken}`);

    expect(res.status).toBe(200);
    expect(res.body.history).toHaveLength(2);
  });

  it('returns 500 gracefully when DB throws on GET /history', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ id: 1, title: 'Road Damage', status: 'open' }] })
      .mockRejectedValueOnce(new Error('DB timeout'));

    const res = await request(app)
      .get('/api/clusters/CL-1/history')
      .set('Authorization', `Bearer ${govtToken}`);

    expect(res.status).toBe(500);
    expect(res.body.error).toBeTruthy();
  });
});

// =============================================================================
// 7. ROLE GATING
// =============================================================================

describe('Role gating', () => {
  it('citizen gets 403 on PATCH /api/clusters/:id/status', async () => {
    const res = await request(app)
      .patch('/api/clusters/CL-1/status')
      .set('Authorization', `Bearer ${citizenToken}`)
      .send({ newStatus: 'in_progress' });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain('Insufficient permissions');
  });

  it('unauthenticated user gets 401 on PATCH /api/clusters/:id/status', async () => {
    const res = await request(app)
      .patch('/api/clusters/CL-1/status')
      .send({ newStatus: 'in_progress' });

    expect(res.status).toBe(401);
  });

  it('unauthenticated user gets 401 on GET /api/clusters/:id/history', async () => {
    const res = await request(app)
      .get('/api/clusters/CL-1/history');

    expect(res.status).toBe(401);
  });

  it('govt token can call PATCH /api/clusters/:id/status', async () => {
    const client = setupTransactionMocks([
      { rows: [] },
      { rows: [{ id: 1, status: 'open', title: 'Test', category: 'infrastructure', region: 'Downtown', severity_score: 50, complaint_count: 3, priority_score: 45, needs_review: false, recommended_action: null, created_at: new Date(), updated_at: new Date() }] },
      { rows: [{ id: 1, status: 'in_progress', title: 'Test', category: 'infrastructure', region: 'Downtown', severity_score: 50, complaint_count: 3, priority_score: 45, needs_review: false, updated_at: new Date() }] },
      { rows: [{ id: 55, cluster_id: 1, admin_id: 10, action_taken: 'status_change', previous_status: 'open', new_status: 'in_progress', note: null, logged_at: new Date() }] },
      { rows: [] },
    ]);

    const res = await request(app)
      .patch('/api/clusters/CL-1/status')
      .set('Authorization', `Bearer ${govtToken}`)
      .send({ newStatus: 'in_progress' });

    expect(res.status).toBe(200);
  });

  it('admin token can call PATCH /api/clusters/:id/status', async () => {
    setupTransactionMocks([
      { rows: [] },
      { rows: [{ id: 2, status: 'in_progress', title: 'Test2', category: 'sanitation', region: 'North', severity_score: 60, complaint_count: 4, priority_score: 55, needs_review: false, recommended_action: null, created_at: new Date(), updated_at: new Date() }] },
      { rows: [{ id: 2, status: 'resolved', title: 'Test2', category: 'sanitation', region: 'North', severity_score: 60, complaint_count: 4, priority_score: 55, needs_review: false, updated_at: new Date() }] },
      { rows: [{ id: 56, cluster_id: 2, admin_id: 11, action_taken: 'status_change', previous_status: 'in_progress', new_status: 'resolved', note: null, logged_at: new Date() }] },
      { rows: [] },
    ]);

    const res = await request(app)
      .patch('/api/clusters/CL-2/status')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ newStatus: 'resolved' });

    expect(res.status).toBe(200);
  });

  it('ngo token can call PATCH /api/clusters/:id/status', async () => {
    setupTransactionMocks([
      { rows: [] },
      { rows: [{ id: 3, status: 'escalated', title: 'Test3', category: 'noise', region: 'East', severity_score: 40, complaint_count: 2, priority_score: 35, needs_review: false, recommended_action: null, created_at: new Date(), updated_at: new Date() }] },
      { rows: [{ id: 3, status: 'in_progress', title: 'Test3', category: 'noise', region: 'East', severity_score: 40, complaint_count: 2, priority_score: 35, needs_review: false, updated_at: new Date() }] },
      { rows: [{ id: 57, cluster_id: 3, admin_id: 12, action_taken: 'status_change', previous_status: 'escalated', new_status: 'in_progress', note: null, logged_at: new Date() }] },
      { rows: [] },
    ]);

    const res = await request(app)
      .patch('/api/clusters/CL-3/status')
      .set('Authorization', `Bearer ${ngoToken}`)
      .send({ newStatus: 'in_progress' });

    expect(res.status).toBe(200);
  });
});

// =============================================================================
// 8. PATCH /status with note field
// =============================================================================

describe('PATCH /status with note', () => {
  it('stores the note in the action_log entry and returns it in the response', async () => {
    const note = 'Contractor dispatched to fix pothole at 5th Cross';

    const client = setupTransactionMocks([
      { rows: [] }, // BEGIN
      { rows: [{ id: 5, status: 'open', title: 'Pothole Cluster', category: 'infrastructure', region: 'Downtown', severity_score: 65, complaint_count: 6, priority_score: 58, needs_review: false, recommended_action: null, created_at: new Date(), updated_at: new Date() }] },
      { rows: [{ id: 5, status: 'in_progress', title: 'Pothole Cluster', category: 'infrastructure', region: 'Downtown', severity_score: 65, complaint_count: 6, priority_score: 58, needs_review: false, updated_at: new Date() }] },
      { rows: [{ id: 200, cluster_id: 5, admin_id: 10, action_taken: 'status_change', previous_status: 'open', new_status: 'in_progress', note, logged_at: new Date() }] },
      { rows: [] }, // COMMIT
    ]);

    const res = await request(app)
      .patch('/api/clusters/CL-5/status')
      .set('Authorization', `Bearer ${govtToken}`)
      .send({ newStatus: 'in_progress', note });

    expect(res.status).toBe(200);
    expect(res.body.logEntry.note).toBe(note);

    // Verify the note was passed in the INSERT statement
    const insertCall = (client.query.mock.calls as any[][]).find(
      (call) => typeof call[0] === 'string' && call[0].includes('INSERT INTO action_log')
    );
    expect(insertCall).toBeDefined();
    const insertParams = insertCall![1] as any[];
    // Params: [cluster_id, admin_id, previous_status, new_status, note]
    expect(insertParams[4]).toBe(note);
  });

  it('stores null note when note is omitted', async () => {
    const client = setupTransactionMocks([
      { rows: [] },
      { rows: [{ id: 6, status: 'in_progress', title: 'Noise Cluster', category: 'noise', region: 'West', severity_score: 45, complaint_count: 3, priority_score: 40, needs_review: false, recommended_action: null, created_at: new Date(), updated_at: new Date() }] },
      { rows: [{ id: 6, status: 'resolved', title: 'Noise Cluster', category: 'noise', region: 'West', severity_score: 45, complaint_count: 3, priority_score: 40, needs_review: false, updated_at: new Date() }] },
      { rows: [{ id: 201, cluster_id: 6, admin_id: 10, action_taken: 'status_change', previous_status: 'in_progress', new_status: 'resolved', note: null, logged_at: new Date() }] },
      { rows: [] },
    ]);

    const res = await request(app)
      .patch('/api/clusters/CL-6/status')
      .set('Authorization', `Bearer ${govtToken}`)
      .send({ newStatus: 'resolved' }); // no note field

    expect(res.status).toBe(200);
    expect(res.body.logEntry.note).toBeNull();

    const insertCall = (client.query.mock.calls as any[][]).find(
      (call) => typeof call[0] === 'string' && call[0].includes('INSERT INTO action_log')
    );
    const insertParams = insertCall![1] as any[];
    expect(insertParams[4]).toBeNull(); // null passed to DB
  });
});

// =============================================================================
// 9. CL- prefix and raw integer ID parsing
// =============================================================================

describe('Cluster ID parsing', () => {
  it('accepts CL-<n> prefix format', async () => {
    const client = setupTransactionMocks([
      { rows: [] },
      { rows: [{ id: 42, status: 'open', title: 'Test', category: 'utility', region: 'North', severity_score: 50, complaint_count: 2, priority_score: 45, needs_review: false, recommended_action: null, created_at: new Date(), updated_at: new Date() }] },
      { rows: [{ id: 42, status: 'in_progress', title: 'Test', category: 'utility', region: 'North', severity_score: 50, complaint_count: 2, priority_score: 45, needs_review: false, updated_at: new Date() }] },
      { rows: [{ id: 300, cluster_id: 42, admin_id: 10, action_taken: 'status_change', previous_status: 'open', new_status: 'in_progress', note: null, logged_at: new Date() }] },
      { rows: [] },
    ]);

    const res = await request(app)
      .patch('/api/clusters/CL-42/status')
      .set('Authorization', `Bearer ${govtToken}`)
      .send({ newStatus: 'in_progress' });

    expect(res.status).toBe(200);
    expect(res.body.cluster.id).toBe('CL-42');
  });

  it('accepts raw integer ID format', async () => {
    setupTransactionMocks([
      { rows: [] },
      { rows: [{ id: 7, status: 'open', title: 'Test Raw', category: 'safety', region: 'South', severity_score: 55, complaint_count: 1, priority_score: 50, needs_review: false, recommended_action: null, created_at: new Date(), updated_at: new Date() }] },
      { rows: [{ id: 7, status: 'in_progress', title: 'Test Raw', category: 'safety', region: 'South', severity_score: 55, complaint_count: 1, priority_score: 50, needs_review: false, updated_at: new Date() }] },
      { rows: [{ id: 301, cluster_id: 7, admin_id: 10, action_taken: 'status_change', previous_status: 'open', new_status: 'in_progress', note: null, logged_at: new Date() }] },
      { rows: [] },
    ]);

    const res = await request(app)
      .patch('/api/clusters/7/status')
      .set('Authorization', `Bearer ${govtToken}`)
      .send({ newStatus: 'in_progress' });

    expect(res.status).toBe(200);
  });
});

// =============================================================================
// 10. Error handling paths
// =============================================================================

describe('Error handling', () => {
  it('returns 500 gracefully when DB throws during PATCH /status', async () => {
    const client = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [] })           // BEGIN
        .mockRejectedValueOnce(new Error('DB crash')), // SELECT FOR UPDATE fails
      release: jest.fn(),
    };
    mockPool.connect.mockResolvedValue(client);

    const res = await request(app)
      .patch('/api/clusters/CL-1/status')
      .set('Authorization', `Bearer ${govtToken}`)
      .send({ newStatus: 'in_progress' });

    expect(res.status).toBe(500);
    expect(res.body.error).toBeTruthy();
    expect(client.release).toHaveBeenCalled(); // connection always released
  });
});
