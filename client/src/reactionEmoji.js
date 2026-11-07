// Emoji offered by the reaction picker. Plain characters, no library; every one must pass shared/emoji.js
// (test/emoji.test.js checks this), because the server rejects anything that isn't a single emoji.
export const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🙏"];

export const MORE_REACTIONS = [
  // Faces
  "😀", "😃", "😄", "😁", "😆", "😅", "🤣", "😊",
  "😇", "🙂", "😉", "😍", "🥰", "😘", "😋", "😎",
  "🤩", "🥳", "🤔", "😐", "😴", "😭", "😡", "🤯",
  // Hands
  "👎", "👏", "🙌", "👌", "✌️", "🤞", "👋", "💪",
  // Hearts
  "🧡", "💛", "💚", "💙", "💜", "🖤", "💔", "💯",
  // Symbols
  "🔥", "✨", "🎉", "✅", "❌", "⭐", "💡", "👀",
];
