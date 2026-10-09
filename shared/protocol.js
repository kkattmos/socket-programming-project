const MAX_FRAME_SIZE = 1024 * 1024;

function encodeFrame(message) {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  if (payload.length > MAX_FRAME_SIZE) {
    throw new Error("Message is too large");
  }

  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

function createFrameDecoder(onMessage, onError = () => {}) {
  let buffered = Buffer.alloc(0);

  return (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);

    while (buffered.length >= 4) {
      const payloadLength = buffered.readUInt32BE(0);
      if (payloadLength > MAX_FRAME_SIZE) {
        onError(new Error("Incoming message is too large"));
        buffered = Buffer.alloc(0);
        return;
      }
      if (buffered.length < payloadLength + 4) return;

      const payload = buffered.subarray(4, payloadLength + 4);
      buffered = buffered.subarray(payloadLength + 4);

      try {
        onMessage(JSON.parse(payload.toString("utf8")));
      } catch {
        onError(new Error("Received invalid JSON"));
      }
    }
  };
}

module.exports = { MAX_FRAME_SIZE, encodeFrame, createFrameDecoder };
