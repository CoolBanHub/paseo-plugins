import assert from "node:assert/strict";
import { test } from "node:test";
import { isMenuModel, isOwnModelEntry, menuModelId, modelIdPattern, ownModelDescription, vendorModelId } from "../shared/model-id.ts";

test("menu ids carry the prefix both ways", () => {
  assert.equal(menuModelId("glm-4.6"), "cm:glm-4.6");
  assert.equal(vendorModelId("cm:glm-4.6"), "glm-4.6");
  assert.equal(vendorModelId("claude-sonnet-4"), "claude-sonnet-4");
  assert.equal(isMenuModel("cm:glm-4.6"), true);
  assert.equal(isMenuModel("glm-4.6"), false);
  assert.equal(isMenuModel(undefined), false);
});

test("model ids reject traversal and odd shapes", () => {
  assert.equal(modelIdPattern.test("deepseek-chat"), true);
  assert.equal(modelIdPattern.test("openai/gpt-4o"), true);
  assert.equal(modelIdPattern.test("qwen3-coder-plus"), true);
  assert.equal(modelIdPattern.test("../etc/passwd"), false);
  assert.equal(modelIdPattern.test("a//b"), false);
  assert.equal(modelIdPattern.test("/leading"), false);
  assert.equal(modelIdPattern.test(""), false);
});

test("own entries are recognised by their description marker", () => {
  assert.equal(isOwnModelEntry({ id: "cm:x", label: "X", description: ownModelDescription("GLM") }), true);
  assert.equal(isOwnModelEntry({ id: "cm:x", label: "X", description: "自己加的" }), false);
  assert.equal(isOwnModelEntry({ id: "cm:x", label: "X" }), false);
  assert.equal(isOwnModelEntry(null), false);
});
