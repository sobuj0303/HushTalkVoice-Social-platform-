import React, { useEffect, useRef, useState } from 'react';
import {
  Play,
  Pause,
  Maximize2,
  Minimize2,
  Shrink,
  Expand,
  X,
  Volume2,
  VolumeX,
  RotateCcw,
  RotateCw,
  Settings2,
  Forward,
  Trash2,
  Loader2,
} from 'lucide-react';
import { Avatar } from './Avatar';
import { apiFetch, getStoredToken } from '../lib/api';
import { formatFileSize } from '../shared/validation';
import type { ChatMessage } from '../shared/types';

export type VideoPlaybackQuality = '144' | '240' | '360' | '480' | '720' | 'original';

const QUALITY_OPTIONS: { value: VideoPlaybackQuality; label: string; hint: string }[] = [
  { value: '144', label: '144p', hint: 'Lowest MB' },
  { value: '240', label: '240p', hint: 'Low MB' },
  { value: '360', label: '360p', hint: 'Balanced' },
  { value: '480', label: '480p', hint: 'Clear' },
  { value: '720', label: '720p', hint: 'HD' },
  { value: 'original', label: 'Original', hint: 'Full MB' },
];

export function formatMessageTimestamp(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  const total = Math.floor(sec);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

function buildVideoSrc(mediaUrl: string, quality: VideoPlaybackQuality): string {
  if (!mediaUrl || quality === 'original') return mediaUrl;
  const params = new URLSearchParams({
    url: mediaUrl,
    quality,
  });
  const token = getStoredToken();
  if (token) params.set('token', token);
  return `/api/media/video-variant?${params.toString()}`;
}

interface GroupVideoBubbleCardProps {
  message: ChatMessage;
  onOpen: (message: ChatMessage, preferredQuality?: VideoPlaybackQuality) => void;
  shouldIgnoreClick?: () => boolean;
}

/**
 * Renders a group chat video as a compact static picture-like preview card.
 * Never autoplays; playback only begins when the user explicitly clicks it.
 */
export const GroupVideoBubbleCard: React.FC<GroupVideoBubbleCardProps> = ({
  message,
  onOpen,
  shouldIgnoreClick,
}) => {
  const previewRef = useRef<HTMLVideoElement>(null);
  const [durationSec, setDurationSec] = useState<number>(0);

  const sizeLabel = formatFileSize(message.media_size_bytes);
  const dateLabel = formatMessageTimestamp(message.created_at);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={(e) => {
        e.stopPropagation();
        if (shouldIgnoreClick?.()) return;
        onOpen(message, 'original');
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen(message, 'original');
        }
      }}
      className="group relative w-full max-w-[256px] sm:max-w-[276px] aspect-video rounded-xl overflow-hidden bg-slate-950 border border-white/15 cursor-pointer select-none focus:outline-none focus:ring-2 focus:ring-purple-500"
      aria-label={`Open video from ${message.sender_name}`}
    >
      {/* Static video frame (never autoplays, acts like a picture preview) */}
      <video
        ref={previewRef}
        src={`${message.media_url}#t=0.2`}
        preload="metadata"
        muted
        playsInline
        onLoadedMetadata={(e) => {
          const el = e.currentTarget;
          if (Number.isFinite(el.duration)) setDurationSec(el.duration);
        }}
        className="w-full h-full object-cover pointer-events-none transition-transform duration-200 group-hover:scale-[1.02]"
      />

      {/* Measured contrast scrim */}
      <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/25 to-black/65 pointer-events-none" />

      {/* Top-left: Sender small avatar + name + date */}
      <div className="absolute top-1.5 left-1.5 right-1.5 flex items-center gap-1.5 pointer-events-none">
        <Avatar src={message.sender_avatar} name={message.sender_name} size="xs" />
        <div className="min-w-0 flex-1 text-left">
          <p className="text-[11px] font-semibold text-white truncate leading-tight">
            {message.sender_name}
          </p>
          <p className="text-[10px] text-white/75 truncate leading-tight">{dateLabel}</p>
        </div>
      </div>

      {/* Center Play trigger */}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <div className="w-10 h-10 rounded-full bg-gradient-to-r from-purple-600 to-orange-500 text-white shadow-lg flex items-center justify-center transition-transform duration-150 group-hover:scale-105">
          <Play className="w-4 h-4 fill-current ml-0.5" />
        </div>
      </div>

      {/* Bottom meta bar: Quick 144p trigger + Duration + MB size */}
      <div className="absolute bottom-1.5 left-1.5 right-1.5 flex items-center justify-between gap-2 text-[10px] font-mono-tabular text-white/95">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            if (shouldIgnoreClick?.()) return;
            onOpen(message, '144');
          }}
          className="px-2 py-0.5 rounded-md bg-black/65 hover:bg-purple-600 text-white border border-white/20 text-[10px] font-semibold cursor-pointer"
          title="Watch in 144p Data Saver mode"
        >
          144p Saver
        </button>
        <span className="flex items-center gap-1 pointer-events-none">
          {sizeLabel && <span>{sizeLabel}</span>}
          {sizeLabel && durationSec > 0 && <span aria-hidden="true">·</span>}
          {durationSec > 0 && <span>{formatDuration(durationSec)}</span>}
        </span>
      </div>
    </div>
  );
};

interface GroupVideoPlayerModalProps {
  message: ChatMessage | null;
  initialQuality?: VideoPlaybackQuality;
  canDelete?: boolean;
  onClose: () => void;
  onReact: (messageId: number, emoji: string) => void;
  onForward?: (message: ChatMessage) => void;
  onDelete?: (messageId: number) => void;
}

export const GroupVideoPlayerModal: React.FC<GroupVideoPlayerModalProps> = ({
  message,
  initialQuality = 'original',
  canDelete = false,
  onClose,
  onReact,
  onForward,
  onDelete,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const pendingResumeRef = useRef<{ time: number; shouldPlay: boolean } | null>(null);

  const [viewMode, setViewMode] = useState<'normal' | 'full' | 'mini'>('normal');
  const [quality, setQuality] = useState<VideoPlaybackQuality>(initialQuality);
  const [showQualityMenu, setShowQualityMenu] = useState(false);
  const [switchingQuality, setSwitchingQuality] = useState(false);
  const [qualitySizes, setQualitySizes] = useState<Record<string, { cached: boolean; size_bytes: number }>>({});

  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [muted, setMuted] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [streamError, setStreamError] = useState('');

  const fetchQualityInfo = async (mediaUrl: string) => {
    try {
      const info = await apiFetch<{
        qualities: Record<string, { cached: boolean; size_bytes: number }>;
      }>(`/api/media/video-variants-info?url=${encodeURIComponent(mediaUrl)}`);
      setQualitySizes(info.qualities || {});
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    if (!message) return;
    setViewMode('normal');
    setQuality(initialQuality);
    setShowQualityMenu(false);
    setSwitchingQuality(initialQuality !== 'original');
    setStreamError('');
    setPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    setSpeed(1);
    pendingResumeRef.current = { time: 0, shouldPlay: true };
    fetchQualityInfo(message.media_url);
  }, [message?.id, initialQuality]);

  if (!message) return null;

  const activeSrc = buildVideoSrc(message.media_url, quality);

  const handleSelectQuality = (nextQ: VideoPlaybackQuality) => {
    setShowQualityMenu(false);
    if (nextQ === quality) return;
    const v = videoRef.current;
    const resumeTime = v ? v.currentTime : currentTime;
    const wasPlaying = v ? !v.paused : playing;
    pendingResumeRef.current = { time: resumeTime, shouldPlay: wasPlaying };
    setSwitchingQuality(true);
    setStreamError('');
    setQuality(nextQ);
  };

  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      v.play().then(() => setPlaying(true)).catch(() => {});
    } else {
      v.pause();
      setPlaying(false);
    }
  };

  const handleSeek = (nextSec: number) => {
    const v = videoRef.current;
    if (!v || !Number.isFinite(duration)) return;
    const clamped = Math.max(0, Math.min(duration, nextSec));
    v.currentTime = clamped;
    setCurrentTime(clamped);
  };

  const skipBy = (delta: number) => {
    handleSeek((videoRef.current?.currentTime || currentTime) + delta);
  };

  const toggleNativeFullscreen = async () => {
    if (viewMode === 'full') {
      if (document.fullscreenElement) {
        await document.exitFullscreen().catch(() => {});
      }
      setViewMode('normal');
      return;
    }
    setViewMode('full');
    if (containerRef.current && containerRef.current.requestFullscreen) {
      containerRef.current.requestFullscreen().catch(() => {});
    }
  };

  const cycleSpeed = () => {
    const speeds = [1, 1.25, 1.5, 2, 0.75];
    const next = speeds[(speeds.indexOf(speed) + 1) % speeds.length];
    setSpeed(next);
    if (videoRef.current) videoRef.current.playbackRate = next;
  };

  const onVideoReadyMetadata = (el: HTMLVideoElement) => {
    setDuration(el.duration || 0);
    el.playbackRate = speed;
    if (pendingResumeRef.current) {
      const { time, shouldPlay } = pendingResumeRef.current;
      pendingResumeRef.current = null;
      if (time > 0 && Number.isFinite(el.duration)) {
        el.currentTime = Math.min(time, el.duration);
        setCurrentTime(el.currentTime);
      }
      if (shouldPlay) {
        el.play()
          .then(() => setPlaying(true))
          .catch(() => setPlaying(false));
      }
    }
    setSwitchingQuality(false);
    if (quality !== 'original') {
      fetchQualityInfo(message.media_url);
    }
  };

  const activeVariantBytes = qualitySizes[quality]?.size_bytes || (quality === 'original' ? message.media_size_bytes || 0 : 0);
  const sizeLabel = formatFileSize(activeVariantBytes || message.media_size_bytes);
  const dateLabel = formatMessageTimestamp(message.created_at);
  const loved = message.reactions.some((r) => r.emoji === '❤️' && r.user_reacted);
  const liked = message.reactions.some((r) => r.emoji === '👍' && r.user_reacted);

  // Mini floating docked window
  if (viewMode === 'mini') {
    return (
      <div className="fixed bottom-20 lg:bottom-5 right-4 z-50 w-80 sm:w-96 rounded-2xl overflow-hidden bg-slate-950 text-white border border-white/15 shadow-2xl">
        <div className="px-3 py-2 bg-slate-900/95 flex items-center justify-between gap-2 border-b border-white/10">
          <div className="flex items-center gap-2 min-w-0">
            <Avatar src={message.sender_avatar} name={message.sender_name} size="xs" />
            <div className="min-w-0">
              <p className="text-xs font-semibold truncate">{message.sender_name}</p>
              <p className="text-[10px] text-slate-400 truncate">
                {quality === 'original' ? 'Original' : `${quality}p`}
                {sizeLabel ? ` · ${sizeLabel}` : ''}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={() => handleSelectQuality(quality === '144' ? 'original' : '144')}
              className={`px-2 py-1 rounded-lg text-[10px] font-semibold cursor-pointer ${
                quality === '144' ? 'bg-purple-600 text-white' : 'bg-white/10 text-slate-200'
              }`}
              title="Toggle 144p Data Saver"
            >
              {quality === '144' ? '144p' : '144p Saver'}
            </button>
            <button
              type="button"
              onClick={() => setViewMode('normal')}
              title="Expand player"
              className="p-1.5 rounded-lg hover:bg-white/10 text-slate-200 cursor-pointer"
            >
              <Expand className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={toggleNativeFullscreen}
              title="Full screen"
              className="p-1.5 rounded-lg hover:bg-white/10 text-slate-200 cursor-pointer"
            >
              <Maximize2 className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={onClose}
              title="Close video"
              className="p-1.5 rounded-lg hover:bg-rose-500/20 text-slate-200 hover:text-rose-300 cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        <div className="relative aspect-video bg-black" onClick={togglePlay}>
          <video
            key={activeSrc}
            ref={videoRef}
            src={activeSrc}
            playsInline
            muted={muted}
            onLoadedMetadata={(e) => onVideoReadyMetadata(e.currentTarget)}
            onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
            onEnded={() => setPlaying(false)}
            onError={() => {
              setSwitchingQuality(false);
              setStreamError('Could not load selected resolution.');
            }}
            className="w-full h-full object-contain cursor-pointer"
          />
          {switchingQuality && (
            <div className="absolute inset-0 bg-black/60 flex flex-col items-center justify-center gap-1.5 text-xs">
              <Loader2 className="w-5 h-5 animate-spin text-orange-400" />
              <span>Preparing {quality === 'original' ? 'Original' : `${quality}p`}...</span>
            </div>
          )}
        </div>

        <div className="px-3 py-2 bg-slate-900 space-y-1.5">
          <input
            type="range"
            min={0}
            max={duration || 1}
            step={0.05}
            value={currentTime}
            onChange={(e) => handleSeek(Number(e.target.value))}
            aria-label="Seek video timeline"
            className="w-full accent-orange-500 cursor-pointer h-1.5"
          />
          <div className="flex items-center justify-between text-[11px] font-mono-tabular text-slate-300">
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={togglePlay}
                className="p-1 rounded hover:bg-white/10 cursor-pointer"
                aria-label={playing ? 'Pause' : 'Play'}
              >
                {playing ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
              </button>
              <button
                type="button"
                onClick={() => skipBy(-10)}
                className="p-1 rounded hover:bg-white/10 cursor-pointer"
                title="-10s"
              >
                <RotateCcw className="w-3 h-3" />
              </button>
              <button
                type="button"
                onClick={() => skipBy(10)}
                className="p-1 rounded hover:bg-white/10 cursor-pointer"
                title="+10s"
              >
                <RotateCw className="w-3 h-3" />
              </button>
            </div>
            <span>
              {formatDuration(currentTime)} / {formatDuration(duration)}
            </span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/85 backdrop-blur-sm flex items-center justify-center p-2 sm:p-4">
      <div
        ref={containerRef}
        className={`bg-slate-950 text-white flex flex-col overflow-hidden border border-white/15 shadow-2xl ${
          viewMode === 'full' ? 'w-full h-full rounded-none' : 'w-full max-w-4xl rounded-2xl'
        }`}
      >
        {/* Top Sender Info & Window Mode Controls */}
        <header className="px-4 py-3 bg-slate-900/95 border-b border-white/10 flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2.5 min-w-0">
            <Avatar src={message.sender_avatar} name={message.sender_name} size="sm" />
            <div className="min-w-0">
              <p className="text-sm font-semibold truncate">{message.sender_name}</p>
              <p className="text-xs text-slate-400 truncate">
                {dateLabel}
                {sizeLabel ? ` · ${sizeLabel}` : ''}
                {quality !== 'original' ? ` · ${quality}p` : ' · Original'}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1.5 shrink-0 flex-wrap">
            {/* Quick 144p Data Saver toggle button */}
            <button
              type="button"
              onClick={() => handleSelectQuality(quality === '144' ? 'original' : '144')}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer ${
                quality === '144'
                  ? 'bg-gradient-to-r from-purple-600 to-orange-500 text-white'
                  : 'bg-white/10 hover:bg-white/15 text-slate-200'
              }`}
              title="Watch in 144p to save mobile MB"
            >
              144p {quality === '144' ? 'Active' : 'Data Saver'}
            </button>

            <button
              type="button"
              onClick={() => setViewMode('mini')}
              className="px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/15 text-xs font-medium inline-flex items-center gap-1.5 cursor-pointer"
              title="Shrink to small floating player"
            >
              <Shrink className="w-3.5 h-3.5" />
              Small
            </button>
            <button
              type="button"
              onClick={toggleNativeFullscreen}
              className="px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/15 text-xs font-medium inline-flex items-center gap-1.5 cursor-pointer"
              title={viewMode === 'full' ? 'Exit full screen' : 'Full screen'}
            >
              {viewMode === 'full' ? (
                <>
                  <Minimize2 className="w-3.5 h-3.5" />
                  Exit Full
                </>
              ) : (
                <>
                  <Maximize2 className="w-3.5 h-3.5" />
                  Full Screen
                </>
              )}
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close video player"
              className="p-2 rounded-lg bg-white/10 hover:bg-rose-500/25 text-slate-200 hover:text-rose-200 cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </header>

        {/* Video Viewport */}
        <div
          className={`relative bg-black flex items-center justify-center flex-1 ${
            viewMode === 'full' ? 'min-h-0' : 'aspect-video'
          }`}
          onClick={togglePlay}
        >
          <video
            key={activeSrc}
            ref={videoRef}
            src={activeSrc}
            playsInline
            muted={muted}
            onLoadedMetadata={(e) => onVideoReadyMetadata(e.currentTarget)}
            onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
            onEnded={() => setPlaying(false)}
            onError={() => {
              setSwitchingQuality(false);
              setStreamError('Could not load this resolution stream. Try Original.');
            }}
            className="w-full h-full max-h-[72vh] object-contain cursor-pointer"
          />

          {switchingQuality && (
            <div className="absolute inset-0 bg-black/65 flex flex-col items-center justify-center gap-2 text-xs font-medium pointer-events-none">
              <Loader2 className="w-7 h-7 animate-spin text-orange-400" />
              <span>
                Optimizing {quality === 'original' ? 'Original' : `${quality}p`} stream...
              </span>
            </div>
          )}

          {!playing && !switchingQuality && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none bg-black/25">
              <div className="w-16 h-16 rounded-full bg-gradient-to-r from-purple-600 to-orange-500 flex items-center justify-center shadow-2xl">
                <Play className="w-7 h-7 fill-current ml-0.5" />
              </div>
            </div>
          )}

          {streamError && (
            <div className="absolute bottom-3 left-3 right-3 bg-rose-950/90 border border-rose-500/40 rounded-lg px-3 py-2 text-xs text-rose-200 text-center">
              {streamError}
            </div>
          )}
        </div>

        {/* Custom Scrub/Drag Bar + Playback Controls + Quality Switcher + Actions */}
        <div className="px-4 py-3 bg-slate-900 border-t border-white/10 space-y-2.5">
          <div className="flex items-center gap-3">
            <span className="text-xs font-mono-tabular text-slate-300 w-11">
              {formatDuration(currentTime)}
            </span>
            <input
              type="range"
              min={0}
              max={duration || 1}
              step={0.05}
              value={currentTime}
              onChange={(e) => handleSeek(Number(e.target.value))}
              aria-label="Drag to seek video"
              className="flex-1 accent-orange-500 cursor-pointer h-2"
            />
            <span className="text-xs font-mono-tabular text-slate-300 w-11 text-right">
              {formatDuration(duration)}
            </span>
          </div>

          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-1.5 flex-wrap">
              <button
                type="button"
                onClick={togglePlay}
                className="px-3.5 py-2 rounded-xl bg-gradient-to-r from-purple-600 to-orange-500 text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer"
              >
                {playing ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                {playing ? 'Pause' : 'Play'}
              </button>
              <button
                type="button"
                onClick={() => skipBy(-10)}
                className="px-2.5 py-2 rounded-xl bg-white/10 hover:bg-white/15 text-xs font-mono-tabular inline-flex items-center gap-1 cursor-pointer"
                title="Rewind 10s"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                10s
              </button>
              <button
                type="button"
                onClick={() => skipBy(10)}
                className="px-2.5 py-2 rounded-xl bg-white/10 hover:bg-white/15 text-xs font-mono-tabular inline-flex items-center gap-1 cursor-pointer"
                title="Forward 10s"
              >
                10s
                <RotateCw className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={() => {
                  const next = !muted;
                  setMuted(next);
                  if (videoRef.current) videoRef.current.muted = next;
                }}
                className="p-2 rounded-xl bg-white/10 hover:bg-white/15 cursor-pointer"
                aria-label={muted ? 'Unmute video' : 'Mute video'}
              >
                {muted ? <VolumeX className="w-4 h-4 text-rose-300" /> : <Volume2 className="w-4 h-4" />}
              </button>
              <button
                type="button"
                onClick={cycleSpeed}
                className="px-2.5 py-2 rounded-xl bg-white/10 hover:bg-white/15 text-xs font-mono-tabular cursor-pointer"
                title="Playback speed"
              >
                {speed}x
              </button>

              {/* Resolution Quality Picker (144p -> Original) */}
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setShowQualityMenu((s) => !s)}
                  className="px-3 py-2 rounded-xl bg-white/10 hover:bg-white/15 text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer"
                  title="Change video quality (144p for low MB)"
                >
                  <Settings2 className="w-3.5 h-3.5 text-orange-400" />
                  <span>{quality === 'original' ? 'Original' : `${quality}p`}</span>
                </button>

                {showQualityMenu && (
                  <div className="absolute bottom-11 left-0 z-40 w-52 rounded-xl bg-slate-900 border border-white/15 shadow-2xl p-1.5 space-y-0.5">
                    <p className="px-2.5 py-1 text-[10px] font-semibold text-slate-400 uppercase tracking-wide">
                      Playback Quality
                    </p>
                    {QUALITY_OPTIONS.map((opt) => {
                      const info = qualitySizes[opt.value];
                      const optSize = info?.size_bytes ? formatFileSize(info.size_bytes) : opt.hint;
                      const active = quality === opt.value;
                      return (
                        <button
                          key={opt.value}
                          type="button"
                          onClick={() => handleSelectQuality(opt.value)}
                          className={`w-full px-2.5 py-1.5 rounded-lg text-left text-xs flex items-center justify-between cursor-pointer ${
                            active
                              ? 'bg-gradient-to-r from-purple-600 to-orange-500 text-white font-semibold'
                              : 'hover:bg-white/10 text-slate-200'
                          }`}
                        >
                          <span>{opt.label}</span>
                          <span className="text-[10px] font-mono-tabular opacity-85">{optSize}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            <div className="flex items-center gap-1.5 flex-wrap">
              <button
                type="button"
                onClick={() => onReact(message.id, '👍')}
                className={`px-3 py-1.5 rounded-xl text-xs font-semibold cursor-pointer ${
                  liked ? 'bg-purple-600 text-white' : 'bg-white/10 hover:bg-white/15 text-slate-200'
                }`}
              >
                👍 Like
              </button>
              <button
                type="button"
                onClick={() => onReact(message.id, '❤️')}
                className={`px-3 py-1.5 rounded-xl text-xs font-semibold cursor-pointer ${
                  loved ? 'bg-rose-600 text-white' : 'bg-white/10 hover:bg-white/15 text-slate-200'
                }`}
              >
                ❤️ Love
              </button>
              {onForward && (
                <button
                  type="button"
                  onClick={() => onForward(message)}
                  className="px-3 py-1.5 rounded-xl text-xs font-semibold bg-white/10 hover:bg-white/15 text-slate-200 inline-flex items-center gap-1 cursor-pointer"
                >
                  <Forward className="w-3.5 h-3.5" />
                  Forward
                </button>
              )}
              {canDelete && onDelete && (
                <button
                  type="button"
                  onClick={() => {
                    onDelete(message.id);
                    onClose();
                  }}
                  className="px-3 py-1.5 rounded-xl text-xs font-semibold bg-rose-500/20 hover:bg-rose-500/35 text-rose-200 inline-flex items-center gap-1 cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Delete
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
