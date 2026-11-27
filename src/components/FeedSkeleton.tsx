import React from 'react';

export type FeedSkeletonVariant =
  | 'home'
  | 'aggregated'
  | 'circle'
  | 'switcher'
  | 'circle-workspace';

interface FeedSkeletonProps {
  variant?: FeedSkeletonVariant;
  count?: number;
  label?: string;
}

const CardSkeleton: React.FC<{
  showCircleChip?: boolean;
  showMedia?: boolean;
}> = ({ showCircleChip = false, showMedia = false }) => (
  <div className="htv-card rounded-2xl p-4 sm:p-5 motion-safe:animate-pulse space-y-3.5">
    {showCircleChip && (
      <div className="flex items-center justify-between gap-2 pb-2 border-b border-[var(--htv-border-subtle)]">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-full htv-elevated shrink-0" />
          <div className="h-3 w-28 htv-elevated rounded" />
          <div className="h-3 w-16 htv-elevated rounded" />
        </div>
        <div className="h-2.5 w-16 htv-elevated rounded" />
      </div>
    )}

    <div className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-3 min-w-0">
        <div className="w-10 h-10 rounded-full htv-elevated shrink-0" />
        <div className="space-y-1.5 min-w-0">
          <div className="h-3.5 w-32 htv-elevated rounded" />
          <div className="h-2.5 w-24 htv-elevated rounded" />
        </div>
      </div>
      <div className="w-6 h-6 rounded-lg htv-elevated shrink-0" />
    </div>

    <div className="space-y-2">
      <div className="h-3.5 w-full htv-elevated rounded" />
      <div className="h-3.5 w-5/6 htv-elevated rounded" />
    </div>

    {showMedia && <div className="h-44 w-full htv-elevated rounded-xl" />}

    <div className="flex items-center justify-between pt-2 border-t border-[var(--htv-border-subtle)]">
      <div className="flex items-center gap-2">
        <div className="h-8 w-14 htv-elevated rounded-lg" />
        <div className="h-8 w-14 htv-elevated rounded-lg" />
        <div className="h-8 w-16 htv-elevated rounded-lg" />
      </div>
      <div className="h-8 w-16 htv-elevated rounded-lg" />
    </div>
  </div>
);

export const FeedSkeleton: React.FC<FeedSkeletonProps> = ({
  variant = 'home',
  count = 3,
  label,
}) => {
  if (variant === 'switcher') {
    return (
      <div
        role="status"
        aria-label={label || 'Loading Circles'}
        className="flex items-center gap-2 overflow-x-hidden pb-1"
      >
        {Array.from({ length: count }).map((_, idx) => (
          <div
            key={idx}
            className="h-12 w-48 rounded-xl htv-elevated motion-safe:animate-pulse shrink-0 flex items-center gap-2.5 px-3"
          >
            <div className="w-8 h-8 rounded-full bg-[var(--htv-surface)] shrink-0" />
            <div className="space-y-1.5 flex-1">
              <div className="h-3 w-24 bg-[var(--htv-surface)] rounded" />
              <div className="h-2.5 w-20 bg-[var(--htv-surface)] rounded" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (variant === 'circle-workspace') {
    return (
      <div
        role="status"
        aria-label={label || 'Loading Circle workspace'}
        className="space-y-4 transition-opacity duration-200"
      >
        <div className="htv-card rounded-2xl p-4 sm:p-5 motion-safe:animate-pulse space-y-4">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div className="flex items-start gap-3.5 min-w-0">
              <div className="w-14 h-14 rounded-full htv-elevated shrink-0" />
              <div className="space-y-2">
                <div className="h-4 w-44 htv-elevated rounded" />
                <div className="h-3 w-64 max-w-full htv-elevated rounded" />
                <div className="h-2.5 w-40 htv-elevated rounded" />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <div className="h-9 w-24 htv-elevated rounded-xl" />
              <div className="h-9 w-20 htv-elevated rounded-xl" />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2 p-1 htv-elevated rounded-xl">
            <div className="h-8 rounded-lg bg-[var(--htv-surface)]" />
            <div className="h-8 rounded-lg bg-[var(--htv-surface)]" />
            <div className="h-8 rounded-lg bg-[var(--htv-surface)]" />
          </div>
        </div>
        <CardSkeleton showMedia />
        <CardSkeleton />
      </div>
    );
  }

  const showCircleChip = variant === 'aggregated';

  return (
    <div
      role="status"
      aria-label={label || 'Loading feed posts'}
      className="space-y-4 transition-opacity duration-200"
    >
      {Array.from({ length: count }).map((_, idx) => (
        <CardSkeleton
          key={idx}
          showCircleChip={showCircleChip}
          showMedia={idx === 0}
        />
      ))}
    </div>
  );
};
