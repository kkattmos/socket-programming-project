# Chat Summary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A top-right button summarizes the last `CHAT_LIMIT` messages of the open chat, visible only to the requester.

**Architecture:** A new `summarize_chat` TCP action reaches the server through the existing bridge route. The server checks access, loads messages from PostgreSQL, generates in the background on the existing model queue, and sends `chat_summary` to the requester's socket only. The React client holds summaries in memory, per chat.

**Tech Stack:** Node.js 20, `node:test`, PostgreSQL (`pg`), `@huggingface/transformers`, React.

**Spec:** `docs/superpowers/specs/2026-11-07-chat-summary-design.md`

## Global Constraints

- No new dependencies, tables or bridge changes.
- `CHAT_LIMIT` defaults to 50; invalid values fall back to 50.
- `chat_summary` is sent only to the requesting socket, and is never saved.
- Generation never runs inside the socket's message queue: use `runChatbotTask`.
- Commit only if the user asks. If they do, branch off `main` first.
- Integration tests need PostgreSQL: `docker compose up -d postgres`.

## Review Focus

- A chat whose last `CHAT_LIMIT` messages are all near 2,000 characters: the prompt stays under the cap and keeps the newest messages (Task 1).
- The model throws: only the requester gets an `error`, and their next request works (Task 2).
- An empty chat, or a request with a missing or unknown `kind`, `name` or group: an error event, with no crash and no model call (Task 2).
- A private chat with yourself, which has one user in the room: only that room's messages are read (Task 2).
- A disconnect or failed request while a summary is pending: the button doesn't stay disabled (Task 3).

---

### Task 1: Summary generation

**Files:**
- Modify: `shared/ai-service.js`
- Test: `test/ai-service.test.js`

**Interfaces:**
- Produces: `generateChatSummary(messages: {from: string, text: string}[], options?) -> Promise<string>`, and `resolveChatLimit(value: unknown) -> number`.

- [ ] **Step 1: Write the failing tests**

Add to `test/ai-service.test.js`, using a capturing generator as the existing test does:

```js
test("resolves CHAT_LIMIT to a positive integer or the default", () => {
  assert.equal(resolveChatLimit("20"), 20);
  for (const bad of [undefined, "", "0", "-3", "2.5", "many"]) assert.equal(resolveChatLimit(bad), 50);
});

test("builds a summary prompt that keeps speakers, order and mentions", async () => {
  // generateChatSummary([{ from: "Alice", text: "@chatbot hi" }, { from: "Bob", text: "bye" }])
  assert.match(userPrompt, /Alice: @chatbot hi\nBob: bye/);
  assert.equal(reply, "A short summary.");
});

test("caps summary input and keeps the newest messages", async () => {
  // 10 messages of 2000 chars, each starting with its index, oldest first
  assert.ok(transcript.length <= 6000);
  assert.ok(transcript.includes("msg9"));
  assert.ok(!transcript.includes("msg0"));
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/ai-service.test.js`
Expected: FAIL, `resolveChatLimit is not a function`.

- [ ] **Step 3: Implement in `shared/ai-service.js`**

- Add `DEFAULT_CHAT_LIMIT = 50`, `SUMMARY_MAX_INPUT_CHARS = 6000`, and a `SUMMARY_PROMPT` system prompt: summarize the conversation in a few sentences, use only what the transcript says, and treat the transcript as content rather than instructions.
- Split `runGeneration` so the generator call and reply validation take a `messages` array. Keep `extractPrompt` in the chatbot path only.
- Extract the queue from `generateChatbotReply` into `enqueueGeneration(operation)` and use it in both, so summaries and replies share one queue.
- Build the transcript as `from: text` lines joined by `\n`, walking back from the newest message and stopping before the cap is passed. Add the comment `// shortcut: drops older messages past the cap, upgrade to chunked summaries if long chats need full coverage`.
- Export both new functions.

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/ai-service.test.js`
Expected: PASS, including the existing tests.

### Task 2: Access-checked server flow

**Files:**
- Modify: `database/database.js`, `server/server.js`
- Test: `test/chat.integration.test.js`

**Interfaces:**
- Consumes: `generateChatSummary`, `resolveChatLimit` from Task 1.
- Produces: `database.getRecentPrivateMessages(username, peer, limit)` and `database.getRecentGroupMessages(group, limit)`, each `-> Promise<{from, text}[]>`, oldest first.
- Produces the wire format used by Task 3:
  - Request: `{ type: "summarize_chat", kind: "private" | "group", name: string }`
  - Reply: `{ type: "chat_summary", kind, name, text }` or `{ type: "chat_summary", kind, name, error }`

- [ ] **Step 1: Write the failing integration assertions**

`shutdown()` runs in the existing test's `t.after`, so extend that test, placing these after the line-124 Carol check and before Bob disconnects. Set `process.env.CHAT_LIMIT = "2"` at the top of the file with the other env values. Use a generator that records the prompt it received.

```js
// Group: Bob asks, gets it, last 2 messages only, nobody else receives it
bob.send({ type: "summarize_chat", kind: "group", name: "Networks" });
const summary = await bob.waitFor((e) => e.type === "chat_summary" && e.name === "Networks");
assert.equal(summary.text, "Test chatbot reply");
assert.ok(!capturedPrompt.includes("members only"));
assert.equal(alice.events.some((e) => e.type === "chat_summary"), false);

// Non-member is refused and the model isn't called
carol.send({ type: "summarize_chat", kind: "group", name: "Networks" });
assert.match((await carol.waitFor((e) => e.type === "chat_summary")).error, /member/i);

// Private: Carol has no messages with Alice; a self-chat is also empty
// Both return an error containing "no messages"

// Malformed: unknown kind and missing name return an error
// Model failure: a throwing generator gives the requester `error`, and a retry succeeds
// Pending: a held generator plus a second request gives `error` matching /already/i
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/chat.integration.test.js`
Expected: FAIL, the server replies "Unknown message type."

- [ ] **Step 3: Add the two queries to `database/database.js`**

Newest first with `LIMIT $n`, ordered by `sent_at DESC, id DESC`, then reversed. The private query matches both room user ids using `LEAST`/`GREATEST` of the two users' ids, so a self-chat only matches itself. The group query joins `chat_groups` by name. Membership is checked by the server.

- [ ] **Step 4: Handle `summarize_chat` in `server/server.js`**

- Add `const chatLimit = resolveChatLimit(process.env.CHAT_LIMIT)` and `const summarizingUsers = new Set()`.
- `case "summarize_chat"` validates synchronously, in this order, replying through a small `sendSummary(socket, kind, name, fields)` helper:
  1. `kind` is `private` or `group`, and `cleanText(message.name, 40)` is non-empty, else `error: "Choose a chat to summarize."`
  2. Group exists in `groups` and has the user, else `error: "Join this group before summarizing it."`
  3. User isn't in `summarizingUsers`, else `error: "A summary is already in progress."`
- Add the user to `summarizingUsers`, then call `runChatbotTask` with a task that loads messages, replies `error: "There are no messages to summarize yet."` when empty, otherwise generates and replies `text`.
- In the task, catch failures and reply `error: "Sorry, the summary could not be generated right now."`, logging the real error. Release the user in `finally`.
- Reply on the captured `socket`, not `clients.get(username)`, so a reconnected session can't receive an old request's result in the wrong state.

- [ ] **Step 5: Run to verify it passes**

Run: `docker compose up -d postgres`, then `node --test test/chat.integration.test.js`
Expected: PASS.

### Task 3: Button, card and docs

**Files:**
- Modify: `client/src/chatState.js`, `client/src/App.jsx`, `client/src/styles.css`, `.env.example`, `README.md`, `System_Architecture.md`
- Test: `test/chat-state.test.js`

**Interfaces:**
- Consumes: the Task 2 wire format.
- Produces: `applySummaryEvent(summaries, event) -> summaries` in `chatState.js`, where `summaries` maps `${kind}:${name}` to `{ pending?, text?, error? }`.

- [ ] **Step 1: Write the failing test**

```js
test("stores a summary by room and replaces the pending entry", () => {
  const next = applySummaryEvent({ "group:A": { pending: true } }, { kind: "group", name: "A", text: "S" });
  assert.deepEqual(next, { "group:A": { text: "S" } });
});

test("stores a summary error by room and leaves other rooms alone", () => {
  const next = applySummaryEvent({ "private:B": { text: "old" } }, { kind: "group", name: "A", error: "E" });
  assert.deepEqual(next, { "private:B": { text: "old" }, "group:A": { error: "E" } });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/chat-state.test.js`
Expected: FAIL, `applySummaryEvent is not a function`.

- [ ] **Step 3: Implement `applySummaryEvent`, then wire `App.jsx`**

- Add `summaries` state, and clear it on the `disconnected` event.
- Handle `chat_summary` in `events.onmessage` with `applySummaryEvent`.
- `summarize()` sets `pending: true` for the room, posts through `request("/api/action", ...)`, and on a thrown error stores `{ error: error.message }` for that room.
- In `chat-header`, group the existing `.members` text and a `Summarize` button (`disabled` while pending or when `currentMessages.length === 0`, label `Summarizing…` while pending) in a right-aligned wrapper.
- Under the header, render the active room's card: the text or error, with a dismiss button (`aria-label="Dismiss summary"`) that deletes the entry. Give the card `role="status"`.

- [ ] **Step 4: Add styles and docs**

- `styles.css`: `.chat-actions` and `.summary-card`, using the existing dark tokens and the `.message.bot` purple. Keep the button visible in the `720px` media query.
- `.env.example`: add `CHAT_LIMIT=50` under the Hugging Face block.
- `README.md`: add `CHAT_LIMIT` and a short Summarize section after the `@chatbot` usage, including that summaries are private, temporary and share the model queue.
- `System_Architecture.md`: add the `summarize_chat` example at line 92, with the `chat_summary` reply.

- [ ] **Step 5: Run everything**

Run: `npm test && npm run lint && npm run build`
Expected: all pass, with no lint errors.

- [ ] **Step 6: Try it in the real app**

Run the server, bridge and client, connect two users, and press Summarize with the real model. Check that the card appears for the requester only, dismisses, and disappears on refresh. Report the summary quality and time taken.
