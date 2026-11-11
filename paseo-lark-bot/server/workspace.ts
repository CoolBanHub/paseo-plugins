import type {
  SessionAgentHandle,
  SessionPaseoApi,
  SessionWorkspaceHandle,
} from "./sessions.ts";

/**
 * Topic agents live in a workspace so the Paseo sidebar is not flooded with
 * one entry per topic. By default every Feishu chat shares "飞书任务"; with
 * `workspacePerBinding` each chat gets its own workspace named after the chat,
 * which lets different bindings point at different project directories.
 */
export const SHARED_WORKSPACE_TITLE = "飞书任务";

/**
 * Name of the workspace that hosts a binding's topic agents. Keeping this in
 * one place lets rewrite/cron helpers resolve the same workspace instead of
 * minting a new one for each one-shot turn.
 */
export function workspaceTitleFor(
  chatId: string,
  chatName: string,
  perBinding: boolean,
): string {
  if (!perBinding) return SHARED_WORKSPACE_TITLE;
  return "飞书 · " + (chatName || chatId).slice(0, 32) + " · " + chatId.slice(-4);
}

/**
 * Find (or create) a workspace by title. Resolves to null when the daemon
 * exposes no workspaces API or the lookup/create fails, so the caller can
 * fall back to a plain agents.create() with its own cwd.
 */
export async function ensureWorkspace(options: {
  paseo: SessionPaseoApi;
  title: string;
  /** Absolute directory for a newly created workspace. */
  directory: string;
  /** Override the failure log when the caller does not fall back to a topic agent. */
  failureMessage?: string;
  log?: (message: string) => void;
}): Promise<SessionWorkspaceHandle | null> {
  const { workspaces } = options.paseo;
  if (!workspaces) return null;
  try {
    const result = await workspaces.list();
    const existing = (result.entries ?? []).find(
      (entry) => entry.title === options.title || entry.name === options.title,
    );
    if (existing) return workspaces.ref(existing.id);
    return await workspaces.create({
      title: options.title,
      source: { kind: "directory", path: options.directory },
    });
  } catch (error) {
    options.log?.(
      (options.failureMessage ?? "workspace 不可用，回退为每话题独立会话：") +
        (error instanceof Error ? error.message : String(error)),
    );
    return null;
  }
}

type HelperAgentOptions = Parameters<SessionWorkspaceHandle["agents"]["create"]>[0];

/**
 * Create a one-shot helper (title/rewrite/cron) without minting a workspace.
 * Hosts with a workspaces API require an explicit workspace handle: returning
 * null lets the caller skip the helper and use its fallback instead of
 * leaving an empty background workspace behind. Legacy hosts keep the old
 * standalone create path.
 */
export async function createHelperAgent(options: {
  paseo: SessionPaseoApi;
  workspace?: SessionWorkspaceHandle | null;
  cwd: string;
  agent: HelperAgentOptions;
}): Promise<SessionAgentHandle | null> {
  if (options.workspace) return options.workspace.agents.create(options.agent);
  if (options.paseo.workspaces) return null;
  return options.paseo.agents.create({
    ...options.agent,
    cwd: options.cwd,
    background: true,
  });
}

/** Backwards-compatible shared-workspace helper. */
export function ensureSharedWorkspace(options: {
  paseo: SessionPaseoApi;
  directory: string;
  log?: (message: string) => void;
}): Promise<SessionWorkspaceHandle | null> {
  return ensureWorkspace({ ...options, title: SHARED_WORKSPACE_TITLE });
}
