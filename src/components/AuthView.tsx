import React, { useState } from 'react';
import { Lock, Mail, User, KeyRound, ShieldCheck, ArrowRight } from 'lucide-react';
import { Logo } from './Logo';
import { PWAInstallButton } from './PWAInstallButton';
import { apiFetch, setStoredToken } from '../lib/api';
import type { AuthUser, ThemeMode } from '../shared/types';

interface AuthViewProps {
  theme: ThemeMode;
  onThemePreview: (t: ThemeMode) => void;
  onAuthenticated: (user: AuthUser) => void;
}

export const AuthView: React.FC<AuthViewProps> = ({
  theme,
  onThemePreview,
  onAuthenticated,
}) => {
  const [mode, setMode] = useState<'login' | 'register' | 'reset'>('login');
  const [identifier, setIdentifier] = useState('');
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  // Reset password state
  const [resetEmail, setResetEmail] = useState('');
  const [resetCode, setResetCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [codePreview, setCodePreview] = useState('');

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setNotice('');
    setLoading(true);
    try {
      const data = await apiFetch<{ token: string; user: AuthUser }>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ identifier, password }),
      });
      setStoredToken(data.token);
      onAuthenticated(data.user);
    } catch (err: any) {
      setError(err?.message || 'Sign in failed.');
    } finally {
      setLoading(false);
    }
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setNotice('');
    setLoading(true);
    try {
      const data = await apiFetch<{ token: string; user: AuthUser }>('/api/auth/register', {
        method: 'POST',
        body: JSON.stringify({ name, username, email, password }),
      });
      setStoredToken(data.token);
      onAuthenticated(data.user);
    } catch (err: any) {
      setError(err?.message || 'Registration failed.');
    } finally {
      setLoading(false);
    }
  };

  const handleRequestReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setNotice('');
    setLoading(true);
    try {
      const data = await apiFetch<{ message: string; verification_code_preview?: string }>(
        '/api/auth/forgot-password',
        {
          method: 'POST',
          body: JSON.stringify({ email: resetEmail }),
        }
      );
      setCodeSent(true);
      setNotice(data.message);
      if (data.verification_code_preview) {
        setCodePreview(data.verification_code_preview);
      }
    } catch (err: any) {
      setError(err?.message || 'Could not send verification code.');
    } finally {
      setLoading(false);
    }
  };

  const handleConfirmReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setNotice('');
    setLoading(true);
    try {
      const data = await apiFetch<{ message: string }>('/api/auth/reset-password', {
        method: 'POST',
        body: JSON.stringify({ email: resetEmail, code: resetCode, newPassword }),
      });
      setNotice(data.message);
      setCodeSent(false);
      setCodePreview('');
      setMode('login');
      setIdentifier(resetEmail);
    } catch (err: any) {
      setError(err?.message || 'Password reset failed.');
    } finally {
      setLoading(false);
    }
  };

  const quickFill = (id: string, pw: string) => {
    setMode('login');
    setIdentifier(id);
    setPassword(pw);
    setError('');
  };

  return (
    <div className="min-h-screen flex flex-col justify-between px-4 py-6 sm:px-8">
      {/* Top Bar */}
      <header className="max-w-6xl w-full mx-auto flex items-center justify-between gap-3">
        <Logo />
        <div className="flex items-center gap-2">
          <PWAInstallButton variant="header" />
          <div className="flex items-center gap-1.5 p-1 rounded-xl htv-card">
            {(
              [
                { id: 'day', label: 'Day' },
                { id: 'night', label: 'Night' },
                { id: 'system', label: 'System' },
              ] as const
            ).map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => onThemePreview(item.id)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-colors cursor-pointer ${
                  theme === item.id
                    ? 'htv-gradient-btn'
                    : 'text-[var(--htv-text-muted)] hover:text-[var(--htv-text)]'
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
      </header>

      {/* Main Split Grid */}
      <main className="max-w-6xl w-full mx-auto grid grid-cols-1 lg:grid-cols-12 gap-10 items-center my-8">
        <section className="lg:col-span-6 space-y-6">
          <div className="space-y-3">
            <p className="text-xs font-medium text-orange-600 dark:text-orange-400 tracking-wide">
              Next-generation evolution of NOTURI
            </p>
            <h1 className="font-display text-3xl sm:text-5xl font-bold leading-[1.12] tracking-tight text-balance">
              Voice-first community, real-time messenger, and open videos.
            </h1>
            <p className="text-[var(--htv-text-muted)] text-base leading-relaxed max-w-xl">
              Connect through live voice notes, gallery moments, 500-member group rooms, and curated
              community videos—zero paywalls, zero external spam links, and full privacy control.
            </p>
          </div>

          <div className="relative rounded-2xl overflow-hidden border border-[var(--htv-border-subtle)] aspect-[16/9] max-w-xl">
            <img
              src="/src/assets/images/cover_studio_1794997822111.jpg"
              alt="HushTalkVoice dark acoustic studio"
              referrerPolicy="no-referrer"
              className="w-full h-full object-cover"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/25 to-transparent flex items-end p-5">
              <div className="flex items-center gap-3 text-xs text-white/90">
                <span>Day, Night & System Modes</span>
                <span aria-hidden="true">·</span>
                <span>Strict Link Blocking</span>
                <span aria-hidden="true">·</span>
                <span>100% Open Community</span>
              </div>
            </div>
          </div>
        </section>

        <section className="lg:col-span-6">
          <div className="htv-card rounded-2xl p-6 sm:p-8 max-w-md w-full mx-auto space-y-6">
            <div className="flex items-center gap-1 p-1 rounded-xl htv-elevated">
              {(
                [
                  { id: 'login', label: 'Sign In' },
                  { id: 'register', label: 'Create Account' },
                  { id: 'reset', label: 'Reset Password' },
                ] as const
              ).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => {
                    setMode(tab.id);
                    setError('');
                    setNotice('');
                  }}
                  className={`flex-1 py-2 px-3 rounded-lg text-xs font-semibold whitespace-nowrap transition-colors cursor-pointer ${
                    mode === tab.id
                      ? 'htv-gradient-btn'
                      : 'text-[var(--htv-text-muted)] hover:text-[var(--htv-text)]'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            {error && (
              <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3.5 py-2.5 text-xs text-rose-700 dark:text-rose-300">
                {error}
              </div>
            )}
            {notice && (
              <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3.5 py-2.5 text-xs text-emerald-700 dark:text-emerald-300 space-y-1">
                <p>{notice}</p>
                {codePreview && (
                  <p className="font-mono-tabular font-semibold text-amber-700 dark:text-amber-300">
                    Verification Code: {codePreview}
                  </p>
                )}
              </div>
            )}

            {mode === 'login' && (
              <form onSubmit={handleLogin} className="space-y-4">
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-[var(--htv-text-muted)]">
                    Email or Username
                  </label>
                  <div className="relative">
                    <Mail className="w-4 h-4 text-[var(--htv-text-dim)] absolute left-3.5 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      required
                      value={identifier}
                      onChange={(e) => setIdentifier(e.target.value)}
                      placeholder="aria@hushtalkvoice.local or aria_voice"
                      className="w-full h-11 pl-10 pr-3.5 rounded-xl htv-elevated text-sm text-[var(--htv-text)] placeholder:text-[var(--htv-text-dim)] focus:outline-none focus:ring-2 focus:ring-purple-500/50"
                    />
                  </div>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-[var(--htv-text-muted)]">
                    Password
                  </label>
                  <div className="relative">
                    <Lock className="w-4 h-4 text-[var(--htv-text-dim)] absolute left-3.5 top-1/2 -translate-y-1/2" />
                    <input
                      type="password"
                      required
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="Enter your password"
                      className="w-full h-11 pl-10 pr-3.5 rounded-xl htv-elevated text-sm text-[var(--htv-text)] placeholder:text-[var(--htv-text-dim)] focus:outline-none focus:ring-2 focus:ring-purple-500/50"
                    />
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full h-11 htv-gradient-btn rounded-xl text-sm font-semibold inline-flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
                >
                  {loading ? 'Signing in...' : 'Sign In to HushTalkVoice'}
                  <ArrowRight className="w-4 h-4" />
                </button>

                <div className="pt-3 border-t border-[var(--htv-border-subtle)] space-y-2">
                  <p className="text-xs text-[var(--htv-text-dim)]">Quick-fill seeded accounts:</p>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => quickFill('aria@hushtalkvoice.local', 'Member@1234')}
                      className="py-2 px-3 rounded-lg htv-elevated hover:bg-[var(--htv-hover)] text-xs font-medium text-[var(--htv-text)] cursor-pointer"
                    >
                      Member (Aria)
                    </button>
                    <button
                      type="button"
                      onClick={() => quickFill('admin@hushtalkvoice.local', 'Admin@1234')}
                      className="py-2 px-3 rounded-lg htv-elevated hover:bg-[var(--htv-hover)] text-xs font-medium text-orange-600 dark:text-orange-300 inline-flex items-center justify-center gap-1.5 cursor-pointer"
                    >
                      <ShieldCheck className="w-3.5 h-3.5" />
                      Admin (Nadia)
                    </button>
                  </div>
                </div>
              </form>
            )}

            {mode === 'register' && (
              <form onSubmit={handleRegister} className="space-y-3.5">
                <div className="space-y-1">
                  <label className="text-xs font-medium text-[var(--htv-text-muted)]">Full Name</label>
                  <div className="relative">
                    <User className="w-4 h-4 text-[var(--htv-text-dim)] absolute left-3.5 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      required
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="Your display name"
                      className="w-full h-11 pl-10 pr-3.5 rounded-xl htv-elevated text-sm text-[var(--htv-text)] focus:outline-none focus:ring-2 focus:ring-purple-500/50"
                    />
                  </div>
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-medium text-[var(--htv-text-muted)]">Username</label>
                  <input
                    type="text"
                    required
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="e.g. farhan_voice"
                    className="w-full h-11 px-3.5 rounded-xl htv-elevated text-sm text-[var(--htv-text)] focus:outline-none focus:ring-2 focus:ring-purple-500/50"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-medium text-[var(--htv-text-muted)]">Email</label>
                  <input
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    className="w-full h-11 px-3.5 rounded-xl htv-elevated text-sm text-[var(--htv-text)] focus:outline-none focus:ring-2 focus:ring-purple-500/50"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-medium text-[var(--htv-text-muted)]">Password</label>
                  <input
                    type="password"
                    required
                    minLength={6}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Minimum 6 characters"
                    className="w-full h-11 px-3.5 rounded-xl htv-elevated text-sm text-[var(--htv-text)] focus:outline-none focus:ring-2 focus:ring-purple-500/50"
                  />
                </div>

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full h-11 htv-gradient-btn rounded-xl text-sm font-semibold cursor-pointer disabled:opacity-50"
                >
                  {loading ? 'Creating account...' : 'Join HushTalkVoice'}
                </button>
              </form>
            )}

            {mode === 'reset' && (
              <div className="space-y-4">
                {!codeSent ? (
                  <form onSubmit={handleRequestReset} className="space-y-4">
                    <div className="space-y-1.5">
                      <label className="text-xs font-medium text-[var(--htv-text-muted)]">
                        Registered Email Address
                      </label>
                      <div className="relative">
                        <Mail className="w-4 h-4 text-[var(--htv-text-dim)] absolute left-3.5 top-1/2 -translate-y-1/2" />
                        <input
                          type="email"
                          required
                          value={resetEmail}
                          onChange={(e) => setResetEmail(e.target.value)}
                          placeholder="aria@hushtalkvoice.local"
                          className="w-full h-11 pl-10 pr-3.5 rounded-xl htv-elevated text-sm text-[var(--htv-text)] focus:outline-none focus:ring-2 focus:ring-purple-500/50"
                        />
                      </div>
                    </div>
                    <button
                      type="submit"
                      disabled={loading}
                      className="w-full h-11 htv-gradient-btn rounded-xl text-sm font-semibold cursor-pointer disabled:opacity-50"
                    >
                      {loading ? 'Generating code...' : 'Send Verification Code'}
                    </button>
                  </form>
                ) : (
                  <form onSubmit={handleConfirmReset} className="space-y-3.5">
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-[var(--htv-text-muted)]">
                        6-Digit Verification Code
                      </label>
                      <div className="relative">
                        <KeyRound className="w-4 h-4 text-[var(--htv-text-dim)] absolute left-3.5 top-1/2 -translate-y-1/2" />
                        <input
                          type="text"
                          required
                          value={resetCode}
                          onChange={(e) => setResetCode(e.target.value)}
                          placeholder="123456"
                          className="w-full h-11 pl-10 pr-3.5 rounded-xl htv-elevated text-sm font-mono-tabular text-[var(--htv-text)] focus:outline-none focus:ring-2 focus:ring-purple-500/50"
                        />
                      </div>
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-[var(--htv-text-muted)]">
                        New Password
                      </label>
                      <input
                        type="password"
                        required
                        minLength={6}
                        value={newPassword}
                        onChange={(e) => setNewPassword(e.target.value)}
                        placeholder="Minimum 6 characters"
                        className="w-full h-11 px-3.5 rounded-xl htv-elevated text-sm text-[var(--htv-text)] focus:outline-none focus:ring-2 focus:ring-purple-500/50"
                      />
                    </div>
                    <button
                      type="submit"
                      disabled={loading}
                      className="w-full h-11 htv-gradient-btn rounded-xl text-sm font-semibold cursor-pointer disabled:opacity-50"
                    >
                      {loading ? 'Updating password...' : 'Confirm Password Reset'}
                    </button>
                  </form>
                )}
              </div>
            )}
          </div>
        </section>
      </main>

      <footer className="max-w-6xl w-full mx-auto text-center text-xs text-[var(--htv-text-dim)]">
        HushTalkVoice — Anti-spam protected community network
      </footer>
    </div>
  );
};
