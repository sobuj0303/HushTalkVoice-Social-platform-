import React, { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import {
  Home,
  Users,
  MessageSquare,
  Video,
  User,
  Bell,
  CircleDot,
  Settings,
  ShieldAlert,
  LogOut,
  Menu,
  X,
  Check,
} from 'lucide-react';
import { Logo } from './components/Logo';
import { Avatar, VerifiedBadge } from './components/Avatar';
import { GlobalSearchBar } from './components/GlobalSearchBar';
import { PWAInstallButton } from './components/PWAInstallButton';
import { OfflineIndicator } from './components/OfflineIndicator';
import { apiFetch, getStoredToken, setStoredToken } from './lib/api';
import { parsePositiveInt } from './shared/validation';
import type { AuthUser, ThemeMode, UserSummary } from './shared/types';

const AuthView = lazy(() => import('./components/AuthView').then((m) => ({ default: m.AuthView })));
const HomeFeed = lazy(() => import('./components/HomeFeed').then((m) => ({ default: m.HomeFeed })));
const FindPeople = lazy(() => import('./components/FindPeople').then((m) => ({ default: m.FindPeople })));
const MessengerView = lazy(() => import('./components/MessengerView').then((m) => ({ default: m.MessengerView })));
const VideosHub = lazy(() => import('./components/VideosHub').then((m) => ({ default: m.VideosHub })));
const CirclesView = lazy(() => import('./components/CirclesView').then((m) => ({ default: m.CirclesView })));
const ProfileAndFollows = lazy(() =>
  import('./components/ProfileAndFollows').then((m) => ({ default: m.ProfileAndFollows }))
);
const NotificationsView = lazy(() =>
  import('./components/NotificationsView').then((m) => ({ default: m.NotificationsView }))
);
const SettingsView = lazy(() => import('./components/SettingsView').then((m) => ({ default: m.SettingsView })));
const AdminDashboard = lazy(() => import('./components/AdminDashboard').then((m) => ({ default: m.AdminDashboard })));
const GroupInviteJoinModal = lazy(() =>
  import('./components/GroupInviteJoinModal').then((m) => ({ default: m.GroupInviteJoinModal }))
);

const ViewLoadingFallback: React.FC = () => (
  <div className="space-y-4" aria-label="Loading view">
    <div className="htv-card rounded-2xl p-5 animate-pulse space-y-3">
      <div className="h-4 w-36 htv-elevated rounded" />
      <div className="h-3 w-full htv-elevated rounded" />
      <div className="h-3 w-2/3 htv-elevated rounded" />
    </div>
  </div>
);

type NavSection =
  | 'home'
  | 'people'
  | 'messenger'
  | 'videos'
  | 'circles'
  | 'profile'
  | 'notifications'
  | 'settings'
  | 'admin';

interface PendingConnectionRequest {
  connection_id: number;
  user_id: number;
  name: string;
  username: string;
  avatar_url: string;
  is_verified: boolean;
}

const THEME_STORAGE_KEY = 'htv_theme';

function readStoredTheme(): ThemeMode | null {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    if (raw === 'day' || raw === 'night' || raw === 'system') return raw;
  } catch {
    // ignore storage errors
  }
  return null;
}

function writeStoredTheme(mode: ThemeMode): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    // ignore storage errors
  }
}

export default function App() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [booting, setBooting] = useState(true);
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => readStoredTheme() ?? 'night');

  const [section, setSection] = useState<NavSection>('home');
  const [profileUserId, setProfileUserId] = useState<number | null>(null);
  const [highlightedPostId, setHighlightedPostId] = useState<number | null>(null);
  const [activeConversationId, setActiveConversationId] = useState<number | null>(null);
  const [activeCircleId, setActiveCircleId] = useState<number | null>(null);
  const [highlightedCirclePostId, setHighlightedCirclePostId] = useState<number | null>(null);
  const [pendingGroupInviteCode, setPendingGroupInviteCode] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Right sidebar + badges state
  const [onlineMembers, setOnlineMembers] = useState<UserSummary[]>([]);
  const [connectionRequests, setConnectionRequests] = useState<PendingConnectionRequest[]>([]);
  const [unreadMessages, setUnreadMessages] = useState(0);
  const [unreadNotifications, setUnreadNotifications] = useState(0);

  // Real-time WebSocket state
  const wsRef = useRef<WebSocket | null>(null);
  const [wsEvent, setWsEvent] = useState<{ type: string; [key: string]: any } | null>(null);

  const applyThemeImmediately = useCallback((mode: ThemeMode) => {
    const prefersDark =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches;
    const resolved = mode === 'system' ? (prefersDark ? 'night' : 'day') : mode;

    document.documentElement.setAttribute('data-resolved-theme', resolved);
    if (resolved === 'night') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
    const metaTheme = document.querySelector('meta[name="theme-color"]');
    if (metaTheme) {
      metaTheme.setAttribute('content', resolved === 'night' ? '#130d22' : '#ffffff');
    }
  }, []);

  const handleThemeChange = useCallback(
    (nextMode: ThemeMode) => {
      writeStoredTheme(nextMode);
      setThemeMode(nextMode);
      applyThemeImmediately(nextMode);
      setUser((prev) => (prev ? { ...prev, theme: nextMode } : prev));
    },
    [applyThemeImmediately]
  );

  useEffect(() => {
    applyThemeImmediately(themeMode);
    if (themeMode !== 'system') return;

    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onSystemChange = () => applyThemeImmediately('system');
    mq.addEventListener('change', onSystemChange);
    return () => mq.removeEventListener('change', onSystemChange);
  }, [themeMode, applyThemeImmediately]);

  const loadSidebarContext = useCallback(async () => {
    try {
      const data = await apiFetch<{
        onlineMembers: UserSummary[];
        connectionRequests: PendingConnectionRequest[];
        unreadMessages: number;
        unreadNotifications: number;
      }>('/api/sidebar-context');
      setOnlineMembers(data.onlineMembers);
      setConnectionRequests(data.connectionRequests);
      setUnreadMessages(data.unreadMessages);
      setUnreadNotifications(data.unreadNotifications);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    apiFetch<{ user: AuthUser; token?: string }>('/api/auth/me')
      .then(async (res) => {
        if (res.token) setStoredToken(res.token);
        const stored = readStoredTheme();
        const effectiveTheme = stored ?? res.user.theme;
        if (!stored && res.user.theme) {
          writeStoredTheme(res.user.theme);
        }
        setThemeMode(effectiveTheme);
        setUser({ ...res.user, theme: effectiveTheme });
        const params = new URLSearchParams(window.location.search);
        const sharedProfile = params.get('profile');
        const sharedGroup = params.get('group');
        const sharedPostId = parsePositiveInt(params.get('post'));
        const sharedCircleId = parsePositiveInt(params.get('circle'));
        const sharedCirclePostId = parsePositiveInt(params.get('circlePost'));
        const sharedCircleInvite = params.get('circleInvite');
        if (sharedGroup) {
          setPendingGroupInviteCode(sharedGroup);
        } else if (sharedCircleInvite) {
          try {
            const joined = await apiFetch<{ circle_id: number }>('/api/circles/join-by-code', {
              method: 'POST',
              body: JSON.stringify({ code: sharedCircleInvite }),
            });
            setActiveCircleId(joined.circle_id || sharedCircleId || null);
            setSection('circles');
            window.history.replaceState({}, '', window.location.pathname);
          } catch {
            if (sharedCircleId) {
              setActiveCircleId(sharedCircleId);
              setSection('circles');
            }
          }
        } else if (sharedCircleId) {
          setActiveCircleId(sharedCircleId);
          if (sharedCirclePostId) setHighlightedCirclePostId(sharedCirclePostId);
          setSection('circles');
        } else if (sharedPostId) {
          setHighlightedPostId(sharedPostId);
          setSection('home');
        } else if (sharedProfile) {
          try {
            const target = await apiFetch<{ id: number }>(
              `/api/users/by-username/${encodeURIComponent(sharedProfile)}`
            );
            setProfileUserId(target.id);
            setSection('profile');
          } catch {
            // ignore invalid profile link
          }
        }
      })
      .catch(() => {
        setUser(null);
      })
      .finally(() => setBooting(false));
  }, []);

  // Connect WebSocket when authenticated
  useEffect(() => {
    if (!user) {
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      return;
    }

    loadSidebarContext();

    let closedByCleanup = false;
    let reconnectTimer: number | null = null;

    const connectWs = () => {
      if (closedByCleanup) return;
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const token = getStoredToken();
      const wsUrl = `${protocol}//${window.location.host}/ws${
        token ? `?token=${encodeURIComponent(token)}` : ''
      }`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data);
          setWsEvent({ ...payload, _ts: Date.now() });
          if (
            payload.type === 'message:new' ||
            payload.type === 'presence:update' ||
            payload.type === 'notification:new' ||
            payload.type === 'conversation:read' ||
            payload.type === 'circle:post:new'
          ) {
            loadSidebarContext();
          }
        } catch {
          // ignore
        }
      };

      ws.onclose = () => {
        if (!closedByCleanup) {
          reconnectTimer = window.setTimeout(connectWs, 2500);
        }
      };
    };

    connectWs();

    const onOnline = () => loadSidebarContext();
    window.addEventListener('online', onOnline);

    return () => {
      closedByCleanup = true;
      window.removeEventListener('online', onOnline);
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [user?.id, loadSidebarContext]);

  const sendWsPayload = useCallback((payload: Record<string, unknown>) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(payload));
    }
  }, []);

  const handleLogout = async () => {
    await apiFetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
    setStoredToken(null);
    setUser(null);
    setSection('home');
    setDrawerOpen(false);
  };

  const handleOpenProfile = (targetId: number) => {
    setProfileUserId(targetId);
    setSection('profile');
    setDrawerOpen(false);
  };

  const handleStartChat = async (targetUserId: number) => {
    try {
      const data = await apiFetch<{ conversation: { id: number } }>('/api/conversations/direct', {
        method: 'POST',
        body: JSON.stringify({ userId: targetUserId }),
      });
      setActiveConversationId(data.conversation.id);
      setSection('messenger');
      setDrawerOpen(false);
    } catch {
      // ignore
    }
  };

  const handleRespondConnection = async (connectionId: number, action: 'accept' | 'reject') => {
    try {
      await apiFetch(`/api/connections/${connectionId}/respond`, {
        method: 'POST',
        body: JSON.stringify({ action }),
      });
      loadSidebarContext();
    } catch {
      // ignore
    }
  };

  if (booting) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <Logo />
          <p className="text-xs text-[var(--htv-text-dim)]">Loading workspace...</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <>
        <Suspense
          fallback={
            <div className="min-h-screen flex items-center justify-center">
              <Logo />
            </div>
          }
        >
          <AuthView
            theme={themeMode}
            onThemePreview={handleThemeChange}
            onAuthenticated={(u) => {
              const stored = readStoredTheme();
              const effectiveTheme = stored ?? u.theme;
              if (!stored && u.theme) writeStoredTheme(u.theme);
              setThemeMode(effectiveTheme);
              setUser({ ...u, theme: effectiveTheme });
              setProfileUserId(u.id);
              setSection('home');
              const params = new URLSearchParams(window.location.search);
              const sharedGroup = params.get('group');
              const sharedPostId = parsePositiveInt(params.get('post'));
              const sharedCircleId = parsePositiveInt(params.get('circle'));
              const sharedCirclePostId = parsePositiveInt(params.get('circlePost'));
              const sharedCircleInvite = params.get('circleInvite');
              if (sharedGroup) {
                setPendingGroupInviteCode(sharedGroup);
              } else if (sharedCircleInvite) {
                void apiFetch<{ circle_id: number }>('/api/circles/join-by-code', {
                  method: 'POST',
                  body: JSON.stringify({ code: sharedCircleInvite }),
                })
                  .then((joined) => {
                    setActiveCircleId(joined.circle_id || sharedCircleId || null);
                    setSection('circles');
                    window.history.replaceState({}, '', window.location.pathname);
                  })
                  .catch(() => {
                    if (sharedCircleId) {
                      setActiveCircleId(sharedCircleId);
                      setSection('circles');
                    }
                  });
              } else if (sharedCircleId) {
                setActiveCircleId(sharedCircleId);
                if (sharedCirclePostId) setHighlightedCirclePostId(sharedCirclePostId);
                setSection('circles');
              } else if (sharedPostId) {
                setHighlightedPostId(sharedPostId);
              }
            }}
          />
        </Suspense>
        <OfflineIndicator />
      </>
    );
  }

  const navItems: {
    id: NavSection;
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    badge?: number;
  }[] = [
    { id: 'home', label: 'Home', icon: Home },
    { id: 'people', label: 'Find People', icon: Users },
    { id: 'messenger', label: 'Messenger', icon: MessageSquare, badge: unreadMessages },
    { id: 'videos', label: 'Videos', icon: Video },
    { id: 'circles', label: 'Circles', icon: CircleDot },
    { id: 'profile', label: 'Profile & Follows', icon: User },
    { id: 'notifications', label: 'Notifications', icon: Bell, badge: unreadNotifications },
    { id: 'settings', label: 'Settings', icon: Settings },
    ...(user.role === 'admin'
      ? [{ id: 'admin' as const, label: 'Admin Dashboard', icon: ShieldAlert }]
      : []),
  ];

  const selectNav = (id: NavSection) => {
    if (id === 'profile') setProfileUserId(user.id);
    setSection(id);
    setDrawerOpen(false);
  };

  return (
    <div className="min-h-screen flex flex-col">
      {/* Sticky Top Navigation Bar with Global Search */}
      <header className="sticky top-0 z-30 h-14 px-3 sm:px-6 htv-glass border-b">
        <div className="max-w-[1440px] mx-auto h-full flex items-center justify-between gap-2.5 sm:gap-4">
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => setDrawerOpen(true)}
              aria-label="Open menu"
              className="lg:hidden min-w-[40px] min-h-[40px] -ml-1 flex items-center justify-center text-[var(--htv-text)] cursor-pointer"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div className="hidden sm:block">
              <Logo />
            </div>
          </div>

          <div className="flex-1 flex justify-center min-w-0">
            <GlobalSearchBar
              onSelectPerson={(uid) => handleOpenProfile(uid)}
              onSelectPost={(pid) => {
                setHighlightedPostId(pid);
                setSection('home');
                setDrawerOpen(false);
              }}
              onSelectCircle={(cid) => {
                setActiveCircleId(cid);
                setSection('circles');
                setDrawerOpen(false);
              }}
            />
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            <PWAInstallButton variant="header" />
            <button
              type="button"
              onClick={() => selectNav('notifications')}
              aria-label="Notifications"
              className="relative min-w-[40px] min-h-[40px] flex items-center justify-center rounded-xl hover:bg-[var(--htv-hover)] text-[var(--htv-text)] cursor-pointer"
            >
              <Bell className="w-5 h-5" />
              {unreadNotifications > 0 && (
                <span className="absolute top-1.5 right-1.5 px-1.5 min-w-[16px] h-4 rounded-full bg-orange-500 text-white text-[10px] font-mono-tabular font-bold flex items-center justify-center">
                  {unreadNotifications}
                </span>
              )}
            </button>
          </div>
        </div>
      </header>

      {/* Mobile Slide-Over Menu Drawer */}
      {drawerOpen && (
        <div className="lg:hidden fixed inset-0 z-50 flex">
          <div
            className="fixed inset-0 bg-black/65 backdrop-blur-sm"
            onClick={() => setDrawerOpen(false)}
          />
          <aside className="relative z-10 w-72 max-w-[82vw] h-full htv-card border-r p-4 flex flex-col justify-between overflow-y-auto">
            <div className="space-y-5">
              <div className="flex items-center justify-between">
                <Logo />
                <button
                  type="button"
                  onClick={() => setDrawerOpen(false)}
                  aria-label="Close menu"
                  className="p-2 rounded-lg text-[var(--htv-text-muted)] hover:text-[var(--htv-text)] cursor-pointer"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <nav className="space-y-1">
                {navItems.map((item) => {
                  const Icon = item.icon;
                  const active = section === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => selectNav(item.id)}
                      className={`w-full px-3.5 py-2.5 rounded-xl text-sm font-medium flex items-center justify-between gap-2 transition-colors cursor-pointer ${
                        active
                          ? 'htv-gradient-btn'
                          : 'text-[var(--htv-text-muted)] hover:bg-[var(--htv-hover)] hover:text-[var(--htv-text)]'
                      }`}
                    >
                      <span className="flex items-center gap-3 whitespace-nowrap">
                        <Icon className="w-4 h-4 shrink-0" />
                        {item.label}
                      </span>
                      {item.badge !== undefined && item.badge > 0 && (
                        <span className="px-2 py-0.5 rounded-full bg-orange-500 text-white text-[11px] font-mono-tabular font-bold">
                          {item.badge}
                        </span>
                      )}
                    </button>
                  );
                })}
              </nav>
            </div>

            <div className="pt-4 border-t border-[var(--htv-border-subtle)] space-y-2.5">
              <PWAInstallButton variant="drawer" />
              <button
                type="button"
                onClick={handleLogout}
                className="w-full px-3.5 py-2.5 rounded-xl text-sm font-medium text-rose-600 dark:text-rose-300 hover:bg-rose-500/15 flex items-center gap-3 cursor-pointer"
              >
                <LogOut className="w-4 h-4" />
                Logout
              </button>
            </div>
          </aside>
        </div>
      )}

      {/* Main 3-Column Desktop Layout */}
      <div className="max-w-[1440px] w-full mx-auto flex-1 flex gap-6 px-4 sm:px-6 py-5 pb-24 lg:pb-8">
        {/* Column 1: Left Navigation Sidebar (Desktop lg+) */}
        <aside className="hidden lg:flex flex-col justify-between w-[250px] shrink-0 sticky top-[76px] h-[calc(100vh-96px)] htv-card rounded-2xl p-4">
          <div className="space-y-4 overflow-y-auto">
            <nav className="space-y-1">
              {navItems.map((item) => {
                const Icon = item.icon;
                const active = section === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => selectNav(item.id)}
                    className={`w-full px-3.5 py-2.5 rounded-xl text-sm font-medium flex items-center justify-between gap-2 transition-colors cursor-pointer ${
                      active
                        ? 'htv-gradient-btn'
                        : 'text-[var(--htv-text-muted)] hover:bg-[var(--htv-hover)] hover:text-[var(--htv-text)]'
                    }`}
                  >
                    <span className="flex items-center gap-3 whitespace-nowrap">
                      <Icon className="w-4 h-4 shrink-0" />
                      {item.label}
                    </span>
                    {item.badge !== undefined && item.badge > 0 && (
                      <span className="px-2 py-0.5 rounded-full bg-orange-500 text-white text-[11px] font-mono-tabular font-bold">
                        {item.badge}
                      </span>
                    )}
                  </button>
                );
              })}

              <button
                type="button"
                onClick={handleLogout}
                className="w-full px-3.5 py-2.5 rounded-xl text-sm font-medium text-rose-600 dark:text-rose-300 hover:bg-rose-500/15 flex items-center gap-3 cursor-pointer"
              >
                <LogOut className="w-4 h-4 shrink-0" />
                Logout
              </button>
            </nav>
          </div>

          {/* Signed-in User Summary */}
          <button
            type="button"
            onClick={() => handleOpenProfile(user.id)}
            className="htv-elevated hover:bg-[var(--htv-hover)] rounded-xl p-2.5 flex items-center gap-2.5 text-left cursor-pointer"
          >
            <Avatar src={user.avatar_url} name={user.name} size="sm" isOnline showOnlineRing />
            <div className="min-w-0">
              <div className="flex items-center gap-1">
                <span className="text-xs font-semibold truncate">{user.name}</span>
                <VerifiedBadge verified={user.is_verified} />
              </div>
              <p className="text-[11px] text-[var(--htv-text-dim)] truncate">@{user.username}</p>
            </div>
          </button>
        </aside>

        {/* Column 2: Main Content Viewport */}
        <main className="flex-1 min-w-0">
          <Suspense fallback={<ViewLoadingFallback />}>
            {section === 'home' && (
              <HomeFeed
                currentUser={user}
                highlightedPostId={highlightedPostId}
                wsEvent={wsEvent}
                onClearHighlightedPost={() => {
                  setHighlightedPostId(null);
                  if (window.location.search.includes('post=')) {
                    const nextUrl = new URL(window.location.href);
                    nextUrl.searchParams.delete('post');
                    window.history.replaceState({}, '', `${nextUrl.pathname}${nextUrl.search}`);
                  }
                }}
                onOpenProfile={handleOpenProfile}
                onOpenCircle={(circleId, circlePostId) => {
                  setActiveCircleId(circleId);
                  setHighlightedCirclePostId(circlePostId ?? null);
                  setSection('circles');
                  setDrawerOpen(false);
                }}
                onOpenConversation={(convId) => {
                  setActiveConversationId(convId);
                  setSection('messenger');
                  setDrawerOpen(false);
                }}
              />
            )}
            {section === 'people' && (
              <FindPeople onStartChat={handleStartChat} onOpenProfile={handleOpenProfile} />
            )}
            {section === 'messenger' && (
              <MessengerView
                currentUser={user}
                initialConversationId={activeConversationId}
                wsEvent={wsEvent}
                sendWsPayload={sendWsPayload}
                onConversationsChanged={loadSidebarContext}
                onOpenProfile={handleOpenProfile}
              />
            )}
            {section === 'videos' && <VideosHub onOpenProfile={handleOpenProfile} />}
            {section === 'circles' && (
              <CirclesView
                currentUser={user}
                initialCircleId={activeCircleId}
                highlightedPostId={highlightedCirclePostId}
                onClearHighlightedPost={() => {
                  setHighlightedCirclePostId(null);
                  if (window.location.search.includes('circlePost=')) {
                    const nextUrl = new URL(window.location.href);
                    nextUrl.searchParams.delete('circlePost');
                    window.history.replaceState({}, '', `${nextUrl.pathname}${nextUrl.search}`);
                  }
                }}
                onOpenProfile={handleOpenProfile}
                onOpenConversation={(convId) => {
                  setActiveConversationId(convId);
                  setSection('messenger');
                  setDrawerOpen(false);
                }}
              />
            )}
            {section === 'profile' && (
              <ProfileAndFollows
                currentUser={user}
                targetUserId={profileUserId || user.id}
                onUserUpdated={(updated) => setUser(updated)}
                onStartChat={handleStartChat}
                onSelectUser={handleOpenProfile}
              />
            )}
            {section === 'notifications' && (
              <NotificationsView onNotificationsRead={loadSidebarContext} />
            )}
            {section === 'settings' && (
              <SettingsView
                currentUser={user}
                activeTheme={themeMode}
                onThemeChange={handleThemeChange}
                onUserUpdated={(updated) => setUser(updated)}
              />
            )}
            {section === 'admin' && user.role === 'admin' && (
              <AdminDashboard onOpenProfile={handleOpenProfile} />
            )}
          </Suspense>
        </main>

        {/* Column 3: Right Sidebar — Online Members & Connection Requests (Desktop lg+) */}
        <aside className="hidden lg:flex flex-col gap-5 w-[290px] shrink-0 sticky top-[76px] h-[calc(100vh-96px)] overflow-y-auto">
          {/* Online Members */}
          <div className="htv-card rounded-2xl p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="font-display font-bold text-sm">Online Members</h3>
              <span className="text-xs font-mono-tabular text-emerald-600 dark:text-emerald-400">
                {onlineMembers.length} active
              </span>
            </div>
            {onlineMembers.length === 0 ? (
              <p className="text-xs text-[var(--htv-text-dim)]">
                No other members currently visible online.
              </p>
            ) : (
              <div className="space-y-2">
                {onlineMembers.map((member) => (
                  <div
                    key={member.id}
                    className="flex items-center justify-between gap-2 p-2 rounded-xl htv-elevated"
                  >
                    <button
                      type="button"
                      onClick={() => handleOpenProfile(member.id)}
                      className="flex items-center gap-2.5 min-w-0 text-left cursor-pointer"
                    >
                      <Avatar
                        src={member.avatar_url}
                        name={member.name}
                        size="sm"
                        isOnline
                        showOnlineRing
                      />
                      <div className="min-w-0">
                        <div className="flex items-center gap-1">
                          <span className="text-xs font-semibold truncate">{member.name}</span>
                          <VerifiedBadge verified={member.is_verified} />
                        </div>
                        <p className="text-[11px] text-[var(--htv-text-dim)] truncate">
                          @{member.username}
                        </p>
                      </div>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleStartChat(member.id)}
                      aria-label={`Message ${member.name}`}
                      className="p-2 rounded-lg hover:bg-[var(--htv-hover)] text-orange-600 dark:text-orange-300 cursor-pointer shrink-0"
                    >
                      <MessageSquare className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Connection Requests */}
          <div className="htv-card rounded-2xl p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="font-display font-bold text-sm">Connection Requests</h3>
              <span className="text-xs font-mono-tabular text-[var(--htv-text-dim)]">
                {connectionRequests.length}
              </span>
            </div>

            {connectionRequests.length === 0 ? (
              <p className="text-xs text-[var(--htv-text-dim)]">No pending requests.</p>
            ) : (
              <div className="space-y-2.5">
                {connectionRequests.map((req) => (
                  <div key={req.connection_id} className="htv-elevated rounded-xl p-3 space-y-2.5">
                    <button
                      type="button"
                      onClick={() => handleOpenProfile(req.user_id)}
                      className="flex items-center gap-2.5 text-left w-full cursor-pointer"
                    >
                      <Avatar src={req.avatar_url} name={req.name} size="sm" />
                      <div className="min-w-0">
                        <div className="flex items-center gap-1">
                          <span className="text-xs font-semibold truncate">{req.name}</span>
                          <VerifiedBadge verified={req.is_verified} />
                        </div>
                        <p className="text-[11px] text-[var(--htv-text-dim)] truncate">
                          @{req.username}
                        </p>
                      </div>
                    </button>

                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => handleRespondConnection(req.connection_id, 'accept')}
                        className="flex-1 py-1.5 rounded-lg htv-gradient-btn text-xs font-semibold inline-flex items-center justify-center gap-1 cursor-pointer"
                      >
                        <Check className="w-3.5 h-3.5" />
                        Accept
                      </button>
                      <button
                        type="button"
                        onClick={() => handleRespondConnection(req.connection_id, 'reject')}
                        className="flex-1 py-1.5 rounded-lg htv-elevated hover:bg-[var(--htv-hover)] text-xs font-medium text-[var(--htv-text-muted)] cursor-pointer"
                      >
                        Decline
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </aside>
      </div>

      {/* Fixed 5-Button Mobile Bottom Thumb Navigation (< lg) */}
      <nav className="lg:hidden fixed bottom-0 left-0 right-0 z-30 min-h-16 pb-[env(safe-area-inset-bottom)] htv-glass border-t grid grid-cols-5 items-center">
        {(
          [
            { id: 'home', label: 'Home', icon: Home },
            { id: 'people', label: 'People', icon: Users },
            { id: 'messenger', label: 'Chats', icon: MessageSquare, badge: unreadMessages },
            { id: 'videos', label: 'Videos', icon: Video },
            { id: 'profile', label: 'Profile', icon: User },
          ] as const
        ).map((tab) => {
          const Icon = tab.icon;
          const active = section === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => selectNav(tab.id)}
              className={`relative min-h-[48px] flex flex-col items-center justify-center gap-0.5 cursor-pointer ${
                active ? 'text-orange-600 dark:text-orange-400' : 'text-[var(--htv-text-muted)]'
              }`}
            >
              <Icon className="w-5 h-5" />
              <span className="text-[10px] font-medium tracking-tight">{tab.label}</span>
              {'badge' in tab && tab.badge !== undefined && tab.badge > 0 && (
                <span className="absolute top-1.5 right-1/4 px-1 min-w-[16px] h-4 rounded-full bg-orange-500 text-white text-[10px] font-mono-tabular font-bold flex items-center justify-center">
                  {tab.badge}
                </span>
              )}
            </button>
          );
        })}
      </nav>
      {/* Deep-linked Group Invite Modal */}
      {pendingGroupInviteCode && (
        <Suspense fallback={null}>
          <GroupInviteJoinModal
            inviteCode={pendingGroupInviteCode}
            onClose={() => {
              setPendingGroupInviteCode(null);
              if (window.location.search.includes('group=')) {
                window.history.replaceState({}, '', window.location.pathname);
              }
            }}
            onJoinedConversation={(convId) => {
              setActiveConversationId(convId);
              setSection('messenger');
              loadSidebarContext();
            }}
            onOpenAdminProfile={handleOpenProfile}
          />
        </Suspense>
      )}
      <OfflineIndicator />
    </div>
  );
}
