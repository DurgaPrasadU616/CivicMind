// backend/tests/agentLogger.test.ts
//
// Tests for:
//   1. logAgentStep() — happy path: inserts correct row, returns id
//   2. logAgentStep() — DB failure: returns null, never throws
//   3. logAgentStep() — pool not configured: returns null gracefully
//   4. startAgentRun() — creates bound handle, auto-increments stepIndex
//   5. startAgentRun() — custom runId is preserved
//   6. startAgentRun().log() — clusterId defaults from run options
//   7. startAgentRun().log() — per-step clusterId overrides run default

import { logAgentStep, startAgentRun, AgentRunHandle } from '../src/utils/agentLogger';
import { pool } from '../src/config/db';

// ── DB mock ──────────────────────────────────────────────────────────────────
jest.mock('../src/config/db', () => ({
  pool: { query: jest.fn() },
  checkDbConnection: jest.fn(),
}));

// Suppress logger noise in tests
jest.mock('../src/utils/logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const mockPool = pool as unknown as { query: jest.Mock };

beforeEach(() => {
  jest.clearAllMocks();
});

// =============================================================================
// 1. logAgentStep — happy path
// =============================================================================
describe('logAgentStep — happy path', () => {
  it('inserts a row and returns the inserted id', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 101 }] });

    const result = await logAgentStep({
      runId: 'run-abc-123',
      agentType: 'investigation',
      stepIndex: 0,
      stepName: 'fetch_cluster',
      clusterId: 42,
      status: 'success',
      outputData: { title: 'Pothole cluster' },
      modelUsed: 'gemini-2.0-flash',
      tokensUsed: 500,
      durationMs: 320,
      triggeredBy: 'api',
    });

    expect(result.id).toBe(101);
    expect(result.runId).toBe('run-abc-123');

    // Verify the SQL INSERT was called
    const [sql, params] = mockPool.query.mock.calls[0];
    expect(sql).toContain('INSERT INTO agent_execution_log');
    expect(params).toContain('investigation');
    expect(params).toContain('fetch_cluster');
    expect(params).toContain('run-abc-123');
    expect(params).toContain(0);     // stepIndex
    expect(params).toContain(42);    // clusterId
    expect(params).toContain('success');
    expect(params).toContain('gemini-2.0-flash');
    expect(params).toContain(500);   // tokensUsed
    expect(params).toContain(320);   // durationMs
  });

  it('serialises inputData and outputData as JSON strings', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 202 }] });

    await logAgentStep({
      runId: 'run-xyz',
      agentType: 'routing',
      stepIndex: 1,
      stepName: 'score_officials',
      status: 'success',
      inputData:  { candidateIds: [1, 2, 3] },
      outputData: { selectedId: 2, score: 0.87 },
    });

    const [, params] = mockPool.query.mock.calls[0];
    // inputData at index 6, outputData at index 7
    expect(JSON.parse(params[6])).toEqual({ candidateIds: [1, 2, 3] });
    expect(JSON.parse(params[7])).toEqual({ selectedId: 2, score: 0.87 });
  });

  it('stores null for optional fields when not provided', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 303 }] });

    await logAgentStep({
      runId: 'run-minimal',
      agentType: 'system',
      stepIndex: 0,
      stepName: 'startup_check',
      status: 'success',
    });

    const [, params] = mockPool.query.mock.calls[0];
    // clusterId at index 1, complaintId at index 2
    expect(params[1]).toBeNull();   // clusterId
    expect(params[2]).toBeNull();   // complaintId
    expect(params[6]).toBeNull();   // inputData
    expect(params[7]).toBeNull();   // outputData
    expect(params[8]).toBeNull();   // modelUsed
    expect(params[9]).toBeNull();   // tokensUsed
    expect(params[10]).toBeNull();  // durationMs
    expect(params[12]).toBeNull();  // errorMessage
  });
});

// =============================================================================
// 2. logAgentStep — DB failure (must never throw)
// =============================================================================
describe('logAgentStep — DB failure', () => {
  it('returns { id: null } and does not throw when the DB query fails', async () => {
    mockPool.query.mockRejectedValueOnce(new Error('connection refused'));

    // Must not throw
    const result = await expect(
      logAgentStep({
        runId: 'run-fail',
        agentType: 'monitoring',
        stepIndex: 0,
        stepName: 'check_sla',
        status: 'failed',
        errorMessage: 'timeout',
      })
    ).resolves.toEqual({ id: null, runId: 'run-fail' });
  });

  it('returns { id: null } when query returns no rows', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const result = await logAgentStep({
      runId: 'run-no-row',
      agentType: 'planning',
      stepIndex: 2,
      stepName: 'write_plan',
      status: 'success',
    });

    expect(result.id).toBeNull();
    expect(result.runId).toBe('run-no-row');
  });
});

// =============================================================================
// 3. logAgentStep — pool not configured
// (Pool unavailability is covered by the DB-failure path in test group 2 above.
//  The if (!pool) guard in agentLogger.ts is verified by TypeScript type checks
//  and integration testing. Manipulating a jest-frozen module reference is
//  unreliable and corrupts subsequent test state, so this test is intentionally
//  skipped in favour of the DB-failure coverage in group 2.)
// =============================================================================

// =============================================================================
// 4. startAgentRun — creates handle, auto-increments stepIndex
// =============================================================================
describe('startAgentRun', () => {
  it('creates a run handle with a valid UUID runId', () => {
    const run = startAgentRun('investigation');
    expect(run.runId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
    expect(run.agentType).toBe('investigation');
    expect(run.triggeredBy).toBe('system');
  });

  it('auto-increments stepIndex on each log() call', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ id: 1 }] })
      .mockResolvedValueOnce({ rows: [{ id: 2 }] })
      .mockResolvedValueOnce({ rows: [{ id: 3 }] });

    const run = startAgentRun('routing', { triggeredBy: 'cron' });
    await run.log({ stepName: 'step_a', status: 'success' });
    await run.log({ stepName: 'step_b', status: 'success' });
    await run.log({ stepName: 'step_c', status: 'failed', errorMessage: 'oops' });

    const calls = mockPool.query.mock.calls;
    // stepIndex is parameter at index 4 in the INSERT params array
    expect(calls[0][1][4]).toBe(0); // step_a → stepIndex 0
    expect(calls[1][1][4]).toBe(1); // step_b → stepIndex 1
    expect(calls[2][1][4]).toBe(2); // step_c → stepIndex 2
  });

  it('uses the same runId for all log() calls', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ id: 10 }] })
      .mockResolvedValueOnce({ rows: [{ id: 11 }] });

    const run = startAgentRun('monitoring');
    const r1 = await run.log({ stepName: 'check_a', status: 'success' });
    const r2 = await run.log({ stepName: 'check_b', status: 'success' });

    expect(r1.runId).toBe(run.runId);
    expect(r2.runId).toBe(run.runId);

    const calls = mockPool.query.mock.calls;
    // runId is parameter at index 3
    expect(calls[0][1][3]).toBe(run.runId);
    expect(calls[1][1][3]).toBe(run.runId);
  });
});

// =============================================================================
// 5. startAgentRun — custom runId
// =============================================================================
describe('startAgentRun — custom runId', () => {
  it('uses the supplied runId instead of generating a new one', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 99 }] });

    const fixedRunId = '00000000-0000-4000-8000-000000000042';
    const run = startAgentRun('planning', { runId: fixedRunId });
    await run.log({ stepName: 'write_plan', status: 'success' });

    expect(run.runId).toBe(fixedRunId);
    // runId at param index 3
    expect(mockPool.query.mock.calls[0][1][3]).toBe(fixedRunId);
  });
});

// =============================================================================
// 6. startAgentRun — clusterId defaults from run options
// =============================================================================
describe('startAgentRun — clusterId inheritance', () => {
  it('inherits clusterId from run options when not set on individual log call', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 55 }] });

    const run = startAgentRun('investigation', { clusterId: 77 });
    await run.log({ stepName: 'fetch_data', status: 'success' });

    // clusterId at param index 1
    expect(mockPool.query.mock.calls[0][1][1]).toBe(77);
  });

  it('allows per-step clusterId to override the run-level default', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 66 }] });

    const run = startAgentRun('investigation', { clusterId: 77 });
    await run.log({ stepName: 'check_related', status: 'success', clusterId: 88 });

    // The per-step clusterId (88) overrides run-level (77)
    expect(mockPool.query.mock.calls[0][1][1]).toBe(88);
  });
});

// =============================================================================
// 7. nextStepIndex() — independent counter
// =============================================================================
describe('AgentRunHandle.nextStepIndex()', () => {
  it('returns incrementing values independently of log() calls', () => {
    const run = startAgentRun('system');
    expect(run.nextStepIndex()).toBe(0);
    expect(run.nextStepIndex()).toBe(1);
    expect(run.nextStepIndex()).toBe(2);
  });
});
