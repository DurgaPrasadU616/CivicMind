import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { env } from './config/env';
import healthRouter from './routes/health';
import complaintsRouter from './routes/complaints';
import authRouter from './routes/auth';
import { seedDatabaseIfEmpty } from './config/seed';

const app = express();

// Apply middleware
app.use(helmet());
app.use(
  cors({
    origin: env.FRONTEND_URL,
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);
app.use(express.json());

// Routes
app.use(healthRouter);
app.use('/api', authRouter);
app.use('/api', complaintsRouter);

// Centralized error handling middleware
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('❌ Unhandled Server Error:', err);
  res.status(500).json({ error: 'An unexpected internal server error occurred.' });
});

// Avoid binding port in test environment to prevent EADDRINUSE conflicts
if (env.NODE_ENV !== 'test') {
  app.listen(env.PORT, async () => {
    console.log(`🚀 CivicMind Backend listening on port ${env.PORT} in ${env.NODE_ENV} mode`);
    await seedDatabaseIfEmpty();
  });
}

export default app;
