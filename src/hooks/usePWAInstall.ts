import { useEffect, useState } from 'react';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

declare global {
  interface Window {
    __htvDeferredInstallPrompt?: BeforeInstallPromptEvent | null;
    __htvAppInstalled?: boolean;
  }
}

let sharedDeferredPrompt: BeforeInstallPromptEvent | null = null;
let sharedInstalled = false;
let initialized = false;
const listeners = new Set<() => void>();

function notifyListeners() {
  for (const fn of listeners) fn();
}

function checkStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    Boolean(window.__htvAppInstalled) ||
    window.matchMedia('(display-mode: standalone)').matches ||
    (window.navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

function checkInIframe(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}

function ensureGlobalListeners() {
  if (initialized || typeof window === 'undefined') return;
  initialized = true;
  sharedDeferredPrompt = window.__htvDeferredInstallPrompt ?? null;
  sharedInstalled = checkStandalone();

  const syncFromWindow = () => {
    sharedDeferredPrompt = window.__htvDeferredInstallPrompt ?? sharedDeferredPrompt;
    sharedInstalled = checkStandalone();
    notifyListeners();
  };

  window.addEventListener('htv:pwa-install-ready', syncFromWindow);
  window.addEventListener('htv:pwa-installed', () => {
    sharedInstalled = true;
    sharedDeferredPrompt = null;
    notifyListeners();
  });

  window.addEventListener('beforeinstallprompt', (e: Event) => {
    e.preventDefault();
    sharedDeferredPrompt = e as BeforeInstallPromptEvent;
    window.__htvDeferredInstallPrompt = sharedDeferredPrompt;
    notifyListeners();
  });

  window.addEventListener('appinstalled', () => {
    sharedInstalled = true;
    sharedDeferredPrompt = null;
    window.__htvAppInstalled = true;
    window.__htvDeferredInstallPrompt = null;
    notifyListeners();
  });

  const mq = window.matchMedia('(display-mode: standalone)');
  if (typeof mq.addEventListener === 'function') {
    mq.addEventListener('change', (e) => {
      sharedInstalled = e.matches || checkStandalone();
      notifyListeners();
    });
  }
}

ensureGlobalListeners();

export function usePWAInstall() {
  ensureGlobalListeners();

  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(
    () => sharedDeferredPrompt ?? (typeof window !== 'undefined' ? window.__htvDeferredInstallPrompt ?? null : null)
  );
  const [isInstalled, setIsInstalled] = useState<boolean>(() =>
    sharedInstalled || checkStandalone()
  );

  const userAgent =
    typeof window !== 'undefined' ? window.navigator.userAgent.toLowerCase() : '';
  const isIOS = /iphone|ipad|ipod/.test(userAgent);
  const isAndroid = /android/.test(userAgent);
  const isInIframe = checkInIframe();

  useEffect(() => {
    const sync = () => {
      setDeferredPrompt(
        sharedDeferredPrompt ?? window.__htvDeferredInstallPrompt ?? null
      );
      setIsInstalled(sharedInstalled || checkStandalone());
    };
    listeners.add(sync);
    sync();
    return () => {
      listeners.delete(sync);
    };
  }, []);

  const install = async (): Promise<boolean> => {
    const activePrompt =
      sharedDeferredPrompt ??
      (typeof window !== 'undefined' ? window.__htvDeferredInstallPrompt ?? null : null);
    if (!activePrompt) return false;
    try {
      await activePrompt.prompt();
      const { outcome } = await activePrompt.userChoice;
      sharedDeferredPrompt = null;
      if (typeof window !== 'undefined') {
        window.__htvDeferredInstallPrompt = null;
      }
      if (outcome === 'accepted') {
        sharedInstalled = true;
        if (typeof window !== 'undefined') {
          window.__htvAppInstalled = true;
        }
        notifyListeners();
        return true;
      }
      notifyListeners();
      return false;
    } catch {
      return false;
    }
  };

  return {
    isInstallable: Boolean(deferredPrompt),
    isInstalled,
    isIOS,
    isAndroid,
    isInIframe,
    install,
  };
}
