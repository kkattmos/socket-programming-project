# Relay — TCP Socket Chat

Relay is a JavaScript chat application built for the socket-programming term project. It uses a central Node.js TCP server, a local Node.js client bridge on each physical client computer, and a React interface.

## Architecture

```text
Computer 1                                      Computer 2
React UI -> local bridge -> raw TCP socket      React UI -> local bridge
                              \                    /
                               central TCP server
                                       |
                                PostgreSQL database
```

The browser cannot create raw TCP sockets. Therefore, each physical client computer runs `bridge/bridge.js`. React talks only to its local bridge; the bridge is the network client and communicates with the central server exclusively through a persistent, length-prefixed TCP socket. No WebSocket or Socket.IO service is used.

## Requirements

- Node.js 20 or newer
- Docker with Docker Compose on the server computer
- Two physical computers on the same LAN for the graded demonstration

## Install and build

Install the server tools and React client:

```bash
npm install
npm --prefix client install
npm run build
```

## Start PostgreSQL and the central server

On the computer acting as the server:

```bash
cp .env.example .env
docker compose up -d postgres
npm run server
```

Docker stores PostgreSQL data in the named `postgres_data` volume. The server creates the required tables and indexes automatically at startup. Users, groups, memberships, private messages, and group messages survive server restarts.

The server listens on all interfaces at TCP port `5050`. If necessary, allow inbound TCP port 5050 in the computer's firewall. Find this computer's LAN IP address; clients must use that IP, not `127.0.0.1`.

Configuration is read from `.env`. Use `.env.example` as the safe template and do not commit the real `.env` file. To stop PostgreSQL without deleting its data:

```bash
docker compose stop postgres
```

## Hugging Face chatbot

The chatbot runs locally in the Node.js server with Transformers.js; it does not call the hosted Hugging Face inference API and does not require a token for the default public model. Configure it in `.env`:

```text
HF_LOCAL_MODEL=HuggingFaceTB/SmolLM2-360M-Instruct
HF_DTYPE=q4
HF_CACHE_DIR=.cache/huggingface
HF_MAX_NEW_TOKENS=200
```

The first `@chatbot` request downloads the quantized ONNX model into the configured cache, so it is slower than later requests and requires an internet connection. Later requests reuse one loaded pipeline. To run from model files already stored on the server, set `HF_LOCAL_MODEL_PATH` and set `HF_ALLOW_REMOTE_MODELS=false`.

Mention `@chatbot` anywhere in a private or group message:

```text
@chatbot explain the difference between TCP and UDP
```

The server runs the prompt through the local model, saves the response as a message from `Chatbot`, and routes it through the original room. In a private room only the two participants receive it; in a group only group members receive it.

## Start one client per physical computer

On each computer that will run a client:

```bash
npm run bridge
```

Open <http://127.0.0.1:3000>, enter a unique name, the central server's LAN IP address, and port `5050`.

For frontend development, start the bridge and then run `npm run client`. The build watcher updates `client/dist`; refresh <http://127.0.0.1:3000> after a change.

## Features and rubric mapping

- **R3:** Server rejects duplicate names.
- **R4:** Every client receives the live connected-user list, including itself.
- **R5–R7:** Selecting a user opens a private room; only sender and recipient receive its messages.
- **R8:** Creating a group adds only its creator.
- **R9:** Every client sees all groups and their member lists.
- **R10:** A user must click **Join group**; creators cannot add other users.
- **R11:** Only joined members can send and receive group messages.
- **Persistence:** PostgreSQL restores group membership and permitted message history after reconnecting or restarting the server.
- **AI feature:** `@chatbot` generates a Hugging Face response inside the invoking private or group room.

## Tests

```bash
npm run lint
npm run build
npm test
```

Start PostgreSQL with `docker compose up -d postgres` before running tests locally. The tests verify TCP framing, private/group authorization, and PostgreSQL history restoration after reconnecting.

Use `npm run lint:fix` to apply ESLint's safe automatic fixes. The GitHub Actions workflow runs install, lint, build, and test checks for every push and pull request.
