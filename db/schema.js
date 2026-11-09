import {sql} from 'drizzle-orm';
import {sqliteTable, text, integer, index, unique, check} from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
  id: text('id').primaryKey().notNull(),
  name: text('name').notNull(),
  code: text('code').unique().notNull(),
  createdAt: text('created_at').notNull()
});

export const mapStates = sqliteTable('map_states', {
  userId: text('user_id').primaryKey().notNull().references(() => users.id, {onDelete: 'cascade'}),
  stateJson: text('state_json'),
  revision: integer('revision').notNull().default(0),
  updatedAt: text('updated_at').notNull()
});

export const friendships = sqliteTable('friendships', {
  id: text('id').primaryKey().notNull(),
  senderId: text('sender_id').notNull().references(() => users.id, {onDelete: 'cascade'}),
  receiverId: text('receiver_id').notNull().references(() => users.id, {onDelete: 'cascade'}),
  pairA: text('pair_a').notNull().references(() => users.id, {onDelete: 'cascade'}),
  pairB: text('pair_b').notNull().references(() => users.id, {onDelete: 'cascade'}),
  status: text('status').notNull(),
  createdAt: text('created_at').notNull()
}, table => [
  unique('friendships_pair_unique').on(table.pairA, table.pairB),
  check('friendships_status_check', sql`${table.status} IN ('pending','accepted')`),
  check('friendships_distinct_users', sql`${table.senderId} <> ${table.receiverId}`),
  index('friendships_sender').on(table.senderId, table.status),
  index('friendships_receiver').on(table.receiverId, table.status)
]);

export const posts = sqliteTable('posts', {
  id: text('id').primaryKey().notNull(),
  city: text('city').notNull(),
  authorId: text('author_id').notNull().references(() => users.id, {onDelete: 'cascade'}),
  text: text('text').notNull(),
  photoKey: text('photo_key'),
  photoType: text('photo_type'),
  visibility: text('visibility').notNull(),
  createdAt: text('created_at').notNull()
}, table => [
  check('posts_visibility_check', sql`${table.visibility} IN ('public','friends')`),
  index('posts_city_time').on(table.city, sql`${table.createdAt} DESC`),
  index('posts_author_time').on(table.authorId, sql`${table.createdAt} DESC`)
]);

export const comments = sqliteTable('comments', {
  id: text('id').primaryKey().notNull(),
  postId: text('post_id').notNull().references(() => posts.id, {onDelete: 'cascade'}),
  authorId: text('author_id').notNull().references(() => users.id, {onDelete: 'cascade'}),
  text: text('text').notNull(),
  createdAt: text('created_at').notNull()
}, table => [
  index('comments_post_time').on(table.postId, table.createdAt),
  index('comments_author_time').on(table.authorId, table.createdAt)
]);

export const authAccounts = sqliteTable('auth_accounts', {
  id: text('id').primaryKey().notNull(),
  username: text('username').unique().notNull(),
  displayName: text('display_name').notNull(),
  passwordSalt: text('password_salt').notNull(),
  passwordHash: text('password_hash').notNull(),
  recoveryHash: text('recovery_hash').notNull(),
  authVersion: integer('auth_version').notNull().default(1),
  createdAt: integer('created_at').notNull()
});

export const authSessions = sqliteTable('auth_sessions', {
  tokenHash: text('token_hash').primaryKey().notNull(),
  accountId: text('account_id').notNull().references(() => authAccounts.id, {onDelete: 'cascade'}),
  authVersion: integer('auth_version').notNull(),
  createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at').notNull()
}, table => [
  index('auth_sessions_account').on(table.accountId),
  index('auth_sessions_expiry').on(table.expiresAt)
]);

export const authRateLimits = sqliteTable('auth_rate_limits', {
  key: text('key').primaryKey().notNull(),
  windowStarted: integer('window_started').notNull(),
  attempts: integer('attempts').notNull()
}, table => [index('auth_rate_limits_window').on(table.windowStarted)]);
