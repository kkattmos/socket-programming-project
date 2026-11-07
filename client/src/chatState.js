function validString(value) {
  return typeof value === "string" && value.length > 0;
}

function normalizeMessage(message) {
  if (!message || !validString(message.type) || !validString(message.from) || !validString(message.text)) return null;
  if (message.type === "private_message" && !validString(message.to)) return null;
  if (message.type === "group_message" && !validString(message.group)) return null;
  if (!validString(message.timestamp) && !(message.timestamp instanceof Date)) return null;
  return { ...message, id: message.id == null ? null : String(message.id) };
}

function identity(message) {
  return message.id
    ? `${message.type}:${message.id}`
    : `${message.type}:${message.from}:${message.to || message.group}:${message.timestamp}:${message.text}`;
}

function privatePeer(message, currentName) {
  if (Array.isArray(message.roomUsers) && message.roomUsers.includes(currentName)) {
    return message.roomUsers.find((name) => name !== currentName) || currentName;
  }
  return message.from === currentName ? message.to : message.from;
}

export function mergeChatMessages(current, incoming, currentName) {
  const next = { ...current };

  for (const candidate of Array.isArray(incoming) ? incoming : []) {
    const message = normalizeMessage(candidate);
    if (!message) continue;

    const peer = message.type === "private_message"
      ? privatePeer(message, currentName)
      : message.group;
    const room = `${message.type === "private_message" ? "private" : "group"}:${peer}`;
    const roomMessages = next[room] || [];
    const existingIndex = roomMessages.findIndex((existing) => identity(existing) === identity(message));
    if (existingIndex !== -1) {
      // Already known: only refresh its reactions, e.g. from a snapshot after the event stream reconnected.
      if (Array.isArray(message.reactions)) {
        next[room] = roomMessages.map((existing, index) => (
          index === existingIndex ? { ...existing, reactions: message.reactions } : existing
        ));
      }
      continue;
    }

    next[room] = [...roomMessages, message].sort(
      (left, right) => new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime(),
    );
  }

  return next;
}

export function historyMessages(history) {
  if (!history || typeof history !== "object") return [];
  return [
    ...(Array.isArray(history.privateMessages) ? history.privateMessages : []),
    ...(Array.isArray(history.groupMessages) ? history.groupMessages : []),
  ];
}

export function applySummaryEvent(summaries, event) {
  const { kind, name, text, error } = event;
  return { ...summaries, [`${kind}:${name}`]: error ? { error } : { text } };
}

// The server sends the full reaction list for one message; replace it wherever that message is shown.
export function applyReactionUpdate(messages, event) {
  if (!event || event.messageId == null || !Array.isArray(event.reactions)) return messages;
  const messageId = String(event.messageId);
  let next = messages;
  for (const [room, roomMessages] of Object.entries(messages)) {
    const index = roomMessages.findIndex((message) => message.type === event.messageType && message.id === messageId);
    if (index === -1) continue;
    if (next === messages) next = { ...messages };
    next[room] = roomMessages.map((message, position) => (
      position === index ? { ...message, reactions: event.reactions } : message
    ));
  }
  return next;
}

// Drops malformed entries so rendering never crashes on bad data.
export function safeReactions(value) {
  return Array.isArray(value)
    ? value.filter((reaction) => (
      reaction
      && typeof reaction.emoji === "string"
      && Array.isArray(reaction.users)
      && reaction.users.length > 0
    ))
    : [];
}
