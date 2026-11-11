import {
  listChatMembers,
  readDepartmentPath,
  readTenantName,
  readUserProfile,
  type LarkChatMember,
  type LarkUserProfile,
} from "./lark.ts";

/**
 * One recently seen chat that has no binding yet. `peerOpenId` is captured
 * from the last inbound p2p message so the settings list can still show an
 * open_id fallback when the members API is unavailable.
 */
export interface UnmatchedChat {
  chatId: string;
  chatType: string;
  lastSeenAt: number;
  peerOpenId?: string;
  peerName?: string;
  peerDepartment?: string;
  peerOrganization?: string;
}

export interface PeerProfile {
  chatId: string;
  openId: string;
  name: string;
  department: string | null;
  organization: string | null;
}

/** Injectable surface so the lookup logic can be tested without lark-cli. */
export interface PeerLookup {
  listMembers(chatId: string): Promise<LarkChatMember[]>;
  readProfile(openId: string): Promise<LarkUserProfile>;
  readDepartmentPath(departmentId: string): Promise<string | null>;
  readTenantName(): Promise<string | null>;
}

const PROFILE_TTL_MS = 10 * 60_000;
const MISS_TTL_MS = 60_000;
const profiles = new Map<string, { at: number; profile: PeerProfile | null }>();
const inflight = new Map<string, Promise<PeerProfile | null>>();
const tenants = new Map<string, { at: number; name: string | null }>();
const tenantInflight = new Map<string, Promise<string | null>>();

/** Test hook: clear the process-wide lookup caches. */
export function resetPeerProfileCacheForTests(): void {
  profiles.clear();
  inflight.clear();
  tenants.clear();
  tenantInflight.clear();
}

async function tenantName(cacheKey: string, lookup: PeerLookup): Promise<string | null> {
  const cached = tenants.get(cacheKey);
  const ttl = cached?.name ? PROFILE_TTL_MS : MISS_TTL_MS;
  if (cached && Date.now() - cached.at < ttl) return cached.name;
  const pending = tenantInflight.get(cacheKey);
  if (pending) return pending;
  const request = lookup
    .readTenantName()
    .catch(() => null)
    .then((name) => {
      tenants.set(cacheKey, { at: Date.now(), name });
      return name;
    })
    .finally(() => {
      tenantInflight.delete(cacheKey);
    });
  tenantInflight.set(cacheKey, request);
  return request;
}

/**
 * Resolve a p2p chat to its human peer. The member name is the primary
 * source; contact fields are best-effort and independently degradable.
 */
export async function resolvePeerProfile(
  chatId: string,
  lookup: PeerLookup,
  fallbackOpenId = "",
  cacheKey = "",
): Promise<PeerProfile | null> {
  let openId = fallbackOpenId;
  let name = "";
  try {
    const member = (await lookup.listMembers(chatId))[0];
    if (member?.openId) {
      openId = member.openId;
      name = member.name.trim();
    }
  } catch {
    // Keep the sender open_id captured by the dispatcher, if any.
  }
  if (!openId) return null;

  let profile: LarkUserProfile | null = null;
  try {
    profile = await lookup.readProfile(openId);
  } catch {
    // Contact scopes are optional; the member name alone is enough.
  }
  if (!name && profile?.name) name = profile.name;

  let department: string | null = null;
  if (profile?.departmentId) {
    department = await lookup.readDepartmentPath(profile.departmentId).catch(() => null);
  }

  return {
    chatId,
    openId,
    name,
    department,
    organization: await tenantName(cacheKey, lookup),
  };
}

function applyProfile(entry: UnmatchedChat, profile: PeerProfile | null): UnmatchedChat {
  if (!profile) return entry;
  return {
    ...entry,
    ...(profile.openId ? { peerOpenId: profile.openId } : {}),
    ...(profile.name ? { peerName: profile.name } : {}),
    ...(profile.department ? { peerDepartment: profile.department } : {}),
    ...(profile.organization ? { peerOrganization: profile.organization } : {}),
  };
}

/**
 * Resolve names/departments for unbound p2p chats. Group chats pass through
 * untouched. Only p2p entries trigger lark-cli, and results are cached so
 * refreshing the settings pane does not re-query every time.
 */
export async function enrichUnmatchedChats(
  cliPath: string | null,
  entries: UnmatchedChat[],
  lookupOverride?: PeerLookup,
): Promise<UnmatchedChat[]> {
  const lookup: PeerLookup | null =
    lookupOverride ??
    (cliPath
      ? {
          listMembers: (chatId) => listChatMembers(cliPath, chatId),
          readProfile: (openId) => readUserProfile(cliPath, openId),
          readDepartmentPath: (departmentId) => readDepartmentPath(cliPath, departmentId),
          readTenantName: () => readTenantName(cliPath),
        }
      : null);
  if (!lookup) return entries;

  const cacheKey = lookupOverride ? "test" : cliPath ?? "";
  return Promise.all(
    entries.map(async (entry) => {
      if (entry.chatType !== "p2p") return entry;
      const key = cacheKey + "\u0000" + entry.chatId;
      const cached = profiles.get(key);
      const ttl = cached?.profile ? PROFILE_TTL_MS : MISS_TTL_MS;
      if (cached && Date.now() - cached.at < ttl) return applyProfile(entry, cached.profile);

      let pending = inflight.get(key);
      if (!pending) {
        pending = resolvePeerProfile(entry.chatId, lookup, entry.peerOpenId ?? "", cacheKey)
          .catch(() => null)
          .finally(() => {
            inflight.delete(key);
          });
        inflight.set(key, pending);
      }
      const profile = await pending;
      profiles.set(key, { at: Date.now(), profile });
      return applyProfile(entry, profile);
    }),
  );
}
