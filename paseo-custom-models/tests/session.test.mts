import assert from "node:assert/strict";
import { test } from "node:test";
import { claudeDefaults, claudeModelFor, cleanEnvironment, MODEL_SELECTED_ENV, modelFamilies, sessionModels, takeSelectedMarker } from "../server/session.ts";
import { menuModelId } from "../shared/model-id.ts";

const glmModels = sessionModels([
  { id: "glm-5.3" },
  { id: "glm-4.5-air", contextWindow: 204800 },
  { id: "glm-4.6", contextWindow: 204800 },
]);

test("model families pick strong and fast by suffix", () => {
  const families = modelFamilies(glmModels);
  // No pro/max suffix and no preference: the first listed model is strong.
  assert.equal(families.strong, "cm:glm-5.3");
  assert.equal(families.fast, "cm:glm-4.5-air");
  const preferred = modelFamilies(glmModels, "cm:glm-4.6");
  assert.equal(preferred.strong, "cm:glm-4.6");
});

test("unknown names map onto the same kind of model", () => {
  assert.equal(claudeModelFor("cm:glm-4.6", glmModels), "cm:glm-4.6");
  assert.equal(claudeModelFor("claude-3-5-haiku-latest", glmModels), "cm:glm-4.5-air");
  assert.equal(claudeModelFor("claude-sonnet-4", glmModels, "cm:glm-4.6"), "cm:glm-4.6");
  assert.equal(claudeModelFor(undefined, glmModels), null);
});

test("defaults name the aliases and honor the real context window", () => {
  const env = claudeDefaults(glmModels, "cm:glm-4.6");
  assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, "cm:glm-4.6");
  assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, "cm:glm-4.6");
  assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, "cm:glm-4.5-air");
  assert.equal(env.CLAUDE_CODE_SUBAGENT_MODEL, "cm:glm-4.5-air");
  assert.equal(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, "204800");
  assert.equal(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "204800");
  // Without a known window the compaction vars stay unset (200k default).
  assert.equal("CLAUDE_CODE_AUTO_COMPACT_WINDOW" in claudeDefaults(glmModels, "cm:glm-5.3"), false);
});

test("cleanEnvironment empties inherited credentials, overlay included", () => {
  process.env.DEEPSEEK_TEST_LEAK = "sk-leaky"; // eslint-disable-line no-process-env
  const cleaned = cleanEnvironment({
    ANTHROPIC_API_KEY: "sk-should-clear",
    ANTHROPIC_BASE_URL: "https://elsewhere.example.com",
    PATH: "/usr/bin",
    AWS_SESSION_TOKEN: "leak",
  });
  assert.equal(cleaned.ANTHROPIC_API_KEY, "");
  assert.equal(cleaned.ANTHROPIC_BASE_URL, "");
  assert.equal(cleaned.AWS_SESSION_TOKEN, "");
  assert.equal(cleaned.PATH, "/usr/bin");
  assert.equal("DEEPSEEK_TEST_LEAK" in cleaned, true);
  assert.equal(cleaned.DEEPSEEK_TEST_LEAK, "");
  delete process.env.DEEPSEEK_TEST_LEAK;
});

test("the selection marker is split out of the env", () => {
  const { env, selected } = takeSelectedMarker({ [MODEL_SELECTED_ENV]: menuModelId("glm-4.6"), OTHER: "x" });
  assert.equal(selected, "cm:glm-4.6");
  assert.deepEqual(env, { OTHER: "x" });
  const empty = takeSelectedMarker({ OTHER: "x" });
  assert.equal(empty.selected, undefined);
});
