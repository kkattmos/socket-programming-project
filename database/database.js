const fs = require("node:fs/promises");
const path = require("node:path");
const { Pool } = require("pg");

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required. Copy .env.example to .env and start PostgreSQL.");
}

const schema = process.env.DATABASE_SCHEMA || "public";
if (!/^[a-z_][a-z0-9_]*$/i.test(schema)) {
  throw new Error("DATABASE_SCHEMA must contain only letters, numbers, and underscores.");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  options: `-c search_path=${schema}`,
});

pool.on("error", (error) => {
  console.error(`PostgreSQL pool error: ${error.message}`);
});

async function initialize() {
  await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
  const schemaSql = await fs.readFile(path.join(__dirname, "schema.sql"), "utf8");
  await pool.query(schemaSql);
}

async function ensureUser(name) {
  const result = await pool.query(
    `INSERT INTO users (name)
     VALUES ($1)
     ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
     RETURNING id, name`,
    [name],
  );
  return result.rows[0];
}

async function loadGroups() {
  const result = await pool.query(
    `SELECT g.name AS group_name, u.name AS member_name
     FROM chat_groups g
     LEFT JOIN group_members gm ON gm.group_id = g.id
     LEFT JOIN users u ON u.id = gm.user_id
     ORDER BY g.name, u.name`,
  );

  const groups = new Map();
  for (const row of result.rows) {
    if (!groups.has(row.group_name)) groups.set(row.group_name, new Set());
    if (row.member_name) groups.get(row.group_name).add(row.member_name);
  }
  return groups;
}

async function createGroup(groupName, creatorName) {
  const connection = await pool.connect();
  try {
    await connection.query("BEGIN");
    const creator = await connection.query("SELECT id FROM users WHERE name = $1", [creatorName]);
    const created = await connection.query(
      "INSERT INTO chat_groups (name, creator_id) VALUES ($1, $2) RETURNING id",
      [groupName, creator.rows[0].id],
    );
    await connection.query(
      "INSERT INTO group_members (group_id, user_id) VALUES ($1, $2)",
      [created.rows[0].id, creator.rows[0].id],
    );
    await connection.query("COMMIT");
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  } finally {
    connection.release();
  }
}

async function joinGroup(groupName, username) {
  const result = await pool.query(
    `INSERT INTO group_members (group_id, user_id)
     SELECT g.id, u.id
     FROM chat_groups g, users u
     WHERE g.name = $1 AND u.name = $2
     ON CONFLICT DO NOTHING
     RETURNING group_id`,
    [groupName, username],
  );
  return result.rowCount > 0;
}

async function savePrivateMessage(from, to, text) {
  const result = await pool.query(
    `INSERT INTO private_messages (sender_id, receiver_id, body, room_user_one_id, room_user_two_id)
     SELECT sender.id, receiver.id, $3,
            LEAST(sender.id, receiver.id), GREATEST(sender.id, receiver.id)
     FROM users sender, users receiver
     WHERE sender.name = $1 AND receiver.name = $2
     RETURNING id, sent_at`,
    [from, to, text],
  );
  return result.rows[0];
}

async function savePrivateChatbotMessage(participantOne, participantTwo, text, chatbotName) {
  const result = await pool.query(
    `INSERT INTO private_messages (sender_id, receiver_id, body, room_user_one_id, room_user_two_id)
     SELECT chatbot.id, participant_two.id, $4,
            LEAST(participant_one.id, participant_two.id),
            GREATEST(participant_one.id, participant_two.id)
     FROM users chatbot, users participant_one, users participant_two
     WHERE chatbot.name = $1
       AND participant_one.name = $2
       AND participant_two.name = $3
     RETURNING id, sent_at`,
    [chatbotName, participantOne, participantTwo, text],
  );
  return result.rows[0];
}

async function saveGroupMessage(group, from, text) {
  const result = await pool.query(
    `INSERT INTO group_messages (group_id, sender_id, body)
     SELECT g.id, u.id, $3
     FROM chat_groups g, users u
     WHERE g.name = $1 AND u.name = $2
     RETURNING id, sent_at`,
    [group, from, text],
  );
  return result.rows[0];
}

// Fixed map, never user input: safe to interpolate as a table name.
const REACTION_TABLES = {
  private_message: "private_message_reactions",
  group_message: "group_message_reactions",
};

// Finds the message's room and checks that `username` belongs to it, in one query.
// No row means the message does not exist OR the user may not see it; callers treat both the same.
const REACTION_ROOM_QUERIES = {
  private_message: `
    SELECT me.id AS user_id, room_one.name AS user_one, room_two.name AS user_two
    FROM private_messages pm
    JOIN users room_one ON room_one.id = pm.room_user_one_id
    JOIN users room_two ON room_two.id = pm.room_user_two_id
    JOIN users me ON me.name = $2
    WHERE pm.id = $1 AND me.id IN (pm.room_user_one_id, pm.room_user_two_id)`,
  group_message: `
    SELECT me.id AS user_id, g.name AS group_name
    FROM group_messages gm
    JOIN chat_groups g ON g.id = gm.group_id
    JOIN users me ON me.name = $2
    JOIN group_members membership ON membership.group_id = gm.group_id AND membership.user_id = me.id
    WHERE gm.id = $1`,
};

// Returns Map<messageId (string), [{ emoji, users: [name, ...] }]> for every id passed in.
// Emoji are ordered by when they were first used and users by when they reacted, so chips don't jump around.
async function reactionsFor(messageType, messageIds) {
  const reactionsById = new Map(messageIds.map((id) => [String(id), []]));
  if (messageIds.length === 0) return reactionsById;

  const result = await pool.query(
    `SELECT r.message_id, r.emoji, u.name
     FROM ${REACTION_TABLES[messageType]} r
     JOIN users u ON u.id = r.user_id
     WHERE r.message_id = ANY($1::bigint[])
     ORDER BY r.reacted_at, u.name`,
    [messageIds],
  );
  for (const row of result.rows) {
    const reactions = reactionsById.get(String(row.message_id));
    let entry = reactions.find((reaction) => reaction.emoji === row.emoji);
    if (!entry) {
      entry = { emoji: row.emoji, users: [] };
      reactions.push(entry);
    }
    entry.users.push(row.name);
  }
  return reactionsById;
}

async function withReactions(messageType, rows) {
  const reactionsById = await reactionsFor(messageType, rows.map((row) => row.id));
  return rows.map((row) => ({ ...row, type: messageType, reactions: reactionsById.get(String(row.id)) }));
}

// Same emoji again removes it; a different emoji replaces it; otherwise it is added.
// Returns null when the message does not exist or the user is not in its room.
// No transaction needed: a user has one socket, and the server processes each socket's messages in order.
async function toggleReaction(username, messageType, messageId, emoji) {
  const table = REACTION_TABLES[messageType];
  if (!table) return null;

  const room = await pool.query(REACTION_ROOM_QUERIES[messageType], [messageId, username]);
  if (room.rowCount === 0) return null;
  const { user_id: userId, user_one: userOne, user_two: userTwo, group_name: groupName } = room.rows[0];

  const removed = await pool.query(
    `DELETE FROM ${table} WHERE message_id = $1 AND user_id = $2 AND emoji = $3`,
    [messageId, userId, emoji],
  );
  if (removed.rowCount === 0) {
    await pool.query(
      `INSERT INTO ${table} (message_id, user_id, emoji)
       VALUES ($1, $2, $3)
       ON CONFLICT (message_id, user_id) DO UPDATE SET emoji = EXCLUDED.emoji, reacted_at = NOW()`,
      [messageId, userId, emoji],
    );
  }

  const reactions = (await reactionsFor(messageType, [messageId])).get(String(messageId));
  return {
    room: messageType === "private_message"
      ? { kind: "private", users: [userOne, userTwo] }
      : { kind: "group", name: groupName },
    reactions,
  };
}

async function getHistory(username) {
  const [privateResult, groupResult] = await Promise.all([
    pool.query(
      `SELECT * FROM (
         SELECT pm.id, sender.name AS "from", receiver.name AS "to", pm.body AS text,
                pm.sent_at AS timestamp,
                ARRAY[room_one.name, room_two.name] AS "roomUsers"
         FROM private_messages pm
         JOIN users sender ON sender.id = pm.sender_id
         JOIN users receiver ON receiver.id = pm.receiver_id
         JOIN users room_one ON room_one.id = pm.room_user_one_id
         JOIN users room_two ON room_two.id = pm.room_user_two_id
         WHERE room_one.name = $1 OR room_two.name = $1
         ORDER BY pm.sent_at DESC
         LIMIT 500
       ) recent_private_messages
       ORDER BY timestamp ASC`,
      [username],
    ),
    pool.query(
      `SELECT * FROM (
         SELECT gm.id, g.name AS "group", sender.name AS "from", gm.body AS text, gm.sent_at AS timestamp
         FROM group_messages gm
         JOIN chat_groups g ON g.id = gm.group_id
         JOIN users sender ON sender.id = gm.sender_id
         JOIN users current_user_record ON current_user_record.name = $1
         JOIN group_members membership
           ON membership.group_id = gm.group_id AND membership.user_id = current_user_record.id
         ORDER BY gm.sent_at DESC
         LIMIT 500
       ) recent_group_messages
       ORDER BY timestamp ASC`,
      [username],
    ),
  ]);

  const [privateMessages, groupMessages] = await Promise.all([
    withReactions("private_message", privateResult.rows),
    withReactions("group_message", groupResult.rows),
  ]);
  return { privateMessages, groupMessages };
}

async function getGroupHistory(group, username) {
  const result = await pool.query(
    `SELECT * FROM (
       SELECT gm.id, g.name AS "group", sender.name AS "from", gm.body AS text, gm.sent_at AS timestamp
       FROM group_messages gm
       JOIN chat_groups g ON g.id = gm.group_id
       JOIN users sender ON sender.id = gm.sender_id
       JOIN users current_user_record ON current_user_record.name = $2
       JOIN group_members membership
         ON membership.group_id = gm.group_id AND membership.user_id = current_user_record.id
       WHERE g.name = $1
       ORDER BY gm.sent_at DESC
       LIMIT 500
     ) recent_group_messages
     ORDER BY timestamp ASC`,
    [group, username],
  );
  return withReactions("group_message", result.rows);
}

async function getRecentPrivateMessages(username, peer, limit) {
  const result = await pool.query(
    `SELECT sender.name AS "from", pm.body AS text
     FROM private_messages pm
     JOIN users sender ON sender.id = pm.sender_id
     JOIN users requester ON requester.name = $1
     JOIN users other ON other.name = $2
     WHERE pm.room_user_one_id = LEAST(requester.id, other.id)
       AND pm.room_user_two_id = GREATEST(requester.id, other.id)
     ORDER BY pm.sent_at DESC, pm.id DESC
     LIMIT $3`,
    [username, peer, limit],
  );
  return result.rows.reverse();
}

async function getRecentGroupMessages(group, limit) {
  const result = await pool.query(
    `SELECT sender.name AS "from", gm.body AS text
     FROM group_messages gm
     JOIN chat_groups g ON g.id = gm.group_id
     JOIN users sender ON sender.id = gm.sender_id
     WHERE g.name = $1
     ORDER BY gm.sent_at DESC, gm.id DESC
     LIMIT $2`,
    [group, limit],
  );
  return result.rows.reverse();
}

async function clearAll() {
  if (schema === "public") throw new Error("Refusing to clear the public database schema");
  await pool.query(
    `TRUNCATE group_message_reactions, private_message_reactions,
              group_messages, private_messages, group_members, chat_groups, users
     RESTART IDENTITY CASCADE`,
  );
}

async function close() {
  await pool.end();
}

module.exports = {
  initialize,
  ensureUser,
  loadGroups,
  createGroup,
  joinGroup,
  savePrivateMessage,
  savePrivateChatbotMessage,
  saveGroupMessage,
  toggleReaction,
  getHistory,
  getGroupHistory,
  getRecentPrivateMessages,
  getRecentGroupMessages,
  clearAll,
  close,
};
