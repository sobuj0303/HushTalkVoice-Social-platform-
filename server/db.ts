import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import fs from 'fs';
import path from 'path';
import { containsBlockedLink, countWords, MAX_WORDS } from '../src/shared/validation';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const UPLOAD_DIR = path.resolve(process.cwd(), 'uploads');
const SEED_MEDIA_DIR = path.resolve(UPLOAD_DIR, 'seed');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(SEED_MEDIA_DIR, { recursive: true });

const DB_PATH = path.resolve(DATA_DIR, 'hushtalkvoice.db');
export const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Register custom SQLite security validation functions for DB-level enforcement
db.function('has_blocked_link', (val: string | null) => {
  if (!val) return 0;
  return containsBlockedLink(String(val)).blocked ? 1 : 0;
});

db.function('exceeds_word_limit', (val: string | null, limit: number) => {
  if (!val) return 0;
  return countWords(String(val)) > limit ? 1 : 0;
});

function createAmbientWav(filePath: string, freqs: number[], durationSec = 4): void {
  if (fs.existsSync(filePath)) return;
  const sampleRate = 22050;
  const numSamples = sampleRate * durationSec;
  const buffer = Buffer.alloc(44 + numSamples * 2);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + numSamples * 2, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(numSamples * 2, 40);

  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const envelope = Math.min(1, t * 3) * Math.min(1, (durationSec - t) * 2.5);
    let sample = 0;
    for (const f of freqs) {
      sample += Math.sin(2 * Math.PI * f * t);
    }
    sample = (sample / freqs.length) * 0.25 * envelope;
    buffer.writeInt16LE(Math.max(-32767, Math.min(32767, Math.floor(sample * 32767))), 44 + i * 2);
  }
  fs.writeFileSync(filePath, buffer);
}

export function initDatabase(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'admin')),
      is_verified INTEGER NOT NULL DEFAULT 0,
      is_blocked INTEGER NOT NULL DEFAULT 0,
      avatar_url TEXT NOT NULL DEFAULT '',
      cover_url TEXT NOT NULL DEFAULT '',
      bio TEXT NOT NULL DEFAULT '',
      facebook_link TEXT NOT NULL DEFAULT '',
      theme TEXT NOT NULL DEFAULT 'night' CHECK (theme IN ('day', 'night', 'system')),
      profile_visibility TEXT NOT NULL DEFAULT 'public' CHECK (profile_visibility IN ('public', 'private')),
      followers_visibility TEXT NOT NULL DEFAULT 'public' CHECK (followers_visibility IN ('public', 'private')),
      following_visibility TEXT NOT NULL DEFAULT 'public' CHECK (following_visibility IN ('public', 'private')),
      facebook_visibility TEXT NOT NULL DEFAULT 'public' CHECK (facebook_visibility IN ('public', 'private')),
      online_status_visibility TEXT NOT NULL DEFAULT 'everyone' CHECK (online_status_visibility IN ('everyone', 'nobody')),
      who_can_message TEXT NOT NULL DEFAULT 'everyone' CHECK (who_can_message IN ('everyone', 'connections')),
      last_seen TEXT NOT NULL DEFAULT (datetime('now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Migrate legacy users table if it still carries old dark-only theme CHECK constraint
  const usersSqlRow = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'")
    .get() as { sql: string } | undefined;
  if (usersSqlRow && usersSqlRow.sql.includes('midnight-purple')) {
    db.pragma('foreign_keys = OFF');
    db.exec(`
      BEGIN TRANSACTION;
      CREATE TABLE users_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        email TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'admin')),
        is_verified INTEGER NOT NULL DEFAULT 0,
        is_blocked INTEGER NOT NULL DEFAULT 0,
        avatar_url TEXT NOT NULL DEFAULT '',
        cover_url TEXT NOT NULL DEFAULT '',
        bio TEXT NOT NULL DEFAULT '',
        facebook_link TEXT NOT NULL DEFAULT '',
        theme TEXT NOT NULL DEFAULT 'night' CHECK (theme IN ('day', 'night', 'system')),
        profile_visibility TEXT NOT NULL DEFAULT 'public' CHECK (profile_visibility IN ('public', 'private')),
        followers_visibility TEXT NOT NULL DEFAULT 'public' CHECK (followers_visibility IN ('public', 'private')),
        following_visibility TEXT NOT NULL DEFAULT 'public' CHECK (following_visibility IN ('public', 'private')),
        facebook_visibility TEXT NOT NULL DEFAULT 'public' CHECK (facebook_visibility IN ('public', 'private')),
        online_status_visibility TEXT NOT NULL DEFAULT 'everyone' CHECK (online_status_visibility IN ('everyone', 'nobody')),
        who_can_message TEXT NOT NULL DEFAULT 'everyone' CHECK (who_can_message IN ('everyone', 'connections')),
        last_seen TEXT NOT NULL DEFAULT (datetime('now')),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO users_new (
        id, name, username, email, password_hash, role, is_verified, is_blocked,
        avatar_url, cover_url, bio, facebook_link, theme,
        profile_visibility, followers_visibility, following_visibility,
        facebook_visibility, online_status_visibility, who_can_message, last_seen, created_at
      )
      SELECT
        id, name, username, email, password_hash, role, is_verified, is_blocked,
        avatar_url, cover_url, bio, facebook_link,
        CASE WHEN theme IN ('day', 'night', 'system') THEN theme ELSE 'night' END,
        profile_visibility, followers_visibility, following_visibility,
        facebook_visibility, online_status_visibility, who_can_message, last_seen, created_at
      FROM users;
      DROP TABLE users;
      ALTER TABLE users_new RENAME TO users;
      COMMIT;
    `);
    db.pragma('foreign_keys = ON');
  }

  db.exec(`

    CREATE TABLE IF NOT EXISTS password_resets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      code TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS follows (
      follower_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      following_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (follower_id, following_id)
    );

    CREATE TABLE IF NOT EXISTS connections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      requester_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      receiver_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (requester_id, receiver_id)
    );

    CREATE TABLE IF NOT EXISTS posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      content TEXT NOT NULL DEFAULT '',
      media_type TEXT NOT NULL DEFAULT 'none' CHECK (media_type IN ('none', 'image', 'audio', 'video')),
      media_url TEXT NOT NULL DEFAULT '',
      views_count INTEGER NOT NULL DEFAULT 0,
      is_boosted INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS post_views (
      post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (post_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS post_likes (
      post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (post_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS post_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS post_shares (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS videos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uploader_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      video_url TEXT NOT NULL,
      thumbnail_url TEXT NOT NULL DEFAULT '',
      duration_seconds INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
      views_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS video_likes (
      video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (video_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS video_loves (
      video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (video_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS video_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL CHECK (type IN ('direct', 'group')),
      name TEXT NOT NULL DEFAULT '',
      avatar_url TEXT NOT NULL DEFAULT '',
      created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'pending_request', 'rejected')),
      requester_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      join_mode TEXT NOT NULL DEFAULT 'direct' CHECK (join_mode IN ('direct', 'approval')),
      invite_code TEXT NOT NULL DEFAULT '',
      max_video_mb INTEGER NOT NULL DEFAULT 25,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS conversation_members (
      conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
      is_muted INTEGER NOT NULL DEFAULT 0,
      is_chat_muted INTEGER NOT NULL DEFAULT 0,
      chat_muted_until TEXT NOT NULL DEFAULT '',
      joined_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_read_at TEXT NOT NULL DEFAULT '1970-01-01 00:00:00',
      PRIMARY KEY (conversation_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS group_join_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      invited_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (conversation_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      content TEXT NOT NULL DEFAULT '',
      media_type TEXT NOT NULL DEFAULT 'none' CHECK (media_type IN ('none', 'image', 'audio', 'video')),
      media_url TEXT NOT NULL DEFAULT '',
      media_size_bytes INTEGER NOT NULL DEFAULT 0,
      reply_to_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
      is_unsent INTEGER NOT NULL DEFAULT 0,
      is_forwarded INTEGER NOT NULL DEFAULT 0,
      forwarded_from_name TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS message_reactions (
      message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      emoji TEXT NOT NULL CHECK (emoji IN ('❤️', '👍', '😂', '😮', '🔥')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (message_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id TEXT NOT NULL DEFAULT '',
      reporter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      target_type TEXT NOT NULL CHECK (target_type IN ('post', 'video', 'user', 'group', 'circle_post')),
      target_id INTEGER NOT NULL,
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved', 'dismissed')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      type TEXT NOT NULL,
      reference_id INTEGER,
      message TEXT NOT NULL,
      is_read INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS circles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'Community',
      description TEXT NOT NULL DEFAULT '',
      avatar_url TEXT NOT NULL DEFAULT '',
      privacy TEXT NOT NULL DEFAULT 'public' CHECK (privacy IN ('public', 'private')),
      require_post_approval INTEGER NOT NULL DEFAULT 0,
      invite_code TEXT NOT NULL DEFAULT '',
      owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS circle_members (
      circle_id INTEGER NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'moderator', 'member')),
      joined_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (circle_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS circle_follow_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      circle_id INTEGER NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (circle_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS circle_posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      circle_id INTEGER NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      content TEXT NOT NULL DEFAULT '',
      media_type TEXT NOT NULL DEFAULT 'none' CHECK (media_type IN ('none', 'image')),
      media_url TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('approved', 'pending', 'rejected')),
      views_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS circle_post_likes (
      post_id INTEGER NOT NULL REFERENCES circle_posts(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (post_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS circle_post_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER NOT NULL REFERENCES circle_posts(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS circle_post_shares (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER NOT NULL REFERENCES circle_posts(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS circle_post_views (
      post_id INTEGER NOT NULL REFERENCES circle_posts(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (post_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS circle_automation_settings (
      circle_id INTEGER PRIMARY KEY REFERENCES circles(id) ON DELETE CASCADE,
      auto_welcome_enabled INTEGER NOT NULL DEFAULT 0,
      auto_welcome_message TEXT NOT NULL DEFAULT '',
      auto_inquiry_reply_enabled INTEGER NOT NULL DEFAULT 1,
      auto_inquiry_reply_message TEXT NOT NULL DEFAULT '',
      auto_approve_verified INTEGER NOT NULL DEFAULT 0,
      auto_keyword_reply_enabled INTEGER NOT NULL DEFAULT 1,
      last_broadcast_at TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS circle_keyword_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      circle_id INTEGER NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
      keyword TEXT NOT NULL,
      reply_text TEXT NOT NULL,
      create_inquiry INTEGER NOT NULL DEFAULT 1,
      hit_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS circle_quick_replies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      circle_id INTEGER NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      usage_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS circle_inquiries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      circle_id INTEGER NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
      customer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      source TEXT NOT NULL DEFAULT 'direct' CHECK (source IN ('direct', 'comment_keyword', 'post_cta')),
      post_id INTEGER REFERENCES circle_posts(id) ON DELETE SET NULL,
      conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
      message TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'in_progress', 'resolved')),
      last_reply TEXT NOT NULL DEFAULT '',
      handled_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Database-level Triggers: 500 Member Group Cap, Anti-Spam Link Blocking, and 200-Word Cap
    CREATE TRIGGER IF NOT EXISTS enforce_group_member_limit
    BEFORE INSERT ON conversation_members
    WHEN (SELECT type FROM conversations WHERE id = NEW.conversation_id) = 'group'
      AND (SELECT COUNT(*) FROM conversation_members WHERE conversation_id = NEW.conversation_id) >= 500
    BEGIN
      SELECT RAISE(ABORT, 'Group chat limit of 500 members exceeded');
    END;

    CREATE TRIGGER IF NOT EXISTS block_links_posts_insert
    BEFORE INSERT ON posts
    WHEN has_blocked_link(NEW.content) = 1 OR exceeds_word_limit(NEW.content, ${MAX_WORDS}) = 1
    BEGIN
      SELECT RAISE(ABORT, 'Post violates anti-spam link or 200-word rule');
    END;

    CREATE TRIGGER IF NOT EXISTS block_links_comments_insert
    BEFORE INSERT ON post_comments
    WHEN has_blocked_link(NEW.content) = 1
    BEGIN
      SELECT RAISE(ABORT, 'Comment violates anti-spam link rule');
    END;

    CREATE TRIGGER IF NOT EXISTS block_links_messages_insert
    BEFORE INSERT ON messages
    WHEN has_blocked_link(NEW.content) = 1 OR exceeds_word_limit(NEW.content, ${MAX_WORDS}) = 1
    BEGIN
      SELECT RAISE(ABORT, 'Message violates anti-spam link or 200-word rule');
    END;

    CREATE TRIGGER IF NOT EXISTS block_links_group_name_insert
    BEFORE INSERT ON conversations
    WHEN NEW.type = 'group' AND has_blocked_link(NEW.name) = 1
    BEGIN
      SELECT RAISE(ABORT, 'Group name violates anti-spam link rule');
    END;

    CREATE TRIGGER IF NOT EXISTS block_links_group_name_update
    BEFORE UPDATE OF name ON conversations
    WHEN NEW.type = 'group' AND has_blocked_link(NEW.name) = 1
    BEGIN
      SELECT RAISE(ABORT, 'Group name violates anti-spam link rule');
    END;

    CREATE TRIGGER IF NOT EXISTS block_links_videos_insert
    BEFORE INSERT ON videos
    WHEN has_blocked_link(NEW.title) = 1 OR has_blocked_link(NEW.description) = 1
    BEGIN
      SELECT RAISE(ABORT, 'Video title or description violates anti-spam link rule');
    END;

    CREATE TRIGGER IF NOT EXISTS block_links_video_comments_insert
    BEFORE INSERT ON video_comments
    WHEN has_blocked_link(NEW.content) = 1
    BEGIN
      SELECT RAISE(ABORT, 'Video comment violates anti-spam link rule');
    END;

    CREATE TRIGGER IF NOT EXISTS block_links_bio_update
    BEFORE UPDATE OF bio ON users
    WHEN has_blocked_link(NEW.bio) = 1
    BEGIN
      SELECT RAISE(ABORT, 'Bio violates anti-spam link rule');
    END;

    CREATE TRIGGER IF NOT EXISTS block_links_circles_insert
    BEFORE INSERT ON circles
    WHEN has_blocked_link(NEW.name) = 1 OR has_blocked_link(NEW.description) = 1
    BEGIN
      SELECT RAISE(ABORT, 'Circle name or description violates anti-spam link rule');
    END;

    CREATE TRIGGER IF NOT EXISTS block_links_circle_posts_insert
    BEFORE INSERT ON circle_posts
    WHEN has_blocked_link(NEW.content) = 1 OR exceeds_word_limit(NEW.content, ${MAX_WORDS}) = 1
    BEGIN
      SELECT RAISE(ABORT, 'Circle post violates anti-spam link or 200-word rule');
    END;

    CREATE TRIGGER IF NOT EXISTS block_links_circle_post_comments_insert
    BEFORE INSERT ON circle_post_comments
    WHEN has_blocked_link(NEW.content) = 1
    BEGIN
      SELECT RAISE(ABORT, 'Circle comment violates anti-spam link rule');
    END;

    CREATE TRIGGER IF NOT EXISTS block_links_circle_automation_insert
    BEFORE INSERT ON circle_automation_settings
    WHEN has_blocked_link(NEW.auto_welcome_message) = 1
    BEGIN
      SELECT RAISE(ABORT, 'Welcome message violates anti-spam link rule');
    END;

    CREATE TRIGGER IF NOT EXISTS block_links_circle_automation_update
    BEFORE UPDATE OF auto_welcome_message ON circle_automation_settings
    WHEN has_blocked_link(NEW.auto_welcome_message) = 1
    BEGIN
      SELECT RAISE(ABORT, 'Welcome message violates anti-spam link rule');
    END;

    CREATE TRIGGER IF NOT EXISTS block_links_circle_automation_inq_insert
    BEFORE INSERT ON circle_automation_settings
    WHEN has_blocked_link(NEW.auto_inquiry_reply_message) = 1
    BEGIN
      SELECT RAISE(ABORT, 'Inquiry auto-reply violates anti-spam link rule');
    END;

    CREATE TRIGGER IF NOT EXISTS block_links_circle_automation_inq_update
    BEFORE UPDATE OF auto_inquiry_reply_message ON circle_automation_settings
    WHEN has_blocked_link(NEW.auto_inquiry_reply_message) = 1
    BEGIN
      SELECT RAISE(ABORT, 'Inquiry auto-reply violates anti-spam link rule');
    END;

    CREATE TRIGGER IF NOT EXISTS block_links_circle_keywords_insert
    BEFORE INSERT ON circle_keyword_rules
    WHEN has_blocked_link(NEW.keyword) = 1 OR has_blocked_link(NEW.reply_text) = 1
    BEGIN
      SELECT RAISE(ABORT, 'Keyword auto-reply violates anti-spam link rule');
    END;

    CREATE TRIGGER IF NOT EXISTS block_links_circle_quick_replies_insert
    BEFORE INSERT ON circle_quick_replies
    WHEN has_blocked_link(NEW.title) = 1 OR has_blocked_link(NEW.content) = 1
    BEGIN
      SELECT RAISE(ABORT, 'Quick reply template violates anti-spam link rule');
    END;

    CREATE TRIGGER IF NOT EXISTS block_links_circle_inquiries_insert
    BEFORE INSERT ON circle_inquiries
    WHEN has_blocked_link(NEW.message) = 1
    BEGIN
      SELECT RAISE(ABORT, 'Customer inquiry violates anti-spam link rule');
    END;
  `);

  // Generate real playable seed audio files
  createAmbientWav(path.join(SEED_MEDIA_DIR, 'midnight_voice_note.wav'), [220, 277.18, 329.63], 4);
  createAmbientWav(path.join(SEED_MEDIA_DIR, 'studio_warmth_session.wav'), [196, 246.94, 293.66], 5);

  // Ensure reports.case_id & target_type ('group') exist on older DBs and backfill
  const reportCols = db.prepare('PRAGMA table_info(reports)').all() as { name: string }[];
  if (!reportCols.some((c) => c.name === 'case_id')) {
    db.exec("ALTER TABLE reports ADD COLUMN case_id TEXT NOT NULL DEFAULT ''");
  }
  const reportsSqlRow = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'reports'")
    .get() as { sql: string } | undefined;
  if (reportsSqlRow && (!reportsSqlRow.sql.includes("'group'") || !reportsSqlRow.sql.includes("'circle_post'"))) {
    db.pragma('foreign_keys = OFF');
    db.exec(`
      BEGIN TRANSACTION;
      CREATE TABLE reports_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        case_id TEXT NOT NULL DEFAULT '',
        reporter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        target_type TEXT NOT NULL CHECK (target_type IN ('post', 'video', 'user', 'group', 'circle_post')),
        target_id INTEGER NOT NULL,
        reason TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved', 'dismissed')),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO reports_new (id, case_id, reporter_id, target_type, target_id, reason, status, created_at)
      SELECT id, case_id, reporter_id, target_type, target_id, reason, status, created_at FROM reports;
      DROP TABLE reports;
      ALTER TABLE reports_new RENAME TO reports;
      COMMIT;
    `);
    db.pragma('foreign_keys = ON');
  }
  db.exec(
    "UPDATE reports SET case_id = 'HTV-CASE-' || printf('%06d', 100000 + id) WHERE case_id = ''"
  );

  // Idempotent migrations for conversations, conversation_members, and messages
  const convCols = db.prepare('PRAGMA table_info(conversations)').all() as { name: string }[];
  if (!convCols.some((c) => c.name === 'join_mode')) {
    db.exec("ALTER TABLE conversations ADD COLUMN join_mode TEXT NOT NULL DEFAULT 'direct'");
  }
  if (!convCols.some((c) => c.name === 'invite_code')) {
    db.exec("ALTER TABLE conversations ADD COLUMN invite_code TEXT NOT NULL DEFAULT ''");
  }
  if (!convCols.some((c) => c.name === 'max_video_mb')) {
    db.exec('ALTER TABLE conversations ADD COLUMN max_video_mb INTEGER NOT NULL DEFAULT 25');
  }

  const convMemCols = db.prepare('PRAGMA table_info(conversation_members)').all() as { name: string }[];
  if (!convMemCols.some((c) => c.name === 'is_muted')) {
    db.exec('ALTER TABLE conversation_members ADD COLUMN is_muted INTEGER NOT NULL DEFAULT 0');
  }
  if (!convMemCols.some((c) => c.name === 'is_chat_muted')) {
    db.exec('ALTER TABLE conversation_members ADD COLUMN is_chat_muted INTEGER NOT NULL DEFAULT 0');
  }
  if (!convMemCols.some((c) => c.name === 'chat_muted_until')) {
    db.exec("ALTER TABLE conversation_members ADD COLUMN chat_muted_until TEXT NOT NULL DEFAULT ''");
  }

  const postCols = db.prepare('PRAGMA table_info(posts)').all() as { name: string }[];
  if (!postCols.some((c) => c.name === 'views_count')) {
    db.exec('ALTER TABLE posts ADD COLUMN views_count INTEGER NOT NULL DEFAULT 0');
  }
  if (!postCols.some((c) => c.name === 'is_boosted')) {
    db.exec('ALTER TABLE posts ADD COLUMN is_boosted INTEGER NOT NULL DEFAULT 0');
    db.exec('UPDATE posts SET is_boosted = 1 WHERE id = (SELECT MIN(id) FROM posts)');
  }
  if (!postCols.some((c) => c.name === 'circle_id')) {
    db.exec('ALTER TABLE posts ADD COLUMN circle_id INTEGER REFERENCES circles(id) ON DELETE CASCADE');
  }
  if (!postCols.some((c) => c.name === 'circle_post_id')) {
    db.exec('ALTER TABLE posts ADD COLUMN circle_post_id INTEGER REFERENCES circle_posts(id) ON DELETE CASCADE');
  }
  if (!postCols.some((c) => c.name === 'is_global')) {
    db.exec('ALTER TABLE posts ADD COLUMN is_global INTEGER NOT NULL DEFAULT 1');
  }

  const circlePostCols = db.prepare('PRAGMA table_info(circle_posts)').all() as { name: string }[];
  if (!circlePostCols.some((c) => c.name === 'is_global')) {
    db.exec('ALTER TABLE circle_posts ADD COLUMN is_global INTEGER NOT NULL DEFAULT 1');
  }
  if (!circlePostCols.some((c) => c.name === 'global_post_id')) {
    db.exec('ALTER TABLE circle_posts ADD COLUMN global_post_id INTEGER');
  }
  if (!circlePostCols.some((c) => c.name === 'delivered_count')) {
    db.exec('ALTER TABLE circle_posts ADD COLUMN delivered_count INTEGER NOT NULL DEFAULT 0');
  }

  const autoCols = db.prepare('PRAGMA table_info(circle_automation_settings)').all() as { name: string }[];
  if (!autoCols.some((c) => c.name === 'auto_inquiry_reply_enabled')) {
    db.exec('ALTER TABLE circle_automation_settings ADD COLUMN auto_inquiry_reply_enabled INTEGER NOT NULL DEFAULT 1');
  }
  if (!autoCols.some((c) => c.name === 'auto_inquiry_reply_message')) {
    db.exec("ALTER TABLE circle_automation_settings ADD COLUMN auto_inquiry_reply_message TEXT NOT NULL DEFAULT ''");
  }

  const postViewCols = db.prepare('PRAGMA table_info(post_views)').all() as { name: string }[];
  if (postViewCols.some((c) => c.name === 'session_id')) {
    db.exec(`
      BEGIN TRANSACTION;
      CREATE TABLE post_views_unique (
        post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (post_id, user_id)
      );
      INSERT OR IGNORE INTO post_views_unique (post_id, user_id, created_at)
      SELECT post_id, user_id, MIN(created_at) FROM post_views GROUP BY post_id, user_id;
      DROP TABLE post_views;
      ALTER TABLE post_views_unique RENAME TO post_views;
      UPDATE posts SET views_count = (
        SELECT COUNT(*) FROM post_views WHERE post_views.post_id = posts.id
      );
      COMMIT;
    `);
  }

  const msgCols = db.prepare('PRAGMA table_info(messages)').all() as { name: string }[];
  if (!msgCols.some((c) => c.name === 'media_size_bytes')) {
    db.exec('ALTER TABLE messages ADD COLUMN media_size_bytes INTEGER NOT NULL DEFAULT 0');
  }
  if (!msgCols.some((c) => c.name === 'is_forwarded')) {
    db.exec('ALTER TABLE messages ADD COLUMN is_forwarded INTEGER NOT NULL DEFAULT 0');
  }
  if (!msgCols.some((c) => c.name === 'forwarded_from_name')) {
    db.exec("ALTER TABLE messages ADD COLUMN forwarded_from_name TEXT NOT NULL DEFAULT ''");
  }

  // Enforce fixed 50 MB upper cap on existing group conversations
  db.exec('UPDATE conversations SET max_video_mb = 50 WHERE max_video_mb > 50');

  // Backfill invite codes for any group conversations lacking one
  const groupsWithoutCode = db
    .prepare("SELECT id FROM conversations WHERE type = 'group' AND (invite_code IS NULL OR invite_code = '')")
    .all() as { id: number }[];
  for (const g of groupsWithoutCode) {
    const code = `htv-grp-${g.id}-${Math.random().toString(36).slice(2, 6)}`;
    db.prepare('UPDATE conversations SET invite_code = ? WHERE id = ?').run(code, g.id);
  }

  const userCount = (db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number }).count;
  if (userCount > 0) {
    seedCirclesIfEmpty();
    syncExistingCirclePostsToGlobalFeed();
    seedDefaultAutomationForExistingCircles();
    return;
  }

  const adminHash = bcrypt.hashSync('Admin@1234', 10);
  const memberHash = bcrypt.hashSync('Member@1234', 10);

  const insertUser = db.prepare(`
    INSERT INTO users (name, username, email, password_hash, role, is_verified, avatar_url, cover_url, bio, facebook_link, theme)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const nadiaId = insertUser.run(
    'Nadia Rahman',
    'nadia_host',
    'admin@hushtalkvoice.local',
    adminHash,
    'admin',
    1,
    '/src/assets/images/avatar_nadia_1794997822171.jpg',
    '/src/assets/images/cover_studio_1794997822111.jpg',
    'Community Steward & Podcast Host on HushTalkVoice. Building safe voice-first spaces.',
    'https://facebook.com/nadia.rahman.host',
    'night'
  ).lastInsertRowid as number;

  const ariaId = insertUser.run(
    'Aria Chowdhury',
    'aria_voice',
    'aria@hushtalkvoice.local',
    memberHash,
    'member',
    1,
    '/src/assets/images/avatar_aria_1794997821348.jpg',
    '/src/assets/images/cover_studio_1794997822111.jpg',
    'Late-night acoustic storyteller and sound designer. Always open for voice notes.',
    'https://facebook.com/aria.chowdhury.audio',
    'night'
  ).lastInsertRowid as number;

  const rafiId = insertUser.run(
    'Rafi Hasan',
    'rafi_studio',
    'rafi@hushtalkvoice.local',
    memberHash,
    'member',
    1,
    '/src/assets/images/avatar_rafi_1794997821103.jpg',
    '/src/assets/images/video_thumb_podcast_1794997823166.jpg',
    'Audio producer mixing warm vocal textures and independent community broadcasts.',
    '',
    'system'
  ).lastInsertRowid as number;

  const tariqId = insertUser.run(
    'Tariq Ahmed',
    'tariq_beats',
    'tariq@hushtalkvoice.local',
    memberHash,
    'member',
    0,
    '/src/assets/images/avatar_rafi_1794997821103.jpg',
    '/src/assets/images/cover_studio_1794997822111.jpg',
    'Sound engineer exploring field recordings and community voice rooms.',
    '',
    'day'
  ).lastInsertRowid as number;

  const sadiaId = insertUser.run(
    'Sadia Karim',
    'sadia_talk',
    'sadia@hushtalkvoice.local',
    memberHash,
    'member',
    0,
    '/src/assets/images/avatar_aria_1794997821348.jpg',
    '/src/assets/images/video_thumb_podcast_1794997823166.jpg',
    'Community listener, book club moderator, and midnight radio enthusiast.',
    '',
    'night'
  ).lastInsertRowid as number;

  // Follows
  const insertFollow = db.prepare('INSERT OR IGNORE INTO follows (follower_id, following_id) VALUES (?, ?)');
  insertFollow.run(ariaId, nadiaId);
  insertFollow.run(ariaId, rafiId);
  insertFollow.run(rafiId, ariaId);
  insertFollow.run(nadiaId, ariaId);
  insertFollow.run(nadiaId, rafiId);
  insertFollow.run(tariqId, ariaId);
  insertFollow.run(sadiaId, nadiaId);

  // Connections (accepted + pending requests)
  const insertConn = db.prepare('INSERT INTO connections (requester_id, receiver_id, status) VALUES (?, ?, ?)');
  insertConn.run(ariaId, rafiId, 'accepted');
  insertConn.run(nadiaId, ariaId, 'accepted');
  insertConn.run(tariqId, ariaId, 'pending');
  insertConn.run(sadiaId, nadiaId, 'pending');

  // Seed Posts
  const insertPost = db.prepare(
    'INSERT INTO posts (user_id, content, media_type, media_url, created_at) VALUES (?, ?, ?, ?, ?)'
  );
  const p1 = insertPost.run(
    nadiaId,
    'Welcome to the refreshed HushTalkVoice! Every conversation here stays link-free, distraction-free, and open to all community members.',
    'image',
    '/src/assets/images/cover_studio_1794997822111.jpg',
    "2026-11-18 01:15:00"
  ).lastInsertRowid as number;

  const p2 = insertPost.run(
    ariaId,
    'Recorded a quick midnight harmonic test right from the desk. Drop a voice note or reply below with your evening studio check-in.',
    'audio',
    '/uploads/seed/midnight_voice_note.wav',
    "2026-11-18 01:45:00"
  ).lastInsertRowid as number;

  const p3 = insertPost.run(
    rafiId,
    'Testing warm compressor settings for tonight’s storytelling session. Remember: no external links, just pure voice, gallery moments, and honest community talk.',
    'none',
    '',
    "2026-11-18 02:10:00"
  ).lastInsertRowid as number;

  db.prepare('INSERT INTO post_likes (post_id, user_id) VALUES (?, ?)').run(p1, ariaId);
  db.prepare('INSERT INTO post_likes (post_id, user_id) VALUES (?, ?)').run(p1, rafiId);
  db.prepare('INSERT INTO post_likes (post_id, user_id) VALUES (?, ?)').run(p2, nadiaId);
  db.prepare('INSERT INTO post_likes (post_id, user_id) VALUES (?, ?)').run(p2, rafiId);
  db.prepare('INSERT INTO post_likes (post_id, user_id) VALUES (?, ?)').run(p3, ariaId);

  db.prepare('INSERT INTO post_comments (post_id, user_id, content) VALUES (?, ?, ?)').run(
    p1,
    ariaId,
    'Love how calm and fast the new Midnight Purple layout feels!'
  );
  db.prepare('INSERT INTO post_comments (post_id, user_id, content) VALUES (?, ?, ?)').run(
    p2,
    rafiId,
    'That chord warmth came through super crisp.'
  );

  // Seed Community Videos (approved + pending)
  const insertVideo = db.prepare(`
    INSERT INTO videos (uploader_id, title, description, video_url, thumbnail_url, duration_seconds, status, views_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const v1 = insertVideo.run(
    nadiaId,
    'Midnight Acoustic Lounge — Episode 01',
    'An open community showcase exploring voice storytelling, room acoustics, and calm late-night discussions.',
    '/uploads/seed/studio_warmth_session.wav',
    '/src/assets/images/video_thumb_podcast_1794997823166.jpg',
    245,
    'approved',
    318
  ).lastInsertRowid as number;

  insertVideo.run(
    rafiId,
    'Studio Mic Placement for Warm Vocals',
    'Step-by-step demonstration on eliminating desk resonance and capturing intimate broadcast clarity.',
    '/uploads/seed/midnight_voice_note.wav',
    '/src/assets/images/cover_studio_1794997822111.jpg',
    192,
    'approved',
    184
  );

  insertVideo.run(
    tariqId,
    'Field Recording Walk Through Old Dhaka',
    'Ambient rain and evening street soundscape waiting for moderator approval.',
    '/uploads/seed/studio_warmth_session.wav',
    '/src/assets/images/cover_studio_1794997822111.jpg',
    160,
    'pending',
    0
  );

  db.prepare('INSERT INTO video_likes (video_id, user_id) VALUES (?, ?)').run(v1, ariaId);
  db.prepare('INSERT INTO video_likes (video_id, user_id) VALUES (?, ?)').run(v1, rafiId);

  // Seed Conversations (Direct + Group)
  const insertConv = db.prepare(`
    INSERT INTO conversations (type, name, avatar_url, created_by, status, requester_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const directConvId = insertConv.run('direct', '', '', ariaId, 'active', ariaId).lastInsertRowid as number;
  const groupConvId = insertConv.run(
    'group',
    'HushTalk Creators Lounge',
    '/src/assets/images/cover_studio_1794997822111.jpg',
    nadiaId,
    'active',
    nadiaId
  ).lastInsertRowid as number;
  const reqConvId = insertConv.run('direct', '', '', sadiaId, 'pending_request', sadiaId).lastInsertRowid as number;

  const insertMember = db.prepare(
    'INSERT INTO conversation_members (conversation_id, user_id, role) VALUES (?, ?, ?)'
  );
  insertMember.run(directConvId, ariaId, 'member');
  insertMember.run(directConvId, rafiId, 'member');

  insertMember.run(groupConvId, nadiaId, 'admin');
  insertMember.run(groupConvId, ariaId, 'member');
  insertMember.run(groupConvId, rafiId, 'member');
  insertMember.run(groupConvId, tariqId, 'member');

  insertMember.run(reqConvId, sadiaId, 'member');
  insertMember.run(reqConvId, ariaId, 'member');

  const insertMsg = db.prepare(`
    INSERT INTO messages (conversation_id, sender_id, content, media_type, media_url)
    VALUES (?, ?, ?, ?, ?)
  `);
  const m1 = insertMsg.run(
    directConvId,
    rafiId,
    'Hey Aria, ready for tonight’s soundcheck? Drop a quick voice note when you have a minute.',
    'none',
    ''
  ).lastInsertRowid as number;
  insertMsg.run(
    directConvId,
    ariaId,
    'Just finished tuning the mic! Here is the harmonic clip.',
    'audio',
    '/uploads/seed/midnight_voice_note.wav'
  );
  insertMsg.run(
    groupConvId,
    nadiaId,
    'Welcome everyone to the Creators Lounge group! Up to 500 members can collaborate here with text, gallery images, audio, and video.',
    'none',
    ''
  );
  insertMsg.run(
    reqConvId,
    sadiaId,
    'Hi Aria! Loved your latest audio post on the feed. Would love to connect.',
    'none',
    ''
  );

  db.prepare('INSERT INTO message_reactions (message_id, user_id, emoji) VALUES (?, ?, ?)').run(m1, ariaId, '❤️');

  // Seed Notifications
  const insertNotif = db.prepare(`
    INSERT INTO notifications (user_id, actor_id, type, reference_id, message)
    VALUES (?, ?, ?, ?, ?)
  `);
  insertNotif.run(ariaId, tariqId, 'connection_request', tariqId, 'Tariq Ahmed sent you a connection request');
  insertNotif.run(ariaId, rafiId, 'comment', p2, 'Rafi Hasan commented on your post');
  insertNotif.run(nadiaId, sadiaId, 'connection_request', sadiaId, 'Sadia Karim sent you a connection request');

  // Mark welcome post as Spotlight boosted
  db.prepare('UPDATE posts SET is_boosted = 1 WHERE id = ?').run(p1);

  seedCirclesIfEmpty();
}

function seedCirclesIfEmpty(): void {
  const circleCount = (db.prepare('SELECT COUNT(*) as count FROM circles').get() as { count: number }).count;
  if (circleCount > 0) return;

  const nadia = db.prepare('SELECT id FROM users WHERE username = ?').get('nadia_host') as { id: number } | undefined;
  const aria = db.prepare('SELECT id FROM users WHERE username = ?').get('aria_voice') as { id: number } | undefined;
  const rafi = db.prepare('SELECT id FROM users WHERE username = ?').get('rafi_studio') as { id: number } | undefined;
  const tariq = db.prepare('SELECT id FROM users WHERE username = ?').get('tariq_beats') as { id: number } | undefined;
  if (!nadia || !aria) return;

  const insertCircle = db.prepare(
    'INSERT INTO circles (name, category, description, avatar_url, privacy, require_post_approval, invite_code, owner_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const c1 = insertCircle.run(
    'Acoustic & Studio Craft',
    'Audio & Gear',
    'Open community circle for mic setups, room acoustics, and late-night vocal chain tips.',
    '/src/assets/images/cover_studio_1794997822111.jpg',
    'public',
    0,
    'htv-cir-acoustic1',
    nadia.id
  ).lastInsertRowid as number;

  const c2 = insertCircle.run(
    'Midnight Storytellers',
    'Podcasting & Voice',
    'Private creator circle with curated post approval for pilot episodes, vocal feedback, and narrative craft.',
    '/src/assets/images/video_thumb_podcast_1794997823166.jpg',
    'private',
    1,
    'htv-cir-midnight2',
    aria.id
  ).lastInsertRowid as number;

  const addMember = db.prepare(
    'INSERT OR IGNORE INTO circle_members (circle_id, user_id, role) VALUES (?, ?, ?)'
  );
  addMember.run(c1, nadia.id, 'owner');
  addMember.run(c1, aria.id, 'admin');
  if (rafi) addMember.run(c1, rafi.id, 'moderator');
  if (tariq) addMember.run(c1, tariq.id, 'member');

  addMember.run(c2, aria.id, 'owner');
  addMember.run(c2, nadia.id, 'admin');
  if (rafi) addMember.run(c2, rafi.id, 'member');

  const insertCirclePost = db.prepare(
    'INSERT INTO circle_posts (circle_id, user_id, content, media_type, media_url, status, views_count) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  const cp1 = insertCirclePost.run(
    c1,
    nadia.id,
    'Welcome to the Acoustic & Studio Craft Circle! Share your desk mic placement photos and room tips below.',
    'image',
    '/src/assets/images/cover_studio_1794997822111.jpg',
    'approved',
    18
  ).lastInsertRowid as number;

  if (rafi) {
    insertCirclePost.run(
      c1,
      rafi.id,
      'Quick tip: placing two broadband panels just behind your monitor speakers clears up muddy low-mids right away.',
      'none',
      '',
      'approved',
      9
    );
  }

  insertCirclePost.run(
    c2,
    aria.id,
    'Welcome to Midnight Storytellers! Drop your episode pacing notes or cover art drafts for community feedback.',
    'image',
    '/src/assets/images/video_thumb_podcast_1794997823166.jpg',
    'approved',
    12
  );

  if (rafi) {
    insertCirclePost.run(
      c2,
      rafi.id,
      'Drafting a three-part late-night documentary script — looking forward to approval and feedback from Circle admins.',
      'none',
      '',
      'pending',
      0
    );
  }

  db.prepare('INSERT OR IGNORE INTO circle_post_likes (post_id, user_id) VALUES (?, ?)').run(cp1, aria.id);
  db.prepare('INSERT INTO circle_post_comments (post_id, user_id, content) VALUES (?, ?, ?)').run(
    cp1,
    aria.id,
    'Super helpful setup reference for weekend sessions!'
  );

  seedDefaultAutomationForCircle(c1);
  syncExistingCirclePostsToGlobalFeed();
}

function seedDefaultAutomationForCircle(circleId: number): void {
  const defaultWelcome =
    'Welcome to {{circle}}, {{name}}! Reply here anytime if you need gear advice, studio pricing, or session availability.';
  const defaultInquiryReply =
    'Hi {{name}}! Thanks for messaging {{circle}}. Our team has received your inquiry and will reply with details shortly.';

  const existingSettings = db
    .prepare(
      'SELECT circle_id, auto_welcome_message, auto_inquiry_reply_message FROM circle_automation_settings WHERE circle_id = ?'
    )
    .get(circleId) as
    | { circle_id: number; auto_welcome_message: string; auto_inquiry_reply_message?: string }
    | undefined;

  if (!existingSettings) {
    db.prepare(
      `INSERT OR IGNORE INTO circle_automation_settings
       (circle_id, auto_welcome_enabled, auto_welcome_message, auto_inquiry_reply_enabled, auto_inquiry_reply_message, auto_approve_verified, auto_keyword_reply_enabled)
       VALUES (?, 1, ?, 1, ?, 0, 1)`
    ).run(circleId, defaultWelcome, defaultInquiryReply);
  } else {
    if (!existingSettings.auto_welcome_message) {
      db.prepare(
        `UPDATE circle_automation_settings
         SET auto_welcome_enabled = 1,
             auto_welcome_message = ?
         WHERE circle_id = ? AND auto_welcome_message = ''`
      ).run(defaultWelcome, circleId);
    }
    if (!existingSettings.auto_inquiry_reply_message) {
      db.prepare(
        `UPDATE circle_automation_settings
         SET auto_inquiry_reply_enabled = 1,
             auto_inquiry_reply_message = ?
         WHERE circle_id = ? AND auto_inquiry_reply_message = ''`
      ).run(defaultInquiryReply, circleId);
    }
  }

  const ruleCount = (
    db.prepare('SELECT COUNT(*) as c FROM circle_keyword_rules WHERE circle_id = ?').get(circleId) as { c: number }
  ).c;
  if (ruleCount === 0) {
    db.prepare(
      'INSERT INTO circle_keyword_rules (circle_id, keyword, reply_text, create_inquiry) VALUES (?, ?, ?, ?)'
    ).run(
      circleId,
      'price',
      'Thanks for asking! Our studio consultation and acoustic setup packages start cleanly via direct message — tap Quick Inquiry to get a custom quote.',
      1
    );
  }

  const replyCount = (
    db.prepare('SELECT COUNT(*) as c FROM circle_quick_replies WHERE circle_id = ?').get(circleId) as { c: number }
  ).c;
  if (replyCount === 0) {
    db.prepare(
      'INSERT INTO circle_quick_replies (circle_id, title, content) VALUES (?, ?, ?)'
    ).run(
      circleId,
      'Studio Pricing & Booking',
      'Hi! Thanks for reaching out to Acoustic & Studio Craft. Share your room size or mic goals here and we will send our package details right away.'
    );
    db.prepare(
      'INSERT INTO circle_quick_replies (circle_id, title, content) VALUES (?, ?, ?)'
    ).run(
      circleId,
      'Order Follow-Up',
      'Your request has been received by our team! We are checking availability and will confirm your slot shortly.'
    );
  }
}

function seedDefaultAutomationForExistingCircles(): void {
  const pubCircle = db
    .prepare("SELECT id FROM circles WHERE privacy = 'public' ORDER BY id ASC LIMIT 1")
    .get() as { id: number } | undefined;
  if (!pubCircle) return;
  const anyRule = db.prepare('SELECT 1 FROM circle_keyword_rules WHERE circle_id = ? LIMIT 1').get(pubCircle.id);
  const anyReply = db.prepare('SELECT 1 FROM circle_quick_replies WHERE circle_id = ? LIMIT 1').get(pubCircle.id);
  if (!anyRule && !anyReply) {
    seedDefaultAutomationForCircle(pubCircle.id);
  }
}

function syncExistingCirclePostsToGlobalFeed(): void {
  const unlinked = db
    .prepare(
      `SELECT cp.id, cp.circle_id, cp.user_id, cp.content, cp.media_type, cp.media_url, cp.views_count, cp.created_at,
              c.privacy
       FROM circle_posts cp
       JOIN circles c ON c.id = cp.circle_id
       WHERE cp.status = 'approved' AND cp.global_post_id IS NULL`
    )
    .all() as any[];

  if (unlinked.length === 0) return;

  const insertGlobal = db.prepare(
    `INSERT INTO posts (user_id, content, media_type, media_url, views_count, circle_id, circle_post_id, is_global, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const linkGlobal = db.prepare('UPDATE circle_posts SET global_post_id = ?, delivered_count = ? WHERE id = ?');
  const countMembers = db.prepare('SELECT COUNT(*) as c FROM circle_members WHERE circle_id = ?');

  const tx = db.transaction(() => {
    for (const row of unlinked) {
      const isGlobal = row.privacy === 'public' ? 1 : 0;
      const res = insertGlobal.run(
        row.user_id,
        row.content,
        row.media_type,
        row.media_url,
        row.views_count || 0,
        row.circle_id,
        row.id,
        isGlobal,
        row.created_at
      );
      const memberCount = (countMembers.get(row.circle_id) as { c: number }).c;
      linkGlobal.run(Number(res.lastInsertRowid), Math.max(0, memberCount - 1), row.id);
    }
  });
  tx();
}


