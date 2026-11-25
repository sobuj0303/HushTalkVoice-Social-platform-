import React, { useEffect, useRef, useState } from 'react';
import {
  ShieldAlert,
  Video,
  Users,
  Flag,
  Check,
  X,
  BadgeCheck,
  Ban,
  Upload,
  Search,
  ExternalLink,
} from 'lucide-react';
import { Avatar, VerifiedBadge } from './Avatar';
import { apiFetch, uploadMediaFile } from '../lib/api';
import { MAX_WORDS, validateTextField } from '../shared/validation';
import type { AdminReportItem, CommunityVideo, UserSummary } from '../shared/types';

interface AdminDashboardProps {
  onOpenProfile?: (userId: number) => void;
}

export const AdminDashboard: React.FC<AdminDashboardProps> = ({ onOpenProfile }) => {
  const [tab, setTab] = useState<'videos' | 'users' | 'reports'>('videos');
  const [videos, setVideos] = useState<CommunityVideo[]>([]);
  const [users, setUsers] = useState<UserSummary[]>([]);
  const [reports, setReports] = useState<AdminReportItem[]>([]);
  const [reportSearch, setReportSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  // Admin direct video publish state
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [videoUrl, setVideoUrl] = useState('');
  const [thumbUrl, setThumbUrl] = useState('');
  const [autoThumbUrl, setAutoThumbUrl] = useState('');
  const [durationSeconds, setDurationSeconds] = useState(0);
  const [uploading, setUploading] = useState(false);

  const videoRef = useRef<HTMLInputElement>(null);
  const thumbRef = useRef<HTMLInputElement>(null);

  const loadOverview = async () => {
    setLoading(true);
    try {
      const data = await apiFetch<{
        videos: CommunityVideo[];
        users: UserSummary[];
        reports: AdminReportItem[];
      }>('/api/admin/overview');
      setVideos(data.videos);
      setUsers(data.users);
      setReports(data.reports);
    } catch (err: any) {
      setError(err?.message || 'Could not load admin overview.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadOverview();
  }, []);

  const handleVideoStatus = async (videoId: number, status: 'approved' | 'rejected') => {
    try {
      await apiFetch(`/api/admin/videos/${videoId}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      });
      setVideos((prev) => prev.map((v) => (v.id === videoId ? { ...v, status } : v)));
    } catch {
      // ignore
    }
  };

  const handleUploadMedia = async (
    e: React.ChangeEvent<HTMLInputElement>,
    kind: 'video' | 'image'
  ) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError('');
    setNotice('');
    setUploading(true);
    try {
      const res = await uploadMediaFile(file, kind, kind === 'video' ? { maxMb: 50 } : undefined);
      if (kind === 'video') {
        setVideoUrl(res.url);
        if (typeof res.duration_seconds === 'number') {
          setDurationSeconds(res.duration_seconds);
        }
        if (res.thumbnail_url) {
          setAutoThumbUrl(res.thumbnail_url);
          if (!thumbUrl || thumbUrl === autoThumbUrl) {
            setThumbUrl(res.thumbnail_url);
          }
        }
        const notes: string[] = [];
        if (res.compressed && res.original_size_bytes && res.size_bytes) {
          const origMb = (res.original_size_bytes / (1024 * 1024)).toFixed(1);
          const finalMb = (res.size_bytes / (1024 * 1024)).toFixed(1);
          notes.push(`Video optimized for fast sharing (${origMb} MB → ${finalMb} MB).`);
        }
        if (res.thumbnail_url) {
          notes.push('Thumbnail auto-captured from video.');
        }
        if (notes.length > 0) {
          setNotice(notes.join(' '));
        }
      } else {
        setThumbUrl(res.url);
      }
    } catch (err: any) {
      setError(err?.message || 'Upload failed.');
    } finally {
      setUploading(false);
    }
  };

  const handlePublishAdminVideo = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setNotice('');
    const tCheck = validateTextField(title, 'Video Title', { required: true, maxWords: 30 });
    if (!tCheck.valid) {
      setError(tCheck.error || 'Invalid title.');
      return;
    }
    const dCheck = validateTextField(description, 'Description', { maxWords: MAX_WORDS });
    if (!dCheck.valid) {
      setError(dCheck.error || 'Invalid description.');
      return;
    }
    if (!videoUrl) {
      setError('Please upload a valid MP4/WebM/MOV video file.');
      return;
    }
    try {
      await apiFetch('/api/admin/videos', {
        method: 'POST',
        body: JSON.stringify({
          title,
          description,
          video_url: videoUrl,
          thumbnail_url: thumbUrl,
          duration_seconds: durationSeconds,
        }),
      });
      setTitle('');
      setDescription('');
      setVideoUrl('');
      setThumbUrl('');
      setAutoThumbUrl('');
      setDurationSeconds(0);
      setNotice('Community video published to Videos Hub.');
      loadOverview();
    } catch (err: any) {
      setError(err?.message || 'Publish failed.');
    }
  };

  const handleToggleVerify = async (userId: number) => {
    try {
      const res = await apiFetch<{ is_verified: boolean }>(`/api/admin/users/${userId}/verify`, {
        method: 'PATCH',
      });
      setUsers((prev) =>
        prev.map((u) => (u.id === userId ? { ...u, is_verified: res.is_verified } : u))
      );
    } catch {
      // ignore
    }
  };

  const handleToggleBlock = async (userId: number) => {
    try {
      const res = await apiFetch<{ is_blocked: boolean }>(`/api/admin/users/${userId}/block`, {
        method: 'PATCH',
      });
      setUsers((prev) =>
        prev.map((u) => (u.id === userId ? { ...u, is_blocked: res.is_blocked } : u))
      );
    } catch (err: any) {
      setError(err?.message || 'Could not update block status.');
    }
  };

  const handleResolveReport = async (reportId: number, action: 'remove_target' | 'dismiss') => {
    try {
      await apiFetch(`/api/admin/reports/${reportId}`, {
        method: 'PATCH',
        body: JSON.stringify({ action }),
      });
      loadOverview();
    } catch {
      // ignore
    }
  };

  const pendingVideosCount = videos.filter((v) => v.status === 'pending').length;
  const pendingReportsCount = reports.filter((r) => r.status === 'pending').length;

  return (
    <div className="space-y-5">
      <div className="htv-card rounded-2xl p-5 flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <ShieldAlert className="w-6 h-6 text-orange-400" />
          <div>
            <h2 className="font-display text-lg font-bold">Admin Dashboard</h2>
            <p className="text-xs text-[var(--htv-text-muted)]">
              Moderate community videos, verify or suspend accounts, and resolve reports.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-1 p-1 rounded-xl htv-elevated">
          <button
            type="button"
            onClick={() => setTab('videos')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer ${
              tab === 'videos' ? 'htv-gradient-btn' : 'text-[var(--htv-text-muted)]'
            }`}
          >
            <Video className="w-3.5 h-3.5" />
            Videos ({pendingVideosCount} pending)
          </button>
          <button
            type="button"
            onClick={() => setTab('users')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer ${
              tab === 'users' ? 'htv-gradient-btn' : 'text-[var(--htv-text-muted)]'
            }`}
          >
            <Users className="w-3.5 h-3.5" />
            Users ({users.length})
          </button>
          <button
            type="button"
            onClick={() => setTab('reports')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer ${
              tab === 'reports' ? 'htv-gradient-btn' : 'text-[var(--htv-text-muted)]'
            }`}
          >
            <Flag className="w-3.5 h-3.5" />
            Reports ({pendingReportsCount})
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-2.5 text-xs text-rose-700 dark:text-rose-300">
          {error}
        </div>
      )}
      {notice && (
        <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-2.5 text-xs text-emerald-700 dark:text-emerald-300">
          {notice}
        </div>
      )}

      {loading ? (
        <div className="htv-card rounded-2xl p-8 animate-pulse h-64" />
      ) : tab === 'videos' ? (
        <div className="space-y-5">
          {/* Publish Community Video (Admin Only) */}
          <form onSubmit={handlePublishAdminVideo} className="htv-card rounded-2xl p-5 space-y-3.5">
            <h3 className="font-display font-semibold text-sm">
              Publish Community Video (Open to all members)
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <input
                type="text"
                required
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Video title (no external links)"
                className="h-10 px-3.5 rounded-xl htv-elevated text-sm text-[var(--htv-text)]"
              />
              <div className="flex items-center gap-2">
                <input
                  ref={videoRef}
                  type="file"
                  accept="video/mp4,video/webm,video/quicktime,video/x-m4v"
                  className="hidden"
                  onChange={(e) => handleUploadMedia(e, 'video')}
                />
                <input
                  ref={thumbRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/gif"
                  className="hidden"
                  onChange={(e) => handleUploadMedia(e, 'image')}
                />
                <button
                  type="button"
                  onClick={() => videoRef.current?.click()}
                  className="flex-1 h-10 px-3 rounded-xl htv-elevated hover:bg-[var(--htv-hover)] text-xs font-medium inline-flex items-center justify-center gap-1.5 cursor-pointer"
                >
                  <Upload className="w-3.5 h-3.5 text-purple-400" />
                  {videoUrl ? 'Video Ready' : 'Upload Video'}
                </button>
                <button
                  type="button"
                  onClick={() => thumbRef.current?.click()}
                  className="flex-1 h-10 px-3 rounded-xl htv-elevated hover:bg-[var(--htv-hover)] text-xs font-medium inline-flex items-center justify-center gap-1.5 cursor-pointer"
                >
                  <Upload className="w-3.5 h-3.5 text-orange-400" />
                  {thumbUrl ? 'Cover Ready' : 'Cover Photo'}
                </button>
              </div>
            </div>
            <textarea
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Video description (max 200 words, links blocked)"
              className="w-full p-3 rounded-xl htv-elevated text-sm text-[var(--htv-text)] resize-none"
            />
            {thumbUrl && (
              <div className="flex items-center gap-3 p-2.5 rounded-xl htv-elevated">
                <img
                  src={thumbUrl}
                  alt="Video thumbnail preview"
                  referrerPolicy="no-referrer"
                  className="w-28 aspect-video rounded-lg object-cover border border-[var(--htv-border-subtle)] shrink-0"
                />
                <div className="min-w-0 flex-1 space-y-0.5">
                  <p className="text-xs font-semibold text-[var(--htv-text)]">
                    {thumbUrl === autoThumbUrl ? 'Auto-captured Thumbnail' : 'Custom Cover Photo'}
                  </p>
                  <p className="text-[11px] text-[var(--htv-text-muted)]">
                    {thumbUrl === autoThumbUrl
                      ? 'Captured directly from the uploaded video frame. You can replace it with a custom cover if you want.'
                      : 'Using custom uploaded cover photo.'}
                  </p>
                </div>
                {autoThumbUrl && thumbUrl !== autoThumbUrl && (
                  <button
                    type="button"
                    onClick={() => setThumbUrl(autoThumbUrl)}
                    className="px-2.5 py-1.5 rounded-lg htv-card text-[11px] font-semibold cursor-pointer shrink-0"
                  >
                    Use Auto Frame
                  </button>
                )}
              </div>
            )}
            <button
              type="submit"
              disabled={uploading}
              className="htv-gradient-btn px-4 py-2 rounded-xl text-xs font-semibold cursor-pointer disabled:opacity-50"
            >
              {uploading ? 'Uploading...' : 'Publish to Videos Hub'}
            </button>
          </form>

          {/* Moderation Queue */}
          <div className="htv-card rounded-2xl divide-y divide-[var(--htv-border-subtle)]">
            {videos.map((v) => (
              <div key={v.id} className="p-4 flex items-center justify-between gap-4 flex-wrap">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-20 h-12 rounded-lg overflow-hidden bg-slate-900 border border-[var(--htv-border-subtle)] shrink-0">
                    {v.thumbnail_url ? (
                      <img
                        src={v.thumbnail_url}
                        alt={v.title}
                        referrerPolicy="no-referrer"
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <video
                        src={`${v.video_url}#t=0.5`}
                        preload="metadata"
                        muted
                        playsInline
                        className="w-full h-full object-cover"
                      />
                    )}
                  </div>
                  <div className="min-w-0">
                    <p className="font-display font-semibold text-sm truncate">{v.title}</p>
                    <p className="text-xs text-[var(--htv-text-dim)]">
                      By {v.uploader_name} · Status:{' '}
                      <span
                        className={
                          v.status === 'approved'
                            ? 'text-emerald-600 dark:text-emerald-400'
                            : v.status === 'rejected'
                            ? 'text-rose-600 dark:text-rose-400'
                            : 'text-amber-600 dark:text-amber-400'
                        }
                      >
                        {v.status}
                      </span>
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => handleVideoStatus(v.id, 'approved')}
                    className="px-3 py-1.5 rounded-lg bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30 text-xs font-semibold inline-flex items-center gap-1 cursor-pointer"
                  >
                    <Check className="w-3.5 h-3.5" />
                    Approve
                  </button>
                  <button
                    type="button"
                    onClick={() => handleVideoStatus(v.id, 'rejected')}
                    className="px-3 py-1.5 rounded-lg bg-rose-500/15 text-rose-700 dark:text-rose-300 border border-rose-500/30 text-xs font-semibold inline-flex items-center gap-1 cursor-pointer"
                  >
                    <X className="w-3.5 h-3.5" />
                    Reject
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : tab === 'users' ? (
        <div className="htv-card rounded-2xl divide-y divide-[var(--htv-border-subtle)]">
          {users.map((u) => (
            <div key={u.id} className="p-4 flex items-center justify-between gap-4 flex-wrap">
              <div className="flex items-center gap-3 min-w-0">
                <Avatar src={u.avatar_url} name={u.name} size="sm" />
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="font-semibold text-sm truncate">{u.name}</span>
                    <VerifiedBadge verified={u.is_verified} />
                  </div>
                  <p className="text-xs text-[var(--htv-text-dim)]">
                    @{u.username} · Role: {u.role} ·{' '}
                    <span className={u.is_blocked ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-600 dark:text-emerald-400'}>
                      {u.is_blocked ? 'Blocked' : 'Active'}
                    </span>
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => handleToggleVerify(u.id)}
                  className="px-3 py-1.5 rounded-lg htv-elevated hover:bg-[var(--htv-hover)] text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer"
                >
                  <BadgeCheck className="w-3.5 h-3.5 text-purple-600 dark:text-purple-400" />
                  {u.is_verified ? 'Unverify' : 'Verify'}
                </button>
                {u.role !== 'admin' && (
                  <button
                    type="button"
                    onClick={() => handleToggleBlock(u.id)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer ${
                      u.is_blocked
                        ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30'
                        : 'bg-rose-500/15 text-rose-700 dark:text-rose-300 border border-rose-500/30'
                    }`}
                  >
                    <Ban className="w-3.5 h-3.5" />
                    {u.is_blocked ? 'Unblock' : 'Block'}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-4">
          <div className="htv-card rounded-2xl p-4">
            <div className="relative">
              <Search className="w-4 h-4 text-[var(--htv-text-dim)] absolute left-3.5 top-1/2 -translate-y-1/2" />
              <input
                type="search"
                value={reportSearch}
                onChange={(e) => setReportSearch(e.target.value)}
                placeholder="Search reports by Case ID (e.g. HTV-CASE-100001) or @username..."
                className="w-full h-10 pl-10 pr-4 rounded-xl htv-elevated text-sm text-[var(--htv-text)] placeholder:text-[var(--htv-text-dim)] focus:outline-none focus:ring-2 focus:ring-purple-500/45"
              />
            </div>
          </div>

          <div className="htv-card rounded-2xl divide-y divide-[var(--htv-border-subtle)]">
            {reports.filter((r) => {
              const q = reportSearch.trim().toLowerCase();
              if (!q) return true;
              return (
                r.case_id.toLowerCase().includes(q) ||
                (r.target_username || '').toLowerCase().includes(q) ||
                r.reporter_username.toLowerCase().includes(q) ||
                r.target_summary.toLowerCase().includes(q)
              );
            }).length === 0 ? (
              <div className="p-8 text-center text-sm text-[var(--htv-text-muted)]">
                No matching reports found.
              </div>
            ) : (
              reports
                .filter((r) => {
                  const q = reportSearch.trim().toLowerCase();
                  if (!q) return true;
                  return (
                    r.case_id.toLowerCase().includes(q) ||
                    (r.target_username || '').toLowerCase().includes(q) ||
                    r.reporter_username.toLowerCase().includes(q) ||
                    r.target_summary.toLowerCase().includes(q)
                  );
                })
                .map((r) => (
                  <div key={r.id} className="p-4 flex items-center justify-between gap-4 flex-wrap">
                    <div className="space-y-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-mono-tabular text-xs font-bold text-amber-600 dark:text-amber-300">
                          {r.case_id}
                        </span>
                        <span aria-hidden="true" className="text-[var(--htv-text-dim)]">·</span>
                        <p className="text-sm font-semibold">{r.target_summary}</p>
                      </div>
                      <p className="text-xs text-[var(--htv-text-muted)]">
                        Reason: {r.reason} · Reported by @{r.reporter_username} · Status: {r.status}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 flex-wrap">
                      {r.target_type === 'user' && onOpenProfile && (
                        <button
                          type="button"
                          onClick={() => onOpenProfile(r.target_id)}
                          className="px-3 py-1.5 rounded-lg htv-elevated hover:bg-[var(--htv-hover)] text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer"
                        >
                          <ExternalLink className="w-3.5 h-3.5 text-purple-500" />
                          Inspect Profile
                        </button>
                      )}
                      {r.status === 'pending' && (
                        <>
                          <button
                            type="button"
                            onClick={() => handleResolveReport(r.id, 'remove_target')}
                            className="px-3 py-1.5 rounded-lg bg-rose-500/15 text-rose-600 dark:text-rose-300 border border-rose-500/30 text-xs font-semibold cursor-pointer"
                          >
                            Remove & Resolve
                          </button>
                          <button
                            type="button"
                            onClick={() => handleResolveReport(r.id, 'dismiss')}
                            className="px-3 py-1.5 rounded-lg htv-elevated text-xs font-semibold cursor-pointer"
                          >
                            Dismiss
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                ))
            )}
          </div>
        </div>
      )}
    </div>
  );
};
