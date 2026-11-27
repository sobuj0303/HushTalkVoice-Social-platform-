-- Supabase / PostgreSQL Indexing Migration for HushTalkVoice
-- Target tables: circle_posts (or circles_posts if renamed in Supabase) & connections
-- Safe for live production execution using CONCURRENTLY + IF NOT EXISTS.

-- 1. Partial covering index for aggregated Circles feed & per-Circle feed pagination:
-- Filters out unapproved/pending posts at index level and pre-sorts by created_at DESC, id DESC.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_circle_posts_approved_feed
  ON circle_posts (circle_id, created_at DESC, id DESC)
  WHERE status = 'approved';

-- 2. Author moderation & profile activity lookups inside Circles:
-- Accelerates queries filtering posts by a specific author and status.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_circle_posts_user_status_created
  ON circle_posts (user_id, status, created_at DESC);

-- 3. Global Circle post discovery & chronological feed fallback:
-- Speeds up scanning approved global posts without touching unapproved/pending rows.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_circle_posts_global_approved
  ON circle_posts (created_at DESC, id DESC)
  WHERE status = 'approved' AND is_global = TRUE;

-- 4. Bidirectional Connection lookup (requester -> receiver):
-- Accelerates checking accepted friends and requester-side connection filtering in HomeFeed.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_connections_status_requester
  ON connections (status, requester_id, receiver_id);

-- 5. Bidirectional Connection lookup (receiver -> requester):
-- Eliminates full scans on OR (requester_id = $1 OR receiver_id = $1) and pending friend request queues.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_connections_status_receiver
  ON connections (status, receiver_id, requester_id);
