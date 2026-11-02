const test = require("node:test");
const assert = require("node:assert/strict");

test("client message state deduplicates history and ignores malformed events", async () => {
  const { historyMessages, mergeChatMessages } = await import("../client/src/chatState.js");
  const message = {
    type: "private_message",
    id: "42",
    from: "Alice",
    to: "Bob",
    text: "persisted hello",
    timestamp: "2026-10-27T12:00:00.000Z",
  };

  let state = mergeChatMessages({}, [message, null, { type: "private_message" }], "Alice");
  state = mergeChatMessages(state, [message], "Alice");

  assert.equal(state["private:Bob"].length, 1);
  assert.deepEqual(historyMessages({ privateMessages: [message] }), [message]);
  assert.deepEqual(historyMessages({}), []);
});

test("client message state sorts restored messages chronologically", async () => {
  const { mergeChatMessages } = await import("../client/src/chatState.js");
  const state = mergeChatMessages({}, [
    { type: "group_message", id: "2", group: "Networks", from: "Bob", text: "second", timestamp: "2026-10-27T12:01:00.000Z" },
    { type: "group_message", id: "1", group: "Networks", from: "Alice", text: "first", timestamp: "2026-10-27T12:00:00.000Z" },
  ], "Alice");

  assert.deepEqual(state["group:Networks"].map((message) => message.text), ["first", "second"]);
});

test("places a chatbot private reply in the original users' room", async () => {
  const { mergeChatMessages } = await import("../client/src/chatState.js");
  const botReply = {
    type: "private_message",
    id: "9",
    from: "Chatbot",
    to: "Bob",
    roomUsers: ["Alice", "Bob"],
    text: "Here is the answer.",
    timestamp: "2026-10-27T12:00:00.000Z",
  };

  assert.equal(mergeChatMessages({}, [botReply], "Alice")["private:Bob"][0].from, "Chatbot");
  assert.equal(mergeChatMessages({}, [botReply], "Bob")["private:Alice"][0].from, "Chatbot");
});
