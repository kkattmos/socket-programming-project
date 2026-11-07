# Chat summary design

## Intent

Let a person catch up on any private or group chat by pressing one button. The summary is for them alone.

## Goals

- A button at the top right of the open chat summarizes its last `CHAT_LIMIT` messages.
- Only the person who pressed it sees the result.
- It uses the Hugging Face model already in the project.

## Non-goals

- Saving summaries. One disappears when dismissed or when the page refreshes.
- Choosing a date range or message count from the UI.
- A second model.

## Anti-goals

- A summary reaching anyone but the requester.
- Summarizing a chat the requester isn't allowed to read.
- A summary holding up that user's normal chat messages while the model runs.

## Approaches

1. **Existing SmolLM2 (picked by the user).** Same loaded model and queue with a new prompt. Almost no new code or memory; quality may be rough, and it can invent details.
2. **Dedicated summarization model.** Built for the job, but adds a download, memory and a config setting, and is usually trained on articles rather than chat.

Dropped: the browser sending its own copy of the messages, because the server couldn't trust that text.

## Decided by the user

- `CHAT_LIMIT` means the last N messages in the open chat.
- Summaries are temporary: gone on dismiss or refresh.
- The model is the existing SmolLM2.

## Flow

1. The button posts `{ type: "summarize_chat", kind: "private" | "group", name }` through the existing `/api/action` route.
2. The server checks access, loads the last `CHAT_LIMIT` messages from PostgreSQL, and runs generation as a background task with `runChatbotTask`, so the socket's message queue keeps moving.
3. The server replies to the requester's socket only with `{ type: "chat_summary", kind, name, text }`, or `{ type: "chat_summary", kind, name, error }` on failure.
4. The bridge needs no change. It already forwards the event, and it doesn't store it, so a refresh clears the summary.

## Calls made by Claude (please check)

- **`CHAT_LIMIT`:** an env setting, documented in `.env.example`, default 50. Invalid values fall back to 50.
- **Button:** labelled "Summarize", at the right of `chat-header`. Disabled while a summary is pending or the chat has no messages.
- **Display:** a dismissible card under the header, kept per chat, so switching chats doesn't lose it.
- **Access:** group summaries require membership. Private summaries only read messages from the requester's own room with that person, and work when that person is offline.
- **Included messages:** everything in the chat, including Chatbot replies.
- **Input size:** the text sent to the model is capped by a constant, keeping the newest messages when `CHAT_LIMIT` messages are too long. This is a known limit and gets a `shortcut:` comment.
- **Repeat requests:** one pending summary per user. A second request gets an error, since a refresh clears the button's disabled state and each summary takes a place in the shared model queue.
- **Separate prompt path:** summaries can't use `extractPrompt`, which strips `@chatbot` and collapses line breaks, so `generateChatSummary` builds its own prompt and shares the queue with `generateChatbotReply`.
- **Failures:** model errors show in the card, with a short message, and clear the pending state.

## Changes

- `shared/ai-service.js`: add `generateChatSummary`, sharing the existing queue.
- `database/database.js`: add a query for a chat's last N messages.
- `server/server.js`: handle `summarize_chat`.
- `client/src/App.jsx`, `client/src/styles.css`: button, card, pending state.
- `.env.example`, `README.md`, `System_Architecture.md`: document the setting and message type.
- `test/ai-service.test.js`, `test/chat.integration.test.js`: cover the prompt, the requester-only delivery, and the non-member rejection.

## Left to the builder

- Exact prompt wording, and the input cap value.
- Card styling, following `styles.css`.

## Known risks

- Summary quality on SmolLM2 is unproven, and the model can invent details.
- Chat text goes into the prompt, so a message could try to steer the summary. The result only reaches the requester, which limits the harm.
- Summaries wait behind `@chatbot` replies in the single model queue, and on a CPU they may be slow.
