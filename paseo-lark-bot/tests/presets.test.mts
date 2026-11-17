import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { REPLY_INSTRUCTION_PRESETS } from "../shared/presets.ts";

describe("reply instruction presets", () => {
  it("ships the two team-baseline presets with unique ids", () => {
    assert.deepEqual(
      REPLY_INSTRUCTION_PRESETS.map((preset) => preset.id),
      ["concise", "boundaries"],
    );
    assert.equal(new Set(REPLY_INSTRUCTION_PRESETS.map((preset) => preset.label)).size, 2);
  });

  it("keeps the concise preset focused on one screen and three asks", () => {
    const text = REPLY_INSTRUCTION_PRESETS.find((preset) => preset.id === "concise")?.text ?? "";
    assert.match(text, /手机一屏/);
    assert.match(text, /最多 3 条/);
    assert.match(text, /绝对路径/);
    assert.match(text, /刷新最新状态/);
  });

  it("keeps the boundary preset explicit about the red lines", () => {
    const text = REPLY_INSTRUCTION_PRESETS.find((preset) => preset.id === "boundaries")?.text ?? "";
    assert.match(text, /花钱/);
    assert.match(text, /删除或覆盖/);
    assert.match(text, /共享\/全局配置/);
    assert.match(text, /main/);
    assert.match(text, /一次授权只覆盖一次操作/);
  });

  it("stays short enough to paste into a chat prompt", () => {
    for (const preset of REPLY_INSTRUCTION_PRESETS) {
      assert.ok(preset.text.length > 100, `${preset.id} should carry real rules`);
      assert.ok(preset.text.length < 1_200, `${preset.id} should stay compact`);
    }
  });
});
