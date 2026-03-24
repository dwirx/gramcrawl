import type { ExtractCacheEntry } from "../types";

export class CacheService {
  private readonly extractCache = new Map<string, ExtractCacheEntry>();

  constructor(private readonly maxEntries: number) {}

  get(key: string): ExtractCacheEntry | undefined {
    const entry = this.extractCache.get(key);
    if (entry && entry.expiresAt > Date.now()) {
      return entry;
    }
    if (entry) {
      this.extractCache.delete(key);
    }
    return undefined;
  }

  set(key: string, entry: ExtractCacheEntry): void {
    this.extractCache.set(key, entry);
    this.cleanup();
  }

  delete(key: string): void {
    this.extractCache.delete(key);
  }

  clearBySite(site: string): void {
    for (const [key, entry] of this.extractCache) {
      if (entry.extraction.site === site) {
        this.extractCache.delete(key);
      }
    }
  }

  clear(): void {
    this.extractCache.clear();
  }

  size(): number {
    return this.extractCache.size;
  }

  cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.extractCache) {
      if (entry.expiresAt <= now) {
        this.extractCache.delete(key);
      }
    }

    const overflow = this.extractCache.size - this.maxEntries;
    if (overflow <= 0) {
      return;
    }

    const oldest = [...this.extractCache.entries()]
      .sort((a, b) => a[1].createdAt - b[1].createdAt)
      .slice(0, overflow);
    for (const [key] of oldest) {
      this.extractCache.delete(key);
    }
  }
}
