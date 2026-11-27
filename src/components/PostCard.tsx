import React, { useEffect, useRef, useState } from 'react';
import {
  CircleDot,
  Eye,
  Flag,
  Globe,
  Heart,
  Lock,
  MessageCircle,
  MessageSquare,
  MoreVertical,
  Share2,
  Sparkles,
  Trash2,
  UserPlus,
} from 'lucide-react';
import { Avatar, VerifiedBadge } from './Avatar';
import { apiFetch } from '../lib/api';
import {
  beginPostViewForUser,
  formatCompactViews,
  formatSafeDate,
  hasViewedPostForUser,
  markPostViewedForUser,
  rollbackPostViewForUser,
  shareOrCopyPostLink,
} from '../lib/postSession';
import {
  MAX_WORDS,
  sanitizeMediaUrl,
  sanitizePlainText,
  validateTextField,
} from '../shared/validation';
import type { AuthUser, PostItem } from '../shared/types';

interface PostCardProps {
  post: PostItem;
  currentUser: AuthUser;
  highlighted?: boolean;
  onOpenProfile: (userId: number) => void;
  onOpenCircle?: (circleId: number, circlePostId?: number | null) => void;
  onFollowCircle?: (circleId: number) => Promise<void>;
  onInquireCircle?: (circleId: number, circleName: string, circlePostId?: number | null) => void;
  onPostUpdated: (updated: PostItem) => void;
  onPostViewSynced?: (postId: number, viewsCount: number) => void;
  onPostDeleted: (postId: number) => void;
  onNotify: (message: string, variant?: 'success' | 'error') => void;
}

export const PostCard: React.FC<PostCardProps> = ({
  post,
  currentUser,
  highlighted = false,
  onOpenProfile,
  onOpenCircle,
  onFollowCircle,
  onInquireCircle,
  onPostUpdated,
  onPostViewSynced,
  onPostDeleted,
  onNotify,
}) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [commentInput, setCommentInput] = useState('');
  const [commentError, setCommentError] = useState('');
  const [reportOpen, setReportOpen] = useState(false);
  const [reportReason, setReportReason] = useState('');
  const [submittingReport, setSubmittingReport] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [togglingBoost, setTogglingBoost] = useState(false);
  const [followCircleBusy, setFollowCircleBusy] = useState(false);

  const cardRef = useRef<HTMLElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const isOwner = Number(post.user_id) === Number(currentUser.id);
  const isSiteAdmin = String(currentUser.role).toLowerCase() === 'admin';
  const isCircleStaff =
    post.circle_viewer_role === 'owner' ||
    post.circle_viewer_role === 'admin' ||
    post.circle_viewer_role === 'moderator';
  const canDelete = isOwner || isSiteAdmin || isCircleStaff;
  const canBoost = isOwner || isSiteAdmin;
  const canReport = !isOwner;
  const hasMenuActions = canBoost || canDelete || canReport;
  const safeMediaUrl = sanitizeMediaUrl(post.media_url);
  const formattedViews = formatCompactViews(post.views_count);

  // Close 3-dot dropdown cleanly on outside click or Escape key
  useEffect(() => {
    if (!menuOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuOpen(false);
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [menuOpen]);

  // Increment post view strictly once per unique user
  useEffect(() => {
    const node = cardRef.current;
    if (!node || post.has_viewed || hasViewedPostForUser(currentUser.id, post.id)) {
      if (post.has_viewed) {
        markPostViewedForUser(currentUser.id, post.id);
        if (post.circle_post_id) {
          markPostViewedForUser(currentUser.id, post.circle_post_id, 'circle');
        }
      }
      return;
    }
    if (typeof IntersectionObserver === 'undefined') return;

    let cancelled = false;
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry?.isIntersecting) return;
        if (!beginPostViewForUser(currentUser.id, post.id)) {
          observer.disconnect();
          return;
        }
        observer.disconnect();

        void (async () => {
          try {
            const res = await apiFetch<{ views_count: number }>(`/api/posts/${post.id}/view`, {
              method: 'POST',
            });
            markPostViewedForUser(currentUser.id, post.id);
            if (post.circle_post_id) {
              markPostViewedForUser(currentUser.id, post.circle_post_id, 'circle');
            }
            if (!cancelled && typeof res.views_count === 'number') {
              if (onPostViewSynced) {
                onPostViewSynced(post.id, res.views_count);
              } else {
                onPostUpdated({ ...post, views_count: res.views_count, has_viewed: true });
              }
            }
          } catch {
            rollbackPostViewForUser(currentUser.id, post.id);
          }
        })();
      },
      { threshold: 0.15 }
    );

    observer.observe(node);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [post.id, post.has_viewed, post.circle_post_id, currentUser.id]);

  const handleToggleLike = async () => {
    try {
      const res = await apiFetch<{ liked: boolean; likes_count: number }>(
        `/api/posts/${post.id}/like`,
        { method: 'POST' }
      );
      onPostUpdated({
        ...post,
        is_liked: res.liked,
        likes_count: res.likes_count,
      });
    } catch (err: any) {
      onNotify(err?.message || 'Could not update reaction.', 'error');
    }
  };

  const handleCommentSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleaned = sanitizePlainText(commentInput, 2500);
    const check = validateTextField(cleaned, 'Comment', {
      required: true,
      maxWords: MAX_WORDS,
    });
    if (!check.valid) {
      setCommentError(check.error || 'Invalid comment.');
      return;
    }

    setCommentError('');
    try {
      const res = await apiFetch<{
        comment: PostItem['comments'][number];
        auto_reply?: PostItem['comments'][number] | null;
      }>(`/api/posts/${post.id}/comment`, {
        method: 'POST',
        body: JSON.stringify({ content: cleaned }),
      });
      const appended = res.auto_reply ? [res.comment, res.auto_reply] : [res.comment];
      onPostUpdated({
        ...post,
        comments_count: post.comments_count + appended.length,
        comments: [...post.comments, ...appended],
      });
      setCommentInput('');
      if (res.auto_reply) {
        onNotify('Automated Circle reply sent!', 'success');
      }
    } catch (err: any) {
      setCommentError(err?.message || 'Comment blocked.');
    }
  };

  const handleShare = async () => {
    try {
      const shareResult = await shareOrCopyPostLink(post.id, post.author_name);
      if (shareResult === 'cancelled') return;

      try {
        const res = await apiFetch<{ shares_count: number }>(`/api/posts/${post.id}/share`, {
          method: 'POST',
        });
        onPostUpdated({ ...post, shares_count: res.shares_count });
      } catch {
        // Share link still succeeded even if count sync fails
      }

      onNotify(
        shareResult === 'shared'
          ? 'Post shared cleanly.'
          : `Share link copied! (?post=${post.id})`,
        'success'
      );
    } catch (err: any) {
      onNotify(err?.message || 'Could not copy post link.', 'error');
    }
  };

  const handleToggleBoost = async () => {
    if (!canBoost || togglingBoost) return;
    setMenuOpen(false);
    setTogglingBoost(true);
    try {
      const res = await apiFetch<{ is_boosted: boolean; is_spotlight: boolean }>(
        `/api/posts/${post.id}/boost`,
        { method: 'POST' }
      );
      onPostUpdated({
        ...post,
        is_boosted: res.is_boosted,
        is_spotlight: res.is_spotlight,
      });
      onNotify(
        res.is_boosted ? 'Post highlighted in Spotlight.' : 'Spotlight boost removed.',
        'success'
      );
    } catch (err: any) {
      onNotify(err?.message || 'Could not update spotlight status.', 'error');
    } finally {
      setTogglingBoost(false);
    }
  };

  const handleDelete = async () => {
    if (!canDelete || deleting) return;
    setMenuOpen(false);
    setDeleting(true);
    try {
      await apiFetch(`/api/posts/${post.id}`, { method: 'DELETE' });
      onPostDeleted(post.id);
      onNotify('Post deleted.', 'success');
    } catch (err: any) {
      onNotify(err?.message || 'Could not delete post.', 'error');
    } finally {
      setDeleting(false);
    }
  };

  const handleReportSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isOwner || submittingReport) return;

    const cleanReason = sanitizePlainText(reportReason, 500);
    if (cleanReason.length < 3) {
      onNotify('Please write at least 3 characters explaining why you are reporting this post.', 'error');
      return;
    }

    setSubmittingReport(true);
    try {
      const res = await apiFetch<{ case_id: string }>('/api/reports', {
        method: 'POST',
        body: JSON.stringify({
          target_type: 'post',
          target_id: post.id,
          reason: cleanReason,
        }),
      });
      setReportOpen(false);
      setReportReason('');
      onNotify(`Report submitted · Case ID: ${res.case_id}`, 'success');
    } catch (err: any) {
      onNotify(err?.message || 'Could not submit report.', 'error');
    } finally {
      setSubmittingReport(false);
    }
  };

  return (
    <article
      ref={cardRef}
      id={`post-${post.id}`}
      className={`htv-card w-full min-w-0 max-w-full rounded-2xl p-4 sm:p-5 space-y-3.5 transition-all relative ${
        menuOpen ? 'z-20' : ''
      } ${
        post.is_spotlight
          ? 'border-orange-500/40 bg-gradient-to-br from-purple-500/[0.06] via-transparent to-orange-500/[0.06]'
          : ''
      } ${highlighted ? 'ring-2 ring-purple-500/70 shadow-lg shadow-purple-500/10' : ''}`}
    >
      {post.is_spotlight && (
        <div className="flex items-center justify-between gap-2 flex-wrap pb-1 min-w-0">
          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-gradient-to-r from-purple-500/20 to-orange-500/20 text-orange-600 dark:text-orange-300 border border-orange-500/30 shrink-0">
            <Sparkles className="w-3 h-3 shrink-0" />
            Spotlight
          </span>
          {post.is_boosted && (
            <span className="text-[11px] text-[var(--htv-text-dim)] font-medium">
              Featured by creator
            </span>
          )}
        </div>
      )}

      {post.circle_id && post.circle_name && (
        <div className="flex items-center justify-between gap-2 flex-wrap px-3 py-2 rounded-xl htv-elevated border border-purple-500/20 min-w-0">
          <button
            type="button"
            onClick={() => onOpenCircle?.(post.circle_id!, post.circle_post_id)}
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-purple-600 dark:text-purple-300 hover:text-orange-500 dark:hover:text-orange-300 transition-colors cursor-pointer min-w-0 max-w-full flex-1 basis-36"
          >
            <CircleDot className="w-3.5 h-3.5 text-orange-500 shrink-0" />
            <span className="truncate">{post.circle_name}</span>
            {post.circle_privacy === 'private' ? (
              <Lock className="w-3 h-3 text-amber-500 shrink-0" />
            ) : (
              <Globe className="w-3 h-3 text-emerald-500 shrink-0" />
            )}
            {post.circle_category && (
              <span className="hidden sm:inline text-[11px] font-normal text-[var(--htv-text-dim)] truncate">
                · {post.circle_category}
              </span>
            )}
          </button>

          <div className="flex items-center gap-1.5 flex-wrap max-w-full">
            {post.circle_privacy === 'public' && !post.circle_is_member && onFollowCircle && (
              <button
                type="button"
                disabled={followCircleBusy}
                onClick={async () => {
                  setFollowCircleBusy(true);
                  try {
                    await onFollowCircle(post.circle_id!);
                  } finally {
                    setFollowCircleBusy(false);
                  }
                }}
                className="px-2.5 py-1 rounded-lg bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-600 hover:to-teal-600 text-white text-[11px] font-semibold inline-flex items-center gap-1 whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
              >
                <UserPlus className="w-3 h-3 shrink-0" />
                {followCircleBusy ? 'Following...' : 'Follow Circle'}
              </button>
            )}
            {!isOwner && onInquireCircle && (
              <button
                type="button"
                onClick={() => onInquireCircle(post.circle_id!, post.circle_name!, post.circle_post_id)}
                className="px-2.5 py-1 rounded-lg border border-orange-500/35 bg-orange-500/10 hover:bg-orange-500/20 text-orange-600 dark:text-orange-300 text-[11px] font-semibold inline-flex items-center gap-1 whitespace-nowrap shrink-0 cursor-pointer"
              >
                <MessageSquare className="w-3 h-3 shrink-0" />
                Inquiry
              </button>
            )}
          </div>
        </div>
      )}

      {/* Header */}
      <div className="flex items-start justify-between gap-2.5 sm:gap-3 min-w-0">
        <button
          type="button"
          onClick={() => onOpenProfile(post.user_id)}
          className="flex items-center gap-2.5 sm:gap-3 text-left group cursor-pointer min-w-0 flex-1"
        >
          <Avatar src={post.author_avatar} name={post.author_name} size="md" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 min-w-0">
              <span className="font-display font-semibold text-sm group-hover:text-purple-600 dark:group-hover:text-purple-300 transition-colors truncate">
                {post.author_name}
              </span>
              <VerifiedBadge verified={post.author_verified} />
            </div>
            <div className="flex items-center gap-x-1.5 gap-y-0.5 text-xs text-[var(--htv-text-dim)] flex-wrap min-w-0">
              <span className="truncate max-w-full">@{post.author_username}</span>
              <span aria-hidden="true">·</span>
              <span className="font-mono-tabular shrink-0">{formatSafeDate(post.created_at)}</span>
            </div>
          </div>
        </button>

        {/* Three-Dot Action Menu */}
        {hasMenuActions && (
          <div ref={menuRef} className="relative shrink-0">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setMenuOpen((prev) => !prev);
              }}
              aria-label="Post options"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              className="min-w-[36px] min-h-[36px] flex items-center justify-center rounded-lg text-[var(--htv-text-dim)] hover:text-[var(--htv-text)] hover:bg-[var(--htv-hover)] transition-colors cursor-pointer"
            >
              <MoreVertical className="w-4 h-4" />
            </button>

            {menuOpen && (
              <div
                role="menu"
                className="absolute right-0 top-full mt-1.5 w-44 max-w-[calc(100vw-2.5rem)] rounded-xl htv-card border border-[var(--htv-border)] shadow-xl py-1 z-40"
              >
                {canBoost && (
                  <button
                    type="button"
                    role="menuitem"
                    disabled={togglingBoost}
                    onClick={handleToggleBoost}
                    className="w-full px-3.5 py-2 text-left text-xs font-semibold text-orange-600 dark:text-orange-300 hover:bg-orange-500/10 flex items-center gap-2 whitespace-nowrap cursor-pointer disabled:opacity-50"
                  >
                    <Sparkles className="w-3.5 h-3.5 shrink-0" />
                    {post.is_boosted ? 'Remove Spotlight' : 'Spotlight Post'}
                  </button>
                )}
                {canDelete && (
                  <button
                    type="button"
                    role="menuitem"
                    disabled={deleting}
                    onClick={handleDelete}
                    className="w-full px-3.5 py-2 text-left text-xs font-semibold text-rose-600 dark:text-rose-400 hover:bg-rose-500/10 flex items-center gap-2 whitespace-nowrap cursor-pointer disabled:opacity-50"
                  >
                    <Trash2 className="w-3.5 h-3.5 shrink-0" />
                    {deleting ? 'Deleting...' : 'Delete'}
                  </button>
                )}
                {canReport && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      setReportOpen((prev) => !prev);
                    }}
                    className="w-full px-3.5 py-2 text-left text-xs font-semibold text-amber-600 dark:text-amber-400 hover:bg-amber-500/10 flex items-center gap-2 whitespace-nowrap cursor-pointer"
                  >
                    <Flag className="w-3.5 h-3.5 shrink-0" />
                    Report
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Body (Rendered safely via JSX text bindings) */}
      {post.content && (
        <p className="text-[15px] leading-relaxed text-[var(--htv-text)] whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
          {post.content}
        </p>
      )}

      {/* Media */}
      {post.media_type === 'image' && safeMediaUrl && (
        <div className="rounded-xl overflow-hidden border border-[var(--htv-border-subtle)] bg-black/40">
          <img
            src={safeMediaUrl}
            alt="Post gallery media"
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            className="w-full max-h-[420px] object-cover"
          />
        </div>
      )}
      {post.media_type === 'audio' && safeMediaUrl && (
        <div className="htv-elevated rounded-xl p-3">
          <audio src={safeMediaUrl} controls className="w-full h-10" />
        </div>
      )}
      {post.media_type === 'video' && safeMediaUrl && (
        <div className="rounded-xl overflow-hidden border border-[var(--htv-border-subtle)] bg-black">
          <video src={safeMediaUrl} controls playsInline className="w-full max-h-[420px]" />
        </div>
      )}

      {/* Report inline bar (for non-owners) */}
      {canReport && reportOpen && (
        <form
          onSubmit={handleReportSubmit}
          className="htv-elevated rounded-xl p-3 flex flex-col sm:flex-row sm:items-center gap-2 min-w-0"
        >
          <input
            type="text"
            value={reportReason}
            onChange={(e) => setReportReason(e.target.value)}
            placeholder="Reason for reporting this post..."
            maxLength={500}
            className="w-full sm:flex-1 min-w-0 h-9 px-3 rounded-lg bg-[var(--htv-input)] border border-[var(--htv-border-subtle)] text-xs text-[var(--htv-text)]"
          />
          <button
            type="submit"
            disabled={submittingReport}
            className="w-full sm:w-auto px-3 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-xs font-medium shrink-0 whitespace-nowrap cursor-pointer disabled:opacity-50"
          >
            {submittingReport ? 'Submitting...' : 'Submit Report'}
          </button>
        </form>
      )}

      {/* Footer Actions: Likes, Comments, Views (Eye), Share (?post=ID) */}
      <div className="flex items-center justify-between gap-1.5 sm:gap-2 pt-2 border-t border-[var(--htv-border-subtle)] flex-wrap min-w-0">
        <div className="flex items-center gap-1 sm:gap-1.5 flex-wrap min-w-0">
          <button
            type="button"
            onClick={handleToggleLike}
            className={`px-2 sm:px-3 py-1.5 sm:py-2 rounded-lg text-xs font-medium inline-flex items-center gap-1 sm:gap-1.5 whitespace-nowrap shrink-0 transition-colors cursor-pointer ${
              post.is_liked
                ? 'bg-rose-500/15 text-rose-600 dark:text-rose-400'
                : 'text-[var(--htv-text-muted)] hover:bg-[var(--htv-hover)]'
            }`}
          >
            <Heart className={`w-4 h-4 shrink-0 ${post.is_liked ? 'fill-current' : ''}`} />
            <span className="font-mono-tabular">{post.likes_count}</span>
          </button>

          <button
            type="button"
            onClick={() => setCommentsOpen((prev) => !prev)}
            className="px-2 sm:px-3 py-1.5 sm:py-2 rounded-lg text-xs font-medium text-[var(--htv-text-muted)] hover:bg-[var(--htv-hover)] inline-flex items-center gap-1 sm:gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <MessageCircle className="w-4 h-4 shrink-0" />
            <span className="font-mono-tabular">{post.comments_count}</span>
          </button>

          <div
            aria-label={formattedViews}
            title={`${post.views_count} unique views`}
            className="px-2 sm:px-2.5 py-1.5 sm:py-2 rounded-lg text-xs font-medium text-[var(--htv-text-dim)] inline-flex items-center gap-1 sm:gap-1.5 whitespace-nowrap shrink-0 select-none"
          >
            <Eye className="w-4 h-4 shrink-0" />
            <span className="font-mono-tabular">{formattedViews}</span>
          </div>
        </div>

        <button
          type="button"
          onClick={handleShare}
          className="px-2.5 sm:px-3 py-1.5 sm:py-2 rounded-lg text-xs font-medium text-[var(--htv-text-muted)] hover:bg-[var(--htv-hover)] hover:text-[var(--htv-text)] inline-flex items-center gap-1 sm:gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
        >
          <Share2 className="w-4 h-4 shrink-0" />
          <span>Share</span>
          {post.shares_count > 0 && (
            <span className="font-mono-tabular text-[var(--htv-text-dim)]">
              ({post.shares_count})
            </span>
          )}
        </button>
      </div>

      {/* Comments Drawer */}
      {commentsOpen && (
        <div className="pt-3 border-t border-[var(--htv-border-subtle)] space-y-3 min-w-0">
          {post.comments.length > 0 && (
            <div className="space-y-2.5 max-h-60 overflow-y-auto pr-1">
              {post.comments.map((c, idx) => (
                <div key={`c-${c.id}-${idx}`} className="flex items-start gap-2.5 min-w-0">
                  <Avatar src={c.author_avatar} name={c.author_name} size="xs" />
                  <div className="htv-elevated rounded-xl px-3 py-2 flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap min-w-0">
                      <span className="text-xs font-semibold truncate max-w-full">{c.author_name}</span>
                      <VerifiedBadge verified={c.author_verified} />
                    </div>
                    <p className="text-xs text-[var(--htv-text)] mt-0.5 break-words [overflow-wrap:anywhere]">{c.content}</p>
                  </div>
                </div>
              ))}
            </div>
          )}

          <form onSubmit={handleCommentSubmit} className="flex items-center gap-2 min-w-0">
            <input
              type="text"
              value={commentInput}
              onChange={(e) => setCommentInput(e.target.value)}
              placeholder="Write a comment (no links allowed)..."
              className="flex-1 min-w-0 h-9 px-3 rounded-lg htv-elevated text-xs text-[var(--htv-text)] placeholder:text-[var(--htv-text-dim)] focus:outline-none focus:ring-2 focus:ring-purple-500/40"
            />
            <button
              type="submit"
              className="htv-gradient-btn px-3 py-2 rounded-lg text-xs font-semibold shrink-0 whitespace-nowrap cursor-pointer"
            >
              Reply
            </button>
          </form>
          {commentError && (
            <p className="text-xs text-rose-600 dark:text-rose-400">{commentError}</p>
          )}
        </div>
      )}
    </article>
  );
};
