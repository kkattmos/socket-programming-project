const test = require("node:test");
const assert = require("node:assert/strict");
const {
  containsChatbotMention,
  extractPrompt,
  generateChatbotReply,
} = require("../shared/ai-service");

test("detects the chatbot mention anywhere in a message", () => {
  assert.equal(containsChatbotMention("hello @chatbot help me"), true);
  assert.equal(containsChatbotMention("@CHATBOT explain TCP"), true);
  assert.equal(containsChatbotMention("hello chatbot"), false);
  assert.equal(extractPrompt("hello @chatbot explain TCP"), "hello explain TCP");
});

test("runs a local Transformers.js chat generation pipeline", async () => {
  let request;
  const reply = await generateChatbotReply("@chatbot explain sockets", {
    generator: async (messages, options) => {
      request = { messages, options };
      return [{
        generated_text: [...messages, {
          role: "assistant",
          content: "A socket is a communication endpoint.",
        }],
      }];
    },
  });

  assert.equal(reply, "A socket is a communication endpoint.");
  assert.equal(request.messages.at(-1).content, "explain sockets");
  assert.equal(request.options.max_new_tokens, 200);
});
