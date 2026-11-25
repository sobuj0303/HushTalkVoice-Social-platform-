import React, { useEffect, useRef, useState } from 'react';
import {
  Users,
  Plus,
  Send,
  Image as ImageIcon,
  Music,
  Mic,
  Video,
  Reply,
  Trash2,
  X,
  Check,
  CheckCheck,
  ArrowLeft,
  BellOff,
  Bell,
  Link2,
  Flag,
  Forward,
  Play,
} from 'lucide-react';
import {
  Loader2,
} from 'lucide-react';
import { Avatar, VerifiedBadge } from './Avatar';
import { VoiceRecorder } from './VoiceRecorder';
import {
  formatMessageTimestamp,
  GroupVideoBubbleCard,
  GroupVideoPlayerModal,
  type VideoPlaybackQuality,
} from './GroupVideoPlayerModal';
import { GroupManageModal } from './GroupManageModal';
import { GroupInviteJoinModal } from './GroupInviteJoinModal';
import { ForwardMessageModal } from './ForwardMessageModal';
import { apiFetch, uploadMediaFile } from '../lib/api';
import {
  ALLOWED_REACTION_EMOJIS,
  countWords,
  formatFileSize,
  MAX_GROUP_MEMBERS,
  MAX_GROUP_VIDEO_MB,
  MAX_WORDS,
  validateTextField,
} from '../shared/validation';
import type {
  AuthUser,
  ChatMessage,
  ConversationItem,
  GroupCandidateItem,
} from '../shared/types';

interface MessengerViewProps {
  currentUser: AuthUser;
  initialConversationId: number | null;
  wsEvent: { type: string; [key: string]: any } | null;
  sendWsPayload: (payload: Record<string, unknown>) => void;
  onConversationsChanged: () => void;
  onOpenProfile?: (userId: number) => void;
}

export const MessengerView: React.FC<MessengerViewProps> = ({
  currentUser,
  initialConversationId,
  wsEvent,
  sendWsPayload,
  onConversationsChanged,
  onOpenProfile,
}) => {
  const [folder, setFolder] = useState<'inbox' | 'requests'>('inbox');
  const [inbox, setInbox] = useState<ConversationItem[]>([]);
  const [requests, setRequests] = useState<ConversationItem[]>([]);
  const [loadingConvs, setLoadingConvs] = useState(true);
  const [activeConvId, setActiveConvId] = useState<number | null>(initialConversationId);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loadingMsgs, setLoadingMsgs] = useState(false);

  // Composer state
  const [text, setText] = useState('');
  const [mediaType, setMediaType] = useState<'none' | 'image' | 'audio' | 'video'>('none');
  const [mediaUrl, setMediaUrl] = useState('');
  const [mediaSizeBytes, setMediaSizeBytes] = useState(0);
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const [showRecorder, setShowRecorder] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadingKind, setUploadingKind] = useState<'image' | 'audio' | 'video' | null>(null);
  const [chatError, setChatError] = useState('');

  // Active video message opened for playback & preferred quality (e.g. 144p)
  const [playingVideoMsg, setPlayingVideoMsg] = useState<ChatMessage | null>(null);
  const [playingVideoQuality, setPlayingVideoQuality] = useState<VideoPlaybackQuality>('original');
  // Message selected for Facebook-style forwarding
  const [forwardTargetMsg, setForwardTargetMsg] = useState<ChatMessage | null>(null);

  // Long-press context menu, press feedback & typing state
  const [contextMenuMsgId, setContextMenuMsgId] = useState<number | null>(null);
  const [pressingMsgId, setPressingMsgId] = useState<number | null>(null);
  const longPressTimerRef = useRef<number | null>(null);
  const pressOriginRef = useRef<{ x: number; y: number } | null>(null);
  const longPressTriggeredAtRef = useRef<number>(0);
  const prevConvIdRef = useRef<number | null>(null);
  const activeConvIdRef = useRef<number | null>(initialConversationId);

  const [typingUser, setTypingUser] = useState<string>('');
  const typingTimeoutRef = useRef<number | null>(null);

  // Group create modal
  const [showCreateGroup, setShowCreateGroup] = useState(false);
  const [groupName, setGroupName] = useState('');
  const [groupJoinMode, setGroupJoinMode] = useState<'direct' | 'approval'>('direct');
  const [groupSelectedIds, setGroupSelectedIds] = useState<number[]>([]);
  const [groupCreateError, setGroupCreateError] = useState('');
  const [createCandidates, setCreateCandidates] = useState<GroupCandidateItem[]>([]);

  // Group Manage Popup Modal
  const [manageModalOpen, setManageModalOpen] = useState(false);
  const [manageModalTab, setManageModalTab] = useState<'members' | 'add' | 'requests' | 'settings'>(
    'members'
  );
  const [copiedGroupLink, setCopiedGroupLink] = useState(false);

  // Join Group via pasted link/code modal
  const [showJoinInput, setShowJoinInput] = useState(false);
  const [joinLinkInput, setJoinLinkInput] = useState('');
  const [previewInviteCode, setPreviewInviteCode] = useState<string | null>(null);

  const imgRef = useRef<HTMLInputElement>(null);
  const audRef = useRef<HTMLInputElement>(null);
  const vidRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const loadConversations = async () => {
    try {
      const data = await apiFetch<{ inbox: ConversationItem[]; requests: ConversationItem[] }>(
        '/api/conversations'
      );
      setInbox(data.inbox);
      setRequests(data.requests);
      if (!activeConvIdRef.current && data.inbox.length > 0 && window.innerWidth >= 768) {
        setActiveConvId(data.inbox[0].id);
      }
    } catch {
      // ignore
    } finally {
      setLoadingConvs(false);
    }
  };

  const loadMessages = async (convId: number, options?: { silent?: boolean; scrollToBottom?: boolean }) => {
    const silent = options?.silent ?? false;
    const scrollToBottom = options?.scrollToBottom ?? !silent;
    if (!silent) {
      setLoadingMsgs(true);
    }
    try {
      const data = await apiFetch<{ messages: ChatMessage[] }>(
        `/api/conversations/${convId}/messages`
      );
      setMessages(data.messages);
      setPlayingVideoMsg((prev) =>
        prev ? data.messages.find((m) => m.id === prev.id) || prev : null
      );
      if (scrollToBottom) {
        onConversationsChanged();
        setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 60);
      }
    } catch {
      // ignore
    } finally {
      if (!silent) {
        setLoadingMsgs(false);
      }
    }
  };

  useEffect(() => {
    loadConversations();
    return () => {
      if (typingTimeoutRef.current) window.clearTimeout(typingTimeoutRef.current);
      if (longPressTimerRef.current) window.clearTimeout(longPressTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (showCreateGroup) {
      apiFetch<{ candidates: GroupCandidateItem[] }>('/api/groups/create-candidates')
        .then((d) => setCreateCandidates(d.candidates))
        .catch(() => {});
    }
  }, [showCreateGroup]);

  useEffect(() => {
    if (initialConversationId) {
      setActiveConvId(initialConversationId);
      setFolder('inbox');
    }
  }, [initialConversationId]);

  useEffect(() => {
    activeConvIdRef.current = activeConvId;
    if (activeConvId) {
      const changedConv = prevConvIdRef.current !== activeConvId;
      prevConvIdRef.current = activeConvId;
      loadMessages(activeConvId, { silent: !changedConv, scrollToBottom: true });
      setTypingUser('');
      setReplyTo(null);
      setChatError('');
      setContextMenuMsgId(null);
    } else {
      prevConvIdRef.current = null;
      setMessages([]);
      setContextMenuMsgId(null);
    }
  }, [activeConvId]);

  useEffect(() => {
    if (contextMenuMsgId === null) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setContextMenuMsgId(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [contextMenuMsgId]);

  // Handle real-time WebSocket updates without jarring loading flashes or scroll jumps
  useEffect(() => {
    if (!wsEvent) return;
    const currentConvId = activeConvIdRef.current;

    if (wsEvent.type === 'message:new') {
      loadConversations();
      if (wsEvent.conversationId === currentConvId && wsEvent.message) {
        setMessages((prev) => {
          if (prev.some((m) => m.id === wsEvent.message.id)) return prev;
          return [...prev, wsEvent.message];
        });
        apiFetch(`/api/conversations/${currentConvId}/read`, { method: 'POST' }).catch(() => {});
        onConversationsChanged();
        setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 60);
      }
    } else if (wsEvent.type === 'message:updated') {
      if (currentConvId !== null && wsEvent.conversationId === currentConvId) {
        if (wsEvent.action === 'unsend' && wsEvent.messageId) {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === wsEvent.messageId
                ? {
                    ...m,
                    is_unsent: true,
                    content: '',
                    media_type: 'none',
                    media_url: '',
                    media_size_bytes: 0,
                    reactions: [],
                  }
                : m
            )
          );
        } else {
          loadMessages(currentConvId, { silent: true, scrollToBottom: false });
        }
      }
      loadConversations();
    } else if (wsEvent.type === 'conversation:read') {
      loadConversations();
      if (
        currentConvId !== null &&
        Number(wsEvent.conversationId) === currentConvId &&
        Number(wsEvent.userId) !== currentUser.id
      ) {
        // Optimistically mark current user's sent messages as seen immediately
        setMessages((prev) =>
          prev.map((m) =>
            m.sender_id === currentUser.id && !m.is_unsent
              ? { ...m, seen_by_count: Math.max(1, m.seen_by_count) }
              : m
          )
        );
        loadMessages(currentConvId, { silent: true, scrollToBottom: false });
      }
    } else if (wsEvent.type === 'conversation:updated') {
      loadConversations();
    } else if (wsEvent.type === 'conversation:removed') {
      if (wsEvent.conversationId === currentConvId) {
        setActiveConvId(null);
        setManageModalOpen(false);
      }
      loadConversations();
    } else if (wsEvent.type === 'presence:update') {
      loadConversations();
    } else if (wsEvent.type === 'typing:start' && wsEvent.conversationId === currentConvId) {
      setTypingUser(wsEvent.userName || 'Someone');
    } else if (wsEvent.type === 'typing:stop' && wsEvent.conversationId === currentConvId) {
      setTypingUser('');
    }
  }, [wsEvent, currentUser.id]);

  const activeConv =
    inbox.find((c) => c.id === activeConvId) ||
    requests.find((c) => c.id === activeConvId) ||
    null;

  const listToDisplay = folder === 'inbox' ? inbox : requests;
  const wordCount = countWords(text);

  const emitTyping = (val: string) => {
    if (!activeConvId) return;
    sendWsPayload({ type: val ? 'typing:start' : 'typing:stop', conversationId: activeConvId });
    if (typingTimeoutRef.current) window.clearTimeout(typingTimeoutRef.current);
    if (val) {
      typingTimeoutRef.current = window.setTimeout(() => {
        sendWsPayload({ type: 'typing:stop', conversationId: activeConvId });
      }, 1800);
    }
  };

  const uploadFinalFile = async (file: File, expected: 'image' | 'audio' | 'video') => {
    setChatError('');
    setUploading(true);
    setUploadingKind(expected);
    try {
      const targetMaxMb =
        expected === 'video'
          ? Math.min(MAX_GROUP_VIDEO_MB, activeConv?.max_video_mb || MAX_GROUP_VIDEO_MB)
          : undefined;
      const uploaded = await uploadMediaFile(
        file,
        expected,
        targetMaxMb ? { maxMb: targetMaxMb } : undefined
      );
      setMediaType(uploaded.category);
      setMediaUrl(uploaded.url);
      setMediaSizeBytes(uploaded.size_bytes || file.size || 0);
      setShowRecorder(false);
    } catch (err: any) {
      setChatError(err?.message || 'File rejected.');
    } finally {
      setUploading(false);
      setUploadingKind(null);
    }
  };

  const handleMediaPick = async (
    e: React.ChangeEvent<HTMLInputElement>,
    expected: 'image' | 'audio' | 'video'
  ) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setChatError('');

    await uploadFinalFile(file, expected);
  };

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeConvId) return;
    setChatError('');

    if (!text.trim() && mediaType === 'none') return;
    const validation = validateTextField(text, 'Message', { maxWords: MAX_WORDS });
    if (!validation.valid) {
      setChatError(validation.error || 'Message blocked.');
      return;
    }

    try {
      const data = await apiFetch<{ message: ChatMessage }>(
        `/api/conversations/${activeConvId}/messages`,
        {
          method: 'POST',
          body: JSON.stringify({
            content: text,
            media_type: mediaType,
            media_url: mediaUrl,
            media_size_bytes: mediaSizeBytes,
            reply_to_id: replyTo?.id || null,
          }),
        }
      );
      setMessages((prev) =>
        prev.some((m) => m.id === data.message.id) ? prev : [...prev, data.message]
      );
      setText('');
      setMediaType('none');
      setMediaUrl('');
      setMediaSizeBytes(0);
      setReplyTo(null);
      setShowRecorder(false);
      sendWsPayload({ type: 'typing:stop', conversationId: activeConvId });
      loadConversations();
      setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 60);
    } catch (err: any) {
      setChatError(err?.message || 'Failed to send message.');
    }
  };

  const handleRespondRequest = async (convId: number, action: 'accept' | 'reject') => {
    try {
      await apiFetch(`/api/conversations/${convId}/respond`, {
        method: 'POST',
        body: JSON.stringify({ action }),
      });
      await loadConversations();
      if (action === 'accept') {
        setFolder('inbox');
        setActiveConvId(convId);
      } else {
        setActiveConvId(null);
      }
      onConversationsChanged();
    } catch {
      // ignore
    }
  };

  const handleToggleConversationMute = async () => {
    if (!activeConv) return;
    try {
      await apiFetch(`/api/conversations/${activeConv.id}/mute`, {
        method: 'POST',
        body: JSON.stringify({ muted: !activeConv.is_muted }),
      });
      await loadConversations();
      onConversationsChanged();
    } catch {
      // ignore
    }
  };

  const handleCopyGroupInvite = async () => {
    if (!activeConv || activeConv.type !== 'group' || !activeConv.invite_code) return;
    const url = `${window.location.origin}/?group=${encodeURIComponent(activeConv.invite_code)}`;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // fallback
    }
    setCopiedGroupLink(true);
    setTimeout(() => setCopiedGroupLink(false), 2200);
  };

  const handleCreateGroup = async (e: React.FormEvent) => {
    e.preventDefault();
    setGroupCreateError('');
    const check = validateTextField(groupName, 'Group Name', {
      required: true,
      maxWords: 20,
      maxChars: 60,
    });
    if (!check.valid) {
      setGroupCreateError(check.error || 'Invalid group name.');
      return;
    }
    if (groupSelectedIds.length + 1 > MAX_GROUP_MEMBERS) {
      setGroupCreateError(`Group limit is ${MAX_GROUP_MEMBERS} members.`);
      return;
    }
    try {
      const data = await apiFetch<{ conversation: ConversationItem }>('/api/conversations/group', {
        method: 'POST',
        body: JSON.stringify({
          name: groupName,
          memberIds: groupSelectedIds,
          join_mode: groupJoinMode,
        }),
      });
      setShowCreateGroup(false);
      setGroupName('');
      setGroupSelectedIds([]);
      setGroupJoinMode('direct');
      await loadConversations();
      setFolder('inbox');
      setActiveConvId(data.conversation.id);
    } catch (err: any) {
      setGroupCreateError(err?.message || 'Could not create group.');
    }
  };

  const computeOptimisticReactions = (
    current: ChatMessage['reactions'],
    emoji: string
  ): ChatMessage['reactions'] => {
    const prevMine = current.find((r) => r.user_reacted);
    let next = current.map((r) => ({ ...r }));

    if (prevMine) {
      next = next
        .map((r) =>
          r.emoji === prevMine.emoji
            ? { ...r, count: Math.max(0, r.count - 1), user_reacted: false }
            : r
        )
        .filter((r) => r.count > 0);
      if (prevMine.emoji === emoji) {
        return next;
      }
    }

    const existingTarget = next.find((r) => r.emoji === emoji);
    if (existingTarget) {
      return next.map((r) =>
        r.emoji === emoji ? { ...r, count: r.count + 1, user_reacted: true } : r
      );
    }
    return [...next, { emoji, count: 1, user_reacted: true }];
  };

  const handleReaction = async (messageId: number, emoji: string) => {
    setContextMenuMsgId(null);
    const snapshot = messages;

    const patchReaction = (reactions: ChatMessage['reactions']) =>
      computeOptimisticReactions(reactions, emoji);

    setMessages((prev) =>
      prev.map((m) => (m.id === messageId ? { ...m, reactions: patchReaction(m.reactions) } : m))
    );
    setPlayingVideoMsg((prev) =>
      prev && prev.id === messageId ? { ...prev, reactions: patchReaction(prev.reactions) } : prev
    );

    try {
      const res = await apiFetch<{ ok: boolean; reactions?: ChatMessage['reactions'] }>(
        `/api/messages/${messageId}/react`,
        {
          method: 'POST',
          body: JSON.stringify({ emoji }),
        }
      );
      if (res.reactions) {
        setMessages((prev) =>
          prev.map((m) => (m.id === messageId ? { ...m, reactions: res.reactions! } : m))
        );
        setPlayingVideoMsg((prev) =>
          prev && prev.id === messageId ? { ...prev, reactions: res.reactions! } : prev
        );
      }
    } catch {
      setMessages(snapshot);
      setPlayingVideoMsg((prev) =>
        prev && prev.id === messageId
          ? snapshot.find((m) => m.id === messageId) || prev
          : prev
      );
    }
  };

  const handleUnsend = async (messageId: number) => {
    setChatError('');
    setContextMenuMsgId(null);
    const snapshot = messages;

    setMessages((prev) =>
      prev.map((m) =>
        m.id === messageId
          ? {
              ...m,
              is_unsent: true,
              content: '',
              media_type: 'none',
              media_url: '',
              media_size_bytes: 0,
              reactions: [],
            }
          : m
      )
    );

    try {
      await apiFetch(`/api/messages/${messageId}`, { method: 'DELETE' });
      loadConversations();
    } catch (err: any) {
      setMessages(snapshot);
      setChatError(err?.message || 'Only the sender or an admin can delete this message.');
    }
  };

  // Long-press gesture handlers on message bubbles (text, image, audio & video) for Reaction + Action menu
  const clearLongPress = () => {
    if (longPressTimerRef.current) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    setPressingMsgId(null);
    pressOriginRef.current = null;
  };

  const startLongPress = (msgId: number, clientX: number, clientY: number) => {
    clearLongPress();
    setPressingMsgId(msgId);
    pressOriginRef.current = { x: clientX, y: clientY };
    longPressTimerRef.current = window.setTimeout(() => {
      longPressTriggeredAtRef.current = Date.now();
      setContextMenuMsgId(msgId);
      setPressingMsgId(null);
      longPressTimerRef.current = null;
    }, 360);
  };

  const handlePointerMovePress = (clientX: number, clientY: number) => {
    if (!pressOriginRef.current) return;
    const dx = Math.abs(clientX - pressOriginRef.current.x);
    const dy = Math.abs(clientY - pressOriginRef.current.y);
    if (dx > 10 || dy > 10) {
      clearLongPress();
    }
  };

  const shouldIgnoreMediaClick = () => {
    if (Date.now() - longPressTriggeredAtRef.current < 450) {
      longPressTriggeredAtRef.current = 0;
      return true;
    }
    return false;
  };

  const parseInviteCode = (raw: string): string => {
    const trimmed = raw.trim();
    if (!trimmed) return '';
    try {
      if (trimmed.includes('group=')) {
        const u = new URL(trimmed.startsWith('http') ? trimmed : `https://x.local/${trimmed}`);
        return u.searchParams.get('group') || trimmed;
      }
    } catch {
      // fallback
    }
    return trimmed;
  };

  const isGroupAdmin =
    activeConv?.type === 'group' &&
    (activeConv.created_by === currentUser.id ||
      activeConv.members?.some((m) => m.user_id === currentUser.id && m.role === 'admin'));

  const pendingRequestsCount = activeConv?.pending_join_requests?.length || 0;

  return (
    <div className="htv-card rounded-2xl overflow-hidden grid grid-cols-1 md:grid-cols-12 min-h-[640px] max-h-[calc(100vh-140px)]">
      {/* Left Thread List */}
      <aside
        className={`md:col-span-4 border-r border-[var(--htv-border-subtle)] flex flex-col min-h-0 ${
          activeConvId ? 'hidden md:flex' : 'flex'
        }`}
      >
        <div className="p-2.5 border-b border-[var(--htv-border-subtle)] space-y-2">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <h2 className="font-display font-bold text-base">Messenger</h2>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setShowJoinInput((s) => !s)}
                className="px-2.5 py-1.5 rounded-lg htv-elevated hover:bg-[var(--htv-hover)] text-xs font-semibold inline-flex items-center gap-1 whitespace-nowrap cursor-pointer"
                title="Join group using copied link or code"
              >
                <Link2 className="w-3.5 h-3.5 text-purple-600 dark:text-purple-300" />
                Join
              </button>
              <button
                type="button"
                onClick={() => setShowCreateGroup(true)}
                className="htv-gradient-btn px-3 py-1.5 rounded-lg text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                New Group
              </button>
            </div>
          </div>

          {showJoinInput && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const code = parseInviteCode(joinLinkInput);
                if (code) {
                  setPreviewInviteCode(code);
                  setShowJoinInput(false);
                  setJoinLinkInput('');
                }
              }}
              className="flex items-center gap-1.5"
            >
              <input
                type="text"
                value={joinLinkInput}
                onChange={(e) => setJoinLinkInput(e.target.value)}
                placeholder="Paste group link or invite code..."
                className="flex-1 h-8 px-2.5 rounded-lg htv-elevated text-xs text-[var(--htv-text)]"
              />
              <button
                type="submit"
                className="htv-gradient-btn h-8 px-2.5 rounded-lg text-xs font-semibold cursor-pointer"
              >
                Open
              </button>
            </form>
          )}

          <div className="flex items-center gap-1 p-1 rounded-xl htv-elevated">
            <button
              type="button"
              onClick={() => setFolder('inbox')}
              className={`flex-1 py-1.5 px-2.5 rounded-lg text-xs font-semibold cursor-pointer ${
                folder === 'inbox'
                  ? 'htv-gradient-btn'
                  : 'text-[var(--htv-text-muted)] hover:text-[var(--htv-text)]'
              }`}
            >
              Inbox ({inbox.length})
            </button>
            <button
              type="button"
              onClick={() => setFolder('requests')}
              className={`flex-1 py-1.5 px-2.5 rounded-lg text-xs font-semibold cursor-pointer ${
                folder === 'requests'
                  ? 'htv-gradient-btn'
                  : 'text-[var(--htv-text-muted)] hover:text-[var(--htv-text)]'
              }`}
            >
              Requests ({requests.length})
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto divide-y divide-[var(--htv-border-subtle)]">
          {loadingConvs && listToDisplay.length === 0 ? (
            <div className="p-3 space-y-3" aria-label="Loading conversations">
              {[1, 2, 3, 4, 5].map((n) => (
                <div key={n} className="flex items-center gap-2.5 animate-pulse">
                  <div className="w-10 h-10 rounded-full htv-elevated shrink-0" />
                  <div className="flex-1 space-y-1.5">
                    <div className="h-3.5 w-28 htv-elevated rounded" />
                    <div className="h-2.5 w-40 htv-elevated rounded" />
                  </div>
                </div>
              ))}
            </div>
          ) : listToDisplay.length === 0 ? (
            <div className="p-5 text-center text-xs text-[var(--htv-text-dim)]">
              {folder === 'inbox'
                ? 'No active chats yet. Start a chat from Find People or create a group.'
                : 'No pending message requests.'}
            </div>
          ) : (
            listToDisplay.map((conv) => (
              <button
                key={conv.id}
                type="button"
                onClick={() => setActiveConvId(conv.id)}
                className={`w-full px-3 py-2.5 flex items-center gap-2.5 text-left transition-colors cursor-pointer ${
                  activeConvId === conv.id ? 'bg-purple-500/15' : 'hover:bg-[var(--htv-hover)]'
                }`}
              >
                <Avatar
                  src={conv.avatar_url}
                  name={conv.name}
                  size="md"
                  isOnline={conv.type === 'direct' && Boolean(conv.other_user?.is_online)}
                  showOnlineRing={conv.type === 'direct'}
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-display font-semibold text-sm truncate flex items-center gap-1.5">
                      <span className="truncate">{conv.name}</span>
                      {conv.is_muted && (
                        <BellOff className="w-3 h-3 text-[var(--htv-text-dim)] shrink-0" />
                      )}
                    </span>
                    {conv.unread_count > 0 && !conv.is_muted && (
                      <span className="px-1.5 py-0.5 rounded-full bg-orange-500 text-white text-[10px] font-mono-tabular font-bold">
                        {conv.unread_count}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 text-xs text-[var(--htv-text-dim)] truncate">
                    {conv.type === 'group' && (
                      <span className="font-mono-tabular text-purple-600 dark:text-purple-300 shrink-0">
                        {conv.member_count}/{MAX_GROUP_MEMBERS}
                      </span>
                    )}
                    <span className="truncate">
                      {conv.last_message
                        ? conv.last_message.is_unsent
                          ? 'Message unsent'
                          : conv.last_message.content || `Sent ${conv.last_message.media_type}`
                        : 'No messages yet'}
                    </span>
                  </div>
                </div>
              </button>
            ))
          )}
        </div>
      </aside>

      {/* Right Active Conversation */}
      <section
        className={`md:col-span-8 flex flex-col min-h-0 ${
          activeConvId ? 'flex' : 'hidden md:flex'
        }`}
      >
        {!activeConv ? (
          <div className="flex-1 flex flex-col items-center justify-center p-8 text-center space-y-2">
            <Users className="w-10 h-10 text-purple-500/70" />
            <h3 className="font-display font-semibold text-base">Select a conversation</h3>
            <p className="text-xs text-[var(--htv-text-muted)] max-w-sm">
              Direct chats support text & gallery photos. Group chats support text, gallery photos,
              voice notes, and videos.
            </p>
          </div>
        ) : (
          <>
            {/* Conversation Header */}
            <header className="px-3 py-2 border-b border-[var(--htv-border-subtle)] flex items-center justify-between gap-2 flex-wrap">
              <div className="flex items-center gap-2.5 min-w-0">
                <button
                  type="button"
                  onClick={() => setActiveConvId(null)}
                  className="md:hidden p-2 -ml-2 rounded-lg text-[var(--htv-text-muted)] hover:text-[var(--htv-text)] cursor-pointer"
                  aria-label="Back to inbox"
                >
                  <ArrowLeft className="w-4 h-4" />
                </button>
                <Avatar
                  src={activeConv.avatar_url}
                  name={activeConv.name}
                  size="sm"
                  isOnline={activeConv.type === 'direct' && Boolean(activeConv.other_user?.is_online)}
                  showOnlineRing={activeConv.type === 'direct'}
                />
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <h3 className="font-display font-semibold text-sm truncate">
                      {activeConv.name}
                    </h3>
                    {activeConv.type === 'direct' && (
                      <VerifiedBadge verified={activeConv.other_user?.is_verified} />
                    )}
                  </div>
                  <p className="text-xs text-[var(--htv-text-dim)] font-mono-tabular">
                    {activeConv.type === 'group'
                      ? `${activeConv.member_count}/${MAX_GROUP_MEMBERS} members`
                      : activeConv.other_user?.is_online
                      ? 'Online now'
                      : 'Offline'}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-1.5 flex-wrap">
                {/* Mute conversation notifications button (for repeated SMS) */}
                <button
                  type="button"
                  onClick={handleToggleConversationMute}
                  title={
                    activeConv.is_muted
                      ? 'Unmute notifications from this chat'
                      : 'Mute repeated SMS notifications'
                  }
                  className={`px-2.5 py-1.5 rounded-lg text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer ${
                    activeConv.is_muted
                      ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
                      : 'htv-elevated hover:bg-[var(--htv-hover)] text-[var(--htv-text-muted)]'
                  }`}
                >
                  {activeConv.is_muted ? (
                    <>
                      <BellOff className="w-3.5 h-3.5" />
                      Muted
                    </>
                  ) : (
                    <>
                      <Bell className="w-3.5 h-3.5" />
                      Mute
                    </>
                  )}
                </button>

                {activeConv.type === 'group' && (
                  <>
                    <button
                      type="button"
                      onClick={handleCopyGroupInvite}
                      title="Copy Group Invite Link"
                      className="px-2.5 py-1.5 rounded-lg htv-elevated hover:bg-[var(--htv-hover)] text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
                    >
                      {copiedGroupLink ? (
                        <Check className="w-3.5 h-3.5 text-emerald-500" />
                      ) : (
                        <Link2 className="w-3.5 h-3.5 text-purple-600 dark:text-purple-300" />
                      )}
                      {copiedGroupLink ? 'Copied' : 'Link'}
                    </button>

                    <button
                      type="button"
                      onClick={() => {
                        setManageModalTab('members');
                        setManageModalOpen(true);
                      }}
                      className="px-3 py-1.5 rounded-lg htv-elevated hover:bg-[var(--htv-hover)] text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
                    >
                      <Users className="w-3.5 h-3.5 text-purple-600 dark:text-purple-400" />
                      Members ({activeConv.member_count})
                      {isGroupAdmin && pendingRequestsCount > 0 && (
                        <span className="px-1.5 py-0.2 rounded-full bg-orange-500 text-white text-[10px] font-mono-tabular">
                          {pendingRequestsCount}
                        </span>
                      )}
                    </button>

                    <button
                      type="button"
                      onClick={() => {
                        setManageModalTab('settings');
                        setManageModalOpen(true);
                      }}
                      title="Group settings & report"
                      className="p-2 rounded-lg htv-elevated hover:bg-[var(--htv-hover)] text-amber-600 dark:text-amber-300 cursor-pointer"
                      aria-label="Report group or open settings"
                    >
                      <Flag className="w-3.5 h-3.5" />
                    </button>
                  </>
                )}
              </div>
            </header>

            {/* Pending Message Request Banner */}
            {activeConv.status === 'pending_request' && activeConv.requester_id !== currentUser.id && (
              <div className="px-4 py-3 bg-purple-500/10 border-b border-purple-500/25 flex items-center justify-between gap-3 flex-wrap">
                <p className="text-xs text-[var(--htv-text)]">
                  Message request from <strong>{activeConv.name}</strong>. Accept to move to Inbox.
                </p>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => handleRespondRequest(activeConv.id, 'accept')}
                    className="htv-gradient-btn px-3 py-1.5 rounded-lg text-xs font-semibold inline-flex items-center gap-1 cursor-pointer"
                  >
                    <Check className="w-3.5 h-3.5" />
                    Accept
                  </button>
                  <button
                    type="button"
                    onClick={() => handleRespondRequest(activeConv.id, 'reject')}
                    className="px-3 py-1.5 rounded-lg bg-rose-600/20 text-rose-600 dark:text-rose-300 border border-rose-500/30 text-xs font-semibold cursor-pointer"
                  >
                    Reject
                  </button>
                </div>
              </div>
            )}

            {/* Messages Area — Compact, clean spacing & Long-Press for reactions/actions */}
            <div
              className="flex-1 overflow-y-auto px-2.5 py-2 sm:px-3.5 sm:py-2.5 space-y-1.5"
              onClick={() => {
                if (contextMenuMsgId !== null) setContextMenuMsgId(null);
              }}
            >
              {loadingMsgs ? (
                <div className="space-y-3 py-3" aria-label="Loading messages">
                  {[
                    { mine: false, w: 'w-48' },
                    { mine: true, w: 'w-56' },
                    { mine: false, w: 'w-64' },
                    { mine: true, w: 'w-40' },
                    { mine: false, w: 'w-52' },
                  ].map((item, idx) => (
                    <div
                      key={idx}
                      className={`flex items-end gap-2 animate-pulse ${
                        item.mine ? 'justify-end' : 'justify-start'
                      }`}
                    >
                      {!item.mine && <div className="w-6 h-6 rounded-full htv-elevated shrink-0" />}
                      <div className={`h-10 ${item.w} rounded-2xl htv-elevated`} />
                    </div>
                  ))}
                </div>
              ) : messages.length === 0 ? (
                <p className="text-xs text-[var(--htv-text-dim)] text-center py-6">
                  {activeConv.type === 'group'
                    ? 'Start the group chat with text, gallery photos, voice notes, or videos. Press and hold any message or video for reactions & options.'
                    : 'Start the conversation with text or gallery photos. Press and hold any message for reactions & options.'}
                </p>
              ) : (
                messages.map((msg, idx) => {
                  const isMine = msg.sender_id === currentUser.id;
                  const isLastMine =
                    isMine &&
                    idx === messages.map((m) => m.sender_id).lastIndexOf(currentUser.id);
                  const isPressing = pressingMsgId === msg.id;
                  const isVisualMediaOnly =
                    !msg.is_unsent &&
                    !msg.content &&
                    !msg.reply_preview &&
                    !msg.is_forwarded &&
                    (msg.media_type === 'image' || msg.media_type === 'video');

                  return (
                    <div
                      key={msg.id}
                      className={`flex flex-col ${isMine ? 'items-end' : 'items-start'} gap-0.5`}
                    >
                      <div
                        className={`flex items-end gap-1.5 max-w-[88%] sm:max-w-[78%] ${
                          isMine ? 'flex-row-reverse' : 'flex-row'
                        }`}
                      >
                        {!isMine && (
                          <div className="shrink-0 mb-0.5">
                            <Avatar src={msg.sender_avatar} name={msg.sender_name} size="xs" />
                          </div>
                        )}

                        <div
                          onPointerDown={(e) => {
                            if (msg.is_unsent) return;
                            startLongPress(msg.id, e.clientX, e.clientY);
                          }}
                          onPointerMove={(e) => handlePointerMovePress(e.clientX, e.clientY)}
                          onPointerUp={clearLongPress}
                          onPointerCancel={clearLongPress}
                          onPointerLeave={clearLongPress}
                          onContextMenu={(e) => {
                            if (!msg.is_unsent) {
                              e.preventDefault();
                              setContextMenuMsgId(msg.id);
                            }
                          }}
                          title={!msg.is_unsent ? 'Press & hold for reactions and actions' : undefined}
                          style={
                            msg.is_unsent
                              ? undefined
                              : isMine
                              ? {
                                  background: 'var(--htv-bubble-mine-bg)',
                                  color: 'var(--htv-bubble-mine-text)',
                                  WebkitTouchCallout: 'none',
                                }
                              : {
                                  backgroundColor: 'var(--htv-bubble-other-bg)',
                                  color: 'var(--htv-bubble-other-text)',
                                  WebkitTouchCallout: 'none',
                                }
                          }
                          className={`relative max-w-full overflow-hidden rounded-2xl transition-transform duration-150 select-none touch-pan-y ${
                            isVisualMediaOnly
                              ? 'p-1.5 space-y-1'
                              : msg.reply_preview
                              ? 'px-2.5 py-1.5 space-y-0.5'
                              : 'px-3 py-1.5 space-y-1'
                          } ${isPressing ? 'scale-[0.97]' : ''} ${
                            msg.is_unsent
                              ? 'htv-elevated text-[var(--htv-text-dim)] italic text-xs'
                              : !isMine
                              ? 'border border-[var(--htv-border-subtle)]'
                              : 'shadow-sm'
                          }`}
                        >
                          {msg.is_forwarded && !msg.is_unsent && (
                            <p
                              style={{
                                color: isMine
                                  ? 'var(--htv-bubble-mine-muted)'
                                  : 'var(--htv-bubble-other-muted)',
                              }}
                              className="text-[10px] font-semibold inline-flex items-center gap-1 leading-tight"
                            >
                              <Forward className="w-2.5 h-2.5 shrink-0" />
                              <span className="truncate">
                                Forwarded
                                {msg.forwarded_from_name ? ` from ${msg.forwarded_from_name}` : ''}
                              </span>
                            </p>
                          )}

                          {!isMine && activeConv.type === 'group' && !msg.is_unsent && msg.media_type !== 'video' && (
                            <p className="text-[11px] font-semibold text-purple-600 dark:text-purple-300 leading-tight">
                              {msg.sender_name}
                            </p>
                          )}

                          {msg.reply_preview && !msg.is_unsent && (
                            <div
                              style={{
                                borderLeft: isMine
                                  ? '2px solid rgba(255, 255, 255, 0.55)'
                                  : '2px solid var(--htv-accent-primary)',
                                color: isMine
                                  ? 'var(--htv-bubble-mine-text)'
                                  : 'var(--htv-bubble-other-text)',
                              }}
                              className="pl-2 py-0.5 space-y-0 min-w-0"
                            >
                              <p
                                style={{
                                  color: isMine
                                    ? 'var(--htv-bubble-mine-muted)'
                                    : 'var(--htv-bubble-other-muted)',
                                }}
                                className="text-[11px] font-medium leading-tight inline-flex items-center gap-1 max-w-full truncate"
                              >
                                <Reply className="w-2.5 h-2.5 shrink-0" />
                                <span className="truncate">
                                  Reply to {msg.reply_preview.sender_name}
                                </span>
                              </p>
                              <p className="text-[11px] leading-tight opacity-85 truncate max-w-[230px] sm:max-w-[280px]">
                                {msg.reply_preview.is_unsent
                                  ? 'Message unsent'
                                  : msg.reply_preview.content ||
                                    (msg.reply_preview.media_type === 'video'
                                      ? 'Video'
                                      : msg.reply_preview.media_type === 'audio'
                                      ? 'Audio note'
                                      : msg.reply_preview.media_type === 'image'
                                      ? 'Photo'
                                      : `[${msg.reply_preview.media_type}]`)}
                              </p>
                            </div>
                          )}

                          {msg.content && (
                            <p className="text-[13.5px] sm:text-sm leading-snug whitespace-pre-wrap break-words select-text">
                              {msg.content}
                            </p>
                          )}

                          {msg.media_type === 'image' && msg.media_url && (
                            <div className="w-full max-w-[240px] sm:max-w-[260px] rounded-xl overflow-hidden bg-black/15 border border-black/10 dark:border-white/10">
                              <img
                                src={msg.media_url}
                                alt="Chat gallery attachment"
                                referrerPolicy="no-referrer"
                                draggable={false}
                                className="w-full max-h-56 object-cover block select-none"
                              />
                            </div>
                          )}

                          {msg.media_type === 'audio' && msg.media_url && (
                            <div className="w-full max-w-[240px] rounded-xl py-0.5">
                              <audio src={msg.media_url} controls className="w-full h-8" />
                            </div>
                          )}

                          {msg.media_type === 'video' && msg.media_url && (
                            <GroupVideoBubbleCard
                              message={msg}
                              shouldIgnoreClick={shouldIgnoreMediaClick}
                              onOpen={(selectedMsg, preferredQuality) => {
                                setPlayingVideoQuality(preferredQuality || 'original');
                                setPlayingVideoMsg(selectedMsg);
                              }}
                            />
                          )}

                          {/* Compact Timestamp + Size + Read status metadata */}
                          {!msg.is_unsent && (
                            <div
                              style={{
                                color: isMine
                                  ? 'var(--htv-bubble-mine-muted)'
                                  : 'var(--htv-bubble-other-muted)',
                              }}
                              className={`flex items-center gap-1 text-[10px] leading-none pt-0.5 ${
                                isVisualMediaOnly ? 'px-1 pb-0.5' : ''
                              } ${isMine ? 'justify-end' : 'justify-start'}`}
                            >
                              <span>{formatMessageTimestamp(msg.created_at)}</span>
                              {msg.media_size_bytes ? (
                                <>
                                  <span aria-hidden="true">·</span>
                                  <span className="font-mono-tabular">
                                    {formatFileSize(msg.media_size_bytes)}
                                  </span>
                                </>
                              ) : null}
                              {isMine && (
                                msg.seen_by_count > 0 ? (
                                  <CheckCheck className="w-3 h-3 text-sky-300 shrink-0" aria-label="Seen" />
                                ) : (
                                  <Check className="w-3 h-3 opacity-75 shrink-0" aria-label="Sent" />
                                )
                              )}
                            </div>
                          )}
                        </div>
                      </div>

                      {/* Compact Reactions Badge Strip (only shown if message has reactions) */}
                      {msg.reactions.length > 0 && !msg.is_unsent && (
                        <div
                          className={`flex items-center gap-1 flex-wrap ${
                            isMine ? 'justify-end pr-1' : 'justify-start pl-7'
                          }`}
                        >
                          {msg.reactions.map((rx) => (
                            <button
                              key={rx.emoji}
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleReaction(msg.id, rx.emoji);
                              }}
                              className={`px-1.5 py-0.5 rounded-full text-[11px] leading-none inline-flex items-center gap-0.5 cursor-pointer transition-colors ${
                                rx.user_reacted
                                  ? 'bg-purple-600/20 text-[var(--htv-text)] ring-1 ring-purple-500/50'
                                  : 'htv-card text-[var(--htv-text-muted)] hover:text-[var(--htv-text)]'
                              }`}
                            >
                              <span>{rx.emoji}</span>
                              <span className="font-mono-tabular text-[10px]">{rx.count}</span>
                            </button>
                          ))}
                        </div>
                      )}

                      {isLastMine && !msg.is_unsent && (
                        <span
                          className={`text-[10px] inline-flex items-center gap-1 pr-1 leading-none ${
                            msg.seen_by_count > 0
                              ? 'text-purple-500 dark:text-purple-300 font-medium'
                              : 'text-[var(--htv-text-dim)]'
                          }`}
                        >
                          {msg.seen_by_count > 0 ? (
                            <>
                              <CheckCheck className="w-3 h-3 text-purple-500 dark:text-purple-300" />
                              {activeConv.type === 'group' && msg.seen_by_count > 1
                                ? `Seen by ${msg.seen_by_count}`
                                : 'Seen'}
                            </>
                          ) : (
                            <>
                              <Check className="w-3 h-3" />
                              Sent
                            </>
                          )}
                        </span>
                      )}
                    </div>
                  );
                })
              )}

              {typingUser && (
                <p className="text-xs text-purple-600 dark:text-purple-300 italic">
                  {typingUser} is typing...
                </p>
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Composer or Muted Notice */}
            {activeConv.viewer_chat_muted ? (
              <div className="p-3 border-t border-[var(--htv-border-subtle)] bg-rose-500/10 text-xs text-rose-600 dark:text-rose-300 text-center font-medium">
                You are muted from sending messages in this group by an admin due to repeated messages.
              </div>
            ) : (
              <form
                onSubmit={handleSend}
                className="px-3 py-2 border-t border-[var(--htv-border-subtle)] space-y-2"
              >
                {replyTo && (
                  <div className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg htv-elevated text-xs">
                    <span className="truncate">
                      Replying to <strong>{replyTo.sender_name}</strong>:{' '}
                      {replyTo.content || `[${replyTo.media_type}]`}
                    </span>
                    <button
                      type="button"
                      onClick={() => setReplyTo(null)}
                      className="text-[var(--htv-text-dim)] hover:text-[var(--htv-text)] cursor-pointer"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )}

                {showRecorder && (
                  <VoiceRecorder
                    compact
                    onAudioReady={(url) => {
                      setMediaType('audio');
                      setMediaUrl(url);
                      setMediaSizeBytes(0);
                      setShowRecorder(false);
                    }}
                    onCancel={() => setShowRecorder(false)}
                  />
                )}

                {uploading && (
                  <div className="flex items-center gap-2 px-3 py-2 rounded-lg htv-elevated text-xs text-purple-600 dark:text-purple-300 font-medium">
                    <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
                    <span>
                      {uploadingKind === 'video'
                        ? 'Optimizing & compressing video for fast sharing...'
                        : 'Uploading media...'}
                    </span>
                  </div>
                )}

                {mediaType !== 'none' && mediaUrl && (
                  <div className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg htv-elevated text-xs">
                    <span className="text-purple-600 dark:text-purple-300 font-medium">
                      Attached {mediaType}
                      {mediaSizeBytes ? ` (${formatFileSize(mediaSizeBytes)})` : ''} ready to send
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setMediaType('none');
                        setMediaUrl('');
                        setMediaSizeBytes(0);
                      }}
                      className="text-rose-500 hover:underline cursor-pointer"
                    >
                      Remove
                    </button>
                  </div>
                )}

                {chatError && (
                  <p className="text-xs text-rose-600 dark:text-rose-300 bg-rose-500/10 border border-rose-500/25 rounded-lg px-3 py-2">
                    {chatError}
                  </p>
                )}

                <div className="flex items-center gap-1.5 flex-wrap">
                  <input
                    ref={imgRef}
                    type="file"
                    accept="image/jpeg,image/png,image/webp,image/gif"
                    className="hidden"
                    onChange={(e) => handleMediaPick(e, 'image')}
                  />
                  <input
                    ref={audRef}
                    type="file"
                    accept="audio/*"
                    className="hidden"
                    onChange={(e) => handleMediaPick(e, 'audio')}
                  />
                  <input
                    ref={vidRef}
                    type="file"
                    accept="video/mp4,video/webm,video/quicktime,video/x-m4v"
                    className="hidden"
                    onChange={(e) => handleMediaPick(e, 'video')}
                  />

                  <button
                    type="button"
                    onClick={() => imgRef.current?.click()}
                    title="Send Gallery Picture"
                    className="p-2.5 rounded-xl htv-elevated hover:bg-[var(--htv-hover)] text-purple-600 dark:text-purple-300 cursor-pointer"
                  >
                    <ImageIcon className="w-4 h-4" />
                  </button>
                  {activeConv.type === 'group' && (
                    <>
                      <button
                        type="button"
                        onClick={() => audRef.current?.click()}
                        title="Send Audio File (Group Only)"
                        className="p-2.5 rounded-xl htv-elevated hover:bg-[var(--htv-hover)] text-orange-600 dark:text-orange-300 cursor-pointer"
                      >
                        <Music className="w-4 h-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setShowRecorder((s) => !s)}
                        title="Record Live Voice Message (Group Only)"
                        className="p-2.5 rounded-xl htv-elevated hover:bg-[var(--htv-hover)] text-rose-500 dark:text-rose-400 cursor-pointer"
                      >
                        <Mic className="w-4 h-4" />
                      </button>
                      <button
                        type="button"
                        disabled={uploading}
                        onClick={() => vidRef.current?.click()}
                        title="Send Video (Group Only)"
                        className="p-2.5 rounded-xl htv-elevated hover:bg-[var(--htv-hover)] text-sky-600 dark:text-sky-400 cursor-pointer disabled:opacity-50"
                      >
                        <Video className="w-4 h-4" />
                      </button>
                    </>
                  )}

                  <input
                    type="text"
                    value={text}
                    onChange={(e) => {
                      setText(e.target.value);
                      emitTyping(e.target.value);
                      if (chatError) setChatError('');
                    }}
                    placeholder="Write message (max 200 words, no links)..."
                    className="flex-1 min-w-[160px] h-10 px-3.5 rounded-xl htv-elevated text-sm text-[var(--htv-text)] placeholder:text-[var(--htv-text-dim)] focus:outline-none focus:ring-2 focus:ring-purple-500/50"
                  />

                  <span
                    className={`text-[11px] font-mono-tabular px-1 ${
                      wordCount > MAX_WORDS ? 'text-rose-500' : 'text-[var(--htv-text-dim)]'
                    }`}
                  >
                    {wordCount}/{MAX_WORDS}
                  </span>

                  <button
                    type="submit"
                    disabled={uploading}
                    className="htv-gradient-btn h-10 px-4 rounded-xl text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                  >
                    <Send className="w-3.5 h-3.5" />
                    {uploading ? '...' : 'Send'}
                  </button>
                </div>
              </form>
            )}
          </>
        )}
      </section>

      {/* Interactive Video Player (144p-Original Quality / Full-Screen / Small / Scrubbing / Actions) */}
      <GroupVideoPlayerModal
        message={playingVideoMsg}
        initialQuality={playingVideoQuality}
        canDelete={Boolean(
          playingVideoMsg &&
            (playingVideoMsg.sender_id === currentUser.id ||
              currentUser.role === 'admin' ||
              isGroupAdmin)
        )}
        onClose={() => setPlayingVideoMsg(null)}
        onReact={handleReaction}
        onForward={(m) => {
          setPlayingVideoMsg(null);
          setForwardTargetMsg(m);
        }}
        onDelete={handleUnsend}
      />

      {/* Facebook-style Forward Message Modal */}
      <ForwardMessageModal
        message={forwardTargetMsg}
        conversations={[...inbox, ...requests]}
        currentUserId={currentUser.id}
        onClose={() => setForwardTargetMsg(null)}
        onForwarded={() => {
          loadConversations();
          onConversationsChanged();
        }}
      />

      {/* Dedicated Popup Modal for Group Members, Add/Remove, Requests, Link & Report */}
      {activeConv && activeConv.type === 'group' && (
        <GroupManageModal
          open={manageModalOpen}
          initialTab={manageModalTab}
          group={activeConv}
          currentUser={currentUser}
          onClose={() => setManageModalOpen(false)}
          onGroupUpdated={() => {
            loadConversations();
            onConversationsChanged();
          }}
          onLeftGroup={() => {
            setActiveConvId(null);
            loadConversations();
            onConversationsChanged();
          }}
        />
      )}

      {/* Join Group Preview Modal (when pasting invite link) */}
      <GroupInviteJoinModal
        inviteCode={previewInviteCode}
        onClose={() => setPreviewInviteCode(null)}
        onJoinedConversation={(convId) => {
          loadConversations();
          setFolder('inbox');
          setActiveConvId(convId);
        }}
        onOpenAdminProfile={(creatorId) => onOpenProfile?.(creatorId)}
      />

      {/* Create Group Modal */}
      {showCreateGroup && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
          <form
            onSubmit={handleCreateGroup}
            className="htv-card rounded-2xl p-6 max-w-md w-full space-y-4 shadow-2xl max-h-[90vh] overflow-y-auto"
          >
            <div className="flex items-center justify-between">
              <h3 className="font-display font-bold text-base">
                Create Group Chat (Max {MAX_GROUP_MEMBERS} Members)
              </h3>
              <button
                type="button"
                onClick={() => setShowCreateGroup(false)}
                className="p-1.5 rounded-lg text-[var(--htv-text-dim)] hover:text-[var(--htv-text)] cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-[var(--htv-text-muted)]">
                Group Name (No external links)
              </label>
              <input
                type="text"
                required
                value={groupName}
                onChange={(e) => setGroupName(e.target.value)}
                placeholder="e.g. Midnight Sound Collective"
                className="w-full h-10 px-3.5 rounded-xl htv-elevated text-sm text-[var(--htv-text)]"
              />
            </div>

            {/* Two Join Modes */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-[var(--htv-text-muted)]">
                How Members Join
              </label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setGroupJoinMode('direct')}
                  className={`p-2.5 rounded-xl text-left text-xs font-semibold cursor-pointer ${
                    groupJoinMode === 'direct'
                      ? 'htv-gradient-btn'
                      : 'htv-elevated text-[var(--htv-text-muted)]'
                  }`}
                >
                  Direct Add
                  <span className="block text-[11px] font-normal opacity-85">
                    Added immediately
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => setGroupJoinMode('approval')}
                  className={`p-2.5 rounded-xl text-left text-xs font-semibold cursor-pointer ${
                    groupJoinMode === 'approval'
                      ? 'htv-gradient-btn'
                      : 'htv-elevated text-[var(--htv-text-muted)]'
                  }`}
                >
                  Admin Permission
                  <span className="block text-[11px] font-normal opacity-85">
                    Needs admin approval
                  </span>
                </button>
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs text-[var(--htv-text-muted)]">
                <span>Add Eligible Followers / Friends</span>
                <span className="font-mono-tabular">
                  {groupSelectedIds.length + 1} / {MAX_GROUP_MEMBERS}
                </span>
              </div>
              <div className="max-h-48 overflow-y-auto space-y-1.5 pr-1">
                {createCandidates.map((person) => {
                  const selected = groupSelectedIds.includes(person.id);
                  return (
                    <button
                      key={person.id}
                      type="button"
                      disabled={!person.eligible}
                      onClick={() =>
                        setGroupSelectedIds((prev) =>
                          selected ? prev.filter((id) => id !== person.id) : [...prev, person.id]
                        )
                      }
                      className={`w-full flex items-center justify-between p-2 rounded-xl text-left ${
                        !person.eligible
                          ? 'opacity-50 cursor-not-allowed htv-elevated'
                          : selected
                          ? 'bg-purple-500/20 border border-purple-500/40 cursor-pointer'
                          : 'htv-elevated hover:bg-[var(--htv-hover)] cursor-pointer'
                      }`}
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <Avatar src={person.avatar_url} name={person.name} size="xs" />
                        <div className="min-w-0">
                          <span className="text-xs font-medium truncate block">{person.name}</span>
                          <span className="text-[10px] text-[var(--htv-text-dim)] block">
                            {person.eligible
                              ? person.follows_admin
                                ? 'Follows you'
                                : 'Friend'
                              : 'Must follow you or be friends'}
                          </span>
                        </div>
                      </div>
                      {selected && <Check className="w-4 h-4 text-purple-600 dark:text-purple-300" />}
                    </button>
                  );
                })}
              </div>
            </div>

            {groupCreateError && <p className="text-xs text-rose-500">{groupCreateError}</p>}

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setShowCreateGroup(false)}
                className="px-4 py-2 rounded-xl htv-elevated text-xs font-medium cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="htv-gradient-btn px-4 py-2 rounded-xl text-xs font-semibold cursor-pointer"
              >
                Create Group
              </button>
            </div>
          </form>
        </div>
      )}
      {/* Long-Press Message Reaction & Action Menu (Reply, Forward, Play Video, Delete) */}
      {(() => {
        const contextMsg =
          contextMenuMsgId !== null
            ? messages.find((m) => m.id === contextMenuMsgId && !m.is_unsent) || null
            : null;
        if (!contextMsg) return null;
        const canDeleteContextMsg =
          contextMsg.sender_id === currentUser.id ||
          currentUser.role === 'admin' ||
          Boolean(isGroupAdmin);
        const previewText = contextMsg.content
          ? contextMsg.content
          : contextMsg.media_type === 'video'
          ? 'Video message'
          : contextMsg.media_type === 'image'
          ? 'Photo message'
          : contextMsg.media_type === 'audio'
          ? 'Voice / Audio message'
          : 'Message';

        return (
          <div
            className="fixed inset-0 z-50 bg-black/50 backdrop-blur-[2px] flex items-end sm:items-center justify-center p-3 sm:p-4"
            onClick={() => setContextMenuMsgId(null)}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              className="htv-card rounded-2xl w-full max-w-sm p-3.5 space-y-3 shadow-2xl"
              role="dialog"
              aria-label="Message actions and reactions"
            >
              <div className="flex items-center justify-between gap-2 pb-2 border-b border-[var(--htv-border-subtle)]">
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-[var(--htv-text)] truncate">
                    {contextMsg.sender_name}
                  </p>
                  <p className="text-[11px] text-[var(--htv-text-muted)] truncate">
                    {previewText}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setContextMenuMsgId(null)}
                  className="p-1.5 rounded-lg text-[var(--htv-text-dim)] hover:text-[var(--htv-text)] hover:bg-[var(--htv-hover)] cursor-pointer shrink-0"
                  aria-label="Close menu"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Quick Emoji Reaction Row */}
              <div className="flex items-center justify-between gap-1 p-1 rounded-xl htv-elevated">
                {ALLOWED_REACTION_EMOJIS.map((emoji) => {
                  const active = contextMsg.reactions.some(
                    (r) => r.emoji === emoji && r.user_reacted
                  );
                  return (
                    <button
                      key={emoji}
                      type="button"
                      onClick={() => handleReaction(contextMsg.id, emoji)}
                      className={`flex-1 min-h-[40px] rounded-lg text-lg flex items-center justify-center transition-transform hover:scale-110 cursor-pointer ${
                        active
                          ? 'bg-purple-600/25 ring-1 ring-purple-500/60'
                          : 'hover:bg-[var(--htv-hover)]'
                      }`}
                    >
                      {emoji}
                    </button>
                  );
                })}
              </div>

              {/* Action Buttons (Reply, Forward, Play Video if video, Delete for sender/admin) */}
              <div className="grid grid-cols-2 gap-1.5">
                {contextMsg.media_type === 'video' && contextMsg.media_url && (
                  <button
                    type="button"
                    onClick={() => {
                      setContextMenuMsgId(null);
                      setPlayingVideoQuality('original');
                      setPlayingVideoMsg(contextMsg);
                    }}
                    className="col-span-2 px-3 py-2.5 rounded-xl htv-gradient-btn text-xs font-semibold inline-flex items-center justify-center gap-1.5 cursor-pointer"
                  >
                    <Play className="w-3.5 h-3.5 fill-current" />
                    Play Video
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => {
                    setReplyTo(contextMsg);
                    setContextMenuMsgId(null);
                  }}
                  className="px-3 py-2.5 rounded-xl htv-elevated hover:bg-[var(--htv-hover)] text-xs font-semibold text-[var(--htv-text)] inline-flex items-center justify-center gap-1.5 cursor-pointer"
                >
                  <Reply className="w-3.5 h-3.5 text-purple-500" />
                  Reply
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setForwardTargetMsg(contextMsg);
                    setContextMenuMsgId(null);
                  }}
                  className="px-3 py-2.5 rounded-xl htv-elevated hover:bg-[var(--htv-hover)] text-xs font-semibold text-[var(--htv-text)] inline-flex items-center justify-center gap-1.5 cursor-pointer"
                >
                  <Forward className="w-3.5 h-3.5 text-orange-500" />
                  Forward
                </button>

                {canDeleteContextMsg && (
                  <button
                    type="button"
                    onClick={() => handleUnsend(contextMsg.id)}
                    className="col-span-2 px-3 py-2.5 rounded-xl bg-rose-500/15 hover:bg-rose-500/25 border border-rose-500/30 text-xs font-semibold text-rose-600 dark:text-rose-300 inline-flex items-center justify-center gap-1.5 cursor-pointer"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    Delete Message
                  </button>
                )}
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
};
