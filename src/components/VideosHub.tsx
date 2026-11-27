import React, { useEffect, useRef, useState } from 'react';
import {
  Play,
  Search,
  Heart,
  ThumbsUp,
  Eye,
  MessageCircle,
  Flag,
  Volume2,
} from 'lucide-react';
import { Avatar, VerifiedBadge } from './Avatar';
import { apiFetch } from '../lib/api';
import { cachedApiFetch, invalidateApiCache } from '../lib/cache';
import { MAX_WORDS, validateTextField } from '../shared/validation';
import type { CommunityVideo, VideoComment } from '../shared/types';

interface VideosHubProps {
  currentUserId?: number;
  onOpenProfile: (userId: number) => void;
}

export const VideosHub: React.FC<VideosHubProps> = ({ currentUserId, onOpenProfile }) => {
  const [videos, setVideos] = useState<CommunityVideo[]>([]);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<CommunityVideo | null>(null);
  const [comments, setComments] = useState<VideoComment[]>([]);
  const [commentsOpen, setCommentsOpen] = useState(true);
  const [commentText, setCommentText] = useState('');
  const [commentError, setCommentError] = useState('');
  const [loading, setLoading] = useState(true);
  const [reportMsg, setReportMsg] = useState('');
  const [failedThumbIds, setFailedThumbIds] = useState<Record<number, boolean>>({});

  const commentInputRef = useRef<HTMLInputElement>(null);
  const featuredContainerRef = useRef<HTMLDivElement>(null);
  const timersRef = useRef<number[]>([]);

  useEffect(() => {
    return () => {
      for (const id of timersRef.current) {
        window.clearTimeout(id);
      }
      timersRef.current = [];
    };
  }, []);

  const loadVideos = async (q: string) => {
    setLoading(true);
    try {
      const path = `/api/videos?q=${encodeURIComponent(q)}`;
      const applyVideos = (data: { videos: CommunityVideo[] }) => {
        setVideos(data.videos);
        setSelected((prev) => prev ?? data.videos[0] ?? null);
      };
      const data =
        !q && currentUserId
          ? await cachedApiFetch<{ videos: CommunityVideo[] }>(path, {
              userId: currentUserId,
              ttlMs: 45_000,
              onRevalidated: applyVideos,
            })
          : await apiFetch<{ videos: CommunityVideo[] }>(path);
      applyVideos(data);
      if (!selected && data.videos.length > 0) {
        selectVideo(data.videos[0]);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const timer = window.setTimeout(() => loadVideos(search), 180);
    return () => window.clearTimeout(timer);
  }, [search]);

  const selectVideo = async (video: CommunityVideo, focusComment = false) => {
    setSelected(video);
    setCommentError('');
    if (focusComment) {
      setCommentsOpen(true);
      timersRef.current.push(
        window.setTimeout(() => {
          featuredContainerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          commentInputRef.current?.focus();
        }, 120)
      );
    }
    try {
      await apiFetch(`/api/videos/${video.id}/view`, { method: 'POST' });
      setVideos((prev) =>
        prev.map((v) => (v.id === video.id ? { ...v, views_count: v.views_count + 1 } : v))
      );
      const cData = await apiFetch<{ comments: VideoComment[] }>(`/api/videos/${video.id}/comments`);
      setComments(cData.comments);
    } catch {
      // ignore
    }
  };

  const handleLike = async (videoId: number) => {
    try {
      const res = await apiFetch<{ liked: boolean; likes_count: number }>(
        `/api/videos/${videoId}/like`,
        { method: 'POST' }
      );
      setVideos((prev) =>
        prev.map((v) =>
          v.id === videoId ? { ...v, is_liked: res.liked, likes_count: res.likes_count } : v
        )
      );
      if (selected?.id === videoId) {
        setSelected((prev) =>
          prev ? { ...prev, is_liked: res.liked, likes_count: res.likes_count } : prev
        );
      }
      if (currentUserId) invalidateApiCache(currentUserId, '/api/videos');
    } catch {
      // ignore
    }
  };

  const handleLove = async (videoId: number) => {
    try {
      const res = await apiFetch<{ loved: boolean; loves_count: number }>(
        `/api/videos/${videoId}/love`,
        { method: 'POST' }
      );
      setVideos((prev) =>
        prev.map((v) =>
          v.id === videoId ? { ...v, is_loved: res.loved, loves_count: res.loves_count } : v
        )
      );
      if (selected?.id === videoId) {
        setSelected((prev) =>
          prev ? { ...prev, is_loved: res.loved, loves_count: res.loves_count } : prev
        );
      }
      if (currentUserId) invalidateApiCache(currentUserId, '/api/videos');
    } catch {
      // ignore
    }
  };

  const handleComment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selected) return;
    setCommentError('');
    const check = validateTextField(commentText, 'Comment', { required: true, maxWords: MAX_WORDS });
    if (!check.valid) {
      setCommentError(check.error || 'Invalid comment.');
      return;
    }
    try {
      const res = await apiFetch<{ comment: VideoComment }>(`/api/videos/${selected.id}/comments`, {
        method: 'POST',
        body: JSON.stringify({ content: commentText }),
      });
      setComments((prev) => [...prev, res.comment]);
      setVideos((prev) =>
        prev.map((v) =>
          v.id === selected.id ? { ...v, comments_count: v.comments_count + 1 } : v
        )
      );
      setSelected((prev) =>
        prev ? { ...prev, comments_count: prev.comments_count + 1 } : prev
      );
      setCommentText('');
      if (currentUserId) invalidateApiCache(currentUserId, '/api/videos');
    } catch (err: any) {
      setCommentError(err?.message || 'Comment blocked.');
    }
  };

  const handleReport = async (videoId: number) => {
    try {
      const res = await apiFetch<{ case_id?: string }>('/api/reports', {
        method: 'POST',
        body: JSON.stringify({
          target_type: 'video',
          target_id: videoId,
          reason: 'Reported from Community Videos Hub',
        }),
      });
      setReportMsg(
        res.case_id
          ? `Video reported for moderator review · Case ID: ${res.case_id}`
          : 'Video reported for moderator review.'
      );
      timersRef.current.push(window.setTimeout(() => setReportMsg(''), 3500));
    } catch (err: any) {
      setReportMsg(err?.message || 'Could not submit video report.');
      timersRef.current.push(window.setTimeout(() => setReportMsg(''), 3500));
    }
  };

  const isAudioOnlyShowcase = (url: string) =>
    /\.(wav|mp3|ogg)$/i.test(String(url || '').split('?')[0]);

  const formatDuration = (sec?: number) => {
    if (!sec || !Number.isFinite(sec) || sec <= 0) return '';
    const total = Math.round(sec);
    const mins = Math.floor(total / 60);
    const secs = total % 60;
    return `${mins}:${String(secs).padStart(2, '0')}`;
  };

  const renderVideoThumb = (v: CommunityVideo, className = 'w-full h-full object-cover') => {
    const thumbBroken = Boolean(failedThumbIds[v.id]);
    const hasThumb = Boolean(v.thumbnail_url) && !thumbBroken;

    if (hasThumb) {
      return (
        <img
          src={v.thumbnail_url}
          alt={v.title}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailedThumbIds((prev) => ({ ...prev, [v.id]: true }))}
          className={className}
        />
      );
    }

    if (!isAudioOnlyShowcase(v.video_url) && v.video_url) {
      return (
        <video
          src={`${v.video_url}#t=0.5`}
          preload="metadata"
          muted
          playsInline
          className={className}
        />
      );
    }

    return (
      <div className="w-full h-full bg-gradient-to-br from-purple-900/90 via-slate-900 to-orange-900/80 flex items-center justify-center">
        <Volume2 className="w-10 h-10 text-orange-300/80" />
      </div>
    );
  };

  return (
    <div className="space-y-5 min-w-0">
      <div className="htv-card rounded-2xl p-4 sm:p-5 space-y-4">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            <h2 className="font-display text-lg font-bold">Community Videos</h2>
            <p className="text-xs text-[var(--htv-text-muted)]">
              Open community broadcasts and sessions—100% free and accessible to every member.
            </p>
          </div>
          <div className="relative w-full sm:w-72">
            <Search className="w-4 h-4 text-[var(--htv-text-dim)] absolute left-3.5 top-1/2 -translate-y-1/2" />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search videos..."
              className="w-full h-10 pl-10 pr-3.5 rounded-xl htv-elevated text-sm text-[var(--htv-text)] placeholder:text-[var(--htv-text-dim)] focus:outline-none focus:ring-2 focus:ring-purple-500/50"
            />
          </div>
        </div>
      </div>

      {reportMsg && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-xs text-amber-700 dark:text-amber-300">
          {reportMsg}
        </div>
      )}

      {/* Featured Video Container — All Like / Love / Comment controls strictly nested inside */}
      {selected && (
        <article
          ref={featuredContainerRef}
          className="htv-card rounded-2xl overflow-hidden w-full max-w-full min-w-0 box-border"
        >
          <div className="relative bg-black aspect-video w-full overflow-hidden">
            {isAudioOnlyShowcase(selected.video_url) ? (
              <div className="relative w-full h-full">
                {renderVideoThumb(selected, 'w-full h-full object-cover opacity-75')}
                <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/40 to-transparent flex flex-col justify-end p-4 sm:p-5 gap-3">
                  <div className="flex items-center gap-2 text-xs text-orange-300 font-medium">
                    <Volume2 className="w-4 h-4 shrink-0" />
                    <span className="truncate">Studio Broadcast Session</span>
                  </div>
                  <audio src={selected.video_url} controls className="w-full h-10" />
                </div>
              </div>
            ) : (
              <video
                key={selected.id}
                src={selected.video_url}
                poster={
                  selected.thumbnail_url && !failedThumbIds[selected.id]
                    ? selected.thumbnail_url
                    : undefined
                }
                controls
                playsInline
                preload="metadata"
                className="w-full h-full object-contain bg-black"
              />
            )}
          </div>

          <div className="p-4 sm:p-5 space-y-4 w-full min-w-0">
            <div className="space-y-1.5 min-w-0">
              <h3 className="font-display text-lg font-bold break-words">{selected.title}</h3>
              <div className="flex items-center gap-2 text-xs text-[var(--htv-text-dim)] flex-wrap">
                <button
                  type="button"
                  onClick={() => onOpenProfile(selected.uploader_id)}
                  className="inline-flex items-center gap-1.5 text-[var(--htv-text-muted)] hover:text-purple-500 dark:hover:text-purple-300 cursor-pointer min-w-0"
                >
                  <Avatar src={selected.uploader_avatar} name={selected.uploader_name} size="xs" />
                  <span className="truncate">{selected.uploader_name}</span>
                  <VerifiedBadge verified={selected.uploader_verified} />
                </button>
                <span aria-hidden="true">·</span>
                <span className="font-mono-tabular inline-flex items-center gap-1 shrink-0">
                  <Eye className="w-3.5 h-3.5" />
                  {selected.views_count} views
                </span>
              </div>
            </div>

            {selected.description && (
              <p className="text-sm text-[var(--htv-text-muted)] leading-relaxed break-words">
                {selected.description}
              </p>
            )}

            {/* Nested Interactive Action Bar (Like, Love, Comment, Report) strictly inside container */}
            <div className="pt-3 border-t border-[var(--htv-border-subtle)] flex items-center justify-between gap-2 flex-wrap w-full min-w-0">
              <div className="flex items-center gap-1.5 sm:gap-2 flex-wrap min-w-0">
                <button
                  type="button"
                  onClick={() => handleLike(selected.id)}
                  className={`px-3 py-1.5 rounded-xl text-xs font-semibold inline-flex items-center gap-1.5 shrink-0 cursor-pointer transition-colors ${
                    selected.is_liked
                      ? 'bg-purple-600/20 text-purple-600 dark:text-purple-300 ring-1 ring-purple-500/40'
                      : 'htv-elevated text-[var(--htv-text)] hover:bg-[var(--htv-hover)]'
                  }`}
                >
                  <ThumbsUp className={`w-3.5 h-3.5 ${selected.is_liked ? 'fill-current' : ''}`} />
                  <span>Like</span>
                  <span className="font-mono-tabular">{selected.likes_count}</span>
                </button>

                <button
                  type="button"
                  onClick={() => handleLove(selected.id)}
                  className={`px-3 py-1.5 rounded-xl text-xs font-semibold inline-flex items-center gap-1.5 shrink-0 cursor-pointer transition-colors ${
                    selected.is_loved
                      ? 'bg-rose-500/20 text-rose-500 dark:text-rose-300 ring-1 ring-rose-500/40'
                      : 'htv-elevated text-[var(--htv-text)] hover:bg-[var(--htv-hover)]'
                  }`}
                >
                  <Heart className={`w-3.5 h-3.5 ${selected.is_loved ? 'fill-current' : ''}`} />
                  <span>Love</span>
                  <span className="font-mono-tabular">{selected.loves_count ?? 0}</span>
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setCommentsOpen((prev) => !prev);
                    window.setTimeout(() => commentInputRef.current?.focus(), 60);
                  }}
                  className={`px-3 py-1.5 rounded-xl text-xs font-semibold inline-flex items-center gap-1.5 shrink-0 cursor-pointer transition-colors ${
                    commentsOpen
                      ? 'bg-orange-500/15 text-orange-600 dark:text-orange-300'
                      : 'htv-elevated text-[var(--htv-text)] hover:bg-[var(--htv-hover)]'
                  }`}
                >
                  <MessageCircle className="w-3.5 h-3.5" />
                  <span>Comment</span>
                  <span className="font-mono-tabular">{comments.length}</span>
                </button>
              </div>

              <button
                type="button"
                onClick={() => handleReport(selected.id)}
                className="px-3 py-1.5 rounded-xl htv-elevated text-xs text-[var(--htv-text-muted)] hover:text-amber-500 dark:hover:text-amber-300 inline-flex items-center gap-1.5 shrink-0 cursor-pointer"
              >
                <Flag className="w-3.5 h-3.5" />
                <span>Report</span>
              </button>
            </div>

            {/* Video Comments Panel nested inside featured video container */}
            {commentsOpen && (
              <div className="pt-3 border-t border-[var(--htv-border-subtle)] space-y-3 w-full min-w-0">
                <form onSubmit={handleComment} className="flex items-center gap-2 w-full min-w-0">
                  <input
                    ref={commentInputRef}
                    type="text"
                    value={commentText}
                    onChange={(e) => setCommentText(e.target.value)}
                    placeholder="Add a comment (no external links)..."
                    className="flex-1 min-w-0 h-10 px-3.5 rounded-xl htv-elevated text-xs text-[var(--htv-text)]"
                  />
                  <button
                    type="submit"
                    className="htv-gradient-btn h-10 px-4 rounded-xl text-xs font-semibold shrink-0 cursor-pointer"
                  >
                    Post
                  </button>
                </form>
                {commentError && <p className="text-xs text-rose-500">{commentError}</p>}

                <div className="space-y-2 max-h-52 overflow-y-auto">
                  {comments.map((c) => (
                    <div key={c.id} className="flex items-start gap-2.5 min-w-0">
                      <Avatar src={c.author_avatar} name={c.author_name} size="xs" />
                      <div className="htv-elevated rounded-xl px-3 py-2 flex-1 min-w-0">
                        <div className="flex items-center gap-1.5 text-xs font-semibold">
                          <span className="truncate">{c.author_name}</span>
                          <VerifiedBadge verified={c.author_verified} />
                        </div>
                        <p className="text-xs text-[var(--htv-text-muted)] mt-0.5 break-words">
                          {c.content}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </article>
      )}

      {/* Video Feed Grid — Every card properly contains its Like, Love, Comment interactive buttons */}
      {loading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {[1, 2].map((n) => (
            <div key={n} className="htv-card rounded-2xl h-64 animate-pulse" />
          ))}
        </div>
      ) : videos.length === 0 ? (
        <div className="htv-card rounded-2xl p-8 text-center text-sm text-[var(--htv-text-muted)]">
          No approved community videos match your search.
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {videos.map((v) => (
            <article
              key={v.id}
              className={`htv-card rounded-2xl overflow-hidden flex flex-col w-full min-w-0 box-border transition-transform hover:-translate-y-0.5 ${
                selected?.id === v.id ? 'ring-2 ring-purple-500/70' : ''
              }`}
            >
              <button
                type="button"
                onClick={() => selectVideo(v)}
                className="group w-full text-left cursor-pointer focus:outline-none"
              >
                <div className="relative aspect-video bg-black w-full overflow-hidden">
                  {renderVideoThumb(
                    v,
                    'w-full h-full object-cover transition-transform duration-300 group-hover:scale-[1.03]'
                  )}
                  <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/15 to-transparent flex items-center justify-center">
                    <div className="w-11 h-11 rounded-full htv-gradient-btn flex items-center justify-center transition-transform duration-150 group-hover:scale-105">
                      <Play className="w-5 h-5 fill-current ml-0.5" />
                    </div>
                  </div>
                  {v.duration_seconds > 0 && (
                    <span className="absolute bottom-2 right-2 px-1.5 py-0.5 rounded bg-black/75 text-white text-[11px] font-mono-tabular leading-none">
                      {formatDuration(v.duration_seconds)}
                    </span>
                  )}
                </div>
                <div className="px-4 pt-3.5 pb-2 space-y-1 min-w-0">
                  <h4 className="font-display font-semibold text-sm line-clamp-1 break-words">
                    {v.title}
                  </h4>
                  <div className="flex items-center gap-2 text-xs text-[var(--htv-text-dim)] min-w-0">
                    <span className="truncate">{v.uploader_name}</span>
                    <span aria-hidden="true">·</span>
                    <span className="font-mono-tabular shrink-0">{v.views_count} views</span>
                  </div>
                </div>
              </button>

              {/* Properly nested Like, Love, and Comment buttons inside each video card */}
              <div className="mt-auto px-3.5 py-2.5 border-t border-[var(--htv-border-subtle)] flex items-center justify-between gap-1.5 flex-wrap w-full min-w-0">
                <button
                  type="button"
                  onClick={() => handleLike(v.id)}
                  className={`px-2.5 py-1.5 rounded-lg text-xs font-semibold inline-flex items-center gap-1 shrink-0 cursor-pointer ${
                    v.is_liked
                      ? 'bg-purple-600/20 text-purple-600 dark:text-purple-300'
                      : 'htv-elevated text-[var(--htv-text-muted)] hover:text-[var(--htv-text)]'
                  }`}
                >
                  <ThumbsUp className={`w-3.5 h-3.5 ${v.is_liked ? 'fill-current' : ''}`} />
                  <span>Like</span>
                  <span className="font-mono-tabular">{v.likes_count}</span>
                </button>

                <button
                  type="button"
                  onClick={() => handleLove(v.id)}
                  className={`px-2.5 py-1.5 rounded-lg text-xs font-semibold inline-flex items-center gap-1 shrink-0 cursor-pointer ${
                    v.is_loved
                      ? 'bg-rose-500/20 text-rose-500 dark:text-rose-300'
                      : 'htv-elevated text-[var(--htv-text-muted)] hover:text-[var(--htv-text)]'
                  }`}
                >
                  <Heart className={`w-3.5 h-3.5 ${v.is_loved ? 'fill-current' : ''}`} />
                  <span>Love</span>
                  <span className="font-mono-tabular">{v.loves_count ?? 0}</span>
                </button>

                <button
                  type="button"
                  onClick={() => selectVideo(v, true)}
                  className="px-2.5 py-1.5 rounded-lg htv-elevated text-xs font-semibold text-[var(--htv-text-muted)] hover:text-[var(--htv-text)] inline-flex items-center gap-1 shrink-0 cursor-pointer"
                >
                  <MessageCircle className="w-3.5 h-3.5" />
                  <span>Comment</span>
                  <span className="font-mono-tabular">{v.comments_count}</span>
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
};
