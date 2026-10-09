const net = require("node:net");
const { encodeFrame, createFrameDecoder } = require("../shared/protocol");

const host = process.env.CHAT_HOST || "0.0.0.0";
const port = Number(process.env.CHAT_PORT || 5050);
const clients = new Map();
const groups = new Map();

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

function handleRegisteredMessage(socket, username, message) {
  switch (message.type) {
    case "private_message": {
      const to = cleanText(message.to, 30);
      const text = cleanText(message.text, 2000);
      if (!to || !text) return sendError(socket, "Recipient and message are required.");

      const recipient = clients.get(to);
      if (!recipient) return sendError(socket, `User '${to}' is not connected.`);

      const event = {
        type: "private_message",
        from: username,
        to,
        text,
        timestamp: new Date().toISOString(),
      };
      send(socket, event);
      if (recipient !== socket) send(recipient, event);
      break;
    }

    case "create_group": {
      const group = cleanText(message.group, 40);
      if (!group) return sendError(socket, "Group name is required.");
      if (groups.has(group)) return sendError(socket, `Group '${group}' already exists.`);

      groups.set(group, new Set([username]));
      broadcastState();
      break;
    }

    case "join_group": {
      const group = cleanText(message.group, 40);
      const members = groups.get(group);
      if (!members) return sendError(socket, `Group '${group}' does not exist.`);
      members.add(username);
      broadcastState();
      break;
    }

    case "group_message": {
      const group = cleanText(message.group, 40);
      const text = cleanText(message.text, 2000);
      const members = groups.get(group);
      if (!members) return sendError(socket, `Group '${group}' does not exist.`);
      if (!members.has(username)) return sendError(socket, `Join '${group}' before sending a message.`);
      if (!text) return sendError(socket, "Message cannot be empty.");

      const event = {
        type: "group_message",
        group,
        from: username,
        text,
        timestamp: new Date().toISOString(),
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

  const decode = createFrameDecoder(
    (message) => {
      if (!username) {
        if (message.type !== "register") {
          return sendError(socket, "Register a name before using chat.");
        }

        const requestedName = cleanText(message.name, 30);
        if (!requestedName) return sendError(socket, "A name is required.");
        if (clients.has(requestedName)) return sendError(socket, "That name is already connected.");

        username = requestedName;
        clients.set(username, socket);
        console.log(`${username} connected from ${socket.remoteAddress}:${socket.remotePort}`);
        send(socket, { type: "registered", name: username });
        broadcastState();
        return;
      }

      handleRegisteredMessage(socket, username, message);
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
      for (const members of groups.values()) members.delete(username);
      console.log(`${username} disconnected`);
      broadcastState();
    }
  });
});

server.on("error", (error) => {
  console.error(`Server error: ${error.message}`);
  process.exitCode = 1;
});

server.listen(port, host, () => {
  console.log(`Chat server listening on ${host}:${port}`);
});

module.exports = { server };
