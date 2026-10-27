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

export function mergeChatMessages(current, incoming, currentName) {
  const next = { ...current };

  for (const candidate of Array.isArray(incoming) ? incoming : []) {
    const message = normalizeMessage(candidate);
    if (!message) continue;

    const peer = message.type === "private_message"
      ? (message.from === currentName ? message.to : message.from)
      : message.group;
    const room = `${message.type === "private_message" ? "private" : "group"}:${peer}`;
    const roomMessages = next[room] || [];
    if (roomMessages.some((existing) => identity(existing) === identity(message))) continue;

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
