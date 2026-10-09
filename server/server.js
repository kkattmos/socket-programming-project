require("dotenv").config();

const net = require("node:net");
const database = require("../database/database");
const { encodeFrame, createFrameDecoder } = require("../shared/protocol");

const host = process.env.CHAT_HOST || "0.0.0.0";
const port = Number(process.env.CHAT_PORT || 5050);
const clients = new Map();
const registeringNames = new Set();
let groups = new Map();

function cleanText(value, maxLength) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function send(socket, message) {
  if (!socket.destroyed) socket.write(encodeFrame(message));
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

async function handleRegisteredMessage(socket, username, message) {
  switch (message.type) {
    case "private_message": {
      const to = cleanText(message.to, 30);
      const text = cleanText(message.text, 2000);
      if (!to || !text) return sendError(socket, "Recipient and message are required.");

      const recipient = clients.get(to);
      if (!recipient) return sendError(socket, `User '${to}' is not connected.`);

      const timestamp = await database.savePrivateMessage(username, to, text);
      const event = {
        type: "private_message",
        from: username,
        to,
        text,
        timestamp,
      };
      send(socket, event);
      if (recipient !== socket) send(recipient, event);
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

      const timestamp = await database.saveGroupMessage(group, username, text);
      const event = {
        type: "group_message",
        group,
        from: username,
        text,
        timestamp,
      };
      for (const member of members) {
        const memberSocket = clients.get(member);
        if (memberSocket) send(memberSocket, event);
      }
      break;
    }

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
