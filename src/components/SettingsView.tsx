import React, { useEffect, useState } from 'react';
import {
  Sun,
  Moon,
  Monitor,
  Shield,
  Check,
  Edit3,
  Save,
  UserCog,
} from 'lucide-react';
import { PWAInstallButton } from './PWAInstallButton';
import { apiFetch } from '../lib/api';
import { containsBlockedLink, validateFacebookLink, validateTextField } from '../shared/validation';
import type { AuthUser, PrivacySettings, ThemeMode } from '../shared/types';

interface SettingsViewProps {
  currentUser: AuthUser;
  activeTheme: ThemeMode;
  onThemeChange: (theme: ThemeMode) => void;
  onUserUpdated: (user: AuthUser) => void;
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

export const SettingsView: React.FC<SettingsViewProps> = ({
  currentUser,
  activeTheme,
  onThemeChange,
  onUserUpdated,
}) => {
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

  const hasSettingsChanges =
    JSON.stringify(privacy) !== JSON.stringify(currentUser.privacy);

  const hasProfileChanges =
    name.trim() !== currentUser.name ||
    username.trim().toLowerCase() !== currentUser.username ||
    bio.trim() !== (currentUser.bio || '') ||
    facebookLink.trim() !== (currentUser.facebook_link || '');

  const hasUnsavedChanges = hasSettingsChanges || hasProfileChanges;

  const handleThemePick = async (id: ThemeMode) => {
    setNotice('');
    setError('');
    // Apply immediately across entire app & persist to localStorage
    onThemeChange(id);

    // Sync user preference in background without requiring Save
    try {
      const res = await apiFetch<{ user: AuthUser }>('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({ theme: id, privacy: currentUser.privacy }),
      });
      onUserUpdated({ ...res.user, theme: id });
    } catch {
      // localStorage already preserves the selected theme immediately
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
    <form onSubmit={handleSaveAll} className="space-y-5 pb-6">
      <div className="htv-card rounded-2xl p-5 space-y-1">
        <h2 className="font-display text-lg font-bold">Settings & Preferences</h2>
        <p className="text-xs text-[var(--htv-text-muted)]">
          Switch Day, Night, or System mode instantly, edit account details, and save privacy controls.
        </p>
      </div>

      <PWAInstallButton variant="settings" />

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
          <div className="flex items-center gap-2.5">
            <Sun className="w-5 h-5 text-orange-500" />
            <div>
              <h3 className="font-display text-base font-bold">Display Mode (দিন / রাত / সিস্টেম)</h3>
              <p className="text-xs text-[var(--htv-text-muted)]">
                Tap Day, Night, or System mode to apply it across the entire app immediately.
              </p>
            </div>
          </div>
          <span className="text-[11px] font-semibold text-purple-600 dark:text-purple-300 font-mono-tabular">
            Active:{' '}
            {activeTheme === 'day'
              ? 'Day (দিন)'
              : activeTheme === 'night'
              ? 'Night (রাত)'
              : `System · ${systemPrefersDark ? 'Night' : 'Day'}`}
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
                    <p className="font-display font-semibold text-sm truncate">{item.title}</p>
                  </div>

                  {/* Radio / Circle (⚪) Indicator */}
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
          <div className="flex items-center gap-2.5">
            <UserCog className="w-5 h-5 text-purple-600 dark:text-purple-400" />
            <div>
              <h3 className="font-display text-base font-bold">Profile & Account Editor</h3>
              <p className="text-xs text-[var(--htv-text-muted)]">
                Update your display name, handle, bio, and optional Facebook link.
              </p>
            </div>
          </div>
          <span className="text-xs font-mono-tabular text-[var(--htv-text-dim)]">
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
          <Shield className="w-5 h-5 text-orange-500" />
          <div>
            <h3 className="font-display text-base font-bold">Privacy Controls</h3>
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
              <div className="space-y-0.5 max-w-md">
                <p className="text-sm font-semibold">{ctrl.title}</p>
                <p className="text-xs text-[var(--htv-text-muted)]">{ctrl.desc}</p>
              </div>
              <div className="flex items-center gap-1 p-1 rounded-xl htv-elevated">
                {ctrl.options.map((opt) => {
                  const isActive = privacy[ctrl.key] === opt.value;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      disabled={!editorEnabled || saving}
                      onClick={() => handlePrivacyChange(ctrl.key, opt.value as any)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap ${
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
            className="px-4 py-2.5 rounded-xl htv-elevated hover:bg-[var(--htv-hover)] text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
          >
            <Edit3 className="w-3.5 h-3.5 text-purple-600 dark:text-purple-400" />
            {editorEnabled ? 'Cancel Edit' : 'Edit'}
          </button>

          <button
            type="submit"
            disabled={!editorEnabled || saving || !hasUnsavedChanges}
            className="htv-gradient-btn px-5 py-2.5 rounded-xl text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed"
          >
            <Save className="w-3.5 h-3.5" />
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </form>
  );
};
