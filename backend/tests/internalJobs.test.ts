import express from 'express';
import request from 'supertest';

jest.mock('../src/services/complaintMediaService', () => ({
  runMediaAnalysisJob: jest.fn(),
  recoverStaleMediaJobs: jest.fn(),
}));

jest.mock('../src/utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import internalJobsRouter from '../src/routes/internalJobs';
import { recoverStaleMediaJobs } from '../src/services/complaintMediaService';

const mockRecover = recoverStaleMediaJobs as jest.Mock;
const app = express();
app.use(express.json());
app.use(internalJobsRouter);

describe('media recovery endpoint', () => {
  beforeEach(() => {
    process.env.CRON_SECRET = 'test-cron-secret';
    mockRecover.mockReset();
  });

  afterAll(() => {
    delete process.env.CRON_SECRET;
  });

  it('rejects calls without the configured CRON_SECRET', async () => {
    const response = await request(app).post('/api/internal/jobs/media-recover');

    expect(response.status).toBe(401);
    expect(mockRecover).not.toHaveBeenCalled();
  });

  it('preserves bounded batch size and returns the recovery summary', async () => {
    mockRecover.mockResolvedValue({
      scanned: 50,
      recovered: 42,
      skipped: 3,
      failed: 4,
      exhausted: 1,
    });

    const response = await request(app)
      .post('/api/internal/jobs/media-recover?limit=500')
      .set('Authorization', 'Bearer test-cron-secret');

    expect(response.status).toBe(200);
    expect(mockRecover).toHaveBeenCalledWith(50);
    expect(response.body).toMatchObject({
      ok: true,
      scanned: 50,
      recovered: 42,
      skipped: 3,
      failed: 4,
      exhausted: 1,
    });
  });

  it('does not expose recovery exception details in the response', async () => {
    mockRecover.mockRejectedValue(new Error('private database connection detail'));

    const response = await request(app)
      .get('/api/internal/jobs/media-recover')
      .set('Authorization', 'Bearer test-cron-secret');

    expect(response.status).toBe(500);
    expect(response.body.error).toBe('Media recovery sweep failed.');
    expect(JSON.stringify(response.body)).not.toContain('private database connection detail');
  });
});
