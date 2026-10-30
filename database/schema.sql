CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(30) NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS chat_groups (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(40) NOT NULL UNIQUE,
  creator_id BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS group_members (
  group_id BIGINT NOT NULL REFERENCES chat_groups(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (group_id, user_id)
);

CREATE TABLE IF NOT EXISTS private_messages (
  id BIGSERIAL PRIMARY KEY,
  sender_id BIGINT NOT NULL REFERENCES users(id),
  receiver_id BIGINT NOT NULL REFERENCES users(id),
  body TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE private_messages
  ADD COLUMN IF NOT EXISTS room_user_one_id BIGINT REFERENCES users(id);

ALTER TABLE private_messages
  ADD COLUMN IF NOT EXISTS room_user_two_id BIGINT REFERENCES users(id);

UPDATE private_messages
SET room_user_one_id = LEAST(sender_id, receiver_id),
    room_user_two_id = GREATEST(sender_id, receiver_id)
WHERE room_user_one_id IS NULL OR room_user_two_id IS NULL;

CREATE TABLE IF NOT EXISTS group_messages (
  id BIGSERIAL PRIMARY KEY,
  group_id BIGINT NOT NULL REFERENCES chat_groups(id) ON DELETE CASCADE,
  sender_id BIGINT NOT NULL REFERENCES users(id),
  body TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS private_messages_sender_idx
  ON private_messages (sender_id, sent_at DESC);

CREATE INDEX IF NOT EXISTS private_messages_receiver_idx
  ON private_messages (receiver_id, sent_at DESC);

CREATE INDEX IF NOT EXISTS group_messages_group_idx
  ON group_messages (group_id, sent_at DESC);

CREATE INDEX IF NOT EXISTS group_members_user_idx
  ON group_members (user_id);
