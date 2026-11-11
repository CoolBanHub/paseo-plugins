import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  enrichUnmatchedChats,
  resetPeerProfileCacheForTests,
  type PeerLookup,
} from "../server/peer.ts";

function makeLookup(overrides: Partial<PeerLookup> = {}) {
  const calls = { members: [] as string[], profiles: [] as string[], departments: [] as string[], tenants: 0 };
  const lookup: PeerLookup = {
    listMembers: async (chatId) => {
      calls.members.push(chatId);
      return [{ openId: "ou_peer", name: "赖大昌" }];
    },
    readProfile: async (openId) => {
      calls.profiles.push(openId);
      return { openId, name: "赖大昌", departmentId: "od-dept" };
    },
    readDepartmentPath: async (departmentId) => {
      calls.departments.push(departmentId);
      return "示例公司 / 研发中心";
    },
    readTenantName: async () => {
      calls.tenants += 1;
      return "示例公司";
    },
    ...overrides,
  };
  return { lookup, calls };
}

beforeEach(() => {
  resetPeerProfileCacheForTests();
});

describe("enrichUnmatchedChats", () => {
  it("resolves a p2p peer name, department path and organization", async () => {
    const { lookup, calls } = makeLookup();
    const [entry] = await enrichUnmatchedChats(
      null,
      [{ chatId: "oc_p2p", chatType: "p2p", lastSeenAt: 1 }],
      lookup,
    );
    assert.equal(entry?.peerName, "赖大昌");
    assert.equal(entry?.peerOpenId, "ou_peer");
    assert.equal(entry?.peerDepartment, "示例公司 / 研发中心");
    assert.equal(entry?.peerOrganization, "示例公司");
    assert.deepEqual(calls.members, ["oc_p2p"]);
    assert.deepEqual(calls.profiles, ["ou_peer"]);
    assert.deepEqual(calls.departments, ["od-dept"]);
    assert.equal(calls.tenants, 1);
  });

  it("falls back to the sender open_id when the members API is unavailable", async () => {
    const { lookup } = makeLookup({
      listMembers: async () => {
        throw new Error("im:chat.members:read missing");
      },
      readProfile: async (openId) => ({ openId, name: "张三", departmentId: null }),
      readTenantName: async () => null,
    });
    const [entry] = await enrichUnmatchedChats(
      null,
      [{ chatId: "oc_p2p_fallback", chatType: "p2p", lastSeenAt: 1, peerOpenId: "ou_fallback" }],
      lookup,
    );
    assert.equal(entry?.peerOpenId, "ou_fallback");
    assert.equal(entry?.peerName, "张三");
    assert.equal(entry?.peerDepartment, undefined);
    assert.equal(entry?.peerOrganization, undefined);
  });

  it("keeps the member name when contact fields are unavailable", async () => {
    const { lookup } = makeLookup({
      readProfile: async () => {
        throw new Error("contact scope missing");
      },
      readTenantName: async () => null,
    });
    const [entry] = await enrichUnmatchedChats(
      null,
      [{ chatId: "oc_p2p_contact_missing", chatType: "p2p", lastSeenAt: 1 }],
      lookup,
    );
    assert.equal(entry?.peerName, "赖大昌");
    assert.equal(entry?.peerDepartment, undefined);
    assert.equal(entry?.peerOrganization, undefined);
  });

  it("does not touch group chats and caches repeated lookups", async () => {
    const { lookup, calls } = makeLookup();
    const groups = await enrichUnmatchedChats(
      null,
      [{ chatId: "oc_group", chatType: "group", lastSeenAt: 1 }],
      lookup,
    );
    assert.deepEqual(groups, [{ chatId: "oc_group", chatType: "group", lastSeenAt: 1 }]);
    assert.equal(calls.members.length, 0);

    const entry = { chatId: "oc_p2p_cached", chatType: "p2p", lastSeenAt: 1 };
    await enrichUnmatchedChats(null, [entry], lookup);
    await enrichUnmatchedChats(null, [entry], lookup);
    assert.equal(calls.members.length, 1, "the second status call must use the cache");
    assert.equal(calls.tenants, 1, "the tenant name is cached across chats");
  });
});
