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

test("stores a summary by room and replaces the pending entry", async () => {
  const { applySummaryEvent } = await import("../client/src/chatState.js");
  const next = applySummaryEvent({ "group:A": { pending: true } }, { kind: "group", name: "A", text: "S" });
  assert.deepEqual(next, { "group:A": { text: "S" } });
});

test("stores a summary error by room and leaves other rooms alone", async () => {
  const { applySummaryEvent } = await import("../client/src/chatState.js");
  const next = applySummaryEvent({ "private:B": { text: "old" } }, { kind: "group", name: "A", error: "E" });
  assert.deepEqual(next, { "private:B": { text: "old" }, "group:A": { error: "E" } });
});

const reactedMessage = {
  type: "group_message",
  id: "7",
  group: "Networks",
  from: "Alice",
  text: "react to me",
  timestamp: "2026-10-27T12:00:00.000Z",
};

test("applies a reaction update to the matching message only", async () => {
  const { applyReactionUpdate, mergeChatMessages } = await import("../client/src/chatState.js");
  const state = mergeChatMessages({}, [reactedMessage, { ...reactedMessage, id: "8", text: "other" }], "Bob");
  const reactions = [{ emoji: "👍", users: ["Bob"] }];

  const next = applyReactionUpdate(state, { type: "reaction_update", messageType: "group_message", messageId: 7, reactions });

  assert.deepEqual(next["group:Networks"][0].reactions, reactions);
  assert.equal(next["group:Networks"][1].reactions, undefined);
  assert.equal(state["group:Networks"][0].reactions, undefined, "the previous state is not mutated");
});

test("ignores reaction updates that match nothing or are malformed", async () => {
  const { applyReactionUpdate, mergeChatMessages } = await import("../client/src/chatState.js");
  const state = mergeChatMessages({}, [reactedMessage], "Bob");

  // Private and group ids are separate sequences, so the type must match too.
  assert.equal(applyReactionUpdate(state, { messageType: "private_message", messageId: "7", reactions: [] }), state);
  assert.equal(applyReactionUpdate(state, { messageType: "group_message", messageId: "99", reactions: [] }), state);
  assert.equal(applyReactionUpdate(state, { messageType: "group_message", messageId: "7" }), state);
  assert.equal(applyReactionUpdate(state, null), state);
});

test("a re-sent message refreshes its reactions without duplicating it", async () => {
  const { mergeChatMessages } = await import("../client/src/chatState.js");
  let state = mergeChatMessages({}, [{ ...reactedMessage, reactions: [{ emoji: "👍", users: ["Bob"] }] }], "Bob");

  state = mergeChatMessages(state, [{ ...reactedMessage, reactions: [{ emoji: "😂", users: ["Alice"] }] }], "Bob");
  assert.equal(state["group:Networks"].length, 1);
  assert.deepEqual(state["group:Networks"][0].reactions, [{ emoji: "😂", users: ["Alice"] }]);

  state = mergeChatMessages(state, [reactedMessage], "Bob");
  assert.deepEqual(state["group:Networks"][0].reactions, [{ emoji: "😂", users: ["Alice"] }], "a copy without reactions keeps them");
});

test("drops malformed reaction entries before rendering", async () => {
  const { safeReactions } = await import("../client/src/chatState.js");
  const valid = { emoji: "👍", users: ["Alice"] };
  assert.deepEqual(safeReactions([valid, null, { emoji: 5, users: ["A"] }, { emoji: "😂", users: [] }, { emoji: "😮" }]), [valid]);
  assert.deepEqual(safeReactions(undefined), []);
  assert.deepEqual(safeReactions("👍"), []);
});
