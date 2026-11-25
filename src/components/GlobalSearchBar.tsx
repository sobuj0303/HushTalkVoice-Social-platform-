import React, { useEffect, useRef, useState } from 'react';
import { CircleDot, FileText, Globe, Loader2, Lock, Search, Users, X } from 'lucide-react';
import { Avatar, VerifiedBadge } from './Avatar';
import { apiFetch } from '../lib/api';
import { sanitizePlainText } from '../shared/validation';
import type { GlobalSearchResults } from '../shared/types';

interface GlobalSearchBarProps {
  onSelectPerson: (userId: number) => void;
  onSelectPost: (postId: number) => void;
  onSelectCircle: (circleId: number) => void;
}

const EMPTY_RESULTS: GlobalSearchResults = { people: [], posts: [], circles: [] };

export const GlobalSearchBar: React.FC<GlobalSearchBarProps> = ({
  onSelectPerson,
  onSelectPost,
  onSelectCircle,
}) => {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<GlobalSearchResults>(EMPTY_RESULTS);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');

  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handlePointerDown = (e: PointerEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  useEffect(() => {
    const clean = sanitizePlainText(query, 80);
    if (clean.length < 2) {
      setResults(EMPTY_RESULTS);
      setLoading(false);
      setError('');
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    setError('');

    const timer = window.setTimeout(async () => {
      try {
        const data = await apiFetch<GlobalSearchResults>(
          `/api/search?q=${encodeURIComponent(clean)}`,
          { signal: controller.signal }
        );
        setResults({
          people: Array.isArray(data.people) ? data.people : [],
          posts: Array.isArray(data.posts) ? data.posts : [],
          circles: Array.isArray(data.circles) ? data.circles : [],
        });
        setOpen(true);
      } catch (err: any) {
        if (err?.name === 'AbortError') return;
        setError('Search unavailable right now.');
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    }, 300);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  const trimmed = sanitizePlainText(query, 80);
  const totalMatches =
    results.people.length + results.posts.length + results.circles.length;

  const clearAndClose = () => {
    setQuery('');
    setResults(EMPTY_RESULTS);
    setOpen(false);
  };

  return (
    <div ref={containerRef} className="relative w-full max-w-md min-w-0">
      <div className="relative flex items-center">
        <Search className="w-4 h-4 text-[var(--htv-text-dim)] absolute left-3 pointer-events-none" />
        <input
          type="search"
          value={query}
          onFocus={() => {
            if (trimmed.length >= 2) setOpen(true);
          }}
          onChange={(e) => {
            setQuery(e.target.value);
            if (e.target.value.trim().length >= 2) setOpen(true);
          }}
          placeholder="Search posts, people, circles..."
          aria-label="Global search"
          className="w-full h-9 pl-9 pr-8 rounded-xl bg-[var(--htv-input)] border border-[var(--htv-border-subtle)] text-xs sm:text-sm text-[var(--htv-text)] placeholder:text-[var(--htv-text-dim)] focus:outline-none focus:ring-2 focus:ring-purple-500/45"
        />
        {loading ? (
          <Loader2 className="w-3.5 h-3.5 text-purple-400 animate-spin absolute right-2.5 pointer-events-none" />
        ) : query ? (
          <button
            type="button"
            onClick={clearAndClose}
            aria-label="Clear search"
            className="absolute right-2 p-0.5 rounded text-[var(--htv-text-dim)] hover:text-[var(--htv-text)] cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        ) : null}
      </div>

      {open && trimmed.length >= 2 && (
        <div className="absolute left-0 right-0 mt-2 rounded-2xl htv-card border border-[var(--htv-border)] shadow-2xl overflow-hidden z-50 max-h-[70vh] overflow-y-auto">
          {loading ? (
            <div className="p-3 space-y-2.5">
              {[1, 2, 3].map((n) => (
                <div key={n} className="flex items-center gap-2.5 animate-pulse">
                  <div className="w-8 h-8 rounded-full htv-elevated shrink-0" />
                  <div className="flex-1 space-y-1.5">
                    <div className="h-3 w-32 rounded htv-elevated" />
                    <div className="h-2.5 w-48 rounded htv-elevated" />
                  </div>
                </div>
              ))}
            </div>
          ) : error ? (
            <p className="p-4 text-xs text-rose-500 text-center">{error}</p>
          ) : totalMatches === 0 ? (
            <p className="p-4 text-xs text-[var(--htv-text-dim)] text-center">
              No posts, people, or circles matched &ldquo;{trimmed}&rdquo;.
            </p>
          ) : (
            <div className="divide-y divide-[var(--htv-border-subtle)]">
              {results.people.length > 0 && (
                <div className="p-2 space-y-1">
                  <p className="px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-[var(--htv-text-dim)] flex items-center gap-1.5">
                    <Users className="w-3 h-3 text-purple-400" />
                    People
                  </p>
                  {results.people.map((person) => (
                    <button
                      key={`p-${person.id}`}
                      type="button"
                      onClick={() => {
                        onSelectPerson(person.id);
                        setOpen(false);
                      }}
                      className="w-full px-2.5 py-2 rounded-xl hover:bg-[var(--htv-hover)] flex items-center gap-2.5 text-left cursor-pointer"
                    >
                      <Avatar src={person.avatar_url} name={person.name} size="sm" />
                      <div className="min-w-0">
                        <div className="flex items-center gap-1">
                          <span className="text-xs font-semibold truncate">{person.name}</span>
                          <VerifiedBadge verified={person.is_verified} />
                        </div>
                        <p className="text-[11px] text-[var(--htv-text-dim)] truncate">
                          @{person.username}
                        </p>
                      </div>
                    </button>
                  ))}
                </div>
              )}

              {results.posts.length > 0 && (
                <div className="p-2 space-y-1">
                  <p className="px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-[var(--htv-text-dim)] flex items-center gap-1.5">
                    <FileText className="w-3 h-3 text-orange-400" />
                    Posts
                  </p>
                  {results.posts.map((post) => (
                    <button
                      key={`post-${post.id}`}
                      type="button"
                      onClick={() => {
                        onSelectPost(post.id);
                        setOpen(false);
                      }}
                      className="w-full px-2.5 py-2 rounded-xl hover:bg-[var(--htv-hover)] flex items-start gap-2.5 text-left cursor-pointer"
                    >
                      <Avatar src={post.author_avatar} name={post.author_name} size="xs" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1">
                          <span className="text-xs font-semibold truncate">{post.author_name}</span>
                          <VerifiedBadge verified={post.author_verified} />
                        </div>
                        <p className="text-[11px] text-[var(--htv-text-muted)] line-clamp-2">
                          {post.content}
                        </p>
                      </div>
                    </button>
                  ))}
                </div>
              )}

              {results.circles.length > 0 && (
                <div className="p-2 space-y-1">
                  <p className="px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-[var(--htv-text-dim)] flex items-center gap-1.5">
                    <CircleDot className="w-3 h-3 text-emerald-400" />
                    Circles
                  </p>
                  {results.circles.map((circle) => (
                    <button
                      key={`circle-${circle.id}`}
                      type="button"
                      onClick={() => {
                        onSelectCircle(circle.id);
                        setOpen(false);
                      }}
                      className="w-full px-2.5 py-2 rounded-xl hover:bg-[var(--htv-hover)] flex items-center gap-2.5 text-left cursor-pointer"
                    >
                      <Avatar src={circle.avatar_url} name={circle.name} size="sm" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <p className="text-xs font-semibold truncate">{circle.name}</p>
                          <span
                            className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0 ${
                              circle.privacy === 'private'
                                ? 'bg-amber-500/15 text-amber-600 dark:text-amber-300'
                                : 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-300'
                            }`}
                          >
                            {circle.privacy === 'private' ? (
                              <Lock className="w-2.5 h-2.5" />
                            ) : (
                              <Globe className="w-2.5 h-2.5" />
                            )}
                            {circle.privacy === 'private' ? 'Private' : 'Public'}
                          </span>
                        </div>
                        <p className="text-[11px] text-[var(--htv-text-dim)] truncate">
                          {circle.category} · {circle.member_count} members
                        </p>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
