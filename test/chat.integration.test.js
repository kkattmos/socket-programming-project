const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const { once } = require("node:events");
const { encodeFrame, createFrameDecoder } = require("../shared/protocol");

process.env.CHAT_HOST = "127.0.0.1";
process.env.CHAT_PORT = "0";
process.env.DATABASE_URL ||= "postgresql://chat_user:chat_password@127.0.0.1:5432/socket_chat";
process.env.DATABASE_SCHEMA = "chat_test";
process.env.CHAT_LIMIT = "2";
const { setGeneratorForTests } = require("../shared/ai-service");
setGeneratorForTests(async (messages) => [{
  generated_text: [...messages, { role: "assistant", content: "Test chatbot reply" }],
}]);
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

  let releaseChatbot;
  const chatbotCanReply = new Promise((resolve) => { releaseChatbot = resolve; });
  setGeneratorForTests(async (messages) => {
    await chatbotCanReply;
    return [{ generated_text: [...messages, { role: "assistant", content: "Test chatbot reply" }] }];
  });

  alice.send({ type: "private_message", to: "Bob", text: "private hello" });
  const privateForBob = await bob.waitFor((event) => event.type === "private_message");
  assert.equal(privateForBob.text, "private hello");
  assert.ok(privateForBob.id);
  alice.send({ type: "private_message", to: "Bob", text: "second private message" });
  await bob.waitFor((event) => event.type === "private_message" && event.text === "second private message");
  alice.send({ type: "private_message", to: "Bob", text: "@chatbot answer privately" });
  await bob.waitFor((event) => event.type === "private_message" && event.text === "@chatbot answer privately");
  alice.send({ type: "create_group", group: "CreatedWhileChatbotRuns" });
  try {
    await alice.waitFor(
      (event) => event.type === "state" && event.groups.some((group) => group.name === "CreatedWhileChatbotRuns"),
      1000,
    );
  } finally {
    releaseChatbot();
  }
  const privateBotReply = await bob.waitFor((event) => event.type === "private_message" && event.from === "Chatbot");
  assert.equal(privateBotReply.text, "Test chatbot reply");
  assert.deepEqual(privateBotReply.roomUsers, ["Alice", "Bob"]);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(carol.events.some((event) => event.type === "private_message"), false);

  alice.send({ type: "create_group", group: "Networks" });
  const createdState = await alice.waitFor((event) => event.type === "state" && event.groups.some((group) => group.name === "Networks"));
  assert.deepEqual(createdState.groups.find((group) => group.name === "Networks").members, ["Alice"]);

  bob.send({ type: "join_group", group: "Networks" });
  await bob.waitFor((event) => event.type === "state" && event.groups.some((group) => group.name === "Networks" && group.members.includes("Bob")));
  alice.send({ type: "group_message", group: "Networks", text: "members only" });
  const groupForBob = await bob.waitFor((event) => event.type === "group_message");
  assert.equal(groupForBob.text, "members only");
  assert.ok(groupForBob.id);
  bob.send({ type: "group_message", group: "Networks", text: "second group message" });
  await alice.waitFor((event) => event.type === "group_message" && event.text === "second group message");
  alice.send({ type: "group_message", group: "Networks", text: "Please @chatbot answer the group" });
  const groupBotReply = await bob.waitFor((event) => event.type === "group_message" && event.from === "Chatbot");
  assert.equal(groupBotReply.text, "Test chatbot reply");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(carol.events.some((event) => event.type === "group_message"), false);

  let summaryPrompt = null;
  const summaryGenerator = async (messages) => {
    summaryPrompt = messages.at(-1).content;
    return [{ generated_text: [...messages, { role: "assistant", content: "Test summary" }] }];
  };
  const summaryFor = (client, name) => {
    client.events.length = 0;
    return (message) => {
      client.send(message);
      return client.waitFor((event) => event.type === "chat_summary" && event.name === name);
    };
  };
  setGeneratorForTests(summaryGenerator);

  const groupSummary = await summaryFor(bob, "Networks")({ type: "summarize_chat", kind: "group", name: "Networks" });
  assert.equal(groupSummary.text, "Test summary");
  assert.equal(groupSummary.kind, "group");
  assert.match(summaryPrompt, /Chatbot: Test chatbot reply/);
  assert.ok(!summaryPrompt.includes("members only"), "only the last CHAT_LIMIT messages are read");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(alice.events.some((event) => event.type === "chat_summary"), false);
  assert.equal(carol.events.some((event) => event.type === "chat_summary"), false);

  summaryPrompt = null;
  const refused = await summaryFor(carol, "Networks")({ type: "summarize_chat", kind: "group", name: "Networks" });
  assert.match(refused.error, /join/i);
  const unknownGroup = await summaryFor(carol, "Nope")({ type: "summarize_chat", kind: "group", name: "Nope" });
  assert.match(unknownGroup.error, /join/i);
  const otherRoom = await summaryFor(carol, "Bob")({ type: "summarize_chat", kind: "private", name: "Bob" });
  assert.match(otherRoom.error, /no messages/i);
  const badKind = await summaryFor(carol, "Bob")({ type: "summarize_chat", kind: "secret", name: "Bob" });
  assert.match(badKind.error, /choose/i);
  const noName = await summaryFor(carol, "")({ type: "summarize_chat", kind: "group" });
  assert.match(noName.error, /choose/i);
  assert.equal(summaryPrompt, null, "the model is not called for refused requests");

  const privateSummary = await summaryFor(bob, "Alice")({ type: "summarize_chat", kind: "private", name: "Alice" });
  assert.equal(privateSummary.text, "Test summary");
  assert.match(summaryPrompt, /Alice: @chatbot answer privately/);

  alice.send({ type: "private_message", to: "Alice", text: "note to self" });
  await alice.waitFor((event) => event.type === "private_message" && event.text === "note to self");
  await summaryFor(alice, "Alice")({ type: "summarize_chat", kind: "private", name: "Alice" });
  assert.equal(summaryPrompt, "Alice: note to self");

  setGeneratorForTests(async () => { throw new Error("model failed"); });
  const failed = await summaryFor(bob, "Alice")({ type: "summarize_chat", kind: "private", name: "Alice" });
  assert.match(failed.error, /could not be generated/i);
  setGeneratorForTests(summaryGenerator);
  const retried = await summaryFor(bob, "Alice")({ type: "summarize_chat", kind: "private", name: "Alice" });
  assert.equal(retried.text, "Test summary");

  let releaseSummary;
  const summaryCanFinish = new Promise((resolve) => { releaseSummary = resolve; });
  setGeneratorForTests(async (messages) => {
    await summaryCanFinish;
    return summaryGenerator(messages);
  });
  bob.events.length = 0;
  bob.send({ type: "summarize_chat", kind: "private", name: "Alice" });
  bob.send({ type: "summarize_chat", kind: "group", name: "Networks" });
  const busy = await bob.waitFor((event) => event.type === "chat_summary" && event.name === "Networks");
  assert.match(busy.error, /already/i);
  bob.send({ type: "group_message", group: "Networks", text: "still chatting" });
  await bob.waitFor((event) => event.type === "group_message" && event.text === "still chatting");
  releaseSummary();
  const finished = await bob.waitFor((event) => event.type === "chat_summary" && event.name === "Alice");
  assert.equal(finished.text, "Test summary");
  setGeneratorForTests(summaryGenerator);

  const bobClosed = once(bob.socket, "close");
  bob.socket.destroy();
  await bobClosed;
  returningBob = makeClient(port);
  await once(returningBob.socket, "connect");
  returningBob.send({ type: "register", name: "Bob" });
  const history = await returningBob.waitFor((event) => event.type === "history");
  assert.equal(history.privateMessages.some((message) => message.text === "private hello"), true);
  assert.equal(history.privateMessages.some((message) => message.text === "second private message"), true);
  assert.equal(history.privateMessages.some((message) => message.from === "Chatbot" && message.text === "Test chatbot reply"), true);
  assert.equal(history.groupMessages.some((message) => message.text === "members only"), true);
  assert.equal(history.groupMessages.some((message) => message.text === "second group message"), true);
  assert.equal(history.groupMessages.some((message) => message.from === "Chatbot" && message.text === "Test chatbot reply"), true);
});
