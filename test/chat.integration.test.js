const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const { once } = require("node:events");
const { encodeFrame, createFrameDecoder } = require("../shared/protocol");

process.env.CHAT_HOST = "127.0.0.1";
process.env.CHAT_PORT = "0";
process.env.DATABASE_URL ||= "postgresql://chat_user:chat_password@127.0.0.1:5432/socket_chat";
process.env.DATABASE_SCHEMA = "chat_test";
const { server, ready, resetForTests, shutdown } = require("../server/server");

function makeClient(port) {
  const socket = net.createConnection({ host: "127.0.0.1", port });
  const events = [];
  const waiters = [];

  socket.on("data", createFrameDecoder((message) => {
    events.push(message);
    for (const waiter of [...waiters]) {
      if (waiter.predicate(message)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      }
    }
  }));

  return {
    socket,
    events,
    send(message) { socket.write(encodeFrame(message)); },
    waitFor(predicate, timeout = 1500) {
      const existing = events.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve };
        waiter.timer = setTimeout(() => {
          waiters.splice(waiters.indexOf(waiter), 1);
          reject(new Error("Timed out waiting for server event"));
        }, timeout);
        waiters.push(waiter);
      });
    },
  };
}

test("routes private and group messages only through registered TCP clients", async (t) => {
  await ready;
  await resetForTests();
  const port = server.address().port;
  const alice = makeClient(port);
  const bob = makeClient(port);
  const carol = makeClient(port);
  let returningBob = null;
  t.after(async () => {
    alice.socket.destroy();
    bob.socket.destroy();
    carol.socket.destroy();
    returningBob?.socket.destroy();
    await shutdown();
  });

  await Promise.all([once(alice.socket, "connect"), once(bob.socket, "connect"), once(carol.socket, "connect")]);
  alice.send({ type: "register", name: "Alice" });
  bob.send({ type: "register", name: "Bob" });
  carol.send({ type: "register", name: "Carol" });
  await Promise.all([
    alice.waitFor((event) => event.type === "registered"),
    bob.waitFor((event) => event.type === "registered"),
    carol.waitFor((event) => event.type === "registered"),
  ]);

  alice.send({ type: "private_message", to: "Bob", text: "private hello" });
  const privateForBob = await bob.waitFor((event) => event.type === "private_message");
  assert.equal(privateForBob.text, "private hello");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(carol.events.some((event) => event.type === "private_message"), false);

  alice.send({ type: "create_group", group: "Networks" });
  const createdState = await alice.waitFor((event) => event.type === "state" && event.groups.some((group) => group.name === "Networks"));
  assert.deepEqual(createdState.groups.find((group) => group.name === "Networks").members, ["Alice"]);

  bob.send({ type: "join_group", group: "Networks" });
  await bob.waitFor((event) => event.type === "state" && event.groups.some((group) => group.name === "Networks" && group.members.includes("Bob")));
  alice.send({ type: "group_message", group: "Networks", text: "members only" });
  assert.equal((await bob.waitFor((event) => event.type === "group_message")).text, "members only");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(carol.events.some((event) => event.type === "group_message"), false);

  const bobClosed = once(bob.socket, "close");
  bob.socket.destroy();
  await bobClosed;
  returningBob = makeClient(port);
  await once(returningBob.socket, "connect");
  returningBob.send({ type: "register", name: "Bob" });
  const history = await returningBob.waitFor((event) => event.type === "history");
  assert.equal(history.privateMessages.some((message) => message.text === "private hello"), true);
  assert.equal(history.groupMessages.some((message) => message.text === "members only"), true);
});
