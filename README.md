# Relay — TCP Socket Chat

Relay is a JavaScript chat application built for the socket-programming term project. It uses a central Node.js TCP server, a local Node.js client bridge on each physical client computer, and a React interface.

## Architecture

```text
Computer 1                                      Computer 2
React UI -> local bridge -> raw TCP socket      React UI -> local bridge
                              \                    /
                               central TCP server
```

The browser cannot create raw TCP sockets. Therefore, each physical client computer runs `bridge/bridge.js`. React talks only to its local bridge; the bridge is the network client and communicates with the central server exclusively through a persistent, length-prefixed TCP socket. No WebSocket or Socket.IO service is used.

## Requirements

- Node.js 18 or newer
- Two physical computers on the same LAN for the graded demonstration

## Install and build

On each client computer:

```bash
npm --prefix client install
npm run build
```

## Start the central server

On the computer acting as the server:

```bash
npm run server
```

The server listens on all interfaces at TCP port `5050`. If necessary, allow inbound TCP port 5050 in the computer's firewall. Find this computer's LAN IP address; clients must use that IP, not `127.0.0.1`.

Optional configuration:

```bash
CHAT_HOST=0.0.0.0 CHAT_PORT=5050 npm run server
```

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

## Tests

```bash
npm run lint
npm run build
npm test
```

The protocol tests verify that TCP messages decode correctly when a frame is split across reads and when several frames arrive in one read.

Use `npm run lint:fix` to apply ESLint's safe automatic fixes. The GitHub Actions workflow runs install, lint, build, and test checks for every push and pull request.
