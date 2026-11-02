const test = require("node:test");
const assert = require("node:assert/strict");
const {
  containsChatbotMention,
  extractPrompt,
  generateChatbotReply,
  setGeneratorForTests,
} = require("../shared/ai-service");

test("detects the chatbot mention anywhere in a message", () => {
  assert.equal(containsChatbotMention("hello @chatbot help me"), true);
  assert.equal(containsChatbotMention("@CHATBOT explain TCP"), true);
  assert.equal(containsChatbotMention("hello chatbot"), false);
  assert.equal(extractPrompt("hello @chatbot explain TCP"), "hello explain TCP");
});

test("reuses one loaded Transformers.js pipeline for multiple generations", async () => {
  const requests = [];
  const generator = async (messages, options) => {
    requests.push({ messages, options });
    return [{
      generated_text: [...messages, {
        role: "assistant",
        content: "A socket is a communication endpoint.",
      }],
    }];
  };
  setGeneratorForTests(generator);
  const firstReply = await generateChatbotReply("@chatbot explain sockets");
  const secondReply = await generateChatbotReply("@chatbot explain TCP");

  assert.equal(firstReply, "A socket is a communication endpoint.");
  assert.equal(secondReply, "A socket is a communication endpoint.");
  assert.equal(requests[0].messages.at(-1).content, "explain sockets");
  assert.equal(requests[1].messages.at(-1).content, "explain TCP");
  assert.equal(requests[0].options.max_new_tokens, 200);
});
