import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  CircleDot,
  Globe,
  Image as ImageIcon,
  MessageSquare,
  RefreshCw,
  Send,
  ShieldCheck,
  X,
} from 'lucide-react';
import { Avatar } from './Avatar';
import { PostCard } from './PostCard';
import { apiFetch, uploadMediaFile } from '../lib/api';
import {
  countWords,
  MAX_WORDS,
  sanitizePlainText,
  validateTextField,
} from '../shared/validation';
import type { AuthUser, PostItem } from '../shared/types';

interface HomeFeedProps {
  currentUser: AuthUser;
  highlightedPostId?: number | null;
  wsEvent?: { type: string; [key: string]: any } | null;
  onClearHighlightedPost?: () => void;
  onOpenProfile: (userId: number) => void;
  onOpenCircle?: (circleId: number, circlePostId?: number | null) => void;
  onOpenConversation?: (conversationId: number) => void;
}

type FeedFilter = 'all' | 'global' | 'connections' | 'following' | 'popular' | 'recent';

export const HomeFeed: React.FC<HomeFeedProps> = ({
  currentUser,
  highlightedPostId = null,
  wsEvent = null,
  onClearHighlightedPost,
  onOpenProfile,
  onOpenCircle,
  onOpenConversation,
}) => {
  const [posts, setPosts] = useState<PostItem[]>([]);
  const [filter, setFilter] = useState<FeedFilter>('all');
  const [verifiedOnly, setVerifiedOnly] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [sharedMissing, setSharedMissing] = useState(false);

  // Composer state
  const [content, setContent] = useState('');
  const [mediaType, setMediaType] = useState<'none' | 'image'>('none');
  const [mediaUrl, setMediaUrl] = useState('');
  const [uploading, setUploading] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [composerError, setComposerError] = useState('');

  // Live Circle feed update banner & Quick Inquiry modal
  const [liveBanner, setLiveBanner] = useState<string | null>(null);
  const [inquiryTarget, setInquiryTarget] = useState<{
    circleId: number;
    circleName: string;
    circlePostId?: number | null;
  } | null>(null);
  const [inquiryMessage, setInquiryMessage] = useState('');
  const [sendingInquiry, setSendingInquiry] = useState(false);

  // Toast state with safe unmount cleanup
  const [toast, setToast] = useState<{ text: string; variant: 'success' | 'error' } | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);

  const showToast = useCallback((text: string, variant: 'success' | 'error' = 'success') => {
    setToast({ text, variant });
    if (toastTimerRef.current) {
      window.clearTimeout(toastTimerRef.current);
    }
    toastTimerRef.current = window.setTimeout(() => {
      setToast(null);
      toastTimerRef.current = null;
    }, 3500);
  }, []);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) {
        window.clearTimeout(toastTimerRef.current);
      }
    };
  }, []);

  const FEED_PAGE_SIZE = 15;

  const loadPosts = useCallback(
    async (activeFilter: FeedFilter, onlyVerified: boolean) => {
      setLoading(true);
      setSharedMissing(false);
      try {
        const verifiedParam = activeFilter === 'global' && onlyVerified ? '&verifiedOnly=1' : '';
        const data = await apiFetch<{ posts: PostItem[]; hasMore?: boolean }>(
          `/api/posts?filter=${activeFilter}&limit=${FEED_PAGE_SIZE}&offset=0${verifiedParam}`
        );
        let merged = data.posts;

        if (highlightedPostId && !merged.some((p) => p.id === highlightedPostId)) {
          try {
            const single = await apiFetch<{ post: PostItem }>(`/api/posts/${highlightedPostId}`);
            if (single.post) {
              merged = [single.post, ...merged];
            }
          } catch {
            setSharedMissing(true);
          }
        }

        setPosts(merged);
        setHasMore(Boolean(data.hasMore));
      } catch (err: any) {
        showToast(err?.message || 'Could not load feed posts.', 'error');
      } finally {
        setLoading(false);
      }
    },
    [highlightedPostId, showToast]
  );

  const handleLoadMore = async () => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    try {
      const verifiedParam = filter === 'global' && verifiedOnly ? '&verifiedOnly=1' : '';
      const data = await apiFetch<{ posts: PostItem[]; hasMore?: boolean }>(
        `/api/posts?filter=${filter}&limit=${FEED_PAGE_SIZE}&offset=${posts.length}${verifiedParam}`
      );
      setPosts((prev) => {
        const seen = new Set(prev.map((p) => p.id));
        const next = data.posts.filter((p) => !seen.has(p.id));
        return [...prev, ...next];
      });
      setHasMore(Boolean(data.hasMore));
    } catch (err: any) {
      showToast(err?.message || 'Could not load more posts.', 'error');
    } finally {
      setLoadingMore(false);
    }
  };

  useEffect(() => {
    loadPosts(filter, verifiedOnly);
  }, [filter, verifiedOnly, loadPosts]);

  useEffect(() => {
    if (!wsEvent) return;
    if (wsEvent.type === 'feed:new_post' || wsEvent.type === 'circle:post:new') {
      const name = typeof wsEvent.circleName === 'string' && wsEvent.circleName ? wsEvent.circleName : 'a Circle';
      setLiveBanner(`New post shared in ${name}`);
    }
  }, [wsEvent]);

  useEffect(() => {
    if (!highlightedPostId || loading) return;
    const timer = window.setTimeout(() => {
      const el = document.getElementById(`post-${highlightedPostId}`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }, 100);
    return () => window.clearTimeout(timer);
  }, [highlightedPostId, loading]);

  const wordCount = countWords(content);

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    setComposerError('');
    setUploading(true);
    try {
      const uploaded = await uploadMediaFile(file, 'image');
      setMediaType('image');
      setMediaUrl(uploaded.url);
    } catch (err: any) {
      setComposerError(err?.message || 'Only gallery pictures are allowed.');
    } finally {
      setUploading(false);
    }
  };

  const handlePublish = async (e: React.FormEvent) => {
    e.preventDefault();
    setComposerError('');

    const sanitized = sanitizePlainText(content, 4000);
    if (!sanitized && mediaType === 'none') {
      setComposerError('Write a text post or attach a gallery picture.');
      return;
    }

    const validation = validateTextField(sanitized, 'Post', { maxWords: MAX_WORDS });
    if (!validation.valid) {
      setComposerError(validation.error || 'Invalid post.');
      return;
    }

    setPublishing(true);
    try {
      const data = await apiFetch<{ post: PostItem }>('/api/posts', {
        method: 'POST',
        body: JSON.stringify({
          content: sanitized,
          media_type: mediaType,
          media_url: mediaUrl,
        }),
      });
      setPosts((prev) => [data.post, ...prev]);
      setContent('');
      setMediaType('none');
      setMediaUrl('');
      showToast('Post published.', 'success');
    } catch (err: any) {
      setComposerError(err?.message || 'Failed to publish post.');
    } finally {
      setPublishing(false);
    }
  };

  const handlePostUpdated = useCallback((updated: PostItem) => {
    setPosts((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
  }, []);

  const handlePostViewSynced = useCallback((postId: number, viewsCount: number) => {
    setPosts((prev) =>
      prev.map((p) => (p.id === postId ? { ...p, views_count: viewsCount, has_viewed: true } : p))
    );
  }, []);

  const handlePostDeleted = useCallback((postId: number) => {
    setPosts((prev) => prev.filter((p) => p.id !== postId));
  }, []);

  const handleFollowCircle = useCallback(
    async (circleId: number) => {
      try {
        const res = await apiFetch<{ following: boolean; pending: boolean }>(
          `/api/circles/${circleId}/follow`,
          { method: 'POST' }
        );
        if (res.following) {
          setPosts((prev) =>
            prev.map((p) =>
              p.circle_id === circleId
                ? { ...p, circle_is_member: true, circle_viewer_role: p.circle_viewer_role || 'member' }
                : p
            )
          );
          showToast('Following Circle! New posts will arrive sequentially.', 'success');
        } else if (res.pending) {
          showToast('Follow request sent to this Circle.', 'success');
        } else {
          setPosts((prev) =>
            prev.map((p) =>
              p.circle_id === circleId
                ? { ...p, circle_is_member: false, circle_viewer_role: null }
                : p
            )
          );
          showToast('Unfollowed Circle.', 'success');
        }
      } catch (err: any) {
        showToast(err?.message || 'Could not update Circle follow status.', 'error');
      }
    },
    [showToast]
  );

  const handleSubmitInquiry = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inquiryTarget || sendingInquiry) return;
    const cleaned = sanitizePlainText(inquiryMessage, 2000);
    const check = validateTextField(cleaned, 'Inquiry', { required: true, maxWords: MAX_WORDS });
    if (!check.valid) {
      showToast(check.error || 'Invalid inquiry message.', 'error');
      return;
    }

    setSendingInquiry(true);
    try {
      const res = await apiFetch<{
        ok: boolean;
        conversation_id: number | null;
        auto_reply?: string | null;
      }>(`/api/circles/${inquiryTarget.circleId}/inquiries`, {
        method: 'POST',
        body: JSON.stringify({
          message: cleaned,
          post_id: inquiryTarget.circlePostId ?? undefined,
          source: 'post_cta',
        }),
      });
      setInquiryTarget(null);
      setInquiryMessage('');
      showToast(
        res.auto_reply
          ? 'Inquiry sent — instant Auto-Reply delivered in Messenger!'
          : 'Inquiry sent to Circle staff & Messenger!',
        'success'
      );
      if (res.conversation_id && onOpenConversation) {
        onOpenConversation(res.conversation_id);
      }
    } catch (err: any) {
      showToast(err?.message || 'Could not send inquiry.', 'error');
    } finally {
      setSendingInquiry(false);
    }
  };

  return (
    <div className="space-y-5">
      {toast && (
        <div
          role="status"
          className={`fixed bottom-20 lg:bottom-6 right-4 sm:right-6 z-40 rounded-xl border px-4 py-2.5 text-xs font-medium shadow-xl backdrop-blur-md ${
            toast.variant === 'error'
              ? 'border-rose-500/40 bg-rose-500/15 text-rose-700 dark:text-rose-200'
              : 'border-emerald-500/40 bg-emerald-500/15 text-emerald-700 dark:text-emerald-200'
          }`}
        >
          {toast.text}
        </div>
      )}

      {liveBanner && (
        <div className="rounded-xl border border-orange-500/35 bg-gradient-to-r from-purple-500/15 to-orange-500/15 px-4 py-2.5 flex items-center justify-between gap-2 text-xs">
          <span className="inline-flex items-center gap-2 font-semibold text-orange-600 dark:text-orange-300">
            <CircleDot className="w-4 h-4 shrink-0" />
            {liveBanner}
          </span>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => {
                setLiveBanner(null);
                loadPosts(filter, verifiedOnly);
              }}
              className="px-2.5 py-1 rounded-lg htv-gradient-btn text-[11px] font-semibold inline-flex items-center gap-1 cursor-pointer"
            >
              <RefreshCw className="w-3 h-3" />
              Refresh
            </button>
            <button
              type="button"
              onClick={() => setLiveBanner(null)}
              aria-label="Dismiss new post notification"
              className="p-1 rounded-lg text-[var(--htv-text-dim)] hover:text-[var(--htv-text)] cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

      {highlightedPostId && (
        <div className="rounded-xl border border-purple-500/35 bg-purple-500/10 px-4 py-2.5 flex items-center justify-between gap-2 text-xs">
          <span className="text-purple-700 dark:text-purple-200 font-medium">
            {sharedMissing
              ? 'The shared post link could not be found or was deleted.'
              : `Viewing shared post #${highlightedPostId}`}
          </span>
          {onClearHighlightedPost && (
            <button
              type="button"
              onClick={onClearHighlightedPost}
              className="px-2.5 py-1 rounded-lg htv-elevated hover:bg-[var(--htv-hover)] text-[11px] font-semibold cursor-pointer"
            >
              Clear
            </button>
          )}
        </div>
      )}

      {/* Composer */}
      <form onSubmit={handlePublish} className="htv-card rounded-2xl p-4 sm:p-5 space-y-3.5">
        <div className="flex items-start gap-3">
          <Avatar src={currentUser.avatar_url} name={currentUser.name} size="md" />
          <div className="flex-1 min-w-0 space-y-2">
            <textarea
              rows={3}
              value={content}
              onChange={(e) => {
                setContent(e.target.value);
                if (composerError) setComposerError('');
              }}
              placeholder="Share text or a gallery photo (max 200 words, no external links)..."
              className="w-full rounded-xl htv-elevated p-3 text-sm text-[var(--htv-text)] placeholder:text-[var(--htv-text-dim)] resize-none focus:outline-none focus:ring-2 focus:ring-purple-500/50"
            />

            <div className="flex items-center justify-between text-xs">
              <span
                className={`font-mono-tabular ${
                  wordCount > MAX_WORDS
                    ? 'text-rose-500 dark:text-rose-400 font-semibold'
                    : 'text-[var(--htv-text-dim)]'
                }`}
              >
                {wordCount} / {MAX_WORDS} words
              </span>
              <span className="text-[var(--htv-text-dim)]">
                Text & gallery photos only (videos in Group Chats)
              </span>
            </div>
          </div>
        </div>

        {mediaType === 'image' && mediaUrl && (
          <div className="relative htv-elevated rounded-xl p-3">
            <button
              type="button"
              onClick={() => {
                setMediaType('none');
                setMediaUrl('');
              }}
              aria-label="Remove attachment"
              className="absolute top-2 right-2 z-10 p-1.5 rounded-lg bg-black/70 text-white hover:bg-black cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
            <img
              src={mediaUrl}
              alt="Attachment preview"
              referrerPolicy="no-referrer"
              className="max-h-72 w-full object-cover rounded-lg"
            />
          </div>
        )}

        {composerError && (
          <p className="text-xs text-rose-600 dark:text-rose-400 bg-rose-500/10 border border-rose-500/25 rounded-lg px-3 py-2">
            {composerError}
          </p>
        )}

        <div className="flex items-center justify-between gap-2 pt-2 border-t border-[var(--htv-border-subtle)] flex-wrap">
          <div className="flex items-center gap-1.5 flex-wrap">
            <input
              ref={imageInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif"
              className="hidden"
              onChange={handleFileSelect}
            />

            <button
              type="button"
              onClick={() => imageInputRef.current?.click()}
              className="px-3.5 py-2 rounded-lg htv-elevated hover:bg-[var(--htv-hover)] text-xs font-medium text-[var(--htv-text-muted)] hover:text-[var(--htv-text)] inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
            >
              <ImageIcon className="w-4 h-4 text-purple-500 dark:text-purple-400" />
              Gallery Photo
            </button>
          </div>

          <button
            type="submit"
            disabled={publishing || uploading}
            className="htv-gradient-btn px-4 py-2 rounded-xl text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer disabled:opacity-50"
          >
            <Send className="w-3.5 h-3.5" />
            {uploading ? 'Uploading...' : publishing ? 'Posting...' : 'Publish'}
          </button>
        </div>
      </form>

      {/* Filter Bar */}
      <div className="space-y-2">
        <div className="flex items-center gap-1.5 p-1.5 htv-card rounded-xl overflow-x-auto">
          {(
            [
              { id: 'all', label: 'All Posts' },
              { id: 'global', label: 'Global', icon: Globe },
              { id: 'connections', label: 'Connections' },
              { id: 'following', label: 'Following' },
              { id: 'popular', label: 'Popular' },
              { id: 'recent', label: 'Recent' },
            ] as const
          ).map((tab) => {
            const Icon = 'icon' in tab ? tab.icon : null;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setFilter(tab.id)}
                className={`px-3.5 py-2 rounded-lg text-xs font-semibold whitespace-nowrap shrink-0 inline-flex items-center gap-1.5 transition-colors cursor-pointer ${
                  filter === tab.id
                    ? 'htv-gradient-btn'
                    : 'text-[var(--htv-text-muted)] hover:text-[var(--htv-text)] hover:bg-[var(--htv-hover)]'
                }`}
              >
                {Icon && <Icon className="w-3.5 h-3.5" />}
                {tab.label}
              </button>
            );
          })}
        </div>

        {filter === 'global' && (
          <div className="htv-card rounded-xl px-3.5 py-2.5 flex items-center justify-between gap-2 flex-wrap border border-purple-500/20">
            <div className="flex items-center gap-2 text-xs text-[var(--htv-text-muted)] min-w-0">
              <Globe className="w-4 h-4 text-emerald-500 shrink-0" />
              <span className="truncate">
                Aggregating public posts from joined Circles, global connections &amp; verified voices
              </span>
            </div>
            <button
              type="button"
              onClick={() => setVerifiedOnly((prev) => !prev)}
              aria-pressed={verifiedOnly}
              className={`px-3 py-1.5 rounded-lg text-[11px] font-semibold inline-flex items-center gap-1.5 cursor-pointer transition-colors shrink-0 ${
                verifiedOnly
                  ? 'bg-gradient-to-r from-emerald-500 to-teal-500 text-white shadow-sm'
                  : 'htv-elevated text-[var(--htv-text-muted)] hover:text-[var(--htv-text)]'
              }`}
            >
              <ShieldCheck className="w-3.5 h-3.5" />
              {verifiedOnly ? 'Verified Public Only: On' : 'Verified Public Only'}
            </button>
          </div>
        )}
      </div>

      {/* Posts List */}
      {loading ? (
        <div className="space-y-4" aria-label="Loading posts">
          {[1, 2, 3].map((n) => (
            <div key={n} className="htv-card rounded-2xl p-4 sm:p-5 animate-pulse space-y-3.5">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full htv-elevated shrink-0" />
                  <div className="space-y-1.5">
                    <div className="h-3.5 w-32 htv-elevated rounded" />
                    <div className="h-2.5 w-24 htv-elevated rounded" />
                  </div>
                </div>
                <div className="w-6 h-6 rounded-lg htv-elevated" />
              </div>
              <div className="space-y-2">
                <div className="h-3.5 w-full htv-elevated rounded" />
                <div className="h-3.5 w-4/5 htv-elevated rounded" />
              </div>
              {n === 1 && <div className="h-44 w-full htv-elevated rounded-xl" />}
              <div className="flex items-center justify-between pt-2 border-t border-[var(--htv-border-subtle)]">
                <div className="flex items-center gap-2">
                  <div className="h-7 w-14 htv-elevated rounded-lg" />
                  <div className="h-7 w-14 htv-elevated rounded-lg" />
                  <div className="h-7 w-16 htv-elevated rounded-lg" />
                </div>
                <div className="h-7 w-16 htv-elevated rounded-lg" />
              </div>
            </div>
          ))}
        </div>
      ) : posts.length === 0 ? (
        <div className="htv-card rounded-2xl p-8 text-center space-y-2">
          <p className="font-display font-semibold text-base">No posts in this feed yet</p>
          <p className="text-sm text-[var(--htv-text-muted)]">
            Try switching filters or publish the first voice note or gallery post above.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {posts.map((post) => (
            <PostCard
              key={post.id}
              post={post}
              currentUser={currentUser}
              highlighted={highlightedPostId === post.id}
              onOpenProfile={onOpenProfile}
              onOpenCircle={onOpenCircle}
              onFollowCircle={handleFollowCircle}
              onInquireCircle={(circleId, circleName, circlePostId) => {
                setInquiryTarget({ circleId, circleName, circlePostId });
                setInquiryMessage('');
              }}
              onPostUpdated={handlePostUpdated}
              onPostViewSynced={handlePostViewSynced}
              onPostDeleted={handlePostDeleted}
              onNotify={showToast}
            />
          ))}
          {hasMore && (
            <div className="flex justify-center pt-1">
              <button
                type="button"
                disabled={loadingMore}
                onClick={handleLoadMore}
                className="px-5 py-2.5 rounded-xl htv-card hover:bg-[var(--htv-hover)] text-xs font-semibold text-purple-600 dark:text-purple-300 cursor-pointer disabled:opacity-50"
              >
                {loadingMore ? 'Loading more...' : 'Load More Posts'}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Quick Business Inquiry Modal */}
      {inquiryTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
          <form
            onSubmit={handleSubmitInquiry}
            className="w-full max-w-md htv-card rounded-2xl border border-[var(--htv-border)] p-5 space-y-4 shadow-2xl"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <div className="w-8 h-8 rounded-lg htv-gradient-btn flex items-center justify-center shrink-0">
                  <MessageSquare className="w-4 h-4" />
                </div>
                <div className="min-w-0">
                  <h3 className="font-display font-bold text-sm truncate">
                    Quick Inquiry · {inquiryTarget.circleName}
                  </h3>
                  <p className="text-[11px] text-[var(--htv-text-dim)]">
                    Goes directly to Circle customer queue & Messenger
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setInquiryTarget(null)}
                aria-label="Close inquiry modal"
                className="p-1.5 rounded-lg text-[var(--htv-text-dim)] hover:text-[var(--htv-text)] cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <textarea
              rows={4}
              value={inquiryMessage}
              onChange={(e) => setInquiryMessage(e.target.value)}
              placeholder="Ask about pricing, order details, booking, or support (no external links)..."
              maxLength={2000}
              className="w-full rounded-xl htv-elevated p-3 text-xs text-[var(--htv-text)] placeholder:text-[var(--htv-text-dim)] resize-none focus:outline-none focus:ring-2 focus:ring-purple-500/50"
            />

            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setInquiryTarget(null)}
                className="px-3.5 py-2 rounded-xl htv-elevated text-xs font-semibold cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={sendingInquiry}
                className="htv-gradient-btn px-4 py-2 rounded-xl text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
              >
                <Send className="w-3.5 h-3.5" />
                {sendingInquiry ? 'Sending...' : 'Send Inquiry'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
