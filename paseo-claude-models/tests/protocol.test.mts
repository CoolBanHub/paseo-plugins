import assert from "node:assert/strict";
import { test } from "node:test";
import { anthropicToChat } from "../server/protocol/anthropic-to-chat.ts";
import { estimateAnthropicInputTokens } from "../server/protocol/estimate.ts";

const anthropicRequest = {
  model: "cm:glm-4.6",
  max_tokens: 1024,
  stream: true,
  system: "You are helpful.",
  messages: [
    { role: "user", content: [{ type: "text", text: "你好" }] },
    { role: "assistant", content: [{ type: "text", text: "你好！" }] },
    { role: "user", content: [{ type: "text", text: "讲个笑话" }] },
  ],
  tools: [{
    name: "get_weather",
    description: "查天气",
    input_schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
  }],
};

test("upstream path mapping", () => {
  assert.equal(anthropicToChat.upstreamPath("v1/messages"), "v1/chat/completions");
  assert.equal(anthropicToChat.upstreamPath("v1/messages?beta=true"), "v1/chat/completions");
  assert.equal(anthropicToChat.upstreamPath("v1/messages/count_tokens"), null);
});

test("request conversion: messages, system and model", () => {
  const options = { model: "glm-4.6", clientRequest: anthropicRequest as Record<string, unknown> };
  const outgoing = anthropicToChat.request(anthropicRequest as Record<string, unknown>, options) as Record<string, any>;
  assert.equal(outgoing.model, "glm-4.6");
  assert.equal(outgoing.stream, true);
  const messages = outgoing.messages as Array<Record<string, any>>;
  assert.equal(messages[0]!.role, "system");
  assert.equal(messages[0]!.content, "You are helpful.");
  assert.equal(messages.length, 4);
  const tools = outgoing.tools as Array<Record<string, any>>;
  assert.equal(tools[0]!.function.name, "get_weather");
  assert.ok(JSON.stringify(tools[0]!.function.parameters).includes("city"));
});

test("stream conversion: chat deltas become anthropic events", () => {
  const options = { model: "glm-4.6", clientRequest: anthropicRequest as Record<string, unknown> };
  const converter = anthropicToChat.stream(options);
  const chunks = [
    `data: ${JSON.stringify({ id: "c1", choices: [{ index: 0, delta: { role: "assistant", content: "为什么" } }] })}\n\n`,
    `data: ${JSON.stringify({ id: "c1", choices: [{ index: 0, delta: { content: "程序员怕海？" } }] })}\n\n`,
    `data: ${JSON.stringify({ id: "c1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\n`,
    "data: [DONE]\n\n",
  ];
  let text = "";
  for (const chunk of chunks) text += converter.push(chunk);
  text += converter.end();
  // Frames are named ("event: message_start"), so pull the data lines out.
  const events = text.split("\n\n")
    .flatMap((frame) => frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()))
    .filter(Boolean)
    .map((data) => JSON.parse(data));
  assert.equal(events[0]!.type, "message_start");
  const starts = events.filter((event) => event.type === "content_block_start");
  assert.equal(starts.length, 1);
  assert.equal(starts[0]!.content_block.type, "text");
  const deltas = events.filter((event) => event.type === "content_block_delta");
  assert.deepEqual(deltas.map((event) => event.delta.text), ["为什么", "程序员怕海？"]);
  assert.equal(events.at(-1)!.type, "message_stop");
  const messageDelta = events.find((event) => event.type === "message_delta");
  assert.equal(messageDelta!.delta.stop_reason, "end_turn");
});

test("error conversion keeps the status and an anthropic shape", () => {
  const converted = anthropicToChat.error(429, { error: { message: "rate limited", code: 429 } });
  assert.equal(converted.type, "error");
  assert.equal((converted.error as Record<string, unknown>).type, "rate_limit_error");
});

test("count estimate grows with content and counts CJK denser", () => {
  const ascii = estimateAnthropicInputTokens({ messages: [{ role: "user", content: "hello world" }] });
  const cjk = estimateAnthropicInputTokens({ messages: [{ role: "user", content: "你好世界" }] });
  assert.ok(ascii >= 3);
  // Four CJK characters cost more tokens than four ASCII characters would.
  assert.ok(cjk > ascii);
  const withImage = estimateAnthropicInputTokens({ messages: [{ role: "user", content: [{ type: "image", source: { data: "aGk=" } }] }] });
  assert.ok(withImage >= 1600);
});
