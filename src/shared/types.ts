export type ThemeMode = 'day' | 'night' | 'system';
export type UserRole = 'member' | 'admin';

export interface PrivacySettings {
  profile_visibility: 'public' | 'private';
  followers_visibility: 'public' | 'private';
  following_visibility: 'public' | 'private';
  facebook_visibility: 'public' | 'private';
  online_status_visibility: 'everyone' | 'nobody';
  who_can_message: 'everyone' | 'connections';
}

export interface UserSummary {
  id: number;
  name: string;
  username: string;
  avatar_url: string;
  role: UserRole;
  is_verified: boolean;
  is_blocked?: boolean;
  is_online?: boolean;
  bio?: string;
}

export interface AuthUser extends UserSummary {
  email: string;
  cover_url: string;
  facebook_link: string;
  theme: ThemeMode;
  privacy: PrivacySettings;
  followers_count: number;
  following_count: number;
  created_at: string;
}

export interface PersonDirectoryItem extends UserSummary {
  followers_count: number;
  following_count: number;
  is_following: boolean;
  connection_status: 'none' | 'pending_sent' | 'pending_received' | 'accepted';
  connection_id?: number;
  can_view_profile: boolean;
}

export interface PostComment {
  id: number;
  post_id: number;
  user_id: number;
  author_name: string;
  author_username: string;
  author_avatar: string;
  author_verified: boolean;
  content: string;
  created_at: string;
}

export interface PostItem {
  id: number;
  user_id: number;
  author_name: string;
  author_username: string;
  author_avatar: string;
  author_verified: boolean;
  content: string;
  media_type: 'none' | 'image' | 'audio' | 'video';
  media_url: string;
  likes_count: number;
  comments_count: number;
  shares_count: number;
  views_count: number;
  has_viewed?: boolean;
  is_liked: boolean;
  is_boosted?: boolean;
  is_spotlight?: boolean;
  circle_id?: number | null;
  circle_post_id?: number | null;
  circle_name?: string;
  circle_category?: string;
  circle_privacy?: CirclePrivacy;
  circle_avatar?: string;
  circle_is_member?: boolean;
  circle_viewer_role?: CircleRole | null;
  comments: PostComment[];
  created_at: string;
}

export interface ConversationMember {
  user_id: number;
  name: string;
  username: string;
  avatar_url: string;
  is_verified: boolean;
  is_online: boolean;
  role: 'admin' | 'member';
  is_chat_muted?: boolean;
  chat_muted_until?: string;
}

export interface GroupJoinRequest {
  id: number;
  conversation_id: number;
  user_id: number;
  name: string;
  username: string;
  avatar_url: string;
  is_verified: boolean;
  invited_by_name?: string | null;
  follows_admin: boolean;
  is_friend_with_admin: boolean;
  created_at: string;
}

export interface GroupCandidateItem {
  id: number;
  name: string;
  username: string;
  avatar_url: string;
  is_verified: boolean;
  is_online: boolean;
  follows_admin: boolean;
  is_friend_with_actor_or_admin: boolean;
  eligible: boolean;
  already_member: boolean;
  pending_request: boolean;
}

export interface MessageReaction {
  emoji: string;
  count: number;
  user_reacted: boolean;
}

export interface ChatMessage {
  id: number;
  conversation_id: number;
  sender_id: number;
  sender_name: string;
  sender_username: string;
  sender_avatar: string;
  sender_verified: boolean;
  content: string;
  media_type: 'none' | 'image' | 'audio' | 'video';
  media_url: string;
  media_size_bytes?: number;
  reply_to_id: number | null;
  reply_preview?: {
    id: number;
    sender_name: string;
    content: string;
    media_type: string;
    is_unsent: boolean;
  } | null;
  is_unsent: boolean;
  is_forwarded?: boolean;
  forwarded_from_name?: string;
  reactions: MessageReaction[];
  seen_by_count: number;
  created_at: string;
}

export interface ConversationItem {
  id: number;
  type: 'direct' | 'group';
  name: string;
  avatar_url: string;
  created_by: number;
  status: 'active' | 'pending_request' | 'rejected';
  requester_id: number | null;
  join_mode?: 'direct' | 'approval';
  invite_code?: string;
  max_video_mb?: number;
  is_muted?: boolean;
  viewer_chat_muted?: boolean;
  viewer_chat_muted_until?: string;
  member_count: number;
  unread_count: number;
  last_message: {
    content: string;
    media_type: string;
    sender_name: string;
    created_at: string;
    is_unsent: boolean;
  } | null;
  other_user?: UserSummary | null;
  members?: ConversationMember[];
  pending_join_requests?: GroupJoinRequest[];
  updated_at: string;
}

export interface VideoComment {
  id: number;
  video_id: number;
  user_id: number;
  author_name: string;
  author_username: string;
  author_avatar: string;
  author_verified: boolean;
  content: string;
  created_at: string;
}

export interface CommunityVideo {
  id: number;
  uploader_id: number;
  uploader_name: string;
  uploader_username: string;
  uploader_avatar: string;
  uploader_verified: boolean;
  title: string;
  description: string;
  video_url: string;
  thumbnail_url: string;
  duration_seconds: number;
  status: 'pending' | 'approved' | 'rejected';
  views_count: number;
  likes_count: number;
  loves_count?: number;
  comments_count: number;
  is_liked: boolean;
  is_loved?: boolean;
  created_at: string;
}

export interface NotificationItem {
  id: number;
  type: string;
  reference_id: number | null;
  message: string;
  is_read: boolean;
  actor_name: string;
  actor_username: string;
  actor_avatar: string;
  created_at: string;
}

export interface AdminReportItem {
  id: number;
  case_id: string;
  reporter_name: string;
  reporter_username: string;
  target_type: 'post' | 'video' | 'user' | 'group' | 'circle_post';
  target_id: number;
  target_username?: string;
  target_summary: string;
  reason: string;
  status: 'pending' | 'resolved' | 'dismissed';
  created_at: string;
}

export type CircleRole = 'owner' | 'admin' | 'moderator' | 'member';
export type CirclePrivacy = 'public' | 'private';

export interface CircleItem {
  id: number;
  name: string;
  category: string;
  description: string;
  avatar_url: string;
  privacy: CirclePrivacy;
  require_post_approval: boolean;
  invite_code: string;
  owner_id: number;
  owner_name: string;
  owner_username: string;
  viewer_role: CircleRole | null;
  is_member: boolean;
  pending_request: boolean;
  member_count: number;
  post_count: number;
  pending_posts_count?: number;
  pending_requests_count?: number;
  created_at: string;
}

export interface CircleMemberItem {
  user_id: number;
  name: string;
  username: string;
  avatar_url: string;
  is_verified: boolean;
  is_online: boolean;
  role: CircleRole;
  joined_at: string;
}

export interface CircleFollowRequestItem {
  id: number;
  circle_id: number;
  user_id: number;
  name: string;
  username: string;
  avatar_url: string;
  is_verified: boolean;
  created_at: string;
}

export interface CirclePostComment {
  id: number;
  post_id: number;
  user_id: number;
  author_name: string;
  author_username: string;
  author_avatar: string;
  author_verified: boolean;
  content: string;
  created_at: string;
}

export interface CirclePostItem {
  id: number;
  circle_id: number;
  user_id: number;
  author_name: string;
  author_username: string;
  author_avatar: string;
  author_verified: boolean;
  content: string;
  media_type: 'none' | 'image';
  media_url: string;
  status: 'approved' | 'pending' | 'rejected';
  likes_count: number;
  comments_count: number;
  shares_count: number;
  views_count: number;
  has_viewed?: boolean;
  is_liked: boolean;
  is_global?: boolean;
  global_post_id?: number | null;
  delivered_count?: number;
  comments: CirclePostComment[];
  created_at: string;
}

export interface CircleAutomationSettings {
  circle_id: number;
  auto_welcome_enabled: boolean;
  auto_welcome_message: string;
  auto_inquiry_reply_enabled: boolean;
  auto_inquiry_reply_message: string;
  auto_approve_verified: boolean;
  auto_keyword_reply_enabled: boolean;
  last_broadcast_at: string;
}

export interface CircleKeywordRule {
  id: number;
  circle_id: number;
  keyword: string;
  reply_text: string;
  create_inquiry: boolean;
  hit_count: number;
  created_at: string;
}

export interface CircleQuickReply {
  id: number;
  circle_id: number;
  title: string;
  content: string;
  usage_count: number;
  created_at: string;
}

export type CircleInquiryStatus = 'new' | 'in_progress' | 'resolved';

export interface CircleInquiryItem {
  id: number;
  circle_id: number;
  customer_id: number;
  customer_name: string;
  customer_username: string;
  customer_avatar: string;
  customer_verified: boolean;
  source: 'direct' | 'comment_keyword' | 'post_cta';
  post_id: number | null;
  conversation_id: number | null;
  message: string;
  status: CircleInquiryStatus;
  last_reply: string;
  handled_by_name?: string;
  created_at: string;
  updated_at: string;
}

export interface CircleAutomationPayload {
  settings: CircleAutomationSettings;
  keyword_rules: CircleKeywordRule[];
  quick_replies: CircleQuickReply[];
  inquiries: CircleInquiryItem[];
  stats: {
    total_reach: number;
    followers_count: number;
    new_inquiries: number;
    resolved_inquiries: number;
    auto_replies_sent: number;
  };
}

export interface GlobalSearchResults {
  people: {
    id: number;
    name: string;
    username: string;
    avatar_url: string;
    is_verified: boolean;
    bio: string;
  }[];
  posts: {
    id: number;
    user_id: number;
    content: string;
    media_type: string;
    created_at: string;
    author_name: string;
    author_username: string;
    author_avatar: string;
    author_verified: boolean;
  }[];
  circles: {
    id: number;
    name: string;
    category: string;
    description: string;
    avatar_url: string;
    privacy: CirclePrivacy;
    member_count: number;
  }[];
}



