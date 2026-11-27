import React from 'react';
import {
  CircleDot,
  Info,
  LifeBuoy,
  Lock,
  MessageSquare,
  Mic,
  Settings,
  ShieldCheck,
  Sparkles,
  Video,
} from 'lucide-react';
import { Logo } from './Logo';

interface AboutViewProps {
  appVersion?: string;
  telegramHandle?: string;
  telegramUrl?: string;
  onOpenSupport: () => void;
  onOpenSettings: () => void;
}

export const AboutView: React.FC<AboutViewProps> = ({
  appVersion = '2.4.0',
  telegramHandle = '',
  telegramUrl = '',
  onOpenSupport,
  onOpenSettings,
}) => {
  const highlights = [
    {
      icon: Mic,
      title: 'Voice-First Social & Messenger',
      desc: 'Share voice notes, gallery photos, and real-time direct or group conversations up to 500 members with instant reactions and replies.',
      accent: 'text-purple-500',
    },
    {
      icon: CircleDot,
      title: 'Circles & Business Automation',
      desc: 'Follow public or private communities, manage sequential follower updates, auto-welcome DMs, keyword replies, and customer inquiries.',
      accent: 'text-orange-500',
    },
    {
      icon: Video,
      title: 'Community Videos Hub',
      desc: 'Moderated community video publishing with automatic thumbnails, fast streaming optimization, reactions, and unique view tracking.',
      accent: 'text-emerald-500',
    },
    {
      icon: ShieldCheck,
      title: 'Anti-Spam & Safety Shield',
      desc: 'Built-in link filtering, 200-word clarity standard, strict media allowlists, and traceable Case IDs keep conversations clean and trustworthy.',
      accent: 'text-sky-500',
    },
  ];

  return (
    <div className="space-y-5 min-w-0 w-full pb-6">
      {/* Brand Hero */}
      <section className="htv-card rounded-2xl p-5 sm:p-6 space-y-4 relative overflow-hidden">
        <div className="flex items-start justify-between gap-4 flex-wrap min-w-0">
          <div className="space-y-2.5 min-w-0 flex-1">
            <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full htv-elevated text-[11px] font-semibold text-purple-600 dark:text-purple-300">
              <Info className="w-3.5 h-3.5 shrink-0" />
              About HushTalkVoice
            </div>
            <div className="pt-0.5">
              <Logo />
            </div>
            <p className="text-sm text-[var(--htv-text-muted)] leading-relaxed max-w-2xl">
              HushTalkVoice is a real-time social community, voice-first messenger, and Circle
              workspace built for clear conversations, moderated video sharing, and spam-free
              interaction across desktop and mobile.
            </p>
          </div>

          <div className="htv-elevated rounded-xl px-4 py-3 space-y-1 shrink-0">
            <p className="text-[11px] text-[var(--htv-text-dim)] uppercase tracking-wide font-semibold">
              Release Build
            </p>
            <p className="font-mono-tabular text-base font-bold htv-gradient-text">
              v{appVersion}
            </p>
            <p className="text-[11px] text-emerald-600 dark:text-emerald-400 font-medium inline-flex items-center gap-1">
              <Sparkles className="w-3 h-3 shrink-0" />
              Day · Night · System Ready
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2.5 flex-wrap pt-1">
          <button
            type="button"
            onClick={onOpenSupport}
            className="htv-gradient-btn px-4 py-2.5 rounded-xl text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <LifeBuoy className="w-4 h-4 shrink-0" />
            Open SupportBox (Bug &amp; Help)
          </button>

          {telegramUrl && (
            <a
              href={telegramUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="px-4 py-2.5 rounded-xl bg-sky-500/15 border border-sky-500/35 text-sky-700 dark:text-sky-300 hover:bg-sky-500/25 text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors"
            >
              <MessageSquare className="w-4 h-4 shrink-0" />
              Telegram Support {telegramHandle ? `(${telegramHandle})` : ''}
            </a>
          )}

          <button
            type="button"
            onClick={onOpenSettings}
            className="px-4 py-2.5 rounded-xl htv-elevated hover:bg-[var(--htv-hover)] text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Settings className="w-4 h-4 shrink-0 text-[var(--htv-text-muted)]" />
            Preferences &amp; Privacy
          </button>
        </div>
      </section>

      {/* Core Platform Pillars */}
      <section className="grid grid-cols-1 sm:grid-cols-2 gap-4 min-w-0">
        {highlights.map((item) => {
          const Icon = item.icon;
          return (
            <div key={item.title} className="htv-card rounded-2xl p-4 sm:p-5 space-y-2 min-w-0">
              <div className="w-9 h-9 rounded-xl htv-elevated flex items-center justify-center">
                <Icon className={`w-4 h-4 ${item.accent}`} />
              </div>
              <h3 className="font-display font-bold text-sm">{item.title}</h3>
              <p className="text-xs text-[var(--htv-text-muted)] leading-relaxed">{item.desc}</p>
            </div>
          );
        })}
      </section>

      {/* Community Rules & Privacy Transparency */}
      <section className="htv-card rounded-2xl p-5 space-y-3.5 min-w-0">
        <div className="flex items-center gap-2">
          <Lock className="w-4 h-4 text-purple-500 shrink-0" />
          <h3 className="font-display font-bold text-sm">Community &amp; Safety Standards</h3>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
          <div className="htv-elevated rounded-xl p-3.5 space-y-1">
            <p className="font-semibold text-[var(--htv-text)]">1. Concise &amp; Link-Safe</p>
            <p className="text-[var(--htv-text-muted)] leading-relaxed">
              Posts, messages, and comments block external spam URLs and enforce a 200-word cap so feeds stay readable.
            </p>
          </div>
          <div className="htv-elevated rounded-xl p-3.5 space-y-1">
            <p className="font-semibold text-[var(--htv-text)]">2. Privacy Controls</p>
            <p className="text-[var(--htv-text-muted)] leading-relaxed">
              Members control profile, followers, following, online presence, and who can send direct messages at any time.
            </p>
          </div>
          <div className="htv-elevated rounded-xl p-3.5 space-y-1">
            <p className="font-semibold text-[var(--htv-text)]">3. Trackable Support</p>
            <p className="text-[var(--htv-text-muted)] leading-relaxed">
              Every bug report or support application receives a traceable SupportBox Ticket ID and direct follow-up.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
};
