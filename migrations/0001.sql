CREATE TABLE users (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  code TEXT UNIQUE NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE map_states (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  state_json TEXT,
  revision INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE TABLE friendships (
  id TEXT PRIMARY KEY NOT NULL,
  sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  receiver_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pair_a TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pair_b TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('pending','accepted')),
  created_at TEXT NOT NULL,
  UNIQUE(pair_a, pair_b),
  CHECK(sender_id <> receiver_id)
);
CREATE INDEX friendships_sender ON friendships(sender_id, status);
CREATE INDEX friendships_receiver ON friendships(receiver_id, status);
CREATE TABLE posts (
  id TEXT PRIMARY KEY NOT NULL,
  city TEXT NOT NULL,
  author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  photo_key TEXT,
  photo_type TEXT,
  visibility TEXT NOT NULL CHECK(visibility IN ('public','friends')),
  created_at TEXT NOT NULL
);
CREATE INDEX posts_city_time ON posts(city, created_at DESC);
CREATE INDEX posts_author_time ON posts(author_id, created_at DESC);
CREATE TABLE comments (
  id TEXT PRIMARY KEY NOT NULL,
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX comments_post_time ON comments(post_id, created_at);
CREATE INDEX comments_author_time ON comments(author_id, created_at);
CREATE TABLE auth_accounts (
  id TEXT PRIMARY KEY NOT NULL,
  username TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  recovery_hash TEXT NOT NULL,
  auth_version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE TABLE auth_sessions (
  token_hash TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL REFERENCES auth_accounts(id) ON DELETE CASCADE,
  auth_version INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX auth_sessions_account ON auth_sessions(account_id);
CREATE INDEX auth_sessions_expiry ON auth_sessions(expires_at);
CREATE TABLE auth_rate_limits (
  key TEXT PRIMARY KEY NOT NULL,
  window_started INTEGER NOT NULL,
  attempts INTEGER NOT NULL
);
CREATE INDEX auth_rate_limits_window ON auth_rate_limits(window_started);
