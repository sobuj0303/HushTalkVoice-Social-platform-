import { classifyAllowedMedia, type MediaCategory } from '../shared/validation';

const TOKEN_KEY = 'htv_token';

export function getStoredToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setStoredToken(token: string | null): void {
  try {
    if (token) {
      localStorage.setItem(TOKEN_KEY, token);
    } else {
      localStorage.removeItem(TOKEN_KEY);
    }
  } catch {
    // Ignore storage errors
  }
}

export async function apiFetch<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getStoredToken();
  const headers = new Headers(init.headers || {});
  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers,
      credentials: 'include',
    });
  } catch (err: any) {
    if (err?.name === 'AbortError') throw err;
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    throw new Error(
      offline
        ? 'You are offline. Reconnect to the internet and try again.'
        : 'Network error — could not reach HushTalkVoice server.'
    );
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error || `Request failed (${res.status})`);
  }
  return data as T;
}

export async function uploadMediaFile(
  file: File,
  expectedCategory?: MediaCategory,
  options?: { maxMb?: number }
): Promise<{
  url: string;
  category: MediaCategory;
  size_bytes?: number;
  compressed?: boolean;
  original_size_bytes?: number;
  thumbnail_url?: string;
  duration_seconds?: number;
}> {
  const check = classifyAllowedMedia(file.type, file.name);
  if (!check.valid || !check.category) {
    throw new Error(check.error || 'Unsupported file format.');
  }
  if (expectedCategory && check.category !== expectedCategory) {
    const label =
      expectedCategory === 'image'
        ? 'gallery photos (JPG, PNG, WEBP, GIF)'
        : expectedCategory === 'audio'
        ? 'audio files (MP3, WAV, OGG, WEBM, M4A)'
        : 'video files (MP4, WEBM, MOV)';
    throw new Error(`Please select ${label} only.`);
  }

  const form = new FormData();
  if (options?.maxMb) {
    form.append('maxMb', String(options.maxMb));
  }
  form.append('file', file);

  const token = getStoredToken();
  const headers: Record<string, string> = {};
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const endpoint =
    options?.maxMb && check.category === 'video'
      ? `/api/upload?maxMb=${encodeURIComponent(String(options.maxMb))}`
      : '/api/upload';

  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: form,
      credentials: 'include',
    });
  } catch {
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    throw new Error(
      offline
        ? 'You are offline. Reconnect before uploading media.'
        : 'Network error during media upload.'
    );
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error || 'Media upload failed.');
  }
  return data as {
    url: string;
    category: MediaCategory;
    size_bytes?: number;
    compressed?: boolean;
    original_size_bytes?: number;
    thumbnail_url?: string;
    duration_seconds?: number;
  };
}
