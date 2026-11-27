import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Camera,
  Edit3,
  Lock,
  MessageSquare,
  Save,
  X,
  ExternalLink,
  Link2,
  Check,
  Flag,
  Copy,
} from 'lucide-react';
import { Avatar, VerifiedBadge } from './Avatar';
import { PostCard } from './PostCard';
import { apiFetch, uploadMediaFile } from '../lib/api';
import {
  sanitizeMediaUrl,
  sanitizePlainText,
  validateFacebookLink,
  validateTextField,
} from '../shared/validation';
import type { AuthUser, PostItem, UserSummary } from '../shared/types';

interface ProfileAndFollowsProps {
  currentUser: AuthUser;
  targetUserId: number;
  onUserUpdated: (user: AuthUser) => void;
  onStartChat: (userId: number) => void;
  onSelectUser: (userId: number) => void;
}

export const ProfileAndFollows: React.FC<ProfileAndFollowsProps> = ({
  currentUser,
  targetUserId,
  onUserUpdated,
  onStartChat,
  onSelectUser,
}) => {
  const [activeTab, setActiveTab] = useState<'posts' | 'followers' | 'following'>('posts');
  const [profile, setProfile] = useState<any>(null);
  const [posts, setPosts] = useState<PostItem[]>([]);
  const [followers, setFollowers] = useState<UserSummary[] | null>(null);
  const [following, setFollowing] = useState<UserSummary[] | null>(null);
  const [loading, setLoading] = useState(true);

  // Edit profile state
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [bio, setBio] = useState('');
  const [facebookLink, setFacebookLink] = useState('');
  const [avatarUrl, setAvatarUrl] = useState('');
  const [coverUrl, setCoverUrl] = useState('');
  const [saveError, setSaveError] = useState('');
  const [saving, setSaving] = useState(false);

  // Copy profile link & Profile report with Case ID
  const [linkCopied, setLinkCopied] = useState(false);
  const [showReportBox, setShowReportBox] = useState(false);
  const [reportReason, setReportReason] = useState('');
  const [reportedCaseId, setReportedCaseId] = useState('');
  const [caseCopied, setCaseCopied] = useState(false);
  const [toast, setToast] = useState<{ text: string; variant: 'success' | 'error' } | null>(null);

  const avatarInputRef = useRef<HTMLInputElement>(null);
  const coverInputRef = useRef<HTMLInputElement>(null);
  const timersRef = useRef<number[]>([]);

  const scheduleTimer = useCallback((fn: () => void, ms: number) => {
    const id = window.setTimeout(fn, ms);
    timersRef.current.push(id);
  }, []);

  useEffect(() => {
    return () => {
      for (const id of timersRef.current) {
        window.clearTimeout(id);
      }
      timersRef.current = [];
    };
  }, []);

  const showToast = useCallback(
    (text: string, variant: 'success' | 'error' = 'success') => {
      setToast({ text, variant });
      scheduleTimer(() => setToast(null), 3500);
    },
    [scheduleTimer]
  );

  const isOwn = targetUserId === currentUser.id;

  const loadProfile = async () => {
    setLoading(true);
    try {
      const data = await apiFetch<{
        profile: any;
        posts: PostItem[];
        followers: UserSummary[] | null;
        following: UserSummary[] | null;
      }>(`/api/users/${targetUserId}/profile`);
      setProfile(data.profile);
      setPosts(data.posts);
      setFollowers(data.followers);
      setFollowing(data.following);

      setName(data.profile.name);
      setUsername(data.profile.username);
      setBio(data.profile.bio || '');
      setFacebookLink(data.profile.facebook_link || '');
      setAvatarUrl(data.profile.avatar_url || '');
      setCoverUrl(data.profile.cover_url || '');
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadProfile();
    setEditing(false);
    setActiveTab('posts');
    setShowReportBox(false);
    setReportedCaseId('');
    setReportReason('');
    setLinkCopied(false);
  }, [targetUserId]);

  const handleCopyProfileLink = async () => {
    if (!profile) return;
    const shareUrl = `${window.location.origin}/?profile=${encodeURIComponent(profile.username)}`;
    try {
      await navigator.clipboard.writeText(shareUrl);
    } catch {
      // Ignore clipboard permission limitations
    }
    setLinkCopied(true);
    scheduleTimer(() => setLinkCopied(false), 2400);
  };

  const handleReportProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanReason = sanitizePlainText(reportReason, 500);
    if (!profile || cleanReason.length < 3) {
      showToast('Please provide at least 3 characters for your report reason.', 'error');
      return;
    }
    try {
      const res = await apiFetch<{ case_id: string }>('/api/reports', {
        method: 'POST',
        body: JSON.stringify({
          target_type: 'user',
          target_id: profile.id,
          reason: cleanReason,
        }),
      });
      setReportedCaseId(res.case_id);
      setReportReason('');
      setShowReportBox(false);
    } catch (err: any) {
      showToast(err?.message || 'Could not submit profile report.', 'error');
    }
  };

  const handlePhotoUpload = async (
    e: React.ChangeEvent<HTMLInputElement>,
    kind: 'avatar' | 'cover'
  ) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setSaveError('');
    try {
      const res = await uploadMediaFile(file, 'image');
      if (kind === 'avatar') setAvatarUrl(res.url);
      else setCoverUrl(res.url);
    } catch (err: any) {
      setSaveError(err?.message || 'Only gallery photos are allowed.');
    }
  };

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaveError('');

    const bioCheck = validateTextField(bio, 'Bio', { maxWords: 120 });
    if (!bioCheck.valid) {
      setSaveError(bioCheck.error || 'Invalid bio.');
      return;
    }
    const fbCheck = validateFacebookLink(facebookLink);
    if (!fbCheck.valid) {
      setSaveError(fbCheck.error || 'Invalid Facebook link.');
      return;
    }

    setSaving(true);
    try {
      const res = await apiFetch<{ user: AuthUser }>('/api/profile', {
        method: 'PUT',
        body: JSON.stringify({
          name,
          username,
          bio,
          facebook_link: fbCheck.normalized || '',
          avatar_url: avatarUrl,
          cover_url: coverUrl,
        }),
      });
      onUserUpdated(res.user);
      setEditing(false);
      await loadProfile();
    } catch (err: any) {
      setSaveError(err?.message || 'Could not save profile.');
    } finally {
      setSaving(false);
    }
  };

  const handleFollowToggle = async () => {
    try {
      await apiFetch(`/api/users/${targetUserId}/follow`, { method: 'POST' });
      loadProfile();
    } catch {
      // ignore
    }
  };

  if (loading || !profile) {
    return <div className="htv-card rounded-2xl p-8 animate-pulse h-80" />;
  }

  const safeCoverSrc = sanitizeMediaUrl(editing ? coverUrl : profile.cover_url);

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

      {/* Cover + Profile Header Card */}
      <div className="htv-card rounded-2xl overflow-hidden">
        <div className="relative h-44 sm:h-56 bg-black/50">
          {safeCoverSrc && (
            <img
              src={safeCoverSrc}
              alt="Profile cover"
              referrerPolicy="no-referrer"
              className="w-full h-full object-cover"
            />
          )}
          <div className="absolute inset-0 bg-gradient-to-t from-black/75 via-transparent to-transparent" />
          {isOwn && editing && (
            <>
              <input
                ref={coverInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp,image/gif"
                className="hidden"
                onChange={(e) => handlePhotoUpload(e, 'cover')}
              />
              <button
                type="button"
                onClick={() => coverInputRef.current?.click()}
                className="absolute bottom-3 right-3 px-3 py-1.5 rounded-lg bg-black/75 text-white text-xs font-medium inline-flex items-center gap-1.5 cursor-pointer"
              >
                <Camera className="w-3.5 h-3.5" />
                Change Cover
              </button>
            </>
          )}
        </div>

        <div className="px-5 pb-5">
          <div className="flex items-end justify-between gap-4 -mt-10 relative z-10 flex-wrap">
            <div className="relative">
              <Avatar
                src={editing ? avatarUrl : profile.avatar_url}
                name={profile.name}
                size="xl"
                isOnline={profile.is_online}
                showOnlineRing
              />
              {isOwn && editing && (
                <>
                  <input
                    ref={avatarInputRef}
                    type="file"
                    accept="image/jpeg,image/png,image/webp,image/gif"
                    className="hidden"
                    onChange={(e) => handlePhotoUpload(e, 'avatar')}
                  />
                  <button
                    type="button"
                    onClick={() => avatarInputRef.current?.click()}
                    aria-label="Change avatar"
                    className="absolute bottom-0 right-0 p-2 rounded-full htv-gradient-btn cursor-pointer"
                  >
                    <Camera className="w-3.5 h-3.5" />
                  </button>
                </>
              )}
            </div>

            <div className="flex items-center gap-2 pt-12 sm:pt-0 flex-wrap">
              <button
                type="button"
                onClick={handleCopyProfileLink}
                className="px-3.5 py-2 rounded-xl htv-elevated hover:bg-[var(--htv-hover)] text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer"
              >
                {linkCopied ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-emerald-500" />
                    Link Copied
                  </>
                ) : (
                  <>
                    <Link2 className="w-3.5 h-3.5 text-purple-600 dark:text-purple-400" />
                    Copy Profile Link
                  </>
                )}
              </button>

              {isOwn ? (
                <button
                  type="button"
                  onClick={() => setEditing((e) => !e)}
                  className="px-4 py-2 rounded-xl htv-elevated hover:bg-[var(--htv-hover)] text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer"
                >
                  {editing ? <X className="w-3.5 h-3.5" /> : <Edit3 className="w-3.5 h-3.5" />}
                  {editing ? 'Cancel Edit' : 'Edit Profile'}
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={handleFollowToggle}
                    className={`px-4 py-2 rounded-xl text-xs font-semibold cursor-pointer ${
                      profile.is_following
                        ? 'htv-elevated text-purple-700 dark:text-purple-300'
                        : 'htv-gradient-btn'
                    }`}
                  >
                    {profile.is_following ? 'Following' : 'Follow'}
                  </button>
                  <button
                    type="button"
                    onClick={() => onStartChat(profile.id)}
                    className="px-4 py-2 rounded-xl htv-elevated hover:bg-[var(--htv-hover)] text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer"
                  >
                    <MessageSquare className="w-3.5 h-3.5 text-orange-500" />
                    Chat
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowReportBox((s) => !s)}
                    className="px-3 py-2 rounded-xl htv-elevated hover:bg-[var(--htv-hover)] text-xs font-semibold text-amber-600 dark:text-amber-300 inline-flex items-center gap-1.5 cursor-pointer"
                  >
                    <Flag className="w-3.5 h-3.5" />
                    Report Profile
                  </button>
                </>
              )}
            </div>
          </div>

          <div className="mt-4 space-y-2">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="font-display text-xl font-bold">{profile.name}</h2>
              <VerifiedBadge verified={profile.is_verified} />
              <span className="text-xs text-[var(--htv-text-dim)]">@{profile.username}</span>
            </div>

            <p className="text-sm text-[var(--htv-text-muted)] leading-relaxed max-w-2xl">
              {profile.bio || 'No bio added yet.'}
            </p>

            <div className="flex items-center gap-4 text-xs text-[var(--htv-text-dim)] flex-wrap pt-1">
              <span className="font-mono-tabular">
                <strong className="text-[var(--htv-text)]">{profile.followers_count}</strong> Followers
              </span>
              <span aria-hidden="true">·</span>
              <span className="font-mono-tabular">
                <strong className="text-[var(--htv-text)]">{profile.following_count}</strong> Following
              </span>
              {profile.facebook_link && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="inline-flex items-center gap-1 text-purple-700 dark:text-purple-300 min-w-0 max-w-full break-all">
                    <ExternalLink className="w-3.5 h-3.5 shrink-0" />
                    Facebook: {profile.facebook_link}
                  </span>
                </>
              )}
            </div>
          </div>

          {/* Inline Profile Report Box */}
          {!isOwn && showReportBox && (
            <form
              onSubmit={handleReportProfile}
              className="mt-4 p-3.5 rounded-xl htv-elevated flex flex-col sm:flex-row sm:items-center gap-2 min-w-0"
            >
              <input
                type="text"
                required
                value={reportReason}
                onChange={(e) => setReportReason(e.target.value)}
                placeholder="Reason for reporting this profile..."
                className="w-full sm:flex-1 min-w-0 h-9 px-3 rounded-lg bg-[var(--htv-input)] border border-[var(--htv-border-subtle)] text-xs text-[var(--htv-text)]"
              />
              <button
                type="submit"
                className="w-full sm:w-auto px-3.5 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-xs font-semibold shrink-0 whitespace-nowrap cursor-pointer"
              >
                Submit Report
              </button>
            </form>
          )}

          {/* Report Case ID Confirmation */}
          {reportedCaseId && (
            <div className="mt-4 p-3.5 rounded-xl border border-amber-500/35 bg-amber-500/10 flex items-center justify-between gap-3 flex-wrap">
              <div className="text-xs space-y-0.5">
                <p className="font-semibold text-amber-700 dark:text-amber-300">
                  Profile report filed. Save your Case ID for quick admin lookup:
                </p>
                <p className="font-mono-tabular font-bold text-sm text-[var(--htv-text)]">
                  {reportedCaseId}
                </p>
              </div>
              <button
                type="button"
                onClick={async () => {
                  await navigator.clipboard.writeText(reportedCaseId).catch(() => {});
                  setCaseCopied(true);
                  setTimeout(() => setCaseCopied(false), 2000);
                }}
                className="px-3 py-1.5 rounded-lg htv-elevated text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer"
              >
                {caseCopied ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
                {caseCopied ? 'Copied' : 'Copy Case ID'}
              </button>
            </div>
          )}

          {/* Inline Edit Profile Form */}
          {isOwn && editing && (
            <form
              onSubmit={handleSaveProfile}
              className="mt-5 pt-5 border-t border-[var(--htv-border-subtle)] space-y-3.5"
            >
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-xs text-[var(--htv-text-muted)]">Display Name</label>
                  <input
                    type="text"
                    required
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="w-full h-10 px-3 rounded-xl htv-elevated text-sm text-[var(--htv-text)]"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-[var(--htv-text-muted)]">Username</label>
                  <input
                    type="text"
                    required
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    className="w-full h-10 px-3 rounded-xl htv-elevated text-sm text-[var(--htv-text)]"
                  />
                </div>
              </div>

              <div className="space-y-1">
                <label className="text-xs text-[var(--htv-text-muted)]">
                  Bio (External links blocked)
                </label>
                <textarea
                  rows={2}
                  value={bio}
                  onChange={(e) => setBio(e.target.value)}
                  className="w-full p-3 rounded-xl htv-elevated text-sm text-[var(--htv-text)] resize-none"
                />
              </div>

              <div className="space-y-1">
                <label className="text-xs text-[var(--htv-text-muted)]">
                  Optional Facebook Profile Link (https://facebook.com/...)
                </label>
                <input
                  type="text"
                  value={facebookLink}
                  onChange={(e) => setFacebookLink(e.target.value)}
                  placeholder="https://facebook.com/your.profile"
                  className="w-full h-10 px-3 rounded-xl htv-elevated text-sm text-[var(--htv-text)]"
                />
              </div>

              {saveError && <p className="text-xs text-rose-600 dark:text-rose-400">{saveError}</p>}

              <button
                type="submit"
                disabled={saving}
                className="htv-gradient-btn px-5 py-2.5 rounded-xl text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer"
              >
                <Save className="w-3.5 h-3.5" />
                {saving ? 'Saving...' : 'Save Changes'}
              </button>
            </form>
          )}
        </div>
      </div>

      {/* 3 Profile Tabs: Posts, Followers (count), Following (count) */}
      <div className="flex items-center gap-1.5 p-1.5 htv-card rounded-xl overflow-x-auto">
        <button
          type="button"
          onClick={() => setActiveTab('posts')}
          className={`flex-1 py-2 px-3 rounded-lg text-xs font-semibold whitespace-nowrap shrink-0 cursor-pointer ${
            activeTab === 'posts'
              ? 'htv-gradient-btn'
              : 'text-[var(--htv-text-muted)] hover:text-[var(--htv-text)]'
          }`}
        >
          Posts ({posts.length})
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('followers')}
          className={`flex-1 py-2 px-3 rounded-lg text-xs font-semibold whitespace-nowrap shrink-0 cursor-pointer ${
            activeTab === 'followers'
              ? 'htv-gradient-btn'
              : 'text-[var(--htv-text-muted)] hover:text-[var(--htv-text)]'
          }`}
        >
          Followers ({profile.followers_count})
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('following')}
          className={`flex-1 py-2 px-3 rounded-lg text-xs font-semibold whitespace-nowrap shrink-0 cursor-pointer ${
            activeTab === 'following'
              ? 'htv-gradient-btn'
              : 'text-[var(--htv-text-muted)] hover:text-[var(--htv-text)]'
          }`}
        >
          Following ({profile.following_count})
        </button>
      </div>

      {/* Tab Content */}
      {activeTab === 'posts' && (
        <div className="space-y-4">
          {!profile.can_view_profile ? (
            <div className="htv-card rounded-2xl p-8 text-center space-y-2">
              <Lock className="w-7 h-7 text-[var(--htv-text-dim)] mx-auto" />
              <p className="text-sm font-semibold">Private Profile</p>
              <p className="text-xs text-[var(--htv-text-muted)]">
                Connect with {profile.name} to view their posts.
              </p>
            </div>
          ) : posts.length === 0 ? (
            <div className="htv-card rounded-2xl p-8 text-center text-sm text-[var(--htv-text-muted)]">
              No posts published yet.
            </div>
          ) : (
            posts.map((p) => (
              <PostCard
                key={p.id}
                post={p}
                currentUser={currentUser}
                onOpenProfile={onSelectUser}
                onPostUpdated={(updated) =>
                  setPosts((prev) => prev.map((item) => (item.id === updated.id ? updated : item)))
                }
                onPostViewSynced={(postId, viewsCount) =>
                  setPosts((prev) =>
                    prev.map((item) =>
                      item.id === postId
                        ? { ...item, views_count: Math.max(item.views_count, viewsCount), has_viewed: true }
                        : item
                    )
                  )
                }
                onPostDeleted={(deletedId) =>
                  setPosts((prev) => prev.filter((item) => item.id !== deletedId))
                }
                onNotify={showToast}
              />
            ))
          )}
        </div>
      )}

      {activeTab === 'followers' && (
        <div className="htv-card rounded-2xl p-4">
          {followers === null ? (
            <div className="py-6 text-center space-y-2">
              <Lock className="w-6 h-6 text-[var(--htv-text-dim)] mx-auto" />
              <p className="text-xs text-[var(--htv-text-muted)]">
                This member’s followers list is set to private.
              </p>
            </div>
          ) : followers.length === 0 ? (
            <div className="py-6 text-center text-xs text-[var(--htv-text-muted)]">
              No followers yet.
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {followers.map((u) => (
                <button
                  key={u.id}
                  type="button"
                  onClick={() => onSelectUser(u.id)}
                  className="htv-elevated hover:bg-[var(--htv-hover)] rounded-xl p-3 flex items-center gap-3 text-left cursor-pointer"
                >
                  <Avatar src={u.avatar_url} name={u.name} size="sm" isOnline={u.is_online} showOnlineRing />
                  <div className="min-w-0">
                    <div className="flex items-center gap-1">
                      <span className="text-xs font-semibold truncate">{u.name}</span>
                      <VerifiedBadge verified={u.is_verified} />
                    </div>
                    <p className="text-[11px] text-[var(--htv-text-dim)] truncate">@{u.username}</p>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {activeTab === 'following' && (
        <div className="htv-card rounded-2xl p-4">
          {following === null ? (
            <div className="py-6 text-center space-y-2">
              <Lock className="w-6 h-6 text-[var(--htv-text-dim)] mx-auto" />
              <p className="text-xs text-[var(--htv-text-muted)]">
                This member’s following list is set to private.
              </p>
            </div>
          ) : following.length === 0 ? (
            <div className="py-6 text-center text-xs text-[var(--htv-text-muted)]">
              Not following anyone yet.
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {following.map((u) => (
                <button
                  key={u.id}
                  type="button"
                  onClick={() => onSelectUser(u.id)}
                  className="htv-elevated hover:bg-[var(--htv-hover)] rounded-xl p-3 flex items-center gap-3 text-left cursor-pointer"
                >
                  <Avatar src={u.avatar_url} name={u.name} size="sm" isOnline={u.is_online} showOnlineRing />
                  <div className="min-w-0">
                    <div className="flex items-center gap-1">
                      <span className="text-xs font-semibold truncate">{u.name}</span>
                      <VerifiedBadge verified={u.is_verified} />
                    </div>
                    <p className="text-[11px] text-[var(--htv-text-dim)] truncate">@{u.username}</p>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
