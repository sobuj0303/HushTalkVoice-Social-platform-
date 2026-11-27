import express, { NextFunction, Request, Response } from 'express';
import http from 'http';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import cookieParser from 'cookie-parser';
import compression from 'compression';
import multer from 'multer';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer as createViteServer } from 'vite';
import { db, initDatabase } from './server/db';
import {
  compressVideoUnderLimit,
  generateVideoThumbnail,
  probeVideoFile,
} from './server/videoProcessor';
import {
  ALLOWED_REACTION_EMOJIS,
  classifyAllowedMedia,
  containsBlockedLink,
  MAX_GROUP_MEMBERS,
  MAX_GROUP_VIDEO_MB,
  MAX_RAW_VIDEO_UPLOAD_BYTES,
  MAX_UPLOAD_BYTES,
  MAX_WORDS,
  MIN_GROUP_VIDEO_MB,
  parsePositiveInt,
  sanitizeMediaUrl,
  sanitizePlainText,
  validateFacebookLink,
  validateTextField,
} from './src/shared/validation';
import type { PrivacySettings, ThemeMode } from './src/shared/types';

initDatabase();

const execFileAsync = promisify(execFile);
const PORT =
  process.env.NGINX_PORT && process.env.PORT === process.env.NGINX_PORT
    ? Number(process.env.DEFAULT_APP_PORT || 3000)
    : Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET || 'hushtalkvoice_dev_secret_change_in_prod';
const UPLOAD_DIR = path.resolve(process.cwd(), 'uploads');
const VARIANT_DIR = path.resolve(UPLOAD_DIR, 'variants');
const THUMB_DIR = path.resolve(UPLOAD_DIR, 'thumbs');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(VARIANT_DIR, { recursive: true });
fs.mkdirSync(THUMB_DIR, { recursive: true });

const VIDEO_QUALITY_PRESETS: Record<
  string,
  { height: number; videoBitrate: string; maxrate: string; bufsize: string; audioBitrate: string }
> = {
  '144': { height: 144, videoBitrate: '110k', maxrate: '145k', bufsize: '290k', audioBitrate: '32k' },
  '240': { height: 240, videoBitrate: '220k', maxrate: '280k', bufsize: '560k', audioBitrate: '48k' },
  '360': { height: 360, videoBitrate: '450k', maxrate: '600k', bufsize: '1200k', audioBitrate: '64k' },
  '480': { height: 480, videoBitrate: '850k', maxrate: '1100k', bufsize: '2200k', audioBitrate: '96k' },
  '720': { height: 720, videoBitrate: '1500k', maxrate: '1900k', bufsize: '3800k', audioBitrate: '128k' },
};
const variantInFlight = new Map<string, Promise<string>>();

interface AuthedRequest extends Request {
  userId?: number;
  userRole?: 'member' | 'admin';
}

const activeSockets = new Map<number, Set<WebSocket>>();

function isUserSocketOnline(userId: number): boolean {
  const set = activeSockets.get(userId);
  return Boolean(set && set.size > 0);
}

function canSeeOnlineStatus(viewerId: number, targetId: number, visibility: string): boolean {
  if (viewerId === targetId) return true;
  if (visibility === 'nobody') return false;
  return isUserSocketOnline(targetId);
}

function sendWsToUser(userId: number, payload: Record<string, unknown>): void {
  const set = activeSockets.get(userId);
  if (!set) return;
  const serialized = JSON.stringify(payload);
  for (const ws of set) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(serialized);
    }
  }
}

function broadcastPresence(userId: number, online: boolean): void {
  const userRow = db
    .prepare('SELECT online_status_visibility FROM users WHERE id = ?')
    .get(userId) as { online_status_visibility: string } | undefined;
  if (!userRow || userRow.online_status_visibility === 'nobody') return;

  const payload = JSON.stringify({ type: 'presence:update', userId, online });
  for (const [uid, set] of activeSockets.entries()) {
    if (uid === userId) continue;
    for (const ws of set) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
      }
    }
  }
}

function signToken(userId: number, role: string): string {
  return jwt.sign({ userId, role }, JWT_SECRET, { expiresIn: '7d' });
}

function extractToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }
  if (req.cookies && req.cookies.htv_token) {
    return String(req.cookies.htv_token);
  }
  if (typeof req.query?.token === 'string' && req.query.token.trim()) {
    return req.query.token.trim();
  }
  return null;
}

function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): void {
  const token = extractToken(req);
  if (!token) {
    res.status(401).json({ error: 'Authentication required.' });
    return;
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { userId: number; role: 'member' | 'admin' };
    const user = db
      .prepare('SELECT id, role, is_blocked FROM users WHERE id = ?')
      .get(decoded.userId) as { id: number; role: 'member' | 'admin'; is_blocked: number } | undefined;
    if (!user) {
      res.status(401).json({ error: 'Account not found.' });
      return;
    }
    if (user.is_blocked) {
      res.status(403).json({ error: 'Your account has been suspended by an administrator.' });
      return;
    }
    req.userId = user.id;
    req.userRole = user.role;
    db.prepare(
      "UPDATE users SET last_seen = datetime('now') WHERE id = ? AND last_seen < datetime('now', '-30 seconds')"
    ).run(user.id);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired session.' });
  }
}

function requireAdmin(req: AuthedRequest, res: Response, next: NextFunction): void {
  if (req.userRole !== 'admin') {
    res.status(403).json({ error: 'Administrator privileges required.' });
    return;
  }
  next();
}

function formatUserRow(row: any, viewerId: number) {
  const followersCount = (
    db.prepare('SELECT COUNT(*) as c FROM follows WHERE following_id = ?').get(row.id) as { c: number }
  ).c;
  const followingCount = (
    db.prepare('SELECT COUNT(*) as c FROM follows WHERE follower_id = ?').get(row.id) as { c: number }
  ).c;
  const privacy: PrivacySettings = {
    profile_visibility: row.profile_visibility,
    followers_visibility: row.followers_visibility,
    following_visibility: row.following_visibility,
    facebook_visibility: row.facebook_visibility,
    online_status_visibility: row.online_status_visibility,
    who_can_message: row.who_can_message,
  };
  return {
    id: row.id,
    name: row.name,
    username: row.username,
    email: viewerId === row.id ? row.email : '',
    role: row.role,
    is_verified: Boolean(row.is_verified),
    is_blocked: Boolean(row.is_blocked),
    is_online: canSeeOnlineStatus(viewerId, row.id, row.online_status_visibility),
    avatar_url: row.avatar_url,
    cover_url: row.cover_url,
    bio: row.bio,
    facebook_link:
      viewerId === row.id || row.facebook_visibility === 'public' ? row.facebook_link : '',
    theme: row.theme as ThemeMode,
    privacy,
    followers_count: followersCount,
    following_count: followingCount,
    created_at: row.created_at,
  };
}

function areUsersConnected(a: number, b: number): boolean {
  const row = db
    .prepare(
      `SELECT id FROM connections
       WHERE status = 'accepted'
         AND ((requester_id = ? AND receiver_id = ?) OR (requester_id = ? AND receiver_id = ?))`
    )
    .get(a, b, b, a);
  return Boolean(row);
}

function createNotification(
  userId: number,
  actorId: number | null,
  type: string,
  referenceId: number | null,
  message: string
): void {
  if (actorId && userId === actorId) return;
  const result = db
    .prepare(
      'INSERT INTO notifications (user_id, actor_id, type, reference_id, message) VALUES (?, ?, ?, ?, ?)'
    )
    .run(userId, actorId, type, referenceId, message);
  const notif = db
    .prepare(
      `SELECT n.*, COALESCE(u.name, 'System') as actor_name, COALESCE(u.username, 'system') as actor_username, COALESCE(u.avatar_url, '') as actor_avatar
       FROM notifications n
       LEFT JOIN users u ON u.id = n.actor_id
       WHERE n.id = ?`
    )
    .get(result.lastInsertRowid) as any;
  if (notif) {
    sendWsToUser(userId, {
      type: 'notification:new',
      notification: { ...notif, is_read: Boolean(notif.is_read) },
    });
  }
}

// Configure Multer with strict allowlist: Gallery Images, Audio, Video ONLY
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const safeExt = path.extname(file.originalname || '').toLowerCase().replace(/[^a-z0-9.]/g, '') || '.bin';
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e6)}${safeExt}`;
    cb(null, unique);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_RAW_VIDEO_UPLOAD_BYTES },
  fileFilter: (_req, file, cb) => {
    const check = classifyAllowedMedia(file.mimetype, file.originalname);
    if (!check.valid) {
      cb(new Error(check.error || 'Unsupported file type.'));
      return;
    }
    cb(null, true);
  },
});

async function bootstrap() {
  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    try {
      const pathname = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`).pathname;
      if (pathname === '/ws') {
        wss.handleUpgrade(req, socket, head, (ws) => {
          wss.emit('connection', ws, req);
        });
      } else if (process.env.NODE_ENV === 'production' || pathname !== '/__vite_hmr') {
        socket.destroy();
      }
    } catch {
      socket.destroy();
    }
  });

  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(self), geolocation=()');
    next();
  });

  app.use(compression({ threshold: 1024 }));
  app.use(express.json({ limit: '2mb' }));
  app.use(cookieParser());
  app.use(
    '/uploads',
    express.static(UPLOAD_DIR, {
      maxAge: '7d',
      etag: true,
      setHeaders: (res) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Cache-Control', 'public, max-age=604800');
      },
    })
  );

  // WebSocket handling
  wss.on('connection', (ws, req) => {
    let userId: number | null = null;
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      const tokenParam = url.searchParams.get('token');
      const cookieHeader = req.headers.cookie || '';
      const cookieTokenMatch = cookieHeader.match(/(?:^|;\s*)htv_token=([^;]+)/);
      const token = tokenParam || (cookieTokenMatch ? decodeURIComponent(cookieTokenMatch[1]) : null);

      if (!token) {
        ws.close(1008, 'Auth required');
        return;
      }
      const decoded = jwt.verify(token, JWT_SECRET) as { userId: number };
      const user = db
        .prepare('SELECT id, is_blocked FROM users WHERE id = ?')
        .get(decoded.userId) as { id: number; is_blocked: number } | undefined;
      if (!user || user.is_blocked) {
        ws.close(1008, 'Unauthorized');
        return;
      }
      userId = user.id;

      let set = activeSockets.get(userId);
      if (!set) {
        set = new Set();
        activeSockets.set(userId, set);
      }
      const wasOffline = set.size === 0;
      set.add(ws);
      if (wasOffline) {
        broadcastPresence(userId, true);
      }
    } catch {
      ws.close(1008, 'Invalid token');
      return;
    }

    ws.on('message', (raw) => {
      if (!userId) return;
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'typing:start' || msg.type === 'typing:stop') {
          const conversationId = Number(msg.conversationId);
          if (!conversationId) return;
          const isMember = db
            .prepare('SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?')
            .get(conversationId, userId);
          if (!isMember) return;
          const actor = db.prepare('SELECT name FROM users WHERE id = ?').get(userId) as { name: string };
          const members = db
            .prepare('SELECT user_id FROM conversation_members WHERE conversation_id = ? AND user_id != ?')
            .all(conversationId, userId) as { user_id: number }[];
          for (const m of members) {
            sendWsToUser(m.user_id, {
              type: msg.type,
              conversationId,
              userId,
              userName: actor?.name || 'Someone',
            });
          }
        }
      } catch {
        // Ignore malformed WS payloads
      }
    });

    ws.on('close', () => {
      if (!userId) return;
      const set = activeSockets.get(userId);
      if (set) {
        set.delete(ws);
        if (set.size === 0) {
          activeSockets.delete(userId);
          broadcastPresence(userId, false);
        }
      }
    });
  });

  // ─────────────────────────────────────────────────────────────
  // AUTH ROUTES
  // ─────────────────────────────────────────────────────────────
  app.post('/api/auth/register', (req, res) => {
    try {
      const { name, username, email, password } = req.body || {};
      const cleanName = sanitizePlainText(name || '', 80);
      const cleanUsername = String(username || '').trim().toLowerCase().replace(/^@/, '');
      const cleanEmail = String(email || '').trim().toLowerCase();
      const rawPassword = String(password || '');

      if (!cleanName || cleanName.length < 2) {
        res.status(400).json({ error: 'Name must be at least 2 characters.' });
        return;
      }
      if (!/^[a-z0-9_]{3,24}$/.test(cleanUsername)) {
        res.status(400).json({ error: 'Username must be 3–24 characters (letters, numbers, underscores).' });
        return;
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
        res.status(400).json({ error: 'Please enter a valid email address.' });
        return;
      }
      if (rawPassword.length < 6) {
        res.status(400).json({ error: 'Password must be at least 6 characters.' });
        return;
      }
      const nameLinkCheck = containsBlockedLink(cleanName);
      if (nameLinkCheck.blocked) {
        res.status(400).json({ error: 'Display name cannot contain links or URLs.' });
        return;
      }

      const existing = db
        .prepare('SELECT id FROM users WHERE username = ? OR email = ?')
        .get(cleanUsername, cleanEmail);
      if (existing) {
        res.status(409).json({ error: 'Username or email is already registered.' });
        return;
      }

      const hash = bcrypt.hashSync(rawPassword, 10);
      const result = db
        .prepare(
          `INSERT INTO users (name, username, email, password_hash, role, avatar_url, cover_url, theme)
           VALUES (?, ?, ?, ?, 'member', ?, ?, 'night')`
        )
        .run(
          cleanName,
          cleanUsername,
          cleanEmail,
          hash,
          '/src/assets/images/avatar_aria_1794997821348.jpg',
          '/src/assets/images/cover_studio_1794997822111.jpg'
        );

      const newId = Number(result.lastInsertRowid);
      const token = signToken(newId, 'member');
      res.cookie('htv_token', token, {
        httpOnly: true,
        sameSite: 'none',
        secure: true,
        maxAge: 7 * 24 * 60 * 60 * 1000,
      });

      const userRow = db.prepare('SELECT * FROM users WHERE id = ?').get(newId);
      res.status(201).json({ token, user: formatUserRow(userRow, newId) });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Registration failed.' });
    }
  });

  app.post('/api/auth/login', (req, res) => {
    try {
      const { identifier, password } = req.body || {};
      const cleanId = String(identifier || '').trim().toLowerCase().replace(/^@/, '');
      const rawPassword = String(password || '');

      const userRow = db
        .prepare('SELECT * FROM users WHERE email = ? OR username = ?')
        .get(cleanId, cleanId) as any;

      if (!userRow || !bcrypt.compareSync(rawPassword, userRow.password_hash)) {
        res.status(401).json({ error: 'Invalid credentials. Please check your email/username and password.' });
        return;
      }

      if (userRow.is_blocked) {
        res.status(403).json({ error: 'Your account has been suspended by an administrator.' });
        return;
      }

      const token = signToken(userRow.id, userRow.role);
      res.cookie('htv_token', token, {
        httpOnly: true,
        sameSite: 'none',
        secure: true,
        maxAge: 7 * 24 * 60 * 60 * 1000,
      });
      res.json({ token, user: formatUserRow(userRow, userRow.id) });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Login failed.' });
    }
  });

  app.post('/api/auth/logout', (_req, res) => {
    res.clearCookie('htv_token', { sameSite: 'none', secure: true });
    res.json({ ok: true });
  });

  app.get('/api/auth/me', requireAuth, (req: AuthedRequest, res) => {
    const userRow = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
    const token = extractToken(req);
    res.json({ user: formatUserRow(userRow, req.userId!), token });
  });

  app.post('/api/auth/forgot-password', (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const user = db.prepare('SELECT id, email FROM users WHERE email = ?').get(email) as
      | { id: number; email: string }
      | undefined;
    if (!user) {
      res.status(404).json({ error: 'No account found with that email address.' });
      return;
    }
    const code = String(crypto.randomInt(100000, 1000000));
    db.prepare('UPDATE password_resets SET used = 1 WHERE user_id = ?').run(user.id);
    db.prepare(
      "INSERT INTO password_resets (user_id, code, expires_at) VALUES (?, ?, datetime('now', '+15 minutes'))"
    ).run(user.id, code);
    res.json({
      message: '6-digit verification code generated. Enter it below to reset your password.',
      verification_code_preview: code,
    });
  });

  app.post('/api/auth/reset-password', (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const code = String(req.body?.code || '').trim();
    const newPassword = String(req.body?.newPassword || '');

    if (newPassword.length < 6) {
      res.status(400).json({ error: 'New password must be at least 6 characters.' });
      return;
    }

    const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email) as { id: number } | undefined;
    if (!user) {
      res.status(404).json({ error: 'Account not found.' });
      return;
    }

    const resetRow = db
      .prepare(
        `SELECT id FROM password_resets
         WHERE user_id = ? AND code = ? AND used = 0 AND expires_at > datetime('now')
         ORDER BY id DESC LIMIT 1`
      )
      .get(user.id, code) as { id: number } | undefined;

    if (!resetRow) {
      res.status(400).json({ error: 'Invalid or expired verification code.' });
      return;
    }

    const hash = bcrypt.hashSync(newPassword, 10);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, user.id);
    db.prepare('UPDATE password_resets SET used = 1 WHERE id = ?').run(resetRow.id);
    res.json({ message: 'Password updated successfully. You can now sign in.' });
  });

  // ─────────────────────────────────────────────────────────────
  // MEDIA UPLOAD (Strict Allowlist: Gallery Images, Audio, Video ONLY)
  // ─────────────────────────────────────────────────────────────
  app.post('/api/upload', requireAuth, (req: AuthedRequest, res) => {
    upload.single('file')(req, res, async (err: any) => {
      if (err) {
        res.status(400).json({ error: err.message || 'File upload rejected.' });
        return;
      }
      if (!req.file) {
        res.status(400).json({ error: 'No media file provided.' });
        return;
      }
      const check = classifyAllowedMedia(req.file.mimetype, req.file.originalname);
      if (!check.valid || !check.category) {
        fs.unlink(req.file.path, () => {});
        res.status(400).json({ error: check.error || 'Invalid file type.' });
        return;
      }

      if (check.category !== 'video') {
        if (req.file.size > MAX_UPLOAD_BYTES) {
          fs.unlink(req.file.path, () => {});
          res.status(400).json({ error: 'Image and audio uploads cannot exceed 50 MB.' });
          return;
        }
        res.json({
          url: `/uploads/${req.file.filename}`,
          category: check.category,
          size_bytes: req.file.size,
          compressed: false,
          original_size_bytes: req.file.size,
        });
        return;
      }

      try {
        const rawMaxMb = Number(req.body?.maxMb || req.query?.maxMb || MAX_GROUP_VIDEO_MB);
        const clampedMb = Number.isFinite(rawMaxMb)
          ? Math.max(MIN_GROUP_VIDEO_MB, Math.min(MAX_GROUP_VIDEO_MB, Math.round(rawMaxMb)))
          : MAX_GROUP_VIDEO_MB;
        const targetBytes = Math.min(MAX_UPLOAD_BYTES, clampedMb * 1024 * 1024);

        const processed = await compressVideoUnderLimit(req.file.path, targetBytes);
        const [thumb, probe] = await Promise.all([
          generateVideoThumbnail(processed.filePath, THUMB_DIR).catch(() => null),
          probeVideoFile(processed.filePath).catch(() => null),
        ]);
        res.json({
          url: `/uploads/${processed.filename}`,
          category: 'video',
          size_bytes: processed.sizeBytes,
          compressed: processed.compressed,
          original_size_bytes: processed.originalSizeBytes,
          thumbnail_url: thumb ? `/uploads/thumbs/${thumb.filename}` : undefined,
          duration_seconds: probe ? Math.max(0, Math.round(probe.duration || 0)) : undefined,
        });
      } catch (procErr: any) {
        if (req.file?.path && fs.existsSync(req.file.path)) {
          fs.unlink(req.file.path, () => {});
        }
        res.status(400).json({
          error: procErr?.message || 'Could not optimize uploaded video.',
        });
      }
    });
  });

  function resolveSafeUploadVideo(rawUrl: string): string | null {
    const cleanUrl = String(rawUrl || '').split('?')[0].split('#')[0].trim();
    if (!cleanUrl.startsWith('/uploads/')) return null;
    const rel = cleanUrl.replace(/^\/uploads\//, '');
    const full = path.resolve(UPLOAD_DIR, rel);
    if (!full.startsWith(UPLOAD_DIR + path.sep)) return null;
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return null;
    return full;
  }

  function cleanupUnusedUploadFile(rawUrl: unknown): void {
    try {
      const cleanUrl = typeof rawUrl === 'string' ? rawUrl.split('?')[0].split('#')[0].trim() : '';
      if (!cleanUrl.startsWith('/uploads/') || cleanUrl.startsWith('/uploads/seed/')) return;
      const rel = cleanUrl.replace(/^\/uploads\//, '');
      const full = path.resolve(UPLOAD_DIR, rel);
      if (!full.startsWith(UPLOAD_DIR + path.sep) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
        return;
      }
      const stillReferenced =
        db.prepare('SELECT 1 FROM posts WHERE media_url = ? LIMIT 1').get(cleanUrl) ||
        db.prepare('SELECT 1 FROM circle_posts WHERE media_url = ? LIMIT 1').get(cleanUrl) ||
        db.prepare('SELECT 1 FROM messages WHERE media_url = ? AND is_unsent = 0 LIMIT 1').get(cleanUrl) ||
        db.prepare('SELECT 1 FROM videos WHERE video_url = ? OR thumbnail_url = ? LIMIT 1').get(cleanUrl, cleanUrl) ||
        db.prepare('SELECT 1 FROM users WHERE avatar_url = ? OR cover_url = ? LIMIT 1').get(cleanUrl, cleanUrl) ||
        db.prepare('SELECT 1 FROM circles WHERE avatar_url = ? LIMIT 1').get(cleanUrl);
      if (!stillReferenced) {
        fs.unlink(full, () => {});
      }
    } catch {
      // Ignore cleanup errors so DB deletes remain reliable
    }
  }

  async function ensureVideoVariant(sourcePath: string, quality: string): Promise<string> {
    const preset = VIDEO_QUALITY_PRESETS[quality];
    if (!preset) {
      throw new Error('Unsupported video quality.');
    }
    const stat = fs.statSync(sourcePath);
    const hash = crypto
      .createHash('sha1')
      .update(`${sourcePath}:${stat.size}:${stat.mtimeMs}:${quality}`)
      .digest('hex')
      .slice(0, 16);
    const outPath = path.join(VARIANT_DIR, `${hash}-${quality}p.mp4`);
    if (fs.existsSync(outPath) && fs.statSync(outPath).size > 0) {
      return outPath;
    }

    const inFlightKey = `${hash}-${quality}`;
    const existing = variantInFlight.get(inFlightKey);
    if (existing) return existing;

    const task = (async () => {
      const tmpPath = path.join(VARIANT_DIR, `${hash}-${quality}p.${Date.now()}.tmp.mp4`);
      try {
        await execFileAsync(
          'ffmpeg',
          [
            '-y',
            '-i',
            sourcePath,
            '-vf',
            `scale=-2:${preset.height}`,
            '-c:v',
            'libx264',
            '-preset',
            'veryfast',
            '-pix_fmt',
            'yuv420p',
            '-b:v',
            preset.videoBitrate,
            '-maxrate',
            preset.maxrate,
            '-bufsize',
            preset.bufsize,
            '-c:a',
            'aac',
            '-b:a',
            preset.audioBitrate,
            '-ac',
            '1',
            '-movflags',
            '+faststart',
            tmpPath,
          ],
          { timeout: 120_000 }
        );
        fs.renameSync(tmpPath, outPath);
        return outPath;
      } catch (err) {
        if (fs.existsSync(tmpPath)) {
          fs.unlink(tmpPath, () => {});
        }
        throw err;
      } finally {
        variantInFlight.delete(inFlightKey);
      }
    })();

    variantInFlight.set(inFlightKey, task);
    return task;
  }

  app.get('/api/media/video-variant', requireAuth, async (req: AuthedRequest, res) => {
    try {
      const rawUrl = String(req.query.url || '');
      const quality = String(req.query.quality || 'original').toLowerCase().replace(/p$/, '');
      const sourcePath = resolveSafeUploadVideo(rawUrl);
      if (!sourcePath) {
        res.status(404).json({ error: 'Video file not found.' });
        return;
      }

      if (quality === 'original' || !VIDEO_QUALITY_PRESETS[quality]) {
        res.sendFile(sourcePath);
        return;
      }

      const variantPath = await ensureVideoVariant(sourcePath, quality);
      res.setHeader('Content-Type', 'video/mp4');
      res.sendFile(variantPath);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Could not prepare video quality variant.' });
    }
  });

  app.get('/api/media/video-variants-info', requireAuth, (req: AuthedRequest, res) => {
    const rawUrl = String(req.query.url || '');
    const sourcePath = resolveSafeUploadVideo(rawUrl);
    if (!sourcePath) {
      res.status(404).json({ error: 'Video file not found.' });
      return;
    }
    const stat = fs.statSync(sourcePath);
    const qualities: Record<string, { cached: boolean; size_bytes: number }> = {
      original: { cached: true, size_bytes: stat.size },
    };
    for (const q of Object.keys(VIDEO_QUALITY_PRESETS)) {
      const hash = crypto
        .createHash('sha1')
        .update(`${sourcePath}:${stat.size}:${stat.mtimeMs}:${q}`)
        .digest('hex')
        .slice(0, 16);
      const outPath = path.join(VARIANT_DIR, `${hash}-${q}p.mp4`);
      if (fs.existsSync(outPath)) {
        qualities[q] = { cached: true, size_bytes: fs.statSync(outPath).size };
      } else {
        qualities[q] = { cached: false, size_bytes: 0 };
      }
    }
    res.json({ qualities });
  });

  // ─────────────────────────────────────────────────────────────
  // PROFILE & SETTINGS (3 Dark Modes + 6 Privacy Controls)
  // ─────────────────────────────────────────────────────────────
  app.put('/api/settings', requireAuth, (req: AuthedRequest, res) => {
    const { theme, privacy } = req.body || {};
    const validThemes: ThemeMode[] = ['day', 'night', 'system'];

    if (theme && !validThemes.includes(theme)) {
      res.status(400).json({ error: 'Theme mode must be Day, Night, or System.' });
      return;
    }

    const current = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId) as any;
    const nextTheme = theme || current.theme;
    const nextPrivacy = {
      profile_visibility:
        privacy?.profile_visibility === 'private' ? 'private' : privacy?.profile_visibility === 'public' ? 'public' : current.profile_visibility,
      followers_visibility:
        privacy?.followers_visibility === 'private' ? 'private' : privacy?.followers_visibility === 'public' ? 'public' : current.followers_visibility,
      following_visibility:
        privacy?.following_visibility === 'private' ? 'private' : privacy?.following_visibility === 'public' ? 'public' : current.following_visibility,
      facebook_visibility:
        privacy?.facebook_visibility === 'private' ? 'private' : privacy?.facebook_visibility === 'public' ? 'public' : current.facebook_visibility,
      online_status_visibility:
        privacy?.online_status_visibility === 'nobody' ? 'nobody' : privacy?.online_status_visibility === 'everyone' ? 'everyone' : current.online_status_visibility,
      who_can_message:
        privacy?.who_can_message === 'connections' ? 'connections' : privacy?.who_can_message === 'everyone' ? 'everyone' : current.who_can_message,
    };

    db.prepare(
      `UPDATE users
       SET theme = ?, profile_visibility = ?, followers_visibility = ?, following_visibility = ?,
           facebook_visibility = ?, online_status_visibility = ?, who_can_message = ?
       WHERE id = ?`
    ).run(
      nextTheme,
      nextPrivacy.profile_visibility,
      nextPrivacy.followers_visibility,
      nextPrivacy.following_visibility,
      nextPrivacy.facebook_visibility,
      nextPrivacy.online_status_visibility,
      nextPrivacy.who_can_message,
      req.userId
    );

    if (nextPrivacy.online_status_visibility === 'nobody') {
      broadcastPresence(req.userId!, false);
    } else if (isUserSocketOnline(req.userId!)) {
      broadcastPresence(req.userId!, true);
    }

    const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
    res.json({ user: formatUserRow(updated, req.userId!) });
  });

  app.put('/api/profile', requireAuth, (req: AuthedRequest, res) => {
    try {
      const { name, username, bio, facebook_link, avatar_url, cover_url } = req.body || {};
      const cleanName = sanitizePlainText(name || '', 80);
      const cleanUsername = String(username || '').trim().toLowerCase().replace(/^@/, '');
      const cleanBio = sanitizePlainText(bio || '', 1200);
      const cleanAvatar = sanitizeMediaUrl(avatar_url);
      const cleanCover = sanitizeMediaUrl(cover_url);

      if (!cleanName || cleanName.length < 2) {
        res.status(400).json({ error: 'Name must be at least 2 characters.' });
        return;
      }
      if (!/^[a-z0-9_]{3,24}$/.test(cleanUsername)) {
        res.status(400).json({ error: 'Username must be 3–24 characters (letters, numbers, underscores).' });
        return;
      }
      if (containsBlockedLink(cleanName).blocked) {
        res.status(400).json({ error: 'Name cannot contain external links.' });
        return;
      }
      const bioCheck = validateTextField(cleanBio, 'Bio', { maxWords: 120 });
      if (!bioCheck.valid) {
        res.status(400).json({ error: bioCheck.error });
        return;
      }
      const fbCheck = validateFacebookLink(String(facebook_link || ''));
      if (!fbCheck.valid) {
        res.status(400).json({ error: fbCheck.error });
        return;
      }

      const taken = db
        .prepare('SELECT id FROM users WHERE username = ? AND id != ?')
        .get(cleanUsername, req.userId);
      if (taken) {
        res.status(409).json({ error: 'That username is already taken.' });
        return;
      }

      const current = db.prepare('SELECT avatar_url, cover_url FROM users WHERE id = ?').get(req.userId) as any;
      db.prepare(
        `UPDATE users
         SET name = ?, username = ?, bio = ?, facebook_link = ?, avatar_url = ?, cover_url = ?
         WHERE id = ?`
      ).run(
        cleanName,
        cleanUsername,
        cleanBio,
        fbCheck.normalized || '',
        cleanAvatar || current.avatar_url,
        cleanCover || current.cover_url,
        req.userId
      );

      const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
      res.json({ user: formatUserRow(updated, req.userId!) });
    } catch (err: any) {
      res.status(400).json({ error: err?.message || 'Could not update profile.' });
    }
  });

  app.get('/api/users/:id/profile', requireAuth, (req: AuthedRequest, res) => {
    const targetId = Number(req.params.id);
    const target = db.prepare('SELECT * FROM users WHERE id = ? AND is_blocked = 0').get(targetId) as any;
    if (!target) {
      res.status(404).json({ error: 'User not found.' });
      return;
    }

    const isSelf = req.userId === targetId;
    const isConnected = areUsersConnected(req.userId!, targetId);
    const canViewFull = isSelf || target.profile_visibility === 'public' || isConnected;

    const baseUser = formatUserRow(target, req.userId!);
    const isFollowing = Boolean(
      db.prepare('SELECT 1 FROM follows WHERE follower_id = ? AND following_id = ?').get(req.userId, targetId)
    );

    let connectionStatus: 'none' | 'pending_sent' | 'pending_received' | 'accepted' = 'none';
    const conn = db
      .prepare(
        `SELECT * FROM connections
         WHERE (requester_id = ? AND receiver_id = ?) OR (requester_id = ? AND receiver_id = ?)`
      )
      .get(req.userId, targetId, targetId, req.userId) as any;
    if (conn) {
      if (conn.status === 'accepted') connectionStatus = 'accepted';
      else if (conn.status === 'pending') {
        connectionStatus = conn.requester_id === req.userId ? 'pending_sent' : 'pending_received';
      }
    }

    const canSeeFollowers = isSelf || target.followers_visibility === 'public' || isConnected;
    const canSeeFollowing = isSelf || target.following_visibility === 'public' || isConnected;

    const followers = canSeeFollowers
      ? (db
          .prepare(
            `SELECT u.id, u.name, u.username, u.avatar_url, u.role, u.is_verified, u.bio, u.online_status_visibility
             FROM follows f JOIN users u ON u.id = f.follower_id
             WHERE f.following_id = ? AND u.is_blocked = 0`
          )
          .all(targetId) as any[]).map((u) => ({
          ...u,
          is_verified: Boolean(u.is_verified),
          is_online: canSeeOnlineStatus(req.userId!, u.id, u.online_status_visibility),
        }))
      : null;

    const following = canSeeFollowing
      ? (db
          .prepare(
            `SELECT u.id, u.name, u.username, u.avatar_url, u.role, u.is_verified, u.bio, u.online_status_visibility
             FROM follows f JOIN users u ON u.id = f.following_id
             WHERE f.follower_id = ? AND u.is_blocked = 0`
          )
          .all(targetId) as any[]).map((u) => ({
          ...u,
          is_verified: Boolean(u.is_verified),
          is_online: canSeeOnlineStatus(req.userId!, u.id, u.online_status_visibility),
        }))
      : null;

    const posts = canViewFull ? fetchFormattedPosts(req.userId!, { userId: targetId }) : [];

    res.json({
      profile: {
        ...baseUser,
        bio: canViewFull ? baseUser.bio : 'This profile is set to private.',
        is_following: isFollowing,
        connection_status: connectionStatus,
        can_view_profile: canViewFull,
        can_see_followers: canSeeFollowers,
        can_see_following: canSeeFollowing,
      },
      followers,
      following,
      posts,
    });
  });

  app.get('/api/users/by-username/:username', requireAuth, (req: AuthedRequest, res) => {
    const clean = String(req.params.username || '').trim().toLowerCase().replace(/^@/, '');
    const row = db
      .prepare('SELECT id FROM users WHERE username = ? AND is_blocked = 0')
      .get(clean) as { id: number } | undefined;
    if (!row) {
      res.status(404).json({ error: 'Profile not found.' });
      return;
    }
    res.json({ id: row.id });
  });

  // ─────────────────────────────────────────────────────────────
  // FIND PEOPLE, FOLLOWS, CONNECTIONS, ONLINE MEMBERS
  // ─────────────────────────────────────────────────────────────
  app.get('/api/people', requireAuth, (req: AuthedRequest, res) => {
    const q = String(req.query.q || '').trim().toLowerCase();
    const filter = String(req.query.filter || 'all');

    const rows = db
      .prepare(
        `SELECT
           u.id, u.name, u.username, u.avatar_url, u.role, u.is_verified,
           u.online_status_visibility, u.profile_visibility, u.bio,
           (SELECT COUNT(*) FROM follows WHERE following_id = u.id) as followers_count,
           (SELECT COUNT(*) FROM follows WHERE follower_id = u.id) as following_count,
           EXISTS(SELECT 1 FROM follows WHERE follower_id = ? AND following_id = u.id) as is_following,
           c.id as conn_id, c.requester_id as conn_requester_id, c.status as conn_status
         FROM users u
         LEFT JOIN connections c
           ON (c.requester_id = ? AND c.receiver_id = u.id)
           OR (c.requester_id = u.id AND c.receiver_id = ?)
         WHERE u.id != ? AND u.is_blocked = 0`
      )
      .all(req.userId, req.userId, req.userId, req.userId) as any[];

    let mapped = rows.map((r) => {
      let connectionStatus: 'none' | 'pending_sent' | 'pending_received' | 'accepted' = 'none';
      if (r.conn_status === 'accepted') {
        connectionStatus = 'accepted';
      } else if (r.conn_status === 'pending') {
        connectionStatus = r.conn_requester_id === req.userId ? 'pending_sent' : 'pending_received';
      }

      const canViewProfile = r.profile_visibility === 'public' || connectionStatus === 'accepted';
      return {
        id: r.id,
        name: r.name,
        username: r.username,
        avatar_url: r.avatar_url,
        role: r.role,
        is_verified: Boolean(r.is_verified),
        is_online: canSeeOnlineStatus(req.userId!, r.id, r.online_status_visibility),
        bio: canViewProfile ? r.bio : 'Private profile',
        followers_count: Number(r.followers_count || 0),
        following_count: Number(r.following_count || 0),
        is_following: Boolean(r.is_following),
        connection_status: connectionStatus,
        connection_id: r.conn_id ?? undefined,
        can_view_profile: canViewProfile,
      };
    });

    if (q) {
      mapped = mapped.filter(
        (u) => u.name.toLowerCase().includes(q) || u.username.toLowerCase().includes(q)
      );
    }

    if (filter === 'online') {
      mapped = mapped.filter((u) => u.is_online);
    } else if (filter === 'popular') {
      mapped.sort((a, b) => b.followers_count - a.followers_count);
    }

    res.json({ people: mapped });
  });

  app.get('/api/sidebar-context', requireAuth, (req: AuthedRequest, res) => {
    const allUsers = db
      .prepare('SELECT id, name, username, avatar_url, role, is_verified, online_status_visibility FROM users WHERE id != ? AND is_blocked = 0')
      .all(req.userId) as any[];

    const onlineMembers = allUsers
      .filter((u) => canSeeOnlineStatus(req.userId!, u.id, u.online_status_visibility))
      .map((u) => ({
        id: u.id,
        name: u.name,
        username: u.username,
        avatar_url: u.avatar_url,
        role: u.role,
        is_verified: Boolean(u.is_verified),
        is_online: true,
      }));

    const requests = db
      .prepare(
        `SELECT c.id as connection_id, u.id as user_id, u.name, u.username, u.avatar_url, u.is_verified, c.created_at
         FROM connections c
         JOIN users u ON u.id = c.requester_id
         WHERE c.receiver_id = ? AND c.status = 'pending' AND u.is_blocked = 0
         ORDER BY c.created_at DESC`
      )
      .all(req.userId) as any[];

    const unreadNotifications = (
      db.prepare('SELECT COUNT(*) as c FROM notifications WHERE user_id = ? AND is_read = 0').get(req.userId) as {
        c: number;
      }
    ).c;

    const unreadMessages = getUnreadMessagesTotal(req.userId!);

    res.json({
      onlineMembers,
      connectionRequests: requests.map((r) => ({ ...r, is_verified: Boolean(r.is_verified) })),
      unreadNotifications,
      unreadMessages,
    });
  });

  app.post('/api/users/:id/follow', requireAuth, (req: AuthedRequest, res) => {
    const targetId = Number(req.params.id);
    if (targetId === req.userId) {
      res.status(400).json({ error: 'You cannot follow yourself.' });
      return;
    }
    const exists = db
      .prepare('SELECT 1 FROM follows WHERE follower_id = ? AND following_id = ?')
      .get(req.userId, targetId);
    if (exists) {
      db.prepare('DELETE FROM follows WHERE follower_id = ? AND following_id = ?').run(req.userId, targetId);
      res.json({ following: false });
    } else {
      db.prepare('INSERT INTO follows (follower_id, following_id) VALUES (?, ?)').run(req.userId, targetId);
      const actor = db.prepare('SELECT name FROM users WHERE id = ?').get(req.userId) as { name: string };
      createNotification(targetId, req.userId!, 'follow', req.userId!, `${actor.name} started following you`);
      res.json({ following: true });
    }
  });

  app.post('/api/connections/request', requireAuth, (req: AuthedRequest, res) => {
    const targetId = Number(req.body?.userId);
    if (!targetId || targetId === req.userId) {
      res.status(400).json({ error: 'Invalid target user.' });
      return;
    }

    const existing = db
      .prepare(
        `SELECT * FROM connections
         WHERE (requester_id = ? AND receiver_id = ?) OR (requester_id = ? AND receiver_id = ?)`
      )
      .get(req.userId, targetId, targetId, req.userId) as any;

    if (existing) {
      if (existing.status === 'accepted') {
        res.json({ status: 'accepted', id: existing.id });
        return;
      }
      if (existing.status === 'pending') {
        res.json({ status: 'pending', id: existing.id });
        return;
      }
      db.prepare("UPDATE connections SET requester_id = ?, receiver_id = ?, status = 'pending' WHERE id = ?").run(
        req.userId,
        targetId,
        existing.id
      );
      const actor = db.prepare('SELECT name FROM users WHERE id = ?').get(req.userId) as { name: string };
      createNotification(targetId, req.userId!, 'connection_request', req.userId!, `${actor.name} sent you a connection request`);
      res.json({ status: 'pending', id: existing.id });
      return;
    }

    const result = db
      .prepare("INSERT INTO connections (requester_id, receiver_id, status) VALUES (?, ?, 'pending')")
      .run(req.userId, targetId);
    const actor = db.prepare('SELECT name FROM users WHERE id = ?').get(req.userId) as { name: string };
    createNotification(targetId, req.userId!, 'connection_request', req.userId!, `${actor.name} sent you a connection request`);
    res.status(201).json({ status: 'pending', id: Number(result.lastInsertRowid) });
  });

  app.post('/api/connections/:id/respond', requireAuth, (req: AuthedRequest, res) => {
    const connId = Number(req.params.id);
    const action = req.body?.action;
    if (action !== 'accept' && action !== 'reject') {
      res.status(400).json({ error: 'Action must be accept or reject.' });
      return;
    }

    const conn = db
      .prepare('SELECT * FROM connections WHERE id = ? AND receiver_id = ?')
      .get(connId, req.userId) as any;
    if (!conn) {
      res.status(404).json({ error: 'Connection request not found.' });
      return;
    }

    const nextStatus = action === 'accept' ? 'accepted' : 'rejected';
    db.prepare('UPDATE connections SET status = ? WHERE id = ?').run(nextStatus, connId);
    if (action === 'accept') {
      const actor = db.prepare('SELECT name FROM users WHERE id = ?').get(req.userId) as { name: string };
      createNotification(
        conn.requester_id,
        req.userId!,
        'connection_accepted',
        req.userId!,
        `${actor.name} accepted your connection request`
      );
    }
    res.json({ status: nextStatus });
  });

  // ─────────────────────────────────────────────────────────────
  // POSTS FEED (200-word limit, Strict Anti-Spam Link Blocking)
  // ─────────────────────────────────────────────────────────────
  function fetchFormattedPosts(
    viewerId: number,
    options: { filter?: string; userId?: number; postId?: number; verifiedOnly?: boolean; limit?: number; offset?: number } = {}
  ) {
    const isGlobalFilter = !options.postId && !options.userId && options.filter === 'global';
    let whereClause = isGlobalFilter
      ? "u.is_blocked = 0 AND (p.circle_id IS NULL OR (c.privacy = 'public' AND p.is_global = 1))"
      : "u.is_blocked = 0 AND (p.circle_id IS NULL OR (c.privacy = 'public' AND p.is_global = 1) OR EXISTS(SELECT 1 FROM circle_members cm WHERE cm.circle_id = p.circle_id AND cm.user_id = ?))";
    const params: any[] = isGlobalFilter ? [] : [viewerId];

    if (options.postId) {
      whereClause += ' AND p.id = ?';
      params.push(options.postId);
    } else if (options.userId) {
      whereClause += ' AND p.user_id = ?';
      params.push(options.userId);
    } else if (isGlobalFilter) {
      whereClause += ` AND (
        p.circle_id IN (SELECT circle_id FROM circle_members WHERE user_id = ?)
        OR p.user_id IN (SELECT following_id FROM follows WHERE follower_id = ?)
        OR p.user_id IN (
          SELECT receiver_id FROM connections WHERE status = 'accepted' AND requester_id = ?
          UNION ALL
          SELECT requester_id FROM connections WHERE status = 'accepted' AND receiver_id = ?
        )
        OR (u.is_verified = 1 AND (p.circle_id IS NOT NULL OR u.profile_visibility = 'public'))
        OR p.user_id = ?
      )`;
      params.push(viewerId, viewerId, viewerId, viewerId, viewerId);
    } else if (options.filter === 'following') {
      whereClause +=
        ' AND (p.user_id = ? OR p.user_id IN (SELECT following_id FROM follows WHERE follower_id = ?) OR p.circle_id IN (SELECT circle_id FROM circle_members WHERE user_id = ?))';
      params.push(viewerId, viewerId, viewerId);
    } else if (options.filter === 'connections') {
      whereClause += ` AND (p.user_id = ? OR p.user_id IN (
        SELECT receiver_id FROM connections WHERE status = 'accepted' AND requester_id = ?
        UNION ALL
        SELECT requester_id FROM connections WHERE status = 'accepted' AND receiver_id = ?
      ))`;
      params.push(viewerId, viewerId, viewerId);
    }

    if (options.verifiedOnly && !options.postId) {
      whereClause +=
        " AND u.is_verified = 1 AND (p.circle_id IS NOT NULL OR u.profile_visibility = 'public' OR p.user_id = ?)";
      params.push(viewerId);
    }

    const spotlightExpr =
      '(s.is_boosted = 1 OR ((s.likes_count * 2 + s.comments_count * 2 + s.shares_count * 3) >= 4) OR s.views_count >= 25)';

    const orderClause =
      options.filter === 'popular'
        ? 'ORDER BY (s.likes_count * 2 + s.comments_count * 2 + s.shares_count * 3) DESC, s.created_at DESC, s.id DESC'
        : options.filter === 'recent'
        ? 'ORDER BY s.created_at DESC, s.id DESC'
        : `ORDER BY CASE WHEN ${spotlightExpr} THEN 1 ELSE 0 END DESC, s.is_boosted DESC, s.created_at DESC, s.id DESC`;

    const limitVal = Math.min(60, Math.max(1, Number(options.limit || 20)));
    const offsetVal = Math.max(0, Number(options.offset || 0));

    const rows = db
      .prepare(
        `WITH scored_posts AS (
           SELECT p.*, u.name as author_name, u.username as author_username, u.avatar_url as author_avatar, u.is_verified as author_verified,
             c.name as circle_name, c.category as circle_category, c.privacy as circle_privacy, c.avatar_url as circle_avatar,
             (SELECT COUNT(*) FROM post_likes WHERE post_id = p.id) as likes_count,
             (SELECT COUNT(*) FROM post_comments WHERE post_id = p.id) as comments_count,
             (SELECT COUNT(*) FROM post_shares WHERE post_id = p.id) as shares_count
           FROM posts p
           JOIN users u ON u.id = p.user_id
           LEFT JOIN circles c ON c.id = p.circle_id
           WHERE ${whereClause}
         )
         SELECT s.*,
           CASE WHEN s.circle_id IS NOT NULL THEN EXISTS(SELECT 1 FROM circle_members cm2 WHERE cm2.circle_id = s.circle_id AND cm2.user_id = ?) ELSE 0 END as circle_is_member,
           CASE WHEN s.circle_id IS NOT NULL THEN (SELECT cm3.role FROM circle_members cm3 WHERE cm3.circle_id = s.circle_id AND cm3.user_id = ?) ELSE NULL END as circle_viewer_role,
           EXISTS(SELECT 1 FROM post_likes WHERE post_id = s.id AND user_id = ?) as is_liked,
           EXISTS(SELECT 1 FROM post_views WHERE post_id = s.id AND user_id = ?) as has_viewed
         FROM scored_posts s
         ${orderClause}
         LIMIT ? OFFSET ?`
      )
      .all(...params, viewerId, viewerId, viewerId, viewerId, limitVal, offsetVal) as any[];

    const commentsByPostId = new Map<number, any[]>();
    if (rows.length > 0) {
      const postIds = rows.map((r) => Number(r.id));
      const placeholders = postIds.map(() => '?').join(',');
      const allComments = db
        .prepare(
          `SELECT c.*, u.name as author_name, u.username as author_username, u.avatar_url as author_avatar, u.is_verified as author_verified
           FROM post_comments c
           JOIN users u ON u.id = c.user_id
           WHERE c.post_id IN (${placeholders}) AND u.is_blocked = 0
           ORDER BY c.created_at ASC`
        )
        .all(...postIds) as any[];

      for (const c of allComments) {
        const pid = Number(c.post_id);
        const list = commentsByPostId.get(pid) || [];
        list.push({
          ...c,
          author_avatar: sanitizeMediaUrl(c.author_avatar),
          author_verified: Boolean(c.author_verified),
        });
        commentsByPostId.set(pid, list);
      }
    }

    return rows.map((r) => {
      const likesCount = Number(r.likes_count || 0);
      const commentsCount = Number(r.comments_count || 0);
      const sharesCount = Number(r.shares_count || 0);
      const viewsCount = Number(r.views_count || 0);
      const isBoosted = Boolean(r.is_boosted);
      const engagementScore = likesCount * 2 + commentsCount * 2 + sharesCount * 3;
      const isSpotlight = isBoosted || engagementScore >= 4 || viewsCount >= 25;

      return {
        id: r.id,
        user_id: r.user_id,
        author_name: r.author_name,
        author_username: r.author_username,
        author_avatar: sanitizeMediaUrl(r.author_avatar),
        author_verified: Boolean(r.author_verified),
        content: r.content,
        media_type: r.media_type,
        media_url: sanitizeMediaUrl(r.media_url),
        likes_count: likesCount,
        comments_count: commentsCount,
        shares_count: sharesCount,
        views_count: viewsCount,
        has_viewed: Boolean(r.has_viewed),
        is_liked: Boolean(r.is_liked),
        is_boosted: isBoosted,
        is_spotlight: isSpotlight,
        circle_id: r.circle_id ? Number(r.circle_id) : null,
        circle_post_id: r.circle_post_id ? Number(r.circle_post_id) : null,
        circle_name: r.circle_name || undefined,
        circle_category: r.circle_category || undefined,
        circle_privacy: r.circle_privacy === 'private' ? ('private' as const) : r.circle_id ? ('public' as const) : undefined,
        circle_avatar: r.circle_avatar ? sanitizeMediaUrl(r.circle_avatar) : undefined,
        circle_is_member: Boolean(r.circle_is_member),
        circle_viewer_role: r.circle_viewer_role || null,
        comments: commentsByPostId.get(Number(r.id)) || [],
        created_at: r.created_at,
      };
    });
  }

  app.get('/api/posts', requireAuth, (req: AuthedRequest, res) => {
    try {
      const filter = String(req.query.filter || 'all');
      const verifiedOnly = req.query.verifiedOnly === '1' || req.query.verifiedOnly === 'true';
      const limit = Math.min(60, Math.max(1, Number(req.query.limit || 20)));
      const offset = Math.max(0, Number(req.query.offset || 0));
      const fetched = fetchFormattedPosts(req.userId!, {
        filter,
        verifiedOnly,
        limit: limit + 1,
        offset,
      });
      const hasMore = fetched.length > limit;
      const posts = hasMore ? fetched.slice(0, limit) : fetched;
      res.json({ posts, hasMore });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Failed to load posts.' });
    }
  });

  app.get('/api/posts/:id', requireAuth, (req: AuthedRequest, res) => {
    try {
      const postId = parsePositiveInt(req.params.id);
      if (!postId) {
        res.status(400).json({ error: 'Invalid post identifier.' });
        return;
      }
      const post = fetchFormattedPosts(req.userId!, { postId })[0];
      if (!post) {
        res.status(404).json({ error: 'Post not found.' });
        return;
      }
      res.json({ post });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Could not load post.' });
    }
  });

  app.post('/api/posts', requireAuth, (req: AuthedRequest, res) => {
    try {
      const content = sanitizePlainText(req.body?.content || '', 4000);
      const mediaType = String(req.body?.media_type || 'none');
      const rawMediaUrl = String(req.body?.media_url || '').trim();
      const mediaUrl = mediaType === 'image' ? sanitizeMediaUrl(rawMediaUrl) : '';

      if (!['none', 'image'].includes(mediaType)) {
        res.status(400).json({
          error: 'Only text and gallery pictures can be uploaded on the feed. Videos are only permitted in Group Chats.',
        });
        return;
      }
      if (mediaType === 'image' && !mediaUrl) {
        res.status(400).json({ error: 'Invalid gallery image path.' });
        return;
      }
      if (!content && mediaType === 'none') {
        res.status(400).json({ error: 'Please write a post or attach media.' });
        return;
      }

      const check = validateTextField(content, 'Post', { maxWords: MAX_WORDS });
      if (!check.valid) {
        res.status(400).json({ error: check.error });
        return;
      }

      const result = db
        .prepare('INSERT INTO posts (user_id, content, media_type, media_url) VALUES (?, ?, ?, ?)')
        .run(req.userId, content, mediaType, mediaUrl);

      const post = fetchFormattedPosts(req.userId!, { postId: Number(result.lastInsertRowid) })[0];
      res.status(201).json({ post });
    } catch (err: any) {
      res.status(400).json({ error: err?.message || 'Could not publish post.' });
    }
  });

  app.delete('/api/posts/:id', requireAuth, (req: AuthedRequest, res) => {
    try {
      const postId = parsePositiveInt(req.params.id);
      if (!postId) {
        res.status(400).json({ error: 'Invalid post identifier.' });
        return;
      }
      const post = db
        .prepare('SELECT id, user_id, circle_id, circle_post_id, media_url FROM posts WHERE id = ?')
        .get(postId) as
        | { id: number; user_id: number; circle_id: number | null; circle_post_id: number | null; media_url: string }
        | undefined;
      if (!post) {
        res.status(404).json({ error: 'Post not found.' });
        return;
      }
      const circleRole = post.circle_id ? getCircleMemberRole(post.circle_id, req.userId!) : null;
      const isCircleStaff = circleRole === 'owner' || circleRole === 'admin' || circleRole === 'moderator';
      if (post.user_id !== req.userId && req.userRole !== 'admin' && !isCircleStaff) {
        res.status(403).json({ error: 'Strict ownership required: you can only delete your own posts.' });
        return;
      }
      db.prepare('DELETE FROM posts WHERE id = ?').run(postId);
      if (post.circle_post_id) {
        db.prepare('DELETE FROM circle_posts WHERE id = ?').run(post.circle_post_id);
      }
      if (post.media_url) {
        cleanupUnusedUploadFile(post.media_url);
      }
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Could not delete post.' });
    }
  });

  app.post('/api/posts/:id/like', requireAuth, (req: AuthedRequest, res) => {
    try {
      const postId = parsePositiveInt(req.params.id);
      if (!postId) {
        res.status(400).json({ error: 'Invalid post identifier.' });
        return;
      }
      const post = db
        .prepare(
          `SELECT p.user_id, p.circle_id, p.circle_post_id, c.privacy as circle_privacy
           FROM posts p LEFT JOIN circles c ON c.id = p.circle_id WHERE p.id = ?`
        )
        .get(postId) as
        | { user_id: number; circle_id: number | null; circle_post_id: number | null; circle_privacy: string | null }
        | undefined;
      if (!post) {
        res.status(404).json({ error: 'Post not found.' });
        return;
      }
      if (post.circle_id && post.circle_privacy === 'private' && !getCircleMemberRole(post.circle_id, req.userId!)) {
        res.status(403).json({ error: 'Private Circle access denied.' });
        return;
      }
      const exists = db
        .prepare('SELECT 1 FROM post_likes WHERE post_id = ? AND user_id = ?')
        .get(postId, req.userId);
      if (exists) {
        db.prepare('DELETE FROM post_likes WHERE post_id = ? AND user_id = ?').run(postId, req.userId);
        if (post.circle_post_id) {
          db.prepare('DELETE FROM circle_post_likes WHERE post_id = ? AND user_id = ?').run(
            post.circle_post_id,
            req.userId
          );
        }
      } else {
        db.prepare('INSERT OR IGNORE INTO post_likes (post_id, user_id) VALUES (?, ?)').run(postId, req.userId);
        if (post.circle_post_id) {
          db.prepare('INSERT OR IGNORE INTO circle_post_likes (post_id, user_id) VALUES (?, ?)').run(
            post.circle_post_id,
            req.userId
          );
        }
        const actor = db.prepare('SELECT name FROM users WHERE id = ?').get(req.userId) as
          | { name: string }
          | undefined;
        if (actor) {
          createNotification(post.user_id, req.userId!, 'like', postId, `${actor.name} liked your post`);
        }
      }
      const count = (
        db.prepare('SELECT COUNT(*) as c FROM post_likes WHERE post_id = ?').get(postId) as { c: number }
      ).c;
      res.json({ liked: !exists, likes_count: count });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Could not toggle like.' });
    }
  });

  app.post('/api/posts/:id/comment', requireAuth, (req: AuthedRequest, res) => {
    try {
      const postId = parsePositiveInt(req.params.id);
      if (!postId) {
        res.status(400).json({ error: 'Invalid post identifier.' });
        return;
      }
      const content = sanitizePlainText(req.body?.content || '', 2500);
      const post = db
        .prepare(
          `SELECT p.user_id, p.circle_id, p.circle_post_id, c.privacy as circle_privacy
           FROM posts p LEFT JOIN circles c ON c.id = p.circle_id WHERE p.id = ?`
        )
        .get(postId) as
        | { user_id: number; circle_id: number | null; circle_post_id: number | null; circle_privacy: string | null }
        | undefined;
      if (!post) {
        res.status(404).json({ error: 'Post not found.' });
        return;
      }
      if (post.circle_id && post.circle_privacy === 'private' && !getCircleMemberRole(post.circle_id, req.userId!)) {
        res.status(403).json({ error: 'Join this Private Circle to comment.' });
        return;
      }

      const check = validateTextField(content, 'Comment', { required: true, maxWords: MAX_WORDS });
      if (!check.valid) {
        res.status(400).json({ error: check.error });
        return;
      }

      const result = db
        .prepare('INSERT INTO post_comments (post_id, user_id, content) VALUES (?, ?, ?)')
        .run(postId, req.userId, content);

      let autoReplyComment: any = null;
      if (post.circle_id && post.circle_post_id) {
        db.prepare('INSERT INTO circle_post_comments (post_id, user_id, content) VALUES (?, ?, ?)').run(
          post.circle_post_id,
          req.userId,
          content
        );
        autoReplyComment = triggerCircleCommentAutomation(post.circle_id, post.circle_post_id, req.userId!, content);
      }

      const comment = db
        .prepare(
          `SELECT c.*, u.name as author_name, u.username as author_username, u.avatar_url as author_avatar, u.is_verified as author_verified
           FROM post_comments c JOIN users u ON u.id = c.user_id WHERE c.id = ?`
        )
        .get(result.lastInsertRowid) as any;

      const actor = db.prepare('SELECT name FROM users WHERE id = ?').get(req.userId) as
        | { name: string }
        | undefined;
      if (actor) {
        createNotification(post.user_id, req.userId!, 'comment', postId, `${actor.name} commented on your post`);
      }

      res.status(201).json({
        comment: { ...comment, author_verified: Boolean(comment.author_verified) },
        auto_reply: autoReplyComment,
      });
    } catch (err: any) {
      res.status(400).json({ error: err?.message || 'Comment blocked.' });
    }
  });

  app.post('/api/posts/:id/share', requireAuth, (req: AuthedRequest, res) => {
    try {
      const postId = parsePositiveInt(req.params.id);
      if (!postId) {
        res.status(400).json({ error: 'Invalid post identifier.' });
        return;
      }
      const original = db
        .prepare('SELECT id, circle_post_id FROM posts WHERE id = ?')
        .get(postId) as { id: number; circle_post_id: number | null } | undefined;
      if (!original) {
        res.status(404).json({ error: 'Post not found.' });
        return;
      }
      db.prepare('INSERT INTO post_shares (post_id, user_id) VALUES (?, ?)').run(postId, req.userId);
      if (original.circle_post_id) {
        db.prepare('INSERT INTO circle_post_shares (post_id, user_id) VALUES (?, ?)').run(
          original.circle_post_id,
          req.userId
        );
      }
      const sharesCount = (
        db.prepare('SELECT COUNT(*) as c FROM post_shares WHERE post_id = ?').get(postId) as { c: number }
      ).c;
      res.json({ shares_count: sharesCount });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Could not record share.' });
    }
  });

  const recordPostViewTx = db.transaction((postId: number, userId: number, circlePostId: number | null) => {
    const info = db
      .prepare('INSERT OR IGNORE INTO post_views (post_id, user_id) VALUES (?, ?)')
      .run(postId, userId);
    if (info.changes > 0) {
      db.prepare('UPDATE posts SET views_count = views_count + 1 WHERE id = ?').run(postId);
      if (circlePostId) {
        const cInfo = db
          .prepare('INSERT OR IGNORE INTO circle_post_views (post_id, user_id) VALUES (?, ?)')
          .run(circlePostId, userId);
        if (cInfo.changes > 0) {
          db.prepare('UPDATE circle_posts SET views_count = views_count + 1 WHERE id = ?').run(circlePostId);
        }
      }
    }
    const row = db.prepare('SELECT views_count FROM posts WHERE id = ?').get(postId) as
      | { views_count: number }
      | undefined;
    return { incremented: info.changes > 0, views_count: Number(row?.views_count || 0) };
  });

  app.post('/api/posts/:id/view', requireAuth, (req: AuthedRequest, res) => {
    try {
      const postId = parsePositiveInt(req.params.id);
      if (!postId) {
        res.status(400).json({ error: 'Invalid post identifier.' });
        return;
      }
      const exists = db
        .prepare('SELECT id, circle_post_id FROM posts WHERE id = ?')
        .get(postId) as { id: number; circle_post_id: number | null } | undefined;
      if (!exists) {
        res.status(404).json({ error: 'Post not found.' });
        return;
      }
      const outcome = recordPostViewTx(postId, req.userId!, exists.circle_post_id);
      res.json({ ok: true, ...outcome });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Could not update post views.' });
    }
  });

  app.post('/api/posts/:id/boost', requireAuth, (req: AuthedRequest, res) => {
    try {
      const postId = parsePositiveInt(req.params.id);
      if (!postId) {
        res.status(400).json({ error: 'Invalid post identifier.' });
        return;
      }
      const post = db
        .prepare('SELECT id, user_id, is_boosted FROM posts WHERE id = ?')
        .get(postId) as { id: number; user_id: number; is_boosted: number } | undefined;
      if (!post) {
        res.status(404).json({ error: 'Post not found.' });
        return;
      }
      if (post.user_id !== req.userId && req.userRole !== 'admin') {
        res.status(403).json({ error: 'Only the post owner or an admin can spotlight this post.' });
        return;
      }
      const nextBoost = post.is_boosted ? 0 : 1;
      db.prepare('UPDATE posts SET is_boosted = ? WHERE id = ?').run(nextBoost, postId);
      const updated = fetchFormattedPosts(req.userId!, { postId })[0];
      res.json({
        is_boosted: Boolean(nextBoost),
        is_spotlight: Boolean(updated?.is_spotlight ?? nextBoost),
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Could not toggle spotlight.' });
    }
  });

  // ─────────────────────────────────────────────────────────────
  // MESSENGER & GROUP CHAT (Up to 500 Members, Audio/Video/Text/Gallery Only)
  // ─────────────────────────────────────────────────────────────
  function getUnreadMessagesTotal(userId: number): number {
    const row = db
      .prepare(
        `SELECT COUNT(*) as c
         FROM messages m
         JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = ?
         JOIN conversations c ON c.id = m.conversation_id
         WHERE c.status = 'active'
           AND cm.is_muted = 0
           AND m.sender_id != ?
           AND m.is_unsent = 0
           AND m.created_at > cm.last_read_at`
      )
      .get(userId, userId) as { c: number };
    return row.c;
  }

  function getGroupAdminIds(convId: number): number[] {
    const conv = db.prepare('SELECT created_by FROM conversations WHERE id = ?').get(convId) as
      | { created_by: number }
      | undefined;
    const rows = db
      .prepare("SELECT user_id FROM conversation_members WHERE conversation_id = ? AND role = 'admin'")
      .all(convId) as { user_id: number }[];
    const set = new Set<number>();
    if (conv?.created_by) set.add(conv.created_by);
    for (const r of rows) set.add(r.user_id);
    return Array.from(set);
  }

  function checkCandidateGroupEligibility(
    adminIds: number[],
    candidateId: number,
    actorId: number
  ): {
    allowed: boolean;
    followsAdmin: boolean;
    connectedWithAdminOrActor: boolean;
    reason?: string;
  } {
    if (adminIds.includes(candidateId)) {
      return { allowed: true, followsAdmin: true, connectedWithAdminOrActor: true };
    }

    const followsAdmin = adminIds.some((aid) =>
      Boolean(db.prepare('SELECT 1 FROM follows WHERE follower_id = ? AND following_id = ?').get(candidateId, aid))
    );

    const connectedWithAdmin = adminIds.some((aid) => areUsersConnected(candidateId, aid));
    const connectedWithActor = actorId !== candidateId ? areUsersConnected(candidateId, actorId) : false;
    const connectedWithAdminOrActor = connectedWithAdmin || connectedWithActor;

    if (!followsAdmin && !connectedWithAdminOrActor) {
      return {
        allowed: false,
        followsAdmin: false,
        connectedWithAdminOrActor: false,
        reason: 'Member must follow a group admin or be connected (friends) with the admin/inviter before joining.',
      };
    }

    return { allowed: true, followsAdmin, connectedWithAdminOrActor };
  }

  function isMuteActive(isChatMuted: number, mutedUntil: string): boolean {
    if (!isChatMuted) return false;
    if (!mutedUntil) return true;
    const expiry = Date.parse(mutedUntil);
    if (Number.isNaN(expiry)) return true;
    return expiry > Date.now();
  }

  function formatConversation(convId: number, viewerId: number) {
    const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(convId) as any;
    if (!conv) return null;

    const members = (
      db
        .prepare(
          `SELECT cm.user_id, cm.role, cm.is_chat_muted, cm.chat_muted_until, u.name, u.username, u.avatar_url, u.is_verified, u.online_status_visibility
           FROM conversation_members cm
           JOIN users u ON u.id = cm.user_id
           WHERE cm.conversation_id = ? AND u.is_blocked = 0
           ORDER BY CASE WHEN cm.role = 'admin' THEN 0 ELSE 1 END, u.name ASC`
        )
        .all(convId) as any[]
    ).map((m) => ({
      user_id: m.user_id,
      name: m.name,
      username: m.username,
      avatar_url: m.avatar_url,
      is_verified: Boolean(m.is_verified),
      is_online: canSeeOnlineStatus(viewerId, m.user_id, m.online_status_visibility),
      role: m.role,
      is_chat_muted: isMuteActive(m.is_chat_muted, m.chat_muted_until || ''),
      chat_muted_until: m.chat_muted_until || '',
    }));

    const viewerMem = db
      .prepare('SELECT role, is_muted, is_chat_muted, chat_muted_until, last_read_at FROM conversation_members WHERE conversation_id = ? AND user_id = ?')
      .get(convId, viewerId) as
      | {
          role: string;
          is_muted: number;
          is_chat_muted: number;
          chat_muted_until: string;
          last_read_at: string;
        }
      | undefined;

    const unreadCount = viewerMem
      ? (
          db
            .prepare(
              `SELECT COUNT(*) as c FROM messages
               WHERE conversation_id = ? AND sender_id != ? AND is_unsent = 0 AND created_at > ?`
            )
            .get(convId, viewerId, viewerMem.last_read_at) as { c: number }
        ).c
      : 0;

    const lastMsg = db
      .prepare(
        `SELECT m.content, m.media_type, m.created_at, m.is_unsent, u.name as sender_name
         FROM messages m JOIN users u ON u.id = m.sender_id
         WHERE m.conversation_id = ?
         ORDER BY m.id DESC LIMIT 1`
      )
      .get(convId) as any;

    let otherUser = null;
    if (conv.type === 'direct') {
      const other = members.find((m) => m.user_id !== viewerId) || members[0];
      if (other) {
        otherUser = {
          id: other.user_id,
          name: other.name,
          username: other.username,
          avatar_url: other.avatar_url,
          role: 'member' as const,
          is_verified: other.is_verified,
          is_online: other.is_online,
        };
      }
    }

    const isViewerAdmin =
      conv.type === 'group' && (conv.created_by === viewerId || viewerMem?.role === 'admin');
    let pendingJoinRequests: any[] = [];
    if (isViewerAdmin) {
      const adminIds = getGroupAdminIds(convId);
      const reqRows = db
        .prepare(
          `SELECT r.*, u.name, u.username, u.avatar_url, u.is_verified, inv.name as invited_by_name
           FROM group_join_requests r
           JOIN users u ON u.id = r.user_id
           LEFT JOIN users inv ON inv.id = r.invited_by
           WHERE r.conversation_id = ? AND r.status = 'pending' AND u.is_blocked = 0
           ORDER BY r.created_at DESC`
        )
        .all(convId) as any[];

      pendingJoinRequests = reqRows.map((r) => {
        const elig = checkCandidateGroupEligibility(adminIds, r.user_id, r.invited_by || r.user_id);
        return {
          id: r.id,
          conversation_id: r.conversation_id,
          user_id: r.user_id,
          name: r.name,
          username: r.username,
          avatar_url: r.avatar_url,
          is_verified: Boolean(r.is_verified),
          invited_by_name: r.invited_by_name || null,
          follows_admin: elig.followsAdmin,
          is_friend_with_admin: elig.connectedWithAdminOrActor,
          created_at: r.created_at,
        };
      });
    }

    return {
      id: conv.id,
      type: conv.type,
      name: conv.type === 'group' ? conv.name : otherUser?.name || 'Direct Chat',
      avatar_url: conv.type === 'group' ? conv.avatar_url : otherUser?.avatar_url || '',
      created_by: conv.created_by,
      status: conv.status,
      requester_id: conv.requester_id,
      join_mode: (conv.join_mode || 'direct') as 'direct' | 'approval',
      invite_code: conv.type === 'group' ? conv.invite_code || '' : '',
      max_video_mb: conv.max_video_mb || 25,
      is_muted: Boolean(viewerMem?.is_muted),
      viewer_chat_muted: viewerMem
        ? isMuteActive(viewerMem.is_chat_muted, viewerMem.chat_muted_until || '')
        : false,
      viewer_chat_muted_until: viewerMem?.chat_muted_until || '',
      member_count: members.length,
      unread_count: unreadCount,
      last_message: lastMsg ? { ...lastMsg, is_unsent: Boolean(lastMsg.is_unsent) } : null,
      other_user: otherUser,
      members,
      pending_join_requests: pendingJoinRequests,
      updated_at: conv.updated_at,
    };
  }

  function resolveDiskSize(mediaUrl: string, storedBytes: number): number {
    if (storedBytes && storedBytes > 0) return storedBytes;
    if (mediaUrl && mediaUrl.startsWith('/uploads/')) {
      const rel = mediaUrl.replace(/^\/uploads\//, '');
      const full = path.resolve(UPLOAD_DIR, rel);
      if (full.startsWith(UPLOAD_DIR) && fs.existsSync(full)) {
        try {
          return fs.statSync(full).size;
        } catch {
          return 0;
        }
      }
    }
    return 0;
  }

  function formatMessages(conversationId: number, viewerId: number) {
    const rows = db
      .prepare(
        `SELECT m.*, u.name as sender_name, u.username as sender_username, u.avatar_url as sender_avatar, u.is_verified as sender_verified
         FROM messages m
         JOIN users u ON u.id = m.sender_id
         WHERE m.conversation_id = ?
         ORDER BY m.id ASC`
      )
      .all(conversationId) as any[];

    if (rows.length === 0) return [];

    const msgIds = rows.map((r) => Number(r.id));
    const msgPlaceholders = msgIds.map(() => '?').join(',');

    // Batch-load reactions for all messages in this conversation (avoids N+1 queries)
    const allReactions = db
      .prepare(
        `SELECT message_id, emoji, COUNT(*) as count, MAX(CASE WHEN user_id = ? THEN 1 ELSE 0 END) as user_reacted
         FROM message_reactions
         WHERE message_id IN (${msgPlaceholders})
         GROUP BY message_id, emoji`
      )
      .all(viewerId, ...msgIds) as any[];

    const reactionsByMsg = new Map<number, any[]>();
    for (const rx of allReactions) {
      const mid = Number(rx.message_id);
      let list = reactionsByMsg.get(mid);
      if (!list) {
        list = [];
        reactionsByMsg.set(mid, list);
      }
      list.push({
        emoji: rx.emoji,
        count: rx.count,
        user_reacted: Boolean(rx.user_reacted),
      });
    }

    // Batch-load reply previews referenced by messages in this conversation
    const replyIds = Array.from(
      new Set(rows.map((r) => (r.reply_to_id ? Number(r.reply_to_id) : 0)).filter((id) => id > 0))
    );
    const replyById = new Map<number, any>();
    if (replyIds.length > 0) {
      const replyPlaceholders = replyIds.map(() => '?').join(',');
      const replyRows = db
        .prepare(
          `SELECT m.id, m.content, m.media_type, m.is_unsent, u.name as sender_name
           FROM messages m JOIN users u ON u.id = m.sender_id
           WHERE m.id IN (${replyPlaceholders})`
        )
        .all(...replyIds) as any[];
      for (const rr of replyRows) {
        replyById.set(Number(rr.id), rr);
      }
    }

    // Load conversation member read cursors once to compute seen_by_count in memory
    const memberReadCursors = db
      .prepare('SELECT user_id, last_read_at FROM conversation_members WHERE conversation_id = ?')
      .all(conversationId) as { user_id: number; last_read_at: string }[];

    return rows.map((r) => {
      const replyRow = r.reply_to_id ? replyById.get(Number(r.reply_to_id)) : null;
      const seenCount = memberReadCursors.reduce(
        (acc, m) => (m.user_id !== r.sender_id && m.last_read_at >= r.created_at ? acc + 1 : acc),
        0
      );

      return {
        id: r.id,
        conversation_id: r.conversation_id,
        sender_id: r.sender_id,
        sender_name: r.sender_name,
        sender_username: r.sender_username,
        sender_avatar: r.sender_avatar,
        sender_verified: Boolean(r.sender_verified),
        content: r.is_unsent ? 'Message unsent' : r.content,
        media_type: r.is_unsent ? 'none' : r.media_type,
        media_url: r.is_unsent ? '' : r.media_url,
        media_size_bytes: r.is_unsent ? 0 : resolveDiskSize(r.media_url, r.media_size_bytes || 0),
        reply_to_id: r.reply_to_id,
        reply_preview: replyRow
          ? {
              id: replyRow.id,
              sender_name: replyRow.sender_name,
              content: replyRow.is_unsent ? 'Message unsent' : replyRow.content,
              media_type: replyRow.media_type,
              is_unsent: Boolean(replyRow.is_unsent),
            }
          : null,
        is_unsent: Boolean(r.is_unsent),
        is_forwarded: Boolean(r.is_forwarded),
        forwarded_from_name: r.forwarded_from_name || '',
        reactions: reactionsByMsg.get(Number(r.id)) || [],
        seen_by_count: seenCount,
        created_at: r.created_at,
      };
    });
  }

  app.get('/api/conversations', requireAuth, (req: AuthedRequest, res) => {
    const convIds = db
      .prepare(
        `SELECT c.id FROM conversations c
         JOIN conversation_members cm ON cm.conversation_id = c.id
         WHERE cm.user_id = ? AND c.status != 'rejected'
         ORDER BY c.updated_at DESC, c.id DESC`
      )
      .all(req.userId) as { id: number }[];

    const all = convIds.map((row) => formatConversation(row.id, req.userId!)).filter(Boolean);
    const inbox = all.filter(
      (c: any) => c.status === 'active' || (c.status === 'pending_request' && c.requester_id === req.userId)
    );
    const requests = all.filter(
      (c: any) => c.status === 'pending_request' && c.requester_id !== req.userId
    );
    res.json({ inbox, requests });
  });

  app.post('/api/conversations/direct', requireAuth, (req: AuthedRequest, res) => {
    const targetId = Number(req.body?.userId);
    if (!targetId || targetId === req.userId) {
      res.status(400).json({ error: 'Invalid recipient.' });
      return;
    }

    const target = db
      .prepare('SELECT id, who_can_message, is_blocked FROM users WHERE id = ?')
      .get(targetId) as { id: number; who_can_message: string; is_blocked: number } | undefined;
    if (!target || target.is_blocked) {
      res.status(404).json({ error: 'Member not found.' });
      return;
    }

    const existing = db
      .prepare(
        `SELECT c.id FROM conversations c
         JOIN conversation_members m1 ON m1.conversation_id = c.id AND m1.user_id = ?
         JOIN conversation_members m2 ON m2.conversation_id = c.id AND m2.user_id = ?
         WHERE c.type = 'direct'
         LIMIT 1`
      )
      .get(req.userId, targetId) as { id: number } | undefined;

    if (existing) {
      db.prepare("UPDATE conversations SET status = CASE WHEN status = 'rejected' THEN 'pending_request' ELSE status END WHERE id = ?").run(
        existing.id
      );
      res.json({ conversation: formatConversation(existing.id, req.userId!) });
      return;
    }

    const connected = areUsersConnected(req.userId!, targetId);
    const initialStatus =
      target.who_can_message === 'connections' && !connected ? 'pending_request' : 'active';

    const result = db
      .prepare(
        "INSERT INTO conversations (type, name, created_by, status, requester_id) VALUES ('direct', '', ?, ?, ?)"
      )
      .run(req.userId, initialStatus, req.userId);
    const convId = Number(result.lastInsertRowid);

    db.prepare('INSERT INTO conversation_members (conversation_id, user_id, role) VALUES (?, ?, ?)').run(
      convId,
      req.userId,
      'member'
    );
    db.prepare('INSERT INTO conversation_members (conversation_id, user_id, role) VALUES (?, ?, ?)').run(
      convId,
      targetId,
      'member'
    );

    const conv = formatConversation(convId, req.userId!);
    sendWsToUser(targetId, { type: 'conversation:updated', conversationId: convId });
    res.status(201).json({ conversation: conv });
  });

  app.post('/api/conversations/group', requireAuth, (req: AuthedRequest, res) => {
    try {
      const name = String(req.body?.name || '').trim();
      const joinMode = req.body?.join_mode === 'approval' ? 'approval' : 'direct';
      const maxVideoMbRaw = Number(req.body?.max_video_mb || 25);
      const maxVideoMb = Math.max(MIN_GROUP_VIDEO_MB, Math.min(MAX_GROUP_VIDEO_MB, Math.round(maxVideoMbRaw)));
      const memberIdsInput: number[] = Array.isArray(req.body?.memberIds)
        ? req.body.memberIds.map((n: any) => Number(n)).filter((n: number) => Number.isInteger(n) && n > 0)
        : [];

      const nameCheck = validateTextField(name, 'Group Name', { required: true, maxWords: 20, maxChars: 60 });
      if (!nameCheck.valid) {
        res.status(400).json({ error: nameCheck.error });
        return;
      }

      const uniqueMembers = Array.from(new Set([req.userId!, ...memberIdsInput]));
      if (uniqueMembers.length > MAX_GROUP_MEMBERS) {
        res.status(400).json({ error: `A group can have at most ${MAX_GROUP_MEMBERS} members.` });
        return;
      }

      // Enforce: every initial member must follow the creator (admin) OR be friends (connected) with creator
      for (const uid of uniqueMembers) {
        if (uid === req.userId) continue;
        const elig = checkCandidateGroupEligibility([req.userId!], uid, req.userId!);
        if (!elig.allowed) {
          const targetUser = db.prepare('SELECT name FROM users WHERE id = ?').get(uid) as { name: string } | undefined;
          res.status(403).json({
            error: `${targetUser?.name || 'Member'} cannot be added: ${elig.reason}`,
          });
          return;
        }
      }

      const tempCode = `htv-grp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const result = db
        .prepare(
          "INSERT INTO conversations (type, name, avatar_url, created_by, status, requester_id, join_mode, invite_code, max_video_mb) VALUES ('group', ?, '/src/assets/images/cover_studio_1794997822111.jpg', ?, 'active', ?, ?, ?, ?)"
        )
        .run(name, req.userId, req.userId, joinMode, tempCode, maxVideoMb);
      const convId = Number(result.lastInsertRowid);
      const finalInviteCode = `htv-grp-${convId}-${Math.random().toString(36).slice(2, 6)}`;
      db.prepare('UPDATE conversations SET invite_code = ? WHERE id = ?').run(finalInviteCode, convId);

      const insertMem = db.prepare(
        'INSERT INTO conversation_members (conversation_id, user_id, role) VALUES (?, ?, ?)'
      );
      for (const uid of uniqueMembers) {
        insertMem.run(convId, uid, uid === req.userId ? 'admin' : 'member');
        if (uid !== req.userId) {
          sendWsToUser(uid, { type: 'conversation:updated', conversationId: convId });
        }
      }

      res.status(201).json({ conversation: formatConversation(convId, req.userId!) });
    } catch (err: any) {
      res.status(400).json({ error: err?.message || 'Could not create group.' });
    }
  });

  app.get('/api/groups/create-candidates', requireAuth, (req: AuthedRequest, res) => {
    const users = db
      .prepare('SELECT id, name, username, avatar_url, is_verified, online_status_visibility FROM users WHERE id != ? AND is_blocked = 0 ORDER BY name ASC')
      .all(req.userId) as any[];

    const candidates = users.map((u) => {
      const elig = checkCandidateGroupEligibility([req.userId!], u.id, req.userId!);
      return {
        id: u.id,
        name: u.name,
        username: u.username,
        avatar_url: u.avatar_url,
        is_verified: Boolean(u.is_verified),
        is_online: canSeeOnlineStatus(req.userId!, u.id, u.online_status_visibility),
        follows_admin: elig.followsAdmin,
        is_friend_with_actor_or_admin: elig.connectedWithAdminOrActor,
        eligible: elig.allowed,
        already_member: false,
        pending_request: false,
      };
    });
    res.json({ candidates });
  });

  app.post('/api/conversations/:id/respond', requireAuth, (req: AuthedRequest, res) => {
    const convId = Number(req.params.id);
    const action = req.body?.action;
    const isMember = db
      .prepare('SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?')
      .get(convId, req.userId);
    if (!isMember) {
      res.status(404).json({ error: 'Conversation not found.' });
      return;
    }

    const nextStatus = action === 'accept' ? 'active' : 'rejected';
    db.prepare('UPDATE conversations SET status = ? WHERE id = ?').run(nextStatus, convId);
    res.json({ status: nextStatus, conversation: formatConversation(convId, req.userId!) });
  });

  app.get('/api/conversations/:id/candidates', requireAuth, (req: AuthedRequest, res) => {
    const convId = Number(req.params.id);
    const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(convId) as any;
    if (!conv || conv.type !== 'group') {
      res.status(404).json({ error: 'Group not found.' });
      return;
    }
    const isMem = db
      .prepare('SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?')
      .get(convId, req.userId);
    if (!isMem) {
      res.status(403).json({ error: 'Access denied.' });
      return;
    }

    const adminIds = getGroupAdminIds(convId);
    const memberIds = new Set(
      (db.prepare('SELECT user_id FROM conversation_members WHERE conversation_id = ?').all(convId) as { user_id: number }[]).map(
        (m) => m.user_id
      )
    );
    const pendingIds = new Set(
      (
        db
          .prepare("SELECT user_id FROM group_join_requests WHERE conversation_id = ? AND status = 'pending'")
          .all(convId) as { user_id: number }[]
      ).map((r) => r.user_id)
    );

    const allUsers = db
      .prepare('SELECT id, name, username, avatar_url, is_verified, online_status_visibility FROM users WHERE id != ? AND is_blocked = 0 ORDER BY name ASC')
      .all(req.userId) as any[];

    const candidates = allUsers.map((u) => {
      const elig = checkCandidateGroupEligibility(adminIds, u.id, req.userId!);
      return {
        id: u.id,
        name: u.name,
        username: u.username,
        avatar_url: u.avatar_url,
        is_verified: Boolean(u.is_verified),
        is_online: canSeeOnlineStatus(req.userId!, u.id, u.online_status_visibility),
        follows_admin: elig.followsAdmin,
        is_friend_with_actor_or_admin: elig.connectedWithAdminOrActor,
        eligible: elig.allowed,
        already_member: memberIds.has(u.id),
        pending_request: pendingIds.has(u.id),
      };
    });

    res.json({ candidates });
  });

  app.post('/api/conversations/:id/members', requireAuth, (req: AuthedRequest, res) => {
    try {
      const convId = Number(req.params.id);
      const userIdToAdd = Number(req.body?.userId);
      const requestedMode = req.body?.mode === 'approval' ? 'approval' : req.body?.mode === 'direct' ? 'direct' : null;
      const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(convId) as any;
      if (!conv || conv.type !== 'group') {
        res.status(404).json({ error: 'Group conversation not found.' });
        return;
      }

      const actorMem = db
        .prepare('SELECT role FROM conversation_members WHERE conversation_id = ? AND user_id = ?')
        .get(convId, req.userId) as { role: string } | undefined;
      if (!actorMem) {
        res.status(403).json({ error: 'You are not a member of this group.' });
        return;
      }

      const currentCount = (
        db.prepare('SELECT COUNT(*) as c FROM conversation_members WHERE conversation_id = ?').get(convId) as {
          c: number;
        }
      ).c;
      if (currentCount >= MAX_GROUP_MEMBERS) {
        res.status(400).json({ error: `Group has reached the strict ${MAX_GROUP_MEMBERS}-member limit.` });
        return;
      }

      const already = db
        .prepare('SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?')
        .get(convId, userIdToAdd);
      if (already) {
        res.status(400).json({ error: 'User is already in this group.' });
        return;
      }

      const targetExists = db
        .prepare('SELECT id, name FROM users WHERE id = ? AND is_blocked = 0')
        .get(userIdToAdd) as { id: number; name: string } | undefined;
      if (!targetExists) {
        res.status(404).json({ error: 'Member not found.' });
        return;
      }

      const adminIds = getGroupAdminIds(convId);
      const elig = checkCandidateGroupEligibility(adminIds, userIdToAdd, req.userId!);
      if (!elig.allowed) {
        res.status(403).json({ error: elig.reason });
        return;
      }

      const isActorAdmin = actorMem.role === 'admin' || conv.created_by === req.userId;
      // Two ways to add:
      // 1) Direct Add: when group is in 'direct' mode, OR when group admin directly adds
      // 2) Admin Approval Queue: when group is in 'approval' mode and non-admin invites (or mode === 'approval')
      const shouldRequireApproval =
        requestedMode === 'approval' || (conv.join_mode === 'approval' && !isActorAdmin);

      if (shouldRequireApproval) {
        db.prepare(
          `INSERT INTO group_join_requests (conversation_id, user_id, invited_by, status)
           VALUES (?, ?, ?, 'pending')
           ON CONFLICT(conversation_id, user_id) DO UPDATE SET status = 'pending', invited_by = excluded.invited_by, created_at = datetime('now')`
        ).run(convId, userIdToAdd, req.userId);

        const actorUser = db.prepare('SELECT name FROM users WHERE id = ?').get(req.userId) as { name: string };
        for (const aid of adminIds) {
          if (aid !== req.userId) {
            createNotification(
              aid,
              req.userId!,
              'group_join_request',
              convId,
              `${actorUser.name} requested to add ${targetExists.name} to ${conv.name}`
            );
          }
          sendWsToUser(aid, { type: 'conversation:updated', conversationId: convId });
        }
        res.status(202).json({
          pending: true,
          message: `Request sent for ${targetExists.name}. Waiting for group admin permission.`,
          conversation: formatConversation(convId, req.userId!),
        });
        return;
      }

      db.prepare("INSERT INTO conversation_members (conversation_id, user_id, role) VALUES (?, ?, 'member')").run(
        convId,
        userIdToAdd
      );
      db.prepare("UPDATE group_join_requests SET status = 'approved' WHERE conversation_id = ? AND user_id = ?").run(
        convId,
        userIdToAdd
      );

      const allMems = db
        .prepare('SELECT user_id FROM conversation_members WHERE conversation_id = ?')
        .all(convId) as { user_id: number }[];
      for (const m of allMems) {
        sendWsToUser(m.user_id, { type: 'conversation:updated', conversationId: convId });
      }
      res.json({ pending: false, conversation: formatConversation(convId, req.userId!) });
    } catch (err: any) {
      res.status(400).json({ error: err?.message || 'Could not add member.' });
    }
  });

  app.post('/api/conversations/:id/join-requests/:requestId/respond', requireAuth, (req: AuthedRequest, res) => {
    const convId = Number(req.params.id);
    const requestId = Number(req.params.requestId);
    const action = req.body?.action === 'approve' ? 'approve' : 'reject';

    const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(convId) as any;
    if (!conv || conv.type !== 'group') {
      res.status(404).json({ error: 'Group not found.' });
      return;
    }
    const actorMem = db
      .prepare('SELECT role FROM conversation_members WHERE conversation_id = ? AND user_id = ?')
      .get(convId, req.userId) as { role: string } | undefined;
    if (!actorMem || (actorMem.role !== 'admin' && conv.created_by !== req.userId)) {
      res.status(403).json({ error: 'Only group admins can approve or reject join requests.' });
      return;
    }

    const reqRow = db
      .prepare('SELECT * FROM group_join_requests WHERE id = ? AND conversation_id = ?')
      .get(requestId, convId) as any;
    if (!reqRow) {
      res.status(404).json({ error: 'Join request not found.' });
      return;
    }

    if (action === 'approve') {
      const currentCount = (
        db.prepare('SELECT COUNT(*) as c FROM conversation_members WHERE conversation_id = ?').get(convId) as {
          c: number;
        }
      ).c;
      if (currentCount >= MAX_GROUP_MEMBERS) {
        res.status(400).json({ error: `Group has reached the ${MAX_GROUP_MEMBERS}-member limit.` });
        return;
      }

      const adminIds = getGroupAdminIds(convId);
      const elig = checkCandidateGroupEligibility(adminIds, reqRow.user_id, reqRow.invited_by || req.userId!);
      if (!elig.allowed) {
        res.status(403).json({ error: elig.reason });
        return;
      }

      db.prepare("INSERT OR IGNORE INTO conversation_members (conversation_id, user_id, role) VALUES (?, ?, 'member')").run(
        convId,
        reqRow.user_id
      );
      db.prepare("UPDATE group_join_requests SET status = 'approved' WHERE id = ?").run(requestId);
      createNotification(
        reqRow.user_id,
        req.userId!,
        'group_join_approved',
        convId,
        `Your request to join "${conv.name}" was approved by the group admin.`
      );
    } else {
      db.prepare("UPDATE group_join_requests SET status = 'rejected' WHERE id = ?").run(requestId);
    }

    const members = db
      .prepare('SELECT user_id FROM conversation_members WHERE conversation_id = ?')
      .all(convId) as { user_id: number }[];
    for (const m of members) {
      sendWsToUser(m.user_id, { type: 'conversation:updated', conversationId: convId });
    }
    sendWsToUser(reqRow.user_id, { type: 'conversation:updated', conversationId: convId });

    res.json({ ok: true, conversation: formatConversation(convId, req.userId!) });
  });

  app.patch('/api/conversations/:id/settings', requireAuth, (req: AuthedRequest, res) => {
    const convId = Number(req.params.id);
    const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(convId) as any;
    if (!conv || conv.type !== 'group') {
      res.status(404).json({ error: 'Group not found.' });
      return;
    }
    const actorMem = db
      .prepare('SELECT role FROM conversation_members WHERE conversation_id = ? AND user_id = ?')
      .get(convId, req.userId) as { role: string } | undefined;
    if (!actorMem || (actorMem.role !== 'admin' && conv.created_by !== req.userId)) {
      res.status(403).json({ error: 'Only group admins can update group settings.' });
      return;
    }

    const joinMode =
      req.body?.join_mode === 'approval' ? 'approval' : req.body?.join_mode === 'direct' ? 'direct' : conv.join_mode;
    const maxVideoMb =
      req.body?.max_video_mb !== undefined
        ? Math.max(MIN_GROUP_VIDEO_MB, Math.min(MAX_GROUP_VIDEO_MB, Math.round(Number(req.body.max_video_mb) || 25)))
        : conv.max_video_mb || 25;
    const inviteCode = req.body?.regenerate_invite
      ? `htv-grp-${convId}-${Math.random().toString(36).slice(2, 7)}`
      : conv.invite_code;

    db.prepare('UPDATE conversations SET join_mode = ?, max_video_mb = ?, invite_code = ? WHERE id = ?').run(
      joinMode,
      maxVideoMb,
      inviteCode,
      convId
    );

    const members = db
      .prepare('SELECT user_id FROM conversation_members WHERE conversation_id = ?')
      .all(convId) as { user_id: number }[];
    for (const m of members) {
      sendWsToUser(m.user_id, { type: 'conversation:updated', conversationId: convId });
    }

    res.json({ conversation: formatConversation(convId, req.userId!) });
  });

  app.get('/api/groups/preview/:code', requireAuth, (req: AuthedRequest, res) => {
    const code = String(req.params.code || '').trim();
    const conv = db
      .prepare("SELECT * FROM conversations WHERE type = 'group' AND invite_code = ?")
      .get(code) as any;
    if (!conv) {
      res.status(404).json({ error: 'Invalid or expired group invite link.' });
      return;
    }

    const memberCount = (
      db.prepare('SELECT COUNT(*) as c FROM conversation_members WHERE conversation_id = ?').get(conv.id) as {
        c: number;
      }
    ).c;
    const alreadyMember = Boolean(
      db
        .prepare('SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?')
        .get(conv.id, req.userId)
    );
    const pendingRequest = Boolean(
      db
        .prepare("SELECT 1 FROM group_join_requests WHERE conversation_id = ? AND user_id = ? AND status = 'pending'")
        .get(conv.id, req.userId)
    );
    const adminIds = getGroupAdminIds(conv.id);
    const elig = checkCandidateGroupEligibility(adminIds, req.userId!, req.userId!);
    const creator = db.prepare('SELECT name, username FROM users WHERE id = ?').get(conv.created_by) as
      | { name: string; username: string }
      | undefined;

    res.json({
      group: {
        id: conv.id,
        name: conv.name,
        avatar_url: conv.avatar_url,
        invite_code: conv.invite_code,
        join_mode: conv.join_mode || 'direct',
        member_count: memberCount,
        creator_id: conv.created_by,
        creator_name: creator?.name || 'Admin',
        creator_username: creator?.username || 'admin',
        already_member: alreadyMember,
        pending_request: pendingRequest,
        eligible: elig.allowed,
        eligibility_reason: elig.reason || '',
      },
    });
  });

  app.post('/api/groups/join-by-code', requireAuth, (req: AuthedRequest, res) => {
    const code = String(req.body?.code || '').trim();
    const conv = db
      .prepare("SELECT * FROM conversations WHERE type = 'group' AND invite_code = ?")
      .get(code) as any;
    if (!conv) {
      res.status(404).json({ error: 'Invalid or expired group invite link.' });
      return;
    }

    const already = db
      .prepare('SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?')
      .get(conv.id, req.userId);
    if (already) {
      res.json({ joined: true, pending: false, conversation: formatConversation(conv.id, req.userId!) });
      return;
    }

    const currentCount = (
      db.prepare('SELECT COUNT(*) as c FROM conversation_members WHERE conversation_id = ?').get(conv.id) as {
        c: number;
      }
    ).c;
    if (currentCount >= MAX_GROUP_MEMBERS) {
      res.status(400).json({ error: `Group has reached the ${MAX_GROUP_MEMBERS}-member limit.` });
      return;
    }

    const adminIds = getGroupAdminIds(conv.id);
    const elig = checkCandidateGroupEligibility(adminIds, req.userId!, req.userId!);
    if (!elig.allowed) {
      res.status(403).json({ error: elig.reason });
      return;
    }

    if ((conv.join_mode || 'direct') === 'approval') {
      db.prepare(
        `INSERT INTO group_join_requests (conversation_id, user_id, invited_by, status)
         VALUES (?, ?, ?, 'pending')
         ON CONFLICT(conversation_id, user_id) DO UPDATE SET status = 'pending', created_at = datetime('now')`
      ).run(conv.id, req.userId, req.userId);
      const actor = db.prepare('SELECT name FROM users WHERE id = ?').get(req.userId) as { name: string };
      for (const aid of adminIds) {
        createNotification(
          aid,
          req.userId!,
          'group_join_request',
          conv.id,
          `${actor.name} requested to join "${conv.name}" via invite link.`
        );
        sendWsToUser(aid, { type: 'conversation:updated', conversationId: conv.id });
      }
      res.status(202).json({
        joined: false,
        pending: true,
        message: 'Join request sent. Waiting for group admin approval.',
      });
      return;
    }

    db.prepare("INSERT INTO conversation_members (conversation_id, user_id, role) VALUES (?, ?, 'member')").run(
      conv.id,
      req.userId
    );
    const allMems = db
      .prepare('SELECT user_id FROM conversation_members WHERE conversation_id = ?')
      .all(conv.id) as { user_id: number }[];
    for (const m of allMems) {
      sendWsToUser(m.user_id, { type: 'conversation:updated', conversationId: conv.id });
    }
    res.status(201).json({
      joined: true,
      pending: false,
      conversation: formatConversation(conv.id, req.userId!),
    });
  });

  app.post('/api/conversations/:id/mute', requireAuth, (req: AuthedRequest, res) => {
    const convId = Number(req.params.id);
    const muted = Boolean(req.body?.muted);
    const mem = db
      .prepare('SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?')
      .get(convId, req.userId);
    if (!mem) {
      res.status(404).json({ error: 'Conversation not found.' });
      return;
    }
    db.prepare('UPDATE conversation_members SET is_muted = ? WHERE conversation_id = ? AND user_id = ?').run(
      muted ? 1 : 0,
      convId,
      req.userId
    );
    res.json({ is_muted: muted, conversation: formatConversation(convId, req.userId!) });
  });

  app.post('/api/conversations/:id/members/:userId/mute', requireAuth, (req: AuthedRequest, res) => {
    const convId = Number(req.params.id);
    const targetUserId = Number(req.params.userId);
    const muted = Boolean(req.body?.muted);
    const durationMinutes = Number(req.body?.durationMinutes || 0);

    const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(convId) as any;
    if (!conv || conv.type !== 'group') {
      res.status(404).json({ error: 'Group conversation not found.' });
      return;
    }

    const actorMem = db
      .prepare('SELECT role FROM conversation_members WHERE conversation_id = ? AND user_id = ?')
      .get(convId, req.userId) as { role: string } | undefined;
    if (!actorMem || (actorMem.role !== 'admin' && conv.created_by !== req.userId)) {
      res.status(403).json({ error: 'Only group admins can mute members.' });
      return;
    }
    if (targetUserId === req.userId) {
      res.status(400).json({ error: 'You cannot mute yourself.' });
      return;
    }

    const mutedUntil =
      muted && durationMinutes > 0
        ? new Date(Date.now() + durationMinutes * 60 * 1000).toISOString()
        : '';

    db.prepare(
      'UPDATE conversation_members SET is_chat_muted = ?, chat_muted_until = ? WHERE conversation_id = ? AND user_id = ?'
    ).run(muted ? 1 : 0, mutedUntil, convId, targetUserId);

    const members = db
      .prepare('SELECT user_id FROM conversation_members WHERE conversation_id = ?')
      .all(convId) as { user_id: number }[];
    for (const m of members) {
      sendWsToUser(m.user_id, { type: 'conversation:updated', conversationId: convId });
    }

    res.json({ ok: true, conversation: formatConversation(convId, req.userId!) });
  });

  app.delete('/api/conversations/:id/members/:userId', requireAuth, (req: AuthedRequest, res) => {
    const convId = Number(req.params.id);
    const targetUserId = Number(req.params.userId);

    const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(convId) as any;
    if (!conv || conv.type !== 'group') {
      res.status(404).json({ error: 'Group conversation not found.' });
      return;
    }

    const actorMem = db
      .prepare('SELECT role FROM conversation_members WHERE conversation_id = ? AND user_id = ?')
      .get(convId, req.userId) as { role: string } | undefined;
    if (!actorMem) {
      res.status(403).json({ error: 'Access denied.' });
      return;
    }

    const isSelfLeave = targetUserId === req.userId;
    if (!isSelfLeave && actorMem.role !== 'admin' && conv.created_by !== req.userId) {
      res.status(403).json({ error: 'Only group admins can remove other members.' });
      return;
    }

    db.prepare('DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?').run(
      convId,
      targetUserId
    );
    sendWsToUser(targetUserId, { type: 'conversation:removed', conversationId: convId });

    const remaining = db
      .prepare('SELECT user_id FROM conversation_members WHERE conversation_id = ?')
      .all(convId) as { user_id: number }[];
    for (const m of remaining) {
      sendWsToUser(m.user_id, { type: 'conversation:updated', conversationId: convId });
    }

    res.json({
      left: isSelfLeave,
      conversation: isSelfLeave ? null : formatConversation(convId, req.userId!),
    });
  });

  app.get('/api/conversations/:id/messages', requireAuth, (req: AuthedRequest, res) => {
    const convId = Number(req.params.id);
    const isMember = db
      .prepare('SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?')
      .get(convId, req.userId);
    if (!isMember) {
      res.status(403).json({ error: 'You do not have access to this conversation.' });
      return;
    }

    db.prepare(
      "UPDATE conversation_members SET last_read_at = datetime('now') WHERE conversation_id = ? AND user_id = ?"
    ).run(convId, req.userId);

    const messages = formatMessages(convId, req.userId!);
    const members = db
      .prepare('SELECT user_id FROM conversation_members WHERE conversation_id = ? AND user_id != ?')
      .all(convId, req.userId) as { user_id: number }[];
    for (const m of members) {
      sendWsToUser(m.user_id, { type: 'conversation:read', conversationId: convId, userId: req.userId });
    }

    res.json({ messages });
  });

  app.post('/api/conversations/:id/read', requireAuth, (req: AuthedRequest, res) => {
    const convId = Number(req.params.id);
    db.prepare(
      "UPDATE conversation_members SET last_read_at = datetime('now') WHERE conversation_id = ? AND user_id = ?"
    ).run(convId, req.userId);
    const members = db
      .prepare('SELECT user_id FROM conversation_members WHERE conversation_id = ? AND user_id != ?')
      .all(convId, req.userId) as { user_id: number }[];
    for (const m of members) {
      sendWsToUser(m.user_id, { type: 'conversation:read', conversationId: convId, userId: req.userId });
    }
    res.json({ ok: true });
  });

  app.post('/api/conversations/:id/messages', requireAuth, (req: AuthedRequest, res) => {
    try {
      const convId = Number(req.params.id);
      const memRow = db
        .prepare('SELECT is_chat_muted, chat_muted_until FROM conversation_members WHERE conversation_id = ? AND user_id = ?')
        .get(convId, req.userId) as { is_chat_muted: number; chat_muted_until: string } | undefined;
      if (!memRow) {
        res.status(403).json({ error: 'Not a member of this conversation.' });
        return;
      }

      if (memRow.is_chat_muted) {
        if (isMuteActive(memRow.is_chat_muted, memRow.chat_muted_until || '')) {
          res.status(403).json({
            error: 'You are currently muted in this group by an admin due to repeated messages.',
          });
          return;
        } else {
          db.prepare(
            "UPDATE conversation_members SET is_chat_muted = 0, chat_muted_until = '' WHERE conversation_id = ? AND user_id = ?"
          ).run(convId, req.userId);
        }
      }

      // Anti-SMS flood guard: max 10 messages in 10 seconds per conversation per user
      const recentBurst = (
        db
          .prepare(
            "SELECT COUNT(*) as c FROM messages WHERE conversation_id = ? AND sender_id = ? AND created_at >= datetime('now', '-10 seconds')"
          )
          .get(convId, req.userId) as { c: number }
      ).c;
      if (recentBurst >= 10) {
        res.status(429).json({
          error: 'Too many repeated messages in a short time. Please wait a few seconds before sending again.',
        });
        return;
      }

      const content = sanitizePlainText(req.body?.content || '', 4000);
      const mediaType = String(req.body?.media_type || 'none');
      const mediaUrl = mediaType === 'none' ? '' : sanitizeMediaUrl(req.body?.media_url);
      const requestedSizeBytes = Math.max(0, Number(req.body?.media_size_bytes || 0));
      const replyToId = req.body?.reply_to_id ? parsePositiveInt(req.body.reply_to_id) : null;

      const convRow = db
        .prepare('SELECT type, max_video_mb FROM conversations WHERE id = ?')
        .get(convId) as { type: 'direct' | 'group'; max_video_mb: number } | undefined;
      if (!convRow) {
        res.status(404).json({ error: 'Conversation not found.' });
        return;
      }

      if (convRow.type === 'group') {
        if (!['none', 'image', 'audio', 'video'].includes(mediaType)) {
          res.status(400).json({
            error: 'Only text, gallery photos, audio, and video are permitted in group chats.',
          });
          return;
        }
      } else {
        if (!['none', 'image'].includes(mediaType)) {
          res.status(400).json({
            error: 'Only text and gallery pictures are allowed in direct chats. Videos can only be uploaded inside Group Chats.',
          });
          return;
        }
      }

      const actualSize = resolveDiskSize(mediaUrl, requestedSizeBytes);
      const effectiveGroupMb = Math.min(MAX_GROUP_VIDEO_MB, Math.max(MIN_GROUP_VIDEO_MB, convRow.max_video_mb || 25));
      const maxGroupBytes = effectiveGroupMb * 1024 * 1024;
      if (mediaType === 'video' && actualSize > MAX_UPLOAD_BYTES) {
        res.status(400).json({
          error: 'Video exceeds the maximum permitted upload size.',
        });
        return;
      }
      if (convRow.type === 'group' && mediaType === 'video' && actualSize > maxGroupBytes) {
        res.status(400).json({
          error: 'Video exceeds the permitted size for this group.',
        });
        return;
      }

      if (!content && mediaType === 'none') {
        res.status(400).json({ error: 'Message cannot be empty.' });
        return;
      }

      const check = validateTextField(content, 'Message', { maxWords: MAX_WORDS });
      if (!check.valid) {
        res.status(400).json({ error: check.error });
        return;
      }

      const result = db
        .prepare(
          'INSERT INTO messages (conversation_id, sender_id, content, media_type, media_url, media_size_bytes, reply_to_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
        )
        .run(convId, req.userId, content, mediaType, mediaUrl, actualSize, replyToId);

      db.prepare("UPDATE conversations SET updated_at = datetime('now') WHERE id = ?").run(convId);
      db.prepare(
        "UPDATE conversation_members SET last_read_at = datetime('now') WHERE conversation_id = ? AND user_id = ?"
      ).run(convId, req.userId);

      const newId = Number(result.lastInsertRowid);
      const allMsgs = formatMessages(convId, req.userId!);
      const created = allMsgs.find((m) => m.id === newId);

      const members = db
        .prepare('SELECT user_id FROM conversation_members WHERE conversation_id = ?')
        .all(convId) as { user_id: number }[];
      for (const m of members) {
        sendWsToUser(m.user_id, {
          type: 'message:new',
          conversationId: convId,
          message: created,
        });
      }

      if (convRow.type === 'direct' && content.trim()) {
        triggerCircleDirectMessageAutoReply(convId, req.userId!, content);
      }

      res.status(201).json({ message: created });
    } catch (err: any) {
      res.status(400).json({ error: err?.message || 'Message blocked.' });
    }
  });

  app.post('/api/messages/:id/react', requireAuth, (req: AuthedRequest, res) => {
    const messageId = Number(req.params.id);
    const emoji = String(req.body?.emoji || '');
    if (!ALLOWED_REACTION_EMOJIS.includes(emoji as any)) {
      res.status(400).json({ error: 'Invalid reaction emoji.' });
      return;
    }

    const msg = db.prepare('SELECT conversation_id FROM messages WHERE id = ?').get(messageId) as
      | { conversation_id: number }
      | undefined;
    if (!msg) {
      res.status(404).json({ error: 'Message not found.' });
      return;
    }

    const existing = db
      .prepare('SELECT emoji FROM message_reactions WHERE message_id = ? AND user_id = ?')
      .get(messageId, req.userId) as { emoji: string } | undefined;

    if (existing && existing.emoji === emoji) {
      db.prepare('DELETE FROM message_reactions WHERE message_id = ? AND user_id = ?').run(messageId, req.userId);
    } else {
      db.prepare(
        'INSERT INTO message_reactions (message_id, user_id, emoji) VALUES (?, ?, ?) ON CONFLICT(message_id, user_id) DO UPDATE SET emoji = excluded.emoji'
      ).run(messageId, req.userId, emoji);
    }

    const reactions = (
      db
        .prepare(
          `SELECT emoji, COUNT(*) as count, MAX(CASE WHEN user_id = ? THEN 1 ELSE 0 END) as user_reacted
           FROM message_reactions WHERE message_id = ? GROUP BY emoji`
        )
        .all(req.userId, messageId) as any[]
    ).map((rx) => ({
      emoji: rx.emoji,
      count: rx.count,
      user_reacted: Boolean(rx.user_reacted),
    }));

    const members = db
      .prepare('SELECT user_id FROM conversation_members WHERE conversation_id = ?')
      .all(msg.conversation_id) as { user_id: number }[];
    for (const m of members) {
      sendWsToUser(m.user_id, {
        type: 'message:updated',
        action: 'react',
        conversationId: msg.conversation_id,
        messageId,
      });
    }

    res.json({ ok: true, reactions });
  });

  app.delete('/api/messages/:id', requireAuth, (req: AuthedRequest, res) => {
    const messageId = Number(req.params.id);
    const msg = db
      .prepare('SELECT sender_id, conversation_id, media_type FROM messages WHERE id = ?')
      .get(messageId) as { sender_id: number; conversation_id: number; media_type: string } | undefined;
    if (!msg) {
      res.status(404).json({ error: 'Message not found.' });
      return;
    }

    const conv = db
      .prepare('SELECT type, created_by FROM conversations WHERE id = ?')
      .get(msg.conversation_id) as { type: string; created_by: number } | undefined;
    const actorMem = db
      .prepare('SELECT role FROM conversation_members WHERE conversation_id = ? AND user_id = ?')
      .get(msg.conversation_id, req.userId) as { role: string } | undefined;

    if (!actorMem && req.userRole !== 'admin') {
      res.status(403).json({ error: 'Access denied.' });
      return;
    }

    const isSender = msg.sender_id === req.userId;
    const isSiteAdmin = req.userRole === 'admin';
    const isGroupAdmin =
      conv?.type === 'group' && (conv.created_by === req.userId || actorMem?.role === 'admin');

    if (!isSender && !isSiteAdmin && !isGroupAdmin) {
      res.status(403).json({
        error: 'Only the sender or an admin can delete this video or message.',
      });
      return;
    }

    db.prepare(
      "UPDATE messages SET is_unsent = 1, content = '', media_type = 'none', media_url = '', media_size_bytes = 0 WHERE id = ?"
    ).run(messageId);
    const members = db
      .prepare('SELECT user_id FROM conversation_members WHERE conversation_id = ?')
      .all(msg.conversation_id) as { user_id: number }[];
    for (const m of members) {
      sendWsToUser(m.user_id, {
        type: 'message:updated',
        action: 'unsend',
        conversationId: msg.conversation_id,
        messageId,
      });
    }
    res.json({ ok: true });
  });

  app.post('/api/messages/:id/forward', requireAuth, (req: AuthedRequest, res) => {
    try {
      const rawParamId = Number(req.params.id);
      const rawSourceMsg = req.body?.sourceMessage;
      const messageId =
        Number.isInteger(rawParamId) && rawParamId > 0
          ? rawParamId
          : Number(rawSourceMsg?.id || 0);

      const targetConvIdsInput: number[] = Array.isArray(req.body?.targetConversationIds)
        ? req.body.targetConversationIds.map((n: any) => Number(n)).filter((n: number) => Number.isInteger(n) && n > 0)
        : [];
      const targetUserIdsInput: number[] = Array.isArray(req.body?.targetUserIds)
        ? req.body.targetUserIds.map((n: any) => Number(n)).filter((n: number) => Number.isInteger(n) && n > 0)
        : [];

      if (targetConvIdsInput.length === 0 && targetUserIdsInput.length === 0) {
        res.status(400).json({ error: 'Select at least one chat or friend to forward to.' });
        return;
      }

      let orig =
        Number.isInteger(messageId) && messageId > 0
          ? (db
              .prepare(
                `SELECT m.*, COALESCE(u.name, 'Member') as sender_name
                 FROM messages m LEFT JOIN users u ON u.id = m.sender_id
                 WHERE m.id = ?`
              )
              .get(messageId) as any)
          : undefined;

      if (orig && Number(orig.is_unsent) === 1) {
        res.status(404).json({ error: 'Message not found or was deleted.' });
        return;
      }

      if (!orig && rawSourceMsg && typeof rawSourceMsg === 'object') {
        const srcMediaType = String(rawSourceMsg.media_type || 'none');
        const srcMediaUrl = String(rawSourceMsg.media_url || '').trim();
        const srcContent = String(rawSourceMsg.content || '').trim();
        const srcConvId = Number(rawSourceMsg.conversation_id || 0);

        const isValidMedia =
          ['image', 'audio', 'video'].includes(srcMediaType) &&
          Boolean(resolveSafeUploadVideo(srcMediaUrl));

        if ((isValidMedia || srcContent) && srcConvId > 0) {
          const isSrcMember = db
            .prepare('SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?')
            .get(srcConvId, req.userId);
          if (isSrcMember) {
            orig = {
              id: messageId,
              conversation_id: srcConvId,
              content: srcContent,
              media_type: isValidMedia ? srcMediaType : 'none',
              media_url: isValidMedia ? srcMediaUrl : '',
              media_size_bytes: Number(rawSourceMsg.media_size_bytes || 0),
              sender_name: String(rawSourceMsg.sender_name || 'Member'),
              forwarded_from_name: String(rawSourceMsg.forwarded_from_name || ''),
              is_unsent: 0,
            };
          }
        }
      }

      if (!orig) {
        res.status(404).json({ error: 'Message not found or was deleted.' });
        return;
      }

      const canReadSource = db
        .prepare('SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?')
        .get(orig.conversation_id, req.userId);
      if (!canReadSource && req.userRole !== 'admin') {
        res.status(403).json({ error: 'You cannot forward a message from a chat you are not in.' });
        return;
      }

      const resolvedConvIds = new Set<number>(targetConvIdsInput);

      // Find or create direct conversations for any selected user IDs
      for (const uid of targetUserIdsInput) {
        if (uid === req.userId) continue;
        const targetUser = db
          .prepare('SELECT id, who_can_message, is_blocked FROM users WHERE id = ?')
          .get(uid) as { id: number; who_can_message: string; is_blocked: number } | undefined;
        if (!targetUser || targetUser.is_blocked) continue;

        const existingDirect = db
          .prepare(
            `SELECT c.id FROM conversations c
             JOIN conversation_members m1 ON m1.conversation_id = c.id AND m1.user_id = ?
             JOIN conversation_members m2 ON m2.conversation_id = c.id AND m2.user_id = ?
             WHERE c.type = 'direct' LIMIT 1`
          )
          .get(req.userId, uid) as { id: number } | undefined;

        if (existingDirect) {
          resolvedConvIds.add(existingDirect.id);
        } else {
          const connected = areUsersConnected(req.userId!, uid);
          const initialStatus =
            targetUser.who_can_message === 'connections' && !connected ? 'pending_request' : 'active';
          const createdConv = db
            .prepare(
              "INSERT INTO conversations (type, name, created_by, status, requester_id) VALUES ('direct', '', ?, ?, ?)"
            )
            .run(req.userId, initialStatus, req.userId);
          const newConvId = Number(createdConv.lastInsertRowid);
          db.prepare('INSERT INTO conversation_members (conversation_id, user_id, role) VALUES (?, ?, ?)').run(
            newConvId,
            req.userId,
            'member'
          );
          db.prepare('INSERT INTO conversation_members (conversation_id, user_id, role) VALUES (?, ?, ?)').run(
            newConvId,
            uid,
            'member'
          );
          resolvedConvIds.add(newConvId);
        }
      }

      const forwardedResults: any[] = [];
      const origSize = resolveDiskSize(orig.media_url, orig.media_size_bytes || 0);
      const forwardedFromLabel = orig.forwarded_from_name || orig.sender_name || '';

      for (const convId of resolvedConvIds) {
        const memRow = db
          .prepare('SELECT is_chat_muted, chat_muted_until FROM conversation_members WHERE conversation_id = ? AND user_id = ?')
          .get(convId, req.userId) as { is_chat_muted: number; chat_muted_until: string } | undefined;
        if (!memRow) {
          res.status(403).json({ error: 'Not a member of a selected destination chat.' });
          return;
        }
        if (memRow.is_chat_muted && isMuteActive(memRow.is_chat_muted, memRow.chat_muted_until || '')) {
          res.status(403).json({ error: 'You are muted in one of the selected destination groups.' });
          return;
        }

        const convRow = db
          .prepare('SELECT id, type, name, max_video_mb FROM conversations WHERE id = ?')
          .get(convId) as { id: number; type: 'direct' | 'group'; name: string; max_video_mb: number } | undefined;
        if (!convRow) continue;

        const effectiveGroupMb = Math.min(MAX_GROUP_VIDEO_MB, Math.max(MIN_GROUP_VIDEO_MB, convRow.max_video_mb || 25));
        if (convRow.type === 'group' && orig.media_type === 'video' && origSize > effectiveGroupMb * 1024 * 1024) {
          res.status(400).json({
            error: `Video could not be forwarded to "${convRow.name}" due to size constraints.`,
          });
          return;
        }

        const ins = db
          .prepare(
            `INSERT INTO messages (conversation_id, sender_id, content, media_type, media_url, media_size_bytes, is_forwarded, forwarded_from_name)
             VALUES (?, ?, ?, ?, ?, ?, 1, ?)`
          )
          .run(convId, req.userId, orig.content || '', orig.media_type, orig.media_url || '', origSize, forwardedFromLabel);

        db.prepare("UPDATE conversations SET updated_at = datetime('now') WHERE id = ?").run(convId);
        db.prepare(
          "UPDATE conversation_members SET last_read_at = datetime('now') WHERE conversation_id = ? AND user_id = ?"
        ).run(convId, req.userId);

        const newMsgId = Number(ins.lastInsertRowid);
        const createdMsg = formatMessages(convId, req.userId!).find((m) => m.id === newMsgId);
        forwardedResults.push({ conversationId: convId, message: createdMsg });

        const members = db
          .prepare('SELECT user_id FROM conversation_members WHERE conversation_id = ?')
          .all(convId) as { user_id: number }[];
        for (const m of members) {
          sendWsToUser(m.user_id, {
            type: 'message:new',
            conversationId: convId,
            message: createdMsg,
          });
        }
      }

      res.status(201).json({ forwarded: forwardedResults });
    } catch (err: any) {
      res.status(400).json({ error: err?.message || 'Could not forward message.' });
    }
  });

  // ─────────────────────────────────────────────────────────────
  // COMMUNITY VIDEOS HUB (All Approved Videos Completely Free & Open)
  // ─────────────────────────────────────────────────────────────
  app.get('/api/videos', requireAuth, async (req: AuthedRequest, res) => {
    const q = String(req.query.q || '').trim().toLowerCase();
    const rows = db
      .prepare(
        `SELECT v.*, u.name as uploader_name, u.username as uploader_username, u.avatar_url as uploader_avatar, u.is_verified as uploader_verified,
          (SELECT COUNT(*) FROM video_likes WHERE video_id = v.id) as likes_count,
          (SELECT COUNT(*) FROM video_loves WHERE video_id = v.id) as loves_count,
          (SELECT COUNT(*) FROM video_comments WHERE video_id = v.id) as comments_count,
          EXISTS(SELECT 1 FROM video_likes WHERE video_id = v.id AND user_id = ?) as is_liked,
          EXISTS(SELECT 1 FROM video_loves WHERE video_id = v.id AND user_id = ?) as is_loved
         FROM videos v
         JOIN users u ON u.id = v.uploader_id
         WHERE v.status = 'approved' AND u.is_blocked = 0
         ORDER BY v.created_at DESC`
      )
      .all(req.userId, req.userId) as any[];

    const STATIC_PLACEHOLDER = '/src/assets/images/video_thumb_podcast_1794997823166.jpg';
    const isAudioUrl = (url: string) => /\.(wav|mp3|ogg)$/i.test(String(url || '').split('?')[0]);

    const filtered = rows.filter(
      (v) => !q || v.title.toLowerCase().includes(q) || v.description.toLowerCase().includes(q)
    );

    const mapped = await Promise.all(
      filtered.map(async (v) => {
        let thumbUrl = String(v.thumbnail_url || '');
        if ((!thumbUrl || thumbUrl === STATIC_PLACEHOLDER) && !isAudioUrl(v.video_url)) {
          const localVideo = resolveSafeUploadVideo(v.video_url);
          if (localVideo) {
            const generated = await generateVideoThumbnail(localVideo, THUMB_DIR).catch(() => null);
            if (generated) {
              thumbUrl = `/uploads/thumbs/${generated.filename}`;
              db.prepare('UPDATE videos SET thumbnail_url = ? WHERE id = ?').run(thumbUrl, v.id);
            }
          }
        }
        return {
          ...v,
          thumbnail_url: thumbUrl,
          uploader_verified: Boolean(v.uploader_verified),
          is_liked: Boolean(v.is_liked),
          is_loved: Boolean(v.is_loved),
        };
      })
    );

    res.json({ videos: mapped });
  });

  app.post('/api/videos/:id/view', requireAuth, (req, res) => {
    const videoId = Number(req.params.id);
    db.prepare('UPDATE videos SET views_count = views_count + 1 WHERE id = ?').run(videoId);
    res.json({ ok: true });
  });

  app.post('/api/videos/:id/like', requireAuth, (req: AuthedRequest, res) => {
    const videoId = Number(req.params.id);
    const exists = db.prepare('SELECT 1 FROM video_likes WHERE video_id = ? AND user_id = ?').get(videoId, req.userId);
    if (exists) {
      db.prepare('DELETE FROM video_likes WHERE video_id = ? AND user_id = ?').run(videoId, req.userId);
    } else {
      db.prepare('INSERT INTO video_likes (video_id, user_id) VALUES (?, ?)').run(videoId, req.userId);
    }
    const count = (db.prepare('SELECT COUNT(*) as c FROM video_likes WHERE video_id = ?').get(videoId) as { c: number }).c;
    res.json({ liked: !exists, likes_count: count });
  });

  app.post('/api/videos/:id/love', requireAuth, (req: AuthedRequest, res) => {
    const videoId = Number(req.params.id);
    const exists = db.prepare('SELECT 1 FROM video_loves WHERE video_id = ? AND user_id = ?').get(videoId, req.userId);
    if (exists) {
      db.prepare('DELETE FROM video_loves WHERE video_id = ? AND user_id = ?').run(videoId, req.userId);
    } else {
      db.prepare('INSERT INTO video_loves (video_id, user_id) VALUES (?, ?)').run(videoId, req.userId);
    }
    const count = (db.prepare('SELECT COUNT(*) as c FROM video_loves WHERE video_id = ?').get(videoId) as { c: number }).c;
    res.json({ loved: !exists, loves_count: count });
  });

  app.get('/api/videos/:id/comments', requireAuth, (req, res) => {
    const videoId = Number(req.params.id);
    const rows = db
      .prepare(
        `SELECT c.*, u.name as author_name, u.username as author_username, u.avatar_url as author_avatar, u.is_verified as author_verified
         FROM video_comments c JOIN users u ON u.id = c.user_id
         WHERE c.video_id = ? AND u.is_blocked = 0
         ORDER BY c.created_at ASC`
      )
      .all(videoId) as any[];
    res.json({ comments: rows.map((c) => ({ ...c, author_verified: Boolean(c.author_verified) })) });
  });

  app.post('/api/videos/:id/comments', requireAuth, (req: AuthedRequest, res) => {
    try {
      const videoId = parsePositiveInt(req.params.id);
      if (!videoId) {
        res.status(400).json({ error: 'Invalid video identifier.' });
        return;
      }
      const content = sanitizePlainText(req.body?.content || '', 2500);
      const check = validateTextField(content, 'Comment', { required: true, maxWords: MAX_WORDS });
      if (!check.valid) {
        res.status(400).json({ error: check.error });
        return;
      }
      const videoRow = db.prepare('SELECT id FROM videos WHERE id = ?').get(videoId) as { id: number } | undefined;
      if (!videoRow) {
        res.status(404).json({ error: 'Video not found.' });
        return;
      }
      const result = db
        .prepare('INSERT INTO video_comments (video_id, user_id, content) VALUES (?, ?, ?)')
        .run(videoId, req.userId, content);
      const created = db
        .prepare(
          `SELECT c.*, u.name as author_name, u.username as author_username, u.avatar_url as author_avatar, u.is_verified as author_verified
           FROM video_comments c JOIN users u ON u.id = c.user_id WHERE c.id = ?`
        )
        .get(result.lastInsertRowid) as any;
      res.status(201).json({ comment: { ...created, author_verified: Boolean(created.author_verified) } });
    } catch (err: any) {
      res.status(400).json({ error: err?.message || 'Comment rejected.' });
    }
  });

  // ─────────────────────────────────────────────────────────────
  // CIRCLES (Global/Sequential Distribution + Business Automation)
  // ─────────────────────────────────────────────────────────────
  function getCircleMemberRole(circleId: number, userId: number): string | null {
    const row = db
      .prepare('SELECT role FROM circle_members WHERE circle_id = ? AND user_id = ?')
      .get(circleId, userId) as { role: string } | undefined;
    return row ? row.role : null;
  }

  function hasPendingCircleRequest(circleId: number, userId: number): boolean {
    return Boolean(
      db
        .prepare("SELECT 1 FROM circle_follow_requests WHERE circle_id = ? AND user_id = ? AND status = 'pending'")
        .get(circleId, userId)
    );
  }

  function getOrEnsureCircleAutomationSettings(circleId: number) {
    let row = db
      .prepare('SELECT * FROM circle_automation_settings WHERE circle_id = ?')
      .get(circleId) as any;
    if (!row) {
      db.prepare(
        `INSERT OR IGNORE INTO circle_automation_settings
         (circle_id, auto_welcome_enabled, auto_welcome_message, auto_inquiry_reply_enabled, auto_inquiry_reply_message, auto_approve_verified, auto_keyword_reply_enabled)
         VALUES (?, 0, '', 1, 'Hi {{name}}! Thanks for messaging {{circle}}. Our team has received your inquiry and will reply with details shortly.', 0, 1)`
      ).run(circleId);
      row = db.prepare('SELECT * FROM circle_automation_settings WHERE circle_id = ?').get(circleId) as any;
    }
    return {
      circle_id: circleId,
      auto_welcome_enabled: Boolean(row?.auto_welcome_enabled),
      auto_welcome_message: String(row?.auto_welcome_message || ''),
      auto_inquiry_reply_enabled: row ? Boolean(row.auto_inquiry_reply_enabled) : true,
      auto_inquiry_reply_message: String(row?.auto_inquiry_reply_message || ''),
      auto_approve_verified: Boolean(row?.auto_approve_verified),
      auto_keyword_reply_enabled: row ? Boolean(row.auto_keyword_reply_enabled) : true,
      last_broadcast_at: String(row?.last_broadcast_at || ''),
    };
  }

  function sendAutomatedDirectMessage(senderId: number, recipientId: number, rawMessage: string): number | null {
    if (!senderId || !recipientId || senderId === recipientId) return null;
    const cleanText = sanitizePlainText(rawMessage, 2500);
    const check = validateTextField(cleanText, 'Message', { required: true, maxWords: MAX_WORDS });
    if (!check.valid) return null;

    const sender = db.prepare('SELECT id, is_blocked FROM users WHERE id = ?').get(senderId) as
      | { id: number; is_blocked: number }
      | undefined;
    const recipient = db.prepare('SELECT id, is_blocked FROM users WHERE id = ?').get(recipientId) as
      | { id: number; is_blocked: number }
      | undefined;
    if (!sender || !recipient || sender.is_blocked || recipient.is_blocked) return null;

    try {
      const existing = db
        .prepare(
          `SELECT c.id FROM conversations c
           JOIN conversation_members m1 ON m1.conversation_id = c.id AND m1.user_id = ?
           JOIN conversation_members m2 ON m2.conversation_id = c.id AND m2.user_id = ?
           WHERE c.type = 'direct'
           LIMIT 1`
        )
        .get(senderId, recipientId) as { id: number } | undefined;

      let convId: number;
      if (existing) {
        convId = existing.id;
        db.prepare("UPDATE conversations SET status = 'active', updated_at = datetime('now') WHERE id = ?").run(convId);
      } else {
        const res = db
          .prepare(
            "INSERT INTO conversations (type, name, created_by, status, requester_id) VALUES ('direct', '', ?, 'active', ?)"
          )
          .run(senderId, senderId);
        convId = Number(res.lastInsertRowid);
        db.prepare('INSERT INTO conversation_members (conversation_id, user_id, role) VALUES (?, ?, ?)').run(
          convId,
          senderId,
          'member'
        );
        db.prepare('INSERT INTO conversation_members (conversation_id, user_id, role) VALUES (?, ?, ?)').run(
          convId,
          recipientId,
          'member'
        );
      }

      const msgRes = db
        .prepare(
          'INSERT INTO messages (conversation_id, sender_id, content, media_type, media_url, media_size_bytes) VALUES (?, ?, ?, ?, ?, 0)'
        )
        .run(convId, senderId, cleanText, 'none', '');
      db.prepare("UPDATE conversations SET updated_at = datetime('now') WHERE id = ?").run(convId);
      db.prepare(
        "UPDATE conversation_members SET last_read_at = datetime('now') WHERE conversation_id = ? AND user_id = ?"
      ).run(convId, senderId);

      const newMsgId = Number(msgRes.lastInsertRowid);
      const formatted = formatMessages(convId, senderId).find((m) => m.id === newMsgId);
      if (formatted) {
        sendWsToUser(recipientId, { type: 'message:new', conversationId: convId, message: formatted });
        sendWsToUser(senderId, { type: 'message:new', conversationId: convId, message: formatted });
      }
      sendWsToUser(recipientId, { type: 'conversation:updated', conversationId: convId });
      sendWsToUser(senderId, { type: 'conversation:updated', conversationId: convId });
      return convId;
    } catch {
      return null;
    }
  }

  function triggerCircleAutoWelcome(circleId: number, newUserId: number): void {
    const circle = db.prepare('SELECT id, name, owner_id FROM circles WHERE id = ?').get(circleId) as
      | { id: number; name: string; owner_id: number }
      | undefined;
    if (!circle || circle.owner_id === newUserId) return;

    const settings = getOrEnsureCircleAutomationSettings(circleId);
    if (!settings.auto_welcome_enabled || !settings.auto_welcome_message.trim()) return;

    const memberUser = db.prepare('SELECT name FROM users WHERE id = ?').get(newUserId) as
      | { name: string }
      | undefined;
    const personalized = settings.auto_welcome_message
      .replace(/\{\{\s*name\s*\}\}/gi, memberUser?.name || 'there')
      .replace(/\{\{\s*circle\s*\}\}/gi, circle.name);

    sendAutomatedDirectMessage(circle.owner_id, newUserId, personalized);
  }

  function triggerCircleDirectMessageAutoReply(convId: number, senderId: number, messageText: string): void {
    try {
      const linkedInquiry = db
        .prepare(
          `SELECT id, circle_id
           FROM circle_inquiries
           WHERE conversation_id = ? AND customer_id = ?
           ORDER BY id DESC LIMIT 1`
        )
        .get(convId, senderId) as { id: number; circle_id: number } | undefined;
      if (!linkedInquiry) return;

      const circle = db
        .prepare('SELECT id, name, owner_id FROM circles WHERE id = ?')
        .get(linkedInquiry.circle_id) as { id: number; name: string; owner_id: number } | undefined;
      if (!circle || circle.owner_id === senderId) return;

      const senderRole = getCircleMemberRole(circle.id, senderId);
      if (senderRole === 'owner' || senderRole === 'admin' || senderRole === 'moderator') return;

      const settings = getOrEnsureCircleAutomationSettings(circle.id);
      const lowerMsg = messageText.toLowerCase();
      let autoReplyTemplate: string | null = null;

      if (settings.auto_keyword_reply_enabled) {
        const rules = db
          .prepare('SELECT id, keyword, reply_text FROM circle_keyword_rules WHERE circle_id = ? AND is_active = 1 ORDER BY id ASC')
          .all(circle.id) as { id: number; keyword: string; reply_text: string }[];
        const matchedRule = rules.find((r) => lowerMsg.includes(String(r.keyword || '').trim().toLowerCase()));
        if (matchedRule) {
          db.prepare('UPDATE circle_keyword_rules SET hit_count = hit_count + 1 WHERE id = ?').run(matchedRule.id);
          autoReplyTemplate = matchedRule.reply_text;
        }
      }

      if (!autoReplyTemplate && settings.auto_inquiry_reply_enabled && settings.auto_inquiry_reply_message.trim()) {
        // Avoid repeating generic inquiry reply if staff/owner already messaged within the last 5 minutes
        const recentOwnerReply = db
          .prepare(
            `SELECT 1 FROM messages
             WHERE conversation_id = ? AND sender_id = ? AND created_at >= datetime('now', '-5 minutes')
             LIMIT 1`
          )
          .get(convId, circle.owner_id);
        if (!recentOwnerReply) {
          autoReplyTemplate = settings.auto_inquiry_reply_message;
        }
      }

      if (!autoReplyTemplate) return;

      const actor = db.prepare('SELECT name FROM users WHERE id = ?').get(senderId) as { name: string } | undefined;
      const personalized = autoReplyTemplate
        .replace(/\{\{\s*name\s*\}\}/gi, actor?.name || 'there')
        .replace(/\{\{\s*circle\s*\}\}/gi, circle.name);

      // Deduplicate identical auto-reply sent within the last 60 seconds
      const duplicateRecent = db
        .prepare(
          `SELECT 1 FROM messages
           WHERE conversation_id = ? AND sender_id = ? AND content = ? AND created_at >= datetime('now', '-60 seconds')
           LIMIT 1`
        )
        .get(convId, circle.owner_id, personalized);
      if (duplicateRecent) return;

      sendAutomatedDirectMessage(circle.owner_id, senderId, personalized);
      db.prepare(
        `UPDATE circle_inquiries
         SET status = 'in_progress', last_reply = ?, handled_by = ?, updated_at = datetime('now')
         WHERE id = ?`
      ).run(personalized, circle.owner_id, linkedInquiry.id);
    } catch {
      // Keep direct message send non-blocking if auto-reply encounters an issue
    }
  }

  function dispatchCirclePostToFollowersAndGlobal(circlePostId: number): {
    globalPostId: number | null;
    deliveredCount: number;
  } {
    const cp = db
      .prepare(
        `SELECT cp.*, c.name as circle_name, c.privacy as circle_privacy, c.owner_id as circle_owner_id,
                u.name as author_name
         FROM circle_posts cp
         JOIN circles c ON c.id = cp.circle_id
         JOIN users u ON u.id = cp.user_id
         WHERE cp.id = ? AND cp.status = 'approved'`
      )
      .get(circlePostId) as any;

    if (!cp) return { globalPostId: null, deliveredCount: 0 };

    const isGlobal = cp.circle_privacy === 'public' && Number(cp.is_global ?? 1) === 1 ? 1 : 0;
    let globalPostId: number | null = cp.global_post_id ? Number(cp.global_post_id) : null;

    if (!globalPostId) {
      const insertGlobal = db
        .prepare(
          `INSERT INTO posts (user_id, content, media_type, media_url, views_count, circle_id, circle_post_id, is_global, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          cp.user_id,
          cp.content,
          cp.media_type,
          cp.media_url,
          cp.views_count || 0,
          cp.circle_id,
          cp.id,
          isGlobal,
          cp.created_at
        );
      globalPostId = Number(insertGlobal.lastInsertRowid);
    }

    // Build sequential recipient queue: Circle followers first (by join order), then author followers for public global posts
    const seenRecipients = new Set<number>([Number(cp.user_id)]);
    const sequentialRecipients: number[] = [];

    const circleFollowers = db
      .prepare(
        `SELECT cm.user_id
         FROM circle_members cm
         JOIN users u ON u.id = cm.user_id
         WHERE cm.circle_id = ? AND u.is_blocked = 0
         ORDER BY cm.joined_at ASC, cm.user_id ASC`
      )
      .all(cp.circle_id) as { user_id: number }[];
    for (const row of circleFollowers) {
      if (!seenRecipients.has(row.user_id)) {
        seenRecipients.add(row.user_id);
        sequentialRecipients.push(row.user_id);
      }
    }

    if (isGlobal === 1) {
      const authorFollowers = db
        .prepare(
          `SELECT f.follower_id as user_id
           FROM follows f
           JOIN users u ON u.id = f.follower_id
           WHERE f.following_id = ? AND u.is_blocked = 0
           ORDER BY f.created_at ASC, f.follower_id ASC`
        )
        .all(cp.user_id) as { user_id: number }[];
      for (const row of authorFollowers) {
        if (!seenRecipients.has(row.user_id)) {
          seenRecipients.add(row.user_id);
          sequentialRecipients.push(row.user_id);
        }
      }
    }

    db.prepare('UPDATE circle_posts SET global_post_id = ?, delivered_count = ? WHERE id = ?').run(
      globalPostId,
      sequentialRecipients.length,
      cp.id
    );

    const snippet = (cp.content || 'Shared a gallery photo').slice(0, 60);
    const notifMsg = `${cp.author_name} posted in ${cp.circle_name}: "${snippet}${
      (cp.content || '').length > 60 ? '...' : ''
    }"`;

    // Sequential batch dispatcher (20 followers per tick) so large communities deliver cleanly in order
    const BATCH_SIZE = 20;
    const totalRecipients = sequentialRecipients.length;
    const processBatch = (offset: number) => {
      const slice = sequentialRecipients.slice(offset, offset + BATCH_SIZE);
      for (let i = 0; i < slice.length; i++) {
        const uid = slice[i];
        try {
          createNotification(uid, cp.user_id, 'circle_post', cp.circle_id, notifMsg);
          sendWsToUser(uid, {
            type: 'circle:post:new',
            circleId: cp.circle_id,
            circleName: cp.circle_name,
            circlePostId: cp.id,
            globalPostId,
            isGlobal: Boolean(isGlobal),
            sequenceIndex: offset + i + 1,
            totalRecipients,
          });
        } catch {
          // Continue sequential dispatch safely if an individual delivery fails
        }
      }
      if (offset + BATCH_SIZE < totalRecipients) {
        setTimeout(() => processBatch(offset + BATCH_SIZE), 35);
      }
    };

    if (totalRecipients > 0) {
      processBatch(0);
    }

    if (isGlobal === 1) {
      for (const [uid, sockets] of activeSockets.entries()) {
        if (uid === cp.user_id) continue;
        for (const ws of sockets) {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({
                type: 'feed:new_post',
                postId: globalPostId,
                circleId: cp.circle_id,
                circleName: cp.circle_name,
              })
            );
          }
        }
      }
    }

    return { globalPostId, deliveredCount: totalRecipients };
  }

  function triggerCircleCommentAutomation(
    circleId: number,
    circlePostId: number,
    commenterId: number,
    commentContent: string
  ): any | null {
    const commenterRole = getCircleMemberRole(circleId, commenterId);
    if (commenterRole === 'owner' || commenterRole === 'admin' || commenterRole === 'moderator') {
      return null;
    }

    const circle = db.prepare('SELECT id, name, owner_id FROM circles WHERE id = ?').get(circleId) as
      | { id: number; name: string; owner_id: number }
      | undefined;
    if (!circle || circle.owner_id === commenterId) return null;

    const settings = getOrEnsureCircleAutomationSettings(circleId);
    if (!settings.auto_keyword_reply_enabled) return null;

    const rules = db
      .prepare('SELECT * FROM circle_keyword_rules WHERE circle_id = ? AND is_active = 1 ORDER BY id ASC')
      .all(circleId) as any[];
    const lowerText = commentContent.toLowerCase();
    const matched = rules.find((r) => lowerText.includes(String(r.keyword || '').trim().toLowerCase()));
    if (!matched) return null;

    db.prepare('UPDATE circle_keyword_rules SET hit_count = hit_count + 1 WHERE id = ?').run(matched.id);

    let autoComment: any = null;
    const alreadyReplied = db
      .prepare('SELECT 1 FROM circle_post_comments WHERE post_id = ? AND user_id = ? AND content = ?')
      .get(circlePostId, circle.owner_id, matched.reply_text);
    if (!alreadyReplied) {
      const cRes = db
        .prepare('INSERT INTO circle_post_comments (post_id, user_id, content) VALUES (?, ?, ?)')
        .run(circlePostId, circle.owner_id, matched.reply_text);
      autoComment = db
        .prepare(
          `SELECT c.*, u.name as author_name, u.username as author_username, u.avatar_url as author_avatar, u.is_verified as author_verified
           FROM circle_post_comments c JOIN users u ON u.id = c.user_id WHERE c.id = ?`
        )
        .get(cRes.lastInsertRowid) as any;

      const linkedPost = db
        .prepare('SELECT global_post_id FROM circle_posts WHERE id = ?')
        .get(circlePostId) as { global_post_id: number | null } | undefined;
      if (linkedPost?.global_post_id) {
        db.prepare('INSERT INTO post_comments (post_id, user_id, content) VALUES (?, ?, ?)').run(
          linkedPost.global_post_id,
          circle.owner_id,
          matched.reply_text
        );
      }
    }

    if (matched.create_inquiry) {
      const convId = sendAutomatedDirectMessage(
        circle.owner_id,
        commenterId,
        `[${circle.name}] Auto-Reply (${matched.keyword}): ${matched.reply_text}`
      );
      db.prepare(
        `INSERT INTO circle_inquiries (circle_id, customer_id, source, post_id, conversation_id, message, status, last_reply, handled_by)
         VALUES (?, ?, 'comment_keyword', ?, ?, ?, 'in_progress', ?, ?)`
      ).run(
        circleId,
        commenterId,
        circlePostId,
        convId,
        commentContent,
        matched.reply_text,
        circle.owner_id
      );

      const staff = db
        .prepare("SELECT user_id FROM circle_members WHERE circle_id = ? AND role IN ('owner', 'admin', 'moderator')")
        .all(circleId) as { user_id: number }[];
      for (const s of staff) {
        createNotification(
          s.user_id,
          commenterId,
          'circle_inquiry',
          circleId,
          `Auto-captured keyword inquiry ("${matched.keyword}") in ${circle.name}`
        );
      }
    }

    return autoComment
      ? {
          ...autoComment,
          author_avatar: sanitizeMediaUrl(autoComment.author_avatar),
          author_verified: Boolean(autoComment.author_verified),
        }
      : null;
  }

  function formatCircleRow(circle: any, viewerId: number) {
    const viewerRole = getCircleMemberRole(circle.id, viewerId);
    const isStaff = viewerRole === 'owner' || viewerRole === 'admin' || viewerRole === 'moderator';
    const pendingPostsCount = isStaff
      ? (
          db
            .prepare("SELECT COUNT(*) as c FROM circle_posts WHERE circle_id = ? AND status = 'pending'")
            .get(circle.id) as { c: number }
        ).c
      : 0;
    const pendingRequestsCount = isStaff
      ? (
          db
            .prepare("SELECT COUNT(*) as c FROM circle_follow_requests WHERE circle_id = ? AND status = 'pending'")
            .get(circle.id) as { c: number }
        ).c
      : 0;

    return {
      id: circle.id,
      name: circle.name,
      category: circle.category,
      description: circle.description,
      avatar_url: sanitizeMediaUrl(circle.avatar_url),
      privacy: circle.privacy === 'private' ? 'private' : 'public',
      require_post_approval: Boolean(circle.require_post_approval),
      invite_code: circle.invite_code || '',
      owner_id: circle.owner_id,
      owner_name: circle.owner_name,
      owner_username: circle.owner_username,
      viewer_role: viewerRole,
      is_member: Boolean(viewerRole),
      pending_request: viewerRole ? false : hasPendingCircleRequest(circle.id, viewerId),
      member_count: Number(circle.member_count || 0),
      post_count: Number(circle.post_count || 0),
      pending_posts_count: pendingPostsCount,
      pending_requests_count: pendingRequestsCount,
      created_at: circle.created_at,
    };
  }

  function hydrateCirclePostRows(rows: any[]) {
    if (rows.length === 0) return [];
    const postIds = rows.map((r) => Number(r.id));
    const placeholders = postIds.map(() => '?').join(',');
    const allComments = db
      .prepare(
        `SELECT c.*, u.name as author_name, u.username as author_username, u.avatar_url as author_avatar, u.is_verified as author_verified
         FROM circle_post_comments c
         JOIN users u ON u.id = c.user_id
         WHERE c.post_id IN (${placeholders}) AND u.is_blocked = 0
         ORDER BY c.created_at ASC, c.id ASC`
      )
      .all(...postIds) as any[];

    const commentsByPost = new Map<number, any[]>();
    for (const c of allComments) {
      const pid = Number(c.post_id);
      let list = commentsByPost.get(pid);
      if (!list) {
        list = [];
        commentsByPost.set(pid, list);
      }
      list.push({
        ...c,
        author_avatar: sanitizeMediaUrl(c.author_avatar),
        author_verified: Boolean(c.author_verified),
      });
    }

    return rows.map((r) => ({
      id: r.id,
      circle_id: r.circle_id,
      ...(r.circle_name !== undefined ? { circle_name: r.circle_name } : {}),
      ...(r.circle_category !== undefined ? { circle_category: r.circle_category } : {}),
      ...(r.circle_privacy !== undefined
        ? { circle_privacy: r.circle_privacy === 'private' ? 'private' : 'public' }
        : {}),
      ...(r.circle_avatar !== undefined ? { circle_avatar: sanitizeMediaUrl(r.circle_avatar) } : {}),
      ...(r.circle_viewer_role !== undefined ? { circle_viewer_role: r.circle_viewer_role } : {}),
      user_id: r.user_id,
      author_name: r.author_name,
      author_username: r.author_username,
      author_avatar: sanitizeMediaUrl(r.author_avatar),
      author_verified: Boolean(r.author_verified),
      content: r.content,
      media_type: r.media_type === 'image' ? 'image' : 'none',
      media_url: sanitizeMediaUrl(r.media_url),
      status: r.status,
      likes_count: Number(r.likes_count || 0),
      comments_count: Number(r.comments_count || 0),
      shares_count: Number(r.shares_count || 0),
      views_count: Number(r.views_count || 0),
      has_viewed: Boolean(r.has_viewed),
      is_liked: Boolean(r.is_liked),
      is_global: Boolean(r.is_global ?? 1),
      global_post_id: r.global_post_id ? Number(r.global_post_id) : null,
      delivered_count: Number(r.delivered_count || 0),
      comments: commentsByPost.get(Number(r.id)) || [],
      created_at: r.created_at,
    }));
  }

  function formatCirclePosts(circleId: number, viewerId: number, status: 'approved' | 'pending') {
    const rows = db
      .prepare(
        `SELECT p.*, u.name as author_name, u.username as author_username, u.avatar_url as author_avatar, u.is_verified as author_verified,
          (SELECT COUNT(*) FROM circle_post_likes WHERE post_id = p.id) as likes_count,
          (SELECT COUNT(*) FROM circle_post_comments WHERE post_id = p.id) as comments_count,
          (SELECT COUNT(*) FROM circle_post_shares WHERE post_id = p.id) as shares_count,
          EXISTS(SELECT 1 FROM circle_post_likes WHERE post_id = p.id AND user_id = ?) as is_liked,
          EXISTS(SELECT 1 FROM circle_post_views WHERE post_id = p.id AND user_id = ?) as has_viewed
         FROM circle_posts p
         JOIN users u ON u.id = p.user_id
         WHERE p.circle_id = ? AND p.status = ? AND u.is_blocked = 0
         ORDER BY p.created_at DESC, p.id DESC
         LIMIT 60`
      )
      .all(viewerId, viewerId, circleId, status) as any[];

    return hydrateCirclePostRows(rows);
  }

  app.get('/api/circles', requireAuth, (req: AuthedRequest, res) => {
    try {
      const rows = db
        .prepare(
          `SELECT c.*, u.name as owner_name, u.username as owner_username,
            (SELECT COUNT(*) FROM circle_members WHERE circle_id = c.id) as member_count,
            (SELECT COUNT(*) FROM circle_posts WHERE circle_id = c.id AND status = 'approved') as post_count
           FROM circles c
           JOIN users u ON u.id = c.owner_id
           WHERE u.is_blocked = 0
           ORDER BY c.created_at DESC, c.id DESC`
        )
        .all() as any[];

      res.json({ circles: rows.map((c) => formatCircleRow(c, req.userId!)) });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Failed to load Circles.' });
    }
  });

  app.post('/api/circles', requireAuth, (req: AuthedRequest, res) => {
    try {
      const name = sanitizePlainText(req.body?.name || '', 80);
      const category = sanitizePlainText(req.body?.category || 'Community', 50) || 'Community';
      const description = sanitizePlainText(req.body?.description || '', 800);
      const avatarUrl = sanitizeMediaUrl(req.body?.avatar_url) || '/src/assets/images/cover_studio_1794997822111.jpg';
      const privacy = req.body?.privacy === 'private' ? 'private' : 'public';
      const requirePostApproval = req.body?.require_post_approval ? 1 : 0;

      const nameCheck = validateTextField(name, 'Circle Name', { required: true, maxWords: 15 });
      if (!nameCheck.valid) {
        res.status(400).json({ error: nameCheck.error });
        return;
      }
      const descCheck = validateTextField(description, 'Circle Description', { maxWords: MAX_WORDS });
      if (!descCheck.valid) {
        res.status(400).json({ error: descCheck.error });
        return;
      }

      const tempCode = `htv-cir-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const createTx = db.transaction(() => {
        const result = db
          .prepare(
            'INSERT INTO circles (name, category, description, avatar_url, privacy, require_post_approval, invite_code, owner_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
          )
          .run(name, category, description, avatarUrl, privacy, requirePostApproval, tempCode, req.userId);
        const circleId = Number(result.lastInsertRowid);
        const inviteCode = `htv-cir-${circleId}-${Math.random().toString(36).slice(2, 6)}`;
        db.prepare('UPDATE circles SET invite_code = ? WHERE id = ?').run(inviteCode, circleId);
        db.prepare('INSERT INTO circle_members (circle_id, user_id, role) VALUES (?, ?, ?)').run(
          circleId,
          req.userId,
          'owner'
        );
        return circleId;
      });

      const circleId = createTx();
      const row = db
        .prepare(
          `SELECT c.*, u.name as owner_name, u.username as owner_username,
            (SELECT COUNT(*) FROM circle_members WHERE circle_id = c.id) as member_count,
            (SELECT COUNT(*) FROM circle_posts WHERE circle_id = c.id AND status = 'approved') as post_count
           FROM circles c JOIN users u ON u.id = c.owner_id WHERE c.id = ?`
        )
        .get(circleId);

      res.status(201).json({ circle: formatCircleRow(row, req.userId!) });
    } catch (err: any) {
      res.status(400).json({ error: err?.message || 'Could not create Circle.' });
    }
  });

  app.get('/api/circles/feed/aggregated', requireAuth, (req: AuthedRequest, res) => {
    try {
      const rawLimit = Number(req.query.limit);
      const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(40, Math.floor(rawLimit)) : 15;
      const rawOffset = Number(req.query.offset);
      const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? Math.floor(rawOffset) : 0;

      const rows = db
        .prepare(
          `WITH scored_circle_posts AS (
             SELECT
               p.*,
               c.name as circle_name,
               c.category as circle_category,
               c.privacy as circle_privacy,
               c.avatar_url as circle_avatar,
               cm.role as circle_viewer_role,
               u.name as author_name,
               u.username as author_username,
               u.avatar_url as author_avatar,
               u.is_verified as author_verified,
               (SELECT COUNT(*) FROM circle_post_likes WHERE post_id = p.id) as likes_count,
               (SELECT COUNT(*) FROM circle_post_comments WHERE post_id = p.id) as comments_count,
               (SELECT COUNT(*) FROM circle_post_shares WHERE post_id = p.id) as shares_count
             FROM circle_members cm
             JOIN circle_posts p ON p.circle_id = cm.circle_id AND p.status = 'approved'
             JOIN circles c ON c.id = p.circle_id
             JOIN users u ON u.id = p.user_id
             JOIN users co ON co.id = c.owner_id
             WHERE cm.user_id = ? AND u.is_blocked = 0 AND co.is_blocked = 0
           )
           SELECT s.*,
             EXISTS(SELECT 1 FROM circle_post_likes WHERE post_id = s.id AND user_id = ?) as is_liked,
             EXISTS(SELECT 1 FROM circle_post_views WHERE post_id = s.id AND user_id = ?) as has_viewed
           FROM scored_circle_posts s
           ORDER BY (
             (s.likes_count * 2 + s.comments_count * 3 + s.shares_count * 4 + MIN(s.views_count, 50) * 0.1)
             - ((julianday('now') - julianday(s.created_at)) * 3.0)
           ) DESC, s.created_at DESC, s.id DESC
           LIMIT ? OFFSET ?`
        )
        .all(req.userId, req.userId, req.userId, limit + 1, offset) as any[];

      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;
      res.json({
        posts: hydrateCirclePostRows(pageRows),
        hasMore,
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Could not load aggregated Circles feed.' });
    }
  });

  app.get('/api/circles/:id', requireAuth, (req: AuthedRequest, res) => {
    try {
      const circleId = parsePositiveInt(req.params.id);
      if (!circleId) {
        res.status(400).json({ error: 'Invalid Circle identifier.' });
        return;
      }

      const circleRow = db
        .prepare(
          `SELECT c.*, u.name as owner_name, u.username as owner_username,
            (SELECT COUNT(*) FROM circle_members WHERE circle_id = c.id) as member_count,
            (SELECT COUNT(*) FROM circle_posts WHERE circle_id = c.id AND status = 'approved') as post_count
           FROM circles c JOIN users u ON u.id = c.owner_id WHERE c.id = ?`
        )
        .get(circleId) as any;

      if (!circleRow) {
        res.status(404).json({ error: 'Circle not found.' });
        return;
      }

      const viewerRole = getCircleMemberRole(circleId, req.userId!);
      const isMember = Boolean(viewerRole);
      const isStaff = viewerRole === 'owner' || viewerRole === 'admin' || viewerRole === 'moderator';
      const canViewFeed = circleRow.privacy === 'public' || isMember || req.userRole === 'admin';

      const members = canViewFeed
        ? (
            db
              .prepare(
                `SELECT cm.user_id, cm.role, cm.joined_at, u.name, u.username, u.avatar_url, u.is_verified, u.online_status_visibility
                 FROM circle_members cm
                 JOIN users u ON u.id = cm.user_id
                 WHERE cm.circle_id = ? AND u.is_blocked = 0
                 ORDER BY CASE cm.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'moderator' THEN 2 ELSE 3 END, cm.joined_at ASC`
              )
              .all(circleId) as any[]
          ).map((m) => ({
            user_id: m.user_id,
            name: m.name,
            username: m.username,
            avatar_url: sanitizeMediaUrl(m.avatar_url),
            is_verified: Boolean(m.is_verified),
            is_online: canSeeOnlineStatus(req.userId!, m.user_id, m.online_status_visibility),
            role: m.role,
            joined_at: m.joined_at,
          }))
        : [];

      const followRequests = isStaff
        ? (
            db
              .prepare(
                `SELECT r.id, r.circle_id, r.user_id, r.created_at, u.name, u.username, u.avatar_url, u.is_verified
                 FROM circle_follow_requests r
                 JOIN users u ON u.id = r.user_id
                 WHERE r.circle_id = ? AND r.status = 'pending' AND u.is_blocked = 0
                 ORDER BY r.created_at ASC`
              )
              .all(circleId) as any[]
          ).map((r) => ({
            ...r,
            avatar_url: sanitizeMediaUrl(r.avatar_url),
            is_verified: Boolean(r.is_verified),
          }))
        : [];

      const posts = canViewFeed ? formatCirclePosts(circleId, req.userId!, 'approved') : [];
      const pendingPosts = isStaff ? formatCirclePosts(circleId, req.userId!, 'pending') : [];

      res.json({
        circle: formatCircleRow(circleRow, req.userId!),
        members,
        follow_requests: followRequests,
        posts,
        pending_posts: pendingPosts,
        can_view_feed: canViewFeed,
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Could not load Circle.' });
    }
  });

  app.post('/api/circles/:id/follow', requireAuth, (req: AuthedRequest, res) => {
    try {
      const circleId = parsePositiveInt(req.params.id);
      if (!circleId) {
        res.status(400).json({ error: 'Invalid Circle identifier.' });
        return;
      }
      const circle = db.prepare('SELECT id, name, privacy, owner_id FROM circles WHERE id = ?').get(circleId) as
        | { id: number; name: string; privacy: string; owner_id: number }
        | undefined;
      if (!circle) {
        res.status(404).json({ error: 'Circle not found.' });
        return;
      }

      const existingRole = getCircleMemberRole(circleId, req.userId!);
      if (existingRole === 'owner') {
        res.status(400).json({ error: 'Circle owner cannot unfollow their own Circle.' });
        return;
      }

      if (existingRole) {
        db.prepare('DELETE FROM circle_members WHERE circle_id = ? AND user_id = ?').run(circleId, req.userId);
        res.json({ following: false, pending: false });
        return;
      }

      if (circle.privacy === 'public') {
        db.prepare('INSERT OR IGNORE INTO circle_members (circle_id, user_id, role) VALUES (?, ?, ?)').run(
          circleId,
          req.userId,
          'member'
        );
        db.prepare("UPDATE circle_follow_requests SET status = 'approved' WHERE circle_id = ? AND user_id = ?").run(
          circleId,
          req.userId
        );
        triggerCircleAutoWelcome(circleId, req.userId!);
        res.json({ following: true, pending: false });
        return;
      }

      const pending = hasPendingCircleRequest(circleId, req.userId!);
      if (pending) {
        db.prepare('DELETE FROM circle_follow_requests WHERE circle_id = ? AND user_id = ?').run(
          circleId,
          req.userId
        );
        res.json({ following: false, pending: false });
        return;
      }

      // Auto-approve verified followers if enabled in Business Automation settings
      const automationSettings = getOrEnsureCircleAutomationSettings(circleId);
      const actorInfo = db
        .prepare('SELECT name, is_verified FROM users WHERE id = ?')
        .get(req.userId) as { name: string; is_verified: number } | undefined;

      if (automationSettings.auto_approve_verified && actorInfo?.is_verified) {
        db.prepare('INSERT OR IGNORE INTO circle_members (circle_id, user_id, role) VALUES (?, ?, ?)').run(
          circleId,
          req.userId,
          'member'
        );
        db.prepare(
          `INSERT INTO circle_follow_requests (circle_id, user_id, status)
           VALUES (?, ?, 'approved')
           ON CONFLICT(circle_id, user_id) DO UPDATE SET status = 'approved', created_at = datetime('now')`
        ).run(circleId, req.userId);
        triggerCircleAutoWelcome(circleId, req.userId!);
        res.json({ following: true, pending: false, auto_approved: true });
        return;
      }

      db.prepare(
        `INSERT INTO circle_follow_requests (circle_id, user_id, status)
         VALUES (?, ?, 'pending')
         ON CONFLICT(circle_id, user_id) DO UPDATE SET status = 'pending', created_at = datetime('now')`
      ).run(circleId, req.userId);

      const managers = db
        .prepare("SELECT user_id FROM circle_members WHERE circle_id = ? AND role IN ('owner', 'admin', 'moderator')")
        .all(circleId) as { user_id: number }[];
      for (const mgr of managers) {
        createNotification(
          mgr.user_id,
          req.userId!,
          'circle_request',
          circleId,
          `${actorInfo?.name || 'Someone'} requested to join ${circle.name}`
        );
      }

      res.json({ following: false, pending: true });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Could not update Circle follow status.' });
    }
  });

  app.post('/api/circles/join-by-code', requireAuth, (req: AuthedRequest, res) => {
    try {
      const code = sanitizePlainText(req.body?.code || '', 64);
      if (!code) {
        res.status(400).json({ error: 'Invite code is required.' });
        return;
      }
      const circle = db.prepare('SELECT id, name FROM circles WHERE invite_code = ?').get(code) as
        | { id: number; name: string }
        | undefined;
      if (!circle) {
        res.status(404).json({ error: 'Invalid or expired Circle invite link.' });
        return;
      }
      const already = getCircleMemberRole(circle.id, req.userId!);
      db.prepare('INSERT OR IGNORE INTO circle_members (circle_id, user_id, role) VALUES (?, ?, ?)').run(
        circle.id,
        req.userId,
        'member'
      );
      db.prepare("UPDATE circle_follow_requests SET status = 'approved' WHERE circle_id = ? AND user_id = ?").run(
        circle.id,
        req.userId
      );
      if (!already) {
        triggerCircleAutoWelcome(circle.id, req.userId!);
      }
      res.json({ ok: true, circle_id: circle.id, name: circle.name });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Could not join Circle.' });
    }
  });

  app.patch('/api/circles/:id/settings', requireAuth, (req: AuthedRequest, res) => {
    try {
      const circleId = parsePositiveInt(req.params.id);
      if (!circleId) {
        res.status(400).json({ error: 'Invalid Circle identifier.' });
        return;
      }
      const actorRole = getCircleMemberRole(circleId, req.userId!);
      if (actorRole !== 'owner' && actorRole !== 'admin') {
        res.status(403).json({ error: 'Only Circle owners and admins can update settings.' });
        return;
      }
      const current = db.prepare('SELECT privacy, require_post_approval, invite_code FROM circles WHERE id = ?').get(
        circleId
      ) as { privacy: string; require_post_approval: number; invite_code: string } | undefined;
      if (!current) {
        res.status(404).json({ error: 'Circle not found.' });
        return;
      }
      const nextPrivacy =
        req.body?.privacy === 'private' ? 'private' : req.body?.privacy === 'public' ? 'public' : current.privacy;
      const nextApproval =
        req.body?.require_post_approval !== undefined
          ? req.body.require_post_approval
            ? 1
            : 0
          : current.require_post_approval;
      const nextCode = req.body?.regenerate_invite
        ? `htv-cir-${circleId}-${Math.random().toString(36).slice(2, 6)}`
        : current.invite_code;

      db.prepare('UPDATE circles SET privacy = ?, require_post_approval = ?, invite_code = ? WHERE id = ?').run(
        nextPrivacy,
        nextApproval,
        nextCode,
        circleId
      );
      res.json({
        privacy: nextPrivacy,
        require_post_approval: Boolean(nextApproval),
        invite_code: nextCode,
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Could not update Circle settings.' });
    }
  });

  app.post('/api/circles/:id/members/invite', requireAuth, (req: AuthedRequest, res) => {
    try {
      const circleId = parsePositiveInt(req.params.id);
      if (!circleId) {
        res.status(400).json({ error: 'Invalid Circle identifier.' });
        return;
      }
      const actorRole = getCircleMemberRole(circleId, req.userId!);
      if (!actorRole) {
        res.status(403).json({ error: 'Join this Circle first to invite members.' });
        return;
      }
      const circle = db.prepare('SELECT id, name, privacy FROM circles WHERE id = ?').get(circleId) as
        | { id: number; name: string; privacy: string }
        | undefined;
      if (!circle) {
        res.status(404).json({ error: 'Circle not found.' });
        return;
      }

      const rawUsername = String(req.body?.username || '').trim().toLowerCase().replace(/^@/, '');
      const requestedRole = String(req.body?.role || 'member');
      if (!['member', 'moderator', 'admin'].includes(requestedRole)) {
        res.status(400).json({ error: 'Invalid Circle role selected.' });
        return;
      }
      if (requestedRole !== 'member' && actorRole !== 'owner' && actorRole !== 'admin') {
        res.status(403).json({ error: 'Only Circle owners or admins can invite with elevated roles.' });
        return;
      }
      if (requestedRole === 'admin' && actorRole !== 'owner') {
        res.status(403).json({ error: 'Only the Circle owner can assign admin roles.' });
        return;
      }
      if (!/^[a-z0-9_]{3,24}$/.test(rawUsername)) {
        res.status(400).json({ error: 'Enter a valid username (3–24 characters).' });
        return;
      }

      const target = db
        .prepare('SELECT id, name, username FROM users WHERE username = ? AND is_blocked = 0')
        .get(rawUsername) as { id: number; name: string; username: string } | undefined;
      if (!target) {
        res.status(404).json({ error: `No active user found with username @${rawUsername}.` });
        return;
      }

      const existing = getCircleMemberRole(circleId, target.id);
      if (existing) {
        res.status(409).json({ error: `@${target.username} is already in this Circle.` });
        return;
      }

      db.prepare('INSERT INTO circle_members (circle_id, user_id, role) VALUES (?, ?, ?)').run(
        circleId,
        target.id,
        requestedRole
      );
      db.prepare("UPDATE circle_follow_requests SET status = 'approved' WHERE circle_id = ? AND user_id = ?").run(
        circleId,
        target.id
      );

      createNotification(
        target.id,
        req.userId!,
        'circle_invite',
        circleId,
        `You were invited to ${circle.name} as ${requestedRole}`
      );
      triggerCircleAutoWelcome(circleId, target.id);

      res.status(201).json({ ok: true, user_id: target.id, role: requestedRole });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Could not invite member.' });
    }
  });

  app.post('/api/circles/:id/follow-requests/:requestId/respond', requireAuth, (req: AuthedRequest, res) => {
    try {
      const circleId = parsePositiveInt(req.params.id);
      const requestId = parsePositiveInt(req.params.requestId);
      const action = req.body?.action === 'approve' ? 'approve' : 'reject';
      if (!circleId || !requestId) {
        res.status(400).json({ error: 'Invalid request identifier.' });
        return;
      }
      const actorRole = getCircleMemberRole(circleId, req.userId!);
      if (!actorRole || !['owner', 'admin', 'moderator'].includes(actorRole)) {
        res.status(403).json({ error: 'Only Circle admins and moderators can handle follow requests.' });
        return;
      }
      const reqRow = db
        .prepare('SELECT id, user_id FROM circle_follow_requests WHERE id = ? AND circle_id = ?')
        .get(requestId, circleId) as { id: number; user_id: number } | undefined;
      if (!reqRow) {
        res.status(404).json({ error: 'Follow request not found.' });
        return;
      }

      if (action === 'approve') {
        db.prepare('INSERT OR IGNORE INTO circle_members (circle_id, user_id, role) VALUES (?, ?, ?)').run(
          circleId,
          reqRow.user_id,
          'member'
        );
        db.prepare("UPDATE circle_follow_requests SET status = 'approved' WHERE id = ?").run(requestId);
        const circle = db.prepare('SELECT name FROM circles WHERE id = ?').get(circleId) as { name: string } | undefined;
        createNotification(
          reqRow.user_id,
          req.userId!,
          'circle_approved',
          circleId,
          `Your request to join ${circle?.name || 'Circle'} was approved`
        );
        triggerCircleAutoWelcome(circleId, reqRow.user_id);
      } else {
        db.prepare("UPDATE circle_follow_requests SET status = 'rejected' WHERE id = ?").run(requestId);
      }
      res.json({ ok: true, action });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Could not process follow request.' });
    }
  });

  app.patch('/api/circles/:id/members/:userId/role', requireAuth, (req: AuthedRequest, res) => {
    try {
      const circleId = parsePositiveInt(req.params.id);
      const targetUserId = parsePositiveInt(req.params.userId);
      const nextRole = String(req.body?.role || '');
      if (!circleId || !targetUserId || !['admin', 'moderator', 'member'].includes(nextRole)) {
        res.status(400).json({ error: 'Invalid Circle member role request.' });
        return;
      }

      const actorRole = getCircleMemberRole(circleId, req.userId!);
      if (actorRole !== 'owner' && actorRole !== 'admin') {
        res.status(403).json({ error: 'Only Circle owners and admins can assign roles.' });
        return;
      }
      const targetRole = getCircleMemberRole(circleId, targetUserId);
      if (!targetRole) {
        res.status(404).json({ error: 'Member not found in this Circle.' });
        return;
      }
      if (targetRole === 'owner') {
        res.status(403).json({ error: 'Circle owner role cannot be modified.' });
        return;
      }
      if (actorRole !== 'owner' && (targetRole === 'admin' || nextRole === 'admin')) {
        res.status(403).json({ error: 'Only the Circle owner can assign or change Admin roles.' });
        return;
      }

      db.prepare('UPDATE circle_members SET role = ? WHERE circle_id = ? AND user_id = ?').run(
        nextRole,
        circleId,
        targetUserId
      );
      res.json({ ok: true, role: nextRole });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Could not update Circle role.' });
    }
  });

  app.delete('/api/circles/:id/members/:userId', requireAuth, (req: AuthedRequest, res) => {
    try {
      const circleId = parsePositiveInt(req.params.id);
      const targetUserId = parsePositiveInt(req.params.userId);
      if (!circleId || !targetUserId) {
        res.status(400).json({ error: 'Invalid Circle or member identifier.' });
        return;
      }
      const targetRole = getCircleMemberRole(circleId, targetUserId);
      if (!targetRole) {
        res.status(404).json({ error: 'Member not found.' });
        return;
      }
      if (targetRole === 'owner') {
        res.status(403).json({ error: 'Circle owner cannot be removed from their own Circle.' });
        return;
      }
      const actorRole = getCircleMemberRole(circleId, req.userId!);
      const isSelf = targetUserId === req.userId;
      if (!isSelf && actorRole !== 'owner' && actorRole !== 'admin') {
        res.status(403).json({ error: 'Permission denied.' });
        return;
      }
      if (!isSelf && actorRole === 'admin' && targetRole === 'admin') {
        res.status(403).json({ error: 'Only the Circle owner can remove another admin.' });
        return;
      }

      db.prepare('DELETE FROM circle_members WHERE circle_id = ? AND user_id = ?').run(circleId, targetUserId);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Could not remove Circle member.' });
    }
  });

  app.post('/api/circles/:id/posts', requireAuth, (req: AuthedRequest, res) => {
    try {
      const circleId = parsePositiveInt(req.params.id);
      if (!circleId) {
        res.status(400).json({ error: 'Invalid Circle identifier.' });
        return;
      }
      const actorRole = getCircleMemberRole(circleId, req.userId!);
      if (!actorRole) {
        res.status(403).json({ error: 'Follow this Circle first to publish posts.' });
        return;
      }
      const circle = db
        .prepare('SELECT id, name, privacy, require_post_approval FROM circles WHERE id = ?')
        .get(circleId) as
        | { id: number; name: string; privacy: string; require_post_approval: number }
        | undefined;
      if (!circle) {
        res.status(404).json({ error: 'Circle not found.' });
        return;
      }

      const content = sanitizePlainText(req.body?.content || '', 4000);
      const mediaType = req.body?.media_type === 'image' ? 'image' : 'none';
      const mediaUrl = mediaType === 'image' ? sanitizeMediaUrl(req.body?.media_url) : '';
      const wantsGlobal =
        circle.privacy === 'public' ? req.body?.broadcast_global !== false : false;
      const isGlobalFlag = wantsGlobal ? 1 : 0;

      if (mediaType === 'image' && !mediaUrl) {
        res.status(400).json({ error: 'Invalid gallery image path.' });
        return;
      }
      if (!content && mediaType === 'none') {
        res.status(400).json({ error: 'Write a post or attach a gallery photo.' });
        return;
      }

      const check = validateTextField(content, 'Circle Post', { maxWords: MAX_WORDS });
      if (!check.valid) {
        res.status(400).json({ error: check.error });
        return;
      }

      const isStaff = actorRole === 'owner' || actorRole === 'admin' || actorRole === 'moderator';
      const status = circle.require_post_approval && !isStaff ? 'pending' : 'approved';

      const result = db
        .prepare(
          'INSERT INTO circle_posts (circle_id, user_id, content, media_type, media_url, status, is_global) VALUES (?, ?, ?, ?, ?, ?, ?)'
        )
        .run(circleId, req.userId, content, mediaType, mediaUrl, status, isGlobalFlag);
      const newPostId = Number(result.lastInsertRowid);

      if (status === 'pending') {
        const actor = db.prepare('SELECT name FROM users WHERE id = ?').get(req.userId) as { name: string } | undefined;
        const staff = db
          .prepare("SELECT user_id FROM circle_members WHERE circle_id = ? AND role IN ('owner', 'admin', 'moderator')")
          .all(circleId) as { user_id: number }[];
        for (const s of staff) {
          createNotification(
            s.user_id,
            req.userId!,
            'circle_post_pending',
            circleId,
            `${actor?.name || 'A member'} submitted a post for approval in ${circle.name}`
          );
        }
      } else {
        dispatchCirclePostToFollowersAndGlobal(newPostId);
      }

      const created = formatCirclePosts(circleId, req.userId!, status).find((p) => p.id === newPostId);
      res.status(201).json({ post: created, status });
    } catch (err: any) {
      res.status(400).json({ error: err?.message || 'Could not publish Circle post.' });
    }
  });

  app.patch('/api/circles/:id/posts/:postId/moderate', requireAuth, (req: AuthedRequest, res) => {
    try {
      const circleId = parsePositiveInt(req.params.id);
      const postId = parsePositiveInt(req.params.postId);
      const action = req.body?.action === 'approve' ? 'approve' : req.body?.action === 'reject' ? 'reject' : '';
      if (!circleId || !postId || !action) {
        res.status(400).json({ error: 'Invalid moderation request.' });
        return;
      }
      const actorRole = getCircleMemberRole(circleId, req.userId!);
      if (!actorRole || !['owner', 'admin', 'moderator'].includes(actorRole)) {
        res.status(403).json({ error: 'Only Circle admins and moderators can approve or reject posts.' });
        return;
      }

      const post = db
        .prepare('SELECT id, user_id, status FROM circle_posts WHERE id = ? AND circle_id = ?')
        .get(postId, circleId) as { id: number; user_id: number; status: string } | undefined;
      if (!post) {
        res.status(404).json({ error: 'Circle post not found.' });
        return;
      }

      const nextStatus = action === 'approve' ? 'approved' : 'rejected';
      db.prepare('UPDATE circle_posts SET status = ? WHERE id = ?').run(nextStatus, postId);

      if (action === 'approve') {
        if (post.status !== 'approved') {
          dispatchCirclePostToFollowersAndGlobal(postId);
        }
        const updatedPost = formatCirclePosts(circleId, req.userId!, 'approved').find((p) => p.id === postId);
        res.json({ ok: true, status: nextStatus, post: updatedPost });
        return;
      }
      res.json({ ok: true, status: nextStatus });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Could not moderate Circle post.' });
    }
  });

  app.delete('/api/circles/:id/posts/:postId', requireAuth, (req: AuthedRequest, res) => {
    try {
      const circleId = parsePositiveInt(req.params.id);
      const postId = parsePositiveInt(req.params.postId);
      if (!circleId || !postId) {
        res.status(400).json({ error: 'Invalid identifier.' });
        return;
      }
      const post = db
        .prepare('SELECT id, user_id, global_post_id, media_url FROM circle_posts WHERE id = ? AND circle_id = ?')
        .get(postId, circleId) as
        | { id: number; user_id: number; global_post_id: number | null; media_url: string }
        | undefined;
      if (!post) {
        res.status(404).json({ error: 'Circle post not found.' });
        return;
      }

      const actorRole = getCircleMemberRole(circleId, req.userId!);
      const isOwner = post.user_id === req.userId;
      const isCircleStaff = actorRole === 'owner' || actorRole === 'admin' || actorRole === 'moderator';
      const isSiteAdmin = req.userRole === 'admin';
      if (!isOwner && !isCircleStaff && !isSiteAdmin) {
        res.status(403).json({
          error: 'Only the post owner, Circle admins/moderators, or site admins can delete this post.',
        });
        return;
      }

      db.prepare('DELETE FROM circle_posts WHERE id = ?').run(postId);
      if (post.global_post_id) {
        db.prepare('DELETE FROM posts WHERE id = ?').run(post.global_post_id);
      }
      if (post.media_url) {
        cleanupUnusedUploadFile(post.media_url);
      }
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Could not delete Circle post.' });
    }
  });

  app.post('/api/circles/:id/posts/:postId/like', requireAuth, (req: AuthedRequest, res) => {
    try {
      const circleId = parsePositiveInt(req.params.id);
      const postId = parsePositiveInt(req.params.postId);
      if (!circleId || !postId) {
        res.status(400).json({ error: 'Invalid identifier.' });
        return;
      }
      const circle = db.prepare('SELECT privacy FROM circles WHERE id = ?').get(circleId) as
        | { privacy: string }
        | undefined;
      if (!circle) {
        res.status(404).json({ error: 'Circle not found.' });
        return;
      }
      if (circle.privacy === 'private' && !getCircleMemberRole(circleId, req.userId!)) {
        res.status(403).json({ error: 'Private Circle access denied.' });
        return;
      }
      const post = db
        .prepare("SELECT id, global_post_id FROM circle_posts WHERE id = ? AND circle_id = ? AND status = 'approved'")
        .get(postId, circleId) as { id: number; global_post_id: number | null } | undefined;
      if (!post) {
        res.status(404).json({ error: 'Circle post not found.' });
        return;
      }

      const exists = db
        .prepare('SELECT 1 FROM circle_post_likes WHERE post_id = ? AND user_id = ?')
        .get(postId, req.userId);
      if (exists) {
        db.prepare('DELETE FROM circle_post_likes WHERE post_id = ? AND user_id = ?').run(postId, req.userId);
        if (post.global_post_id) {
          db.prepare('DELETE FROM post_likes WHERE post_id = ? AND user_id = ?').run(post.global_post_id, req.userId);
        }
      } else {
        db.prepare('INSERT OR IGNORE INTO circle_post_likes (post_id, user_id) VALUES (?, ?)').run(postId, req.userId);
        if (post.global_post_id) {
          db.prepare('INSERT OR IGNORE INTO post_likes (post_id, user_id) VALUES (?, ?)').run(
            post.global_post_id,
            req.userId
          );
        }
      }
      const likesCount = (
        db.prepare('SELECT COUNT(*) as c FROM circle_post_likes WHERE post_id = ?').get(postId) as { c: number }
      ).c;
      res.json({ liked: !exists, likes_count: likesCount });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Could not toggle like.' });
    }
  });

  app.post('/api/circles/:id/posts/:postId/comment', requireAuth, (req: AuthedRequest, res) => {
    try {
      const circleId = parsePositiveInt(req.params.id);
      const postId = parsePositiveInt(req.params.postId);
      if (!circleId || !postId) {
        res.status(400).json({ error: 'Invalid identifier.' });
        return;
      }
      const circle = db.prepare('SELECT privacy FROM circles WHERE id = ?').get(circleId) as
        | { privacy: string }
        | undefined;
      if (!circle) {
        res.status(404).json({ error: 'Circle not found.' });
        return;
      }
      if (circle.privacy === 'private' && !getCircleMemberRole(circleId, req.userId!)) {
        res.status(403).json({ error: 'Join this Private Circle to comment.' });
        return;
      }
      const post = db
        .prepare("SELECT id, global_post_id FROM circle_posts WHERE id = ? AND circle_id = ? AND status = 'approved'")
        .get(postId, circleId) as { id: number; global_post_id: number | null } | undefined;
      if (!post) {
        res.status(404).json({ error: 'Circle post not found.' });
        return;
      }

      const content = sanitizePlainText(req.body?.content || '', 2500);
      const check = validateTextField(content, 'Comment', { required: true, maxWords: MAX_WORDS });
      if (!check.valid) {
        res.status(400).json({ error: check.error });
        return;
      }

      const result = db
        .prepare('INSERT INTO circle_post_comments (post_id, user_id, content) VALUES (?, ?, ?)')
        .run(postId, req.userId, content);

      if (post.global_post_id) {
        db.prepare('INSERT INTO post_comments (post_id, user_id, content) VALUES (?, ?, ?)').run(
          post.global_post_id,
          req.userId,
          content
        );
      }

      const comment = db
        .prepare(
          `SELECT c.*, u.name as author_name, u.username as author_username, u.avatar_url as author_avatar, u.is_verified as author_verified
           FROM circle_post_comments c JOIN users u ON u.id = c.user_id WHERE c.id = ?`
        )
        .get(result.lastInsertRowid) as any;

      const autoReplyComment = triggerCircleCommentAutomation(circleId, postId, req.userId!, content);

      res.status(201).json({
        comment: {
          ...comment,
          author_avatar: sanitizeMediaUrl(comment.author_avatar),
          author_verified: Boolean(comment.author_verified),
        },
        auto_reply: autoReplyComment,
      });
    } catch (err: any) {
      res.status(400).json({ error: err?.message || 'Comment blocked.' });
    }
  });

  app.post('/api/circles/:id/posts/:postId/share', requireAuth, (req: AuthedRequest, res) => {
    try {
      const circleId = parsePositiveInt(req.params.id);
      const postId = parsePositiveInt(req.params.postId);
      if (!circleId || !postId) {
        res.status(400).json({ error: 'Invalid identifier.' });
        return;
      }
      const post = db
        .prepare("SELECT id, global_post_id FROM circle_posts WHERE id = ? AND circle_id = ? AND status = 'approved'")
        .get(postId, circleId) as { id: number; global_post_id: number | null } | undefined;
      if (!post) {
        res.status(404).json({ error: 'Circle post not found.' });
        return;
      }
      db.prepare('INSERT INTO circle_post_shares (post_id, user_id) VALUES (?, ?)').run(postId, req.userId);
      if (post.global_post_id) {
        db.prepare('INSERT INTO post_shares (post_id, user_id) VALUES (?, ?)').run(post.global_post_id, req.userId);
      }
      const sharesCount = (
        db.prepare('SELECT COUNT(*) as c FROM circle_post_shares WHERE post_id = ?').get(postId) as { c: number }
      ).c;
      res.json({ shares_count: sharesCount });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Could not record share.' });
    }
  });

  const recordCircleViewTx = db.transaction((postId: number, userId: number, globalPostId: number | null) => {
    const info = db
      .prepare('INSERT OR IGNORE INTO circle_post_views (post_id, user_id) VALUES (?, ?)')
      .run(postId, userId);
    if (info.changes > 0) {
      db.prepare('UPDATE circle_posts SET views_count = views_count + 1 WHERE id = ?').run(postId);
      if (globalPostId) {
        const gInfo = db
          .prepare('INSERT OR IGNORE INTO post_views (post_id, user_id) VALUES (?, ?)')
          .run(globalPostId, userId);
        if (gInfo.changes > 0) {
          db.prepare('UPDATE posts SET views_count = views_count + 1 WHERE id = ?').run(globalPostId);
        }
      }
    }
    const row = db.prepare('SELECT views_count FROM circle_posts WHERE id = ?').get(postId) as
      | { views_count: number }
      | undefined;
    return { incremented: info.changes > 0, views_count: Number(row?.views_count || 0) };
  });

  app.post('/api/circles/:id/posts/:postId/view', requireAuth, (req: AuthedRequest, res) => {
    try {
      const circleId = parsePositiveInt(req.params.id);
      const postId = parsePositiveInt(req.params.postId);
      if (!circleId || !postId) {
        res.status(400).json({ error: 'Invalid identifier.' });
        return;
      }
      const post = db
        .prepare("SELECT id, global_post_id FROM circle_posts WHERE id = ? AND circle_id = ? AND status = 'approved'")
        .get(postId, circleId) as { id: number; global_post_id: number | null } | undefined;
      if (!post) {
        res.status(404).json({ error: 'Circle post not found.' });
        return;
      }
      const outcome = recordCircleViewTx(postId, req.userId!, post.global_post_id);
      res.json({ ok: true, ...outcome });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Could not update post views.' });
    }
  });

  // ─────────────────────────────────────────────────────────────
  // CIRCLES BUSINESS AUTOMATION & CUSTOMER MANAGEMENT
  // ─────────────────────────────────────────────────────────────
  app.get('/api/circles/:id/automation', requireAuth, (req: AuthedRequest, res) => {
    try {
      const circleId = parsePositiveInt(req.params.id);
      if (!circleId) {
        res.status(400).json({ error: 'Invalid Circle identifier.' });
        return;
      }
      const actorRole = getCircleMemberRole(circleId, req.userId!);
      if (!actorRole || !['owner', 'admin', 'moderator'].includes(actorRole)) {
        res.status(403).json({ error: 'Only Circle staff can access Business Automation.' });
        return;
      }

      const settings = getOrEnsureCircleAutomationSettings(circleId);
      const keywordRules = (
        db.prepare('SELECT * FROM circle_keyword_rules WHERE circle_id = ? ORDER BY id DESC').all(circleId) as any[]
      ).map((r) => ({
        ...r,
        create_inquiry: Boolean(r.create_inquiry),
        is_active: Boolean(r.is_active ?? 1),
      }));

      const quickReplies = db
        .prepare('SELECT * FROM circle_quick_replies WHERE circle_id = ? ORDER BY usage_count DESC, id DESC')
        .all(circleId) as any[];

      const inquiries = (
        db
          .prepare(
            `SELECT i.*, u.name as customer_name, u.username as customer_username, u.avatar_url as customer_avatar, u.is_verified as customer_verified,
                    h.name as handled_by_name
             FROM circle_inquiries i
             JOIN users u ON u.id = i.customer_id
             LEFT JOIN users h ON h.id = i.handled_by
             WHERE i.circle_id = ?
             ORDER BY CASE i.status WHEN 'new' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END, i.updated_at DESC, i.id DESC
             LIMIT 100`
          )
          .all(circleId) as any[]
      ).map((i) => ({
        ...i,
        customer_avatar: sanitizeMediaUrl(i.customer_avatar),
        customer_verified: Boolean(i.customer_verified),
      }));

      const totalReach = (
        db
          .prepare("SELECT COALESCE(SUM(views_count), 0) as v FROM circle_posts WHERE circle_id = ? AND status = 'approved'")
          .get(circleId) as { v: number }
      ).v;
      const followersCount = (
        db.prepare('SELECT COUNT(*) as c FROM circle_members WHERE circle_id = ?').get(circleId) as { c: number }
      ).c;
      const newInquiries = inquiries.filter((i) => i.status === 'new').length;
      const resolvedInquiries = inquiries.filter((i) => i.status === 'resolved').length;
      const autoRepliesSent = keywordRules.reduce((sum, r) => sum + Number(r.hit_count || 0), 0);

      res.json({
        settings,
        keyword_rules: keywordRules,
        quick_replies: quickReplies,
        inquiries,
        stats: {
          total_reach: Number(totalReach || 0),
          followers_count: Number(followersCount || 0),
          new_inquiries: newInquiries,
          resolved_inquiries: resolvedInquiries,
          auto_replies_sent: autoRepliesSent,
        },
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Could not load Business Automation.' });
    }
  });

  app.patch('/api/circles/:id/automation/settings', requireAuth, (req: AuthedRequest, res) => {
    try {
      const circleId = parsePositiveInt(req.params.id);
      if (!circleId) {
        res.status(400).json({ error: 'Invalid Circle identifier.' });
        return;
      }
      const actorRole = getCircleMemberRole(circleId, req.userId!);
      if (actorRole !== 'owner' && actorRole !== 'admin') {
        res.status(403).json({ error: 'Only Circle owners and admins can configure automation rules.' });
        return;
      }

      const current = getOrEnsureCircleAutomationSettings(circleId);
      const nextWelcomeEnabled =
        req.body?.auto_welcome_enabled !== undefined
          ? req.body.auto_welcome_enabled
            ? 1
            : 0
          : current.auto_welcome_enabled
          ? 1
          : 0;
      const nextWelcomeMessage =
        req.body?.auto_welcome_message !== undefined
          ? sanitizePlainText(req.body.auto_welcome_message, 1500)
          : current.auto_welcome_message;
      const nextInquiryReplyEnabled =
        req.body?.auto_inquiry_reply_enabled !== undefined
          ? req.body.auto_inquiry_reply_enabled
            ? 1
            : 0
          : current.auto_inquiry_reply_enabled
          ? 1
          : 0;
      const nextInquiryReplyMessage =
        req.body?.auto_inquiry_reply_message !== undefined
          ? sanitizePlainText(req.body.auto_inquiry_reply_message, 1500)
          : current.auto_inquiry_reply_message;
      const nextApproveVerified =
        req.body?.auto_approve_verified !== undefined
          ? req.body.auto_approve_verified
            ? 1
            : 0
          : current.auto_approve_verified
          ? 1
          : 0;
      const nextKeywordEnabled =
        req.body?.auto_keyword_reply_enabled !== undefined
          ? req.body.auto_keyword_reply_enabled
            ? 1
            : 0
          : current.auto_keyword_reply_enabled
          ? 1
          : 0;

      if (nextWelcomeMessage) {
        const msgCheck = validateTextField(nextWelcomeMessage, 'Auto-Welcome Message', {
          maxWords: MAX_WORDS,
        });
        if (!msgCheck.valid) {
          res.status(400).json({ error: msgCheck.error });
          return;
        }
      }
      if (nextWelcomeEnabled && !nextWelcomeMessage.trim()) {
        res.status(400).json({ error: 'Write an Auto-Welcome message before enabling it.' });
        return;
      }

      if (nextInquiryReplyMessage) {
        const inqMsgCheck = validateTextField(nextInquiryReplyMessage, 'Inquiry Auto-Reply Message', {
          maxWords: MAX_WORDS,
        });
        if (!inqMsgCheck.valid) {
          res.status(400).json({ error: inqMsgCheck.error });
          return;
        }
      }
      if (nextInquiryReplyEnabled && !nextInquiryReplyMessage.trim()) {
        res.status(400).json({ error: 'Write an Inquiry Auto-Reply template before enabling it.' });
        return;
      }

      db.prepare(
        `UPDATE circle_automation_settings
         SET auto_welcome_enabled = ?, auto_welcome_message = ?, auto_inquiry_reply_enabled = ?, auto_inquiry_reply_message = ?, auto_approve_verified = ?, auto_keyword_reply_enabled = ?, updated_at = datetime('now')
         WHERE circle_id = ?`
      ).run(
        nextWelcomeEnabled,
        nextWelcomeMessage,
        nextInquiryReplyEnabled,
        nextInquiryReplyMessage,
        nextApproveVerified,
        nextKeywordEnabled,
        circleId
      );

      res.json({ settings: getOrEnsureCircleAutomationSettings(circleId) });
    } catch (err: any) {
      res.status(400).json({ error: err?.message || 'Could not save automation settings.' });
    }
  });

  app.post('/api/circles/:id/automation/keywords', requireAuth, (req: AuthedRequest, res) => {
    try {
      const circleId = parsePositiveInt(req.params.id);
      if (!circleId) {
        res.status(400).json({ error: 'Invalid Circle identifier.' });
        return;
      }
      const actorRole = getCircleMemberRole(circleId, req.userId!);
      if (actorRole !== 'owner' && actorRole !== 'admin') {
        res.status(403).json({ error: 'Only Circle owners and admins can add keyword triggers.' });
        return;
      }

      const keyword = sanitizePlainText(req.body?.keyword || '', 40).toLowerCase();
      const replyText = sanitizePlainText(req.body?.reply_text || '', 2000);
      const createInquiry = req.body?.create_inquiry === false ? 0 : 1;
      const isActive = req.body?.is_active === false ? 0 : 1;

      const kwCheck = validateTextField(keyword, 'Keyword', { required: true, maxWords: 5 });
      if (!kwCheck.valid) {
        res.status(400).json({ error: kwCheck.error });
        return;
      }
      const replyCheck = validateTextField(replyText, 'Auto-Reply Message', { required: true, maxWords: MAX_WORDS });
      if (!replyCheck.valid) {
        res.status(400).json({ error: replyCheck.error });
        return;
      }

      const result = db
        .prepare(
          'INSERT INTO circle_keyword_rules (circle_id, keyword, reply_text, create_inquiry, is_active) VALUES (?, ?, ?, ?, ?)'
        )
        .run(circleId, keyword, replyText, createInquiry, isActive);
      const created = db
        .prepare('SELECT * FROM circle_keyword_rules WHERE id = ?')
        .get(result.lastInsertRowid) as any;

      res.status(201).json({
        rule: {
          ...created,
          create_inquiry: Boolean(created.create_inquiry),
          is_active: Boolean(created.is_active ?? 1),
        },
      });
    } catch (err: any) {
      res.status(400).json({ error: err?.message || 'Could not add keyword rule.' });
    }
  });

  app.patch('/api/circles/:id/automation/keywords/:ruleId', requireAuth, (req: AuthedRequest, res) => {
    try {
      const circleId = parsePositiveInt(req.params.id);
      const ruleId = parsePositiveInt(req.params.ruleId);
      if (!circleId || !ruleId) {
        res.status(400).json({ error: 'Invalid identifier.' });
        return;
      }
      const actorRole = getCircleMemberRole(circleId, req.userId!);
      if (actorRole !== 'owner' && actorRole !== 'admin') {
        res.status(403).json({ error: 'Only Circle owners and admins can edit keyword rules.' });
        return;
      }

      const existing = db
        .prepare('SELECT * FROM circle_keyword_rules WHERE id = ? AND circle_id = ?')
        .get(ruleId, circleId) as any;
      if (!existing) {
        res.status(404).json({ error: 'Keyword rule not found.' });
        return;
      }

      const nextKeyword =
        req.body?.keyword !== undefined
          ? sanitizePlainText(req.body.keyword, 40).toLowerCase()
          : String(existing.keyword || '').toLowerCase();
      const nextReplyText =
        req.body?.reply_text !== undefined
          ? sanitizePlainText(req.body.reply_text, 2000)
          : String(existing.reply_text || '');
      const nextCreateInquiry =
        req.body?.create_inquiry !== undefined
          ? req.body.create_inquiry
            ? 1
            : 0
          : existing.create_inquiry
          ? 1
          : 0;
      const nextIsActive =
        req.body?.is_active !== undefined
          ? req.body.is_active
            ? 1
            : 0
          : Number(existing.is_active ?? 1)
          ? 1
          : 0;

      const kwCheck = validateTextField(nextKeyword, 'Keyword', { required: true, maxWords: 5 });
      if (!kwCheck.valid) {
        res.status(400).json({ error: kwCheck.error });
        return;
      }
      const replyCheck = validateTextField(nextReplyText, 'Auto-Reply Message', {
        required: true,
        maxWords: MAX_WORDS,
      });
      if (!replyCheck.valid) {
        res.status(400).json({ error: replyCheck.error });
        return;
      }

      db.prepare(
        'UPDATE circle_keyword_rules SET keyword = ?, reply_text = ?, create_inquiry = ?, is_active = ? WHERE id = ? AND circle_id = ?'
      ).run(nextKeyword, nextReplyText, nextCreateInquiry, nextIsActive, ruleId, circleId);

      const updated = db
        .prepare('SELECT * FROM circle_keyword_rules WHERE id = ?')
        .get(ruleId) as any;

      res.json({
        rule: {
          ...updated,
          create_inquiry: Boolean(updated.create_inquiry),
          is_active: Boolean(updated.is_active ?? 1),
        },
      });
    } catch (err: any) {
      res.status(400).json({ error: err?.message || 'Could not update keyword rule.' });
    }
  });

  app.delete('/api/circles/:id/automation/keywords/:ruleId', requireAuth, (req: AuthedRequest, res) => {
    try {
      const circleId = parsePositiveInt(req.params.id);
      const ruleId = parsePositiveInt(req.params.ruleId);
      if (!circleId || !ruleId) {
        res.status(400).json({ error: 'Invalid identifier.' });
        return;
      }
      const actorRole = getCircleMemberRole(circleId, req.userId!);
      if (actorRole !== 'owner' && actorRole !== 'admin') {
        res.status(403).json({ error: 'Permission denied.' });
        return;
      }
      db.prepare('DELETE FROM circle_keyword_rules WHERE id = ? AND circle_id = ?').run(ruleId, circleId);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Could not delete keyword rule.' });
    }
  });

  app.post('/api/circles/:id/automation/quick-replies', requireAuth, (req: AuthedRequest, res) => {
    try {
      const circleId = parsePositiveInt(req.params.id);
      if (!circleId) {
        res.status(400).json({ error: 'Invalid Circle identifier.' });
        return;
      }
      const actorRole = getCircleMemberRole(circleId, req.userId!);
      if (!actorRole || !['owner', 'admin', 'moderator'].includes(actorRole)) {
        res.status(403).json({ error: 'Only Circle staff can create quick replies.' });
        return;
      }

      const title = sanitizePlainText(req.body?.title || '', 60);
      const content = sanitizePlainText(req.body?.content || '', 2000);
      const titleCheck = validateTextField(title, 'Template Title', { required: true, maxWords: 12 });
      if (!titleCheck.valid) {
        res.status(400).json({ error: titleCheck.error });
        return;
      }
      const contentCheck = validateTextField(content, 'Template Message', { required: true, maxWords: MAX_WORDS });
      if (!contentCheck.valid) {
        res.status(400).json({ error: contentCheck.error });
        return;
      }

      const result = db
        .prepare('INSERT INTO circle_quick_replies (circle_id, title, content) VALUES (?, ?, ?)')
        .run(circleId, title, content);
      const quickReply = db.prepare('SELECT * FROM circle_quick_replies WHERE id = ?').get(result.lastInsertRowid);
      res.status(201).json({ quick_reply: quickReply });
    } catch (err: any) {
      res.status(400).json({ error: err?.message || 'Could not save quick reply.' });
    }
  });

  app.patch('/api/circles/:id/automation/quick-replies/:replyId', requireAuth, (req: AuthedRequest, res) => {
    try {
      const circleId = parsePositiveInt(req.params.id);
      const replyId = parsePositiveInt(req.params.replyId);
      if (!circleId || !replyId) {
        res.status(400).json({ error: 'Invalid identifier.' });
        return;
      }
      const actorRole = getCircleMemberRole(circleId, req.userId!);
      if (!actorRole || !['owner', 'admin', 'moderator'].includes(actorRole)) {
        res.status(403).json({ error: 'Only Circle staff can edit quick replies.' });
        return;
      }

      const existing = db
        .prepare('SELECT * FROM circle_quick_replies WHERE id = ? AND circle_id = ?')
        .get(replyId, circleId) as any;
      if (!existing) {
        res.status(404).json({ error: 'Quick reply template not found.' });
        return;
      }

      const nextTitle =
        req.body?.title !== undefined
          ? sanitizePlainText(req.body.title, 60)
          : String(existing.title || '');
      const nextContent =
        req.body?.content !== undefined
          ? sanitizePlainText(req.body.content, 2000)
          : String(existing.content || '');

      const titleCheck = validateTextField(nextTitle, 'Template Title', { required: true, maxWords: 12 });
      if (!titleCheck.valid) {
        res.status(400).json({ error: titleCheck.error });
        return;
      }
      const contentCheck = validateTextField(nextContent, 'Template Message', {
        required: true,
        maxWords: MAX_WORDS,
      });
      if (!contentCheck.valid) {
        res.status(400).json({ error: contentCheck.error });
        return;
      }

      db.prepare(
        'UPDATE circle_quick_replies SET title = ?, content = ? WHERE id = ? AND circle_id = ?'
      ).run(nextTitle, nextContent, replyId, circleId);
      const updated = db.prepare('SELECT * FROM circle_quick_replies WHERE id = ?').get(replyId);
      res.json({ quick_reply: updated });
    } catch (err: any) {
      res.status(400).json({ error: err?.message || 'Could not update quick reply.' });
    }
  });

  app.delete('/api/circles/:id/automation/quick-replies/:replyId', requireAuth, (req: AuthedRequest, res) => {
    try {
      const circleId = parsePositiveInt(req.params.id);
      const replyId = parsePositiveInt(req.params.replyId);
      if (!circleId || !replyId) {
        res.status(400).json({ error: 'Invalid identifier.' });
        return;
      }
      const actorRole = getCircleMemberRole(circleId, req.userId!);
      if (!actorRole || !['owner', 'admin', 'moderator'].includes(actorRole)) {
        res.status(403).json({ error: 'Permission denied.' });
        return;
      }
      db.prepare('DELETE FROM circle_quick_replies WHERE id = ? AND circle_id = ?').run(replyId, circleId);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Could not delete quick reply.' });
    }
  });

  app.post('/api/circles/:id/inquiries', requireAuth, (req: AuthedRequest, res) => {
    try {
      const circleId = parsePositiveInt(req.params.id);
      if (!circleId) {
        res.status(400).json({ error: 'Invalid Circle identifier.' });
        return;
      }
      const circle = db.prepare('SELECT id, name, privacy, owner_id FROM circles WHERE id = ?').get(circleId) as
        | { id: number; name: string; privacy: string; owner_id: number }
        | undefined;
      if (!circle) {
        res.status(404).json({ error: 'Circle not found.' });
        return;
      }
      if (circle.privacy === 'private' && !getCircleMemberRole(circleId, req.userId!)) {
        res.status(403).json({ error: 'Follow this Private Circle before sending an inquiry.' });
        return;
      }
      if (circle.owner_id === req.userId) {
        res.status(400).json({ error: 'Circle owners receive inquiries from customers here.' });
        return;
      }

      const message = sanitizePlainText(req.body?.message || '', 2000);
      const postId = req.body?.post_id ? parsePositiveInt(req.body.post_id) : null;
      const source = req.body?.source === 'post_cta' ? 'post_cta' : 'direct';
      const check = validateTextField(message, 'Inquiry', { required: true, maxWords: MAX_WORDS });
      if (!check.valid) {
        res.status(400).json({ error: check.error });
        return;
      }

      const validPostId = postId
        ? (
            db
              .prepare('SELECT id FROM circle_posts WHERE id = ? AND circle_id = ?')
              .get(postId, circleId) as { id: number } | undefined
          )?.id ?? null
        : null;

      const convId = sendAutomatedDirectMessage(
        req.userId!,
        circle.owner_id,
        `[${circle.name} Inquiry] ${message}`
      );

      const ins = db
        .prepare(
          `INSERT INTO circle_inquiries (circle_id, customer_id, source, post_id, conversation_id, message, status)
           VALUES (?, ?, ?, ?, ?, ?, 'new')`
        )
        .run(circleId, req.userId, source, validPostId, convId, message);

      const inquiryId = Number(ins.lastInsertRowid);
      const actor = db.prepare('SELECT name FROM users WHERE id = ?').get(req.userId) as { name: string } | undefined;
      const staff = db
        .prepare("SELECT user_id FROM circle_members WHERE circle_id = ? AND role IN ('owner', 'admin', 'moderator')")
        .all(circleId) as { user_id: number }[];
      for (const s of staff) {
        createNotification(
          s.user_id,
          req.userId!,
          'circle_inquiry',
          circleId,
          `${actor?.name || 'A customer'} sent an inquiry in ${circle.name}`
        );
      }

      // Automatic inquiry / keyword DM reply back to customer if configured
      let autoReplyText: string | null = null;
      const settings = getOrEnsureCircleAutomationSettings(circleId);
      const lowerMsg = message.toLowerCase();

      if (settings.auto_keyword_reply_enabled) {
        const rules = db
          .prepare('SELECT id, keyword, reply_text FROM circle_keyword_rules WHERE circle_id = ? AND is_active = 1 ORDER BY id ASC')
          .all(circleId) as { id: number; keyword: string; reply_text: string }[];
        const matchedRule = rules.find((r) => lowerMsg.includes(r.keyword.toLowerCase()));
        if (matchedRule) {
          db.prepare('UPDATE circle_keyword_rules SET hit_count = hit_count + 1 WHERE id = ?').run(matchedRule.id);
          autoReplyText = matchedRule.reply_text;
        }
      }

      if (!autoReplyText && settings.auto_inquiry_reply_enabled && settings.auto_inquiry_reply_message.trim()) {
        autoReplyText = settings.auto_inquiry_reply_message;
      }

      if (autoReplyText) {
        const personalizedReply = autoReplyText
          .replace(/\{\{\s*name\s*\}\}/gi, actor?.name || 'there')
          .replace(/\{\{\s*circle\s*\}\}/gi, circle.name);
        const replyConvId = sendAutomatedDirectMessage(circle.owner_id, req.userId!, personalizedReply);
        db.prepare(
          `UPDATE circle_inquiries
           SET status = 'in_progress', last_reply = ?, handled_by = ?, conversation_id = COALESCE(conversation_id, ?), updated_at = datetime('now')
           WHERE id = ?`
        ).run(personalizedReply, circle.owner_id, replyConvId, inquiryId);
        autoReplyText = personalizedReply;
      }

      res.status(201).json({
        ok: true,
        inquiry_id: inquiryId,
        conversation_id: convId,
        auto_reply: autoReplyText,
      });
    } catch (err: any) {
      res.status(400).json({ error: err?.message || 'Could not send inquiry.' });
    }
  });

  app.post('/api/circles/:id/inquiries/:inquiryId/reply', requireAuth, (req: AuthedRequest, res) => {
    try {
      const circleId = parsePositiveInt(req.params.id);
      const inquiryId = parsePositiveInt(req.params.inquiryId);
      if (!circleId || !inquiryId) {
        res.status(400).json({ error: 'Invalid identifier.' });
        return;
      }
      const actorRole = getCircleMemberRole(circleId, req.userId!);
      if (!actorRole || !['owner', 'admin', 'moderator'].includes(actorRole)) {
        res.status(403).json({ error: 'Only Circle staff can reply to customer inquiries.' });
        return;
      }

      const inquiry = db
        .prepare('SELECT * FROM circle_inquiries WHERE id = ? AND circle_id = ?')
        .get(inquiryId, circleId) as any;
      if (!inquiry) {
        res.status(404).json({ error: 'Customer inquiry not found.' });
        return;
      }

      const circle = db.prepare('SELECT name, owner_id FROM circles WHERE id = ?').get(circleId) as
        | { name: string; owner_id: number }
        | undefined;
      if (!circle) {
        res.status(404).json({ error: 'Circle not found.' });
        return;
      }

      let replyText = sanitizePlainText(req.body?.reply_text || '', 2000);
      const quickReplyId = req.body?.quick_reply_id ? parsePositiveInt(req.body.quick_reply_id) : null;
      if (quickReplyId && !replyText) {
        const tmpl = db
          .prepare('SELECT id, content FROM circle_quick_replies WHERE id = ? AND circle_id = ?')
          .get(quickReplyId, circleId) as { id: number; content: string } | undefined;
        if (tmpl) {
          replyText = tmpl.content;
        }
      }

      const nextStatus =
        req.body?.status === 'resolved'
          ? 'resolved'
          : req.body?.status === 'in_progress'
          ? 'in_progress'
          : 'resolved';

      if (replyText) {
        const check = validateTextField(replyText, 'Reply', { required: true, maxWords: MAX_WORDS });
        if (!check.valid) {
          res.status(400).json({ error: check.error });
          return;
        }
        const convId = sendAutomatedDirectMessage(
          req.userId!,
          inquiry.customer_id,
          `[${circle.name}] ${replyText}`
        );
        if (quickReplyId) {
          db.prepare('UPDATE circle_quick_replies SET usage_count = usage_count + 1 WHERE id = ?').run(quickReplyId);
        }
        db.prepare(
          `UPDATE circle_inquiries
           SET status = ?, last_reply = ?, handled_by = ?, conversation_id = COALESCE(?, conversation_id), updated_at = datetime('now')
           WHERE id = ?`
        ).run(nextStatus, replyText, req.userId, convId, inquiryId);
      } else {
        db.prepare(
          "UPDATE circle_inquiries SET status = ?, handled_by = ?, updated_at = datetime('now') WHERE id = ?"
        ).run(nextStatus, req.userId, inquiryId);
      }

      res.json({ ok: true, status: nextStatus, last_reply: replyText || inquiry.last_reply });
    } catch (err: any) {
      res.status(400).json({ error: err?.message || 'Could not update inquiry.' });
    }
  });

  app.patch('/api/circles/:id/inquiries/bulk', requireAuth, (req: AuthedRequest, res) => {
    try {
      const circleId = parsePositiveInt(req.params.id);
      if (!circleId) {
        res.status(400).json({ error: 'Invalid Circle identifier.' });
        return;
      }
      const actorRole = getCircleMemberRole(circleId, req.userId!);
      if (!actorRole || !['owner', 'admin', 'moderator'].includes(actorRole)) {
        res.status(403).json({ error: 'Only Circle staff can manage customer inquiries.' });
        return;
      }
      const nextStatus = req.body?.status === 'in_progress' ? 'in_progress' : 'resolved';
      const idsRaw = Array.isArray(req.body?.inquiry_ids) ? req.body.inquiry_ids : [];
      const ids = idsRaw.map((v: any) => parsePositiveInt(v)).filter((v: number | null): v is number => Boolean(v));

      if (ids.length > 0) {
        const placeholders = ids.map(() => '?').join(', ');
        db.prepare(
          `UPDATE circle_inquiries SET status = ?, handled_by = ?, updated_at = datetime('now') WHERE circle_id = ? AND id IN (${placeholders})`
        ).run(nextStatus, req.userId, circleId, ...ids);
      } else {
        db.prepare(
          `UPDATE circle_inquiries SET status = ?, handled_by = ?, updated_at = datetime('now') WHERE circle_id = ? AND status != 'resolved'`
        ).run(nextStatus, req.userId, circleId);
      }
      res.json({ ok: true, status: nextStatus });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Bulk inquiry update failed.' });
    }
  });

  app.post('/api/circles/:id/automation/approve-all-requests', requireAuth, (req: AuthedRequest, res) => {
    try {
      const circleId = parsePositiveInt(req.params.id);
      if (!circleId) {
        res.status(400).json({ error: 'Invalid Circle identifier.' });
        return;
      }
      const actorRole = getCircleMemberRole(circleId, req.userId!);
      if (!actorRole || !['owner', 'admin', 'moderator'].includes(actorRole)) {
        res.status(403).json({ error: 'Only Circle staff can approve requests.' });
        return;
      }
      const circle = db.prepare('SELECT name FROM circles WHERE id = ?').get(circleId) as { name: string } | undefined;
      const pending = db
        .prepare("SELECT id, user_id FROM circle_follow_requests WHERE circle_id = ? AND status = 'pending' ORDER BY created_at ASC")
        .all(circleId) as { id: number; user_id: number }[];

      const approveTx = db.transaction(() => {
        for (const reqRow of pending) {
          db.prepare('INSERT OR IGNORE INTO circle_members (circle_id, user_id, role) VALUES (?, ?, ?)').run(
            circleId,
            reqRow.user_id,
            'member'
          );
          db.prepare("UPDATE circle_follow_requests SET status = 'approved' WHERE id = ?").run(reqRow.id);
        }
      });
      approveTx();

      pending.forEach((reqRow, idx) => {
        setTimeout(() => {
          createNotification(
            reqRow.user_id,
            req.userId!,
            'circle_approved',
            circleId,
            `Your request to join ${circle?.name || 'Circle'} was approved`
          );
          triggerCircleAutoWelcome(circleId, reqRow.user_id);
        }, idx * 25);
      });

      res.json({ ok: true, approved_count: pending.length });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Could not approve all requests.' });
    }
  });

  app.post('/api/circles/:id/automation/broadcast', requireAuth, (req: AuthedRequest, res) => {
    try {
      const circleId = parsePositiveInt(req.params.id);
      if (!circleId) {
        res.status(400).json({ error: 'Invalid Circle identifier.' });
        return;
      }
      const actorRole = getCircleMemberRole(circleId, req.userId!);
      if (actorRole !== 'owner' && actorRole !== 'admin') {
        res.status(403).json({ error: 'Only Circle owners and admins can send follower broadcasts.' });
        return;
      }
      const circle = db.prepare('SELECT id, name, owner_id FROM circles WHERE id = ?').get(circleId) as
        | { id: number; name: string; owner_id: number }
        | undefined;
      if (!circle) {
        res.status(404).json({ error: 'Circle not found.' });
        return;
      }

      const settings = getOrEnsureCircleAutomationSettings(circleId);
      if (settings.last_broadcast_at) {
        const elapsedMs = Date.now() - new Date(`${settings.last_broadcast_at.replace(' ', 'T')}Z`).getTime();
        if (Number.isFinite(elapsedMs) && elapsedMs < 60_000) {
          res.status(429).json({
            error: `Please wait ${Math.ceil((60_000 - elapsedMs) / 1000)}s before sending another follower broadcast.`,
          });
          return;
        }
      }

      const message = sanitizePlainText(req.body?.message || '', 2000);
      const sendDm = Boolean(req.body?.send_dm);
      const check = validateTextField(message, 'Broadcast Message', { required: true, maxWords: MAX_WORDS });
      if (!check.valid) {
        res.status(400).json({ error: check.error });
        return;
      }

      const followers = db
        .prepare(
          `SELECT cm.user_id
           FROM circle_members cm
           JOIN users u ON u.id = cm.user_id
           WHERE cm.circle_id = ? AND u.is_blocked = 0 AND cm.user_id != ?
           ORDER BY cm.joined_at ASC, cm.user_id ASC`
        )
        .all(circleId, req.userId) as { user_id: number }[];

      db.prepare("UPDATE circle_automation_settings SET last_broadcast_at = datetime('now') WHERE circle_id = ?").run(
        circleId
      );

      const BATCH_SIZE = 20;
      const runBatch = (offset: number) => {
        const slice = followers.slice(offset, offset + BATCH_SIZE);
        for (const f of slice) {
          try {
            createNotification(f.user_id, req.userId!, 'circle_broadcast', circleId, `[${circle.name}] ${message}`);
            if (sendDm) {
              sendAutomatedDirectMessage(req.userId!, f.user_id, `[${circle.name} Update] ${message}`);
            }
          } catch {
            // Keep sequential dispatch resilient
          }
        }
        if (offset + BATCH_SIZE < followers.length) {
          setTimeout(() => runBatch(offset + BATCH_SIZE), 40);
        }
      };

      if (followers.length > 0) {
        runBatch(0);
      }

      res.json({ ok: true, recipients_count: followers.length });
    } catch (err: any) {
      res.status(400).json({ error: err?.message || 'Broadcast failed.' });
    }
  });

  // ─────────────────────────────────────────────────────────────
  // GLOBAL SEARCH (Posts, People, Circles)
  // ─────────────────────────────────────────────────────────────
  app.get('/api/search', requireAuth, (req: AuthedRequest, res) => {
    try {
      const rawQuery = sanitizePlainText(req.query.q || '', 80);
      if (rawQuery.length < 2) {
        res.json({ posts: [], people: [], circles: [] });
        return;
      }

      const escaped = rawQuery.replace(/[\\%_]/g, '\\$&');
      const likeTerm = `%${escaped}%`;

      const peopleRows = db
        .prepare(
          `SELECT id, name, username, avatar_url, is_verified, bio
           FROM users
           WHERE is_blocked = 0 AND (name LIKE ? ESCAPE '\\' OR username LIKE ? ESCAPE '\\')
           ORDER BY is_verified DESC, name ASC
           LIMIT 5`
        )
        .all(likeTerm, likeTerm) as any[];

      const postRows = db
        .prepare(
          `SELECT p.id, p.user_id, p.content, p.media_type, p.created_at,
                  u.name as author_name, u.username as author_username, u.avatar_url as author_avatar, u.is_verified as author_verified
           FROM posts p
           JOIN users u ON u.id = p.user_id
           LEFT JOIN circles c ON c.id = p.circle_id
           WHERE u.is_blocked = 0
             AND (p.circle_id IS NULL OR (c.privacy = 'public' AND p.is_global = 1) OR EXISTS(SELECT 1 FROM circle_members cm WHERE cm.circle_id = p.circle_id AND cm.user_id = ?))
             AND (p.content LIKE ? ESCAPE '\\' OR u.name LIKE ? ESCAPE '\\' OR u.username LIKE ? ESCAPE '\\')
           ORDER BY p.is_boosted DESC, p.created_at DESC
           LIMIT 5`
        )
        .all(req.userId, likeTerm, likeTerm, likeTerm) as any[];

      const circleRows = db
        .prepare(
          `SELECT c.id, c.name, c.category, c.description, c.avatar_url, c.privacy,
                  (SELECT COUNT(*) FROM circle_members WHERE circle_id = c.id) as member_count
           FROM circles c
           WHERE c.name LIKE ? ESCAPE '\\' OR c.category LIKE ? ESCAPE '\\' OR c.description LIKE ? ESCAPE '\\'
           ORDER BY member_count DESC, c.id DESC
           LIMIT 5`
        )
        .all(likeTerm, likeTerm, likeTerm) as any[];

      res.json({
        people: peopleRows.map((u) => ({
          id: u.id,
          name: u.name,
          username: u.username,
          avatar_url: sanitizeMediaUrl(u.avatar_url),
          is_verified: Boolean(u.is_verified),
          bio: u.bio || '',
        })),
        posts: postRows.map((p) => ({
          id: p.id,
          user_id: p.user_id,
          content: p.content,
          media_type: p.media_type,
          created_at: p.created_at,
          author_name: p.author_name,
          author_username: p.author_username,
          author_avatar: sanitizeMediaUrl(p.author_avatar),
          author_verified: Boolean(p.author_verified),
        })),
        circles: circleRows.map((c) => ({
          id: c.id,
          name: c.name,
          category: c.category,
          description: c.description || '',
          avatar_url: sanitizeMediaUrl(c.avatar_url),
          privacy: c.privacy === 'private' ? 'private' : 'public',
          member_count: Number(c.member_count || 0),
        })),
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Search failed.' });
    }
  });

  // ─────────────────────────────────────────────────────────────
  // NOTIFICATIONS & REPORTS
  // ─────────────────────────────────────────────────────────────
  app.get('/api/notifications', requireAuth, (req: AuthedRequest, res) => {
    const rows = db
      .prepare(
        `SELECT n.*, COALESCE(u.name, 'System') as actor_name, COALESCE(u.username, 'system') as actor_username, COALESCE(u.avatar_url, '') as actor_avatar
         FROM notifications n
         LEFT JOIN users u ON u.id = n.actor_id
         WHERE n.user_id = ?
         ORDER BY n.created_at DESC, n.id DESC
         LIMIT 50`
      )
      .all(req.userId) as any[];
    res.json({
      notifications: rows.map((n) => ({ ...n, is_read: Boolean(n.is_read) })),
    });
  });

  app.post('/api/notifications/read-all', requireAuth, (req: AuthedRequest, res) => {
    db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ?').run(req.userId);
    res.json({ ok: true });
  });

  const reportRateBuckets = new Map<number, number[]>();
  const REPORT_WINDOW_MS = 5 * 60 * 1000;
  const REPORT_MAX_PER_WINDOW = 5;

  app.post('/api/reports', requireAuth, (req: AuthedRequest, res) => {
    try {
      const reporterId = req.userId!;
      const targetType = String(req.body?.target_type || '').trim();
      const targetId = parsePositiveInt(req.body?.target_id);
      const reason = sanitizePlainText(req.body?.reason || '', 500);

      if (!['post', 'video', 'user', 'group', 'circle_post'].includes(targetType) || !targetId) {
        res.status(400).json({ error: 'Invalid report target.' });
        return;
      }

      if (reason.length < 3) {
        res.status(400).json({ error: 'Please provide a descriptive report reason (at least 3 characters).' });
        return;
      }

      const reasonCheck = validateTextField(reason, 'Report reason', { required: true, maxChars: 500 });
      if (!reasonCheck.valid) {
        res.status(400).json({ error: reasonCheck.error || 'Report reason rejected.' });
        return;
      }

      // Verify target exists and prevent self-reporting own post/video/user
      if (targetType === 'post') {
        const postRow = db.prepare('SELECT user_id FROM posts WHERE id = ?').get(targetId) as
          | { user_id: number }
          | undefined;
        if (!postRow) {
          res.status(404).json({ error: 'Reported post not found.' });
          return;
        }
        if (postRow.user_id === reporterId) {
          res.status(400).json({ error: 'You cannot report your own post.' });
          return;
        }
      } else if (targetType === 'circle_post') {
        const cpRow = db.prepare('SELECT user_id FROM circle_posts WHERE id = ?').get(targetId) as
          | { user_id: number }
          | undefined;
        if (!cpRow) {
          res.status(404).json({ error: 'Reported Circle post not found.' });
          return;
        }
        if (cpRow.user_id === reporterId) {
          res.status(400).json({ error: 'You cannot report your own post.' });
          return;
        }
      } else if (targetType === 'video') {
        const vidRow = db.prepare('SELECT uploader_id FROM videos WHERE id = ?').get(targetId) as
          | { uploader_id: number }
          | undefined;
        if (!vidRow) {
          res.status(404).json({ error: 'Reported video not found.' });
          return;
        }
        if (vidRow.uploader_id === reporterId) {
          res.status(400).json({ error: 'You cannot report your own video.' });
          return;
        }
      } else if (targetType === 'user') {
        const userRow = db.prepare('SELECT id FROM users WHERE id = ?').get(targetId) as
          | { id: number }
          | undefined;
        if (!userRow) {
          res.status(404).json({ error: 'Reported user not found.' });
          return;
        }
        if (userRow.id === reporterId) {
          res.status(400).json({ error: 'You cannot report your own profile.' });
          return;
        }
      } else if (targetType === 'group') {
        const groupRow = db
          .prepare("SELECT id FROM conversations WHERE id = ? AND type = 'group'")
          .get(targetId) as { id: number } | undefined;
        if (!groupRow) {
          res.status(404).json({ error: 'Reported group not found.' });
          return;
        }
      }

      // Prevent duplicate pending report by the same reporter for the same target
      const duplicate = db
        .prepare(
          "SELECT case_id FROM reports WHERE reporter_id = ? AND target_type = ? AND target_id = ? AND status = 'pending'"
        )
        .get(reporterId, targetType, targetId) as { case_id: string } | undefined;
      if (duplicate) {
        res.status(409).json({
          error: `You already submitted a pending report for this item (${duplicate.case_id}).`,
        });
        return;
      }

      // Sliding-window rate limit per user
      const now = Date.now();
      const recent = (reportRateBuckets.get(reporterId) || []).filter(
        (ts) => now - ts < REPORT_WINDOW_MS
      );
      if (recent.length >= REPORT_MAX_PER_WINDOW) {
        reportRateBuckets.set(reporterId, recent);
        res.status(429).json({
          error: 'Too many reports submitted recently. Please wait a few minutes before reporting again.',
        });
        return;
      }
      recent.push(now);
      reportRateBuckets.set(reporterId, recent);
      if (reportRateBuckets.size > 1000) {
        for (const [uid, times] of reportRateBuckets.entries()) {
          if (times.every((ts) => now - ts >= REPORT_WINDOW_MS)) {
            reportRateBuckets.delete(uid);
          }
        }
      }

      const randomDigits = crypto.randomInt(100000, 999999);
      const caseId = `HTV-CASE-${randomDigits}`;
      db.prepare(
        'INSERT INTO reports (case_id, reporter_id, target_type, target_id, reason) VALUES (?, ?, ?, ?, ?)'
      ).run(caseId, reporterId, targetType, targetId, reason);

      res.status(201).json({
        case_id: caseId,
        message: `Report submitted. Case ID: ${caseId}`,
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Could not submit report.' });
    }
  });

  function describeReportTarget(targetType: string, targetId: number) {
    let targetOwnerId: number | null = null;
    let targetName = '';
    let targetUsername = '';
    let targetAvatar = '';
    let targetSummary = `${targetType} #${targetId}`;

    if (targetType === 'post') {
      const p = db
        .prepare(
          'SELECT p.content, u.id as owner_id, u.name, u.username, u.avatar_url FROM posts p JOIN users u ON u.id = p.user_id WHERE p.id = ?'
        )
        .get(targetId) as any;
      if (p) {
        targetOwnerId = p.owner_id;
        targetName = p.name;
        targetUsername = p.username;
        targetAvatar = p.avatar_url || '';
        const snippet = String(p.content || '').slice(0, 80);
        targetSummary = snippet ? `Post: "${snippet}${p.content.length > 80 ? '...' : ''}"` : 'Image Post';
      } else {
        targetSummary = 'Deleted post';
      }
    } else if (targetType === 'circle_post') {
      const cp = db
        .prepare(
          'SELECT p.content, u.id as owner_id, u.name, u.username, u.avatar_url FROM circle_posts p JOIN users u ON u.id = p.user_id WHERE p.id = ?'
        )
        .get(targetId) as any;
      if (cp) {
        targetOwnerId = cp.owner_id;
        targetName = cp.name;
        targetUsername = cp.username;
        targetAvatar = cp.avatar_url || '';
        const snippet = String(cp.content || '').slice(0, 80);
        targetSummary = snippet
          ? `Circle Post: "${snippet}${cp.content.length > 80 ? '...' : ''}"`
          : 'Circle Image Post';
      } else {
        targetSummary = 'Deleted Circle post';
      }
    } else if (targetType === 'video') {
      const v = db
        .prepare(
          'SELECT v.title, u.id as owner_id, u.name, u.username, u.avatar_url FROM videos v JOIN users u ON u.id = v.uploader_id WHERE v.id = ?'
        )
        .get(targetId) as any;
      if (v) {
        targetOwnerId = v.owner_id;
        targetName = v.name;
        targetUsername = v.username;
        targetAvatar = v.avatar_url || '';
        targetSummary = `Video: "${v.title}"`;
      } else {
        targetSummary = 'Deleted video';
      }
    } else if (targetType === 'user') {
      const u = db
        .prepare('SELECT id as owner_id, name, username, avatar_url FROM users WHERE id = ?')
        .get(targetId) as any;
      if (u) {
        targetOwnerId = u.owner_id;
        targetName = u.name;
        targetUsername = u.username;
        targetAvatar = u.avatar_url || '';
        targetSummary = `Profile: ${u.name} (@${u.username})`;
      } else {
        targetSummary = 'Deleted account';
      }
    } else if (targetType === 'group') {
      const g = db
        .prepare(
          'SELECT c.name as group_name, u.id as owner_id, u.name, u.username, u.avatar_url FROM conversations c JOIN users u ON u.id = c.created_by WHERE c.id = ?'
        )
        .get(targetId) as any;
      if (g) {
        targetOwnerId = g.owner_id;
        targetName = g.name;
        targetUsername = g.username;
        targetAvatar = g.avatar_url || '';
        targetSummary = `Group: "${g.group_name}"`;
      } else {
        targetSummary = 'Deleted group';
      }
    }

    return {
      targetOwnerId,
      targetName,
      targetUsername,
      targetAvatar,
      targetSummary,
    };
  }

  app.get('/api/reports/my-activity', requireAuth, (req: AuthedRequest, res) => {
    try {
      const userId = req.userId!;

      const givenRows = db
        .prepare(
          `SELECT id, case_id, target_type, target_id, reason, status, created_at
           FROM reports
           WHERE reporter_id = ?
           ORDER BY created_at DESC, id DESC
           LIMIT 100`
        )
        .all(userId) as any[];

      const reportsGiven = givenRows.map((row) => {
        const info = describeReportTarget(row.target_type, row.target_id);
        return {
          id: row.id,
          case_id: row.case_id || `HTV-CASE-${100000 + row.id}`,
          target_type: row.target_type,
          target_id: row.target_id,
          target_name: info.targetName,
          target_username: info.targetUsername,
          target_avatar: info.targetAvatar,
          target_summary: info.targetSummary,
          reason: row.reason,
          status: row.status,
          created_at: row.created_at,
        };
      });

      const receivedRows = db
        .prepare(
          `SELECT r.id, r.case_id, r.target_type, r.target_id, r.reason, r.status, r.created_at
           FROM reports r
           WHERE (r.target_type = 'user' AND r.target_id = ?)
              OR (r.target_type = 'post' AND EXISTS (SELECT 1 FROM posts p WHERE p.id = r.target_id AND p.user_id = ?))
              OR (r.target_type = 'circle_post' AND EXISTS (SELECT 1 FROM circle_posts cp WHERE cp.id = r.target_id AND cp.user_id = ?))
              OR (r.target_type = 'video' AND EXISTS (SELECT 1 FROM videos v WHERE v.id = r.target_id AND v.uploader_id = ?))
              OR (r.target_type = 'group' AND EXISTS (SELECT 1 FROM conversations c WHERE c.id = r.target_id AND c.created_by = ?))
           ORDER BY r.created_at DESC, r.id DESC
           LIMIT 100`
        )
        .all(userId, userId, userId, userId, userId) as any[];

      const reportsReceived = receivedRows.map((row) => {
        const info = describeReportTarget(row.target_type, row.target_id);
        return {
          id: row.id,
          case_id: row.case_id || `HTV-CASE-${100000 + row.id}`,
          target_type: row.target_type,
          target_id: row.target_id,
          target_name: info.targetName,
          target_username: info.targetUsername,
          target_avatar: info.targetAvatar,
          target_summary: info.targetSummary,
          reason: row.reason,
          status: row.status,
          created_at: row.created_at,
        };
      });

      const summary = {
        received_count: reportsReceived.length,
        given_count: reportsGiven.length,
        pending_received: reportsReceived.filter((r) => r.status === 'pending').length,
        resolved_received: reportsReceived.filter((r) => r.status === 'resolved').length,
        pending_given: reportsGiven.filter((r) => r.status === 'pending').length,
      };

      if (req.userRole === 'admin') {
        const allReports = db
          .prepare(
            `SELECT r.*, u.name as reporter_name, u.username as reporter_username
             FROM reports r
             JOIN users u ON u.id = r.reporter_id
             ORDER BY r.created_at DESC, r.id DESC
             LIMIT 150`
          )
          .all() as any[];

        const perUserMap = new Map<
          number,
          { received_count: number; given_count: number; pending_received: number }
        >();
        const ensureUserStats = (uid: number) => {
          let entry = perUserMap.get(uid);
          if (!entry) {
            entry = { received_count: 0, given_count: 0, pending_received: 0 };
            perUserMap.set(uid, entry);
          }
          return entry;
        };

        const communityCases = allReports.map((rep) => {
          const info = describeReportTarget(rep.target_type, rep.target_id);
          ensureUserStats(rep.reporter_id).given_count += 1;
          if (info.targetOwnerId) {
            const targetStats = ensureUserStats(info.targetOwnerId);
            targetStats.received_count += 1;
            if (rep.status === 'pending') targetStats.pending_received += 1;
          }
          return {
            id: rep.id,
            case_id: rep.case_id || `HTV-CASE-${100000 + rep.id}`,
            reporter_id: rep.reporter_id,
            reporter_name: rep.reporter_name,
            reporter_username: rep.reporter_username,
            target_type: rep.target_type,
            target_id: rep.target_id,
            target_name: info.targetName,
            target_username: info.targetUsername,
            target_summary: info.targetSummary,
            reason: rep.reason,
            status: rep.status,
            created_at: rep.created_at,
          };
        });

        const involvedIds = Array.from(perUserMap.keys());
        const communitySummary: any[] = [];
        if (involvedIds.length > 0) {
          const placeholders = involvedIds.map(() => '?').join(',');
          const userRows = db
            .prepare(
              `SELECT id, name, username, avatar_url, is_verified FROM users WHERE id IN (${placeholders})`
            )
            .all(...involvedIds) as any[];
          for (const u of userRows) {
            const st = perUserMap.get(u.id)!;
            communitySummary.push({
              user_id: u.id,
              name: u.name,
              username: u.username,
              avatar_url: u.avatar_url || '',
              is_verified: Boolean(u.is_verified),
              received_count: st.received_count,
              given_count: st.given_count,
              pending_received: st.pending_received,
            });
          }
          communitySummary.sort(
            (a, b) =>
              b.received_count - a.received_count ||
              b.given_count - a.given_count ||
              a.name.localeCompare(b.name)
          );
        }

        res.json({
          summary,
          reports_received: reportsReceived,
          reports_given: reportsGiven,
          community_summary: communitySummary,
          community_cases: communityCases.slice(0, 60),
        });
        return;
      }

      res.json({
        summary,
        reports_received: reportsReceived,
        reports_given: reportsGiven,
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Could not load report activity.' });
    }
  });

  // ─────────────────────────────────────────────────────────────
  // ADMIN DASHBOARD ROUTES (Protected by requireAdmin)
  // ─────────────────────────────────────────────────────────────
  app.get('/api/admin/overview', requireAuth, requireAdmin, (_req, res) => {
    const videos = db
      .prepare(
        `SELECT v.*, u.name as uploader_name, u.username as uploader_username, u.avatar_url as uploader_avatar, u.is_verified as uploader_verified,
          (SELECT COUNT(*) FROM video_likes WHERE video_id = v.id) as likes_count,
          (SELECT COUNT(*) FROM video_comments WHERE video_id = v.id) as comments_count
         FROM videos v JOIN users u ON u.id = v.uploader_id
         ORDER BY CASE WHEN v.status = 'pending' THEN 0 ELSE 1 END, v.created_at DESC`
      )
      .all() as any[];

    const users = db
      .prepare('SELECT id, name, username, email, role, is_verified, is_blocked, avatar_url, created_at FROM users ORDER BY id ASC')
      .all() as any[];

    const reports = db
      .prepare(
        `SELECT r.*, u.name as reporter_name, u.username as reporter_username
         FROM reports r JOIN users u ON u.id = r.reporter_id
         ORDER BY CASE WHEN r.status = 'pending' THEN 0 ELSE 1 END, r.created_at DESC`
      )
      .all() as any[];

    const formattedReports = reports.map((rep) => {
      let targetSummary = `${rep.target_type} #${rep.target_id}`;
      let targetUsername = '';
      if (rep.target_type === 'post') {
        const p = db
          .prepare('SELECT p.content, u.username FROM posts p JOIN users u ON u.id = p.user_id WHERE p.id = ?')
          .get(rep.target_id) as { content: string; username: string } | undefined;
        targetSummary = p ? `Post by @${p.username}: "${p.content.slice(0, 70)}..."` : 'Deleted post';
        targetUsername = p?.username || '';
      } else if (rep.target_type === 'circle_post') {
        const cp = db
          .prepare('SELECT p.content, u.username FROM circle_posts p JOIN users u ON u.id = p.user_id WHERE p.id = ?')
          .get(rep.target_id) as { content: string; username: string } | undefined;
        targetSummary = cp ? `Circle post by @${cp.username}: "${cp.content.slice(0, 70)}..."` : 'Deleted Circle post';
        targetUsername = cp?.username || '';
      } else if (rep.target_type === 'video') {
        const v = db
          .prepare('SELECT v.title, u.username FROM videos v JOIN users u ON u.id = v.uploader_id WHERE v.id = ?')
          .get(rep.target_id) as { title: string; username: string } | undefined;
        targetSummary = v ? `Video by @${v.username}: "${v.title}"` : 'Deleted video';
        targetUsername = v?.username || '';
      } else if (rep.target_type === 'user') {
        const u = db.prepare('SELECT name, username FROM users WHERE id = ?').get(rep.target_id) as
          | { name: string; username: string }
          | undefined;
        targetSummary = u ? `Profile: ${u.name} (@${u.username})` : 'Deleted user';
        targetUsername = u?.username || '';
      } else if (rep.target_type === 'group') {
        const g = db
          .prepare('SELECT c.name, u.username FROM conversations c JOIN users u ON u.id = c.created_by WHERE c.id = ?')
          .get(rep.target_id) as { name: string; username: string } | undefined;
        targetSummary = g ? `Group: "${g.name}" (by @${g.username})` : 'Deleted group';
        targetUsername = g?.username || '';
      }
      return {
        ...rep,
        case_id: rep.case_id || `HTV-CASE-${100000 + rep.id}`,
        target_username: targetUsername,
        target_summary: targetSummary,
      };
    });

    res.json({
      videos: videos.map((v) => ({ ...v, uploader_verified: Boolean(v.uploader_verified) })),
      users: users.map((u) => ({
        ...u,
        is_verified: Boolean(u.is_verified),
        is_blocked: Boolean(u.is_blocked),
      })),
      reports: formattedReports,
    });
  });

  app.post('/api/admin/videos', requireAuth, requireAdmin, async (req: AuthedRequest, res) => {
    try {
      const title = String(req.body?.title || '').trim();
      const description = String(req.body?.description || '').trim();
      const videoUrl = String(req.body?.video_url || '').trim();
      let thumbnailUrl = String(req.body?.thumbnail_url || '').trim();
      let durationSeconds = Number(req.body?.duration_seconds || 0);

      const titleCheck = validateTextField(title, 'Video Title', { required: true, maxWords: 30 });
      if (!titleCheck.valid) {
        res.status(400).json({ error: titleCheck.error });
        return;
      }
      const descCheck = validateTextField(description, 'Video Description', { maxWords: MAX_WORDS });
      if (!descCheck.valid) {
        res.status(400).json({ error: descCheck.error });
        return;
      }
      if (!videoUrl) {
        res.status(400).json({ error: 'Please upload a valid video file.' });
        return;
      }

      const localVideo = resolveSafeUploadVideo(videoUrl);
      if (localVideo) {
        if (!thumbnailUrl) {
          const thumb = await generateVideoThumbnail(localVideo, THUMB_DIR).catch(() => null);
          if (thumb) {
            thumbnailUrl = `/uploads/thumbs/${thumb.filename}`;
          }
        }
        if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
          const probe = await probeVideoFile(localVideo).catch(() => null);
          if (probe) durationSeconds = Math.max(0, Math.round(probe.duration || 0));
        }
      }

      const result = db
        .prepare(
          "INSERT INTO videos (uploader_id, title, description, video_url, thumbnail_url, duration_seconds, status) VALUES (?, ?, ?, ?, ?, ?, 'approved')"
        )
        .run(
          req.userId,
          title,
          description,
          videoUrl,
          thumbnailUrl,
          Number.isFinite(durationSeconds) && durationSeconds > 0 ? Math.round(durationSeconds) : 0
        );

      res.status(201).json({
        id: Number(result.lastInsertRowid),
        thumbnail_url: thumbnailUrl,
        duration_seconds: Math.round(durationSeconds || 0),
      });
    } catch (err: any) {
      res.status(400).json({ error: err?.message || 'Could not publish video.' });
    }
  });

  app.patch('/api/admin/videos/:id/status', requireAuth, requireAdmin, (req, res) => {
    const videoId = Number(req.params.id);
    const status = req.body?.status;
    if (!['approved', 'rejected', 'pending'].includes(status)) {
      res.status(400).json({ error: 'Invalid status.' });
      return;
    }
    db.prepare('UPDATE videos SET status = ? WHERE id = ?').run(status, videoId);
    res.json({ ok: true, status });
  });

  app.patch('/api/admin/users/:id/verify', requireAuth, requireAdmin, (req, res) => {
    const targetId = Number(req.params.id);
    const u = db.prepare('SELECT is_verified FROM users WHERE id = ?').get(targetId) as { is_verified: number } | undefined;
    if (!u) {
      res.status(404).json({ error: 'User not found.' });
      return;
    }
    const next = u.is_verified ? 0 : 1;
    db.prepare('UPDATE users SET is_verified = ? WHERE id = ?').run(next, targetId);
    res.json({ is_verified: Boolean(next) });
  });

  app.patch('/api/admin/users/:id/block', requireAuth, requireAdmin, (req: AuthedRequest, res) => {
    const targetId = Number(req.params.id);
    if (targetId === req.userId) {
      res.status(400).json({ error: 'You cannot suspend your own administrator account.' });
      return;
    }
    const u = db.prepare('SELECT is_blocked FROM users WHERE id = ?').get(targetId) as { is_blocked: number } | undefined;
    if (!u) {
      res.status(404).json({ error: 'User not found.' });
      return;
    }
    const next = u.is_blocked ? 0 : 1;
    db.prepare('UPDATE users SET is_blocked = ? WHERE id = ?').run(next, targetId);
    if (next === 1) {
      const sockets = activeSockets.get(targetId);
      if (sockets) {
        for (const ws of sockets) ws.close(1008, 'Account suspended');
        activeSockets.delete(targetId);
      }
    }
    res.json({ is_blocked: Boolean(next) });
  });

  app.patch('/api/admin/reports/:id', requireAuth, requireAdmin, (req, res) => {
    const reportId = Number(req.params.id);
    const action = req.body?.action; // 'remove_target' | 'dismiss'
    const report = db.prepare('SELECT * FROM reports WHERE id = ?').get(reportId) as any;
    if (!report) {
      res.status(404).json({ error: 'Report not found.' });
      return;
    }

    if (action === 'remove_target') {
      if (report.target_type === 'post') {
        db.prepare('DELETE FROM posts WHERE id = ?').run(report.target_id);
      } else if (report.target_type === 'circle_post') {
        db.prepare('DELETE FROM circle_posts WHERE id = ?').run(report.target_id);
      } else if (report.target_type === 'video') {
        db.prepare("UPDATE videos SET status = 'rejected' WHERE id = ?").run(report.target_id);
      } else if (report.target_type === 'user') {
        db.prepare("UPDATE users SET is_blocked = 1 WHERE id = ? AND role != 'admin'").run(report.target_id);
      } else if (report.target_type === 'group') {
        db.prepare("DELETE FROM conversations WHERE id = ? AND type = 'group'").run(report.target_id);
      }
      db.prepare("UPDATE reports SET status = 'resolved' WHERE id = ?").run(reportId);
    } else {
      db.prepare("UPDATE reports SET status = 'dismissed' WHERE id = ?").run(reportId);
    }
    res.json({ ok: true });
  });

  // ─────────────────────────────────────────────────────────────
  // SUPPORTBOX & TELEGRAM SUPPORT ROUTES
  // ─────────────────────────────────────────────────────────────
  const SUPPORT_CATEGORIES = new Set([
    'bug_error',
    'crash_performance',
    'account_access',
    'feature_request',
    'safety_policy',
    'other',
  ]);
  const SUPPORT_STATUSES = new Set(['submitted', 'in_review', 'resolved', 'closed']);
  const supportRateBuckets = new Map<number, number[]>();
  const SUPPORT_WINDOW_MS = 10 * 60 * 1000;
  const SUPPORT_MAX_PER_WINDOW = 6;

  function normalizeTelegramHandleInput(raw: unknown): { valid: boolean; handle: string; error?: string } {
    const trimmed = typeof raw === 'string' ? raw.trim() : '';
    if (!trimmed) return { valid: true, handle: '' };
    let cleaned = trimmed
      .replace(/^https?:\/\/(www\.)?(t\.me|telegram\.me)\//i, '')
      .replace(/^(t\.me|telegram\.me)\//i, '')
      .replace(/^@+/, '')
      .split(/[/?#]/)[0]
      .trim();
    if (!/^[a-zA-Z0-9_]{3,64}$/.test(cleaned)) {
      return {
        valid: false,
        handle: '',
        error: 'Telegram username must be 3–64 letters, numbers, or underscores (e.g. @HushTalkSupport).',
      };
    }
    return { valid: true, handle: cleaned };
  }

  function getSupportConfig() {
    const row = db
      .prepare("SELECT value FROM app_settings WHERE key = 'telegram_support_handle'")
      .get() as { value: string } | undefined;
    const rawSetting = row?.value || process.env.TELEGRAM_SUPPORT_HANDLE || '';
    const parsed = normalizeTelegramHandleInput(rawSetting);
    const cleanHandle = parsed.valid ? parsed.handle : '';
    const botConfigured = Boolean(
      (process.env.TELEGRAM_BOT_TOKEN || '').trim() && (process.env.TELEGRAM_CHAT_ID || '').trim()
    );
    return {
      telegram_handle: cleanHandle ? `@${cleanHandle}` : '',
      telegram_url: cleanHandle ? `https://t.me/${cleanHandle}` : '',
      telegram_bot_configured: botConfigured,
      app_version: '2.4.0',
    };
  }

  async function forwardSupportTicketToTelegram(ticket: {
    ticket_id: string;
    category: string;
    affected_area: string;
    subject: string;
    description: string;
    device_info: string;
    reporter_name: string;
    reporter_username: string;
  }): Promise<boolean> {
    const botToken = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
    const chatId = (process.env.TELEGRAM_CHAT_ID || '').trim();
    if (!botToken || !chatId) return false;

    const lines = [
      `HushTalkVoice SupportBox [${ticket.ticket_id}]`,
      `From: ${ticket.reporter_name} (@${ticket.reporter_username})`,
      `Category: ${ticket.category} | Area: ${ticket.affected_area}`,
      `Subject: ${ticket.subject}`,
      `Details: ${ticket.description.slice(0, 1200)}`,
      ticket.device_info ? `Device: ${ticket.device_info}` : '',
    ].filter(Boolean);

    try {
      const resp = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: lines.join('\n'),
        }),
        signal: AbortSignal.timeout(5000),
      });
      return resp.ok;
    } catch {
      return false;
    }
  }

  function formatSupportTicketRow(row: any) {
    return {
      ...row,
      telegram_forwarded: Boolean(row.telegram_forwarded),
    };
  }

  app.get('/api/support/config', requireAuth, (_req, res) => {
    res.json(getSupportConfig());
  });

  app.get('/api/support/tickets', requireAuth, (req: AuthedRequest, res) => {
    const rows = db
      .prepare(
        `SELECT t.*, h.name as handled_by_name
         FROM support_tickets t
         LEFT JOIN users h ON h.id = t.handled_by
         WHERE t.user_id = ?
         ORDER BY t.id DESC
         LIMIT 50`
      )
      .all(req.userId!) as any[];
    res.json({ tickets: rows.map(formatSupportTicketRow) });
  });

  app.post('/api/support/tickets', requireAuth, async (req: AuthedRequest, res) => {
    try {
      const userId = req.userId!;
      const category = String(req.body?.category || 'bug_error').trim();
      const affectedArea = sanitizePlainText(req.body?.affected_area || 'general', 50) || 'general';
      const subject = sanitizePlainText(req.body?.subject || '', 140);
      const description = sanitizePlainText(req.body?.description || '', 2500);
      const rawScreenshot = sanitizeMediaUrl(req.body?.screenshot_url || '');
      const screenshotUrl = rawScreenshot.startsWith('/uploads/') ? rawScreenshot : '';
      const deviceInfo = sanitizePlainText(req.body?.device_info || '', 300);

      if (!SUPPORT_CATEGORIES.has(category)) {
        res.status(400).json({ error: 'Invalid issue category selected.' });
        return;
      }
      if (subject.length < 3) {
        res.status(400).json({ error: 'Please enter a short summary (at least 3 characters).' });
        return;
      }
      if (description.length < 10) {
        res.status(400).json({ error: 'Please describe what happened (at least 10 characters).' });
        return;
      }

      // Sliding-window rate limit
      const now = Date.now();
      const recent = (supportRateBuckets.get(userId) || []).filter(
        (ts) => now - ts < SUPPORT_WINDOW_MS
      );
      if (recent.length >= SUPPORT_MAX_PER_WINDOW) {
        supportRateBuckets.set(userId, recent);
        res.status(429).json({
          error: 'Too many SupportBox applications submitted recently. Please wait a few minutes or message us on Telegram.',
        });
        return;
      }
      recent.push(now);
      supportRateBuckets.set(userId, recent);
      if (supportRateBuckets.size > 1000) {
        for (const [uid, times] of supportRateBuckets.entries()) {
          if (times.every((ts) => now - ts >= SUPPORT_WINDOW_MS)) {
            supportRateBuckets.delete(uid);
          }
        }
      }

      const ticketCode = `HTV-SUP-${crypto.randomInt(100000, 999999)}`;
      const insertResult = db
        .prepare(
          `INSERT INTO support_tickets
           (ticket_id, user_id, category, affected_area, subject, description, screenshot_url, device_info)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(ticketCode, userId, category, affectedArea, subject, description, screenshotUrl, deviceInfo);

      const createdId = Number(insertResult.lastInsertRowid);
      const userRow = db
        .prepare('SELECT name, username FROM users WHERE id = ?')
        .get(userId) as { name: string; username: string } | undefined;

      const forwarded = await forwardSupportTicketToTelegram({
        ticket_id: ticketCode,
        category,
        affected_area: affectedArea,
        subject,
        description,
        device_info: deviceInfo,
        reporter_name: userRow?.name || 'Member',
        reporter_username: userRow?.username || String(userId),
      });

      if (forwarded) {
        db.prepare('UPDATE support_tickets SET telegram_forwarded = 1 WHERE id = ?').run(createdId);
      }

      // Notify admins in-app
      const admins = db
        .prepare("SELECT id FROM users WHERE role = 'admin' AND is_blocked = 0 AND id != ?")
        .all(userId) as { id: number }[];
      for (const admin of admins) {
        createNotification(
          admin.id,
          userId,
          'support_ticket',
          createdId,
          `submitted SupportBox ticket ${ticketCode}: ${subject.slice(0, 60)}`
        );
      }

      const ticket = db
        .prepare(
          `SELECT t.*, h.name as handled_by_name
           FROM support_tickets t
           LEFT JOIN users h ON h.id = t.handled_by
           WHERE t.id = ?`
        )
        .get(createdId);

      res.status(201).json({ ticket: formatSupportTicketRow(ticket) });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Could not submit SupportBox application.' });
    }
  });

  app.get('/api/admin/support', requireAuth, requireAdmin, (_req, res) => {
    const rows = db
      .prepare(
        `SELECT t.*,
                u.name as user_name, u.username as user_username, u.avatar_url as user_avatar, u.email as user_email,
                h.name as handled_by_name
         FROM support_tickets t
         JOIN users u ON u.id = t.user_id
         LEFT JOIN users h ON h.id = t.handled_by
         ORDER BY CASE WHEN t.status IN ('submitted', 'in_review') THEN 0 ELSE 1 END, t.id DESC
         LIMIT 200`
      )
      .all() as any[];

    res.json({
      tickets: rows.map(formatSupportTicketRow),
      config: getSupportConfig(),
    });
  });

  app.patch('/api/admin/support/:id', requireAuth, requireAdmin, (req: AuthedRequest, res) => {
    const ticketDbId = parsePositiveInt(req.params.id);
    if (!ticketDbId) {
      res.status(400).json({ error: 'Invalid ticket ID.' });
      return;
    }

    const existing = db.prepare('SELECT * FROM support_tickets WHERE id = ?').get(ticketDbId) as any;
    if (!existing) {
      res.status(404).json({ error: 'Support ticket not found.' });
      return;
    }

    const status = String(req.body?.status || existing.status).trim();
    if (!SUPPORT_STATUSES.has(status)) {
      res.status(400).json({ error: 'Invalid ticket status.' });
      return;
    }

    const adminReply =
      req.body?.admin_reply !== undefined
        ? sanitizePlainText(req.body.admin_reply, 2000)
        : existing.admin_reply;

    db.prepare(
      `UPDATE support_tickets
       SET status = ?, admin_reply = ?, handled_by = ?, updated_at = datetime('now')
       WHERE id = ?`
    ).run(status, adminReply, req.userId!, ticketDbId);

    const statusLabel =
      status === 'in_review'
        ? 'In Review'
        : status === 'resolved'
        ? 'Resolved'
        : status === 'closed'
        ? 'Closed'
        : 'Submitted';

    createNotification(
      existing.user_id,
      req.userId!,
      'support_reply',
      ticketDbId,
      adminReply
        ? `updated SupportBox ticket ${existing.ticket_id} (${statusLabel}): ${adminReply.slice(0, 80)}`
        : `marked SupportBox ticket ${existing.ticket_id} as ${statusLabel}`
    );

    const updated = db
      .prepare(
        `SELECT t.*,
                u.name as user_name, u.username as user_username, u.avatar_url as user_avatar, u.email as user_email,
                h.name as handled_by_name
         FROM support_tickets t
         JOIN users u ON u.id = t.user_id
         LEFT JOIN users h ON h.id = t.handled_by
         WHERE t.id = ?`
      )
      .get(ticketDbId);

    res.json({ ticket: formatSupportTicketRow(updated) });
  });

  app.put('/api/admin/support/config', requireAuth, requireAdmin, (req, res) => {
    const parsed = normalizeTelegramHandleInput(req.body?.telegram_handle);
    if (!parsed.valid) {
      res.status(400).json({ error: parsed.error || 'Invalid Telegram username.' });
      return;
    }

    db.prepare(
      `INSERT INTO app_settings (key, value, updated_at)
       VALUES ('telegram_support_handle', ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
    ).run(parsed.handle);

    res.json({ config: getSupportConfig() });
  });

  // Vite / Static Frontend integration
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        allowedHosts: true,
        ws: {
          server,
          path: '/__vite_hmr',
        },
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(process.cwd(), 'dist');
    app.use(
      express.static(distPath, {
        maxAge: '1y',
        immutable: true,
        setHeaders: (res, filePath) => {
          if (filePath.endsWith('index.html') || filePath.endsWith('sw.js') || filePath.endsWith('registerSW.js')) {
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
          } else if (filePath.endsWith('.webmanifest')) {
            res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
            res.setHeader('Cache-Control', 'no-cache');
          }
        },
      })
    );
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  // Global error handler (malformed JSON, unexpected server errors)
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof SyntaxError && 'body' in err) {
      res.status(400).json({ error: 'Malformed JSON request body.' });
      return;
    }
    res.status(err?.status || 500).json({ error: 'Internal server error.' });
  });

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`HushTalkVoice running on http://0.0.0.0:${PORT}`);
  });
}

bootstrap().catch((err) => {
  console.error('Failed to start HushTalkVoice server:', err);
  process.exit(1);
});
