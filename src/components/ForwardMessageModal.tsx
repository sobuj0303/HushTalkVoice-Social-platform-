import React, { useEffect, useState } from 'react';
import { X, Forward, Search, Check, Send, Users } from 'lucide-react';
import { Avatar, VerifiedBadge } from './Avatar';
import { apiFetch } from '../lib/api';
import { formatFileSize } from '../shared/validation';
import type { ChatMessage, ConversationItem, PersonDirectoryItem } from '../shared/types';

interface ForwardMessageModalProps {
  message: ChatMessage | null;
  conversations: ConversationItem[];
  currentUserId: number;
  onClose: () => void;
  onForwarded: () => void;
}

export const ForwardMessageModal: React.FC<ForwardMessageModalProps> = ({
  message,
  conversations,
  currentUserId,
  onClose,
  onForwarded,
}) => {
  const [search, setSearch] = useState('');
  const [people, setPeople] = useState<PersonDirectoryItem[]>([]);
  const [sentConvIds, setSentConvIds] = useState<number[]>([]);
  const [sentUserIds, setSentUserIds] = useState<number[]>([]);
  const [sendingKey, setSendingKey] = useState<string>('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!message) return;
    setSearch('');
    setSentConvIds([]);
    setSentUserIds([]);
    setError('');
    apiFetch<{ people: PersonDirectoryItem[] }>('/api/people')
      .then((d) => setPeople(d.people || []))
      .catch(() => {});
  }, [message?.id]);

  if (!message) return null;

  const parsedSource = {
    id: Number(message.id || 0),
    conversation_id: Number(message.conversation_id || 0),
    content: String(message.content || ''),
    media_type: message.media_type || 'none',
    media_url: String(message.media_url || ''),
    media_size_bytes: Number(message.media_size_bytes || 0),
    sender_name: String(message.sender_name || ''),
    forwarded_from_name: String(message.forwarded_from_name || ''),
  };

  const q = search.trim().toLowerCase();

  // Deduplicate direct conversations so people list doesn't duplicate existing chats
  const directUserIds = new Set(
    conversations
      .filter((c) => c.type === 'direct' && c.other_user?.id)
      .map((c) => c.other_user!.id)
  );

  const filteredConversations = conversations.filter(
    (c) => !q || c.name.toLowerCase().includes(q)
  );

  const filteredPeople = people.filter(
    (p) =>
      p.id !== currentUserId &&
      !directUserIds.has(p.id) &&
      (!q || p.name.toLowerCase().includes(q) || p.username.toLowerCase().includes(q))
  );

  const handleForwardToConversation = async (conv: ConversationItem) => {
    setError('');
    const key = `conv-${conv.id}`;
    setSendingKey(key);
    try {
      await apiFetch(`/api/messages/${parsedSource.id}/forward`, {
        method: 'POST',
        body: JSON.stringify({
          targetConversationIds: [conv.id],
          sourceMessage: parsedSource,
        }),
      });
      setSentConvIds((prev) => [...prev, conv.id]);
      onForwarded();
    } catch (err: any) {
      setError(err?.message || 'Could not forward message.');
    } finally {
      setSendingKey('');
    }
  };

  const handleForwardToPerson = async (person: PersonDirectoryItem) => {
    setError('');
    const key = `user-${person.id}`;
    setSendingKey(key);
    try {
      await apiFetch(`/api/messages/${parsedSource.id}/forward`, {
        method: 'POST',
        body: JSON.stringify({
          targetUserIds: [person.id],
          sourceMessage: parsedSource,
        }),
      });
      setSentUserIds((prev) => [...prev, person.id]);
      onForwarded();
    } catch (err: any) {
      setError(err?.message || 'Could not forward message.');
    } finally {
      setSendingKey('');
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-3 sm:p-4">
      <div className="htv-card rounded-2xl w-full max-w-md max-h-[85vh] flex flex-col overflow-hidden shadow-2xl">
        <header className="px-4 py-3 border-b border-[var(--htv-border-subtle)] flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Forward className="w-4 h-4 text-purple-500" />
            <h3 className="font-display font-bold text-base">Forward Message</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close forward modal"
            className="p-1.5 rounded-xl htv-elevated text-[var(--htv-text-muted)] hover:text-[var(--htv-text)] cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </header>

        {/* Preview of message being forwarded */}
        <div className="px-4 pt-3 space-y-2">
          <div className="htv-elevated rounded-xl p-2.5 text-xs space-y-1">
            <p className="text-[11px] font-semibold text-purple-600 dark:text-purple-300">
              From {parsedSource.sender_name}
            </p>
            <p className="text-[var(--htv-text)] line-clamp-2">
              {parsedSource.content ||
                (parsedSource.media_type === 'video'
                  ? `Video (${formatFileSize(parsedSource.media_size_bytes) || 'clip'})`
                  : parsedSource.media_type === 'audio'
                  ? 'Voice / Audio message'
                  : 'Gallery photo')}
            </p>
          </div>

          {error && (
            <p className="text-xs text-rose-600 dark:text-rose-300 bg-rose-500/10 border border-rose-500/25 rounded-lg px-3 py-2">
              {error}
            </p>
          )}

          <div className="relative">
            <Search className="w-4 h-4 text-[var(--htv-text-dim)] absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search groups or friends..."
              className="w-full h-9 pl-9 pr-3 rounded-xl htv-elevated text-xs text-[var(--htv-text)]"
            />
          </div>
        </div>

        {/* Chats & Friends List */}
        <div className="flex-1 overflow-y-auto p-4 space-y-1.5">
          {filteredConversations.map((conv) => {
            const sent = sentConvIds.includes(conv.id);
            const busy = sendingKey === `conv-${conv.id}`;

            return (
              <div
                key={`conv-${conv.id}`}
                className="htv-elevated rounded-xl p-2.5 flex items-center justify-between gap-2.5"
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <Avatar
                    src={conv.avatar_url}
                    name={conv.name}
                    size="sm"
                    isOnline={conv.type === 'direct' && Boolean(conv.other_user?.is_online)}
                    showOnlineRing={conv.type === 'direct'}
                  />
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs font-semibold truncate">{conv.name}</span>
                      {conv.type === 'group' && (
                        <Users className="w-3 h-3 text-purple-500 shrink-0" />
                      )}
                    </div>
                    <p className="text-[11px] text-[var(--htv-text-dim)] truncate">
                      {conv.type === 'group'
                        ? `Group · ${conv.member_count} members`
                        : 'Direct Chat'}
                    </p>
                  </div>
                </div>

                {sent ? (
                  <span className="px-3 py-1.5 rounded-lg bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 text-xs font-semibold inline-flex items-center gap-1">
                    <Check className="w-3.5 h-3.5" />
                    Sent
                  </span>
                ) : (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => handleForwardToConversation(conv)}
                    className="htv-gradient-btn px-3 py-1.5 rounded-lg text-xs font-semibold inline-flex items-center gap-1 cursor-pointer disabled:opacity-50"
                  >
                    <Send className="w-3 h-3" />
                    {busy ? '...' : 'Send'}
                  </button>
                )}
              </div>
            );
          })}

          {filteredPeople.length > 0 && (
            <>
              <p className="pt-2 text-[11px] font-semibold text-[var(--htv-text-dim)] uppercase tracking-wide">
                People & Friends
              </p>
              {filteredPeople.map((person) => {
                const sent = sentUserIds.includes(person.id);
                const busy = sendingKey === `user-${person.id}`;
                return (
                  <div
                    key={`user-${person.id}`}
                    className="htv-elevated rounded-xl p-2.5 flex items-center justify-between gap-2.5"
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <Avatar
                        src={person.avatar_url}
                        name={person.name}
                        size="sm"
                        isOnline={person.is_online}
                        showOnlineRing
                      />
                      <div className="min-w-0">
                        <div className="flex items-center gap-1">
                          <span className="text-xs font-semibold truncate">{person.name}</span>
                          <VerifiedBadge verified={person.is_verified} />
                        </div>
                        <p className="text-[11px] text-[var(--htv-text-dim)] truncate">
                          @{person.username}
                        </p>
                      </div>
                    </div>

                    {sent ? (
                      <span className="px-3 py-1.5 rounded-lg bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 text-xs font-semibold inline-flex items-center gap-1">
                        <Check className="w-3.5 h-3.5" />
                        Sent
                      </span>
                    ) : (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => handleForwardToPerson(person)}
                        className="htv-gradient-btn px-3 py-1.5 rounded-lg text-xs font-semibold inline-flex items-center gap-1 cursor-pointer disabled:opacity-50"
                      >
                        <Send className="w-3 h-3" />
                        {busy ? '...' : 'Send'}
                      </button>
                    )}
                  </div>
                );
              })}
            </>
          )}
        </div>
      </div>
    </div>
  );
};
