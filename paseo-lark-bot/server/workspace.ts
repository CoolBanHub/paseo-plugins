import type { SessionPaseoApi, SessionWorkspaceHandle } from "./sessions.ts";

/**
 * Topic agents live in a workspace so the Paseo sidebar is not flooded with
 * one entry per topic. By default every Feishu chat shares "飞书任务"; with
 * `workspacePerBinding` each chat gets its own workspace named after the chat,
 * which lets different bindings point at different project directories.
 */
export const SHARED_WORKSPACE_TITLE = "飞书任务";

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
      "workspace 不可用，回退为每话题独立会话：" +
        (error instanceof Error ? error.message : String(error)),
    );
    return null;
  }
}

/** Backwards-compatible shared-workspace helper. */
export function ensureSharedWorkspace(options: {
  paseo: SessionPaseoApi;
  directory: string;
  log?: (message: string) => void;
}): Promise<SessionWorkspaceHandle | null> {
  return ensureWorkspace({ ...options, title: SHARED_WORKSPACE_TITLE });
}
