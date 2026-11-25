export const MAX_WORDS = 200;
export const MAX_GROUP_MEMBERS = 500;
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50MB fixed max stored cap
export const MAX_RAW_VIDEO_UPLOAD_BYTES = 250 * 1024 * 1024; // Raw video intake before auto-compression under 50MB
export const MIN_GROUP_VIDEO_MB = 5;
export const MAX_GROUP_VIDEO_MB = 50;

export function formatFileSize(bytes?: number | null): string {
  if (!bytes || bytes <= 0) return '';
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const ALLOWED_REACTION_EMOJIS = ['❤️', '👍', '😂', '😮', '🔥'] as const;
export type ReactionEmoji = (typeof ALLOWED_REACTION_EMOJIS)[number];

// Strict allowlist: Gallery Images, Audio, and Video ONLY (all other files blocked)
export const ALLOWED_GALLERY_IMAGE_MIMES = [
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/gif',
] as const;

export const ALLOWED_AUDIO_MIMES = [
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/wave',
  'audio/x-wav',
  'audio/ogg',
  'audio/webm',
  'audio/mp4',
  'audio/aac',
  'audio/m4a',
  'audio/x-m4a',
] as const;

export const ALLOWED_VIDEO_MIMES = [
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'video/x-m4v',
] as const;

export const ALLOWED_GALLERY_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
export const ALLOWED_AUDIO_EXTENSIONS = ['.mp3', '.wav', '.ogg', '.webm', '.m4a', '.aac'];
export const ALLOWED_VIDEO_EXTENSIONS = ['.mp4', '.webm', '.mov', '.m4v'];

export type MediaCategory = 'image' | 'audio' | 'video';

export function classifyAllowedMedia(
  mimeType: string,
  fileName: string
): { valid: boolean; category?: MediaCategory; error?: string } {
  const mime = (mimeType || '').toLowerCase().split(';')[0].trim();
  const extMatch = (fileName || '').toLowerCase().match(/\.[a-z0-9]+$/);
  const ext = extMatch ? extMatch[0] : '';

  if (
    ALLOWED_GALLERY_IMAGE_MIMES.includes(mime as (typeof ALLOWED_GALLERY_IMAGE_MIMES)[number]) ||
    (!mime && ALLOWED_GALLERY_EXTENSIONS.includes(ext))
  ) {
    if (ext && !ALLOWED_GALLERY_EXTENSIONS.includes(ext)) {
      return { valid: false, error: 'Only gallery photos (JPG, PNG, WEBP, GIF) are allowed.' };
    }
    return { valid: true, category: 'image' };
  }

  if (
    ALLOWED_AUDIO_MIMES.includes(mime as (typeof ALLOWED_AUDIO_MIMES)[number]) ||
    (mime.startsWith('audio/') && ALLOWED_AUDIO_EXTENSIONS.includes(ext))
  ) {
    return { valid: true, category: 'audio' };
  }

  if (
    ALLOWED_VIDEO_MIMES.includes(mime as (typeof ALLOWED_VIDEO_MIMES)[number]) ||
    (mime.startsWith('video/') && ALLOWED_VIDEO_EXTENSIONS.includes(ext))
  ) {
    return { valid: true, category: 'video' };
  }

  return {
    valid: false,
    error:
      'File blocked: Only gallery images (JPG, PNG, WEBP, GIF), audio, and video files are allowed. Documents and other files are prohibited.',
  };
}

// Strict anti-spam link detection (Frontend + Backend + DB layer)
const BLOCKED_URL_PATTERNS: RegExp[] = [
  /https?:\/\//i,
  /ftp:\/\//i,
  /\bwww\.[a-z0-9-]+/i,
  /\b[a-z0-9-]+\.(com|net|org|io|co|xyz|tk|me|info|biz|app|dev|tv|gg|ly|in|uk|bd|us|ca|de|fr|ru|cn|ai|club|site|online|store|shop|tech|pro|link|click|top|live|space|fun)\b(\/|\?|#|\s|$|:)/i,
  /\b(bit\.ly|tinyurl\.com|t\.me|wa\.me|goo\.gl|youtu\.be|rb\.gy|cutt\.ly|is\.gd)\b/i,
  /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d+)?(\/|\b)/,
  /[a-z0-9-]+\s*(\[dot\]|\(dot\)|\{\.\}|\[\.\])\s*(com|net|org|io|co|xyz|me|app|dev|bd)/i,
];

export function containsBlockedLink(text: string): { blocked: boolean; reason?: string } {
  if (!text) return { blocked: false };
  const normalized = text.trim();
  for (const pattern of BLOCKED_URL_PATTERNS) {
    if (pattern.test(normalized)) {
      return {
        blocked: true,
        reason: 'External links and URLs (http, https, www, .com, .net, .org, etc.) are strictly prohibited.',
      };
    }
  }
  return { blocked: false };
}

export function countWords(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

export function validateTextField(
  text: string,
  fieldLabel: string,
  options: { maxWords?: number; required?: boolean; maxChars?: number } = {}
): { valid: boolean; error?: string; wordCount: number } {
  const trimmed = (text || '').trim();
  const wordCount = countWords(trimmed);

  if (options.required && !trimmed) {
    return { valid: false, error: `${fieldLabel} cannot be empty.`, wordCount };
  }

  if (options.maxWords && wordCount > options.maxWords) {
    return {
      valid: false,
      error: `${fieldLabel} cannot exceed ${options.maxWords} words (currently ${wordCount}).`,
      wordCount,
    };
  }

  if (options.maxChars && trimmed.length > options.maxChars) {
    return {
      valid: false,
      error: `${fieldLabel} cannot exceed ${options.maxChars} characters.`,
      wordCount,
    };
  }

  const linkCheck = containsBlockedLink(trimmed);
  if (linkCheck.blocked) {
    return {
      valid: false,
      error: `${fieldLabel}: ${linkCheck.reason}`,
      wordCount,
    };
  }

  return { valid: true, wordCount };
}

export function validateFacebookLink(url: string): { valid: boolean; normalized?: string; error?: string } {
  const trimmed = (url || '').trim();
  if (!trimmed) return { valid: true, normalized: '' };

  const fbRegex = /^https?:\/\/(www\.|m\.|web\.)?(facebook\.com|fb\.com)\/[a-zA-Z0-9._/?=&-]+$/i;
  if (!fbRegex.test(trimmed)) {
    return {
      valid: false,
      error: 'Optional Facebook Link must be a valid https://facebook.com/... profile URL.',
    };
  }
  return { valid: true, normalized: trimmed };
}

const CONTROL_CHARS_REGEX = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const DANGEROUS_HTML_REGEX = /<\s*\/?\s*(script|iframe|object|embed|svg|style|link|meta|base|form)[^>]*>/gi;
const EVENT_HANDLER_REGEX = /\bon[a-z]+\s*=/gi;

export function sanitizePlainText(input: unknown, maxLength = 4000): string {
  const raw = typeof input === 'string' ? input : String(input ?? '');
  return raw
    .replace(CONTROL_CHARS_REGEX, '')
    .replace(DANGEROUS_HTML_REGEX, '')
    .replace(EVENT_HANDLER_REGEX, '')
    .replace(/[<>]/g, '')
    .trim()
    .slice(0, maxLength);
}

export function sanitizeMediaUrl(rawUrl: unknown): string {
  const cleaned = typeof rawUrl === 'string' ? rawUrl.trim() : '';
  if (!cleaned) return '';
  if (cleaned.includes('..') || /[\u0000-\u001F\s]/.test(cleaned)) return '';

  const lower = cleaned.toLowerCase();
  if (
    lower.startsWith('javascript:') ||
    lower.startsWith('vbscript:') ||
    lower.startsWith('data:')
  ) {
    return '';
  }

  if (cleaned.startsWith('/uploads/') || cleaned.startsWith('/src/assets/')) {
    return cleaned;
  }

  try {
    const parsed = new URL(cleaned);
    if (parsed.protocol === 'https:') {
      return parsed.toString();
    }
  } catch {
    return '';
  }
  return '';
}

export function parsePositiveInt(value: unknown): number | null {
  const num = Number(value);
  if (!Number.isInteger(num) || num <= 0) return null;
  return num;
}

