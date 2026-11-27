import React, { Profiler, useEffect, useRef } from 'react';

const IS_DEV = Boolean(import.meta.env?.DEV);

const SLOW_API_THRESHOLD_MS = 250;
const SLOW_RENDER_THRESHOLD_MS = 16;
const MAX_HISTORY = 100;

interface ApiMetric {
  method: string;
  endpoint: string;
  durationMs: number;
  status: number;
  ok: boolean;
  timestamp: string;
}

interface RenderMetric {
  component: string;
  phase: 'mount' | 'update' | 'nested-update';
  actualDurationMs: number;
  renderCount: number;
  timestamp: string;
}

interface PerfStore {
  api: ApiMetric[];
  renders: RenderMetric[];
  summary: () => void;
  clear: () => void;
}

function getStore(): PerfStore | null {
  if (!IS_DEV || typeof window === 'undefined') return null;
  const win = window as Window & { __HTV_PERF__?: PerfStore };
  if (!win.__HTV_PERF__) {
    const store: PerfStore = {
      api: [],
      renders: [],
      summary() {
        const apiByEndpoint = new Map<
          string,
          { count: number; totalMs: number; maxMs: number; errors: number }
        >();
        for (const item of store.api) {
          const key = `${item.method} ${item.endpoint}`;
          const prev = apiByEndpoint.get(key) || { count: 0, totalMs: 0, maxMs: 0, errors: 0 };
          apiByEndpoint.set(key, {
            count: prev.count + 1,
            totalMs: prev.totalMs + item.durationMs,
            maxMs: Math.max(prev.maxMs, item.durationMs),
            errors: prev.errors + (item.ok ? 0 : 1),
          });
        }
        const apiRows = Array.from(apiByEndpoint.entries())
          .map(([endpoint, s]) => ({
            endpoint,
            calls: s.count,
            avgMs: Number((s.totalMs / s.count).toFixed(1)),
            maxMs: Number(s.maxMs.toFixed(1)),
            errors: s.errors,
          }))
          .sort((a, b) => b.maxMs - a.maxMs);

        const renderByComp = new Map<
          string,
          { count: number; totalMs: number; maxMs: number }
        >();
        for (const item of store.renders) {
          const prev = renderByComp.get(item.component) || { count: 0, totalMs: 0, maxMs: 0 };
          renderByComp.set(item.component, {
            count: prev.count + 1,
            totalMs: prev.totalMs + item.actualDurationMs,
            maxMs: Math.max(prev.maxMs, item.actualDurationMs),
          });
        }
        const renderRows = Array.from(renderByComp.entries())
          .map(([component, s]) => ({
            component,
            commits: s.count,
            avgMs: Number((s.totalMs / s.count).toFixed(2)),
            maxMs: Number(s.maxMs.toFixed(2)),
          }))
          .sort((a, b) => b.maxMs - a.maxMs);

        console.group('[HushTalkVoice Dev Perf Summary]');
        if (apiRows.length > 0) console.table(apiRows);
        if (renderRows.length > 0) console.table(renderRows);
        console.groupEnd();
      },
      clear() {
        store.api.length = 0;
        store.renders.length = 0;
      },
    };
    win.__HTV_PERF__ = store;
  }
  return win.__HTV_PERF__;
}

function normalizeEndpoint(rawPath: string): string {
  const [pathname] = rawPath.split('?');
  return pathname.replace(/\/\d+(?=\/|$)/g, '/:id');
}

export function trackApiLatency(
  path: string,
  method: string,
  durationMs: number,
  status: number,
  ok: boolean
): void {
  if (!IS_DEV) return;
  const rounded = Number(durationMs.toFixed(1));
  const metric: ApiMetric = {
    method: method.toUpperCase(),
    endpoint: normalizeEndpoint(path),
    durationMs: rounded,
    status,
    ok,
    timestamp: new Date().toISOString(),
  };

  const store = getStore();
  if (store) {
    store.api.push(metric);
    if (store.api.length > MAX_HISTORY) store.api.shift();
  }

  if (durationMs >= SLOW_API_THRESHOLD_MS) {
    console.warn(
      `[Perf:API SLOW] ${metric.method} ${path} -> ${status} (${rounded}ms)`
    );
  } else {
    console.debug(
      `[Perf:API] ${metric.method} ${path} -> ${status} (${rounded}ms)`
    );
  }
}

export function trackRenderTiming(
  component: string,
  phase: 'mount' | 'update' | 'nested-update',
  actualDurationMs: number,
  renderCount = 1
): void {
  if (!IS_DEV) return;
  const rounded = Number(actualDurationMs.toFixed(2));
  const store = getStore();
  if (store) {
    store.renders.push({
      component,
      phase,
      actualDurationMs: rounded,
      renderCount,
      timestamp: new Date().toISOString(),
    });
    if (store.renders.length > MAX_HISTORY) store.renders.shift();
  }

  if (actualDurationMs >= SLOW_RENDER_THRESHOLD_MS) {
    console.warn(
      `[Perf:Render SLOW] <${component}> (${phase} #${renderCount}) took ${rounded}ms`
    );
  } else if (phase === 'mount') {
    console.debug(
      `[Perf:Render] <${component}> mounted in ${rounded}ms`
    );
  }
}

/**
 * Lightweight hook to measure per-commit render duration in dev mode only.
 * Zero-cost no-op in production builds.
 */
export function useRenderPerf(componentName: string): void {
  const renderCountRef = useRef(0);
  const startMs = IS_DEV && typeof performance !== 'undefined' ? performance.now() : 0;
  renderCountRef.current += 1;

  useEffect(() => {
    if (!IS_DEV || typeof performance === 'undefined') return;
    const durationMs = performance.now() - startMs;
    const count = renderCountRef.current;
    trackRenderTiming(componentName, count === 1 ? 'mount' : 'update', durationMs, count);
  });
}

interface PerfProfilerProps {
  id: string;
  children: React.ReactNode;
}

/**
 * Wraps subtrees with React.Profiler in development only to surface slow commits.
 */
export const PerfProfiler: React.FC<PerfProfilerProps> = ({ id, children }) => {
  if (!IS_DEV) {
    return React.createElement(React.Fragment, null, children);
  }
  return React.createElement(
    Profiler,
    {
      id,
      onRender: (profilerId, phase, actualDuration) => {
        trackRenderTiming(profilerId, phase, actualDuration);
      },
    },
    children
  );
};
