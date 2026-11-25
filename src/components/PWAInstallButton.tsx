import React, { useState } from 'react';
import { Download, ExternalLink, MoreVertical, Share, Smartphone, X } from 'lucide-react';
import { usePWAInstall } from '../hooks/usePWAInstall';

interface PWAInstallButtonProps {
  variant?: 'header' | 'drawer' | 'settings';
}

export const PWAInstallButton: React.FC<PWAInstallButtonProps> = ({
  variant = 'header',
}) => {
  const { isInstallable, isInstalled, isIOS, isAndroid, isInIframe, install } = usePWAInstall();
  const [showGuide, setShowGuide] = useState(false);

  if (isInstalled) {
    return null;
  }

  const handleInstallClick = async () => {
    if (isInstallable) {
      const accepted = await install();
      if (accepted) return;
      return;
    }
    setShowGuide(true);
  };

  const showButton =
    variant === 'settings' || isInstallable || isIOS || isAndroid;

  if (!showButton) {
    return null;
  }

  const openOutsideIframeUrl =
    typeof window !== 'undefined' ? window.location.href : '/';

  return (
    <>
      {variant === 'header' && (
        <button
          type="button"
          onClick={handleInstallClick}
          className="htv-gradient-btn h-9 px-3 rounded-xl text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer shrink-0"
        >
          <Download className="w-3.5 h-3.5" />
          <span className="hidden sm:inline">Install App</span>
          <span className="sm:hidden">Install</span>
        </button>
      )}

      {variant === 'drawer' && (
        <button
          type="button"
          onClick={handleInstallClick}
          className="w-full px-3.5 py-2.5 rounded-xl text-xs font-semibold htv-gradient-btn flex items-center justify-center gap-2 cursor-pointer"
        >
          <Smartphone className="w-4 h-4 shrink-0" />
          Install HushTalkVoice App
        </button>
      )}

      {variant === 'settings' && (
        <section className="htv-card rounded-2xl p-5 flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-start gap-3 min-w-0">
            <div className="w-10 h-10 rounded-xl htv-gradient-btn flex items-center justify-center shrink-0">
              <Smartphone className="w-5 h-5" />
            </div>
            <div className="min-w-0 space-y-0.5">
              <h3 className="font-display text-base font-bold">Install Mobile App (PWA)</h3>
              <p className="text-xs text-[var(--htv-text-muted)]">
                Add HushTalkVoice to your Android or iPhone home screen for full-screen standalone launch.
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={handleInstallClick}
            className="htv-gradient-btn px-4 py-2.5 rounded-xl text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer ml-auto"
          >
            <Download className="w-3.5 h-3.5" />
            {isInstallable ? 'Install App' : 'Install / Add to Home'}
          </button>
        </section>
      )}

      {showGuide && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 backdrop-blur-sm p-4">
          <div className="w-full max-w-sm htv-card rounded-2xl p-5 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Smartphone className="w-4 h-4 text-orange-400" />
                <h3 className="font-display font-bold text-base">Install HushTalkVoice</h3>
              </div>
              <button
                type="button"
                onClick={() => setShowGuide(false)}
                aria-label="Close install guide"
                className="p-1.5 rounded-lg text-[var(--htv-text-dim)] hover:text-[var(--htv-text)] cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {isInIframe ? (
              <div className="space-y-3">
                <p className="text-xs text-[var(--htv-text-muted)] leading-relaxed">
                  Android Chrome does not allow direct app installation inside an embedded preview window. Open HushTalkVoice in a full Chrome tab to trigger the native install prompt:
                </p>
                <a
                  href={openOutsideIframeUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => setShowGuide(false)}
                  className="w-full py-2.5 px-4 rounded-xl htv-gradient-btn text-xs font-semibold inline-flex items-center justify-center gap-2 cursor-pointer"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  Open Full Tab to Install
                </a>
              </div>
            ) : isIOS ? (
              <ol className="space-y-2 text-xs text-[var(--htv-text-muted)] leading-relaxed">
                <li className="flex items-center gap-2">
                  <Share className="w-4 h-4 text-purple-400 shrink-0" />
                  <span>
                    1. Tap the <strong>Share</strong> icon in Safari&apos;s toolbar.
                  </span>
                </li>
                <li>
                  2. Scroll down and tap <strong>Add to Home Screen</strong>.
                </li>
                <li>
                  3. Tap <strong>Add</strong> to launch HushTalkVoice in standalone mode.
                </li>
              </ol>
            ) : (
              <ol className="space-y-2 text-xs text-[var(--htv-text-muted)] leading-relaxed">
                <li className="flex items-center gap-2">
                  <MoreVertical className="w-4 h-4 text-purple-400 shrink-0" />
                  <span>
                    1. Open the browser menu (<strong>⋮</strong>) in Chrome on Android.
                  </span>
                </li>
                <li>
                  2. Tap <strong>Add to Home screen</strong> or <strong>Install app</strong>.
                </li>
                <li>
                  3. Confirm <strong>Install</strong> to open HushTalkVoice as a standalone app.
                </li>
              </ol>
            )}

            <button
              type="button"
              onClick={() => setShowGuide(false)}
              className="w-full py-2.5 rounded-xl htv-elevated hover:bg-[var(--htv-hover)] text-xs font-semibold cursor-pointer"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </>
  );
};
