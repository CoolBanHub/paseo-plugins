import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  chooseReadOnlyPermission,
  createCollabStore,
  formatCollabOpened,
  formatCollabStatus,
  guestCollabPrompt,
  guestTopicKey,
} from "../server/collab.ts";
import type { SessionProviderSnapshot } from "../server/sessions.ts";

const NOW = 1_700_000_000_000;

function withTempDir<T>(run: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "lark-collab-"));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function snapshot(provider: string, modes: { id: string; label: string }[]): SessionProviderSnapshot {
  return { entries: [{ provider, modes }] };
}

describe("collab store", () => {
  it("opens a named, topic-scoped grant and finds the guest", () => {
    withTempDir((dir) => {
      const store = createCollabStore(join(dir, "collab.json"), { now: () => NOW });
      const grant = store.open({
        chatId: "oc_group",
        topicKey: "om_topic",
        guests: [
          { openId: "ou_a", name: "张三" },
          { openId: "ou_a", name: "张三" },
        ],
        openedBy: "ou_owner",
        hours: 24,
        scope: "只看本话题进度",
        permission: "read-only",
        provider: "dsh",
      });
      assert.ok(grant);
      assert.equal(grant.guests.length, 1);
      assert.equal(grant.expiresAt, NOW + 24 * 3_600_000);
      assert.equal(store.active("oc_group", "om_topic")?.scope, "只看本话题进度");
      assert.equal(store.guest("oc_group", "om_topic", "ou_a")?.name, "张三");
      assert.equal(store.guest("oc_group", "om_topic", "ou_other"), null);
      assert.equal(store.active("oc_other", "om_topic"), null);
      assert.equal(store.active("oc_group", "om_other"), null);
    });
  });

  it("expires on time, prunes the grant, and allows reopening", () => {
    let now = NOW;
    withTempDir((dir) => {
      const store = createCollabStore(join(dir, "collab.json"), { now: () => now });
      store.open({
        chatId: "oc_group",
        topicKey: "om_topic",
        guests: [{ openId: "ou_a", name: "张三" }],
        openedBy: "ou_owner",
        hours: 1,
        scope: "",
        permission: "read-only",
        provider: "dsh",
      });
      now += 3_600_001;
      assert.equal(store.active("oc_group", "om_topic"), null);
      assert.equal(store.list("oc_group").length, 0);
      const reopened = store.open({
        chatId: "oc_group",
        topicKey: "om_topic",
        guests: [{ openId: "ou_b", name: "李四" }],
        openedBy: "ou_owner",
        hours: 24,
        scope: "复盘",
        permission: "read-only",
        provider: "dsh",
      });
      assert.equal(reopened?.guests[0]?.openId, "ou_b");
    });
  });

  it("replaces an existing grant for the same topic", () => {
    withTempDir((dir) => {
      const store = createCollabStore(join(dir, "collab.json"), { now: () => NOW });
      const base = {
        chatId: "oc_group",
        topicKey: "om_topic",
        openedBy: "ou_owner",
        hours: 24,
        permission: "read-only",
        provider: "dsh",
      };
      store.open({ ...base, guests: [{ openId: "ou_a", name: "张三" }], scope: "第一版" });
      store.open({ ...base, guests: [{ openId: "ou_b", name: "李四" }], scope: "第二版" });
      const active = store.active("oc_group", "om_topic");
      assert.equal(active?.guests[0]?.openId, "ou_b");
      assert.equal(active?.scope, "第二版");
      assert.equal(store.list("oc_group").length, 1);
    });
  });

  it("closes a grant and persists the state", () => {
    withTempDir((dir) => {
      const path = join(dir, "collab.json");
      const store = createCollabStore(path, { now: () => NOW });
      store.open({
        chatId: "oc_group",
        topicKey: "om_topic",
        guests: [{ openId: "ou_a", name: "张三" }],
        openedBy: "ou_owner",
        hours: 24,
        scope: "",
        permission: "plan",
        provider: "claude",
      });
      const reloaded = createCollabStore(path, { now: () => NOW });
      assert.equal(reloaded.active("oc_group", "om_topic")?.permission, "plan");
      assert.ok(reloaded.close("oc_group", "om_topic"));
      assert.equal(reloaded.active("oc_group", "om_topic"), null);
      assert.equal(reloaded.close("oc_group", "om_topic"), null);
    });
  });

  it("caps the requested duration and rejects empty guest lists", () => {
    withTempDir((dir) => {
      const store = createCollabStore(join(dir, "collab.json"), { now: () => NOW });
      const grant = store.open({
        chatId: "oc_group",
        topicKey: "om_topic",
        guests: [{ openId: "ou_a", name: "张三" }],
        openedBy: "ou_owner",
        hours: 999,
        scope: "",
        permission: "read-only",
        provider: "dsh",
      });
      assert.equal(grant?.expiresAt, NOW + 72 * 3_600_000);
      assert.equal(
        store.open({
          chatId: "oc_group",
          topicKey: "om_topic",
          guests: [],
          openedBy: "ou_owner",
          hours: 24,
          scope: "",
          permission: "read-only",
          provider: "dsh",
        }),
        null,
      );
    });
  });

  it("uses a sibling session key so guest context never mixes with the owner", () => {
    assert.equal(guestTopicKey("om_topic"), "om_topic::guest");
  });
});

describe("read-only permission", () => {
  it("always uses dsh's read-only preset", () => {
    assert.equal(chooseReadOnlyPermission("dsh", null), "read-only");
    assert.equal(chooseReadOnlyPermission("dsh/deepseek-v3", null), "read-only");
  });

  it("picks the plan mode advertised by Claude", () => {
    assert.equal(
      chooseReadOnlyPermission(
        "claude",
        snapshot("claude", [
          { id: "auto", label: "Auto mode" },
          { id: "plan", label: "Plan Mode" },
        ]),
      ),
      "plan",
    );
  });

  it("matches a localized plan label for providers such as ZCode", () => {
    assert.equal(
      chooseReadOnlyPermission(
        "zcode",
        snapshot("zcode", [
          { id: "build", label: "自主模式" },
          { id: "plan", label: "计划模式" },
        ]),
      ),
      "plan",
    );
  });

  it("refuses providers without a read-only mode (Codex)", () => {
    assert.equal(
      chooseReadOnlyPermission(
        "codex",
        snapshot("codex", [
          { id: "default", label: "Default Permissions" },
          { id: "full-access", label: "Full Access" },
        ]),
      ),
      null,
    );
  });

  it("falls back to plan for Claude when the snapshot is unavailable", () => {
    assert.equal(chooseReadOnlyPermission("claude", null), "plan");
    assert.equal(chooseReadOnlyPermission("codex", null), null);
  });
});

describe("collab text", () => {
  const grant = {
    chatId: "oc_group",
    topicKey: "om_topic",
    guests: [{ openId: "ou_a", name: "张三" }],
    openedBy: "ou_owner",
    openedAt: NOW,
    expiresAt: NOW + 24 * 3_600_000,
    scope: "只看本话题进度",
    permission: "read-only",
    provider: "dsh",
  };

  it("reports who, until when, and what is enforced", () => {
    const status = formatCollabStatus(grant, NOW);
    assert.match(status, /张三/);
    assert.match(status, /只看本话题进度/);
    assert.match(status, /只读模式/);
    assert.match(status, /访客需在本话题内 @ 我/);
    const opened = formatCollabOpened(grant, NOW);
    assert.match(opened, /已开启协作/);
    assert.match(opened, /关闭：`\/collab close`/);
  });

  it("writes a guest prompt with scope, expiry and the write refusal", () => {
    const prompt = guestCollabPrompt({
      name: "张三",
      openId: "ou_a",
      scope: "只看本话题进度",
      expiresAt: grant.expiresAt,
    });
    assert.match(prompt, /协作访客/);
    assert.match(prompt, /张三/);
    assert.match(prompt, /只看本话题进度/);
    assert.match(prompt, /只读/);
    assert.match(prompt, /这个要等负责人确认后我再处理/);
    assert.match(prompt, /不要透露其他项目/);
  });
});
