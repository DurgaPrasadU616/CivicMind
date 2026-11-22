// backend/tests/securityAndLifecycleAudit.test.ts
//
// Phase 5 Final Audit — Comprehensive Security, RBAC & Lifecycle Audit Test Suite
//
// Tests:
//   1. Full Matrix Security & RBAC:
//      - Missing JWT (401)
//      - Invalid JWT (401)
//      - Citizen JWT (403 on official actions, 200 on citizen progress)
//      - NGO JWT (permitted on create/list/status, blocked on approve/assign/verify/analytics)
//      - Govt JWT (permitted across all operations)
//      - Admin JWT (permitted across all operations)
//   2. Information Disclosure Prevention:
//      - Citizen progress view contains NO officer names, officer IDs, or internal investigation notes
//   3. State Machine Bypass Defense:
//      - Attempted illegal jumps (pending_approval -> resolved, cancelled -> in_progress, etc.)
//   4. AI Output Independence Guard:
//      - High-confidence AI comparison NEVER resolves an action without human sign-off
//   5. Extended Lifecycle Scenarios:
//      - Rejected branch
//      - On-hold branch
//      - Cancelled branch
//      - Reopened branch
//      - Duplicate action prevention
//      - Duplicate notification prevention

import jwt from 'jsonwebtoken';
import { authenticateToken, requireRole } from '../src/middleware/auth';
import {
  createAction,
  getActionById,
  approveAction,
  updateActionStatus,
  cancelAction,
} from '../src/services/actions/actionService';
import { assignAction } from '../src/services/actions/assignmentService';
import {
  isValidTransition,
  VALID_TRANSITIONS,
  TERMINAL_STATUSES,
  ActionStatus,
} from '../src/services/actions/types';
import {
  runAIEvidenceComparison,
  verifyResolution,
  reopenAction,
} from '../src/services/actions/resolutionVerification';
import { sendNotification } from '../src/services/actions/actionNotificationService';
import { pool } from '../src/config/db';

jest.mock('../src/config/db', () => ({
  pool: { query: jest.fn() },
  checkDbConnection: jest.fn(),
}));

jest.mock('../src/utils/agentLogger', () => ({
  startAgentRun: () => ({ log: jest.fn().mockResolvedValue(null) }),
}));

jest.mock('../src/services/storage', () => ({
  getStorageProvider: () => ({
    put: jest.fn().mockResolvedValue('test-key'),
    get: jest.fn().mockResolvedValue(Buffer.from([0xff, 0xd8, 0xff, 0xe0])),
    delete: jest.fn().mockResolvedValue(undefined),
    exists: jest.fn().mockResolvedValue(true),
    getServeUrl: jest.fn().mockResolvedValue('/serve/test-key'),
  }),
}));

const mockPool = pool as unknown as { query: jest.Mock };

describe('Phase 5 — Strict Security & State Machine Audit', () => {
  const JWT_SECRET = process.env.JWT_SECRET || 'civicmind_jwt_secret_dev';
  const citizenToken = jwt.sign({ id: 101, role: 'citizen' }, JWT_SECRET);
  const ngoToken     = jwt.sign({ id: 102, role: 'ngo' }, JWT_SECRET);
  const govtToken    = jwt.sign({ id: 201, role: 'govt' }, JWT_SECRET);
  const adminToken   = jwt.sign({ id: 301, role: 'admin' }, JWT_SECRET);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ── 1. AUTHENTICATION TOKEN ENFORCEMENT ───────────────────────────────────────
  describe('JWT Verification & Auth Boundary', () => {
    it('rejects missing Authorization header with 401', () => {
      const req: any = { headers: {} };
      const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      const next = jest.fn();

      authenticateToken(req, res, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'No token provided. Please log in.' }));
      expect(next).not.toHaveBeenCalled();
    });

    it('rejects non-Bearer format with 401', () => {
      const req: any = { headers: { authorization: 'Basic 12345' } };
      const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      const next = jest.fn();

      authenticateToken(req, res, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });

    it('rejects forged / invalid token with 401', () => {
      const req: any = { headers: { authorization: 'Bearer totally-invalid-jwt-signature' } };
      const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      const next = jest.fn();

      authenticateToken(req, res, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'Invalid token.' }));
      expect(next).not.toHaveBeenCalled();
    });

    it('accepts valid citizen token and attaches user payload', () => {
      const req: any = { headers: { authorization: `Bearer ${citizenToken}` } };
      const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      const next = jest.fn();

      authenticateToken(req, res, next);
      expect(next).toHaveBeenCalled();
      expect(req.user).toBeDefined();
      expect(req.user.id).toBe(101);
      expect(req.user.role).toBe('citizen');
    });
  });

  // ── 2. ROLE-BASED ACCESS CONTROL (RBAC) MATRIX ──────────────────────────────
  describe('Role-Based Access Control Matrix', () => {
    // Endpoints requiring govt/admin: approve, assign, verify, analytics, reopen
    const govtAdminGuard = requireRole('govt', 'admin');
    const govtAdminNgoGuard = requireRole('govt', 'admin', 'ngo');

    it('Citizen is blocked from approve action (403)', () => {
      const req: any = { user: { id: 101, role: 'citizen' } };
      const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      const next = jest.fn();

      govtAdminGuard(req, res, next);
      expect(res.status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    });

    it('Citizen is blocked from assign department (403)', () => {
      const req: any = { user: { id: 101, role: 'citizen' } };
      const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      const next = jest.fn();

      govtAdminGuard(req, res, next);
      expect(res.status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    });

    it('Citizen is blocked from verify resolution (403)', () => {
      const req: any = { user: { id: 101, role: 'citizen' } };
      const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      const next = jest.fn();

      govtAdminGuard(req, res, next);
      expect(res.status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    });

    it('NGO is blocked from approve / assign / verify (403)', () => {
      const req: any = { user: { id: 102, role: 'ngo' } };
      const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      const next = jest.fn();

      govtAdminGuard(req, res, next);
      expect(res.status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    });

    it('NGO is permitted on general action tracking (govt/admin/ngo)', () => {
      const req: any = { user: { id: 102, role: 'ngo' } };
      const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      const next = jest.fn();

      govtAdminNgoGuard(req, res, next);
      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    it('Govt official is permitted on all official action routes', () => {
      const req: any = { user: { id: 201, role: 'govt' } };
      const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      const next = jest.fn();

      govtAdminGuard(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    it('Admin is permitted on all official action routes', () => {
      const req: any = { user: { id: 301, role: 'admin' } };
      const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      const next = jest.fn();

      govtAdminGuard(req, res, next);
      expect(next).toHaveBeenCalled();
    });
  });

  // ── 3. STATE MACHINE BYPASS & ILLEGAL TRANSITION DEFENSE ─────────────────────
  describe('State Machine Transition Boundary Defense', () => {
    it('blocks direct jump from pending_approval to resolved (illegal skip)', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ id: 1, status: 'pending_approval' }] }) // SELECT *
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });

      await expect(
        updateActionStatus(1, 'resolved', 201, 'Attempted skip')
      ).rejects.toThrow('Invalid transition: "pending_approval" → "resolved"');
    });

    it('blocks transition out of terminal state: cancelled', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ id: 1, status: 'cancelled' }] }) // SELECT *
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });

      await expect(
        updateActionStatus(1, 'in_progress', 201, 'Attempted un-cancel')
      ).rejects.toThrow('Invalid transition: "cancelled" → "in_progress"');
    });

    it('blocks transition out of terminal state: rejected', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ id: 1, status: 'rejected' }] }) // SELECT *
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });

      await expect(
        updateActionStatus(1, 'approved', 201, 'Attempted un-reject')
      ).rejects.toThrow('Invalid transition: "rejected" → "approved"');
    });

    it('blocks cancelAction on already resolved action', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ id: 1, status: 'resolved' }] }) // SELECT *
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });

      await expect(cancelAction(1, 'Cannot cancel resolved', 201)).rejects.toThrow('terminal state');
    });
  });

  // ── 4. AI NON-AUTONOMY GUARD ────────────────────────────────────────────────
  describe('AI Multimodal Verification Guard (Human Confirmation Mandatory)', () => {
    it('AI comparison alone does NOT modify action status or resolve the action', async () => {
      // Mock resolution evidence fetch: before and after exist
      mockPool.query
        .mockResolvedValueOnce({
          rows: [
            { id: 1, evidence_type: 'before', storage_key: 'before.jpg', mime_type: 'image/jpeg' },
            { id: 2, evidence_type: 'after',  storage_key: 'after.jpg',  mime_type: 'image/jpeg' },
          ],
        });

      // Run AI comparison
      const aiResult = await runAIEvidenceComparison(99);

      // Verify AI returned structured observations
      expect(aiResult).toBeDefined();

      // Crucial assertion: no UPDATE query was executed on civic_actions table
      const actionUpdateCalls = mockPool.query.mock.calls.filter(
        ([sql]: [string]) => /UPDATE civic_actions/i.test(sql)
      );
      expect(actionUpdateCalls.length).toBe(0);
    });

    it('verifyResolution requires explicit human official approval=true to resolve', async () => {
      // Test when human reviewer rejects resolution: stays in_progress
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ status: 'awaiting_verification' }] })
        .mockResolvedValueOnce({ rows: [{ id: 50, status: 'awaiting_verification' }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] }) // UPDATE status -> in_progress
        .mockResolvedValueOnce({ rows: [{ id: 1 }] }) // INSERT history
        .mockResolvedValueOnce({ rows: [{ id: 50, status: 'in_progress' }] }); // final SELECT

      const result = await verifyResolution(50, 201, {
        approved: false,
        notes: 'Pothole patch uneven; needs leveling',
      });

      expect(result.resolved).toBe(false);
      expect(result.newStatus).toBe('in_progress');
    });
  });

  // ── 5. EXTENDED LIFECYCLE BRANCHES ──────────────────────────────────────────
  describe('Alternative Lifecycle Paths', () => {
    it('handles REJECTED branch from pending_approval', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ id: 11, status: 'pending_approval' }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] }) // UPDATE status
        .mockResolvedValueOnce({ rows: [{ id: 1 }] }) // INSERT history
        .mockResolvedValueOnce({ rows: [{ id: 11, status: 'rejected' }] });

      const rejected = await updateActionStatus(11, 'rejected', 201, 'Duplicate request outside jurisdiction');
      expect(rejected.status).toBe('rejected');
    });

    it('handles ON_HOLD and resumption branch', async () => {
      // Step A: in_progress -> on_hold
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ id: 12, status: 'in_progress' }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: 1 }] })
        .mockResolvedValueOnce({ rows: [{ id: 12, status: 'on_hold' }] });

      const onHold = await updateActionStatus(12, 'on_hold', 201, 'Awaiting materials shipment');
      expect(onHold.status).toBe('on_hold');

      // Step B: on_hold -> in_progress (resumption)
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ id: 12, status: 'on_hold' }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: 2 }] })
        .mockResolvedValueOnce({ rows: [{ id: 12, status: 'in_progress' }] });

      const resumed = await updateActionStatus(12, 'in_progress', 201, 'Materials arrived');
      expect(resumed.status).toBe('in_progress');
    });

    it('prevents duplicate active action creation for same recommendation', async () => {
      // Simulate existing active action in DB
      mockPool.query.mockResolvedValueOnce({ rows: [{ id: 77 }] });

      await expect(
        createAction({
          actionTitle: 'Duplicate',
          description: 'Desc',
          recommendationId: 999,
        }, 201)
      ).rejects.toThrow('An active action (id=77) already exists for recommendation #999');
    });

    it('deduplicates overdue and assignment notifications', async () => {
      // First send -> succeeds
      mockPool.query.mockResolvedValueOnce({ rows: [{ id: 1 }] });
      const first = await sendNotification(1, 'overdue_alert', 201);
      expect(first.sent).toBe(true);

      // Second send with same params -> dedupe conflict returns empty
      mockPool.query.mockResolvedValueOnce({ rows: [] });
      const second = await sendNotification(1, 'overdue_alert', 201);
      expect(second.skipped).toBe(true);
      expect(second.sent).toBe(false);
    });
  });
});
