import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * The bot's stable ids, cached on disk so a Feishu network outage does not
 * make the plugin drop every group message. Feishu event payloads may identify
 * the bot either by its open_id (`ou_…`) or by the app id (`cli_…`), so both
 * are kept and matched.
 */
export interface BotIdentity {
  openId: string | null;
  appId: string | null;
}

interface StoredBotIdentity {
  version: 1;
  openId?: string;
  appId?: string;
}

const EMPTY: BotIdentity = { openId: null, appId: null };

function validOpenId(value: unknown): string | null {
  return typeof value === "string" && value.startsWith("ou_") ? value : null;
}

function validAppId(value: unknown): string | null {
  return typeof value === "string" && value.startsWith("cli_") ? value : null;
}

/** Read the cached identity; a missing or malformed file yields empty ids. */
export function loadBotIdentity(path: string | null): BotIdentity {
  if (!path) return { ...EMPTY };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<StoredBotIdentity>;
    return {
      openId: validOpenId(parsed.openId),
      appId: validAppId(parsed.appId),
    };
  } catch {
    return { ...EMPTY };
  }
}

/** Atomically persist both ids; an empty pair removes the file. */
export function saveBotIdentity(
  path: string | null,
  identity: BotIdentity,
  log?: (message: string) => void,
): void {
  if (!path) return;
  if (!identity.openId && !identity.appId) {
    clearBotIdentity(path);
    return;
  }
  try {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.tmp`;
    const payload: StoredBotIdentity = {
      version: 1,
      ...(identity.openId ? { openId: identity.openId } : {}),
      ...(identity.appId ? { appId: identity.appId } : {}),
    };
    writeFileSync(temporary, JSON.stringify(payload), { mode: 0o600 });
    renameSync(temporary, path);
  } catch (error) {
    log?.(`bot identity write failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Drop a cached identity when the app/credentials change. */
export function clearBotIdentity(path: string | null): void {
  if (!path) return;
  try {
    unlinkSync(path);
  } catch {
    // Already gone or never written.
  }
}
