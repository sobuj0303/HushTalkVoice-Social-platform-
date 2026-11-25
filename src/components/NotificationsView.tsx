import React, { useEffect, useState } from 'react';
import { Bell, CheckCheck } from 'lucide-react';
import { Avatar } from './Avatar';
import { apiFetch } from '../lib/api';
import type { NotificationItem } from '../shared/types';

interface NotificationsViewProps {
  onNotificationsRead: () => void;
}

export const NotificationsView: React.FC<NotificationsViewProps> = ({ onNotificationsRead }) => {
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      const data = await apiFetch<{ notifications: NotificationItem[] }>('/api/notifications');
      setItems(data.notifications);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const markAllRead = async () => {
    try {
      await apiFetch('/api/notifications/read-all', { method: 'POST' });
      setItems((prev) => prev.map((n) => ({ ...n, is_read: true })));
      onNotificationsRead();
    } catch {
      // ignore
    }
  };

  return (
    <div className="htv-card rounded-2xl p-4 sm:p-5 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-lg font-bold">Notifications</h2>
          <p className="text-xs text-[var(--htv-text-muted)]">
            Likes, comments, new followers, and connection updates.
          </p>
        </div>
        <button
          type="button"
          onClick={markAllRead}
          className="px-3 py-2 rounded-xl htv-elevated hover:bg-[var(--htv-hover)] text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer"
        >
          <CheckCheck className="w-4 h-4 text-purple-600 dark:text-purple-400" />
          Mark all read
        </button>
      </div>

      {loading ? (
        <div className="space-y-2.5">
          {[1, 2, 3].map((n) => (
            <div key={n} className="h-14 rounded-xl htv-elevated animate-pulse" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="py-10 text-center space-y-2">
          <Bell className="w-8 h-8 text-[var(--htv-text-dim)] mx-auto" />
          <p className="text-sm font-medium">All caught up</p>
          <p className="text-xs text-[var(--htv-text-muted)]">No notifications yet.</p>
        </div>
      ) : (
        <div className="divide-y divide-[var(--htv-border-subtle)]">
          {items.map((item) => (
            <div
              key={item.id}
              className={`py-3 px-3 rounded-xl flex items-center gap-3 ${
                !item.is_read ? 'bg-purple-500/10' : ''
              }`}
            >
              <Avatar src={item.actor_avatar} name={item.actor_name} size="sm" />
              <div className="flex-1 min-w-0">
                <p className="text-sm text-[var(--htv-text)]">{item.message}</p>
                <p className="text-xs text-[var(--htv-text-dim)] font-mono-tabular">
                  {new Date(item.created_at.replace(' ', 'T') + 'Z').toLocaleString()}
                </p>
              </div>
              {!item.is_read && (
                <span className="text-[11px] font-semibold text-orange-600 dark:text-orange-400 shrink-0">New</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
