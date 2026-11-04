PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id TEXT PRIMARY KEY NOT NULL,
  full_name TEXT NOT NULL CHECK (length(trim(full_name)) BETWEEN 1 AND 120),
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  email_verified_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX users_email ON users(email COLLATE NOCASE);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX sessions_user ON sessions(user_id, expires_at);

CREATE TABLE verification_tokens (
  token_hash TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE password_reset_tokens (
  token_hash TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE groups (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE group_members (
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('admin','member')),
  joined_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX group_members_user ON group_members(user_id, group_id);

CREATE TABLE invitations (
  id TEXT PRIMARY KEY NOT NULL,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  email TEXT NOT NULL COLLATE NOCASE,
  invited_by TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected','expired')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(group_id, email)
);

CREATE TABLE expenses (
  id TEXT PRIMARY KEY NOT NULL,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
  total_cents INTEGER NOT NULL CHECK (total_cents > 0),
  paid_by TEXT NOT NULL REFERENCES users(id),
  expense_date TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Other',
  description TEXT,
  split_type TEXT NOT NULL CHECK (split_type IN ('equal','exact','percentage','shares','unequal')),
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX expenses_group_date ON expenses(group_id, expense_date DESC);
CREATE INDEX expenses_creator ON expenses(created_by, created_at DESC);
CREATE TABLE expense_participants (
  expense_id TEXT NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  share_cents INTEGER NOT NULL CHECK (share_cents >= 0),
  paid_at TEXT,
  PRIMARY KEY (expense_id, user_id)
);
CREATE INDEX expense_participants_user ON expense_participants(user_id, expense_id);

CREATE TABLE settlements (
  id TEXT PRIMARY KEY NOT NULL,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  from_user TEXT NOT NULL REFERENCES users(id),
  to_user TEXT NOT NULL REFERENCES users(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  note TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (from_user <> to_user)
);
CREATE INDEX settlements_group_date ON settlements(group_id, created_at DESC);

CREATE TABLE notifications (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  resource_id TEXT,
  read_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX notifications_user_date ON notifications(user_id, created_at DESC);
CREATE TABLE email_logs (
  id TEXT PRIMARY KEY NOT NULL,
  recipient TEXT NOT NULL,
  template TEXT NOT NULL,
  resource_id TEXT,
  provider_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('sent','failed')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(recipient, template, resource_id)
);
CREATE TABLE activity_logs (
  id TEXT PRIMARY KEY NOT NULL,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL REFERENCES users(id),
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX activity_group_date ON activity_logs(group_id, created_at DESC);
