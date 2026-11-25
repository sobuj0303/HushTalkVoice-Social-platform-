import React, { useEffect, useState } from 'react';
import { BadgeCheck } from 'lucide-react';
import { sanitizeMediaUrl } from '../shared/validation';

interface AvatarProps {
  src?: string;
  name: string;
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
  isOnline?: boolean;
  showOnlineRing?: boolean;
}

const SIZE_MAP = {
  xs: 'w-7 h-7 text-xs',
  sm: 'w-9 h-9 text-xs',
  md: 'w-10 h-10 text-sm',
  lg: 'w-14 h-14 text-base',
  xl: 'w-20 h-20 text-xl',
};

export const Avatar: React.FC<AvatarProps> = ({
  src,
  name,
  size = 'md',
  isOnline = false,
  showOnlineRing = false,
}) => {
  const [imgError, setImgError] = useState(false);
  const safeSrc = sanitizeMediaUrl(src);

  useEffect(() => {
    setImgError(false);
  }, [safeSrc]);

  const initials = (name || 'U')
    .split(' ')
    .map((p) => p[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  return (
    <div className={`relative inline-flex shrink-0 ${SIZE_MAP[size]}`}>
      {safeSrc && !imgError ? (
        <img
          src={safeSrc}
          alt={name}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setImgError(true)}
          className="w-full h-full rounded-full object-cover border border-white/10"
        />
      ) : (
        <div className="w-full h-full rounded-full flex items-center justify-center font-display font-semibold bg-gradient-to-br from-purple-600/80 to-orange-500/80 text-white border border-white/10">
          {initials}
        </div>
      )}
      {showOnlineRing && isOnline && (
        <span
          title="Online"
          className="absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full bg-emerald-400 ring-2 ring-[var(--htv-surface)]"
        />
      )}
    </div>
  );
};

export const VerifiedBadge: React.FC<{ verified?: boolean }> = ({ verified }) => {
  if (!verified) return null;
  return (
    <BadgeCheck
      className="w-4 h-4 text-purple-400 inline-block shrink-0"
      aria-label="Verified member"
    />
  );
};
