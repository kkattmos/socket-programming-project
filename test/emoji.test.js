const test = require("node:test");
const assert = require("node:assert/strict");
const { MAX_EMOJI_LENGTH, isSingleEmoji } = require("../shared/emoji");

test("accepts one emoji, including flags, keycaps, ZWJ sequences and skin tones", () => {
  for (const emoji of ["👍", "❤️", "😂", "🇹🇭", "1️⃣", "👩🏽‍❤️‍💋‍👨🏿", "🏴󠁧󠁢󠁥󠁮󠁧󠁿", "☺"]) {
    assert.equal(isSingleEmoji(emoji), true, emoji);
  }
});

test("rejects text, several emoji, padding and non-strings", () => {
  for (const value of ["", "a", "ก", "ok", "👍👍", " 👍", "👍 ", null, undefined, 5, {}, ["👍"]]) {
    assert.equal(isSingleEmoji(value), false, String(value));
  }
});

test("rejects anything longer than the length cap", () => {
  assert.equal(isSingleEmoji("👍".repeat(MAX_EMOJI_LENGTH)), false);
});

test("every emoji the reaction picker offers is accepted by the server's rule", async () => {
  const { QUICK_REACTIONS, MORE_REACTIONS } = await import("../client/src/reactionEmoji.js");
  const offered = [...QUICK_REACTIONS, ...MORE_REACTIONS];
  for (const emoji of offered) assert.equal(isSingleEmoji(emoji), true, emoji);
  assert.equal(new Set(offered).size, offered.length, "no emoji is offered twice");
});
