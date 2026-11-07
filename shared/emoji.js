// One rule for "is this a single emoji?", shared by the server (authority), the client (instant feedback) and tests.
const MAX_EMOJI_LENGTH = 16; // UTF-16 code units; the longest real emoji we tested (👩🏽‍❤️‍💋‍👨🏿) is 15

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const RGI_EMOJI = /^\p{RGI_Emoji}$/v; // full emoji sequences, including flags (🇹🇭) and keycaps (1️⃣)
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u; // pictographs the RGI list misses, e.g. ☺ without U+FE0F

function isSingleEmoji(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_EMOJI_LENGTH) return false;
  if ([...graphemes.segment(value)].length !== 1) return false;
  return RGI_EMOJI.test(value) || PICTOGRAPHIC.test(value);
}

module.exports = { MAX_EMOJI_LENGTH, isSingleEmoji };
