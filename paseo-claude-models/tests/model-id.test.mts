import assert from "node:assert/strict";
import { test } from "node:test";
import { isMenuModel, isOwnModelEntry, isWindowVariant, menuModelId, modelIdPattern, ownModelDescription, vendorModelId } from "../shared/model-id.ts";

test("menu ids carry the prefix both ways", () => {
  assert.equal(menuModelId("glm-4.6"), "cm:glm-4.6");
  assert.equal(vendorModelId("cm:glm-4.6"), "glm-4.6");
  assert.equal(vendorModelId("claude-sonnet-4"), "claude-sonnet-4");
  assert.equal(isMenuModel("cm:glm-4.6"), true);
  assert.equal(isMenuModel("glm-4.6"), false);
  assert.equal(isMenuModel(undefined), false);
});

test("the [1m] window switch travels in ids and never reaches the vendor", () => {
  assert.equal(modelIdPattern.test("glm-5.3[1m]"), true);
  assert.equal(modelIdPattern.test("glm-5.3-flash[1m]"), true);
  assert.equal(modelIdPattern.test("deepseek-chat"), true);
  assert.equal(modelIdPattern.test("openai/gpt-4o"), true);
  assert.equal(modelIdPattern.test("qwen3-coder-plus"), true);
  // Only the exact window switch is allowed; anything else with brackets is not an id.
  assert.equal(modelIdPattern.test("glm-5.3[2m]"), false);
  assert.equal(modelIdPattern.test("glm-5.3[1M]"), false);
  assert.equal(modelIdPattern.test("glm-5.3[1m]x"), false);
  assert.equal(modelIdPattern.test("../etc/passwd"), false);
  assert.equal(modelIdPattern.test("a//b"), false);
  assert.equal(modelIdPattern.test("/leading"), false);
  assert.equal(modelIdPattern.test(""), false);
  assert.equal(vendorModelId("cm:glm-5.3-flash[1m]"), "glm-5.3-flash");
  assert.equal(vendorModelId("cm:glm-5.3[1M]"), "glm-5.3");
  assert.equal(isWindowVariant("cm:glm-5.3[1m]"), true);
  assert.equal(isWindowVariant("glm-5.3"), false);
});

test("own entries are recognised by their description marker", () => {
  assert.equal(isOwnModelEntry({ id: "cm:x", label: "X", description: ownModelDescription("GLM") }), true);
  assert.equal(isOwnModelEntry({ id: "cm:x", label: "X", description: "自己加的" }), false);
  assert.equal(isOwnModelEntry({ id: "cm:x", label: "X" }), false);
  assert.equal(isOwnModelEntry(null), false);
});
