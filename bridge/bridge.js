const http = require("node:http");
const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");
const { encodeFrame, createFrameDecoder } = require("../shared/protocol");

const bridgeHost = process.env.BRIDGE_HOST || "127.0.0.1";
const bridgePort = Number(process.env.BRIDGE_PORT || 3000);
const distDirectory = path.join(__dirname, "..", "client", "dist");
let chatSocket = null;
let connection = { connected: false, name: "", host: "", port: 0 };
let chatState = { users: [], groups: [] };
let chatHistory = { privateMessages: [], groupMessages: [] };
const eventStreams = new Set();

function emit(message) {
  const line = `data: ${JSON.stringify(message)}\n\n`;
  for (const response of eventStreams) {
    if (!response.destroyed) response.write(line);
  }
}

function messageKey(message) {
  return message.id
    ? `${message.type}:${message.id}`
    : `${message.type}:${message.from}:${message.to || message.group}:${message.timestamp}:${message.text}`;
}

function mergeMessages(current, incoming) {
  const known = new Set(current.map(messageKey));
  return [...current, ...incoming.filter((message) => {
    const key = messageKey(message);
    if (known.has(key)) return false;
    known.add(key);
    return true;
  })].sort((left, right) => new Date(left.timestamp) - new Date(right.timestamp));
}

function rememberMessage(message) {
  if (message.type === "private_message") {
    chatHistory.privateMessages = mergeMessages(chatHistory.privateMessages, [message]);
  } else if (message.type === "group_message") {
    chatHistory.groupMessages = mergeMessages(chatHistory.groupMessages, [message]);
  } else if (message.type === "history") {
    chatHistory.privateMessages = mergeMessages(chatHistory.privateMessages, message.privateMessages || []);
    chatHistory.groupMessages = mergeMessages(chatHistory.groupMessages, message.groupMessages || []);
  }
}

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) request.destroy();
    });
    request.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON request"));
      }
    });
    request.on("error", reject);
  });
}

function disconnect() {
  if (chatSocket) {
    chatSocket.destroy();
    chatSocket = null;
  }
  connection = { connected: false, name: "", host: "", port: 0 };
  chatState = { users: [], groups: [] };
  chatHistory = { privateMessages: [], groupMessages: [] };
}

function connectToChat({ name, host, port }) {
  return new Promise((resolve, reject) => {
    if (chatSocket) return reject(new Error("This client is already connected."));

    const requestedName = typeof name === "string" ? name.trim().slice(0, 30) : "";
    const requestedHost = typeof host === "string" ? host.trim() : "";
    const requestedPort = Number(port);
    if (!requestedName || !requestedHost || !Number.isInteger(requestedPort) || requestedPort < 1 || requestedPort > 65535) {
      return reject(new Error("Valid name, server address, and port are required."));
    }

    const socket = net.createConnection({ host: requestedHost, port: requestedPort });
    chatSocket = socket;
    let settled = false;

    const decode = createFrameDecoder((message) => {
      rememberMessage(message);
      if (message.type === "state") {
        chatState = { users: message.users, groups: message.groups };
      }
      if (message.type === "registered" && !settled) {
        settled = true;
        connection = { connected: true, name: requestedName, host: requestedHost, port: requestedPort };
        resolve(connection);
      } else if (message.type === "error" && !settled) {
        settled = true;
        disconnect();
        reject(new Error(message.message));
      }
      emit(message);
    });

    socket.on("connect", () => socket.write(encodeFrame({ type: "register", name: requestedName })));
    socket.on("data", decode);
    socket.on("error", (error) => {
      if (!settled) {
        settled = true;
        chatSocket = null;
        reject(error);
      }
      emit({ type: "connection_error", message: error.message });
    });
    socket.on("close", () => {
      const wasCurrentSocket = chatSocket === socket;
      if (wasCurrentSocket) disconnect();
      if (!settled) {
        settled = true;
        reject(new Error("The server closed the connection."));
      }
      emit({ type: "disconnected" });
    });
  });
}

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

function serveStatic(request, response) {
  const requestPath = new URL(request.url, "http://localhost").pathname;
  const candidate = requestPath === "/" ? "index.html" : requestPath.slice(1);
  let filePath = path.resolve(distDirectory, candidate);
  if (!filePath.startsWith(`${path.resolve(distDirectory)}${path.sep}`) && filePath !== path.join(distDirectory, "index.html")) {
    response.writeHead(403).end("Forbidden");
    return;
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) filePath = path.join(distDirectory, "index.html");
  if (!fs.existsSync(filePath)) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("React build not found. Run: npm install, then npm run build");
    return;
  }
  response.writeHead(200, { "Content-Type": mimeTypes[path.extname(filePath)] || "application/octet-stream" });
  fs.createReadStream(filePath).pipe(response);
}

const bridge = http.createServer(async (request, response) => {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (request.method === "OPTIONS") return response.writeHead(204).end();

  try {
    if (request.method === "GET" && request.url === "/api/status") {
      return json(response, 200, { ...connection, ...chatState, history: chatHistory });
    }

    if (request.method === "GET" && request.url === "/api/events") {
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      response.write("retry: 1000\n\n");
      eventStreams.add(response);
      response.write(`data: ${JSON.stringify({ type: "snapshot", connection, state: chatState, history: chatHistory })}\n\n`);
      request.on("close", () => eventStreams.delete(response));
      return;
    }

    if (request.method === "POST" && request.url === "/api/connect") {
      const state = await connectToChat(await readJson(request));
      return json(response, 200, state);
    }

    if (request.method === "POST" && request.url === "/api/action") {
      if (!chatSocket || !connection.connected) return json(response, 409, { error: "Not connected to the chat server." });
      chatSocket.write(encodeFrame(await readJson(request)));
      return json(response, 202, { ok: true });
    }

    if (request.method === "POST" && request.url === "/api/disconnect") {
      disconnect();
      emit({ type: "disconnected" });
      return json(response, 200, { ok: true });
    }

    serveStatic(request, response);
  } catch (error) {
    json(response, 400, { error: error.message });
  }
});

const heartbeat = setInterval(() => {
  for (const response of eventStreams) {
    if (!response.destroyed) response.write(": heartbeat\n\n");
  }
}, 15000);
heartbeat.unref();

bridge.on("error", (error) => {
  console.error(`Client bridge error: ${error.message}`);
  process.exitCode = 1;
});

bridge.listen(bridgePort, bridgeHost, () => {
  console.log(`Client bridge and UI listening on http://${bridgeHost}:${bridgePort}`);
});

module.exports = { bridge };
