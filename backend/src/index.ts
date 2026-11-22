import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { env } from './config/env';
import healthRouter from './routes/health';
import complaintsRouter from './routes/complaints';
import clustersRouter from './routes/clusters';
import authRouter from './routes/auth';
import ingestRouter from './routes/ingest';
import analyticsRouter from './routes/analytics';
import mediaRouter from './routes/media';
import investigationsRouter from './routes/investigations';
import actionsRouter from './routes/actions';
import internalJobsRouter from './routes/internalJobs';
import { seedStartupData } from './config/startupSeeds';
import logger from './utils/logger';
import docsRouter from './routes/docs';

const app = express();

// Apply middleware
app.use(helmet());
app.use(
  cors({
    origin: env.FRONTEND_URL,
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);
app.use(
  express.json({
    // Capture the raw body for QStash signature verification.
    verify: (req: express.Request, _res, buf) => {
      (req as any).rawBody = buf;
    },
  })
);

// Routes
app.get('/', (req, res) => {
  res.json({ message: 'CivicMind API is running' });
});

const apiRouter = express.Router();
apiRouter.use(authRouter);
apiRouter.use(complaintsRouter);
apiRouter.use(clustersRouter);
apiRouter.use(ingestRouter);
apiRouter.use(analyticsRouter);
apiRouter.use(mediaRouter);
apiRouter.use(investigationsRouter);
apiRouter.use(actionsRouter);

app.use(healthRouter);
app.use(internalJobsRouter);
app.use('/api', docsRouter);
app.use('/api/v1', apiRouter);
app.use('/api', apiRouter); // Backward compatibility

// Centralized error handling middleware
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  logger.error('❌ Unhandled Server Error:', err);
  res.status(500).json({ error: 'An unexpected internal server error occurred.' });
});

// Avoid binding port in test environment to prevent EADDRINUSE conflicts
if (env.NODE_ENV !== 'test') {
  app.listen(env.PORT, async () => {
    logger.info(`🚀 CivicMind Backend listening on port ${env.PORT} in ${env.NODE_ENV} mode`);
    await seedStartupData(env.NODE_ENV);
  });
}

export default app;
