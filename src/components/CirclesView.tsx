import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Bot,
  Check,
  CheckCheck,
  CheckCircle2,
  CircleDot,
  Clock,
  Copy,
  Eye,
  Flag,
  Globe,
  Heart,
  Image as ImageIcon,
  Inbox,
  Link2,
  Lock,
  LogOut,
  Megaphone,
  MessageCircle,
  MessageSquare,
  MoreVertical,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Send,
  Share2,
  Shield,
  ShieldCheck,
  Sparkles,
  Trash2,
  UserCheck,
  UserPlus,
  Users,
  X,
  Zap,
} from 'lucide-react';
import { Avatar, VerifiedBadge } from './Avatar';
import { FeedSkeleton } from './FeedSkeleton';
import { apiFetch, uploadMediaFile } from '../lib/api';
import { cachedApiFetch, invalidateApiCache } from '../lib/cache';
import { useRenderPerf } from '../lib/perfMonitor';
import {
  beginPostViewForUser,
  formatCompactViews,
  formatSafeDate,
  hasViewedPostForUser,
  markPostViewedForUser,
  rollbackPostViewForUser,
} from '../lib/postSession';
import {
  countWords,
  MAX_WORDS,
  sanitizeMediaUrl,
  sanitizePlainText,
  validateTextField,
} from '../shared/validation';
import type {
  AuthUser,
  CircleAutomationPayload,
  CircleFollowRequestItem,
  CircleInquiryStatus,
  CircleItem,
  CircleMemberItem,
  CirclePostItem,
  CirclePrivacy,
  CircleRole,
} from '../shared/types';

interface CirclesViewProps {
  currentUser: AuthUser;
  initialCircleId?: number | null;
  highlightedPostId?: number | null;
  onClearHighlightedPost?: () => void;
  onOpenProfile: (userId: number) => void;
  onOpenConversation?: (conversationId: number) => void;
}

type CircleTab = 'feed' | 'pending' | 'members' | 'automation';
type AutomationSubTab = 'queue' | 'autopilot' | 'broadcast';

const ROLE_STYLES: Record<CircleRole, string> = {
  owner: 'bg-orange-500/15 text-orange-600 dark:text-orange-300 border-orange-500/30',
  admin: 'bg-purple-500/15 text-purple-600 dark:text-purple-300 border-purple-500/30',
  moderator: 'bg-sky-500/15 text-sky-600 dark:text-sky-300 border-sky-500/30',
  member: 'bg-[var(--htv-elevated)] text-[var(--htv-text-dim)] border-[var(--htv-border-subtle)]',
};

function buildCircleInviteUrl(circleId: number, inviteCode: string): string {
  if (typeof window === 'undefined') {
    return `/?circle=${circleId}&circleInvite=${encodeURIComponent(inviteCode)}`;
  }
  const url = new URL(window.location.origin);
  url.searchParams.set('circle', String(circleId));
  url.searchParams.set('circleInvite', inviteCode);
  return url.toString();
}

function buildCirclePostShareUrl(circleId: number, postId: number): string {
  if (typeof window === 'undefined') {
    return `/?circle=${circleId}&circlePost=${postId}`;
  }
  const url = new URL(window.location.origin);
  url.searchParams.set('circle', String(circleId));
  url.searchParams.set('circlePost', String(postId));
  return url.toString();
}

async function copyTextSafe(text: string): Promise<void> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    // Fallback below
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  document.body.removeChild(textarea);
}

interface CirclePostCardProps {
  post: CirclePostItem;
  circleId: number;
  currentUser: AuthUser;
  isCircleStaff: boolean;
  isPendingView?: boolean;
  highlighted?: boolean;
  onOpenProfile: (userId: number) => void;
  onOpenCircle?: (circleId: number) => void;
  onPostUpdated: (updated: CirclePostItem) => void;
  onViewSynced: (postId: number, viewsCount: number) => void;
  onPostDeleted: (postId: number) => void;
  onModerate?: (postId: number, action: 'approve' | 'reject') => Promise<void>;
  onNotify: (message: string, variant?: 'success' | 'error') => void;
}

const CirclePostCard: React.FC<CirclePostCardProps> = React.memo(({
  post,
  circleId,
  currentUser,
  isCircleStaff,
  isPendingView = false,
  highlighted = false,
  onOpenProfile,
  onOpenCircle,
  onPostUpdated,
  onViewSynced,
  onPostDeleted,
  onModerate,
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
  const [moderating, setModerating] = useState(false);

  const cardRef = useRef<HTMLElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const isPostOwner = Number(post.user_id) === Number(currentUser.id);
  const isSiteAdmin = String(currentUser.role).toLowerCase() === 'admin';
  const effectiveCircleStaff =
    isCircleStaff ||
    post.circle_viewer_role === 'owner' ||
    post.circle_viewer_role === 'admin' ||
    post.circle_viewer_role === 'moderator';
  const canDelete = isPostOwner || effectiveCircleStaff || isSiteAdmin;
  const canReport = !isPostOwner;
  const hasMenuActions = canDelete || canReport;
  const safeMediaUrl = sanitizeMediaUrl(post.media_url);
  const formattedViews = formatCompactViews(post.views_count);

  useEffect(() => {
    if (!menuOpen) return;
    const handlePointerDown = (e: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [menuOpen]);

  useEffect(() => {
    if (isPendingView || post.status !== 'approved') return;
    const node = cardRef.current;
    if (!node || post.has_viewed || hasViewedPostForUser(currentUser.id, post.id, 'circle')) {
      if (post.has_viewed) {
        markPostViewedForUser(currentUser.id, post.id, 'circle');
        if (post.global_post_id) {
          markPostViewedForUser(currentUser.id, post.global_post_id, 'post');
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
        if (!beginPostViewForUser(currentUser.id, post.id, 'circle')) {
          observer.disconnect();
          return;
        }
        observer.disconnect();

        void (async () => {
          try {
            const res = await apiFetch<{ views_count: number }>(
              `/api/circles/${circleId}/posts/${post.id}/view`,
              { method: 'POST' }
            );
            markPostViewedForUser(currentUser.id, post.id, 'circle');
            if (post.global_post_id) {
              markPostViewedForUser(currentUser.id, post.global_post_id, 'post');
            }
            if (!cancelled && typeof res.views_count === 'number') {
              onViewSynced(post.id, res.views_count);
            }
          } catch {
            rollbackPostViewForUser(currentUser.id, post.id, 'circle');
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
  }, [circleId, currentUser.id, isPendingView, onViewSynced, post.global_post_id, post.has_viewed, post.id, post.status]);

  const handleToggleLike = async () => {
    try {
      const res = await apiFetch<{ liked: boolean; likes_count: number }>(
        `/api/circles/${circleId}/posts/${post.id}/like`,
        { method: 'POST' }
      );
      onPostUpdated({
        ...post,
        is_liked: res.liked,
        likes_count: res.likes_count,
      });
    } catch (err: any) {
      onNotify(err?.message || 'Could not update like.', 'error');
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
        comment: CirclePostItem['comments'][number];
        auto_reply?: CirclePostItem['comments'][number] | null;
      }>(`/api/circles/${circleId}/posts/${post.id}/comment`, {
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
        onNotify('Automated business reply posted!', 'success');
      }
    } catch (err: any) {
      setCommentError(err?.message || 'Comment blocked.');
    }
  };

  const handleShare = async () => {
    try {
      const url = buildCirclePostShareUrl(circleId, post.id);
      if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
        try {
          await navigator.share({
            title: `${post.author_name} in HushTalkVoice Circle`,
            text: `Check out this Circle post by ${post.author_name}`,
            url,
          });
        } catch (err: any) {
          if (err?.name === 'AbortError') return;
          await copyTextSafe(url);
        }
      } else {
        await copyTextSafe(url);
      }

      try {
        const res = await apiFetch<{ shares_count: number }>(
          `/api/circles/${circleId}/posts/${post.id}/share`,
          { method: 'POST' }
        );
        onPostUpdated({ ...post, shares_count: res.shares_count });
      } catch {
        // Share link already copied
      }
      onNotify('Circle post link copied!', 'success');
    } catch (err: any) {
      onNotify(err?.message || 'Could not copy post link.', 'error');
    }
  };

  const handleDelete = async () => {
    if (!canDelete || deleting) return;
    setMenuOpen(false);
    setDeleting(true);
    try {
      await apiFetch(`/api/circles/${circleId}/posts/${post.id}`, { method: 'DELETE' });
      onPostDeleted(post.id);
      onNotify('Circle post deleted.', 'success');
    } catch (err: any) {
      onNotify(err?.message || 'Could not delete post.', 'error');
    } finally {
      setDeleting(false);
    }
  };

  const handleReportSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isPostOwner || submittingReport) return;

    const cleanReason = sanitizePlainText(reportReason, 500);
    if (cleanReason.length < 3) {
      onNotify('Please write at least 3 characters explaining your report.', 'error');
      return;
    }

    setSubmittingReport(true);
    try {
      const res = await apiFetch<{ case_id: string }>('/api/reports', {
        method: 'POST',
        body: JSON.stringify({
          target_type: 'circle_post',
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

  const handleModerateClick = async (action: 'approve' | 'reject') => {
    if (!onModerate || moderating) return;
    setModerating(true);
    try {
      await onModerate(post.id, action);
    } finally {
      setModerating(false);
    }
  };

  return (
    <article
      ref={cardRef}
      id={`circle-post-${post.id}`}
      className={`htv-card w-full min-w-0 max-w-full rounded-2xl p-4 sm:p-5 space-y-3.5 transition-all relative ${
        menuOpen ? 'z-20' : ''
      } ${highlighted ? 'ring-2 ring-emerald-500/70 shadow-lg shadow-emerald-500/10' : ''}`}
    >
      {/* Aggregated Joined Feed Circle Context Chip */}
      {post.circle_name && onOpenCircle && (
        <div className="flex items-center justify-between gap-2 flex-wrap pb-2 border-b border-[var(--htv-border-subtle)] min-w-0">
          <button
            type="button"
            onClick={() => onOpenCircle(post.circle_id)}
            className="inline-flex items-center gap-2 text-left group cursor-pointer min-w-0 flex-1"
          >
            <Avatar src={sanitizeMediaUrl(post.circle_avatar)} name={post.circle_name} size="xs" />
            <span className="text-xs font-display font-semibold text-purple-600 dark:text-purple-300 group-hover:text-orange-400 truncate">
              {post.circle_name}
            </span>
            {post.circle_category && (
              <span className="px-2 py-0.5 rounded-full text-[10px] font-medium htv-elevated text-[var(--htv-text-dim)] shrink-0 max-w-[120px] truncate">
                {post.circle_category}
              </span>
            )}
          </button>
          <span className="text-[10px] text-[var(--htv-text-dim)] shrink-0 whitespace-nowrap">
            Joined Circle
          </span>
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
            <div className="flex items-center gap-1.5 flex-wrap min-w-0">
              <span className="font-display font-semibold text-sm group-hover:text-purple-600 dark:group-hover:text-purple-300 transition-colors truncate max-w-full">
                {post.author_name}
              </span>
              <VerifiedBadge verified={post.author_verified} />
              {post.status === 'pending' && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-500/15 text-amber-600 dark:text-amber-300 border border-amber-500/30 shrink-0">
                  <Clock className="w-2.5 h-2.5 shrink-0" />
                  Pending Approval
                </span>
              )}
              {post.status === 'approved' && post.is_global && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30 shrink-0">
                  <Globe className="w-2.5 h-2.5 shrink-0" />
                  Global Feed
                </span>
              )}
            </div>
            <div className="flex items-center gap-x-1.5 gap-y-0.5 text-xs text-[var(--htv-text-dim)] flex-wrap min-w-0">
              <span className="truncate max-w-full">@{post.author_username}</span>
              <span aria-hidden="true">·</span>
              <span className="font-mono-tabular shrink-0">{formatSafeDate(post.created_at)}</span>
              {post.status === 'approved' && (post.delivered_count ?? 0) > 0 && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="text-[11px] text-purple-600 dark:text-purple-300 font-medium">
                    Delivered to {post.delivered_count} sequentially
                  </span>
                </>
              )}
            </div>
          </div>
        </button>

        {/* Three-Dot Menu */}
        {hasMenuActions && (
          <div ref={menuRef} className="relative shrink-0">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setMenuOpen((prev) => !prev);
              }}
              aria-label="Circle post options"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              className="min-w-[36px] min-h-[36px] flex items-center justify-center rounded-lg text-[var(--htv-text-dim)] hover:text-[var(--htv-text)] hover:bg-[var(--htv-hover)] transition-colors cursor-pointer"
            >
              <MoreVertical className="w-4 h-4" />
            </button>

            {menuOpen && (
              <div
                role="menu"
                className="absolute right-0 top-full mt-1.5 w-40 max-w-[calc(100vw-2.5rem)] rounded-xl htv-card border border-[var(--htv-border)] shadow-xl py-1 z-40"
              >
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

      {/* Content */}
      {post.content && (
        <p className="text-[15px] leading-relaxed text-[var(--htv-text)] whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
          {post.content}
        </p>
      )}

      {/* Image */}
      {post.media_type === 'image' && safeMediaUrl && (
        <div className="rounded-xl overflow-hidden border border-[var(--htv-border-subtle)] bg-black/40">
          <img
            src={safeMediaUrl}
            alt="Circle post gallery photo"
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            className="w-full max-h-[420px] object-cover"
          />
        </div>
      )}

      {/* Report inline form */}
      {canReport && reportOpen && (
        <form
          onSubmit={handleReportSubmit}
          className="htv-elevated rounded-xl p-3 flex flex-col sm:flex-row sm:items-center gap-2 min-w-0"
        >
          <input
            type="text"
            value={reportReason}
            onChange={(e) => setReportReason(e.target.value)}
            placeholder="Reason for reporting this Circle post..."
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

      {/* Footer: Moderation Controls OR Engagement Bar */}
      {isPendingView && onModerate ? (
        <div className="flex items-center justify-end gap-2 flex-wrap pt-2 border-t border-[var(--htv-border-subtle)]">
          <button
            type="button"
            disabled={moderating}
            onClick={() => handleModerateClick('reject')}
            className="px-3.5 py-2 rounded-lg htv-elevated hover:bg-rose-500/15 text-xs font-semibold text-rose-600 dark:text-rose-300 inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
          >
            <X className="w-3.5 h-3.5 shrink-0" />
            Reject
          </button>
          <button
            type="button"
            disabled={moderating}
            onClick={() => handleModerateClick('approve')}
            className="px-3.5 py-2 rounded-lg bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-600 hover:to-teal-600 text-white text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
          >
            <Check className="w-3.5 h-3.5 shrink-0" />
            Approve Post
          </button>
        </div>
      ) : (
        <>
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

          {commentsOpen && (
            <div className="pt-3 border-t border-[var(--htv-border-subtle)] space-y-3 min-w-0">
              {post.comments.length > 0 && (
                <div className="space-y-2.5 max-h-60 overflow-y-auto pr-1">
                  {post.comments.map((c, idx) => (
                    <div key={`cc-${c.id}-${idx}`} className="flex items-start gap-2.5 min-w-0">
                      <Avatar src={c.author_avatar} name={c.author_name} size="xs" />
                      <div className="htv-elevated rounded-xl px-3 py-2 flex-1 min-w-0">
                        <div className="flex items-center gap-1.5 flex-wrap min-w-0">
                          <span className="text-xs font-semibold truncate max-w-full">{c.author_name}</span>
                          <VerifiedBadge verified={c.author_verified} />
                        </div>
                        <p className="text-xs text-[var(--htv-text)] mt-0.5 break-words [overflow-wrap:anywhere]">
                          {c.content}
                        </p>
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
        </>
      )}
    </article>
  );
});

CirclePostCard.displayName = 'CirclePostCard';

export const CirclesView: React.FC<CirclesViewProps> = ({
  currentUser,
  initialCircleId = null,
  highlightedPostId = null,
  onClearHighlightedPost,
  onOpenProfile,
  onOpenConversation,
}) => {
  useRenderPerf('CirclesView');
  const [circles, setCircles] = useState<CircleItem[]>([]);
  const [viewMode, setViewMode] = useState<'aggregated' | 'circle'>(() =>
    initialCircleId ? 'circle' : 'aggregated'
  );
  const [selectedCircleId, setSelectedCircleId] = useState<number | null>(initialCircleId ?? null);
  const [loadingCircles, setLoadingCircles] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);

  // Unified Aggregated Joined Circles Feed state
  const [aggPosts, setAggPosts] = useState<CirclePostItem[]>([]);
  const [loadingAgg, setLoadingAgg] = useState(false);
  const [loadingMoreAgg, setLoadingMoreAgg] = useState(false);
  const [hasMoreAgg, setHasMoreAgg] = useState(false);
  const AGG_PAGE_SIZE = 15;

  // Active Circle state
  const [activeCircle, setActiveCircle] = useState<CircleItem | null>(null);
  const [members, setMembers] = useState<CircleMemberItem[]>([]);
  const [followRequests, setFollowRequests] = useState<CircleFollowRequestItem[]>([]);
  const [posts, setPosts] = useState<CirclePostItem[]>([]);
  const [pendingPosts, setPendingPosts] = useState<CirclePostItem[]>([]);
  const [canViewFeed, setCanViewFeed] = useState(true);

  const [tab, setTab] = useState<CircleTab>('feed');
  const [createOpen, setCreateOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [copiedInvite, setCopiedInvite] = useState(false);

  // Customer Quick Inquiry drawer
  const [inquiryOpen, setInquiryOpen] = useState(false);
  const [inquiryText, setInquiryText] = useState('');
  const [sendingInquiry, setSendingInquiry] = useState(false);

  // Toast
  const [toast, setToast] = useState<{ text: string; variant: 'success' | 'error' } | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const copyTimerRef = useRef<number | null>(null);

  const showToast = useCallback((text: string, variant: 'success' | 'error' = 'success') => {
    setToast({ text, variant });
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => {
      setToast(null);
      toastTimerRef.current = null;
    }, 3500);
  }, []);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
      if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current);
    };
  }, []);

  // Create Circle Form
  const [newName, setNewName] = useState('');
  const [newCategory, setNewCategory] = useState('Community');
  const [newDescription, setNewDescription] = useState('');
  const [newAvatarUrl, setNewAvatarUrl] = useState('');
  const [newPrivacy, setNewPrivacy] = useState<CirclePrivacy>('public');
  const [newRequireApproval, setNewRequireApproval] = useState(false);
  const [creatingCircle, setCreatingCircle] = useState(false);
  const [uploadingCover, setUploadingCover] = useState(false);
  const coverInputRef = useRef<HTMLInputElement>(null);

  // Invite Member Form
  const [inviteUsername, setInviteUsername] = useState('');
  const [inviteRole, setInviteRole] = useState<'member' | 'moderator' | 'admin'>('member');
  const [inviting, setInviting] = useState(false);

  // Post Composer
  const [postContent, setPostContent] = useState('');
  const [postMediaUrl, setPostMediaUrl] = useState('');
  const [broadcastGlobal, setBroadcastGlobal] = useState(true);
  const [uploadingPostPhoto, setUploadingPostPhoto] = useState(false);
  const [publishingPost, setPublishingPost] = useState(false);
  const [composerError, setComposerError] = useState('');
  const postPhotoRef = useRef<HTMLInputElement>(null);

  // Business Automation State (Staff Only)
  const [automationData, setAutomationData] = useState<CircleAutomationPayload | null>(null);
  const [loadingAutomation, setLoadingAutomation] = useState(false);
  const [automationSubTab, setAutomationSubTab] = useState<AutomationSubTab>('queue');
  const [inquiryFilter, setInquiryFilter] = useState<'all' | CircleInquiryStatus>('all');
  const [replyDrafts, setReplyDrafts] = useState<Record<number, string>>({});
  const [replyingId, setReplyingId] = useState<number | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [approveAllBusy, setApproveAllBusy] = useState(false);

  // Auto-Reply & Automation form state
  const [autoWelcomeEnabled, setAutoWelcomeEnabled] = useState(false);
  const [autoWelcomeMessage, setAutoWelcomeMessage] = useState('');
  const [autoInquiryEnabled, setAutoInquiryEnabled] = useState(true);
  const [autoInquiryMessage, setAutoInquiryMessage] = useState('');
  const [autoApproveVerified, setAutoApproveVerified] = useState(false);
  const [autoKeywordEnabled, setAutoKeywordEnabled] = useState(true);
  const [savingAutoSettings, setSavingAutoSettings] = useState(false);

  // Keyword rule form & inline-edit state
  const [newKeyword, setNewKeyword] = useState('');
  const [newKeywordReply, setNewKeywordReply] = useState('');
  const [newKeywordCreateLead, setNewKeywordCreateLead] = useState(true);
  const [addingKeyword, setAddingKeyword] = useState(false);
  const [editingRuleId, setEditingRuleId] = useState<number | null>(null);
  const [editRuleKeyword, setEditRuleKeyword] = useState('');
  const [editRuleReply, setEditRuleReply] = useState('');
  const [editRuleCreateLead, setEditRuleCreateLead] = useState(true);
  const [savingRuleEdit, setSavingRuleEdit] = useState(false);
  const [togglingRuleId, setTogglingRuleId] = useState<number | null>(null);

  // Quick reply template form & inline-edit state
  const [newTemplateTitle, setNewTemplateTitle] = useState('');
  const [newTemplateContent, setNewTemplateContent] = useState('');
  const [addingTemplate, setAddingTemplate] = useState(false);
  const [editingTemplateId, setEditingTemplateId] = useState<number | null>(null);
  const [editTemplateTitle, setEditTemplateTitle] = useState('');
  const [editTemplateContent, setEditTemplateContent] = useState('');
  const [savingTemplateEdit, setSavingTemplateEdit] = useState(false);

  // Sequential follower broadcast state
  const [broadcastMessage, setBroadcastMessage] = useState('');
  const [broadcastSendDm, setBroadcastSendDm] = useState(true);
  const [sendingBroadcast, setSendingBroadcast] = useState(false);

  // Action busy flags
  const [followBusy, setFollowBusy] = useState(false);
  const [updatingSettings, setUpdatingSettings] = useState(false);

  const loadAutomation = useCallback(
    async (circleId: number) => {
      setLoadingAutomation(true);
      try {
        const res = await apiFetch<CircleAutomationPayload>(`/api/circles/${circleId}/automation`);
        setAutomationData(res);
        setAutoWelcomeEnabled(res.settings.auto_welcome_enabled);
        setAutoWelcomeMessage(res.settings.auto_welcome_message);
        setAutoInquiryEnabled(res.settings.auto_inquiry_reply_enabled);
        setAutoInquiryMessage(res.settings.auto_inquiry_reply_message);
        setAutoApproveVerified(res.settings.auto_approve_verified);
        setAutoKeywordEnabled(res.settings.auto_keyword_reply_enabled);
      } catch {
        setAutomationData(null);
      } finally {
        setLoadingAutomation(false);
      }
    },
    []
  );

  const loadAggregatedFeed = useCallback(
    async (forceRefresh = false) => {
      setLoadingAgg(true);
      try {
        const res = await cachedApiFetch<{ posts: CirclePostItem[]; hasMore: boolean }>(
          `/api/circles/feed/aggregated?limit=${AGG_PAGE_SIZE}&offset=0`,
          {
            userId: currentUser.id,
            ttlMs: 45_000,
            forceRefresh,
            onRevalidated: (fresh) => {
              setAggPosts(fresh.posts);
              setHasMoreAgg(Boolean(fresh.hasMore));
            },
          }
        );
        setAggPosts(res.posts);
        setHasMoreAgg(Boolean(res.hasMore));
      } catch (err: any) {
        showToast(err?.message || 'Could not load Joined Circles feed.', 'error');
      } finally {
        setLoadingAgg(false);
      }
    },
    [currentUser.id, showToast]
  );

  const handleLoadMoreAggregated = async () => {
    if (loadingMoreAgg || !hasMoreAgg) return;
    setLoadingMoreAgg(true);
    try {
      const res = await apiFetch<{ posts: CirclePostItem[]; hasMore: boolean }>(
        `/api/circles/feed/aggregated?limit=${AGG_PAGE_SIZE}&offset=${aggPosts.length}`
      );
      setAggPosts((prev) => {
        const seen = new Set(prev.map((p) => p.id));
        return [...prev, ...res.posts.filter((p) => !seen.has(p.id))];
      });
      setHasMoreAgg(Boolean(res.hasMore));
    } catch (err: any) {
      showToast(err?.message || 'Could not load more posts.', 'error');
    } finally {
      setLoadingMoreAgg(false);
    }
  };

  const loadCircles = useCallback(
    async (preferredId?: number | null, forceRefresh = false) => {
      setLoadingCircles(true);
      try {
        const res = await cachedApiFetch<{ circles: CircleItem[] }>('/api/circles', {
          userId: currentUser.id,
          ttlMs: 45_000,
          forceRefresh,
          onRevalidated: (fresh) => setCircles(fresh.circles),
        });
        setCircles(res.circles);
        const targetId =
          preferredId && res.circles.some((c) => c.id === preferredId)
            ? preferredId
            : res.circles[0]?.id ?? null;
        setSelectedCircleId(targetId);
      } catch (err: any) {
        showToast(err?.message || 'Could not load Circles.', 'error');
      } finally {
        setLoadingCircles(false);
      }
    },
    [currentUser.id, showToast]
  );

  const loadCircleDetail = useCallback(
    async (circleId: number) => {
      setLoadingDetail(true);
      try {
        const res = await apiFetch<{
          circle: CircleItem;
          members: CircleMemberItem[];
          follow_requests: CircleFollowRequestItem[];
          posts: CirclePostItem[];
          pending_posts: CirclePostItem[];
          can_view_feed: boolean;
        }>(`/api/circles/${circleId}`);

        setActiveCircle(res.circle);
        setMembers(res.members);
        setFollowRequests(res.follow_requests);
        setPosts(res.posts);
        setPendingPosts(res.pending_posts);
        setCanViewFeed(res.can_view_feed);
        setCircles((prev) => prev.map((c) => (c.id === res.circle.id ? res.circle : c)));

        const role = res.circle.viewer_role;
        if (role === 'owner' || role === 'admin' || role === 'moderator') {
          void loadAutomation(circleId);
        } else {
          setAutomationData(null);
        }
      } catch (err: any) {
        showToast(err?.message || 'Could not open Circle.', 'error');
      } finally {
        setLoadingDetail(false);
      }
    },
    [loadAutomation, showToast]
  );

  useEffect(() => {
    loadCircles(initialCircleId);
  }, [loadCircles, initialCircleId]);

  useEffect(() => {
    if (initialCircleId) {
      setSelectedCircleId(initialCircleId);
      setViewMode('circle');
      setTab('feed');
    }
  }, [initialCircleId]);

  useEffect(() => {
    if (viewMode === 'aggregated') {
      void loadAggregatedFeed();
    }
  }, [viewMode, loadAggregatedFeed]);

  useEffect(() => {
    if (viewMode === 'circle' && selectedCircleId) {
      setInquiryOpen(false);
      loadCircleDetail(selectedCircleId);
    } else if (!selectedCircleId) {
      setActiveCircle(null);
      setAutomationData(null);
    }
  }, [viewMode, selectedCircleId, loadCircleDetail]);

  useEffect(() => {
    if (!highlightedPostId || loadingDetail || tab !== 'feed') return;
    const timer = window.setTimeout(() => {
      const el = document.getElementById(`circle-post-${highlightedPostId}`);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 120);
    return () => window.clearTimeout(timer);
  }, [highlightedPostId, loadingDetail, tab, posts.length]);

  const viewerRole = activeCircle?.viewer_role ?? null;
  const isOwner = viewerRole === 'owner';
  const isAdminOrOwner = viewerRole === 'owner' || viewerRole === 'admin';
  const isStaff =
    viewerRole === 'owner' || viewerRole === 'admin' || viewerRole === 'moderator';

  useEffect(() => {
    if ((tab === 'pending' || tab === 'automation') && !isStaff) {
      setTab('feed');
    }
  }, [tab, isStaff]);

  const handleUploadImage = async (
    file: File,
    setBusy: (v: boolean) => void,
    onDone: (url: string) => void
  ) => {
    setBusy(true);
    try {
      const uploaded = await uploadMediaFile(file, 'image');
      onDone(uploaded.url);
    } catch (err: any) {
      showToast(err?.message || 'Only gallery images are allowed.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleCreateCircle = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanName = sanitizePlainText(newName, 80);
    const cleanCategory = sanitizePlainText(newCategory, 50) || 'Community';
    const cleanDesc = sanitizePlainText(newDescription, 800);

    const nameCheck = validateTextField(cleanName, 'Circle Name', {
      required: true,
      maxWords: 15,
    });
    if (!nameCheck.valid) {
      showToast(nameCheck.error || 'Invalid Circle name.', 'error');
      return;
    }
    const descCheck = validateTextField(cleanDesc, 'Circle Description', {
      maxWords: MAX_WORDS,
    });
    if (!descCheck.valid) {
      showToast(descCheck.error || 'Invalid description.', 'error');
      return;
    }

    setCreatingCircle(true);
    try {
      const res = await apiFetch<{ circle: CircleItem }>('/api/circles', {
        method: 'POST',
        body: JSON.stringify({
          name: cleanName,
          category: cleanCategory,
          description: cleanDesc,
          avatar_url: newAvatarUrl,
          privacy: newPrivacy,
          require_post_approval: newRequireApproval,
        }),
      });
      setCreateOpen(false);
      setNewName('');
      setNewDescription('');
      setNewAvatarUrl('');
      setNewPrivacy('public');
      setNewRequireApproval(false);
      invalidateApiCache(currentUser.id, '/api/circles');
      setViewMode('circle');
      await loadCircles(res.circle.id, true);
      setTab('feed');
      showToast(`${res.circle.name} is now live!`, 'success');
    } catch (err: any) {
      showToast(err?.message || 'Could not create Circle.', 'error');
    } finally {
      setCreatingCircle(false);
    }
  };

  const handleFollowToggle = async () => {
    if (!activeCircle || followBusy || isOwner) return;
    setFollowBusy(true);
    try {
      const res = await apiFetch<{ following: boolean; pending: boolean }>(
        `/api/circles/${activeCircle.id}/follow`,
        { method: 'POST' }
      );
      invalidateApiCache(currentUser.id, '/api/circles');
      invalidateApiCache(currentUser.id, '/api/posts');
      await loadCircleDetail(activeCircle.id);
      if (res.following) {
        showToast(`Following ${activeCircle.name}`, 'success');
      } else if (res.pending) {
        showToast(`Access request sent to ${activeCircle.name}`, 'success');
      } else {
        showToast(
          activeCircle.pending_request
            ? 'Follow request cancelled.'
            : `Unfollowed ${activeCircle.name}`,
          'success'
        );
      }
    } catch (err: any) {
      showToast(err?.message || 'Could not update follow status.', 'error');
    } finally {
      setFollowBusy(false);
    }
  };

  const handleCopyInviteLink = async () => {
    if (!activeCircle) return;
    try {
      const url = buildCircleInviteUrl(activeCircle.id, activeCircle.invite_code);
      await copyTextSafe(url);
      setCopiedInvite(true);
      if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => {
        setCopiedInvite(false);
        copyTimerRef.current = null;
      }, 2500);
      showToast('Circle invite link copied!', 'success');
    } catch {
      showToast('Could not copy invite link.', 'error');
    }
  };

  const handleInviteMember = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeCircle || inviting) return;
    const cleanUsername = inviteUsername.trim().toLowerCase().replace(/^@/, '');
    if (!/^[a-z0-9_]{3,24}$/.test(cleanUsername)) {
      showToast('Enter a valid @username (3-24 letters, numbers, underscores).', 'error');
      return;
    }

    const chosenRole = isAdminOrOwner ? inviteRole : 'member';
    setInviting(true);
    try {
      await apiFetch(`/api/circles/${activeCircle.id}/members/invite`, {
        method: 'POST',
        body: JSON.stringify({ username: cleanUsername, role: chosenRole }),
      });
      setInviteUsername('');
      setInviteRole('member');
      await loadCircleDetail(activeCircle.id);
      showToast(`Invited @${cleanUsername} to ${activeCircle.name}.`, 'success');
    } catch (err: any) {
      showToast(err?.message || 'Could not invite member.', 'error');
    } finally {
      setInviting(false);
    }
  };

  const handleRespondFollowRequest = async (
    requestId: number,
    action: 'approve' | 'reject'
  ) => {
    if (!activeCircle) return;
    try {
      await apiFetch(`/api/circles/${activeCircle.id}/follow-requests/${requestId}/respond`, {
        method: 'POST',
        body: JSON.stringify({ action }),
      });
      await loadCircleDetail(activeCircle.id);
      showToast(
        action === 'approve' ? 'Follow request approved.' : 'Follow request declined.',
        'success'
      );
    } catch (err: any) {
      showToast(err?.message || 'Could not process follow request.', 'error');
    }
  };

  const handleRoleChange = async (
    userId: number,
    role: 'admin' | 'moderator' | 'member'
  ) => {
    if (!activeCircle) return;
    try {
      await apiFetch(`/api/circles/${activeCircle.id}/members/${userId}/role`, {
        method: 'PATCH',
        body: JSON.stringify({ role }),
      });
      setMembers((prev) => prev.map((m) => (m.user_id === userId ? { ...m, role } : m)));
      showToast(`Role updated to ${role}.`, 'success');
    } catch (err: any) {
      showToast(err?.message || 'Could not update role.', 'error');
    }
  };

  const handleRemoveOrLeave = async (userId: number) => {
    if (!activeCircle) return;
    try {
      await apiFetch(`/api/circles/${activeCircle.id}/members/${userId}`, {
        method: 'DELETE',
      });
      await loadCircleDetail(activeCircle.id);
      showToast(userId === currentUser.id ? 'Left Circle.' : 'Member removed.', 'success');
    } catch (err: any) {
      showToast(err?.message || 'Action failed.', 'error');
    }
  };

  const handleUpdateSettings = async (patch: {
    require_post_approval?: boolean;
    privacy?: CirclePrivacy;
  }) => {
    if (!activeCircle || updatingSettings) return;
    setUpdatingSettings(true);
    try {
      const res = await apiFetch<{
        privacy: CirclePrivacy;
        require_post_approval: boolean;
        invite_code: string;
      }>(`/api/circles/${activeCircle.id}/settings`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
      setActiveCircle((prev) =>
        prev
          ? {
              ...prev,
              privacy: res.privacy,
              require_post_approval: res.require_post_approval,
              invite_code: res.invite_code,
            }
          : prev
      );
      setCircles((prev) =>
        prev.map((c) =>
          c.id === activeCircle.id
            ? {
                ...c,
                privacy: res.privacy,
                require_post_approval: res.require_post_approval,
              }
            : c
        )
      );
      showToast('Circle settings saved.', 'success');
    } catch (err: any) {
      showToast(err?.message || 'Could not save Circle settings.', 'error');
    } finally {
      setUpdatingSettings(false);
    }
  };

  const handlePublishPost = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeCircle || publishingPost) return;
    setComposerError('');

    const sanitized = sanitizePlainText(postContent, 4000);
    const mediaType = postMediaUrl ? 'image' : 'none';
    if (!sanitized && mediaType === 'none') {
      setComposerError('Write a post or attach a gallery photo.');
      return;
    }

    const check = validateTextField(sanitized, 'Circle Post', { maxWords: MAX_WORDS });
    if (!check.valid) {
      setComposerError(check.error || 'Invalid post.');
      return;
    }

    setPublishingPost(true);
    try {
      const res = await apiFetch<{ post?: CirclePostItem; status: 'approved' | 'pending' }>(
        `/api/circles/${activeCircle.id}/posts`,
        {
          method: 'POST',
          body: JSON.stringify({
            content: sanitized,
            media_type: mediaType,
            media_url: postMediaUrl,
            broadcast_global: activeCircle.privacy === 'public' ? broadcastGlobal : false,
          }),
        }
      );

      setPostContent('');
      setPostMediaUrl('');
      invalidateApiCache(currentUser.id, '/api/circles');
      invalidateApiCache(currentUser.id, '/api/posts');

      if (res.status === 'pending') {
        if (res.post && isStaff) {
          setPendingPosts((prev) => [res.post!, ...prev]);
        }
        showToast('Post submitted for admin/moderator approval.', 'success');
      } else if (res.post) {
        setPosts((prev) => [res.post!, ...prev]);
        const delivered = res.post.delivered_count ?? 0;
        showToast(
          res.post.is_global
            ? `Published globally & queued for ${delivered} followers sequentially!`
            : `Published & delivered to ${delivered} Circle followers sequentially!`,
          'success'
        );
      }
    } catch (err: any) {
      setComposerError(err?.message || 'Could not publish Circle post.');
    } finally {
      setPublishingPost(false);
    }
  };

  const handleSendCustomerInquiry = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeCircle || sendingInquiry) return;
    const cleaned = sanitizePlainText(inquiryText, 2000);
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
      }>(`/api/circles/${activeCircle.id}/inquiries`, {
        method: 'POST',
        body: JSON.stringify({ message: cleaned, source: 'direct' }),
      });
      setInquiryText('');
      setInquiryOpen(false);
      showToast(
        res.auto_reply
          ? 'Inquiry sent — Auto-Reply delivered in Messenger!'
          : 'Inquiry sent! Circle staff & Messenger notified.',
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

  const handleSaveAutomationSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeCircle || savingAutoSettings) return;
    const cleanedWelcome = sanitizePlainText(autoWelcomeMessage, 1500);
    const cleanedInquiryReply = sanitizePlainText(autoInquiryMessage, 1500);

    if (cleanedWelcome) {
      const check = validateTextField(cleanedWelcome, 'Auto-Welcome Message', { maxWords: MAX_WORDS });
      if (!check.valid) {
        showToast(check.error || 'Invalid Auto-Welcome message.', 'error');
        return;
      }
    }
    if (autoWelcomeEnabled && !cleanedWelcome.trim()) {
      showToast('Write an Auto-Welcome DM message before enabling it.', 'error');
      return;
    }

    if (cleanedInquiryReply) {
      const inqCheck = validateTextField(cleanedInquiryReply, 'Inquiry Auto-Reply Message', {
        maxWords: MAX_WORDS,
      });
      if (!inqCheck.valid) {
        showToast(inqCheck.error || 'Invalid Inquiry Auto-Reply message.', 'error');
        return;
      }
    }
    if (autoInquiryEnabled && !cleanedInquiryReply.trim()) {
      showToast('Write an Inquiry Auto-Reply template before enabling it.', 'error');
      return;
    }

    setSavingAutoSettings(true);
    try {
      await apiFetch(`/api/circles/${activeCircle.id}/automation/settings`, {
        method: 'PATCH',
        body: JSON.stringify({
          auto_welcome_enabled: autoWelcomeEnabled,
          auto_welcome_message: cleanedWelcome,
          auto_inquiry_reply_enabled: autoInquiryEnabled,
          auto_inquiry_reply_message: cleanedInquiryReply,
          auto_approve_verified: autoApproveVerified,
          auto_keyword_reply_enabled: autoKeywordEnabled,
        }),
      });
      await loadAutomation(activeCircle.id);
      showToast('Auto-Reply settings saved!', 'success');
    } catch (err: any) {
      showToast(err?.message || 'Could not save Auto-Reply settings.', 'error');
    } finally {
      setSavingAutoSettings(false);
    }
  };

  const handleAddKeywordRule = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeCircle || addingKeyword) return;
    const kw = sanitizePlainText(newKeyword, 40).toLowerCase();
    const reply = sanitizePlainText(newKeywordReply, 2000);
    if (!kw || !reply) {
      showToast('Enter both a keyword trigger and an auto-reply message.', 'error');
      return;
    }

    setAddingKeyword(true);
    try {
      await apiFetch(`/api/circles/${activeCircle.id}/automation/keywords`, {
        method: 'POST',
        body: JSON.stringify({
          keyword: kw,
          reply_text: reply,
          create_inquiry: newKeywordCreateLead,
        }),
      });
      setNewKeyword('');
      setNewKeywordReply('');
      setNewKeywordCreateLead(true);
      await loadAutomation(activeCircle.id);
      showToast(`Keyword auto-reply for "${kw}" added!`, 'success');
    } catch (err: any) {
      showToast(err?.message || 'Could not add keyword rule.', 'error');
    } finally {
      setAddingKeyword(false);
    }
  };

  const handleToggleKeywordRule = async (ruleId: number, currentActive: boolean) => {
    if (!activeCircle || togglingRuleId) return;
    setTogglingRuleId(ruleId);
    try {
      await apiFetch(`/api/circles/${activeCircle.id}/automation/keywords/${ruleId}`, {
        method: 'PATCH',
        body: JSON.stringify({ is_active: !currentActive }),
      });
      await loadAutomation(activeCircle.id);
      showToast(!currentActive ? 'Keyword auto-reply enabled.' : 'Keyword auto-reply paused.', 'success');
    } catch (err: any) {
      showToast(err?.message || 'Could not update keyword rule.', 'error');
    } finally {
      setTogglingRuleId(null);
    }
  };

  const handleSaveEditKeywordRule = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeCircle || !editingRuleId || savingRuleEdit) return;
    const kw = sanitizePlainText(editRuleKeyword, 40).toLowerCase();
    const reply = sanitizePlainText(editRuleReply, 2000);
    if (!kw || !reply) {
      showToast('Enter both a keyword trigger and an auto-reply message.', 'error');
      return;
    }
    setSavingRuleEdit(true);
    try {
      await apiFetch(`/api/circles/${activeCircle.id}/automation/keywords/${editingRuleId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          keyword: kw,
          reply_text: reply,
          create_inquiry: editRuleCreateLead,
        }),
      });
      setEditingRuleId(null);
      await loadAutomation(activeCircle.id);
      showToast(`Updated auto-reply for "${kw}".`, 'success');
    } catch (err: any) {
      showToast(err?.message || 'Could not save keyword rule.', 'error');
    } finally {
      setSavingRuleEdit(false);
    }
  };

  const handleDeleteKeywordRule = async (ruleId: number) => {
    if (!activeCircle) return;
    try {
      await apiFetch(`/api/circles/${activeCircle.id}/automation/keywords/${ruleId}`, {
        method: 'DELETE',
      });
      if (editingRuleId === ruleId) setEditingRuleId(null);
      await loadAutomation(activeCircle.id);
      showToast('Keyword rule removed.', 'success');
    } catch (err: any) {
      showToast(err?.message || 'Could not delete rule.', 'error');
    }
  };

  const handleAddQuickReply = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeCircle || addingTemplate) return;
    const title = sanitizePlainText(newTemplateTitle, 60);
    const content = sanitizePlainText(newTemplateContent, 2000);
    if (!title || !content) {
      showToast('Enter both a template title and reply message.', 'error');
      return;
    }

    setAddingTemplate(true);
    try {
      await apiFetch(`/api/circles/${activeCircle.id}/automation/quick-replies`, {
        method: 'POST',
        body: JSON.stringify({ title, content }),
      });
      setNewTemplateTitle('');
      setNewTemplateContent('');
      await loadAutomation(activeCircle.id);
      showToast('Quick Reply template saved!', 'success');
    } catch (err: any) {
      showToast(err?.message || 'Could not save template.', 'error');
    } finally {
      setAddingTemplate(false);
    }
  };

  const handleSaveEditQuickReply = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeCircle || !editingTemplateId || savingTemplateEdit) return;
    const title = sanitizePlainText(editTemplateTitle, 60);
    const content = sanitizePlainText(editTemplateContent, 2000);
    if (!title || !content) {
      showToast('Enter both a template title and reply message.', 'error');
      return;
    }
    setSavingTemplateEdit(true);
    try {
      await apiFetch(`/api/circles/${activeCircle.id}/automation/quick-replies/${editingTemplateId}`, {
        method: 'PATCH',
        body: JSON.stringify({ title, content }),
      });
      setEditingTemplateId(null);
      await loadAutomation(activeCircle.id);
      showToast('Quick Reply template updated!', 'success');
    } catch (err: any) {
      showToast(err?.message || 'Could not update template.', 'error');
    } finally {
      setSavingTemplateEdit(false);
    }
  };

  const handleDeleteQuickReply = async (replyId: number) => {
    if (!activeCircle) return;
    try {
      await apiFetch(`/api/circles/${activeCircle.id}/automation/quick-replies/${replyId}`, {
        method: 'DELETE',
      });
      if (editingTemplateId === replyId) setEditingTemplateId(null);
      await loadAutomation(activeCircle.id);
      showToast('Quick Reply deleted.', 'success');
    } catch (err: any) {
      showToast(err?.message || 'Could not delete template.', 'error');
    }
  };

  const handleReplyInquiry = async (
    inquiryId: number,
    options: { quickReplyId?: number; status?: CircleInquiryStatus; replyText?: string }
  ) => {
    if (!activeCircle || replyingId) return;
    const text =
      options.replyText !== undefined
        ? sanitizePlainText(options.replyText, 2000)
        : sanitizePlainText(replyDrafts[inquiryId] || '', 2000);

    if (!options.quickReplyId && !text && !options.status) {
      showToast('Write a reply or choose a Quick Reply template.', 'error');
      return;
    }

    setReplyingId(inquiryId);
    try {
      await apiFetch(`/api/circles/${activeCircle.id}/inquiries/${inquiryId}/reply`, {
        method: 'POST',
        body: JSON.stringify({
          reply_text: text,
          quick_reply_id: options.quickReplyId,
          status: options.status || 'resolved',
        }),
      });
      setReplyDrafts((prev) => ({ ...prev, [inquiryId]: '' }));
      await loadAutomation(activeCircle.id);
      showToast(
        text || options.quickReplyId
          ? 'Reply sent to customer Messenger & inquiry updated!'
          : 'Inquiry status updated.',
        'success'
      );
    } catch (err: any) {
      showToast(err?.message || 'Could not send customer reply.', 'error');
    } finally {
      setReplyingId(null);
    }
  };

  const handleBulkResolveInquiries = async () => {
    if (!activeCircle || bulkBusy) return;
    setBulkBusy(true);
    try {
      await apiFetch(`/api/circles/${activeCircle.id}/inquiries/bulk`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'resolved' }),
      });
      await loadAutomation(activeCircle.id);
      showToast('All open customer inquiries marked resolved.', 'success');
    } catch (err: any) {
      showToast(err?.message || 'Bulk resolve failed.', 'error');
    } finally {
      setBulkBusy(false);
    }
  };

  const handleApproveAllFollowRequests = async () => {
    if (!activeCircle || approveAllBusy) return;
    setApproveAllBusy(true);
    try {
      const res = await apiFetch<{ ok: boolean; approved_count: number }>(
        `/api/circles/${activeCircle.id}/automation/approve-all-requests`,
        { method: 'POST' }
      );
      await loadCircleDetail(activeCircle.id);
      showToast(
        `Approved ${res.approved_count} requests & triggered Auto-Welcome DMs sequentially!`,
        'success'
      );
    } catch (err: any) {
      showToast(err?.message || 'Could not approve all requests.', 'error');
    } finally {
      setApproveAllBusy(false);
    }
  };

  const handleSendSequentialBroadcast = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeCircle || sendingBroadcast) return;
    const cleaned = sanitizePlainText(broadcastMessage, 2000);
    const check = validateTextField(cleaned, 'Broadcast Message', {
      required: true,
      maxWords: MAX_WORDS,
    });
    if (!check.valid) {
      showToast(check.error || 'Invalid broadcast message.', 'error');
      return;
    }

    setSendingBroadcast(true);
    try {
      const res = await apiFetch<{ ok: boolean; recipients_count: number }>(
        `/api/circles/${activeCircle.id}/automation/broadcast`,
        {
          method: 'POST',
          body: JSON.stringify({ message: cleaned, send_dm: broadcastSendDm }),
        }
      );
      setBroadcastMessage('');
      await loadAutomation(activeCircle.id);
      showToast(
        `Broadcast queued sequentially for ${res.recipients_count} followers!`,
        'success'
      );
    } catch (err: any) {
      showToast(err?.message || 'Broadcast failed.', 'error');
    } finally {
      setSendingBroadcast(false);
    }
  };

  const handleModeratePost = async (postId: number, action: 'approve' | 'reject') => {
    if (!activeCircle) return;
    try {
      const res = await apiFetch<{ ok: boolean; status: string; post?: CirclePostItem }>(
        `/api/circles/${activeCircle.id}/posts/${postId}/moderate`,
        {
          method: 'PATCH',
          body: JSON.stringify({ action }),
        }
      );
      invalidateApiCache(currentUser.id, '/api/circles');
      invalidateApiCache(currentUser.id, '/api/posts');
      setPendingPosts((prev) => prev.filter((p) => p.id !== postId));
      if (action === 'approve' && res.post) {
        setPosts((prev) => [res.post!, ...prev]);
        setActiveCircle((prev) =>
          prev ? { ...prev, post_count: prev.post_count + 1 } : prev
        );
        setCircles((prev) =>
          prev.map((c) =>
            c.id === activeCircle.id ? { ...c, post_count: c.post_count + 1 } : c
          )
        );
      }
      showToast(
        action === 'approve' ? 'Post approved and published.' : 'Pending post rejected.',
        'success'
      );
    } catch (err: any) {
      showToast(err?.message || 'Could not moderate post.', 'error');
    }
  };

  const handlePostUpdated = useCallback(
    (updated: CirclePostItem) => {
      setPosts((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
      invalidateApiCache(currentUser.id, '/api/circles/feed/aggregated');
    },
    [currentUser.id]
  );

  const handlePostViewSynced = useCallback((postId: number, viewsCount: number) => {
    setPosts((prev) =>
      prev.map((p) =>
        p.id === postId
          ? { ...p, views_count: Math.max(p.views_count, viewsCount), has_viewed: true }
          : p
      )
    );
  }, []);

  const handlePostDeleted = useCallback(
    (postId: number) => {
      const wasApproved = posts.some((p) => p.id === postId);
      setPosts((prev) => prev.filter((p) => p.id !== postId));
      setPendingPosts((prev) => prev.filter((p) => p.id !== postId));
      setAggPosts((prev) => prev.filter((p) => p.id !== postId));
      invalidateApiCache(currentUser.id, '/api/circles');
      invalidateApiCache(currentUser.id, '/api/posts');
      if (wasApproved && activeCircle) {
        const cid = activeCircle.id;
        setActiveCircle((prev) =>
          prev && prev.id === cid
            ? { ...prev, post_count: Math.max(0, prev.post_count - 1) }
            : prev
        );
        setCircles((prev) =>
          prev.map((c) =>
            c.id === cid ? { ...c, post_count: Math.max(0, c.post_count - 1) } : c
          )
        );
      }
    },
    [posts, activeCircle, currentUser.id]
  );

  const handleAggPostUpdated = useCallback(
    (updated: CirclePostItem) => {
      setAggPosts((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
      invalidateApiCache(currentUser.id, '/api/circles/feed/aggregated');
    },
    [currentUser.id]
  );

  const handleAggPostViewSynced = useCallback((postId: number, viewsCount: number) => {
    setAggPosts((prev) =>
      prev.map((p) =>
        p.id === postId
          ? { ...p, views_count: Math.max(p.views_count, viewsCount), has_viewed: true }
          : p
      )
    );
  }, []);

  const handleAggPostDeleted = useCallback(
    (postId: number) => {
      setAggPosts((prev) => prev.filter((p) => p.id !== postId));
      invalidateApiCache(currentUser.id, '/api/circles');
      invalidateApiCache(currentUser.id, '/api/posts');
    },
    [currentUser.id]
  );

  const wordCount = countWords(postContent);
  const showPendingTab =
    isStaff && (Boolean(activeCircle?.require_post_approval) || pendingPosts.length > 0);

  return (
    <div className="space-y-5 min-w-0 w-full">
      {toast && (
        <div
          role="status"
          className={`fixed bottom-20 lg:bottom-6 right-4 sm:right-6 z-40 max-w-[calc(100vw-2rem)] rounded-xl border px-4 py-2.5 text-xs font-medium shadow-xl backdrop-blur-md ${
            toast.variant === 'error'
              ? 'border-rose-500/40 bg-rose-500/15 text-rose-700 dark:text-rose-200'
              : 'border-emerald-500/40 bg-emerald-500/15 text-emerald-700 dark:text-emerald-200'
          }`}
        >
          {toast.text}
        </div>
      )}

      {/* Header + Create Circle + Switcher */}
      <div className="htv-card rounded-2xl p-4 sm:p-5 space-y-4 min-w-0 w-full">
        <div className="flex items-center justify-between gap-3 flex-wrap min-w-0">
          <div className="flex items-center gap-3 min-w-0 flex-1">
            <div className="w-10 h-10 rounded-xl htv-gradient-btn flex items-center justify-center shrink-0">
              <CircleDot className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <h1 className="font-display font-bold text-lg">Circles</h1>
              <p className="text-xs text-[var(--htv-text-dim)]">
                Follow public or private communities, share gallery posts, and invite friends
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => setCreateOpen((prev) => !prev)}
            className="htv-gradient-btn px-3.5 py-2 rounded-xl text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
          >
            {createOpen ? <X className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />}
            {createOpen ? 'Cancel' : 'Create Circle'}
          </button>
        </div>

        {/* Create Circle Form */}
        {createOpen && (
          <form
            onSubmit={handleCreateCircle}
            className="htv-elevated rounded-xl p-4 space-y-3.5 border border-purple-500/25"
          >
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <h2 className="font-display font-semibold text-sm">Create a New Circle</h2>
              <div className="flex items-center gap-1.5 p-1 rounded-lg bg-[var(--htv-surface)] border border-[var(--htv-border-subtle)]">
                {(
                  [
                    { id: 'public', label: 'Public', icon: Globe },
                    { id: 'private', label: 'Private', icon: Lock },
                  ] as const
                ).map((mode) => {
                  const Icon = mode.icon;
                  const active = newPrivacy === mode.id;
                  return (
                    <button
                      key={mode.id}
                      type="button"
                      onClick={() => setNewPrivacy(mode.id)}
                      className={`px-2.5 py-1 rounded-md text-xs font-semibold inline-flex items-center gap-1 cursor-pointer transition-colors ${
                        active
                          ? mode.id === 'public'
                            ? 'bg-emerald-500 text-white'
                            : 'bg-amber-500 text-white'
                          : 'text-[var(--htv-text-muted)] hover:text-[var(--htv-text)]'
                      }`}
                    >
                      <Icon className="w-3 h-3" />
                      {mode.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Circle name (e.g. Late Night Beats)"
                maxLength={80}
                className="h-9 px-3 rounded-lg bg-[var(--htv-input)] border border-[var(--htv-border-subtle)] text-xs text-[var(--htv-text)]"
              />
              <input
                type="text"
                value={newCategory}
                onChange={(e) => setNewCategory(e.target.value)}
                placeholder="Category (e.g. Music, Photography)"
                maxLength={50}
                className="h-9 px-3 rounded-lg bg-[var(--htv-input)] border border-[var(--htv-border-subtle)] text-xs text-[var(--htv-text)]"
              />
            </div>

            <textarea
              rows={2}
              value={newDescription}
              onChange={(e) => setNewDescription(e.target.value)}
              placeholder="What is this Circle about? (no external links)"
              maxLength={800}
              className="w-full p-3 rounded-lg bg-[var(--htv-input)] border border-[var(--htv-border-subtle)] text-xs text-[var(--htv-text)] resize-none"
            />

            <label className="flex items-center justify-between gap-3 p-2.5 rounded-lg bg-[var(--htv-surface)] border border-[var(--htv-border-subtle)] cursor-pointer">
              <div className="min-w-0">
                <p className="text-xs font-semibold flex items-center gap-1.5">
                  <ShieldCheck className="w-3.5 h-3.5 text-purple-400 shrink-0" />
                  Require Post Approval
                </p>
                <p className="text-[11px] text-[var(--htv-text-dim)]">
                  Hold new member posts in Pending Posts until an admin or moderator approves them
                </p>
              </div>
              <input
                type="checkbox"
                checked={newRequireApproval}
                onChange={(e) => setNewRequireApproval(e.target.checked)}
                className="w-4 h-4 accent-purple-500 cursor-pointer shrink-0"
              />
            </label>

            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="flex items-center gap-2">
                <input
                  ref={coverInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/gif"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = '';
                    if (file) {
                      handleUploadImage(file, setUploadingCover, setNewAvatarUrl);
                    }
                  }}
                />
                <button
                  type="button"
                  disabled={uploadingCover}
                  onClick={() => coverInputRef.current?.click()}
                  className="px-3 py-1.5 rounded-lg bg-[var(--htv-surface)] border border-[var(--htv-border-subtle)] text-xs font-medium inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                >
                  <ImageIcon className="w-3.5 h-3.5 text-purple-400" />
                  {uploadingCover
                    ? 'Uploading...'
                    : newAvatarUrl
                    ? 'Change Cover / Logo'
                    : 'Upload Cover / Logo'}
                </button>
                {newAvatarUrl && (
                  <img
                    src={sanitizeMediaUrl(newAvatarUrl)}
                    alt="Circle cover preview"
                    className="w-8 h-8 rounded-lg object-cover border border-[var(--htv-border-subtle)]"
                  />
                )}
              </div>

              <button
                type="submit"
                disabled={creatingCircle || uploadingCover}
                className="htv-gradient-btn px-4 py-2 rounded-lg text-xs font-semibold cursor-pointer disabled:opacity-50"
              >
                {creatingCircle ? 'Creating...' : 'Create Circle'}
              </button>
            </div>
          </form>
        )}

        {/* Circle Switcher Strip */}
        {loadingCircles ? (
          <FeedSkeleton variant="switcher" count={3} label="Loading Circles" />
        ) : circles.length === 0 ? (
          <p className="text-xs text-[var(--htv-text-dim)]">
            No Circles yet. Create the first community above!
          </p>
        ) : (
          <div className="flex items-center gap-2 overflow-x-auto pb-1">
            <button
              type="button"
              onClick={() => {
                setViewMode('aggregated');
                setInviteOpen(false);
              }}
              className={`px-3 py-2 rounded-xl border text-left flex items-center gap-2.5 shrink-0 transition-all cursor-pointer ${
                viewMode === 'aggregated'
                  ? 'border-orange-500/50 bg-gradient-to-r from-purple-500/15 to-orange-500/15 shadow-sm'
                  : 'htv-elevated hover:bg-[var(--htv-hover)]'
              }`}
            >
              <div className="w-8 h-8 rounded-full htv-gradient-btn flex items-center justify-center shrink-0">
                <Sparkles className="w-4 h-4" />
              </div>
              <div className="min-w-0">
                <p className="text-xs font-semibold whitespace-nowrap">Joined Feed</p>
                <p className="text-[11px] text-[var(--htv-text-dim)] whitespace-nowrap">
                  Top &amp; recent posts
                </p>
              </div>
            </button>

            {circles.map((circle) => {
              const selected = viewMode === 'circle' && circle.id === selectedCircleId;
              const logoUrl = sanitizeMediaUrl(circle.avatar_url);
              return (
                <button
                  key={circle.id}
                  type="button"
                  onClick={() => {
                    setSelectedCircleId(circle.id);
                    setViewMode('circle');
                    setTab('feed');
                    setInviteOpen(false);
                  }}
                  className={`px-3 py-2 rounded-xl border text-left flex items-center gap-2.5 shrink-0 transition-all cursor-pointer ${
                    selected
                      ? 'border-orange-500/50 bg-gradient-to-r from-purple-500/15 to-orange-500/15 shadow-sm'
                      : 'htv-elevated hover:bg-[var(--htv-hover)]'
                  }`}
                >
                  <Avatar src={logoUrl} name={circle.name} size="sm" />
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <p className="text-xs font-semibold truncate max-w-[140px]">
                        {circle.name}
                      </p>
                      {circle.privacy === 'private' ? (
                        <Lock className="w-3 h-3 text-amber-500 shrink-0" />
                      ) : (
                        <Globe className="w-3 h-3 text-emerald-500 shrink-0" />
                      )}
                    </div>
                    <p className="text-[11px] text-[var(--htv-text-dim)] truncate">
                      {circle.category} · {circle.member_count} members
                    </p>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Unified Aggregated Joined Circles Feed */}
      {viewMode === 'aggregated' ? (
        <div className="space-y-4">
          <div className="htv-card rounded-2xl px-4 py-3 flex items-center justify-between gap-2 flex-wrap min-w-0">
            <div className="flex items-center gap-2 text-xs text-[var(--htv-text-muted)] min-w-0 flex-1">
              <Sparkles className="w-4 h-4 text-orange-400 shrink-0" />
              <span className="truncate">
                Unified feed across all your joined Circles — ranked by recency &amp; engagement
              </span>
            </div>
            <button
              type="button"
              onClick={() => loadAggregatedFeed(true)}
              disabled={loadingAgg}
              className="px-3 py-1.5 rounded-lg htv-elevated hover:bg-[var(--htv-hover)] text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 ml-auto cursor-pointer disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 shrink-0 ${loadingAgg ? 'animate-spin' : ''}`} />
              Refresh
            </button>
          </div>

          {loadingAgg && aggPosts.length === 0 ? (
            <FeedSkeleton variant="aggregated" count={3} label="Loading joined Circles feed" />
          ) : aggPosts.length === 0 ? (
            <div className="htv-card rounded-2xl p-8 text-center space-y-2">
              <p className="font-display font-semibold text-sm">No posts from your Circles yet</p>
              <p className="text-xs text-[var(--htv-text-dim)]">
                Follow a Circle in the strip above or create your own to see updates here.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {aggPosts.map((post) => (
                <CirclePostCard
                  key={`agg-${post.id}`}
                  post={post}
                  circleId={post.circle_id}
                  currentUser={currentUser}
                  isCircleStaff={
                    post.circle_viewer_role === 'owner' ||
                    post.circle_viewer_role === 'admin' ||
                    post.circle_viewer_role === 'moderator'
                  }
                  onOpenProfile={onOpenProfile}
                  onOpenCircle={(cid) => {
                    setSelectedCircleId(cid);
                    setViewMode('circle');
                    setTab('feed');
                  }}
                  onPostUpdated={handleAggPostUpdated}
                  onViewSynced={handleAggPostViewSynced}
                  onPostDeleted={handleAggPostDeleted}
                  onNotify={showToast}
                />
              ))}
              {hasMoreAgg && (
                <div className="flex justify-center pt-1">
                  <button
                    type="button"
                    disabled={loadingMoreAgg}
                    onClick={handleLoadMoreAggregated}
                    className="px-5 py-2.5 rounded-xl htv-card hover:bg-[var(--htv-hover)] text-xs font-semibold text-purple-600 dark:text-purple-300 cursor-pointer disabled:opacity-50"
                  >
                    {loadingMoreAgg ? 'Loading more...' : 'Load More Posts'}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      ) : loadingDetail && !activeCircle ? (
        <FeedSkeleton variant="circle-workspace" label="Loading Circle" />
      ) : activeCircle ? (
        <div className="space-y-4 min-w-0 w-full">
          {/* Selected Circle Banner & Actions */}
          <div className="htv-card rounded-2xl p-4 sm:p-5 space-y-4 min-w-0 w-full">
            <div className="flex items-start justify-between gap-3 flex-wrap min-w-0">
              <div className="flex items-start gap-3.5 min-w-0 flex-1 basis-56">
                <Avatar
                  src={sanitizeMediaUrl(activeCircle.avatar_url)}
                  name={activeCircle.name}
                  size="lg"
                />
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex items-center gap-2 flex-wrap min-w-0">
                    <h2 className="font-display font-bold text-base break-words">{activeCircle.name}</h2>
                    <span className="px-2 py-0.5 rounded-full text-[11px] font-medium bg-purple-500/15 text-purple-600 dark:text-purple-300 border border-purple-500/25 max-w-full truncate">
                      {activeCircle.category}
                    </span>
                    <span
                      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold border shrink-0 ${
                        activeCircle.privacy === 'private'
                          ? 'bg-amber-500/15 text-amber-600 dark:text-amber-300 border-amber-500/30'
                          : 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30'
                      }`}
                    >
                      {activeCircle.privacy === 'private' ? (
                        <Lock className="w-3 h-3 shrink-0" />
                      ) : (
                        <Globe className="w-3 h-3 shrink-0" />
                      )}
                      {activeCircle.privacy === 'private' ? 'Private' : 'Public'}
                    </span>
                    {activeCircle.require_post_approval && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-sky-500/15 text-sky-600 dark:text-sky-300 border border-sky-500/25 shrink-0">
                        <ShieldCheck className="w-3 h-3 shrink-0" />
                        Post Approval On
                      </span>
                    )}
                    {viewerRole && (
                      <span
                        className={`px-2 py-0.5 rounded-full text-[11px] font-semibold border capitalize shrink-0 ${ROLE_STYLES[viewerRole]}`}
                      >
                        {viewerRole}
                      </span>
                    )}
                  </div>
                  {activeCircle.description && (
                    <p className="text-xs text-[var(--htv-text-muted)] leading-relaxed break-words [overflow-wrap:anywhere]">
                      {activeCircle.description}
                    </p>
                  )}
                  <p className="text-[11px] text-[var(--htv-text-dim)] break-words">
                    Created by @{activeCircle.owner_username} · {activeCircle.member_count}{' '}
                    members · {activeCircle.post_count} posts
                  </p>
                </div>
              </div>

              {/* Follow / Following (Emerald-Teal) + Quick Inquiry + Prominent Invite Button */}
              <div className="flex items-center gap-2 flex-wrap max-w-full">
                {!isOwner && (
                  <button
                    type="button"
                    disabled={followBusy}
                    onClick={handleFollowToggle}
                    className={`px-4 py-2 rounded-xl text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-all cursor-pointer disabled:opacity-60 ${
                      activeCircle.is_member || activeCircle.pending_request
                        ? 'border border-emerald-500/45 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/25'
                        : 'bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-600 hover:to-teal-600 text-white shadow-sm shadow-emerald-500/20'
                    }`}
                  >
                    {activeCircle.is_member ? (
                      <>
                        <UserCheck className="w-3.5 h-3.5 shrink-0" />
                        Following
                      </>
                    ) : activeCircle.pending_request ? (
                      <>
                        <Clock className="w-3.5 h-3.5 shrink-0" />
                        Requested
                      </>
                    ) : activeCircle.privacy === 'private' ? (
                      <>
                        <Lock className="w-3.5 h-3.5 shrink-0" />
                        Request Access
                      </>
                    ) : (
                      <>
                        <UserPlus className="w-3.5 h-3.5 shrink-0" />
                        Follow
                      </>
                    )}
                  </button>
                )}

                {!isOwner && canViewFeed && (
                  <button
                    type="button"
                    onClick={() => setInquiryOpen((prev) => !prev)}
                    className="px-3.5 py-2 rounded-xl border border-orange-500/35 bg-orange-500/10 hover:bg-orange-500/20 text-orange-600 dark:text-orange-300 text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <MessageSquare className="w-3.5 h-3.5 shrink-0" />
                    Quick Inquiry
                  </button>
                )}

                {activeCircle.is_member && (
                  <button
                    type="button"
                    onClick={() => setInviteOpen((prev) => !prev)}
                    className="htv-gradient-btn px-4 py-2 rounded-xl text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <Link2 className="w-3.5 h-3.5 shrink-0" />
                    Invite
                  </button>
                )}
              </div>
            </div>

            {/* Customer Quick Inquiry Drawer */}
            {inquiryOpen && !isOwner && canViewFeed && (
              <form
                onSubmit={handleSendCustomerInquiry}
                className="htv-elevated rounded-xl p-4 space-y-3 border border-orange-500/30"
              >
                <div className="flex items-center justify-between gap-2">
                  <h3 className="font-display font-semibold text-xs uppercase tracking-wide flex items-center gap-1.5 text-orange-500">
                    <MessageSquare className="w-3.5 h-3.5" />
                    Send Customer Inquiry to {activeCircle.name}
                  </h3>
                  <button
                    type="button"
                    onClick={() => setInquiryOpen(false)}
                    aria-label="Close inquiry drawer"
                    className="p-1 rounded-md text-[var(--htv-text-dim)] hover:text-[var(--htv-text)] cursor-pointer"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
                <textarea
                  rows={2}
                  value={inquiryText}
                  onChange={(e) => setInquiryText(e.target.value)}
                  placeholder="Ask about pricing, orders, support, or bookings (delivers straight to staff & Messenger)..."
                  maxLength={2000}
                  className="w-full p-3 rounded-lg bg-[var(--htv-input)] border border-[var(--htv-border-subtle)] text-xs text-[var(--htv-text)] resize-none"
                />
                <div className="flex items-center justify-end gap-2">
                  <button
                    type="submit"
                    disabled={sendingInquiry}
                    className="htv-gradient-btn px-4 py-2 rounded-lg text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                  >
                    <Send className="w-3.5 h-3.5" />
                    {sendingInquiry ? 'Sending...' : 'Send Inquiry'}
                  </button>
                </div>
              </form>
            )}

            {/* Invite Drawer: Invite by @username + Copy Circle Invite Link */}
            {inviteOpen && activeCircle.is_member && (
              <div className="htv-elevated rounded-xl p-4 space-y-3 border border-purple-500/25">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <h3 className="font-display font-semibold text-xs uppercase tracking-wide flex items-center gap-1.5">
                    <UserPlus className="w-3.5 h-3.5 text-emerald-400" />
                    Invite to {activeCircle.name}
                  </h3>
                  <button
                    type="button"
                    onClick={() => setInviteOpen(false)}
                    aria-label="Close invite panel"
                    className="p-1 rounded-md text-[var(--htv-text-dim)] hover:text-[var(--htv-text)] cursor-pointer"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>

                <form onSubmit={handleInviteMember} className="flex items-center gap-2 flex-wrap min-w-0">
                  <input
                    type="text"
                    value={inviteUsername}
                    onChange={(e) => setInviteUsername(e.target.value)}
                    placeholder="Invite user by @username..."
                    className="w-full sm:w-auto sm:flex-1 min-w-0 h-9 px-3 rounded-lg bg-[var(--htv-input)] border border-[var(--htv-border-subtle)] text-xs text-[var(--htv-text)]"
                  />
                  {isAdminOrOwner && (
                    <select
                      value={inviteRole}
                      onChange={(e) =>
                        setInviteRole(e.target.value as 'member' | 'moderator' | 'admin')
                      }
                      aria-label="Invited member role"
                      className="h-9 px-2.5 rounded-lg bg-[var(--htv-input)] border border-[var(--htv-border-subtle)] text-xs text-[var(--htv-text)] shrink-0"
                    >
                      <option value="member">Member</option>
                      <option value="moderator">Moderator</option>
                      {isOwner && <option value="admin">Admin</option>}
                    </select>
                  )}
                  <button
                    type="submit"
                    disabled={inviting}
                    className="bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-600 hover:to-teal-600 text-white h-9 px-3.5 rounded-lg text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
                  >
                    <UserPlus className="w-3.5 h-3.5 shrink-0" />
                    {inviting ? 'Inviting...' : 'Send Invite'}
                  </button>
                </form>

                <div className="pt-2 border-t border-[var(--htv-border-subtle)] flex items-center justify-between gap-2 flex-wrap">
                  <div className="min-w-0 flex-1">
                    <p className="text-[11px] font-semibold text-[var(--htv-text-muted)]">
                      Shareable Circle Invite Link
                    </p>
                    <p className="text-[11px] font-mono-tabular text-[var(--htv-text-dim)] truncate">
                      {buildCircleInviteUrl(activeCircle.id, activeCircle.invite_code)}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={handleCopyInviteLink}
                    className="px-3 py-1.5 rounded-lg bg-[var(--htv-surface)] border border-[var(--htv-border-subtle)] hover:bg-[var(--htv-hover)] text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer shrink-0"
                  >
                    {copiedInvite ? (
                      <>
                        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                        Copied!
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5 text-purple-400" />
                        Copy Invite Link
                      </>
                    )}
                  </button>
                </div>
              </div>
            )}

            {/* Navigation Tabs */}
            <div className="flex items-center gap-1.5 p-1 htv-elevated rounded-xl overflow-x-auto">
              <button
                type="button"
                onClick={() => setTab('feed')}
                className={`flex-1 min-w-[120px] px-3 py-2 rounded-lg text-xs font-semibold inline-flex items-center justify-center gap-1.5 whitespace-nowrap transition-colors cursor-pointer ${
                  tab === 'feed'
                    ? 'htv-gradient-btn'
                    : 'text-[var(--htv-text-muted)] hover:text-[var(--htv-text)] hover:bg-[var(--htv-hover)]'
                }`}
              >
                <CircleDot className="w-3.5 h-3.5" />
                Feed ({posts.length})
              </button>

              {showPendingTab && (
                <button
                  type="button"
                  onClick={() => setTab('pending')}
                  className={`flex-1 min-w-[140px] px-3 py-2 rounded-lg text-xs font-semibold inline-flex items-center justify-center gap-1.5 whitespace-nowrap transition-colors cursor-pointer ${
                    tab === 'pending'
                      ? 'htv-gradient-btn'
                      : 'text-[var(--htv-text-muted)] hover:text-[var(--htv-text)] hover:bg-[var(--htv-hover)]'
                  }`}
                >
                  <Clock className="w-3.5 h-3.5" />
                  Pending Posts
                  {pendingPosts.length > 0 && (
                    <span className="px-1.5 py-0.5 rounded-full bg-orange-500 text-white text-[10px] font-mono-tabular">
                      {pendingPosts.length}
                    </span>
                  )}
                </button>
              )}

              <button
                type="button"
                onClick={() => setTab('members')}
                className={`flex-1 min-w-[125px] px-3 py-2 rounded-lg text-xs font-semibold inline-flex items-center justify-center gap-1.5 whitespace-nowrap transition-colors cursor-pointer ${
                  tab === 'members'
                    ? 'htv-gradient-btn'
                    : 'text-[var(--htv-text-muted)] hover:text-[var(--htv-text)] hover:bg-[var(--htv-hover)]'
                }`}
              >
                <Users className="w-3.5 h-3.5" />
                Members ({activeCircle.member_count})
                {isStaff && followRequests.length > 0 && (
                  <span className="px-1.5 py-0.5 rounded-full bg-emerald-500 text-white text-[10px] font-mono-tabular">
                    {followRequests.length}
                  </span>
                )}
              </button>

              {isStaff && (
                <button
                  type="button"
                  onClick={() => setTab('automation')}
                  className={`flex-1 min-w-[130px] px-3 py-2 rounded-lg text-xs font-semibold inline-flex items-center justify-center gap-1.5 whitespace-nowrap transition-colors cursor-pointer ${
                    tab === 'automation'
                      ? 'htv-gradient-btn'
                      : 'text-[var(--htv-text-muted)] hover:text-[var(--htv-text)] hover:bg-[var(--htv-hover)]'
                  }`}
                >
                  <Zap className="w-3.5 h-3.5 text-orange-400" />
                  Automation
                  {(automationData?.stats.new_inquiries ?? 0) > 0 && (
                    <span className="px-1.5 py-0.5 rounded-full bg-orange-500 text-white text-[10px] font-mono-tabular">
                      {automationData?.stats.new_inquiries}
                    </span>
                  )}
                </button>
              )}
            </div>
          </div>

          {/* Private Circle Locked State */}
          {!canViewFeed ? (
            <div className="htv-card rounded-2xl p-8 text-center space-y-3">
              <div className="w-12 h-12 rounded-2xl bg-amber-500/15 border border-amber-500/30 text-amber-500 flex items-center justify-center mx-auto">
                <Lock className="w-6 h-6" />
              </div>
              <div className="space-y-1 max-w-md mx-auto">
                <h3 className="font-display font-bold text-base">This is a Private Circle</h3>
                <p className="text-xs text-[var(--htv-text-muted)]">
                  Posts and members are only visible to approved followers. Request access above
                  or join using a Circle invite link.
                </p>
              </div>
            </div>
          ) : (
            <>
              {/* TAB 1: CIRCLE FEED */}
              {tab === 'feed' && (
                <div className="space-y-4">
                  {highlightedPostId && (
                    <div className="rounded-xl border border-emerald-500/35 bg-emerald-500/10 px-4 py-2.5 flex items-center justify-between gap-2 flex-wrap min-w-0 text-xs">
                      <span className="text-emerald-700 dark:text-emerald-200 font-medium min-w-0 break-words">
                        Viewing shared Circle post #{highlightedPostId}
                      </span>
                      {onClearHighlightedPost && (
                        <button
                          type="button"
                          onClick={onClearHighlightedPost}
                          className="px-2.5 py-1 rounded-lg htv-elevated hover:bg-[var(--htv-hover)] text-[11px] font-semibold shrink-0 whitespace-nowrap ml-auto cursor-pointer"
                        >
                          Clear
                        </button>
                      )}
                    </div>
                  )}

                  {activeCircle.is_member && (
                    <form
                      onSubmit={handlePublishPost}
                      className="htv-card rounded-2xl p-4 sm:p-5 space-y-3.5"
                    >
                      <div className="flex items-start gap-3">
                        <Avatar src={currentUser.avatar_url} name={currentUser.name} size="md" />
                        <div className="flex-1 min-w-0 space-y-2">
                          <textarea
                            rows={3}
                            value={postContent}
                            onChange={(e) => {
                              setPostContent(e.target.value);
                              if (composerError) setComposerError('');
                            }}
                            placeholder={`Share a post or gallery photo with ${activeCircle.name} (max 200 words, no links)...`}
                            className="w-full rounded-xl htv-elevated p-3 text-sm text-[var(--htv-text)] placeholder:text-[var(--htv-text-dim)] resize-none focus:outline-none focus:ring-2 focus:ring-purple-500/50"
                          />
                          <div className="flex items-center justify-between text-xs gap-2 flex-wrap">
                            <span
                              className={`font-mono-tabular ${
                                wordCount > MAX_WORDS
                                  ? 'text-rose-500 dark:text-rose-400 font-semibold'
                                  : 'text-[var(--htv-text-dim)]'
                              }`}
                            >
                              {wordCount} / {MAX_WORDS} words
                            </span>
                            {activeCircle.require_post_approval && !isStaff && (
                              <span className="text-[11px] text-amber-600 dark:text-amber-300 font-medium">
                                Posts require admin/moderator approval before appearing in Feed
                              </span>
                            )}
                          </div>
                        </div>
                      </div>

                      {postMediaUrl && (
                        <div className="relative htv-elevated rounded-xl p-3">
                          <button
                            type="button"
                            onClick={() => setPostMediaUrl('')}
                            aria-label="Remove attachment"
                            className="absolute top-2 right-2 z-10 p-1.5 rounded-lg bg-black/70 text-white hover:bg-black cursor-pointer"
                          >
                            <X className="w-4 h-4" />
                          </button>
                          <img
                            src={sanitizeMediaUrl(postMediaUrl)}
                            alt="Circle post preview"
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

                      <div className="flex items-center justify-between gap-2 pt-2 border-t border-[var(--htv-border-subtle)] flex-wrap min-w-0">
                        <div className="flex items-center gap-2.5 flex-wrap min-w-0 max-w-full">
                          <input
                            ref={postPhotoRef}
                            type="file"
                            accept="image/jpeg,image/png,image/webp,image/gif"
                            className="hidden"
                            onChange={(e) => {
                              const file = e.target.files?.[0];
                              e.target.value = '';
                              if (file) {
                                handleUploadImage(file, setUploadingPostPhoto, setPostMediaUrl);
                              }
                            }}
                          />
                          <button
                            type="button"
                            disabled={uploadingPostPhoto}
                            onClick={() => postPhotoRef.current?.click()}
                            className="px-3.5 py-2 rounded-lg htv-elevated hover:bg-[var(--htv-hover)] text-xs font-medium text-[var(--htv-text-muted)] hover:text-[var(--htv-text)] inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
                          >
                            <ImageIcon className="w-4 h-4 text-purple-500 dark:text-purple-400 shrink-0" />
                            {uploadingPostPhoto ? 'Uploading...' : 'Gallery Photo'}
                          </button>

                          {activeCircle.privacy === 'public' ? (
                            <label className="inline-flex items-center gap-2 px-2.5 py-1.5 rounded-lg htv-elevated text-[11px] font-medium text-[var(--htv-text-muted)] cursor-pointer select-none max-w-full">
                              <input
                                type="checkbox"
                                checked={broadcastGlobal}
                                onChange={(e) => setBroadcastGlobal(e.target.checked)}
                                className="w-3.5 h-3.5 accent-emerald-500 cursor-pointer shrink-0"
                              />
                              <Globe className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                              <span className="min-w-0 break-words">Broadcast to Global Feed & followers</span>
                            </label>
                          ) : (
                            <span className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg htv-elevated text-[11px] font-medium text-amber-600 dark:text-amber-300 max-w-full">
                              <Lock className="w-3 h-3 shrink-0" />
                              <span>Delivers sequentially to Circle followers only</span>
                            </span>
                          )}
                        </div>

                        <button
                          type="submit"
                          disabled={publishingPost || uploadingPostPhoto}
                          className="htv-gradient-btn px-4 py-2 rounded-xl text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
                        >
                          <Send className="w-3.5 h-3.5 shrink-0" />
                          {publishingPost ? 'Posting...' : 'Post to Circle'}
                        </button>
                      </div>
                    </form>
                  )}

                  {posts.length === 0 ? (
                    <div className="htv-card rounded-2xl p-8 text-center text-xs text-[var(--htv-text-dim)]">
                      No approved posts in {activeCircle.name} yet.
                    </div>
                  ) : (
                    <div className="space-y-4">
                      {posts.map((post) => (
                        <CirclePostCard
                          key={post.id}
                          post={post}
                          circleId={activeCircle.id}
                          currentUser={currentUser}
                          isCircleStaff={isStaff}
                          highlighted={highlightedPostId === post.id}
                          onOpenProfile={onOpenProfile}
                          onPostUpdated={handlePostUpdated}
                          onViewSynced={handlePostViewSynced}
                          onPostDeleted={handlePostDeleted}
                          onNotify={showToast}
                        />
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* TAB 2: PENDING POSTS (Circle Staff Moderation) */}
              {tab === 'pending' && isStaff && (
                <div className="space-y-4">
                  {pendingPosts.length === 0 ? (
                    <div className="htv-card rounded-2xl p-8 text-center text-xs text-[var(--htv-text-dim)]">
                      No posts waiting for approval right now.
                    </div>
                  ) : (
                    pendingPosts.map((post) => (
                      <CirclePostCard
                        key={post.id}
                        post={post}
                        circleId={activeCircle.id}
                        currentUser={currentUser}
                        isCircleStaff={isStaff}
                        isPendingView
                        onOpenProfile={onOpenProfile}
                        onPostUpdated={handlePostUpdated}
                        onViewSynced={handlePostViewSynced}
                        onPostDeleted={handlePostDeleted}
                        onModerate={handleModeratePost}
                        onNotify={showToast}
                      />
                    ))
                  )}
                </div>
              )}

              {/* TAB 3: MEMBERS, FOLLOW REQUESTS & CIRCLE SETTINGS */}
              {tab === 'members' && (
                <div className="space-y-4">
                  {/* Circle Settings (Owner / Admin) */}
                  {isAdminOrOwner && (
                    <div className="htv-card rounded-2xl p-4 sm:p-5 space-y-3">
                      <h3 className="font-display font-semibold text-xs uppercase tracking-wide flex items-center gap-1.5">
                        <Shield className="w-4 h-4 text-purple-400" />
                        Circle Settings
                      </h3>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <label className="flex items-center justify-between gap-3 p-3 rounded-xl htv-elevated cursor-pointer">
                          <div className="min-w-0">
                            <p className="text-xs font-semibold">Require Post Approval</p>
                            <p className="text-[11px] text-[var(--htv-text-dim)]">
                              Staff review member posts first
                            </p>
                          </div>
                          <input
                            type="checkbox"
                            disabled={updatingSettings}
                            checked={activeCircle.require_post_approval}
                            onChange={(e) =>
                              handleUpdateSettings({ require_post_approval: e.target.checked })
                            }
                            className="w-4 h-4 accent-purple-500 cursor-pointer shrink-0"
                          />
                        </label>

                        <div className="flex items-center justify-between gap-3 p-3 rounded-xl htv-elevated">
                          <div className="min-w-0">
                            <p className="text-xs font-semibold">Circle Privacy</p>
                            <p className="text-[11px] text-[var(--htv-text-dim)]">
                              {activeCircle.privacy === 'private'
                                ? 'Approval required to follow'
                                : 'Anyone can follow & read'}
                            </p>
                          </div>
                          <select
                            disabled={updatingSettings}
                            value={activeCircle.privacy}
                            onChange={(e) =>
                              handleUpdateSettings({ privacy: e.target.value as CirclePrivacy })
                            }
                            aria-label="Circle privacy"
                            className="h-8 px-2.5 rounded-lg bg-[var(--htv-input)] border border-[var(--htv-border-subtle)] text-xs font-semibold"
                          >
                            <option value="public">Public</option>
                            <option value="private">Private</option>
                          </select>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Pending Follow Requests (Circle Staff) */}
                  {isStaff && followRequests.length > 0 && (
                    <div className="htv-card rounded-2xl p-4 sm:p-5 space-y-3">
                      <h3 className="font-display font-semibold text-xs uppercase tracking-wide flex items-center gap-1.5 text-emerald-500">
                        <UserPlus className="w-4 h-4" />
                        Pending Follow Requests ({followRequests.length})
                      </h3>
                      <div className="space-y-2">
                        {followRequests.map((req) => (
                          <div
                            key={req.id}
                            className="flex items-center justify-between gap-2 p-3 rounded-xl htv-elevated flex-wrap"
                          >
                            <button
                              type="button"
                              onClick={() => onOpenProfile(req.user_id)}
                              className="flex items-center gap-2.5 min-w-0 text-left cursor-pointer"
                            >
                              <Avatar src={req.avatar_url} name={req.name} size="sm" />
                              <div className="min-w-0">
                                <div className="flex items-center gap-1">
                                  <span className="text-xs font-semibold truncate">{req.name}</span>
                                  <VerifiedBadge verified={req.is_verified} />
                                </div>
                                <p className="text-[11px] text-[var(--htv-text-dim)] truncate">
                                  @{req.username}
                                </p>
                              </div>
                            </button>

                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                onClick={() => handleRespondFollowRequest(req.id, 'approve')}
                                className="px-3 py-1.5 rounded-lg bg-gradient-to-r from-emerald-500 to-teal-500 text-white text-xs font-semibold inline-flex items-center gap-1 cursor-pointer"
                              >
                                <Check className="w-3.5 h-3.5" />
                                Approve
                              </button>
                              <button
                                type="button"
                                onClick={() => handleRespondFollowRequest(req.id, 'reject')}
                                className="px-3 py-1.5 rounded-lg htv-card hover:bg-rose-500/15 text-xs font-medium text-rose-500 cursor-pointer"
                              >
                                Reject
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Members List & Role Management */}
                  <div className="htv-card rounded-2xl p-4 sm:p-5 space-y-3">
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <h3 className="font-display font-semibold text-xs uppercase tracking-wide flex items-center gap-1.5">
                        <Users className="w-4 h-4 text-orange-400" />
                        Circle Members ({members.length})
                      </h3>
                      {activeCircle.is_member && !isOwner && (
                        <button
                          type="button"
                          onClick={() => handleRemoveOrLeave(currentUser.id)}
                          className="px-2.5 py-1 rounded-lg text-[11px] font-semibold text-rose-500 hover:bg-rose-500/10 inline-flex items-center gap-1 cursor-pointer"
                        >
                          <LogOut className="w-3 h-3" />
                          Leave Circle
                        </button>
                      )}
                    </div>

                    <div className="space-y-2">
                      {members.map((mem) => {
                        const canManageMember =
                          isAdminOrOwner &&
                          mem.role !== 'owner' &&
                          (isOwner || mem.role !== 'admin') &&
                          mem.user_id !== currentUser.id;
                        return (
                          <div
                            key={mem.user_id}
                            className="flex items-center justify-between gap-2 p-2.5 rounded-xl htv-elevated flex-wrap sm:flex-nowrap min-w-0"
                          >
                            <button
                              type="button"
                              onClick={() => onOpenProfile(mem.user_id)}
                              className="flex items-center gap-2.5 min-w-0 flex-1 text-left cursor-pointer"
                            >
                              <Avatar
                                src={mem.avatar_url}
                                name={mem.name}
                                size="sm"
                                isOnline={mem.is_online}
                                showOnlineRing
                              />
                              <div className="min-w-0">
                                <div className="flex items-center gap-1">
                                  <span className="text-xs font-semibold truncate">{mem.name}</span>
                                  <VerifiedBadge verified={mem.is_verified} />
                                </div>
                                <p className="text-[11px] text-[var(--htv-text-dim)] truncate">
                                  @{mem.username}
                                </p>
                              </div>
                            </button>

                            <div className="flex items-center gap-2 shrink-0 ml-auto">
                              {canManageMember ? (
                                <>
                                  <select
                                    value={mem.role}
                                    onChange={(e) =>
                                      handleRoleChange(
                                        mem.user_id,
                                        e.target.value as 'admin' | 'moderator' | 'member'
                                      )
                                    }
                                    aria-label={`Role for ${mem.name}`}
                                    className="h-7 px-2 rounded-md bg-[var(--htv-input)] border border-[var(--htv-border-subtle)] text-[11px] font-medium"
                                  >
                                    <option value="member">Member</option>
                                    <option value="moderator">Moderator</option>
                                    {isOwner && <option value="admin">Admin</option>}
                                  </select>
                                  <button
                                    type="button"
                                    onClick={() => handleRemoveOrLeave(mem.user_id)}
                                    aria-label={`Remove ${mem.name}`}
                                    className="p-1.5 rounded-md text-rose-500 hover:bg-rose-500/10 cursor-pointer"
                                  >
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </button>
                                </>
                              ) : (
                                <span
                                  className={`px-2 py-0.5 rounded-full text-[11px] font-semibold border capitalize ${ROLE_STYLES[mem.role]}`}
                                >
                                  {mem.role}
                                </span>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              )}

              {/* TAB 4: BUSINESS AUTOMATION HUB (Staff Only) */}
              {tab === 'automation' && isStaff && (
                <div className="space-y-4">
                  {/* Stats Strip */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    <div className="htv-card rounded-xl p-3.5 space-y-1">
                      <p className="text-[11px] text-[var(--htv-text-dim)]">Total Post Reach</p>
                      <p className="font-display font-bold text-lg font-mono-tabular">
                        {formatCompactViews(automationData?.stats.total_reach ?? 0).replace(' views', '')}
                      </p>
                    </div>
                    <div className="htv-card rounded-xl p-3.5 space-y-1">
                      <p className="text-[11px] text-[var(--htv-text-dim)]">Active Followers</p>
                      <p className="font-display font-bold text-lg font-mono-tabular text-emerald-500">
                        {automationData?.stats.followers_count ?? activeCircle.member_count}
                      </p>
                    </div>
                    <div className="htv-card rounded-xl p-3.5 space-y-1">
                      <p className="text-[11px] text-[var(--htv-text-dim)]">New Inquiries</p>
                      <p className="font-display font-bold text-lg font-mono-tabular text-orange-400">
                        {automationData?.stats.new_inquiries ?? 0}
                      </p>
                    </div>
                    <div className="htv-card rounded-xl p-3.5 space-y-1">
                      <p className="text-[11px] text-[var(--htv-text-dim)]">Auto-Replies Sent</p>
                      <p className="font-display font-bold text-lg font-mono-tabular text-purple-400">
                        {automationData?.stats.auto_replies_sent ?? 0}
                      </p>
                    </div>
                  </div>

                  {/* Automation Sub-Navigation */}
                  <div className="flex items-center gap-1.5 p-1 htv-card rounded-xl overflow-x-auto">
                    {(
                      [
                        { id: 'queue', label: 'Customer Queue', icon: Inbox },
                        { id: 'autopilot', label: 'Auto-Reply', icon: Bot },
                        { id: 'broadcast', label: 'Quick Replies & Broadcast', icon: Megaphone },
                      ] as const
                    ).map((sub) => {
                      const Icon = sub.icon;
                      const active = automationSubTab === sub.id;
                      return (
                        <button
                          key={sub.id}
                          type="button"
                          onClick={() => setAutomationSubTab(sub.id)}
                          className={`flex-1 min-w-[140px] px-3 py-2 rounded-lg text-xs font-semibold inline-flex items-center justify-center gap-1.5 whitespace-nowrap cursor-pointer transition-colors ${
                            active
                              ? 'bg-gradient-to-r from-purple-500/25 to-orange-500/25 text-orange-500 dark:text-orange-300 border border-orange-500/35'
                              : 'text-[var(--htv-text-muted)] hover:text-[var(--htv-text)] hover:bg-[var(--htv-hover)]'
                          }`}
                        >
                          <Icon className="w-3.5 h-3.5 shrink-0" />
                          {sub.label}
                        </button>
                      );
                    })}
                  </div>

                  {loadingAutomation && !automationData ? (
                    <div className="htv-card rounded-2xl p-8 text-center text-xs text-[var(--htv-text-dim)]">
                      Loading Business Automation tools...
                    </div>
                  ) : (
                    <>
                      {/* SUBTAB 1: CUSTOMER INQUIRY QUEUE */}
                      {automationSubTab === 'queue' && (
                        <div className="htv-card rounded-2xl p-4 sm:p-5 space-y-4">
                          <div className="flex items-center justify-between gap-2 flex-wrap">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              {(['all', 'new', 'in_progress', 'resolved'] as const).map((statusKey) => (
                                <button
                                  key={statusKey}
                                  type="button"
                                  onClick={() => setInquiryFilter(statusKey)}
                                  className={`px-3 py-1.5 rounded-lg text-[11px] font-semibold capitalize cursor-pointer ${
                                    inquiryFilter === statusKey
                                      ? 'htv-gradient-btn'
                                      : 'htv-elevated text-[var(--htv-text-muted)] hover:text-[var(--htv-text)]'
                                  }`}
                                >
                                  {statusKey.replace('_', ' ')}
                                </button>
                              ))}
                            </div>

                            {(automationData?.inquiries || []).some((i) => i.status !== 'resolved') && (
                              <button
                                type="button"
                                disabled={bulkBusy}
                                onClick={handleBulkResolveInquiries}
                                className="px-3 py-1.5 rounded-lg bg-emerald-500/15 border border-emerald-500/35 text-emerald-600 dark:text-emerald-300 hover:bg-emerald-500/25 text-[11px] font-semibold inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                              >
                                <CheckCheck className="w-3.5 h-3.5" />
                                {bulkBusy ? 'Resolving...' : 'Resolve All Open'}
                              </button>
                            )}
                          </div>

                          {(() => {
                            const filtered = (automationData?.inquiries || []).filter((inq) =>
                              inquiryFilter === 'all' ? true : inq.status === inquiryFilter
                            );
                            if (filtered.length === 0) {
                              return (
                                <p className="text-xs text-[var(--htv-text-dim)] py-6 text-center">
                                  No customer inquiries match this filter yet. Customers can tap Inquiry on any post or trigger a keyword comment.
                                </p>
                              );
                            }
                            return (
                              <div className="space-y-3">
                                {filtered.map((inq) => (
                                  <div
                                    key={inq.id}
                                    className="htv-elevated rounded-xl p-3.5 space-y-2.5 border border-[var(--htv-border-subtle)] min-w-0"
                                  >
                                    <div className="flex items-start justify-between gap-2 flex-wrap min-w-0">
                                      <button
                                        type="button"
                                        onClick={() => onOpenProfile(inq.customer_id)}
                                        className="flex items-center gap-2.5 text-left min-w-0 flex-1 cursor-pointer"
                                      >
                                        <Avatar
                                          src={inq.customer_avatar}
                                          name={inq.customer_name}
                                          size="sm"
                                        />
                                        <div className="min-w-0 flex-1">
                                          <div className="flex items-center gap-1.5 flex-wrap min-w-0">
                                            <span className="text-xs font-semibold truncate max-w-full">
                                              {inq.customer_name}
                                            </span>
                                            <VerifiedBadge verified={inq.customer_verified} />
                                            <span className="text-[11px] text-[var(--htv-text-dim)] truncate max-w-full">
                                              @{inq.customer_username}
                                            </span>
                                          </div>
                                          <div className="flex items-center gap-1.5 text-[10px] text-[var(--htv-text-dim)] flex-wrap">
                                            <span>{inq.source.replace('_', ' ')}</span>
                                            <span>·</span>
                                            <span>{formatSafeDate(inq.created_at)}</span>
                                          </div>
                                        </div>
                                      </button>

                                      <div className="flex items-center gap-1.5 shrink-0 flex-wrap">
                                        <span
                                          className={`px-2 py-0.5 rounded-full text-[10px] font-semibold border capitalize whitespace-nowrap shrink-0 ${
                                            inq.status === 'resolved'
                                              ? 'bg-emerald-500/15 text-emerald-500 border-emerald-500/30'
                                              : inq.status === 'in_progress'
                                              ? 'bg-purple-500/15 text-purple-400 border-purple-500/30'
                                              : 'bg-orange-500/15 text-orange-400 border-orange-500/30'
                                          }`}
                                        >
                                          {inq.status.replace('_', ' ')}
                                        </span>
                                        {inq.conversation_id && onOpenConversation && (
                                          <button
                                            type="button"
                                            onClick={() => onOpenConversation(inq.conversation_id!)}
                                            className="px-2.5 py-1 rounded-lg bg-purple-500/15 text-purple-600 dark:text-purple-300 hover:bg-purple-500/25 text-[11px] font-semibold whitespace-nowrap shrink-0 cursor-pointer"
                                          >
                                            Open Chat
                                          </button>
                                        )}
                                      </div>
                                    </div>

                                    <p className="text-xs text-[var(--htv-text)] bg-[var(--htv-surface)] rounded-lg px-3 py-2 break-words [overflow-wrap:anywhere]">
                                      {inq.message}
                                    </p>

                                    {inq.last_reply && (
                                      <p className="text-[11px] text-emerald-600 dark:text-emerald-300 px-1 break-words [overflow-wrap:anywhere]">
                                        Last reply{inq.handled_by_name ? ` (${inq.handled_by_name})` : ''}:{' '}
                                        {inq.last_reply}
                                      </p>
                                    )}

                                    {/* 1-Tap Quick Reply Templates */}
                                    {(automationData?.quick_replies.length ?? 0) > 0 && (
                                      <div className="flex items-center gap-1.5 flex-wrap min-w-0">
                                        <span className="text-[10px] font-semibold text-[var(--htv-text-dim)] uppercase tracking-wide shrink-0">
                                          1-Tap Reply:
                                        </span>
                                        {automationData?.quick_replies.map((tmpl) => (
                                          <button
                                            key={tmpl.id}
                                            type="button"
                                            disabled={replyingId === inq.id}
                                            onClick={() =>
                                              handleReplyInquiry(inq.id, {
                                                quickReplyId: tmpl.id,
                                                status: 'resolved',
                                              })
                                            }
                                            className="px-2.5 py-1 rounded-lg bg-[var(--htv-surface)] border border-purple-500/25 hover:border-orange-500/45 text-[11px] font-semibold text-purple-600 dark:text-purple-300 max-w-full truncate cursor-pointer disabled:opacity-50"
                                          >
                                            {tmpl.title}
                                          </button>
                                        ))}
                                      </div>
                                    )}

                                    <div className="flex items-center gap-2 flex-wrap min-w-0">
                                      <input
                                        type="text"
                                        value={replyDrafts[inq.id] || ''}
                                        onChange={(e) =>
                                          setReplyDrafts((prev) => ({
                                            ...prev,
                                            [inq.id]: e.target.value,
                                          }))
                                        }
                                        placeholder="Send direct reply to customer Messenger..."
                                        className="w-full sm:w-auto sm:flex-1 min-w-0 h-8 px-3 rounded-lg bg-[var(--htv-input)] border border-[var(--htv-border-subtle)] text-xs text-[var(--htv-text)]"
                                      />
                                      <button
                                        type="button"
                                        disabled={replyingId === inq.id}
                                        onClick={() =>
                                          handleReplyInquiry(inq.id, { status: 'resolved' })
                                        }
                                        className="htv-gradient-btn h-8 px-3 rounded-lg text-[11px] font-semibold inline-flex items-center gap-1 whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
                                      >
                                        <Send className="w-3 h-3 shrink-0" />
                                        Reply
                                      </button>
                                      {inq.status !== 'resolved' && (
                                        <button
                                          type="button"
                                          disabled={replyingId === inq.id}
                                          onClick={() =>
                                            handleReplyInquiry(inq.id, {
                                              replyText: '',
                                              status: 'resolved',
                                            })
                                          }
                                          className="h-8 px-2.5 rounded-lg bg-emerald-500/15 text-emerald-500 hover:bg-emerald-500/25 text-[11px] font-semibold whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
                                        >
                                          Resolve
                                        </button>
                                      )}
                                    </div>
                                  </div>
                                ))}
                              </div>
                            );
                          })()}
                        </div>
                      )}

                      {/* SUBTAB 2: AUTO-PILOT RULES & KEYWORD AUTO-REPLIES */}
                      {automationSubTab === 'autopilot' && (
                        <div className="space-y-4">
                          {followRequests.length > 0 && (
                            <div className="htv-card rounded-2xl p-4 flex items-center justify-between gap-3 flex-wrap border border-emerald-500/35">
                              <div>
                                <p className="text-xs font-semibold text-emerald-500">
                                  {followRequests.length} Pending Join Requests
                                </p>
                                <p className="text-[11px] text-[var(--htv-text-dim)]">
                                  Approve everyone in one click & send Auto-Welcome DMs sequentially
                                </p>
                              </div>
                              <button
                                type="button"
                                disabled={approveAllBusy}
                                onClick={handleApproveAllFollowRequests}
                                className="px-3.5 py-2 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-500 text-white text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                              >
                                <CheckCheck className="w-3.5 h-3.5" />
                                {approveAllBusy ? 'Approving...' : 'Approve All Requests'}
                              </button>
                            </div>
                          )}

                          <form
                            onSubmit={handleSaveAutomationSettings}
                            className="htv-card rounded-2xl p-4 sm:p-5 space-y-4"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <h3 className="font-display font-semibold text-xs uppercase tracking-wide flex items-center gap-1.5">
                                <Sparkles className="w-4 h-4 text-orange-400" />
                                Auto-Reply Templates &amp; Rules
                              </h3>
                              {!isAdminOrOwner && (
                                <span className="text-[11px] text-[var(--htv-text-dim)]">
                                  Owner/Admin editable
                                </span>
                              )}
                            </div>

                            {/* 1. New Member Join Welcome Auto-Reply */}
                            <div className="htv-elevated rounded-xl p-3.5 space-y-2.5 border border-[var(--htv-border-subtle)]">
                              <label className="flex items-center justify-between gap-3 cursor-pointer">
                                <div className="min-w-0">
                                  <p className="text-xs font-semibold">
                                    Auto-Welcome DM (New Member Join)
                                  </p>
                                  <p className="text-[11px] text-[var(--htv-text-dim)]">
                                    Triggered automatically when someone joins or is approved
                                  </p>
                                </div>
                                <input
                                  type="checkbox"
                                  disabled={!isAdminOrOwner}
                                  checked={autoWelcomeEnabled}
                                  onChange={(e) => setAutoWelcomeEnabled(e.target.checked)}
                                  className="w-4 h-4 accent-purple-500 cursor-pointer shrink-0"
                                />
                              </label>

                              <div className="flex items-center justify-between gap-2 flex-wrap">
                                <span className="text-[11px] font-semibold text-[var(--htv-text-muted)]">
                                  Welcome Message Template
                                </span>
                                {isAdminOrOwner && (
                                  <div className="flex items-center gap-1.5">
                                    <button
                                      type="button"
                                      onClick={() =>
                                        setAutoWelcomeMessage((prev) => `${prev} {{name}}`.trim())
                                      }
                                      className="px-2 py-0.5 rounded bg-purple-500/15 text-purple-400 text-[10px] font-mono-tabular cursor-pointer"
                                    >
                                      + {'{{name}}'}
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() =>
                                        setAutoWelcomeMessage((prev) => `${prev} {{circle}}`.trim())
                                      }
                                      className="px-2 py-0.5 rounded bg-orange-500/15 text-orange-400 text-[10px] font-mono-tabular cursor-pointer"
                                    >
                                      + {'{{circle}}'}
                                    </button>
                                  </div>
                                )}
                              </div>
                              <textarea
                                rows={2}
                                disabled={!isAdminOrOwner}
                                value={autoWelcomeMessage}
                                onChange={(e) => setAutoWelcomeMessage(e.target.value)}
                                placeholder="Welcome {{name}} to {{circle}}! Reply here anytime for pricing or support."
                                maxLength={1500}
                                className="w-full p-3 rounded-xl bg-[var(--htv-input)] border border-[var(--htv-border-subtle)] text-xs text-[var(--htv-text)] resize-none"
                              />
                            </div>

                            {/* 2. Direct Message / Common Inquiry Auto-Reply */}
                            <div className="htv-elevated rounded-xl p-3.5 space-y-2.5 border border-orange-500/20">
                              <label className="flex items-center justify-between gap-3 cursor-pointer">
                                <div className="min-w-0">
                                  <p className="text-xs font-semibold">
                                    Direct Inquiry Auto-Reply (Common Questions)
                                  </p>
                                  <p className="text-[11px] text-[var(--htv-text-dim)]">
                                    Triggered automatically when a user sends a direct message or inquiry to this Circle
                                  </p>
                                </div>
                                <input
                                  type="checkbox"
                                  disabled={!isAdminOrOwner}
                                  checked={autoInquiryEnabled}
                                  onChange={(e) => setAutoInquiryEnabled(e.target.checked)}
                                  className="w-4 h-4 accent-orange-500 cursor-pointer shrink-0"
                                />
                              </label>

                              <div className="flex items-center justify-between gap-2 flex-wrap">
                                <span className="text-[11px] font-semibold text-[var(--htv-text-muted)]">
                                  Inquiry Auto-Reply Template
                                </span>
                                {isAdminOrOwner && (
                                  <div className="flex items-center gap-1.5 flex-wrap">
                                    <button
                                      type="button"
                                      onClick={() =>
                                        setAutoInquiryMessage((prev) => `${prev} {{name}}`.trim())
                                      }
                                      className="px-2 py-0.5 rounded bg-purple-500/15 text-purple-400 text-[10px] font-mono-tabular cursor-pointer"
                                    >
                                      + {'{{name}}'}
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() =>
                                        setAutoInquiryMessage((prev) => `${prev} {{circle}}`.trim())
                                      }
                                      className="px-2 py-0.5 rounded bg-orange-500/15 text-orange-400 text-[10px] font-mono-tabular cursor-pointer"
                                    >
                                      + {'{{circle}}'}
                                    </button>
                                    {(automationData?.quick_replies || []).map((tmpl) => (
                                      <button
                                        key={`use-inq-${tmpl.id}`}
                                        type="button"
                                        onClick={() => setAutoInquiryMessage(tmpl.content)}
                                        className="px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-500 text-[10px] font-semibold cursor-pointer"
                                      >
                                        Use: {tmpl.title}
                                      </button>
                                    ))}
                                  </div>
                                )}
                              </div>
                              <textarea
                                rows={2}
                                disabled={!isAdminOrOwner}
                                value={autoInquiryMessage}
                                onChange={(e) => setAutoInquiryMessage(e.target.value)}
                                placeholder="Hi {{name}}! Thanks for messaging {{circle}}. Our team has received your inquiry and will reply shortly."
                                maxLength={1500}
                                className="w-full p-3 rounded-xl bg-[var(--htv-input)] border border-[var(--htv-border-subtle)] text-xs text-[var(--htv-text)] resize-none"
                              />
                            </div>

                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                              <label className="flex items-center justify-between gap-3 p-3 rounded-xl htv-elevated cursor-pointer">
                                <div className="min-w-0">
                                  <p className="text-xs font-semibold">Auto-Approve Verified Users</p>
                                  <p className="text-[11px] text-[var(--htv-text-dim)]">
                                    Instant join for verified profiles in Private Circles
                                  </p>
                                </div>
                                <input
                                  type="checkbox"
                                  disabled={!isAdminOrOwner}
                                  checked={autoApproveVerified}
                                  onChange={(e) => setAutoApproveVerified(e.target.checked)}
                                  className="w-4 h-4 accent-emerald-500 cursor-pointer shrink-0"
                                />
                              </label>

                              <label className="flex items-center justify-between gap-3 p-3 rounded-xl htv-elevated cursor-pointer">
                                <div className="min-w-0">
                                  <p className="text-xs font-semibold">Keyword Auto-Replies</p>
                                  <p className="text-[11px] text-[var(--htv-text-dim)]">
                                    Match comments &amp; direct inquiries by keyword
                                  </p>
                                </div>
                                <input
                                  type="checkbox"
                                  disabled={!isAdminOrOwner}
                                  checked={autoKeywordEnabled}
                                  onChange={(e) => setAutoKeywordEnabled(e.target.checked)}
                                  className="w-4 h-4 accent-orange-500 cursor-pointer shrink-0"
                                />
                              </label>
                            </div>

                            {isAdminOrOwner && (
                              <div className="flex justify-end">
                                <button
                                  type="submit"
                                  disabled={savingAutoSettings}
                                  className="htv-gradient-btn px-4 py-2 rounded-xl text-xs font-semibold cursor-pointer disabled:opacity-50"
                                >
                                  {savingAutoSettings ? 'Saving...' : 'Save Auto-Reply Settings'}
                                </button>
                              </div>
                            )}
                          </form>

                          {/* Keyword Auto-Reply Rules */}
                          <div className="htv-card rounded-2xl p-4 sm:p-5 space-y-3.5">
                            <h3 className="font-display font-semibold text-xs uppercase tracking-wide flex items-center gap-1.5">
                              <Bot className="w-4 h-4 text-purple-400" />
                              Keyword Auto-Replies ({automationData?.keyword_rules.length ?? 0})
                            </h3>

                            {isAdminOrOwner && (
                              <form onSubmit={handleAddKeywordRule} className="htv-elevated rounded-xl p-3 space-y-2.5">
                                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                                  <input
                                    type="text"
                                    value={newKeyword}
                                    onChange={(e) => setNewKeyword(e.target.value)}
                                    placeholder="Trigger keyword (e.g. price)"
                                    maxLength={40}
                                    className="h-9 px-3 rounded-lg bg-[var(--htv-input)] border border-[var(--htv-border-subtle)] text-xs text-[var(--htv-text)]"
                                  />
                                  <input
                                    type="text"
                                    value={newKeywordReply}
                                    onChange={(e) => setNewKeywordReply(e.target.value)}
                                    placeholder="Instant reply sent to comment & DM..."
                                    maxLength={2000}
                                    className="sm:col-span-2 h-9 px-3 rounded-lg bg-[var(--htv-input)] border border-[var(--htv-border-subtle)] text-xs text-[var(--htv-text)]"
                                  />
                                </div>
                                <div className="flex items-center justify-between gap-2 flex-wrap">
                                  <label className="inline-flex items-center gap-2 text-[11px] text-[var(--htv-text-muted)] cursor-pointer">
                                    <input
                                      type="checkbox"
                                      checked={newKeywordCreateLead}
                                      onChange={(e) => setNewKeywordCreateLead(e.target.checked)}
                                      className="w-3.5 h-3.5 accent-orange-500"
                                    />
                                    Also open Customer Queue lead & Messenger DM
                                  </label>
                                  <button
                                    type="submit"
                                    disabled={addingKeyword}
                                    className="htv-gradient-btn px-3.5 py-1.5 rounded-lg text-xs font-semibold inline-flex items-center gap-1 cursor-pointer disabled:opacity-50"
                                  >
                                    <Plus className="w-3.5 h-3.5" />
                                    {addingKeyword ? 'Adding...' : 'Add Rule'}
                                  </button>
                                </div>
                              </form>
                            )}

                            <div className="space-y-2">
                              {(automationData?.keyword_rules || []).map((rule) => {
                                const isEditing = editingRuleId === rule.id;
                                const isActive = rule.is_active !== false;
                                if (isEditing) {
                                  return (
                                    <form
                                      key={rule.id}
                                      onSubmit={handleSaveEditKeywordRule}
                                      className="p-3 rounded-xl htv-elevated border border-purple-500/35 space-y-2.5"
                                    >
                                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                                        <input
                                          type="text"
                                          value={editRuleKeyword}
                                          onChange={(e) => setEditRuleKeyword(e.target.value)}
                                          placeholder="Trigger keyword"
                                          maxLength={40}
                                          className="h-9 px-3 rounded-lg bg-[var(--htv-input)] border border-[var(--htv-border-subtle)] text-xs text-[var(--htv-text)]"
                                        />
                                        <input
                                          type="text"
                                          value={editRuleReply}
                                          onChange={(e) => setEditRuleReply(e.target.value)}
                                          placeholder="Auto-reply message..."
                                          maxLength={2000}
                                          className="sm:col-span-2 h-9 px-3 rounded-lg bg-[var(--htv-input)] border border-[var(--htv-border-subtle)] text-xs text-[var(--htv-text)]"
                                        />
                                      </div>
                                      <div className="flex items-center justify-between gap-2 flex-wrap">
                                        <label className="inline-flex items-center gap-2 text-[11px] text-[var(--htv-text-muted)] cursor-pointer">
                                          <input
                                            type="checkbox"
                                            checked={editRuleCreateLead}
                                            onChange={(e) => setEditRuleCreateLead(e.target.checked)}
                                            className="w-3.5 h-3.5 accent-orange-500"
                                          />
                                          Also open Customer Queue lead &amp; Messenger DM
                                        </label>
                                        <div className="flex items-center gap-1.5">
                                          <button
                                            type="button"
                                            onClick={() => setEditingRuleId(null)}
                                            className="px-3 py-1.5 rounded-lg htv-card text-xs font-semibold cursor-pointer"
                                          >
                                            Cancel
                                          </button>
                                          <button
                                            type="submit"
                                            disabled={savingRuleEdit}
                                            className="htv-gradient-btn px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer disabled:opacity-50"
                                          >
                                            {savingRuleEdit ? 'Saving...' : 'Save'}
                                          </button>
                                        </div>
                                      </div>
                                    </form>
                                  );
                                }
                                return (
                                  <div
                                    key={rule.id}
                                    className={`flex items-start justify-between gap-2 flex-wrap sm:flex-nowrap min-w-0 p-3 rounded-xl htv-elevated transition-opacity ${
                                      isActive ? '' : 'opacity-65'
                                    }`}
                                  >
                                    <div className="min-w-0 flex-1 space-y-1">
                                      <div className="flex items-center gap-2 flex-wrap min-w-0">
                                        <span className="px-2 py-0.5 rounded-md bg-orange-500/15 text-orange-500 text-[11px] font-semibold font-mono-tabular max-w-full break-all">
                                          "{rule.keyword}"
                                        </span>
                                        <span
                                          className={`px-2 py-0.5 rounded-full text-[10px] font-semibold border shrink-0 ${
                                            isActive
                                              ? 'bg-emerald-500/15 text-emerald-500 border-emerald-500/30'
                                              : 'bg-slate-500/15 text-[var(--htv-text-dim)] border-[var(--htv-border-subtle)]'
                                          }`}
                                        >
                                          {isActive ? 'Active' : 'Paused'}
                                        </span>
                                        <span className="text-[11px] text-[var(--htv-text-dim)]">
                                          {rule.hit_count} triggers
                                        </span>
                                        {rule.create_inquiry && (
                                          <span className="text-[10px] text-emerald-500 font-medium">
                                            · Auto-Lead + DM
                                          </span>
                                        )}
                                      </div>
                                      <p className="text-xs text-[var(--htv-text)] break-words [overflow-wrap:anywhere]">
                                        {rule.reply_text}
                                      </p>
                                    </div>
                                    {isAdminOrOwner && (
                                      <div className="flex items-center gap-1 shrink-0 ml-auto">
                                        <button
                                          type="button"
                                          disabled={togglingRuleId === rule.id}
                                          onClick={() => handleToggleKeywordRule(rule.id, isActive)}
                                          aria-label={
                                            isActive
                                              ? `Pause keyword rule ${rule.keyword}`
                                              : `Activate keyword rule ${rule.keyword}`
                                          }
                                          title={isActive ? 'Pause rule' : 'Activate rule'}
                                          className={`p-1.5 rounded-lg cursor-pointer disabled:opacity-50 ${
                                            isActive
                                              ? 'text-emerald-500 hover:bg-emerald-500/10'
                                              : 'text-[var(--htv-text-dim)] hover:bg-[var(--htv-hover)]'
                                          }`}
                                        >
                                          {isActive ? (
                                            <Pause className="w-3.5 h-3.5" />
                                          ) : (
                                            <Play className="w-3.5 h-3.5" />
                                          )}
                                        </button>
                                        <button
                                          type="button"
                                          onClick={() => {
                                            setEditingRuleId(rule.id);
                                            setEditRuleKeyword(rule.keyword);
                                            setEditRuleReply(rule.reply_text);
                                            setEditRuleCreateLead(Boolean(rule.create_inquiry));
                                          }}
                                          aria-label={`Edit keyword rule ${rule.keyword}`}
                                          className="p-1.5 rounded-lg text-purple-400 hover:bg-purple-500/10 cursor-pointer"
                                        >
                                          <Pencil className="w-3.5 h-3.5" />
                                        </button>
                                        <button
                                          type="button"
                                          onClick={() => handleDeleteKeywordRule(rule.id)}
                                          aria-label={`Delete keyword rule ${rule.keyword}`}
                                          className="p-1.5 rounded-lg text-rose-500 hover:bg-rose-500/10 cursor-pointer"
                                        >
                                          <Trash2 className="w-3.5 h-3.5" />
                                        </button>
                                      </div>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        </div>
                      )}

                      {/* SUBTAB 3: QUICK REPLIES & SEQUENTIAL FOLLOWER BROADCAST */}
                      {automationSubTab === 'broadcast' && (
                        <div className="space-y-4">
                          {/* Sequential Broadcast */}
                          {isAdminOrOwner && (
                            <form
                              onSubmit={handleSendSequentialBroadcast}
                              className="htv-card rounded-2xl p-4 sm:p-5 space-y-3"
                            >
                              <div className="flex items-center justify-between gap-2 flex-wrap">
                                <h3 className="font-display font-semibold text-xs uppercase tracking-wide flex items-center gap-1.5">
                                  <Megaphone className="w-4 h-4 text-orange-400" />
                                  Sequential Follower Broadcast
                                </h3>
                                <span className="text-[11px] text-[var(--htv-text-dim)]">
                                  Delivers in order to {activeCircle.member_count} members (60s cooldown)
                                </span>
                              </div>
                              <textarea
                                rows={3}
                                value={broadcastMessage}
                                onChange={(e) => setBroadcastMessage(e.target.value)}
                                placeholder="Announce a new offer, restock, or update to all followers sequentially (no external links)..."
                                maxLength={2000}
                                className="w-full p-3 rounded-xl bg-[var(--htv-input)] border border-[var(--htv-border-subtle)] text-xs text-[var(--htv-text)] resize-none"
                              />
                              <div className="flex items-center justify-between gap-2 flex-wrap">
                                <label className="inline-flex items-center gap-2 text-xs text-[var(--htv-text-muted)] cursor-pointer">
                                  <input
                                    type="checkbox"
                                    checked={broadcastSendDm}
                                    onChange={(e) => setBroadcastSendDm(e.target.checked)}
                                    className="w-4 h-4 accent-purple-500"
                                  />
                                  Also deliver directly into each follower&apos;s Messenger inbox
                                </label>
                                <button
                                  type="submit"
                                  disabled={sendingBroadcast}
                                  className="htv-gradient-btn px-4 py-2 rounded-xl text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                                >
                                  <Send className="w-3.5 h-3.5" />
                                  {sendingBroadcast ? 'Dispatching...' : 'Send Broadcast'}
                                </button>
                              </div>
                            </form>
                          )}

                          {/* Quick Reply Templates */}
                          <div className="htv-card rounded-2xl p-4 sm:p-5 space-y-3.5">
                            <h3 className="font-display font-semibold text-xs uppercase tracking-wide flex items-center gap-1.5">
                              <Zap className="w-4 h-4 text-purple-400" />
                              Saved Quick Reply Templates ({automationData?.quick_replies.length ?? 0})
                            </h3>

                            <form onSubmit={handleAddQuickReply} className="htv-elevated rounded-xl p-3 space-y-2.5">
                              <input
                                type="text"
                                value={newTemplateTitle}
                                onChange={(e) => setNewTemplateTitle(e.target.value)}
                                placeholder="Template label (e.g. Booking Slots, Shipping Info)"
                                maxLength={60}
                                className="w-full h-9 px-3 rounded-lg bg-[var(--htv-input)] border border-[var(--htv-border-subtle)] text-xs text-[var(--htv-text)]"
                              />
                              <textarea
                                rows={2}
                                value={newTemplateContent}
                                onChange={(e) => setNewTemplateContent(e.target.value)}
                                placeholder="Full reply text sent in 1 tap from the Customer Queue..."
                                maxLength={2000}
                                className="w-full p-2.5 rounded-lg bg-[var(--htv-input)] border border-[var(--htv-border-subtle)] text-xs text-[var(--htv-text)] resize-none"
                              />
                              <div className="flex justify-end">
                                <button
                                  type="submit"
                                  disabled={addingTemplate}
                                  className="htv-gradient-btn px-3.5 py-1.5 rounded-lg text-xs font-semibold inline-flex items-center gap-1 cursor-pointer disabled:opacity-50"
                                >
                                  <Plus className="w-3.5 h-3.5" />
                                  {addingTemplate ? 'Saving...' : 'Save Quick Reply'}
                                </button>
                              </div>
                            </form>

                            <div className="space-y-2">
                              {(automationData?.quick_replies || []).map((tmpl) => {
                                const isEditing = editingTemplateId === tmpl.id;
                                if (isEditing) {
                                  return (
                                    <form
                                      key={tmpl.id}
                                      onSubmit={handleSaveEditQuickReply}
                                      className="p-3 rounded-xl htv-elevated border border-purple-500/35 space-y-2.5"
                                    >
                                      <input
                                        type="text"
                                        value={editTemplateTitle}
                                        onChange={(e) => setEditTemplateTitle(e.target.value)}
                                        placeholder="Template label"
                                        maxLength={60}
                                        className="w-full h-9 px-3 rounded-lg bg-[var(--htv-input)] border border-[var(--htv-border-subtle)] text-xs text-[var(--htv-text)]"
                                      />
                                      <textarea
                                        rows={2}
                                        value={editTemplateContent}
                                        onChange={(e) => setEditTemplateContent(e.target.value)}
                                        placeholder="Reply template text..."
                                        maxLength={2000}
                                        className="w-full p-2.5 rounded-lg bg-[var(--htv-input)] border border-[var(--htv-border-subtle)] text-xs text-[var(--htv-text)] resize-none"
                                      />
                                      <div className="flex justify-end gap-1.5">
                                        <button
                                          type="button"
                                          onClick={() => setEditingTemplateId(null)}
                                          className="px-3 py-1.5 rounded-lg htv-card text-xs font-semibold cursor-pointer"
                                        >
                                          Cancel
                                        </button>
                                        <button
                                          type="submit"
                                          disabled={savingTemplateEdit}
                                          className="htv-gradient-btn px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer disabled:opacity-50"
                                        >
                                          {savingTemplateEdit ? 'Saving...' : 'Save'}
                                        </button>
                                      </div>
                                    </form>
                                  );
                                }
                                return (
                                  <div
                                    key={tmpl.id}
                                    className="flex items-start justify-between gap-2 flex-wrap sm:flex-nowrap min-w-0 p-3 rounded-xl htv-elevated"
                                  >
                                    <div className="min-w-0 flex-1 space-y-0.5">
                                      <div className="flex items-center gap-2 flex-wrap min-w-0">
                                        <span className="text-xs font-semibold text-purple-600 dark:text-purple-300 break-words max-w-full">
                                          {tmpl.title}
                                        </span>
                                        <span className="text-[11px] text-[var(--htv-text-dim)] shrink-0">
                                          · used {tmpl.usage_count} times
                                        </span>
                                      </div>
                                      <p className="text-xs text-[var(--htv-text)] break-words [overflow-wrap:anywhere]">
                                        {tmpl.content}
                                      </p>
                                    </div>
                                    <div className="flex items-center gap-1 shrink-0 ml-auto">
                                      <button
                                        type="button"
                                        onClick={() => {
                                          setEditingTemplateId(tmpl.id);
                                          setEditTemplateTitle(tmpl.title);
                                          setEditTemplateContent(tmpl.content);
                                        }}
                                        aria-label={`Edit template ${tmpl.title}`}
                                        className="p-1.5 rounded-lg text-purple-400 hover:bg-purple-500/10 cursor-pointer"
                                      >
                                        <Pencil className="w-3.5 h-3.5" />
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => handleDeleteQuickReply(tmpl.id)}
                                        aria-label={`Delete template ${tmpl.title}`}
                                        className="p-1.5 rounded-lg text-rose-500 hover:bg-rose-500/10 cursor-pointer"
                                      >
                                        <Trash2 className="w-3.5 h-3.5" />
                                      </button>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
};
