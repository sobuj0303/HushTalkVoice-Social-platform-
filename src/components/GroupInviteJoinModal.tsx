import React, { useEffect, useState } from 'react';
import { Users, Link2, ShieldAlert, Check, X } from 'lucide-react';
import { Avatar } from './Avatar';
import { apiFetch } from '../lib/api';

interface GroupPreviewData {
  id: number;
  name: string;
  avatar_url: string;
  invite_code: string;
  join_mode: 'direct' | 'approval';
  member_count: number;
  creator_id: number;
  creator_name: string;
  creator_username: string;
  already_member: boolean;
  pending_request: boolean;
  eligible: boolean;
  eligibility_reason: string;
}

interface GroupInviteJoinModalProps {
  inviteCode: string | null;
  onClose: () => void;
  onJoinedConversation: (conversationId: number) => void;
  onOpenAdminProfile: (creatorId: number) => void;
}

export const GroupInviteJoinModal: React.FC<GroupInviteJoinModalProps> = ({
  inviteCode,
  onClose,
  onJoinedConversation,
  onOpenAdminProfile,
}) => {
  const [loading, setLoading] = useState(false);
  const [group, setGroup] = useState<GroupPreviewData | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!inviteCode) {
      setGroup(null);
      return;
    }
    setLoading(true);
    setError('');
    setNotice('');
    apiFetch<{ group: GroupPreviewData }>(`/api/groups/preview/${encodeURIComponent(inviteCode)}`)
      .then((res) => setGroup(res.group))
      .catch((err: any) => setError(err?.message || 'Invalid group link.'))
      .finally(() => setLoading(false));
  }, [inviteCode]);

  if (!inviteCode) return null;

  const handleJoin = async () => {
    if (!group) return;
    setSubmitting(true);
    setError('');
    setNotice('');
    try {
      const res = await apiFetch<{
        joined: boolean;
        pending: boolean;
        message?: string;
        conversation?: { id: number };
      }>('/api/groups/join-by-code', {
        method: 'POST',
        body: JSON.stringify({ code: group.invite_code }),
      });
      if (res.joined && res.conversation) {
        onJoinedConversation(res.conversation.id);
        onClose();
      } else {
        setNotice(res.message || 'Join request sent to group admin.');
        setGroup((prev) => (prev ? { ...prev, pending_request: true } : prev));
      }
    } catch (err: any) {
      setError(err?.message || 'Could not join group.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="htv-card rounded-2xl p-6 max-w-md w-full space-y-4 shadow-2xl">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Link2 className="w-5 h-5 text-purple-500" />
            <h3 className="font-display font-bold text-base">Group Invite</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-[var(--htv-text-dim)] hover:text-[var(--htv-text)] cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {loading ? (
          <p className="text-xs text-[var(--htv-text-muted)] py-6 text-center">Loading group details...</p>
        ) : group ? (
          <div className="space-y-4">
            <div className="htv-elevated rounded-xl p-4 flex items-center gap-3">
              <Avatar src={group.avatar_url} name={group.name} size="md" />
              <div className="min-w-0">
                <h4 className="font-display font-bold text-sm truncate">{group.name}</h4>
                <p className="text-xs text-[var(--htv-text-muted)]">
                  Admin: {group.creator_name} (@{group.creator_username})
                </p>
                <p className="text-[11px] text-[var(--htv-text-dim)] font-mono-tabular mt-0.5">
                  {group.member_count} members ·{' '}
                  {group.join_mode === 'approval' ? 'Admin approval required' : 'Direct join'}
                </p>
              </div>
            </div>

            {!group.eligible && !group.already_member && (
              <div className="rounded-xl border border-amber-500/35 bg-amber-500/10 p-3 space-y-2 text-xs text-amber-800 dark:text-amber-200">
                <div className="flex items-start gap-2">
                  <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
                  <p>{group.eligibility_reason}</p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    onOpenAdminProfile(group.creator_id);
                    onClose();
                  }}
                  className="px-3 py-1.5 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 font-semibold cursor-pointer"
                >
                  Open Admin Profile to Follow / Connect
                </button>
              </div>
            )}

            {notice && (
              <div className="rounded-xl border border-emerald-500/35 bg-emerald-500/10 px-3.5 py-2.5 text-xs text-emerald-700 dark:text-emerald-300 flex items-center gap-2">
                <Check className="w-4 h-4 shrink-0" />
                <span>{notice}</span>
              </div>
            )}

            {error && (
              <p className="text-xs text-rose-500 dark:text-rose-300 bg-rose-500/10 border border-rose-500/25 rounded-lg px-3 py-2">
                {error}
              </p>
            )}

            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 rounded-xl htv-elevated text-xs font-semibold cursor-pointer"
              >
                Close
              </button>
              {group.already_member ? (
                <button
                  type="button"
                  onClick={() => {
                    onJoinedConversation(group.id);
                    onClose();
                  }}
                  className="htv-gradient-btn px-4 py-2 rounded-xl text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer"
                >
                  <Users className="w-3.5 h-3.5" />
                  Open Group
                </button>
              ) : group.pending_request ? (
                <span className="px-4 py-2 rounded-xl htv-elevated text-xs font-semibold text-amber-500">
                  Waiting for Admin Approval
                </span>
              ) : (
                <button
                  type="button"
                  disabled={!group.eligible || submitting}
                  onClick={handleJoin}
                  className="htv-gradient-btn px-4 py-2 rounded-xl text-xs font-semibold cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed"
                >
                  {submitting
                    ? 'Sending...'
                    : group.join_mode === 'approval'
                    ? 'Request Admin Permission'
                    : 'Join Group'}
                </button>
              )}
            </div>
          </div>
        ) : (
          <p className="text-xs text-rose-400">{error || 'Group not found.'}</p>
        )}
      </div>
    </div>
  );
};
