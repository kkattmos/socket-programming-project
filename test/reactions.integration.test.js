const { after, before, test } = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const { once } = require("node:events");
const { encodeFrame, createFrameDecoder } = require("../shared/protocol");

process.env.CHAT_HOST = "127.0.0.1";
process.env.CHAT_PORT = "0";
process.env.DATABASE_URL ||= "postgresql://chat_user:chat_password@127.0.0.1:5432/socket_chat";
// Its own schema: node --test runs test files in parallel, and chat.integration.test.js resets "chat_test".
process.env.DATABASE_SCHEMA = "chat_test_reactions";
const { server, ready, resetForTests, shutdown } = require("../server/server");

const DENIED = "You can't react to that message.";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const openClients = new Set();

function makeClient(port) {
  const socket = net.createConnection({ host: "127.0.0.1", port });
  const events = [];
  socket.on("data", createFrameDecoder((message) => events.push(message)));
  const client = {
    socket,
    events,
    send(message) { socket.write(encodeFrame(message)); },
    // Removes the matched event, so a later wait can never pick up an older, already-handled one.
    async next(predicate, timeout = 1500) {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const index = events.findIndex(predicate);
        if (index !== -1) return events.splice(index, 1)[0];
        await sleep(10);
      }
      throw new Error("Timed out waiting for server event");
    },
  };
  openClients.add(client);
  return client;
}

async function connectAs(...names) {
  const port = server.address().port;
  const clients = names.map(() => makeClient(port));
  await Promise.all(clients.map((client) => once(client.socket, "connect")));
  clients.forEach((client, index) => client.send({ type: "register", name: names[index] }));
  await Promise.all(clients.map(async (client) => {
    client.history = await client.next((event) => event.type === "history");
  }));
  return clients;
}

async function disconnectAll() {
  for (const client of openClients) client.socket.destroy();
  openClients.clear();
}

// resetForTests refuses while the server still lists connected clients; give its close handlers a moment.
async function freshDatabase() {
  await disconnectAll();
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await resetForTests();
      return;
    } catch {
      await sleep(20);
    }
  }
  throw new Error("Server still has connected clients");
}

const isUpdate = (messageType) => (event) => event.type === "reaction_update" && event.messageType === messageType;
const isError = (event) => event.type === "error";

before(async () => {
  await ready;
});

after(async () => {
  await disconnectAll();
  await shutdown();
});

test("private room users add, replace and remove a reaction and both get the full list", async () => {
  await freshDatabase();
  const [alice, bob] = await connectAs("Alice", "Bob");
  alice.send({ type: "private_message", to: "Bob", text: "react to me" });
  const message = await bob.next((event) => event.type === "private_message");
  // Both room users receive every update, including the one who reacted; read it from both.
  const react = async (client, emoji, messageId = message.id) => {
    client.send({ type: "react", messageType: "private_message", messageId, emoji });
    const [forAlice, forBob] = await Promise.all([alice, bob].map((user) => user.next(isUpdate("private_message"))));
    assert.deepEqual(forAlice, forBob, "both users get the same list");
    return forAlice;
  };

  assert.deepEqual(await react(bob, " 👍 "), {
    type: "reaction_update",
    messageType: "private_message",
    messageId: String(message.id),
    reactions: [{ emoji: "👍", users: ["Bob"] }],
  });

  assert.deepEqual((await react(alice, "👍", Number(message.id))).reactions, [{ emoji: "👍", users: ["Bob", "Alice"] }]);

  assert.deepEqual(
    (await react(bob, "🇹🇭")).reactions,
    [{ emoji: "👍", users: ["Alice"] }, { emoji: "🇹🇭", users: ["Bob"] }],
    "a different emoji replaces Bob's reaction",
  );

  assert.deepEqual((await react(bob, "🇹🇭")).reactions, [{ emoji: "👍", users: ["Alice"] }], "the same emoji again removes it");
});

test("outsiders cannot react to a private message or a group they have not joined, and never receive updates", async () => {
  await freshDatabase();
  const [alice, bob, carol] = await connectAs("Alice", "Bob", "Carol");
  alice.send({ type: "private_message", to: "Bob", text: "just us" });
  const privateMessage = await bob.next((event) => event.type === "private_message");

  alice.send({ type: "create_group", group: "Networks" });
  await alice.next((event) => event.type === "state" && event.groups.some((group) => group.name === "Networks"));
  bob.send({ type: "join_group", group: "Networks" });
  await bob.next((event) => event.type === "history");
  alice.send({ type: "group_message", group: "Networks", text: "members only" });
  const groupMessage = await bob.next((event) => event.type === "group_message");

  carol.send({ type: "react", messageType: "private_message", messageId: privateMessage.id, emoji: "👍" });
  assert.equal((await carol.next(isError)).message, DENIED);
  carol.send({ type: "react", messageType: "group_message", messageId: groupMessage.id, emoji: "👍" });
  assert.equal((await carol.next(isError)).message, DENIED);

  bob.send({ type: "react", messageType: "private_message", messageId: privateMessage.id, emoji: "❤️" });
  await alice.next(isUpdate("private_message"));
  bob.send({ type: "react", messageType: "group_message", messageId: groupMessage.id, emoji: "😂" });
  assert.deepEqual((await alice.next(isUpdate("group_message"))).reactions, [{ emoji: "😂", users: ["Bob"] }]);
  await bob.next(isUpdate("group_message"));

  await sleep(50);
  assert.equal(carol.events.some((event) => event.type === "reaction_update"), false);
});

test("rejects malformed reactions without touching the database", async () => {
  await freshDatabase();
  const [alice, bob] = await connectAs("Alice", "Bob");
  alice.send({ type: "private_message", to: "Bob", text: "hello" });
  const message = await bob.next((event) => event.type === "private_message");

  const denied = [
    { messageType: "private_message", messageId: "999999" },
    { messageType: "secret_message", messageId: message.id },
    { messageType: "private_message", messageId: "0" },
    { messageType: "private_message", messageId: "1; DROP TABLE users" },
    { messageType: "private_message", messageId: "9".repeat(19) },
    { messageType: "private_message", messageId: { id: message.id } },
    { messageType: "private_message" },
  ];
  for (const fields of denied) {
    bob.send({ type: "react", emoji: "👍", ...fields });
    assert.equal((await bob.next(isError)).message, DENIED, JSON.stringify(fields));
  }

  for (const emoji of ["ok", "👍👍", "", 5]) {
    bob.send({ type: "react", messageType: "private_message", messageId: message.id, emoji });
    assert.match((await bob.next(isError)).message, /single emoji/, String(emoji));
  }

  await sleep(50);
  assert.equal(alice.events.some((event) => event.type === "reaction_update"), false);
});

test("reactions come back in history, including ones added while the private peer was offline", async () => {
  await freshDatabase();
  const [alice, bob] = await connectAs("Alice", "Bob");
  alice.send({ type: "private_message", to: "Bob", text: "see you later" });
  const privateMessage = await bob.next((event) => event.type === "private_message");
  alice.send({ type: "create_group", group: "Networks" });
  await alice.next((event) => event.type === "state" && event.groups.length > 0);
  bob.send({ type: "join_group", group: "Networks" });
  await bob.next((event) => event.type === "history");
  alice.send({ type: "group_message", group: "Networks", text: "group note" });
  const groupMessage = await bob.next((event) => event.type === "group_message");
  bob.send({ type: "react", messageType: "group_message", messageId: groupMessage.id, emoji: "🙏" });
  await bob.next(isUpdate("group_message"));

  const bobClosed = once(bob.socket, "close");
  bob.socket.destroy();
  await bobClosed;
  await alice.next((event) => event.type === "state" && !event.users.includes("Bob"));
  alice.send({ type: "react", messageType: "private_message", messageId: privateMessage.id, emoji: "😮" });
  assert.deepEqual((await alice.next(isUpdate("private_message"))).reactions, [{ emoji: "😮", users: ["Alice"] }]);

  const [returningBob] = await connectAs("Bob");
  const restoredPrivate = returningBob.history.privateMessages.find((item) => item.text === "see you later");
  const restoredGroup = returningBob.history.groupMessages.find((item) => item.text === "group note");
  assert.deepEqual(restoredPrivate.reactions, [{ emoji: "😮", users: ["Alice"] }]);
  assert.deepEqual(restoredGroup.reactions, [{ emoji: "🙏", users: ["Bob"] }]);
});

test("every history message carries a reactions array, empty when nobody reacted", async () => {
  await freshDatabase();
  const [alice, bob] = await connectAs("Alice", "Bob");
  alice.send({ type: "private_message", to: "Bob", text: "no reactions here" });
  await bob.next((event) => event.type === "private_message");
  alice.send({ type: "create_group", group: "Quiet" });
  await alice.next((event) => event.type === "state" && event.groups.length > 0);
  alice.send({ type: "group_message", group: "Quiet", text: "nobody reacts" });
  await alice.next((event) => event.type === "group_message");

  bob.socket.destroy();
  await alice.next((event) => event.type === "state" && !event.users.includes("Bob"));
  const [bobAgain] = await connectAs("Bob");
  assert.deepEqual(bobAgain.history.privateMessages.map((item) => item.reactions), [[]]);

  alice.socket.destroy();
  await bobAgain.next((event) => event.type === "state" && !event.users.includes("Alice"));
  const [aliceAgain] = await connectAs("Alice");
  assert.deepEqual(aliceAgain.history.groupMessages.map((item) => item.reactions), [[]]);
});
