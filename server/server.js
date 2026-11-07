require("dotenv").config();

const net = require("node:net");
const database = require("../database/database");
const { encodeFrame, createFrameDecoder } = require("../shared/protocol");
const { isSingleEmoji } = require("../shared/emoji");
const {
  CHATBOT_NAME,
  containsChatbotMention,
  generateChatbotReply,
  generateChatSummary,
  resolveChatLimit,
} = require("../shared/ai-service");

const host = process.env.CHAT_HOST || "0.0.0.0";
const port = Number(process.env.CHAT_PORT || 5050);
const clients = new Map();
const registeringNames = new Set();
const summarizingUsers = new Set();
const chatLimit = resolveChatLimit(process.env.CHAT_LIMIT);
let groups = new Map();

// Positive BIGINT ids only; 18 digits can never overflow PostgreSQL's BIGINT.
const MESSAGE_ID_PATTERN = /^[1-9]\d{0,17}$/;
// One wording for "no such message" and "not your room", so outsiders can't probe which ids exist.
const REACTION_DENIED = "You can't react to that message.";

function cleanText(value, maxLength) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function send(socket, message) {
  if (socket && !socket.destroyed) socket.write(encodeFrame(message));
}

function publicState() {
  return {
    users: [...clients.keys()].sort((a, b) => a.localeCompare(b)),
    groups: [...groups.entries()]
      .map(([name, members]) => ({
        name,
        members: [...members].sort((a, b) => a.localeCompare(b)),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

function broadcastState() {
  const message = { type: "state", ...publicState() };
  for (const socket of clients.values()) send(socket, message);
}

function sendError(socket, message) {
  send(socket, { type: "error", message });
}

async function sendHistory(socket, username) {
  const history = await database.getHistory(username);
  send(socket, { type: "history", ...history });
}

async function chatbotReply(text) {
  try {
    return await generateChatbotReply(text);
  } catch (error) {
    console.error(`Chatbot error: ${error.message}`);
    return "Sorry, I could not generate a reply right now. Please check the Hugging Face configuration and try again.";
  }
}

function runChatbotTask(task, context) {
  // Model inference can take seconds (and the first run may download the model),
  // so it must not become part of this socket's ordered message queue.
  void task().catch((error) => {
    console.error(`Chatbot ${context} error: ${error.message}`);
  });
}

async function sendPrivateChatbotReply({ username, to, text }) {
  const reply = await chatbotReply(text);
  const botSaved = await database.savePrivateChatbotMessage(username, to, reply, CHATBOT_NAME);
  const botEvent = {
    type: "private_message",
    id: botSaved.id,
    from: CHATBOT_NAME,
    to,
    text: reply,
    timestamp: botSaved.sent_at,
    roomUsers: [username, to],
    bot: true,
  };
  send(clients.get(username), botEvent);
  if (to !== username) send(clients.get(to), botEvent);
}

async function sendGroupChatbotReply({ group, text }) {
  const reply = await chatbotReply(text);
  const botSaved = await database.saveGroupMessage(group, CHATBOT_NAME, reply);
  const botEvent = {
    type: "group_message",
    id: botSaved.id,
    group,
    from: CHATBOT_NAME,
    text: reply,
    timestamp: botSaved.sent_at,
    bot: true,
  };
  const members = groups.get(group) || new Set();
  for (const member of members) send(clients.get(member), botEvent);
}

function sendSummary(socket, room, fields) {
  send(socket, { type: "chat_summary", kind: room.kind, name: room.name, ...fields });
}

async function summarizeChat(socket, username, room) {
  try {
    const messages = room.kind === "group"
      ? await database.getRecentGroupMessages(room.name, chatLimit)
      : await database.getRecentPrivateMessages(username, room.name, chatLimit);
    if (messages.length === 0) {
      sendSummary(socket, room, { error: "There are no messages to summarize yet." });
      return;
    }
    sendSummary(socket, room, { text: await generateChatSummary(messages) });
  } catch (error) {
    console.error(`Chat summary error: ${error.message}`);
    sendSummary(socket, room, { error: "Sorry, the summary could not be generated right now." });
  } finally {
    summarizingUsers.delete(username);
  }
}

function requestSummary(socket, username, message) {
  const room = { kind: message.kind, name: cleanText(message.name, 40) };
  if ((room.kind !== "private" && room.kind !== "group") || !room.name) {
    return sendSummary(socket, room, { error: "Choose a chat to summarize." });
  }
  if (room.kind === "group" && !groups.get(room.name)?.has(username)) {
    return sendSummary(socket, room, { error: "Join this group before summarizing it." });
  }
  if (summarizingUsers.has(username)) {
    return sendSummary(socket, room, { error: "A summary is already in progress." });
  }

  summarizingUsers.add(username);
  runChatbotTask(() => summarizeChat(socket, username, room), `summary for ${username}`);
}

async function reactToMessage(socket, username, message) {
  const { messageType } = message;
  const messageId = String(message.messageId ?? "");
  const emoji = typeof message.emoji === "string" ? message.emoji.trim() : "";
  if ((messageType !== "private_message" && messageType !== "group_message") || !MESSAGE_ID_PATTERN.test(messageId)) {
    return sendError(socket, REACTION_DENIED);
  }
  if (!isSingleEmoji(emoji)) return sendError(socket, "A reaction must be a single emoji.");

  const result = await database.toggleReaction(username, messageType, messageId, emoji);
  if (!result) return sendError(socket, REACTION_DENIED);

  // Full list, not a delta, so every client converges on the same state.
  const event = { type: "reaction_update", messageType, messageId, reactions: result.reactions };
  // Same audience as the message itself: the two private room users (R7) or the group's members (R11).
  const recipients = result.room.kind === "private"
    ? new Set(result.room.users)
    : groups.get(result.room.name) || new Set();
  for (const member of recipients) send(clients.get(member), event);
}

async function handleRegisteredMessage(socket, username, message) {
  switch (message.type) {
    case "private_message": {
      const to = cleanText(message.to, 30);
      const text = cleanText(message.text, 2000);
      if (!to || !text) return sendError(socket, "Recipient and message are required.");

      const recipient = clients.get(to);
      if (!recipient) return sendError(socket, `User '${to}' is not connected.`);

      const saved = await database.savePrivateMessage(username, to, text);
      const event = {
        type: "private_message",
        id: saved.id,
        from: username,
        to,
        text,
        timestamp: saved.sent_at,
        roomUsers: [username, to],
      };
      send(socket, event);
      if (recipient !== socket) send(recipient, event);

      if (containsChatbotMention(text)) {
        runChatbotTask(
          () => sendPrivateChatbotReply({ username, to, text }),
          `private reply for ${username}`,
        );
      }
      break;
    }

    case "create_group": {
      const group = cleanText(message.group, 40);
      if (!group) return sendError(socket, "Group name is required.");
      if (groups.has(group)) return sendError(socket, `Group '${group}' already exists.`);

      try {
        await database.createGroup(group, username);
      } catch (error) {
        if (error.code === "23505") return sendError(socket, `Group '${group}' already exists.`);
        throw error;
      }
      groups.set(group, new Set([username]));
      broadcastState();
      break;
    }

    case "join_group": {
      const group = cleanText(message.group, 40);
      const members = groups.get(group);
      if (!members) return sendError(socket, `Group '${group}' does not exist.`);
      if (members.has(username)) return sendError(socket, `You are already a member of '${group}'.`);

      const joined = await database.joinGroup(group, username);
      if (!joined) return sendError(socket, `Could not join '${group}'.`);
      members.add(username);
      broadcastState();
      const groupMessages = await database.getGroupHistory(group, username);
      send(socket, { type: "history", privateMessages: [], groupMessages });
      break;
    }

    case "group_message": {
      const group = cleanText(message.group, 40);
      const text = cleanText(message.text, 2000);
      const members = groups.get(group);
      if (!members) return sendError(socket, `Group '${group}' does not exist.`);
      if (!members.has(username)) return sendError(socket, `Join '${group}' before sending a message.`);
      if (!text) return sendError(socket, "Message cannot be empty.");

      const saved = await database.saveGroupMessage(group, username, text);
      const event = {
        type: "group_message",
        id: saved.id,
        group,
        from: username,
        text,
        timestamp: saved.sent_at,
      };
      for (const member of members) {
        const memberSocket = clients.get(member);
        if (memberSocket) send(memberSocket, event);
      }

      if (containsChatbotMention(text)) {
        runChatbotTask(
          () => sendGroupChatbotReply({ group, text }),
          `group reply for ${group}`,
        );
      }
      break;
    }

    case "summarize_chat":
      requestSummary(socket, username, message);
      break;

    case "react":
      await reactToMessage(socket, username, message);
      break;

    default:
      sendError(socket, "Unknown message type.");
  }
}

const server = net.createServer((socket) => {
  socket.setKeepAlive(true);
  socket.setNoDelay(true);
  let username = null;
  let messageQueue = Promise.resolve();

  async function processMessage(message) {
    if (!username) {
      if (message.type !== "register") {
        sendError(socket, "Register a name before using chat.");
        return;
      }

      const requestedName = cleanText(message.name, 30);
      if (!requestedName) return sendError(socket, "A name is required.");
      if (requestedName.toLowerCase() === CHATBOT_NAME.toLowerCase()) {
        return sendError(socket, `The name '${CHATBOT_NAME}' is reserved.`);
      }
      if (clients.has(requestedName) || registeringNames.has(requestedName)) {
        return sendError(socket, "That name is already connected.");
      }

      registeringNames.add(requestedName);
      try {
        await database.ensureUser(requestedName);
        if (socket.destroyed) return;
        username = requestedName;
        clients.set(username, socket);
      } finally {
        registeringNames.delete(requestedName);
      }

      console.log(`${username} connected from ${socket.remoteAddress}:${socket.remotePort}`);
      send(socket, { type: "registered", name: username });
      broadcastState();
      await sendHistory(socket, username);
      return;
    }

    await handleRegisteredMessage(socket, username, message);
  }

  const decode = createFrameDecoder(
    (message) => {
      messageQueue = messageQueue
        .then(() => processMessage(message))
        .catch((error) => {
          console.error(`Message handling error: ${error.message}`);
          sendError(socket, "The server could not complete that operation.");
        });
    },
    (error) => {
      sendError(socket, error.message);
      socket.destroy();
    },
  );

  socket.on("data", decode);
  socket.on("error", (error) => console.error(`Socket error: ${error.message}`));
  socket.on("close", () => {
    if (username && clients.get(username) === socket) {
      clients.delete(username);
      console.log(`${username} disconnected`);
      broadcastState();
    }
  });
});

server.on("error", (error) => {
  console.error(`Server error: ${error.message}`);
  process.exitCode = 1;
});

async function start() {
  await database.initialize();
  await database.ensureUser(CHATBOT_NAME);
  groups = await database.loadGroups();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      console.log(`Chat server listening on ${host}:${server.address().port}`);
      resolve();
    });
  });
}

async function resetForTests() {
  if (clients.size > 0) throw new Error("Cannot reset the database while clients are connected");
  await database.clearAll();
  await database.ensureUser(CHATBOT_NAME);
  groups = new Map();
}

async function shutdown() {
  if (server.listening) {
    await new Promise((resolve) => server.close(resolve));
  }
  await database.close();
}

const ready = start().catch((error) => {
  console.error(`Startup error: ${error.message}`);
  process.exitCode = 1;
  throw error;
});

module.exports = { server, ready, resetForTests, shutdown };
