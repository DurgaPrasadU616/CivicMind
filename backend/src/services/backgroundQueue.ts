import logger from '../utils/logger';

interface QueueJob {
  id: string;
  name: string;
  execute: () => Promise<void>;
  retries: number;
  maxRetries: number;
  createdAt: Date;
}

class BackgroundQueue {
  private queue: QueueJob[] = [];
  private processing = false;
  private maxConcurrency = 5;
  private activeCount = 0;

  enqueue(
    name: string,
    execute: () => Promise<void>,
    options?: { maxRetries?: number }
  ): string {
    const id = `job_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    this.queue.push({
      id,
      name,
      execute,
      retries: 0,
      maxRetries: options?.maxRetries ?? 3,
      createdAt: new Date(),
    });
    logger.debug(`Job queued: ${name} (${id})`);
    setImmediate(() => this.processNext());
    return id;
  }

  private async processNext(): Promise<void> {
    if (this.processing || this.activeCount >= this.maxConcurrency) return;
    if (this.queue.length === 0) return;

    this.processing = true;

    while (this.queue.length > 0 && this.activeCount < this.maxConcurrency) {
      const job = this.queue.shift()!;
      this.activeCount++;
      this.runJob(job).finally(() => {
        this.activeCount--;
        this.processing = false;
        this.processNext();
      });
    }

    this.processing = false;
  }

  private async runJob(job: QueueJob): Promise<void> {
    try {
      await job.execute();
      logger.info(`Job completed: ${job.name} (${job.id})`);
    } catch (error) {
      if (job.retries < job.maxRetries) {
        job.retries++;
        const delay = Math.pow(2, job.retries) * 1000;
        logger.warn(
          `Job failed: ${job.name} (${job.id}), retry ${job.retries}/${job.maxRetries} in ${delay}ms`,
          { error: (error as Error).message }
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        this.queue.push(job);
        this.processNext();
      } else {
        logger.error(
          `Job failed permanently: ${job.name} (${job.id}) after ${job.retries} retries`,
          { error: (error as Error).message }
        );
      }
    }
  }

  get queueLength(): number {
    return this.queue.length;
  }

  get activeJobCount(): number {
    return this.activeCount;
  }
}

export const backgroundQueue = new BackgroundQueue();