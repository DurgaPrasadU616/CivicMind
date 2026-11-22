import { logger } from './logger';

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

class MemoryCache {
  private store: Map<string, CacheEntry<unknown>> = new Map();
  private hitCount = 0;
  private missCount = 0;
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor() {
    this.cleanupInterval = setInterval(() => this.cleanup(), 60_000);
    this.cleanupInterval.unref();
  }

  get<T>(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) {
      this.missCount++;
      return undefined;
    }
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      this.missCount++;
      return undefined;
    }
    this.hitCount++;
    return entry.value as T;
  }

  set<T>(key: string, value: T, ttlMs: number = 60_000): void {
    this.store.set(key, {
      value,
      expiresAt: Date.now() + ttlMs,
    });
  }

  del(key: string): void {
    this.store.delete(key);
  }

  delByPrefix(prefix: string): void {
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
      }
    }
  }

  flush(): void {
    this.store.clear();
    this.hitCount = 0;
    this.missCount = 0;
  }

  private cleanup(): void {
    const now = Date.now();
    let expired = 0;
    for (const [key, entry] of this.store.entries()) {
      if (now > entry.expiresAt) {
        this.store.delete(key);
        expired++;
      }
    }
    if (expired > 0) {
      logger.debug(`Cache cleanup: removed ${expired} expired entries`);
    }
  }

  get stats() {
    return {
      size: this.store.size,
      hitRate: this.hitCount + this.missCount > 0
        ? Math.round((this.hitCount / (this.hitCount + this.missCount)) * 100)
        : 0,
    };
  }

  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    this.flush();
  }
}

export const cache = new MemoryCache();