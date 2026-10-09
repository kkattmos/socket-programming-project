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
const eventStreams = new Set();

function emit(message) {
  const line = `data: ${JSON.stringify(message)}\n\n`;
  for (const response of eventStreams) response.write(line);
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
    if (request.method === "GET" && request.url === "/api/status") return json(response, 200, { ...connection, ...chatState });

    if (request.method === "GET" && request.url === "/api/events") {
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      response.write("retry: 1000\n\n");
      eventStreams.add(response);
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

bridge.listen(bridgePort, bridgeHost, () => {
  console.log(`Client bridge and UI listening on http://${bridgeHost}:${bridgePort}`);
});

module.exports = { bridge };
