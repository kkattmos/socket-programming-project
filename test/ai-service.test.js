const test = require("node:test");
const assert = require("node:assert/strict");
const {
  containsChatbotMention,
  extractPrompt,
  generateChatbotReply,
  generateChatSummary,
  resolveChatLimit,
  setGeneratorForTests,
} = require("../shared/ai-service");

function captureSummaryPrompt() {
  const captured = {};
  setGeneratorForTests(async (messages) => {
    captured.prompt = messages.at(-1).content;
    return [{ generated_text: [...messages, { role: "assistant", content: "A short summary." }] }];
  });
  return captured;
}

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

test("resolves CHAT_LIMIT to a positive integer or the default", () => {
  assert.equal(resolveChatLimit("20"), 20);
  for (const bad of [undefined, "", "0", "-3", "2.5", "many"]) assert.equal(resolveChatLimit(bad), 50);
});

test("builds a summary prompt that keeps speakers, order and mentions", async () => {
  const captured = captureSummaryPrompt();
  const reply = await generateChatSummary([
    { from: "Alice", text: "@chatbot hi" },
    { from: "Bob", text: "bye" },
  ]);

  assert.match(captured.prompt, /- Alice said: "@chatbot hi"\n- Bob said: "bye"/);
  assert.match(captured.prompt, /^Here is a chat log:/);
  assert.match(captured.prompt, /Write a 2-3 sentence summary of this chat log in the third person/);
  assert.equal(reply, "A short summary.");
});

test("caps summary input and keeps the newest messages", async () => {
  const captured = captureSummaryPrompt();
  const messages = Array.from({ length: 10 }, (_, index) => ({
    from: "Alice",
    text: `msg${index} ${"x".repeat(1990)}`,
  }));
  await generateChatSummary(messages);

  const log = captured.prompt.split("\n\n")[1];
  assert.ok(log.length <= 6000);
  assert.ok(captured.prompt.includes("msg9"));
  assert.ok(!captured.prompt.includes("msg0"));
});
