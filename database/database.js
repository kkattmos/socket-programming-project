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
    `INSERT INTO private_messages (sender_id, receiver_id, body)
     SELECT sender.id, receiver.id, $3
     FROM users sender, users receiver
     WHERE sender.name = $1 AND receiver.name = $2
     RETURNING sent_at`,
    [from, to, text],
  );
  return result.rows[0].sent_at;
}

async function saveGroupMessage(group, from, text) {
  const result = await pool.query(
    `INSERT INTO group_messages (group_id, sender_id, body)
     SELECT g.id, u.id, $3
     FROM chat_groups g, users u
     WHERE g.name = $1 AND u.name = $2
     RETURNING sent_at`,
    [group, from, text],
  );
  return result.rows[0].sent_at;
}

async function getHistory(username) {
  const [privateResult, groupResult] = await Promise.all([
    pool.query(
      `SELECT sender.name AS "from", receiver.name AS "to", pm.body AS text, pm.sent_at AS timestamp
       FROM private_messages pm
       JOIN users sender ON sender.id = pm.sender_id
       JOIN users receiver ON receiver.id = pm.receiver_id
       WHERE sender.name = $1 OR receiver.name = $1
       ORDER BY pm.sent_at ASC
       LIMIT 500`,
      [username],
    ),
    pool.query(
      `SELECT g.name AS "group", sender.name AS "from", gm.body AS text, gm.sent_at AS timestamp
       FROM group_messages gm
       JOIN chat_groups g ON g.id = gm.group_id
       JOIN users sender ON sender.id = gm.sender_id
       JOIN users current_user_record ON current_user_record.name = $1
       JOIN group_members membership
         ON membership.group_id = gm.group_id AND membership.user_id = current_user_record.id
       ORDER BY gm.sent_at ASC
       LIMIT 500`,
      [username],
    ),
  ]);

  return {
    privateMessages: privateResult.rows.map((row) => ({ ...row, type: "private_message" })),
    groupMessages: groupResult.rows.map((row) => ({ ...row, type: "group_message" })),
  };
}

async function getGroupHistory(group, username) {
  const result = await pool.query(
    `SELECT g.name AS "group", sender.name AS "from", gm.body AS text, gm.sent_at AS timestamp
     FROM group_messages gm
     JOIN chat_groups g ON g.id = gm.group_id
     JOIN users sender ON sender.id = gm.sender_id
     JOIN users current_user_record ON current_user_record.name = $2
     JOIN group_members membership
       ON membership.group_id = gm.group_id AND membership.user_id = current_user_record.id
     WHERE g.name = $1
     ORDER BY gm.sent_at ASC
     LIMIT 500`,
    [group, username],
  );
  return result.rows.map((row) => ({ ...row, type: "group_message" }));
}

async function clearAll() {
  if (schema === "public") throw new Error("Refusing to clear the public database schema");
  await pool.query("TRUNCATE group_messages, private_messages, group_members, chat_groups, users RESTART IDENTITY CASCADE");
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
  saveGroupMessage,
  getHistory,
  getGroupHistory,
  clearAll,
  close,
};
