import React from 'react';
import { WifiOff } from 'lucide-react';
import { useOnlineStatus } from '../hooks/useOnlineStatus';

export const OfflineIndicator: React.FC = () => {
  const isOnline = useOnlineStatus();

  if (isOnline) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-20 lg:bottom-5 left-4 z-40 flex items-center gap-2 rounded-xl border border-amber-500/40 bg-amber-600/95 px-3.5 py-2 text-xs font-semibold text-white shadow-xl backdrop-blur-md"
    >
      <WifiOff className="w-3.5 h-3.5 shrink-0" />
      <span>Offline mode — Reconnect to sync messages &amp; feeds</span>
    </div>
  );
};
