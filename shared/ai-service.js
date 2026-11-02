const path = require("node:path");

const CHATBOT_NAME = "Chatbot";
const CHATBOT_MENTION = /@chatbot\b/i;
const DEFAULT_MODEL = "HuggingFaceTB/SmolLM2-360M-Instruct";
const SYSTEM_PROMPT = [
  "You are Chatbot, a cheerful and supportive assistant inside a private or group chat.",
  "Answer the user's request directly and concisely.",
  "Do not claim to see messages or users outside the current chat.",
].join(" ");
let generatorPromise = null;
let generationQueue = Promise.resolve();

function containsChatbotMention(text) {
  return typeof text === "string" && CHATBOT_MENTION.test(text);
}

function extractPrompt(text) {
  const prompt = String(text || "").replace(CHATBOT_MENTION, "").replace(/\s+/g, " ").trim();
  return prompt || "Say hello and ask how you can help.";
}

async function getGenerator(options = {}) {
  if (options.generator) return options.generator;
  if (!generatorPromise) {
    generatorPromise = import("@huggingface/transformers").then(async ({ env, pipeline }) => {
      env.cacheDir = process.env.HF_CACHE_DIR || path.join(process.cwd(), ".cache", "huggingface");
      env.allowRemoteModels = process.env.HF_ALLOW_REMOTE_MODELS !== "false";
      if (process.env.HF_LOCAL_MODEL_PATH) env.localModelPath = process.env.HF_LOCAL_MODEL_PATH;

      return pipeline(
        "text-generation",
        options.model || process.env.HF_LOCAL_MODEL || DEFAULT_MODEL,
        { dtype: options.dtype || process.env.HF_DTYPE || "q4" },
      );
    }).catch((error) => {
      generatorPromise = null;
      throw error;
    });
  }
  return generatorPromise;
}

function extractGeneratedText(output) {
  const generated = output?.[0]?.generated_text;
  if (Array.isArray(generated)) return generated.at(-1)?.content;
  if (typeof generated === "string") return generated;
  return null;
}

async function runGeneration(text, options) {
  const generator = await getGenerator(options);
  const output = await generator([
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: extractPrompt(text) },
  ], {
    max_new_tokens: Number(process.env.HF_MAX_NEW_TOKENS || 200),
    do_sample: true,
    temperature: 0.4,
    top_p: 0.9,
    repetition_penalty: 1.1,
  });

  const reply = extractGeneratedText(output);
  if (typeof reply !== "string" || !reply.trim()) throw new Error("The local model returned an empty reply");
  return reply.trim().slice(0, 2000);
}

function generateChatbotReply(text, options = {}) {
  const operation = () => runGeneration(text, options);
  const result = generationQueue.then(operation, operation);
  generationQueue = result.catch(() => {});
  return result;
}

function setGeneratorForTests(generator) {
  generatorPromise = Promise.resolve(generator);
  generationQueue = Promise.resolve();
}

module.exports = {
  CHATBOT_NAME,
  containsChatbotMention,
  extractPrompt,
  generateChatbotReply,
  setGeneratorForTests,
};
