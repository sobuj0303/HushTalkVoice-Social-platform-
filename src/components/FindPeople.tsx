import React, { useEffect, useState } from 'react';
import { Search, UserPlus, UserCheck, MessageSquare, Check, Clock, Users } from 'lucide-react';
import { Avatar, VerifiedBadge } from './Avatar';
import { apiFetch } from '../lib/api';
import { cachedApiFetch, invalidateApiCache } from '../lib/cache';
import type { PersonDirectoryItem } from '../shared/types';

interface FindPeopleProps {
  currentUserId?: number;
  onStartChat: (userId: number) => void;
  onOpenProfile: (userId: number) => void;
}

export const FindPeople: React.FC<FindPeopleProps> = ({
  currentUserId,
  onStartChat,
  onOpenProfile,
}) => {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'online' | 'popular'>('all');
  const [people, setPeople] = useState<PersonDirectoryItem[]>([]);
  const [loading, setLoading] = useState(true);

  const loadPeople = async (searchQuery: string, activeFilter: string) => {
    setLoading(true);
    try {
      const path = `/api/people?q=${encodeURIComponent(searchQuery)}&filter=${activeFilter}`;
      const data =
        !searchQuery.trim() && currentUserId
          ? await cachedApiFetch<{ people: PersonDirectoryItem[] }>(path, {
              userId: currentUserId,
              ttlMs: 30_000,
              onRevalidated: (fresh) => setPeople(fresh.people),
            })
          : await apiFetch<{ people: PersonDirectoryItem[] }>(path);
      setPeople(data.people);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const timer = window.setTimeout(() => {
      loadPeople(query, filter);
    }, 180);
    return () => window.clearTimeout(timer);
  }, [query, filter]);

  const handleFollowToggle = async (personId: number) => {
    try {
      const res = await apiFetch<{ following: boolean }>(`/api/users/${personId}/follow`, {
        method: 'POST',
      });
      if (currentUserId) {
        invalidateApiCache(currentUserId, '/api/people');
        invalidateApiCache(currentUserId, '/api/posts');
      }
      setPeople((prev) =>
        prev.map((p) =>
          p.id === personId
            ? {
                ...p,
                is_following: res.following,
                followers_count: p.followers_count + (res.following ? 1 : -1),
              }
            : p
        )
      );
    } catch {
      // ignore
    }
  };

  const handleConnect = async (person: PersonDirectoryItem) => {
    try {
      if (person.connection_status === 'pending_received' && person.connection_id) {
        await apiFetch(`/api/connections/${person.connection_id}/respond`, {
          method: 'POST',
          body: JSON.stringify({ action: 'accept' }),
        });
        if (currentUserId) {
          invalidateApiCache(currentUserId, '/api/people');
          invalidateApiCache(currentUserId, '/api/posts');
        }
        setPeople((prev) =>
          prev.map((p) => (p.id === person.id ? { ...p, connection_status: 'accepted' } : p))
        );
      } else if (person.connection_status === 'none') {
        const res = await apiFetch<{ status: string; id: number }>('/api/connections/request', {
          method: 'POST',
          body: JSON.stringify({ userId: person.id }),
        });
        if (currentUserId) {
          invalidateApiCache(currentUserId, '/api/people');
        }
        setPeople((prev) =>
          prev.map((p) =>
            p.id === person.id
              ? { ...p, connection_status: 'pending_sent', connection_id: res.id }
              : p
          )
        );
      }
    } catch {
      // ignore
    }
  };

  return (
    <div className="space-y-5">
      <div className="htv-card rounded-2xl p-4 sm:p-5 space-y-4">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h2 className="font-display text-lg font-bold">Find People</h2>
            <p className="text-xs text-[var(--htv-text-muted)]">
              Discover creators, follow voices, send connection requests, or jump straight into chat.
            </p>
          </div>
          <div className="flex items-center gap-1 p-1 rounded-xl htv-elevated">
            {(
              [
                { id: 'all', label: 'All' },
                { id: 'online', label: 'Online' },
                { id: 'popular', label: 'Popular' },
              ] as const
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setFilter(tab.id)}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap cursor-pointer ${
                  filter === tab.id
                    ? 'htv-gradient-btn'
                    : 'text-[var(--htv-text-muted)] hover:text-[var(--htv-text)]'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        <div className="relative">
          <Search className="w-4 h-4 text-[var(--htv-text-dim)] absolute left-3.5 top-1/2 -translate-y-1/2" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by full name or @username..."
            className="w-full h-11 pl-10 pr-4 rounded-xl htv-elevated text-sm text-[var(--htv-text)] placeholder:text-[var(--htv-text-dim)] focus:outline-none focus:ring-2 focus:ring-purple-500/50"
          />
        </div>
      </div>

      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {[1, 2, 3, 4].map((n) => (
            <div key={n} className="htv-card rounded-2xl p-4 animate-pulse h-40" />
          ))}
        </div>
      ) : people.length === 0 ? (
        <div className="htv-card rounded-2xl p-8 text-center space-y-2">
          <Users className="w-8 h-8 text-[var(--htv-text-dim)] mx-auto" />
          <p className="font-display font-semibold text-sm">No matching members found</p>
          <p className="text-xs text-[var(--htv-text-muted)]">
            Try clearing your search or switching to the All filter.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {people.map((person) => (
            <div
              key={person.id}
              className="htv-card rounded-2xl p-4 flex flex-col justify-between gap-4"
            >
              <div className="space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <button
                    type="button"
                    onClick={() => onOpenProfile(person.id)}
                    className="flex items-center gap-3 text-left min-w-0 cursor-pointer group"
                  >
                    <Avatar
                      src={person.avatar_url}
                      name={person.name}
                      size="md"
                      isOnline={person.is_online}
                      showOnlineRing
                    />
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="font-display font-semibold text-sm truncate group-hover:text-purple-600 dark:group-hover:text-purple-300">
                          {person.name}
                        </span>
                        <VerifiedBadge verified={person.is_verified} />
                      </div>
                      <div className="flex items-center gap-1.5 text-xs text-[var(--htv-text-dim)]">
                        <span className="truncate">@{person.username}</span>
                        <span aria-hidden="true">·</span>
                        <span className={person.is_online ? 'text-emerald-600 dark:text-emerald-400' : 'text-[var(--htv-text-dim)]'}>
                          {person.is_online ? 'Online' : 'Offline'}
                        </span>
                      </div>
                    </div>
                  </button>
                  <span className="text-xs text-[var(--htv-text-muted)] font-mono-tabular whitespace-nowrap">
                    {person.followers_count} followers
                  </span>
                </div>

                <p className="text-xs text-[var(--htv-text-muted)] line-clamp-2 leading-relaxed">
                  {person.bio || 'Member on HushTalkVoice'}
                </p>
              </div>

              <div className="flex items-center gap-2 pt-2 border-t border-[var(--htv-border-subtle)]">
                <button
                  type="button"
                  onClick={() => handleFollowToggle(person.id)}
                  className={`flex-1 h-9 px-3 rounded-lg text-xs font-semibold inline-flex items-center justify-center gap-1.5 whitespace-nowrap cursor-pointer transition-colors ${
                    person.is_following
                      ? 'htv-elevated text-purple-700 dark:text-purple-300 border border-purple-500/30'
                      : 'htv-gradient-btn'
                  }`}
                >
                  {person.is_following ? (
                    <>
                      <UserCheck className="w-3.5 h-3.5" />
                      Following
                    </>
                  ) : (
                    <>
                      <UserPlus className="w-3.5 h-3.5" />
                      Follow
                    </>
                  )}
                </button>

                <button
                  type="button"
                  disabled={
                    person.connection_status === 'pending_sent' ||
                    person.connection_status === 'accepted'
                  }
                  onClick={() => handleConnect(person)}
                  className="flex-1 h-9 px-3 rounded-lg htv-elevated hover:bg-[var(--htv-hover)] text-xs font-semibold text-[var(--htv-text)] inline-flex items-center justify-center gap-1.5 whitespace-nowrap cursor-pointer disabled:opacity-70"
                >
                  {person.connection_status === 'accepted' ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-emerald-400" />
                      Connected
                    </>
                  ) : person.connection_status === 'pending_sent' ? (
                    <>
                      <Clock className="w-3.5 h-3.5 text-amber-400" />
                      Pending
                    </>
                  ) : person.connection_status === 'pending_received' ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-purple-400" />
                      Accept
                    </>
                  ) : (
                    <>Connect</>
                  )}
                </button>

                <button
                  type="button"
                  onClick={() => onStartChat(person.id)}
                  aria-label={`Chat with ${person.name}`}
                  className="h-9 px-3 rounded-lg htv-elevated hover:bg-[var(--htv-hover)] text-xs font-semibold text-orange-600 dark:text-orange-300 inline-flex items-center justify-center gap-1.5 whitespace-nowrap cursor-pointer"
                >
                  <MessageSquare className="w-3.5 h-3.5" />
                  Chat
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
