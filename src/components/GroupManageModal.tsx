import React, { useEffect, useState } from 'react';
import {
  X,
  Users,
  UserPlus,
  UserMinus,
  ShieldCheck,
  Link2,
  Copy,
  Check,
  RefreshCw,
  VolumeX,
  Volume2,
  Flag,
  LogOut,
} from 'lucide-react';
import { Avatar, VerifiedBadge } from './Avatar';
import { apiFetch } from '../lib/api';
import { MAX_GROUP_MEMBERS } from '../shared/validation';
import type { AuthUser, ConversationItem, GroupCandidateItem } from '../shared/types';

interface GroupManageModalProps {
  open: boolean;
  initialTab?: 'members' | 'add' | 'requests' | 'settings';
  group: ConversationItem;
  currentUser: AuthUser;
  onClose: () => void;
  onGroupUpdated: () => void;
  onLeftGroup: () => void;
}

export const GroupManageModal: React.FC<GroupManageModalProps> = ({
  open,
  initialTab = 'members',
  group,
  currentUser,
  onClose,
  onGroupUpdated,
  onLeftGroup,
}) => {
  const [tab, setTab] = useState<'members' | 'add' | 'requests' | 'settings'>(initialTab);
  const [candidates, setCandidates] = useState<GroupCandidateItem[]>([]);
  const [loadingCandidates, setLoadingCandidates] = useState(false);
  const [search, setSearch] = useState('');
  const [memberSearch, setMemberSearch] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [copiedLink, setCopiedLink] = useState(false);

  // Admin settings staging
  const [joinMode, setJoinMode] = useState<'direct' | 'approval'>(group.join_mode || 'direct');
  const [savingSettings, setSavingSettings] = useState(false);

  // Mute duration selector per member
  const [muteMenuUserId, setMuteMenuUserId] = useState<number | null>(null);

  // Report group state
  const [showReportBox, setShowReportBox] = useState(false);
  const [reportReason, setReportReason] = useState('');
  const [reportCaseId, setReportCaseId] = useState('');
  const [copiedCase, setCopiedCase] = useState(false);

  const isGroupAdmin =
    group.created_by === currentUser.id ||
    group.members?.some((m) => m.user_id === currentUser.id && m.role === 'admin');

  useEffect(() => {
    if (open) {
      setTab(initialTab);
      setJoinMode(group.join_mode || 'direct');
      setNotice('');
      setError('');
      setReportCaseId('');
      setShowReportBox(false);
    }
  }, [open, initialTab, group.id, group.join_mode]);

  const loadCandidates = async () => {
    setLoadingCandidates(true);
    try {
      const data = await apiFetch<{ candidates: GroupCandidateItem[] }>(
        `/api/conversations/${group.id}/candidates`
      );
      setCandidates(data.candidates);
    } catch {
      // ignore
    } finally {
      setLoadingCandidates(false);
    }
  };

  useEffect(() => {
    if (open && tab === 'add') {
      loadCandidates();
    }
  }, [open, tab, group.id, group.member_count]);

  if (!open) return null;

  const groupInviteUrl = `${window.location.origin}/?group=${encodeURIComponent(
    group.invite_code || ''
  )}`;

  const handleCopyGroupLink = async () => {
    try {
      await navigator.clipboard.writeText(groupInviteUrl);
    } catch {
      // fallback
    }
    setCopiedLink(true);
    setTimeout(() => setCopiedLink(false), 2200);
  };

  const handleAddMember = async (userId: number, mode?: 'direct' | 'approval') => {
    setError('');
    setNotice('');
    try {
      const res = await apiFetch<{ pending?: boolean; message?: string }>(
        `/api/conversations/${group.id}/members`,
        {
          method: 'POST',
          body: JSON.stringify({ userId, mode }),
        }
      );
      setNotice(res.message || (res.pending ? 'Sent to admin for approval.' : 'Member added to group.'));
      await loadCandidates();
      onGroupUpdated();
    } catch (err: any) {
      setError(err?.message || 'Could not add member.');
    }
  };

  const handleRemoveMember = async (userId: number) => {
    setError('');
    setNotice('');
    try {
      const res = await apiFetch<{ left: boolean }>(
        `/api/conversations/${group.id}/members/${userId}`,
        { method: 'DELETE' }
      );
      if (res.left) {
        onLeftGroup();
        onClose();
      } else {
        setNotice('Member removed from group.');
        onGroupUpdated();
      }
    } catch (err: any) {
      setError(err?.message || 'Could not remove member.');
    }
  };

  const handleMuteMember = async (userId: number, muted: boolean, durationMinutes = 0) => {
    setError('');
    setNotice('');
    setMuteMenuUserId(null);
    try {
      await apiFetch(`/api/conversations/${group.id}/members/${userId}/mute`, {
        method: 'POST',
        body: JSON.stringify({ muted, durationMinutes }),
      });
      setNotice(muted ? 'Member muted in this group.' : 'Member unmuted.');
      onGroupUpdated();
    } catch (err: any) {
      setError(err?.message || 'Could not update mute state.');
    }
  };

  const handleRespondJoinRequest = async (requestId: number, action: 'approve' | 'reject') => {
    setError('');
    setNotice('');
    try {
      await apiFetch(`/api/conversations/${group.id}/join-requests/${requestId}/respond`, {
        method: 'POST',
        body: JSON.stringify({ action }),
      });
      setNotice(action === 'approve' ? 'Member approved and added.' : 'Join request rejected.');
      onGroupUpdated();
    } catch (err: any) {
      setError(err?.message || 'Action failed.');
    }
  };

  const handleSaveSettings = async (regenerateInvite = false) => {
    setSavingSettings(true);
    setError('');
    setNotice('');
    try {
      await apiFetch(`/api/conversations/${group.id}/settings`, {
        method: 'PATCH',
        body: JSON.stringify({
          join_mode: joinMode,
          regenerate_invite: regenerateInvite,
        }),
      });
      setNotice(regenerateInvite ? 'New group invite link generated.' : 'Group settings saved.');
      onGroupUpdated();
    } catch (err: any) {
      setError(err?.message || 'Could not save settings.');
    } finally {
      setSavingSettings(false);
    }
  };

  const handleReportGroup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reportReason.trim()) return;
    setError('');
    try {
      const res = await apiFetch<{ case_id: string }>('/api/reports', {
        method: 'POST',
        body: JSON.stringify({
          target_type: 'group',
          target_id: group.id,
          reason: reportReason.trim(),
        }),
      });
      setReportCaseId(res.case_id);
      setReportReason('');
      setShowReportBox(false);
    } catch (err: any) {
      setError(err?.message || 'Could not submit group report.');
    }
  };

  const pendingRequests = group.pending_join_requests || [];
  const filteredMembers = (group.members || []).filter(
    (m) =>
      !memberSearch.trim() ||
      m.name.toLowerCase().includes(memberSearch.toLowerCase()) ||
      m.username.toLowerCase().includes(memberSearch.toLowerCase())
  );
  const filteredCandidates = candidates.filter(
    (u) =>
      !search.trim() ||
      u.name.toLowerCase().includes(search.toLowerCase()) ||
      u.username.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-3 sm:p-4">
      <div className="htv-card rounded-2xl w-full max-w-xl max-h-[88vh] flex flex-col overflow-hidden shadow-2xl">
        {/* Modal Header */}
        <header className="px-5 py-4 border-b border-[var(--htv-border-subtle)] flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h3 className="font-display font-bold text-base truncate">{group.name}</h3>
            <p className="text-xs text-[var(--htv-text-muted)] font-mono-tabular">
              {group.member_count} / {MAX_GROUP_MEMBERS} members ·{' '}
              {group.join_mode === 'approval' ? 'Admin Approval Mode' : 'Direct Add Mode'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close group popup"
            className="p-2 rounded-xl htv-elevated text-[var(--htv-text-muted)] hover:text-[var(--htv-text)] cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </header>

        {/* Modal Tabs */}
        <div className="px-5 pt-3 pb-2 border-b border-[var(--htv-border-subtle)] flex items-center gap-1.5 overflow-x-auto">
          <button
            type="button"
            onClick={() => setTab('members')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer ${
              tab === 'members' ? 'htv-gradient-btn' : 'htv-elevated text-[var(--htv-text-muted)]'
            }`}
          >
            <Users className="w-3.5 h-3.5" />
            Members ({group.member_count})
          </button>
          <button
            type="button"
            onClick={() => setTab('add')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer ${
              tab === 'add' ? 'htv-gradient-btn' : 'htv-elevated text-[var(--htv-text-muted)]'
            }`}
          >
            <UserPlus className="w-3.5 h-3.5" />
            Add People
          </button>
          {isGroupAdmin && (
            <button
              type="button"
              onClick={() => setTab('requests')}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer ${
                tab === 'requests' ? 'htv-gradient-btn' : 'htv-elevated text-[var(--htv-text-muted)]'
              }`}
            >
              <ShieldCheck className="w-3.5 h-3.5" />
              Requests ({pendingRequests.length})
            </button>
          )}
          <button
            type="button"
            onClick={() => setTab('settings')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer ${
              tab === 'settings' ? 'htv-gradient-btn' : 'htv-elevated text-[var(--htv-text-muted)]'
            }`}
          >
            <Link2 className="w-3.5 h-3.5" />
            Link & Safety
          </button>
        </div>

        {/* Feedback Banners */}
        {(error || notice || reportCaseId) && (
          <div className="px-5 pt-3 space-y-2">
            {error && (
              <div className="rounded-xl border border-rose-500/35 bg-rose-500/10 px-3.5 py-2 text-xs text-rose-600 dark:text-rose-300">
                {error}
              </div>
            )}
            {notice && (
              <div className="rounded-xl border border-emerald-500/35 bg-emerald-500/10 px-3.5 py-2 text-xs text-emerald-700 dark:text-emerald-300">
                {notice}
              </div>
            )}
            {reportCaseId && (
              <div className="rounded-xl border border-amber-500/35 bg-amber-500/10 px-3.5 py-2.5 flex items-center justify-between gap-2 flex-wrap">
                <span className="text-xs text-amber-800 dark:text-amber-200">
                  Group reported. Case ID: <strong className="font-mono-tabular">{reportCaseId}</strong>
                </span>
                <button
                  type="button"
                  onClick={async () => {
                    await navigator.clipboard.writeText(reportCaseId).catch(() => {});
                    setCopiedCase(true);
                    setTimeout(() => setCopiedCase(false), 2000);
                  }}
                  className="px-2.5 py-1 rounded-lg bg-amber-500/20 text-xs font-semibold inline-flex items-center gap-1 cursor-pointer"
                >
                  {copiedCase ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                  {copiedCase ? 'Copied' : 'Copy ID'}
                </button>
              </div>
            )}
          </div>
        )}

        {/* Scrollable Tab Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-3">
          {tab === 'members' && (
            <>
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <input
                  type="search"
                  value={memberSearch}
                  onChange={(e) => setMemberSearch(e.target.value)}
                  placeholder="Search group members..."
                  className="flex-1 min-w-[180px] h-9 px-3 rounded-xl htv-elevated text-xs text-[var(--htv-text)]"
                />
                <button
                  type="button"
                  onClick={() => handleRemoveMember(currentUser.id)}
                  className="px-3 py-2 rounded-xl bg-rose-500/15 text-rose-600 dark:text-rose-300 text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  Leave Group
                </button>
              </div>

              <div className="space-y-2">
                {filteredMembers.map((m) => (
                  <div
                    key={m.user_id}
                    className="htv-elevated rounded-xl p-3 flex items-center justify-between gap-3 flex-wrap"
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <Avatar
                        src={m.avatar_url}
                        name={m.name}
                        size="sm"
                        isOnline={m.is_online}
                        showOnlineRing
                      />
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="text-xs font-semibold truncate">{m.name}</span>
                          <VerifiedBadge verified={m.is_verified} />
                          {m.role === 'admin' && (
                            <span className="text-[11px] font-semibold text-purple-600 dark:text-purple-300">
                              · Admin
                            </span>
                          )}
                          {m.is_chat_muted && (
                            <span className="text-[11px] font-semibold text-rose-500 dark:text-rose-300">
                              · Muted
                            </span>
                          )}
                        </div>
                        <p className="text-[11px] text-[var(--htv-text-dim)] truncate">@{m.username}</p>
                      </div>
                    </div>

                    {isGroupAdmin && m.user_id !== currentUser.id && (
                      <div className="flex items-center gap-1.5 relative">
                        {m.is_chat_muted ? (
                          <button
                            type="button"
                            onClick={() => handleMuteMember(m.user_id, false)}
                            className="px-2.5 py-1.5 rounded-lg bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 text-xs font-semibold inline-flex items-center gap-1 cursor-pointer"
                            title="Unmute member"
                          >
                            <Volume2 className="w-3.5 h-3.5" />
                            Unmute
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() =>
                              setMuteMenuUserId(muteMenuUserId === m.user_id ? null : m.user_id)
                            }
                            className="px-2.5 py-1.5 rounded-lg htv-card hover:bg-[var(--htv-hover)] text-xs font-semibold inline-flex items-center gap-1 cursor-pointer"
                            title="Mute member if spamming SMS"
                          >
                            <VolumeX className="w-3.5 h-3.5 text-amber-500" />
                            Mute
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => handleRemoveMember(m.user_id)}
                          aria-label={`Remove ${m.name}`}
                          className="p-1.5 rounded-lg bg-rose-500/15 text-rose-500 dark:text-rose-300 hover:bg-rose-500/25 cursor-pointer"
                          title="Remove from group"
                        >
                          <UserMinus className="w-3.5 h-3.5" />
                        </button>

                        {muteMenuUserId === m.user_id && (
                          <div className="absolute right-0 top-9 z-30 htv-card rounded-xl p-2 shadow-xl flex items-center gap-1">
                            {[
                              { label: '15m', mins: 15 },
                              { label: '1h', mins: 60 },
                              { label: '24h', mins: 1440 },
                              { label: 'Forever', mins: 0 },
                            ].map((opt) => (
                              <button
                                key={opt.label}
                                type="button"
                                onClick={() => handleMuteMember(m.user_id, true, opt.mins)}
                                className="px-2 py-1 rounded-lg htv-elevated hover:bg-[var(--htv-hover)] text-[11px] font-semibold whitespace-nowrap cursor-pointer"
                              >
                                {opt.label}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}

          {tab === 'add' && (
            <>
              <div className="space-y-2">
                <input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search members by name or @username..."
                  className="w-full h-9 px-3.5 rounded-xl htv-elevated text-xs text-[var(--htv-text)]"
                />
                <p className="text-[11px] text-[var(--htv-text-muted)]">
                  Rule: Only users who follow the group admin or are friends (connected) can be added.
                </p>
              </div>

              {loadingCandidates ? (
                <p className="text-xs text-[var(--htv-text-dim)] py-6 text-center">Loading members...</p>
              ) : (
                <div className="space-y-2">
                  {filteredCandidates.map((u) => (
                    <div
                      key={u.id}
                      className="htv-elevated rounded-xl p-3 flex items-center justify-between gap-3 flex-wrap"
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <Avatar src={u.avatar_url} name={u.name} size="sm" isOnline={u.is_online} showOnlineRing />
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="text-xs font-semibold truncate">{u.name}</span>
                            <VerifiedBadge verified={u.is_verified} />
                          </div>
                          <p className="text-[11px] text-[var(--htv-text-dim)] truncate">
                            @{u.username} ·{' '}
                            {u.follows_admin
                              ? 'Follows Admin'
                              : u.is_friend_with_actor_or_admin
                              ? 'Friend'
                              : 'Must follow admin or be friends'}
                          </p>
                        </div>
                      </div>

                      <div className="flex items-center gap-1.5 shrink-0">
                        {u.already_member ? (
                          <span className="text-xs font-semibold text-emerald-600 dark:text-emerald-300">
                            In Group
                          </span>
                        ) : u.pending_request ? (
                          <span className="text-xs font-semibold text-amber-600 dark:text-amber-300">
                            Pending Admin
                          </span>
                        ) : !u.eligible ? (
                          <span className="text-[11px] text-rose-500 dark:text-rose-300 font-medium">
                            Not Eligible
                          </span>
                        ) : isGroupAdmin ? (
                          <>
                            <button
                              type="button"
                              onClick={() => handleAddMember(u.id, 'direct')}
                              className="htv-gradient-btn px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer"
                            >
                              Add Direct
                            </button>
                            <button
                              type="button"
                              onClick={() => handleAddMember(u.id, 'approval')}
                              className="px-2.5 py-1.5 rounded-lg htv-card hover:bg-[var(--htv-hover)] text-xs font-semibold cursor-pointer"
                              title="Send to Admin Approval Queue"
                            >
                              Request
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            onClick={() => handleAddMember(u.id)}
                            className="htv-gradient-btn px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer"
                          >
                            {group.join_mode === 'approval' ? 'Request Add' : 'Add Member'}
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {tab === 'requests' && isGroupAdmin && (
            <div className="space-y-2.5">
              {pendingRequests.length === 0 ? (
                <p className="text-xs text-[var(--htv-text-dim)] py-8 text-center">
                  No pending join requests waiting for admin approval.
                </p>
              ) : (
                pendingRequests.map((req) => (
                  <div
                    key={req.id}
                    className="htv-elevated rounded-xl p-3.5 flex items-center justify-between gap-3 flex-wrap"
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <Avatar src={req.avatar_url} name={req.name} size="sm" />
                      <div className="min-w-0">
                        <div className="flex items-center gap-1">
                          <span className="text-xs font-semibold truncate">{req.name}</span>
                          <VerifiedBadge verified={req.is_verified} />
                        </div>
                        <p className="text-[11px] text-[var(--htv-text-dim)] truncate">
                          @{req.username}
                          {req.invited_by_name ? ` · Invited by ${req.invited_by_name}` : ' · Via Group Link'}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => handleRespondJoinRequest(req.id, 'approve')}
                        className="htv-gradient-btn px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer"
                      >
                        Approve
                      </button>
                      <button
                        type="button"
                        onClick={() => handleRespondJoinRequest(req.id, 'reject')}
                        className="px-3 py-1.5 rounded-lg bg-rose-500/15 text-rose-600 dark:text-rose-300 text-xs font-semibold cursor-pointer"
                      >
                        Reject
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}

          {tab === 'settings' && (
            <div className="space-y-4">
              {/* Group Invite Link */}
              <div className="htv-elevated rounded-xl p-4 space-y-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-bold">Group Invite Link</span>
                  {isGroupAdmin && (
                    <button
                      type="button"
                      disabled={savingSettings}
                      onClick={() => handleSaveSettings(true)}
                      className="text-xs text-purple-600 dark:text-purple-300 hover:underline inline-flex items-center gap-1 cursor-pointer"
                    >
                      <RefreshCw className="w-3 h-3" />
                      Reset Link
                    </button>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    readOnly
                    value={groupInviteUrl}
                    className="flex-1 h-9 px-3 rounded-lg htv-card text-xs font-mono-tabular text-[var(--htv-text-muted)]"
                  />
                  <button
                    type="button"
                    onClick={handleCopyGroupLink}
                    className="htv-gradient-btn h-9 px-3.5 rounded-lg text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
                  >
                    {copiedLink ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                    {copiedLink ? 'Copied' : 'Copy Link'}
                  </button>
                </div>
              </div>

              {/* Admin Controls: 2-Way Join Mode */}
              {isGroupAdmin && (
                <div className="htv-elevated rounded-xl p-4 space-y-4">
                  <div className="space-y-2">
                    <span className="text-xs font-bold block">Member Joining Mode</span>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={() => setJoinMode('direct')}
                        className={`p-2.5 rounded-xl text-left text-xs font-semibold cursor-pointer ${
                          joinMode === 'direct'
                            ? 'htv-gradient-btn'
                            : 'htv-card text-[var(--htv-text-muted)]'
                        }`}
                      >
                        1. Direct Add
                        <span className="block text-[11px] font-normal opacity-85 mt-0.5">
                          Eligible friends/followers join directly
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setJoinMode('approval')}
                        className={`p-2.5 rounded-xl text-left text-xs font-semibold cursor-pointer ${
                          joinMode === 'approval'
                            ? 'htv-gradient-btn'
                            : 'htv-card text-[var(--htv-text-muted)]'
                        }`}
                      >
                        2. Admin Permission
                        <span className="block text-[11px] font-normal opacity-85 mt-0.5">
                          Requires admin approval before joining
                        </span>
                      </button>
                    </div>
                  </div>

                  <button
                    type="button"
                    disabled={savingSettings}
                    onClick={() => handleSaveSettings(false)}
                    className="htv-gradient-btn px-4 py-2 rounded-xl text-xs font-semibold cursor-pointer disabled:opacity-50"
                  >
                    {savingSettings ? 'Saving...' : 'Save Group Settings'}
                  </button>
                </div>
              )}

              {/* Report Group */}
              <div className="htv-elevated rounded-xl p-4 space-y-2.5">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <p className="text-xs font-bold">Report This Group</p>
                    <p className="text-[11px] text-[var(--htv-text-muted)]">
                      Generate a Case ID for admin moderation review.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowReportBox((s) => !s)}
                    className="px-3 py-1.5 rounded-lg bg-amber-500/15 text-amber-700 dark:text-amber-300 text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer"
                  >
                    <Flag className="w-3.5 h-3.5" />
                    Report Group
                  </button>
                </div>

                {showReportBox && (
                  <form onSubmit={handleReportGroup} className="space-y-2 pt-1">
                    <input
                      type="text"
                      required
                      value={reportReason}
                      onChange={(e) => setReportReason(e.target.value)}
                      placeholder="Describe why you are reporting this group..."
                      className="w-full h-9 px-3 rounded-lg htv-card text-xs text-[var(--htv-text)]"
                    />
                    <button
                      type="submit"
                      className="px-3.5 py-1.5 rounded-lg bg-rose-600 text-white text-xs font-semibold cursor-pointer"
                    >
                      Submit Group Report
                    </button>
                  </form>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
