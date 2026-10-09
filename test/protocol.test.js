const test = require("node:test");
const assert = require("node:assert/strict");
const { encodeFrame, createFrameDecoder } = require("../shared/protocol");

test("decodes a frame split across chunks", () => {
  const received = [];
  const decode = createFrameDecoder((message) => received.push(message));
  const frame = encodeFrame({ type: "message", text: "hello" });
  decode(frame.subarray(0, 3));
  decode(frame.subarray(3, 9));
  decode(frame.subarray(9));
  assert.deepEqual(received, [{ type: "message", text: "hello" }]);
});

test("decodes multiple frames from one chunk", () => {
  const received = [];
  const decode = createFrameDecoder((message) => received.push(message));
  decode(Buffer.concat([encodeFrame({ id: 1 }), encodeFrame({ id: 2 })]));
  assert.deepEqual(received, [{ id: 1 }, { id: 2 }]);
});
