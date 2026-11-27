import { apiFetch } from './api';

const CACHE_PREFIX = 'htv_api_cache:';
const DEFAULT_TTL_MS = 45_000;

// Strict safety allowlist: never cache auth, private messages, admin, or user PII routes
const ALLOWED_PUBLIC_PREFIXES = [
  '/api/posts',
  '/api/circles',
  '/api/videos',
  '/api/people',
];

const BLOCKED_SUBSTRINGS = [
  '/api/auth',
  '/api/conversations',
  '/api/notifications',
  '/api/admin',
  '/automation',
  '/inquiries',
  '/follow-requests',
  '/pending',
];

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
  cachedAt: number;
}

function isCacheablePath(path: string): boolean {
  if (!ALLOWED_PUBLIC_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    return false;
  }
  return !BLOCKED_SUBSTRINGS.some((blocked) => path.includes(blocked));
}

function buildKey(userId: number | string, path: string): string {
  return `${CACHE_PREFIX}u${userId}:${path}`;
}

function pruneExpiredEntries(): void {
  try {
    const now = Date.now();
    const toRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(CACHE_PREFIX)) continue;
      try {
        const parsed = JSON.parse(localStorage.getItem(key) || 'null') as CacheEntry<unknown> | null;
        if (!parsed || typeof parsed.expiresAt !== 'number' || parsed.expiresAt <= now) {
          toRemove.push(key);
        }
      } catch {
        toRemove.push(key);
      }
    }
    for (const k of toRemove) {
      localStorage.removeItem(k);
    }
  } catch {
    // Ignore storage unavailability
  }
}

export function readCachedEntry<T>(userId: number | string, path: string): T | null {
  if (typeof window === 'undefined' || !isCacheablePath(path)) return null;
  try {
    const raw = localStorage.getItem(buildKey(userId, path));
    if (!raw) return null;
    const entry = JSON.parse(raw) as CacheEntry<T>;
    if (!entry || typeof entry.expiresAt !== 'number' || Date.now() >= entry.expiresAt) {
      localStorage.removeItem(buildKey(userId, path));
      return null;
    }
    return entry.data;
  } catch {
    return null;
  }
}

export function writeCachedEntry<T>(
  userId: number | string,
  path: string,
  data: T,
  ttlMs: number = DEFAULT_TTL_MS
): void {
  if (typeof window === 'undefined' || !isCacheablePath(path)) return;
  const key = buildKey(userId, path);
  const payload = JSON.stringify({
    data,
    cachedAt: Date.now(),
    expiresAt: Date.now() + Math.max(1000, ttlMs),
  } satisfies CacheEntry<T>);

  try {
    localStorage.setItem(key, payload);
  } catch {
    // Reclaim expired items once on quota pressure; skip silently if still full
    pruneExpiredEntries();
    try {
      localStorage.setItem(key, payload);
    } catch {
      // Ignore storage quota errors
    }
  }
}

/**
 * Invalidates cached entries matching a path prefix (or all entries for a user).
 * Call after mutations (create/delete/like/comment/follow/approve) to keep UI consistent.
 */
export function invalidateApiCache(userId?: number | string, pathPrefix?: string): void {
  if (typeof window === 'undefined') return;
  try {
    const userPrefix = userId !== undefined ? `${CACHE_PREFIX}u${userId}:` : CACHE_PREFIX;
    const matchPrefix = pathPrefix ? `${userPrefix}${pathPrefix}` : userPrefix;
    const toRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(matchPrefix)) {
        toRemove.push(key);
      }
    }
    for (const k of toRemove) {
      localStorage.removeItem(k);
    }
  } catch {
    // Ignore storage errors
  }
}

export async function cachedApiFetch<T = any>(
  path: string,
  options: {
    userId: number | string;
    ttlMs?: number;
    forceRefresh?: boolean;
    onRevalidated?: (freshData: T) => void;
  }
): Promise<T> {
  const { userId, ttlMs = DEFAULT_TTL_MS, forceRefresh = false, onRevalidated } = options;

  if (!forceRefresh) {
    const cached = readCachedEntry<T>(userId, path);
    if (cached !== null) {
      // Background revalidation (stale-while-revalidate feel without blocking paint)
      if (onRevalidated) {
        void apiFetch<T>(path)
          .then((fresh) => {
            writeCachedEntry(userId, path, fresh, ttlMs);
            onRevalidated(fresh);
          })
          .catch(() => {
            // Keep cached response if offline or network slow
          });
      }
      return cached;
    }
  }

  const fresh = await apiFetch<T>(path);
  writeCachedEntry(userId, path, fresh, ttlMs);
  return fresh;
}
