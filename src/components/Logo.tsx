import React from 'react';

interface LogoProps {
  compact?: boolean;
}

export const Logo: React.FC<LogoProps> = ({ compact = false }) => {
  return (
    <div className="inline-flex items-center gap-2.5 shrink-0 select-none">
      <svg
        width="36"
        height="36"
        viewBox="0 0 40 40"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="shrink-0 drop-shadow-[0_0_12px_rgba(147,51,234,0.45)]"
        aria-hidden="true"
      >
        <defs>
          <linearGradient id="htv-grad" x1="4" y1="4" x2="36" y2="36" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#A855F7" />
            <stop offset="55%" stopColor="#EC4899" />
            <stop offset="100%" stopColor="#F97316" />
          </linearGradient>
        </defs>
        <rect x="2" y="2" width="36" height="36" rx="11" fill="url(#htv-grad)" fillOpacity="0.14" stroke="url(#htv-grad)" strokeWidth="1.5" />
        {/* Headphone arc */}
        <path
          d="M10.5 22.5V19.5C10.5 14.2533 14.7533 10 20 10C25.2467 10 29.5 14.2533 29.5 19.5V22.5"
          stroke="url(#htv-grad)"
          strokeWidth="2.4"
          strokeLinecap="round"
        />
        {/* Left & Right Earcups */}
        <rect x="8.5" y="20" width="4.2" height="8.5" rx="2.1" fill="url(#htv-grad)" />
        <rect x="27.3" y="20" width="4.2" height="8.5" rx="2.1" fill="url(#htv-grad)" />
        {/* Soundwave bars inside headphones */}
        <path
          d="M16 20V25M20 17.5V27.5M24 20V25"
          stroke="url(#htv-grad)"
          strokeWidth="2.2"
          strokeLinecap="round"
        />
      </svg>
      {!compact && (
        <span className="font-display text-lg font-bold tracking-tight whitespace-nowrap htv-gradient-text">
          HushTalkVoice
        </span>
      )}
    </div>
  );
};
