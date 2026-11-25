const inFlightUserViews = new Set<string>();

function viewKey(userId: number, postId: number): string {
  return `${userId}:${postId}`;
}

export function hasViewedPostForUser(userId: number, postId: number): boolean {
  const key = viewKey(userId, postId);
  if (inFlightUserViews.has(key)) return true;
  try {
    const raw = localStorage.getItem(`htv_viewed_posts_${userId}`);
    if (!raw) return false;
    const list = JSON.parse(raw);
    return Array.isArray(list) && list.includes(postId);
  } catch {
    return false;
  }
}

export function markPostViewedForUser(userId: number, postId: number): void {
  inFlightUserViews.add(viewKey(userId, postId));
  try {
    const storageKey = `htv_viewed_posts_${userId}`;
    const raw = localStorage.getItem(storageKey);
    const parsed = raw ? JSON.parse(raw) : [];
    const list: number[] = Array.isArray(parsed) ? parsed : [];
    if (!list.includes(postId)) {
      const next = [...list.slice(-499), postId];
      localStorage.setItem(storageKey, JSON.stringify(next));
    }
  } catch {
    // Ignore storage unavailability
  }
}

export function buildPostShareUrl(postId: number): string {
  if (typeof window === 'undefined') return `/?post=${postId}`;
  const url = new URL(window.location.origin);
  url.searchParams.set('post', String(postId));
  return url.toString();
}

export async function shareOrCopyPostLink(
  postId: number,
  authorName: string
): Promise<'shared' | 'copied' | 'cancelled'> {
  const shareUrl = buildPostShareUrl(postId);

  if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
    try {
      await navigator.share({
        title: `${authorName} on HushTalkVoice`,
        text: `Check out this post by ${authorName} on HushTalkVoice`,
        url: shareUrl,
      });
      return 'shared';
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        return 'cancelled';
      }
    }
  }

  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(shareUrl);
      return 'copied';
    }
  } catch {
    // Fall through to DOM copy fallback
  }

  try {
    const textarea = document.createElement('textarea');
    textarea.value = shareUrl;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
    return 'copied';
  } catch {
    return 'copied';
  }
}

export function formatSafeDate(rawDate: string): string {
  try {
    const normalized = rawDate.includes('T') ? rawDate : `${rawDate.replace(' ', 'T')}Z`;
    const parsed = new Date(normalized);
    if (Number.isNaN(parsed.getTime())) return '';
    return parsed.toLocaleDateString();
  } catch {
    return '';
  }
}

export function formatCompactViews(rawCount: number): string {
  const count = Math.max(0, Math.floor(Number(rawCount) || 0));
  if (count === 1) return '1 view';
  if (count < 1000) return `${count} views`;
  if (count < 1_000_000) {
    const k = (count / 1000).toFixed(count >= 10_000 ? 0 : 1).replace(/\.0$/, '');
    return `${k}K views`;
  }
  const m = (count / 1_000_000).toFixed(1).replace(/\.0$/, '');
  return `${m}M views`;
}

