import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Bug,
  Check,
  CheckCircle2,
  Clock,
  Copy,
  ExternalLink,
  HelpCircle,
  Image as ImageIcon,
  Inbox,
  LifeBuoy,
  Lock,
  MessageSquare,
  RefreshCw,
  Send,
  ShieldAlert,
  Sparkles,
  UserCheck,
  X,
} from 'lucide-react';
import { apiFetch, uploadMediaFile } from '../lib/api';
import { formatSafeDate } from '../lib/postSession';
import { sanitizeMediaUrl, sanitizePlainText } from '../shared/validation';
import type {
  AuthUser,
  SupportCategory,
  SupportConfig,
  SupportTicketItem,
  SupportTicketStatus,
} from '../shared/types';

interface SupportBoxViewProps {
  currentUser: AuthUser;
  embedded?: boolean;
  onConfigUpdated?: (config: SupportConfig) => void;
}

const ISSUE_CATEGORIES: {
  id: SupportCategory;
  title: string;
  subtitle: string;
  icon: React.ComponentType<{ className?: string }>;
}[] = [
  {
    id: 'bug_error',
    title: 'Bug or App Error',
    subtitle: 'Something is broken, unresponsive, or showing an error.',
    icon: Bug,
  },
  {
    id: 'crash_performance',
    title: 'Crash or Slowness',
    subtitle: 'Screen freezes, media fails to load, or app lags.',
    icon: AlertTriangle,
  },
  {
    id: 'account_access',
    title: 'Account & Privacy',
    subtitle: 'Login, profile settings, verification, or access help.',
    icon: Lock,
  },
  {
    id: 'safety_policy',
    title: 'Safety & Abuse Help',
    subtitle: 'Escalated moderation, harassment, or spam appeal.',
    icon: ShieldAlert,
  },
  {
    id: 'feature_request',
    title: 'Feature Feedback',
    subtitle: 'Suggest an improvement or new HushTalkVoice tool.',
    icon: Sparkles,
  },
  {
    id: 'other',
    title: 'General Support',
    subtitle: 'Any other question for the HushTalkVoice team.',
    icon: HelpCircle,
  },
];

const AFFECTED_AREAS = [
  'Home Feed',
  'Circles',
  'Messenger',
  'Videos Hub',
  'Profile & Follows',
  'Notifications',
  'Settings & Theme',
  'Login / Account',
  'Other',
] as const;

const STATUS_BADGES: Record<
  SupportTicketStatus,
  { label: string; style: string }
> = {
  submitted: {
    label: 'Submitted',
    style: 'bg-sky-500/15 text-sky-600 dark:text-sky-300 border-sky-500/30',
  },
  in_review: {
    label: 'In Review',
    style: 'bg-amber-500/15 text-amber-600 dark:text-amber-300 border-amber-500/30',
  },
  resolved: {
    label: 'Resolved',
    style: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-300 border-emerald-500/30',
  },
  closed: {
    label: 'Closed',
    style: 'bg-slate-500/15 text-[var(--htv-text-dim)] border-[var(--htv-border-subtle)]',
  },
};

function buildDeviceDiagnostics(): string {
  if (typeof window === 'undefined') return '';
  const width = window.innerWidth;
  const height = window.innerHeight;
  const theme = document.documentElement.getAttribute('data-resolved-theme') || 'night';
  const online = typeof navigator !== 'undefined' && navigator.onLine ? 'online' : 'offline';
  const lang = typeof navigator !== 'undefined' ? navigator.language : 'en';
  return `Viewport ${width}x${height} · Theme ${theme} · ${online} · Lang ${lang}`;
}

export const SupportBoxView: React.FC<SupportBoxViewProps> = ({
  currentUser,
  embedded = false,
  onConfigUpdated,
}) => {
  const [activeTab, setActiveTab] = useState<'submit' | 'inbox'>('submit');
  const [config, setConfig] = useState<SupportConfig | null>(null);
  const [tickets, setTickets] = useState<SupportTicketItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [inboxFilter, setInboxFilter] = useState<'all' | 'open' | 'resolved'>('all');

  // Facebook-style Application Form State
  const [category, setCategory] = useState<SupportCategory>('bug_error');
  const [affectedArea, setAffectedArea] = useState<string>('Home Feed');
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [reporterTelegram, setReporterTelegram] = useState('');
  const [screenshotUrl, setScreenshotUrl] = useState('');
  const [includeDiagnostics, setIncludeDiagnostics] = useState(true);
  const [uploadingShot, setUploadingShot] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');
  const [lastCreatedTicket, setLastCreatedTicket] = useState<SupportTicketItem | null>(null);
  const [copiedId, setCopiedId] = useState('');
  const [diagnosticsPreview] = useState(() => buildDeviceDiagnostics());

  // Admin quick Telegram setup inside SupportBox
  const [editingTelegram, setEditingTelegram] = useState(false);
  const [telegramInput, setTelegramInput] = useState('');
  const [savingTelegram, setSavingTelegram] = useState(false);
  const [telegramNotice, setTelegramNotice] = useState('');
  const [telegramError, setTelegramError] = useState('');

  const screenshotInputRef = useRef<HTMLInputElement>(null);
  const onConfigUpdatedRef = useRef(onConfigUpdated);
  const editingTelegramRef = useRef(editingTelegram);
  const hasInitializedHandleRef = useRef(false);

  useEffect(() => {
    onConfigUpdatedRef.current = onConfigUpdated;
  }, [onConfigUpdated]);

  useEffect(() => {
    editingTelegramRef.current = editingTelegram;
  }, [editingTelegram]);

  const loadSupportData = useCallback(async (isManualRefresh = false) => {
    if (isManualRefresh) {
      setRefreshing(true);
    } else if (!hasInitializedHandleRef.current) {
      setLoading(true);
    }
    try {
      const [cfg, res] = await Promise.all([
        apiFetch<SupportConfig>('/api/support/config'),
        apiFetch<{ tickets: SupportTicketItem[] }>('/api/support/tickets'),
      ]);
      setConfig(cfg);
      if (!hasInitializedHandleRef.current || !editingTelegramRef.current) {
        setTelegramInput(cfg.telegram_handle || '');
        hasInitializedHandleRef.current = true;
      }
      setTickets(res.tickets);
      onConfigUpdatedRef.current?.(cfg);
    } catch {
      // Keep UI usable even if transient network error occurs
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [currentUser.id]);

  useEffect(() => {
    hasInitializedHandleRef.current = false;
    void loadSupportData(false);
  }, [loadSupportData]);

  const handleScreenshotUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setFormError('');
    setUploadingShot(true);
    try {
      const uploaded = await uploadMediaFile(file, 'image');
      setScreenshotUrl(uploaded.url);
    } catch (err: any) {
      setFormError(err?.message || 'Only gallery images (JPG, PNG, WEBP, GIF) are allowed.');
    } finally {
      setUploadingShot(false);
    }
  };

  const handleSubmitApplication = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError('');

    const cleanSubject = sanitizePlainText(subject, 140);
    const cleanDesc = sanitizePlainText(description, 2500);

    if (cleanSubject.length < 3) {
      setFormError('Please enter a brief summary (at least 3 characters).');
      return;
    }
    if (cleanDesc.length < 10) {
      setFormError('Please describe the bug, error, or request (at least 10 characters).');
      return;
    }

    const cleanTelegramUser = sanitizePlainText(reporterTelegram, 65)
      .replace(/^https?:\/\/(www\.)?(t\.me|telegram\.me)\//i, '')
      .replace(/^@+/, '')
      .split(/[/?#\s]/)[0];

    const diagnosticsParts: string[] = [];
    if (cleanTelegramUser) {
      diagnosticsParts.push(`Telegram: @${cleanTelegramUser}`);
    }
    if (includeDiagnostics) {
      diagnosticsParts.push(buildDeviceDiagnostics());
    }

    setSubmitting(true);
    try {
      const res = await apiFetch<{ ticket: SupportTicketItem }>('/api/support/tickets', {
        method: 'POST',
        body: JSON.stringify({
          category,
          affected_area: affectedArea,
          subject: cleanSubject,
          description: cleanDesc,
          screenshot_url: screenshotUrl,
          device_info: diagnosticsParts.join(' · '),
        }),
      });
      setTickets((prev) => [res.ticket, ...prev]);
      setLastCreatedTicket(res.ticket);
      setSubject('');
      setDescription('');
      setReporterTelegram('');
      setScreenshotUrl('');
    } catch (err: any) {
      setFormError(err?.message || 'Could not submit your application. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleCopyTicketSummary = async (ticket: SupportTicketItem) => {
    const summary = [
      `SupportBox Ticket: ${ticket.ticket_id}`,
      `User: @${currentUser.username}`,
      `Category: ${ISSUE_CATEGORIES.find((c) => c.id === ticket.category)?.title || ticket.category}`,
      `Area: ${ticket.affected_area}`,
      `Summary: ${ticket.subject}`,
      `Details: ${ticket.description}`,
    ].join('\n');
    try {
      await navigator.clipboard.writeText(summary);
      setCopiedId(ticket.ticket_id);
      window.setTimeout(() => setCopiedId(''), 2200);
    } catch {
      // ignore clipboard restriction
    }
  };

  const handleSaveTelegramHandle = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingTelegram(true);
    setTelegramNotice('');
    setTelegramError('');
    setFormError('');
    try {
      const res = await apiFetch<{ config: SupportConfig }>('/api/admin/support/config', {
        method: 'PUT',
        body: JSON.stringify({ telegram_handle: telegramInput.trim() }),
      });
      setConfig(res.config);
      setTelegramInput(res.config.telegram_handle || '');
      setEditingTelegram(false);
      setTelegramNotice(
        res.config.telegram_handle
          ? `Telegram Support updated to ${res.config.telegram_handle}`
          : 'Telegram handle cleared.'
      );
      onConfigUpdatedRef.current?.(res.config);
    } catch (err: any) {
      setTelegramError(err?.message || 'Could not save Telegram username.');
    } finally {
      setSavingTelegram(false);
    }
  };

  const openTicketsCount = tickets.filter(
    (t) => t.status === 'submitted' || t.status === 'in_review'
  ).length;

  const filteredTickets = tickets.filter((t) => {
    if (inboxFilter === 'open') return t.status === 'submitted' || t.status === 'in_review';
    if (inboxFilter === 'resolved') return t.status === 'resolved' || t.status === 'closed';
    return true;
  });

  const safeTelegramUrl =
    config?.telegram_url && config.telegram_url.startsWith('https://t.me/')
      ? config.telegram_url
      : '';

  return (
    <div className={`space-y-5 min-w-0 w-full ${embedded ? '' : 'pb-6'}`}>
      {/* Header + Telegram Support Desk Banner */}
      <section className="htv-card rounded-2xl p-4 sm:p-5 space-y-4 min-w-0">
        {embedded ? (
          <div className="flex items-center justify-between gap-3 flex-wrap min-w-0">
            <p className="text-xs text-[var(--htv-text-muted)] min-w-0 flex-1">
              App-এ কোনো Bug বা Error পেলে আবেদন জমা দিন অথবা সরাসরি Telegram-এ সাপোর্ট নিন।
            </p>
            <button
              type="button"
              onClick={() => void loadSupportData(true)}
              disabled={refreshing || loading}
              className="min-h-[40px] px-3.5 rounded-xl htv-elevated hover:bg-[var(--htv-hover)] text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 shrink-0 ${refreshing ? 'animate-spin' : ''}`} />
              {refreshing ? 'Refreshing...' : 'Refresh'}
            </button>
          </div>
        ) : (
          <div className="flex items-start justify-between gap-3 flex-wrap min-w-0">
            <div className="flex items-start gap-3 min-w-0 flex-1">
              <div className="w-10 h-10 rounded-xl htv-gradient-btn flex items-center justify-center shrink-0">
                <LifeBuoy className="w-5 h-5" />
              </div>
              <div className="min-w-0">
                <h2 className="font-display font-bold text-base sm:text-lg">
                  SupportBox &amp; Bug Reports
                </h2>
                <p className="text-xs text-[var(--htv-text-muted)]">
                  App-এ কোনো Bug বা Error পেলে আবেদন জমা দিন অথবা সরাসরি Telegram-এ সাপোর্ট নিন।
                </p>
              </div>
            </div>

            <button
              type="button"
              onClick={() => void loadSupportData(true)}
              disabled={refreshing || loading}
              className="min-h-[40px] px-3.5 rounded-xl htv-elevated hover:bg-[var(--htv-hover)] text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 shrink-0 ${refreshing ? 'animate-spin' : ''}`} />
              {refreshing ? 'Refreshing...' : 'Refresh'}
            </button>
          </div>
        )}

        {/* Telegram Live Support Card */}
        <div className="htv-elevated rounded-xl p-4 border border-sky-500/30 bg-gradient-to-r from-sky-500/10 via-transparent to-purple-500/10 space-y-3 min-w-0">
          <div className="flex items-center justify-between gap-3 flex-wrap min-w-0">
            <div className="flex items-start gap-2.5 min-w-0 flex-1">
              <div className="w-9 h-9 rounded-lg bg-sky-500/20 border border-sky-500/35 text-sky-500 flex items-center justify-center shrink-0">
                <Send className="w-4 h-4" />
              </div>
              <div className="min-w-0 space-y-0.5">
                <div className="flex items-center gap-2 flex-wrap min-w-0">
                  <p className="font-display font-bold text-sm">Telegram Support Desk</p>
                  {config?.telegram_handle && (
                    <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-sky-500/15 text-sky-600 dark:text-sky-300 border border-sky-500/30 whitespace-nowrap">
                      {config.telegram_handle}
                    </span>
                  )}
                  {config?.telegram_bot_configured && (
                    <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/15 text-emerald-600 dark:text-emerald-300 border border-emerald-500/30 whitespace-nowrap">
                      Auto-Forward Active
                    </span>
                  )}
                </div>
                <p className="text-xs text-[var(--htv-text-muted)]">
                  {safeTelegramUrl
                    ? `Direct support via Telegram (${config?.telegram_handle}). Submit a ticket below or message us with your Reference ID.`
                    : 'Submit your bug/error application below. Admins can link a public @Telegram username here for 1-tap Telegram chat.'}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2 flex-wrap shrink-0">
              {safeTelegramUrl && (
                <a
                  href={safeTelegramUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="px-4 py-2 rounded-xl bg-sky-500 hover:bg-sky-600 text-white text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 shadow-sm transition-colors"
                >
                  <MessageSquare className="w-3.5 h-3.5 shrink-0" />
                  Chat on Telegram
                  <ExternalLink className="w-3 h-3 shrink-0" />
                </a>
              )}
              {currentUser.role === 'admin' && (
                <button
                  type="button"
                  onClick={() => {
                    setTelegramError('');
                    setTelegramNotice('');
                    setEditingTelegram((prev) => {
                      const next = !prev;
                      if (next && !telegramInput) {
                        setTelegramInput(config?.telegram_handle || '');
                      }
                      return next;
                    });
                  }}
                  className="px-3 py-2 rounded-xl htv-card hover:bg-[var(--htv-hover)] text-xs font-semibold whitespace-nowrap shrink-0 cursor-pointer"
                >
                  {editingTelegram ? 'Close Setup' : safeTelegramUrl ? 'Edit @Telegram' : 'Link @Telegram'}
                </button>
              )}
            </div>
          </div>

          {currentUser.role === 'admin' && editingTelegram && (
            <form
              onSubmit={handleSaveTelegramHandle}
              className="pt-3 border-t border-[var(--htv-border-subtle)] space-y-2 min-w-0"
            >
              <div className="flex flex-col sm:flex-row sm:items-center gap-2 min-w-0">
                <input
                  type="text"
                  value={telegramInput}
                  onChange={(e) => {
                    setTelegramError('');
                    setTelegramInput(e.target.value);
                  }}
                  placeholder="@YourTelegramSupportHandle (e.g. @HushTalkSupport)"
                  autoComplete="off"
                  className="w-full sm:flex-1 min-w-0 h-9 px-3 rounded-lg bg-[var(--htv-input)] border border-[var(--htv-border-subtle)] text-xs text-[var(--htv-text)] focus:outline-none focus:ring-2 focus:ring-sky-500/45"
                />
                <button
                  type="submit"
                  disabled={savingTelegram}
                  className="w-full sm:w-auto htv-gradient-btn h-9 px-4 rounded-lg text-xs font-semibold whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
                >
                  {savingTelegram ? 'Saving...' : 'Save Telegram Link'}
                </button>
              </div>
              {telegramError && (
                <p className="text-xs text-rose-600 dark:text-rose-300 font-medium">
                  {telegramError}
                </p>
              )}
            </form>
          )}

          {telegramNotice && (
            <p className="text-xs text-emerald-600 dark:text-emerald-300 font-medium">
              {telegramNotice}
            </p>
          )}
        </div>

        {/* Facebook-style Support Navigation Tabs */}
        <div className="grid grid-cols-2 gap-1.5 p-1.5 htv-elevated rounded-xl">
          <button
            type="button"
            onClick={() => setActiveTab('submit')}
            className={`min-h-[44px] px-3 py-2 rounded-lg text-xs font-semibold inline-flex items-center justify-center gap-1.5 whitespace-nowrap cursor-pointer transition-colors ${
              activeTab === 'submit'
                ? 'htv-gradient-btn'
                : 'text-[var(--htv-text-muted)] hover:text-[var(--htv-text)] hover:bg-[var(--htv-hover)]'
            }`}
          >
            <Bug className="w-3.5 h-3.5 shrink-0" />
            <span className="truncate">Report / Apply</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('inbox')}
            className={`min-h-[44px] px-3 py-2 rounded-lg text-xs font-semibold inline-flex items-center justify-center gap-1.5 whitespace-nowrap cursor-pointer transition-colors ${
              activeTab === 'inbox'
                ? 'htv-gradient-btn'
                : 'text-[var(--htv-text-muted)] hover:text-[var(--htv-text)] hover:bg-[var(--htv-hover)]'
            }`}
          >
            <Inbox className="w-3.5 h-3.5 shrink-0" />
            <span className="truncate">
              Inbox ({tickets.length})
              {openTicketsCount > 0 ? ` · ${openTicketsCount} open` : ''}
            </span>
          </button>
        </div>
      </section>

      {formError && (
        <div className="rounded-xl border border-rose-500/35 bg-rose-500/10 px-4 py-2.5 text-xs text-rose-700 dark:text-rose-300">
          {formError}
        </div>
      )}

      {/* TAB 1: FACEBOOK-STYLE REPORT A PROBLEM / APPLICATION FORM */}
      {activeTab === 'submit' && (
        <div className="space-y-4">
          {lastCreatedTicket && (
            <div className="htv-card rounded-2xl p-4 sm:p-5 border border-emerald-500/40 bg-emerald-500/10 space-y-3 min-w-0">
              <div className="flex items-start justify-between gap-2 flex-wrap">
                <div className="flex items-start gap-2.5 min-w-0">
                  <CheckCircle2 className="w-5 h-5 text-emerald-500 shrink-0 mt-0.5" />
                  <div className="space-y-1 min-w-0">
                    <h2 className="font-display font-bold text-sm text-emerald-700 dark:text-emerald-200">
                      Application Submitted to SupportBox!
                    </h2>
                    <p className="text-xs text-[var(--htv-text-muted)]">
                      Reference ID:{' '}
                      <strong className="font-mono-tabular text-[var(--htv-text)]">
                        {lastCreatedTicket.ticket_id}
                      </strong>
                      {lastCreatedTicket.telegram_forwarded
                        ? ' · Forwarded directly to Telegram Support.'
                        : ' · Saved in your Support Inbox.'}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setLastCreatedTicket(null)}
                  aria-label="Dismiss confirmation"
                  className="p-1 rounded-lg text-[var(--htv-text-dim)] hover:text-[var(--htv-text)] cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="flex items-center gap-2 flex-wrap">
                <button
                  type="button"
                  onClick={() => void handleCopyTicketSummary(lastCreatedTicket)}
                  className="px-3 py-1.5 rounded-lg htv-card hover:bg-[var(--htv-hover)] text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
                >
                  {copiedId === lastCreatedTicket.ticket_id ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-emerald-500" />
                      Copied Details!
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5 text-purple-500" />
                      Copy Ticket for Telegram
                    </>
                  )}
                </button>
                {safeTelegramUrl && (
                  <a
                    href={safeTelegramUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="px-3 py-1.5 rounded-lg bg-sky-500 hover:bg-sky-600 text-white text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap"
                  >
                    <Send className="w-3.5 h-3.5" />
                    Send to Telegram
                  </a>
                )}
                <button
                  type="button"
                  onClick={() => setActiveTab('inbox')}
                  className="px-3 py-1.5 rounded-lg htv-elevated text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
                >
                  <Inbox className="w-3.5 h-3.5 text-orange-500" />
                  Track in Support Inbox
                </button>
              </div>
            </div>
          )}

          <form
            onSubmit={handleSubmitApplication}
            className="htv-card rounded-2xl p-4 sm:p-5 space-y-5 min-w-0"
          >
            {/* Step 1: Category Grid (Facebook "Help us understand what happened") */}
            <div className="space-y-2.5">
              <div>
                <h2 className="font-display font-bold text-sm">
                  1. What would you like to report?
                </h2>
                <p className="text-xs text-[var(--htv-text-dim)]">
                  Select the category that best matches your bug, error, or support request.
                </p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
                {ISSUE_CATEGORIES.map((item) => {
                  const Icon = item.icon;
                  const active = category === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setCategory(item.id)}
                      className={`p-3 rounded-xl border text-left transition-all cursor-pointer flex items-start gap-2.5 min-w-0 ${
                        active
                          ? 'border-orange-500/60 bg-gradient-to-br from-purple-500/15 to-orange-500/15 ring-2 ring-orange-500/25'
                          : 'htv-elevated hover:bg-[var(--htv-hover)]'
                      }`}
                    >
                      <div className="w-8 h-8 rounded-lg htv-card flex items-center justify-center shrink-0 mt-0.5">
                        <Icon
                          className={`w-4 h-4 ${
                            active ? 'text-orange-500' : 'text-[var(--htv-text-muted)]'
                          }`}
                        />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="font-display font-semibold text-xs">{item.title}</p>
                        <p className="text-[11px] text-[var(--htv-text-dim)] leading-snug mt-0.5">
                          {item.subtitle}
                        </p>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Step 2: Affected Area */}
            <div className="space-y-2">
              <label className="block font-display font-bold text-sm">
                2. Where did the bug or issue happen?
              </label>
              <div className="flex items-center gap-1.5 flex-wrap">
                {AFFECTED_AREAS.map((area) => {
                  const selected = affectedArea === area;
                  return (
                    <button
                      key={area}
                      type="button"
                      onClick={() => setAffectedArea(area)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap transition-colors cursor-pointer ${
                        selected
                          ? 'htv-gradient-btn'
                          : 'htv-elevated text-[var(--htv-text-muted)] hover:text-[var(--htv-text)]'
                      }`}
                    >
                      {area}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Step 3: Subject & Detailed Description */}
            <div className="space-y-3">
              <div className="space-y-1.5">
                <label htmlFor="support-subject" className="block font-display font-bold text-sm">
                  3. Issue Summary
                </label>
                <input
                  id="support-subject"
                  type="text"
                  required
                  maxLength={140}
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  placeholder="Short title (e.g. Button overflow in Circles or upload error)"
                  className="w-full h-10 px-3.5 rounded-xl htv-elevated text-sm text-[var(--htv-text)] placeholder:text-[var(--htv-text-dim)] focus:outline-none focus:ring-2 focus:ring-purple-500/45"
                />
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <label htmlFor="support-desc" className="font-display font-bold text-sm">
                    4. Details &amp; Error Message
                  </label>
                  <span className="text-[11px] font-mono-tabular text-[var(--htv-text-dim)]">
                    {description.length} / 2500 chars
                  </span>
                </div>
                <textarea
                  id="support-desc"
                  rows={4}
                  required
                  maxLength={2500}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Explain what went wrong, what error text appeared, and the steps so our team can reproduce and fix it..."
                  className="w-full p-3.5 rounded-xl htv-elevated text-sm text-[var(--htv-text)] placeholder:text-[var(--htv-text-dim)] resize-y focus:outline-none focus:ring-2 focus:ring-purple-500/45"
                />
              </div>

              <div className="space-y-1.5">
                <label htmlFor="support-telegram-user" className="block font-display font-bold text-sm">
                  Your Telegram @username (Optional)
                </label>
                <input
                  id="support-telegram-user"
                  type="text"
                  maxLength={65}
                  value={reporterTelegram}
                  onChange={(e) => setReporterTelegram(e.target.value)}
                  placeholder="@your_telegram_username (যাতে সাপোর্ট টিম টেলিগ্রামে যোগাযোগ করতে পারে)"
                  autoComplete="off"
                  className="w-full h-10 px-3.5 rounded-xl htv-elevated text-sm text-[var(--htv-text)] placeholder:text-[var(--htv-text-dim)] focus:outline-none focus:ring-2 focus:ring-sky-500/45"
                />
              </div>
            </div>

            {/* Step 4: Screenshot Attachment (Facebook "Add Screenshot") */}
            <div className="space-y-2.5">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div>
                  <p className="font-display font-bold text-sm">5. Attach Screenshot (Optional)</p>
                  <p className="text-[11px] text-[var(--htv-text-dim)]">
                    Upload a photo of the bug or error message (JPG, PNG, WEBP, GIF).
                  </p>
                </div>
                <input
                  ref={screenshotInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/gif"
                  className="hidden"
                  onChange={handleScreenshotUpload}
                />
                <button
                  type="button"
                  disabled={uploadingShot}
                  onClick={() => screenshotInputRef.current?.click()}
                  className="px-3.5 py-2 rounded-xl htv-elevated hover:bg-[var(--htv-hover)] text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
                >
                  <ImageIcon className="w-4 h-4 text-purple-500 shrink-0" />
                  {uploadingShot ? 'Uploading...' : screenshotUrl ? 'Replace Screenshot' : 'Add Screenshot'}
                </button>
              </div>

              {screenshotUrl && sanitizeMediaUrl(screenshotUrl) && (
                <div className="relative htv-elevated rounded-xl p-3">
                  <button
                    type="button"
                    onClick={() => setScreenshotUrl('')}
                    aria-label="Remove screenshot"
                    className="absolute top-2 right-2 z-10 p-1.5 rounded-lg bg-black/75 text-white hover:bg-black cursor-pointer"
                  >
                    <X className="w-4 h-4" />
                  </button>
                  <img
                    src={sanitizeMediaUrl(screenshotUrl)}
                    alt="Bug report screenshot preview"
                    referrerPolicy="no-referrer"
                    className="max-h-64 w-full object-contain rounded-lg bg-black/30"
                  />
                </div>
              )}
            </div>

            {/* Step 5: Diagnostic Info Toggle (like Facebook) */}
            <label className="flex items-start justify-between gap-3 p-3.5 rounded-xl htv-elevated cursor-pointer">
              <div className="min-w-0 space-y-0.5">
                <p className="text-xs font-semibold">Include Screen &amp; App Diagnostics</p>
                <p className="text-[11px] text-[var(--htv-text-dim)] break-words">
                  Helps reproduce layout or theme bugs ({diagnosticsPreview}). No passwords or private keys are included.
                </p>
              </div>
              <input
                type="checkbox"
                checked={includeDiagnostics}
                onChange={(e) => setIncludeDiagnostics(e.target.checked)}
                className="w-4 h-4 accent-purple-500 cursor-pointer shrink-0 mt-0.5"
              />
            </label>

            <div className="flex items-center justify-between gap-3 pt-2 border-t border-[var(--htv-border-subtle)] flex-wrap">
              <p className="text-[11px] text-[var(--htv-text-dim)]">
                Submitting as <strong className="text-[var(--htv-text)]">@{currentUser.username}</strong>
              </p>
              <button
                type="submit"
                disabled={submitting || uploadingShot}
                className="htv-gradient-btn px-5 py-2.5 rounded-xl text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
              >
                <Send className="w-3.5 h-3.5 shrink-0" />
                {submitting ? 'Submitting...' : 'Submit Application'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* TAB 2: FACEBOOK-STYLE SUPPORT INBOX */}
      {activeTab === 'inbox' && (
        <section className="space-y-4 min-w-0">
          <div className="htv-card rounded-2xl p-3.5 flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-1.5 flex-wrap">
              {(
                [
                  { id: 'all', label: `All (${tickets.length})` },
                  { id: 'open', label: `Open (${openTicketsCount})` },
                  { id: 'resolved', label: `Resolved (${tickets.length - openTicketsCount})` },
                ] as const
              ).map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setInboxFilter(f.id)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap cursor-pointer ${
                    inboxFilter === f.id
                      ? 'htv-gradient-btn'
                      : 'htv-elevated text-[var(--htv-text-muted)] hover:text-[var(--htv-text)]'
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setActiveTab('submit')}
              className="px-3 py-1.5 rounded-lg htv-elevated hover:bg-[var(--htv-hover)] text-xs font-semibold text-purple-600 dark:text-purple-300 whitespace-nowrap cursor-pointer"
            >
              + New Application
            </button>
          </div>

          {loading ? (
            <div className="htv-card rounded-2xl p-8 animate-pulse h-44" />
          ) : filteredTickets.length === 0 ? (
            <div className="htv-card rounded-2xl p-8 text-center space-y-2">
              <Inbox className="w-8 h-8 text-[var(--htv-text-dim)] mx-auto" />
              <p className="font-display font-semibold text-sm">Your Support Inbox is empty</p>
              <p className="text-xs text-[var(--htv-text-muted)]">
                Any bug reports or support applications you submit appear here with live status updates.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {filteredTickets.map((ticket) => {
                const badge = STATUS_BADGES[ticket.status] || STATUS_BADGES.submitted;
                const catLabel =
                  ISSUE_CATEGORIES.find((c) => c.id === ticket.category)?.title || ticket.category;
                const safeShot = sanitizeMediaUrl(ticket.screenshot_url);
                return (
                  <article
                    key={ticket.id}
                    className="htv-card rounded-2xl p-4 sm:p-5 space-y-3 min-w-0"
                  >
                    <div className="flex items-start justify-between gap-2 flex-wrap min-w-0">
                      <div className="space-y-1 min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap min-w-0">
                          <span className="font-mono-tabular text-xs font-bold text-orange-500">
                            {ticket.ticket_id}
                          </span>
                          <span
                            className={`px-2 py-0.5 rounded-full text-[10px] font-semibold border whitespace-nowrap ${badge.style}`}
                          >
                            {badge.label}
                          </span>
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-medium htv-elevated text-[var(--htv-text-muted)] whitespace-nowrap">
                            {catLabel}
                          </span>
                          <span className="text-[11px] text-[var(--htv-text-dim)] whitespace-nowrap">
                            · {ticket.affected_area}
                          </span>
                        </div>
                        <h3 className="font-display font-bold text-sm break-words [overflow-wrap:anywhere]">
                          {ticket.subject}
                        </h3>
                      </div>

                      <div className="flex items-center gap-1.5 shrink-0">
                        <span className="text-[11px] font-mono-tabular text-[var(--htv-text-dim)] inline-flex items-center gap-1 whitespace-nowrap">
                          <Clock className="w-3 h-3 shrink-0" />
                          {formatSafeDate(ticket.created_at)}
                        </span>
                        <button
                          type="button"
                          onClick={() => void handleCopyTicketSummary(ticket)}
                          title="Copy summary for Telegram"
                          className="p-1.5 rounded-lg htv-elevated hover:bg-[var(--htv-hover)] text-[var(--htv-text-muted)] cursor-pointer"
                        >
                          {copiedId === ticket.ticket_id ? (
                            <Check className="w-3.5 h-3.5 text-emerald-500" />
                          ) : (
                            <Copy className="w-3.5 h-3.5" />
                          )}
                        </button>
                      </div>
                    </div>

                    <p className="text-xs text-[var(--htv-text)] whitespace-pre-wrap break-words [overflow-wrap:anywhere] htv-elevated rounded-xl p-3">
                      {ticket.description}
                    </p>

                    {safeShot && (
                      <div className="rounded-xl overflow-hidden border border-[var(--htv-border-subtle)] bg-black/30">
                        <img
                          src={safeShot}
                          alt={`Screenshot for ${ticket.ticket_id}`}
                          referrerPolicy="no-referrer"
                          className="max-h-56 w-full object-contain"
                        />
                      </div>
                    )}

                    {ticket.device_info && (
                      <p className="text-[11px] font-mono-tabular text-[var(--htv-text-dim)] break-words">
                        Diagnostics: {ticket.device_info}
                      </p>
                    )}

                    {ticket.admin_reply && (
                      <div className="rounded-xl border border-emerald-500/35 bg-emerald-500/10 p-3 space-y-1">
                        <p className="text-[11px] font-semibold text-emerald-700 dark:text-emerald-300 inline-flex items-center gap-1.5">
                          <UserCheck className="w-3.5 h-3.5 shrink-0" />
                          Support Team Reply
                          {ticket.handled_by_name ? ` (${ticket.handled_by_name})` : ''}
                        </p>
                        <p className="text-xs text-[var(--htv-text)] whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
                          {ticket.admin_reply}
                        </p>
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          )}
        </section>
      )}
    </div>
  );
};
