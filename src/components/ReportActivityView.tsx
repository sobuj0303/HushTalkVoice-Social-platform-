import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Flag,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Users,
  XCircle,
} from 'lucide-react';
import { Avatar, VerifiedBadge } from './Avatar';
import { apiFetch } from '../lib/api';
import { formatSafeDate } from '../lib/postSession';
import type {
  AuthUser,
  ReportActivityItem,
  ReportActivityPayload,
  ReportStatus,
} from '../shared/types';

interface ReportActivityViewProps {
  currentUser: AuthUser;
  onDataLoaded?: (payload: ReportActivityPayload) => void;
}

const TARGET_LABELS: Record<string, string> = {
  post: 'Feed Post',
  circle_post: 'Circle Post',
  video: 'Video',
  user: 'Profile',
  group: 'Group Chat',
};

function renderStatusLabel(status: ReportStatus) {
  if (status === 'resolved') {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-600 dark:text-emerald-400 whitespace-nowrap">
        <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
        Resolved
      </span>
    );
  }
  if (status === 'dismissed') {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-semibold text-[var(--htv-text-dim)] whitespace-nowrap">
        <XCircle className="w-3.5 h-3.5 shrink-0" />
        Dismissed
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs font-semibold text-amber-600 dark:text-amber-400 whitespace-nowrap">
      <Clock className="w-3.5 h-3.5 shrink-0" />
      Pending Review
    </span>
  );
}

export const ReportActivityView: React.FC<ReportActivityViewProps> = ({
  currentUser,
  onDataLoaded,
}) => {
  const isAdmin = currentUser.role === 'admin';
  const [tab, setTab] = useState<'received' | 'given' | 'community'>('received');
  const [data, setData] = useState<ReportActivityPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const onDataLoadedRef = useRef(onDataLoaded);

  useEffect(() => {
    onDataLoadedRef.current = onDataLoaded;
  }, [onDataLoaded]);

  const loadActivity = useCallback(
    async (manual = false) => {
      if (manual) {
        setRefreshing(true);
      } else {
        setLoading(true);
      }
      setError('');
      try {
        const res = await apiFetch<ReportActivityPayload>('/api/reports/my-activity');
        setData(res);
        onDataLoadedRef.current?.(res);
      } catch (err: any) {
        setError(err?.message || 'Could not load report history.');
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [currentUser.id]
  );

  useEffect(() => {
    void loadActivity(false);
  }, [loadActivity]);

  const receivedList = data?.reports_received || [];
  const givenList = data?.reports_given || [];
  const communitySummary = data?.community_summary || [];
  const communityCases = data?.community_cases || [];

  const renderReportCard = (item: ReportActivityItem, mode: 'received' | 'given') => (
    <article
      key={`${mode}-${item.id}`}
      className="htv-card rounded-2xl p-4 sm:p-5 space-y-3 min-w-0"
    >
      <div className="flex items-start justify-between gap-3 flex-wrap min-w-0">
        <div className="space-y-1 min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap text-xs text-[var(--htv-text-muted)]">
            <span className="font-mono-tabular font-semibold text-[var(--htv-text)]">
              {item.case_id}
            </span>
            <span aria-hidden="true">·</span>
            <span>{TARGET_LABELS[item.target_type] || item.target_type}</span>
            <span aria-hidden="true">·</span>
            <span>{formatSafeDate(item.created_at)}</span>
          </div>

          <p className="text-sm font-semibold text-[var(--htv-text)] break-words [overflow-wrap:anywhere]">
            {mode === 'given' && item.target_username
              ? `Reported ${item.target_name || '@' + item.target_username} (@${item.target_username})`
              : item.target_summary}
          </p>
          {mode === 'given' && item.target_username && (
            <p className="text-xs text-[var(--htv-text-muted)] break-words [overflow-wrap:anywhere]">
              {item.target_summary}
            </p>
          )}
        </div>

        <div className="shrink-0">{renderStatusLabel(item.status)}</div>
      </div>

      <div className="pt-2.5 border-t border-[var(--htv-border-subtle)] text-xs text-[var(--htv-text-muted)] break-words [overflow-wrap:anywhere]">
        <span className="font-semibold text-[var(--htv-text)]">Reason:</span> {item.reason}
      </div>
    </article>
  );

  return (
    <div className="space-y-5 min-w-0 w-full">
      {/* Top Overview Stat Strip */}
      <section className="htv-card rounded-2xl p-4 sm:p-5 space-y-4 min-w-0">
        <div className="flex items-start justify-between gap-3 flex-wrap min-w-0">
          <div className="min-w-0 space-y-1">
            <h2 className="font-display font-bold text-base sm:text-lg">
              Safety &amp; Report History
            </h2>
            <p className="text-xs text-[var(--htv-text-muted)]">
              আপনার বিরুদ্ধে আসা রিপোর্ট (Reports Received) এবং আপনি কাকে রিপোর্ট দিয়েছেন (Reports Given) এখানে দেখুন।
            </p>
          </div>

          <button
            type="button"
            onClick={() => void loadActivity(true)}
            disabled={refreshing || loading}
            className="min-h-[40px] px-3.5 rounded-xl htv-elevated hover:bg-[var(--htv-hover)] text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 shrink-0 ${refreshing ? 'animate-spin' : ''}`} />
            {refreshing ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>

        <div className={`grid gap-3 ${isAdmin ? 'grid-cols-1 sm:grid-cols-3' : 'grid-cols-2'}`}>
          <div className="htv-elevated rounded-xl p-4 space-y-1 min-w-0">
            <div className="flex items-center justify-between gap-2 text-xs text-[var(--htv-text-muted)]">
              <span className="truncate font-medium">Reports Received</span>
              <ShieldAlert className="w-4 h-4 text-amber-500 shrink-0" />
            </div>
            <p className="font-display font-bold text-2xl font-mono-tabular">
              {data ? data.summary.received_count : '—'}
            </p>
            <p className="text-[11px] text-[var(--htv-text-dim)] font-mono-tabular">
              {data
                ? `${data.summary.pending_received} pending · ${data.summary.resolved_received} resolved`
                : 'Loading summary...'}
            </p>
          </div>

          <div className="htv-elevated rounded-xl p-4 space-y-1 min-w-0">
            <div className="flex items-center justify-between gap-2 text-xs text-[var(--htv-text-muted)]">
              <span className="truncate font-medium">Reports Given</span>
              <Flag className="w-4 h-4 text-purple-500 shrink-0" />
            </div>
            <p className="font-display font-bold text-2xl font-mono-tabular">
              {data ? data.summary.given_count : '—'}
            </p>
            <p className="text-[11px] text-[var(--htv-text-dim)] font-mono-tabular">
              {data ? `${data.summary.pending_given} pending review` : 'Loading summary...'}
            </p>
          </div>

          {isAdmin && (
            <div className="htv-elevated rounded-xl p-4 space-y-1 min-w-0">
              <div className="flex items-center justify-between gap-2 text-xs text-[var(--htv-text-muted)]">
                <span className="truncate font-medium">All Members Involved</span>
                <Users className="w-4 h-4 text-sky-500 shrink-0" />
              </div>
              <p className="font-display font-bold text-2xl font-mono-tabular">
                {data ? communitySummary.length : '—'}
              </p>
              <p className="text-[11px] text-[var(--htv-text-dim)] font-mono-tabular">
                {data ? `${communityCases.length} total cases logged` : 'Loading overview...'}
              </p>
            </div>
          )}
        </div>

        {/* Non-overlapping Segmented Switch */}
        <div
          role="tablist"
          aria-label="Report activity tabs"
          className={`grid gap-1.5 p-1.5 htv-elevated rounded-xl ${
            isAdmin ? 'grid-cols-1 sm:grid-cols-3' : 'grid-cols-2'
          }`}
        >
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'received'}
            onClick={() => setTab('received')}
            className={`min-h-[44px] px-3 py-2 rounded-lg text-xs font-semibold inline-flex items-center justify-center gap-1.5 whitespace-nowrap cursor-pointer transition-colors ${
              tab === 'received'
                ? 'htv-gradient-btn'
                : 'text-[var(--htv-text-muted)] hover:text-[var(--htv-text)] hover:bg-[var(--htv-hover)]'
            }`}
          >
            <ShieldAlert className="w-3.5 h-3.5 shrink-0" />
            <span className="truncate">Received ({receivedList.length})</span>
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={tab === 'given'}
            onClick={() => setTab('given')}
            className={`min-h-[44px] px-3 py-2 rounded-lg text-xs font-semibold inline-flex items-center justify-center gap-1.5 whitespace-nowrap cursor-pointer transition-colors ${
              tab === 'given'
                ? 'htv-gradient-btn'
                : 'text-[var(--htv-text-muted)] hover:text-[var(--htv-text)] hover:bg-[var(--htv-hover)]'
            }`}
          >
            <Flag className="w-3.5 h-3.5 shrink-0" />
            <span className="truncate">Given ({givenList.length})</span>
          </button>

          {isAdmin && (
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'community'}
              onClick={() => setTab('community')}
              className={`min-h-[44px] px-3 py-2 rounded-lg text-xs font-semibold inline-flex items-center justify-center gap-1.5 whitespace-nowrap cursor-pointer transition-colors ${
                tab === 'community'
                  ? 'htv-gradient-btn'
                  : 'text-[var(--htv-text-muted)] hover:text-[var(--htv-text)] hover:bg-[var(--htv-hover)]'
              }`}
            >
              <Users className="w-3.5 h-3.5 shrink-0" />
              <span className="truncate">All Members ({communitySummary.length})</span>
            </button>
          )}
        </div>
      </section>

      {error && (
        <div className="rounded-xl border border-rose-500/35 bg-rose-500/10 px-4 py-3 text-xs text-rose-700 dark:text-rose-300 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {loading ? (
        <div className="space-y-3">
          <div className="htv-card rounded-2xl p-6 animate-pulse h-28" />
          <div className="htv-card rounded-2xl p-6 animate-pulse h-28" />
        </div>
      ) : tab === 'received' ? (
        receivedList.length === 0 ? (
          <div className="htv-card rounded-2xl p-8 text-center space-y-2">
            <ShieldCheck className="w-8 h-8 text-emerald-500 mx-auto" />
            <p className="font-display font-semibold text-sm">No Reports Received</p>
            <p className="text-xs text-[var(--htv-text-muted)] max-w-md mx-auto">
              Your profile, posts, videos, and groups have zero safety reports against them.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {receivedList.map((item) => renderReportCard(item, 'received'))}
          </div>
        )
      ) : tab === 'given' ? (
        givenList.length === 0 ? (
          <div className="htv-card rounded-2xl p-8 text-center space-y-2">
            <Flag className="w-8 h-8 text-[var(--htv-text-dim)] mx-auto" />
            <p className="font-display font-semibold text-sm">No Reports Submitted</p>
            <p className="text-xs text-[var(--htv-text-muted)] max-w-md mx-auto">
              When you report a post, profile, video, or group, every case and its status appears here.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {givenList.map((item) => renderReportCard(item, 'given'))}
          </div>
        )
      ) : (
        <div className="space-y-5 min-w-0">
          {/* Admin Community Member Tally */}
          <section className="htv-card rounded-2xl p-4 sm:p-5 space-y-3 min-w-0">
            <div>
              <h3 className="font-display font-bold text-sm">
                Member Report Tally (কে কয়টা রিপোর্ট পেল / দিলো)
              </h3>
              <p className="text-xs text-[var(--htv-text-muted)]">
                Summary of reports received and submitted per community member.
              </p>
            </div>

            {communitySummary.length === 0 ? (
              <p className="text-xs text-[var(--htv-text-dim)] py-4 text-center">
                No report records yet.
              </p>
            ) : (
              <div className="divide-y divide-[var(--htv-border-subtle)]">
                {communitySummary.map((member) => (
                  <div
                    key={member.user_id}
                    className="py-3 flex items-center justify-between gap-3 flex-wrap min-w-0"
                  >
                    <div className="flex items-center gap-2.5 min-w-0 flex-1">
                      <Avatar src={member.avatar_url} name={member.name} size="sm" />
                      <div className="min-w-0">
                        <div className="flex items-center gap-1">
                          <span className="text-xs font-semibold truncate">{member.name}</span>
                          <VerifiedBadge verified={member.is_verified} />
                        </div>
                        <p className="text-[11px] text-[var(--htv-text-dim)] truncate">
                          @{member.username}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center gap-4 text-xs font-mono-tabular shrink-0">
                      <span className="text-amber-600 dark:text-amber-300 font-semibold whitespace-nowrap">
                        Received: {member.received_count}
                      </span>
                      <span className="text-purple-600 dark:text-purple-300 font-semibold whitespace-nowrap">
                        Given: {member.given_count}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Admin Recent Reporter -> Target Log */}
          {communityCases.length > 0 && (
            <section className="htv-card rounded-2xl p-4 sm:p-5 space-y-3 min-w-0">
              <h3 className="font-display font-bold text-sm">Recent Reporter → Target Log</h3>
              <div className="divide-y divide-[var(--htv-border-subtle)]">
                {communityCases.map((c) => (
                  <div key={c.id} className="py-3 space-y-1.5 min-w-0">
                    <div className="flex items-center justify-between gap-2 flex-wrap text-xs">
                      <span className="font-mono-tabular font-semibold text-[var(--htv-text)]">
                        {c.case_id} · {TARGET_LABELS[c.target_type] || c.target_type}
                      </span>
                      {renderStatusLabel(c.status)}
                    </div>
                    <p className="text-xs text-[var(--htv-text)] break-words">
                      <strong>@{c.reporter_username}</strong> reported{' '}
                      <strong>
                        {c.target_username ? `@${c.target_username}` : c.target_summary}
                      </strong>
                    </p>
                    <p className="text-[11px] text-[var(--htv-text-muted)] break-words">
                      {c.target_summary} · Reason: {c.reason}
                    </p>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
};
