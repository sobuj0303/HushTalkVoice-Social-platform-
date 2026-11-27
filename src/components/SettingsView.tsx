import React, { useEffect, useState } from 'react';
import {
  ArrowLeft,
  Check,
  ChevronRight,
  Edit3,
  Flag,
  LifeBuoy,
  Monitor,
  Moon,
  Save,
  Shield,
  SlidersHorizontal,
  Sun,
  UserCog,
} from 'lucide-react';
import { Avatar, VerifiedBadge } from './Avatar';
import { PWAInstallButton } from './PWAInstallButton';
import { ReportActivityView } from './ReportActivityView';
import { SupportBoxView } from './SupportBoxView';
import { apiFetch } from '../lib/api';
import { containsBlockedLink, validateFacebookLink, validateTextField } from '../shared/validation';
import type {
  AuthUser,
  PrivacySettings,
  ReportActivityPayload,
  SupportConfig,
  ThemeMode,
} from '../shared/types';

export type SettingsSection = 'menu' | 'preferences' | 'reports' | 'support';

interface SettingsViewProps {
  currentUser: AuthUser;
  activeTheme: ThemeMode;
  initialSection?: SettingsSection;
  sectionNonce?: number;
  supportHandle?: string;
  onThemeChange: (theme: ThemeMode) => void;
  onUserUpdated: (user: AuthUser) => void;
  onSupportConfigUpdated?: (config: SupportConfig) => void;
}

const THEME_MODES: {
  id: ThemeMode;
  title: string;
  subtitle: string;
  icon: React.ComponentType<{ className?: string }>;
}[] = [
  {
    id: 'day',
    title: 'Day Mode (দিন)',
    subtitle: 'Bright daylight canvas with crisp dark ink and high outdoor readability.',
    icon: Sun,
  },
  {
    id: 'night',
    title: 'Night Mode (রাত)',
    subtitle: 'Deep midnight purple studio palette designed for low-light comfort.',
    icon: Moon,
  },
  {
    id: 'system',
    title: 'System Mode (সিস্টেম)',
    subtitle: 'Automatically matches your device Day or Night preference in real time.',
    icon: Monitor,
  },
];

const SECTION_TITLES: Record<Exclude<SettingsSection, 'menu'>, string> = {
  preferences: 'Preferences & Privacy',
  reports: 'Report Activity & Safety',
  support: 'SupportBox & Bug Reports',
};

export const SettingsView: React.FC<SettingsViewProps> = ({
  currentUser,
  activeTheme,
  initialSection = 'menu',
  sectionNonce = 0,
  supportHandle = '',
  onThemeChange,
  onUserUpdated,
  onSupportConfigUpdated,
}) => {
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const [editorEnabled, setEditorEnabled] = useState(false);
  const [systemPrefersDark, setSystemPrefersDark] = useState<boolean>(() =>
    typeof window !== 'undefined'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
      : true
  );

  // Staged Privacy & Account Editor state
  const [privacy, setPrivacy] = useState<PrivacySettings>(currentUser.privacy);
  const [name, setName] = useState(currentUser.name);
  const [username, setUsername] = useState(currentUser.username);
  const [bio, setBio] = useState(currentUser.bio || '');
  const [facebookLink, setFacebookLink] = useState(currentUser.facebook_link || '');

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  // Report summary preview for Settings Hub row
  const [reportCounts, setReportCounts] = useState<{ received: number; given: number } | null>(
    null
  );

  useEffect(() => {
    setSection(initialSection);
  }, [initialSection, sectionNonce]);

  useEffect(() => {
    setPrivacy(currentUser.privacy);
    setName(currentUser.name);
    setUsername(currentUser.username);
    setBio(currentUser.bio || '');
    setFacebookLink(currentUser.facebook_link || '');
  }, [currentUser]);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const sync = () => setSystemPrefersDark(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  useEffect(() => {
    let cancelled = false;
    apiFetch<ReportActivityPayload>('/api/reports/my-activity')
      .then((res) => {
        if (!cancelled) {
          setReportCounts({
            received: res.summary.received_count,
            given: res.summary.given_count,
          });
        }
      })
      .catch(() => {
        // Keep Settings menu responsive if summary fails
      });
    return () => {
      cancelled = true;
    };
  }, [currentUser.id]);

  const hasSettingsChanges =
    JSON.stringify(privacy) !== JSON.stringify(currentUser.privacy);

  const hasProfileChanges =
    name.trim() !== currentUser.name ||
    username.trim().toLowerCase() !== currentUser.username ||
    bio.trim() !== (currentUser.bio || '') ||
    facebookLink.trim() !== (currentUser.facebook_link || '');

  const hasUnsavedChanges = hasSettingsChanges || hasProfileChanges;

  const activeThemeLabel =
    activeTheme === 'day'
      ? 'Day'
      : activeTheme === 'night'
      ? 'Night'
      : `System (${systemPrefersDark ? 'Night' : 'Day'})`;

  const handleThemePick = async (id: ThemeMode) => {
    setNotice('');
    setError('');
    onThemeChange(id);

    try {
      const res = await apiFetch<{ user: AuthUser }>('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({ theme: id, privacy: currentUser.privacy }),
      });
      onUserUpdated({ ...res.user, theme: id });
    } catch {
      // localStorage preserves selected theme immediately
    }
  };

  const handlePrivacyChange = <K extends keyof PrivacySettings>(
    key: K,
    value: PrivacySettings[K]
  ) => {
    if (!editorEnabled) return;
    setNotice('');
    setError('');
    setPrivacy((prev) => ({ ...prev, [key]: value }));
  };

  const handleSaveAll = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setNotice('');

    if (hasProfileChanges) {
      if (!name.trim() || name.trim().length < 2) {
        setError('Display Name must be at least 2 characters.');
        return;
      }
      if (containsBlockedLink(name).blocked) {
        setError('Display Name cannot contain external links.');
        return;
      }
      const bioCheck = validateTextField(bio, 'Bio', { maxWords: 120 });
      if (!bioCheck.valid) {
        setError(bioCheck.error || 'Invalid bio.');
        return;
      }
      const fbCheck = validateFacebookLink(facebookLink);
      if (!fbCheck.valid) {
        setError(fbCheck.error || 'Invalid Facebook link.');
        return;
      }
    }

    setSaving(true);
    try {
      let latestUser = currentUser;

      if (hasProfileChanges) {
        const profRes = await apiFetch<{ user: AuthUser }>('/api/profile', {
          method: 'PUT',
          body: JSON.stringify({
            name: name.trim(),
            username: username.trim().toLowerCase().replace(/^@/, ''),
            bio: bio.trim(),
            facebook_link: facebookLink.trim(),
            avatar_url: currentUser.avatar_url,
            cover_url: currentUser.cover_url,
          }),
        });
        latestUser = profRes.user;
      }

      if (hasSettingsChanges) {
        const setRes = await apiFetch<{ user: AuthUser }>('/api/settings', {
          method: 'PUT',
          body: JSON.stringify({ theme: activeTheme, privacy }),
        });
        latestUser = setRes.user;
      }

      onUserUpdated({ ...latestUser, theme: activeTheme });
      setEditorEnabled(false);
      setNotice('Settings saved successfully.');
      setTimeout(() => setNotice(''), 3000);
    } catch (err: any) {
      setError(err?.message || 'Could not save settings.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5 pb-6 min-w-0 w-full">
      {section === 'menu' ? (
        <>
          {/* Premium Account Header Card */}
          <section className="htv-card rounded-2xl overflow-hidden min-w-0">
            <div className="h-1.5 w-full bg-gradient-to-r from-purple-500 via-fuchsia-500 to-orange-500" />
            <div className="p-5 sm:p-6 flex items-center justify-between gap-4 flex-wrap min-w-0">
              <div className="flex items-center gap-3.5 min-w-0 flex-1">
                <Avatar
                  src={currentUser.avatar_url}
                  name={currentUser.name}
                  size="lg"
                  isOnline
                  showOnlineRing
                />
                <div className="min-w-0 space-y-0.5">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <h1 className="font-display text-lg sm:text-xl font-bold truncate">
                      {currentUser.name}
                    </h1>
                    <VerifiedBadge verified={currentUser.is_verified} />
                  </div>
                  <p className="text-xs text-[var(--htv-text-muted)] truncate">
                    @{currentUser.username} · {currentUser.email}
                  </p>
                  <p className="text-xs text-[var(--htv-text-dim)] pt-0.5">
                    Theme: {activeThemeLabel} · Profile:{' '}
                    {currentUser.privacy.profile_visibility === 'public' ? 'Public' : 'Private'}
                  </p>
                </div>
              </div>
            </div>
          </section>

          {/* Group 1: Account & Appearance */}
          <section className="space-y-2 min-w-0">
            <h2 className="px-1 text-xs font-semibold text-[var(--htv-text-dim)] tracking-wide">
              Account &amp; Experience
            </h2>

            <div className="htv-card rounded-2xl overflow-hidden divide-y divide-[var(--htv-border-subtle)]">
              <button
                type="button"
                onClick={() => setSection('preferences')}
                className="w-full min-h-[72px] px-4 sm:px-5 py-3.5 flex items-center justify-between gap-3 text-left hover:bg-[var(--htv-hover)] transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500/50"
              >
                <div className="flex items-center gap-3.5 min-w-0 flex-1">
                  <div className="w-10 h-10 rounded-xl bg-purple-500/12 text-purple-600 dark:text-purple-300 flex items-center justify-center shrink-0">
                    <SlidersHorizontal className="w-5 h-5" />
                  </div>
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <p className="font-display text-sm font-bold text-[var(--htv-text)] truncate">
                      Preferences &amp; Privacy
                    </p>
                    <p className="text-xs text-[var(--htv-text-muted)] truncate">
                      Day/Night display mode, profile editor &amp; 6 privacy controls
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-xs font-medium text-[var(--htv-text-dim)] hidden sm:inline whitespace-nowrap">
                    {activeThemeLabel}
                  </span>
                  <ChevronRight className="w-4 h-4 text-[var(--htv-text-dim)] shrink-0" />
                </div>
              </button>
            </div>
          </section>

          {/* Group 2: Safety & Support */}
          <section className="space-y-2 min-w-0">
            <h2 className="px-1 text-xs font-semibold text-[var(--htv-text-dim)] tracking-wide">
              Safety &amp; Support
            </h2>

            <div className="htv-card rounded-2xl overflow-hidden divide-y divide-[var(--htv-border-subtle)]">
              <button
                type="button"
                onClick={() => setSection('reports')}
                className="w-full min-h-[72px] px-4 sm:px-5 py-3.5 flex items-center justify-between gap-3 text-left hover:bg-[var(--htv-hover)] transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500/50"
              >
                <div className="flex items-center gap-3.5 min-w-0 flex-1">
                  <div className="w-10 h-10 rounded-xl bg-amber-500/12 text-amber-600 dark:text-amber-300 flex items-center justify-center shrink-0">
                    <Flag className="w-5 h-5" />
                  </div>
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <p className="font-display text-sm font-bold text-[var(--htv-text)] truncate">
                      Report Activity &amp; Safety
                    </p>
                    <p className="text-xs text-[var(--htv-text-muted)] truncate">
                      Reports received against you &amp; reports you submitted
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  {reportCounts && (
                    <span className="text-xs font-mono-tabular font-medium text-[var(--htv-text-dim)] hidden sm:inline whitespace-nowrap">
                      {reportCounts.received} received · {reportCounts.given} given
                    </span>
                  )}
                  <ChevronRight className="w-4 h-4 text-[var(--htv-text-dim)] shrink-0" />
                </div>
              </button>

              <button
                type="button"
                onClick={() => setSection('support')}
                className="w-full min-h-[72px] px-4 sm:px-5 py-3.5 flex items-center justify-between gap-3 text-left hover:bg-[var(--htv-hover)] transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500/50"
              >
                <div className="flex items-center gap-3.5 min-w-0 flex-1">
                  <div className="w-10 h-10 rounded-xl bg-sky-500/12 text-sky-600 dark:text-sky-300 flex items-center justify-center shrink-0">
                    <LifeBuoy className="w-5 h-5" />
                  </div>
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <p className="font-display text-sm font-bold text-[var(--htv-text)] truncate">
                      SupportBox &amp; Bug Reports
                    </p>
                    <p className="text-xs text-[var(--htv-text-muted)] truncate">
                      Submit bug applications, Support Inbox &amp; Telegram desk
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-xs font-medium text-sky-600 dark:text-sky-300 hidden sm:inline whitespace-nowrap">
                    {supportHandle || 'Telegram'}
                  </span>
                  <ChevronRight className="w-4 h-4 text-[var(--htv-text-dim)] shrink-0" />
                </div>
              </button>
            </div>
          </section>

          <PWAInstallButton variant="settings" />
        </>
      ) : (
        <>
          {/* Sub-View Top Navigation Bar with Back Button */}
          <div className="htv-card rounded-2xl px-3.5 py-3 sm:px-4 sm:py-3.5 flex items-center justify-between gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setSection('menu')}
              className="min-h-[44px] px-3.5 rounded-xl htv-elevated hover:bg-[var(--htv-hover)] text-xs font-semibold inline-flex items-center gap-2 whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500/50"
            >
              <ArrowLeft className="w-4 h-4 shrink-0" />
              Back to Settings
            </button>

            <h1 className="font-display text-sm sm:text-base font-bold text-right truncate min-w-0">
              {SECTION_TITLES[section]}
            </h1>
          </div>

          {section === 'support' && (
            <SupportBoxView
              currentUser={currentUser}
              embedded
              onConfigUpdated={onSupportConfigUpdated}
            />
          )}

          {section === 'reports' && (
            <ReportActivityView
              currentUser={currentUser}
              onDataLoaded={(payload) =>
                setReportCounts({
                  received: payload.summary.received_count,
                  given: payload.summary.given_count,
                })
              }
            />
          )}

          {section === 'preferences' && (
            <form onSubmit={handleSaveAll} className="space-y-5 min-w-0">
              {error && (
                <div className="rounded-xl border border-rose-500/35 bg-rose-500/10 px-4 py-2.5 text-xs text-rose-700 dark:text-rose-300">
                  {error}
                </div>
              )}
              {notice && (
                <div className="rounded-xl border border-emerald-500/35 bg-emerald-500/10 px-4 py-2.5 text-xs text-emerald-700 dark:text-emerald-300">
                  {notice}
                </div>
              )}

              {/* 1. Theme Mode Selector: Day / Night / System (Instant Apply) */}
              <section className="htv-card rounded-2xl p-5 space-y-4">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <Sun className="w-5 h-5 text-orange-500 shrink-0" />
                    <div className="min-w-0">
                      <h2 className="font-display text-base font-bold">
                        Display Mode (দিন / রাত / সিস্টেম)
                      </h2>
                      <p className="text-xs text-[var(--htv-text-muted)]">
                        Tap Day, Night, or System mode to apply it across the entire app immediately.
                      </p>
                    </div>
                  </div>
                  <span className="text-xs font-semibold text-purple-600 dark:text-purple-300 font-mono-tabular whitespace-nowrap">
                    Active: {activeThemeLabel}
                  </span>
                </div>

                <div
                  role="radiogroup"
                  aria-label="Display theme mode"
                  className="grid grid-cols-1 sm:grid-cols-3 gap-3"
                >
                  {THEME_MODES.map((item) => {
                    const Icon = item.icon;
                    const active = activeTheme === item.id;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        onClick={() => handleThemePick(item.id)}
                        className={`p-4 rounded-xl text-left transition-all border cursor-pointer focus:outline-none focus:ring-2 focus:ring-purple-500/50 ${
                          active
                            ? 'border-purple-500 bg-purple-500/10 ring-2 ring-purple-500/35 shadow-sm'
                            : 'htv-elevated hover:bg-[var(--htv-hover)]'
                        }`}
                      >
                        <div className="h-11 rounded-lg mb-3 overflow-hidden border border-[var(--htv-border-subtle)] flex relative">
                          {item.id === 'day' && (
                            <div className="w-full h-full bg-[#f8f7fc] flex items-center justify-between px-3">
                              <div className="flex items-center gap-1.5">
                                <span className="w-4 h-4 rounded-md bg-purple-600" />
                                <span className="w-10 h-2 rounded bg-slate-300" />
                              </div>
                              <Sun className="w-4 h-4 text-orange-500" />
                            </div>
                          )}
                          {item.id === 'night' && (
                            <div className="w-full h-full bg-[#0f0a1c] flex items-center justify-between px-3">
                              <div className="flex items-center gap-1.5">
                                <span className="w-4 h-4 rounded-md bg-purple-500" />
                                <span className="w-10 h-2 rounded bg-purple-300/30" />
                              </div>
                              <Moon className="w-4 h-4 text-purple-300" />
                            </div>
                          )}
                          {item.id === 'system' && (
                            <>
                              <div className="w-1/2 h-full bg-[#f8f7fc] flex items-center pl-2.5">
                                <Sun className="w-3.5 h-3.5 text-orange-500" />
                              </div>
                              <div className="w-1/2 h-full bg-[#0f0a1c] flex items-center justify-end pr-2.5">
                                <Moon className="w-3.5 h-3.5 text-purple-300" />
                              </div>
                            </>
                          )}
                        </div>

                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-1.5 min-w-0">
                            <Icon className="w-4 h-4 text-purple-600 dark:text-purple-400 shrink-0" />
                            <p className="font-display font-semibold text-sm truncate">
                              {item.title}
                            </p>
                          </div>

                          <span
                            aria-hidden="true"
                            className={`w-5 h-5 rounded-full flex items-center justify-center shrink-0 transition-all border-2 ${
                              active
                                ? 'border-purple-600 bg-purple-600 text-white shadow-sm'
                                : 'border-[var(--htv-text-dim)]/60 bg-transparent'
                            }`}
                          >
                            {active && <Check className="w-3 h-3 stroke-[3]" />}
                          </span>
                        </div>
                        <p className="text-xs text-[var(--htv-text-muted)] mt-1.5 leading-relaxed">
                          {item.subtitle}
                        </p>
                      </button>
                    );
                  })}
                </div>
              </section>

              {/* 2. Account & Profile Editor */}
              <section className="htv-card rounded-2xl p-5 space-y-4">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <UserCog className="w-5 h-5 text-purple-600 dark:text-purple-400 shrink-0" />
                    <div className="min-w-0">
                      <h2 className="font-display text-base font-bold">
                        Profile &amp; Account Editor
                      </h2>
                      <p className="text-xs text-[var(--htv-text-muted)]">
                        Update your display name, handle, bio, and optional Facebook link.
                      </p>
                    </div>
                  </div>
                  <span className="text-xs font-mono-tabular text-[var(--htv-text-dim)] truncate">
                    {currentUser.email}
                  </span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-[var(--htv-text-muted)]">
                      Display Name
                    </label>
                    <input
                      type="text"
                      disabled={!editorEnabled}
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      className="w-full h-10 px-3.5 rounded-xl htv-elevated text-sm text-[var(--htv-text)] disabled:opacity-70 focus:outline-none focus:ring-2 focus:ring-purple-500/45"
                    />
                  </div>

                  <div className="space-y-1">
                    <label className="text-xs font-medium text-[var(--htv-text-muted)]">
                      Username
                    </label>
                    <input
                      type="text"
                      disabled={!editorEnabled}
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      className="w-full h-10 px-3.5 rounded-xl htv-elevated text-sm text-[var(--htv-text)] disabled:opacity-70 focus:outline-none focus:ring-2 focus:ring-purple-500/45"
                    />
                  </div>
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-medium text-[var(--htv-text-muted)]">
                    Bio (External links blocked)
                  </label>
                  <textarea
                    rows={2}
                    disabled={!editorEnabled}
                    value={bio}
                    onChange={(e) => setBio(e.target.value)}
                    placeholder="Tell the community about your voice, studio, or interests..."
                    className="w-full p-3 rounded-xl htv-elevated text-sm text-[var(--htv-text)] resize-none disabled:opacity-70 focus:outline-none focus:ring-2 focus:ring-purple-500/45"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-medium text-[var(--htv-text-muted)]">
                    Optional Facebook Link (https://facebook.com/...)
                  </label>
                  <input
                    type="text"
                    disabled={!editorEnabled}
                    value={facebookLink}
                    onChange={(e) => setFacebookLink(e.target.value)}
                    placeholder="https://facebook.com/your.profile"
                    className="w-full h-10 px-3.5 rounded-xl htv-elevated text-sm text-[var(--htv-text)] disabled:opacity-70 focus:outline-none focus:ring-2 focus:ring-purple-500/45"
                  />
                </div>
              </section>

              {/* 3. Six Privacy Controls */}
              <section className="htv-card rounded-2xl p-5 space-y-4">
                <div className="flex items-center gap-2.5">
                  <Shield className="w-5 h-5 text-orange-500 shrink-0" />
                  <div>
                    <h2 className="font-display text-base font-bold">Privacy Controls</h2>
                    <p className="text-xs text-[var(--htv-text-muted)]">
                      Manage all 6 visibility and messaging permissions.
                    </p>
                  </div>
                </div>

                <div className="divide-y divide-[var(--htv-border-subtle)]">
                  {(
                    [
                      {
                        key: 'profile_visibility',
                        title: '1. Profile Visibility',
                        desc: 'Control who can inspect your full profile and posts.',
                        options: [
                          { value: 'public', label: 'Public' },
                          { value: 'private', label: 'Private' },
                        ],
                      },
                      {
                        key: 'followers_visibility',
                        title: '2. Followers List',
                        desc: 'Choose whether your followers list is open or private.',
                        options: [
                          { value: 'public', label: 'Public' },
                          { value: 'private', label: 'Private' },
                        ],
                      },
                      {
                        key: 'following_visibility',
                        title: '3. Following List',
                        desc: 'Choose whether accounts you follow are visible to others.',
                        options: [
                          { value: 'public', label: 'Public' },
                          { value: 'private', label: 'Private' },
                        ],
                      },
                      {
                        key: 'facebook_visibility',
                        title: '4. Facebook Link Visibility',
                        desc: 'Control visibility of your optional Facebook link on your profile.',
                        options: [
                          { value: 'public', label: 'Public' },
                          { value: 'private', label: 'Private' },
                        ],
                      },
                      {
                        key: 'online_status_visibility',
                        title: '5. Online Status',
                        desc: 'Show or hide your live presence indicator across HushTalkVoice.',
                        options: [
                          { value: 'everyone', label: 'Everyone' },
                          { value: 'nobody', label: 'Nobody' },
                        ],
                      },
                      {
                        key: 'who_can_message',
                        title: '6. Who Can Message Me',
                        desc: 'Route messages from non-connections into Message Requests.',
                        options: [
                          { value: 'everyone', label: 'Everyone' },
                          { value: 'connections', label: 'Connections Only' },
                        ],
                      },
                    ] as const
                  ).map((ctrl) => (
                    <div
                      key={ctrl.key}
                      className="py-4 flex items-center justify-between gap-4 flex-wrap"
                    >
                      <div className="space-y-0.5 max-w-md min-w-0">
                        <p className="text-sm font-semibold">{ctrl.title}</p>
                        <p className="text-xs text-[var(--htv-text-muted)]">{ctrl.desc}</p>
                      </div>
                      <div className="flex items-center gap-1 p-1 rounded-xl htv-elevated shrink-0">
                        {ctrl.options.map((opt) => {
                          const isActive = privacy[ctrl.key] === opt.value;
                          return (
                            <button
                              key={opt.value}
                              type="button"
                              disabled={!editorEnabled || saving}
                              onClick={() => handlePrivacyChange(ctrl.key, opt.value as any)}
                              className={`min-h-[36px] px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap ${
                                !editorEnabled ? 'cursor-default opacity-80' : 'cursor-pointer'
                              } ${
                                isActive
                                  ? 'htv-gradient-btn'
                                  : 'text-[var(--htv-text-muted)] hover:text-[var(--htv-text)]'
                              }`}
                            >
                              {opt.label}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              </section>

              {/* Bottom Action Bar: Edit & Save Buttons */}
              <div className="htv-card rounded-2xl p-4 flex items-center justify-between gap-3 flex-wrap">
                <p className="text-xs text-[var(--htv-text-muted)]">
                  {editorEnabled
                    ? hasUnsavedChanges
                      ? 'Unsaved account/privacy changes ready — click Save to apply.'
                      : 'Editing unlocked — modify account details or privacy and click Save.'
                    : 'Click Edit below to modify account details or privacy controls.'}
                </p>

                <div className="flex items-center gap-2.5 ml-auto">
                  <button
                    type="button"
                    onClick={() => {
                      if (editorEnabled) {
                        setPrivacy(currentUser.privacy);
                        setName(currentUser.name);
                        setUsername(currentUser.username);
                        setBio(currentUser.bio || '');
                        setFacebookLink(currentUser.facebook_link || '');
                        setEditorEnabled(false);
                        setError('');
                      } else {
                        setEditorEnabled(true);
                        setNotice('');
                        setError('');
                      }
                    }}
                    className="min-h-[44px] px-4 py-2.5 rounded-xl htv-elevated hover:bg-[var(--htv-hover)] text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
                  >
                    <Edit3 className="w-3.5 h-3.5 text-purple-600 dark:text-purple-400" />
                    {editorEnabled ? 'Cancel Edit' : 'Edit'}
                  </button>

                  <button
                    type="submit"
                    disabled={!editorEnabled || saving || !hasUnsavedChanges}
                    className="min-h-[44px] htv-gradient-btn px-5 py-2.5 rounded-xl text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed"
                  >
                    <Save className="w-3.5 h-3.5" />
                    {saving ? 'Saving...' : 'Save'}
                  </button>
                </div>
              </div>
            </form>
          )}
        </>
      )}
    </div>
  );
};
