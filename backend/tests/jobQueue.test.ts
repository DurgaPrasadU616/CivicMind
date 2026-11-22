// backend/tests/jobQueue.test.ts
//
// Tests for:
//   1. enqueue() — returns a UUID job ID
//   2. enqueue() — calls backgroundQueue.enqueue() with the wrapped execute fn
//   3. enqueue() — maxRetries option is forwarded to backgroundQueue
//   4. getQueueStatus() — returns correct shape (in-process, no Redis)
//   5. getQueueStatus() — redisBridgeEnabled reflects REDIS_URL env var
//   6. wrappedExecute — logs success when inner fn resolves
//   7. wrappedExecute — re-throws and logs error when inner fn rejects
//   8. jobQueue default export — has enqueue and getQueueStatus
//   9. backgroundQueue re-export — available from jobQueue module

// ── Mocks ─────────────────────────────────────────────────────────────────────

// Mock the in-process queue so no real async work runs in tests
jest.mock('../src/services/backgroundQueue', () => ({
  backgroundQueue: {
    enqueue: jest.fn(),
    get queueLength() { return 3; },
    get activeJobCount() { return 1; },
  },
}));

// Suppress logger output in tests
jest.mock('../src/utils/logger', () => ({
  __esModule: true,
  default: {
    info:  jest.fn(),
    warn:  jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { enqueue, getQueueStatus, backgroundQueue, jobQueue } from '../src/services/jobQueue';
import { backgroundQueue as mockedBgQueue } from '../src/services/backgroundQueue';
import logger from '../src/utils/logger';

const mockBgEnqueue = mockedBgQueue.enqueue as jest.Mock;
const mockLogger    = logger as unknown as {
  info: jest.Mock; warn: jest.Mock; error: jest.Mock; debug: jest.Mock;
};

// UUID pattern
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

beforeEach(() => {
  jest.clearAllMocks();
  // Ensure REDIS_URL is absent by default
  delete process.env.REDIS_URL;
});

// =============================================================================
// 1. enqueue — returns a UUID job ID
// =============================================================================
describe('enqueue() — return value', () => {
  it('returns a UUID string', () => {
    const jobId = enqueue('test_job', async () => {});
    expect(typeof jobId).toBe('string');
    expect(jobId).toMatch(UUID_RE);
  });

  it('returns a different UUID on each call', () => {
    const id1 = enqueue('job_a', async () => {});
    const id2 = enqueue('job_b', async () => {});
    expect(id1).not.toBe(id2);
  });
});

// =============================================================================
// 2. enqueue — calls backgroundQueue.enqueue() with wrapped fn
// =============================================================================
describe('enqueue() — delegates to backgroundQueue', () => {
  it('calls backgroundQueue.enqueue() once with the job name and a function', () => {
    enqueue('my_job', async () => {});

    expect(mockBgEnqueue).toHaveBeenCalledTimes(1);
    const [name, fn, opts] = mockBgEnqueue.mock.calls[0];
    expect(name).toBe('my_job');
    expect(typeof fn).toBe('function');   // wrapped execute
    expect(opts).toHaveProperty('maxRetries');
  });

  it('logs an enqueue info message', () => {
    enqueue('info_job', async () => {});
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining('Enqueued job "info_job"')
    );
  });
});

// =============================================================================
// 3. enqueue — maxRetries option is forwarded
// =============================================================================
describe('enqueue() — options', () => {
  it('forwards default maxRetries=3 when not supplied', () => {
    enqueue('default_retries', async () => {});
    const [, , opts] = mockBgEnqueue.mock.calls[0];
    expect(opts.maxRetries).toBe(3);
  });

  it('forwards custom maxRetries when supplied', () => {
    enqueue('custom_retries', async () => {}, { maxRetries: 5 });
    const [, , opts] = mockBgEnqueue.mock.calls[0];
    expect(opts.maxRetries).toBe(5);
  });

  it('passes maxRetries=0 when explicitly set to 0', () => {
    enqueue('no_retries', async () => {}, { maxRetries: 0 });
    const [, , opts] = mockBgEnqueue.mock.calls[0];
    expect(opts.maxRetries).toBe(0);
  });
});

// =============================================================================
// 4. getQueueStatus — shape (no Redis)
// =============================================================================
describe('getQueueStatus() — in-process (no REDIS_URL)', () => {
  it('returns the expected shape', () => {
    const status = getQueueStatus();
    expect(status).toEqual({
      engine: 'in-process',
      redisBridgeEnabled: false,
      pendingJobs: 3,   // from mock getter queueLength
      activeJobs:  1,   // from mock getter activeJobCount
    });
  });

  it('engine is always "in-process" in Phase 1', () => {
    expect(getQueueStatus().engine).toBe('in-process');
  });
});

// =============================================================================
// 5. getQueueStatus — redisBridgeEnabled reflects REDIS_URL
// =============================================================================
describe('getQueueStatus() — redisBridgeEnabled', () => {
  it('is false when REDIS_URL is not set', () => {
    delete process.env.REDIS_URL;
    expect(getQueueStatus().redisBridgeEnabled).toBe(false);
  });

  it('is true when REDIS_URL is set', () => {
    process.env.REDIS_URL = 'redis://localhost:6379';
    expect(getQueueStatus().redisBridgeEnabled).toBe(true);
    delete process.env.REDIS_URL;
  });
});

// =============================================================================
// 6. wrappedExecute — logs success when inner fn resolves
// =============================================================================
describe('wrappedExecute — success path', () => {
  it('calls the inner execute function and logs a completion message', async () => {
    const innerFn = jest.fn().mockResolvedValue(undefined);
    enqueue('success_job', innerFn);

    // Extract the wrappedExecute passed to backgroundQueue.enqueue()
    const [, wrappedExecute] = mockBgEnqueue.mock.calls[0];
    await wrappedExecute();

    expect(innerFn).toHaveBeenCalledTimes(1);
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining('completed in')
    );
    expect(mockLogger.error).not.toHaveBeenCalled();
  });
});

// =============================================================================
// 7. wrappedExecute — re-throws and logs error when inner fn rejects
// =============================================================================
describe('wrappedExecute — failure path', () => {
  it('re-throws the error so BackgroundQueue retry logic still applies', async () => {
    const boom = new Error('simulated task failure');
    const innerFn = jest.fn().mockRejectedValue(boom);
    enqueue('failing_job', innerFn);

    const [, wrappedExecute] = mockBgEnqueue.mock.calls[0];

    await expect(wrappedExecute()).rejects.toThrow('simulated task failure');
  });

  it('logs an error message on failure', async () => {
    const innerFn = jest.fn().mockRejectedValue(new Error('task error'));
    enqueue('error_logged_job', innerFn);

    const [, wrappedExecute] = mockBgEnqueue.mock.calls[0];

    await wrappedExecute().catch(() => {/* expected */});

    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('failed after')
    );
  });

  it('does NOT swallow errors (always re-throws)', async () => {
    const innerFn = jest.fn().mockRejectedValue(new Error('must propagate'));
    enqueue('propagate_job', innerFn);

    const [, wrappedExecute] = mockBgEnqueue.mock.calls[0];

    let threw = false;
    try {
      await wrappedExecute();
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});

// =============================================================================
// 8. jobQueue default export — convenience object
// =============================================================================
describe('jobQueue default export', () => {
  it('exposes enqueue and getQueueStatus', () => {
    expect(typeof jobQueue.enqueue).toBe('function');
    expect(typeof jobQueue.getQueueStatus).toBe('function');
  });

  it('jobQueue.enqueue() behaves identically to named enqueue()', () => {
    const jobId = jobQueue.enqueue('via_default', async () => {});
    expect(jobId).toMatch(UUID_RE);
    expect(mockBgEnqueue).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
// 9. backgroundQueue re-export
// =============================================================================
describe('backgroundQueue re-export', () => {
  it('re-exports backgroundQueue from jobQueue module', () => {
    // The re-export must be the same mocked instance
    expect(backgroundQueue).toBeDefined();
    expect(typeof backgroundQueue.enqueue).toBe('function');
  });
});
