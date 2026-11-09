import type { SessionPaseoApi, SessionWorkspaceHandle } from "./sessions.ts";

/**
 * All Feishu topic agents live in one shared workspace so the Paseo sidebar
 * is not flooded with one workspace per topic. The directory comes from the
 * binding cwd in effect when the workspace is first created.
 */
export const SHARED_WORKSPACE_TITLE = "飞书任务";

/**
 * Find (or create) the shared "飞书任务" workspace. Resolves to null when
 * the daemon exposes no workspaces API or the lookup/create fails, so the
 * caller can fall back to a plain agents.create() with its own cwd.
 */
export async function ensureSharedWorkspace(options: {
  paseo: SessionPaseoApi;
  /** Absolute directory for a newly created workspace. */
  directory: string;
  log?: (message: string) => void;
}): Promise<SessionWorkspaceHandle | null> {
  const { workspaces } = options.paseo;
  if (!workspaces) return null;
  try {
    const result = await workspaces.list();
    const existing = (result.entries ?? []).find(
      (entry) => entry.title === SHARED_WORKSPACE_TITLE || entry.name === SHARED_WORKSPACE_TITLE,
    );
    if (existing) return workspaces.ref(existing.id);
    return await workspaces.create({
      title: SHARED_WORKSPACE_TITLE,
      source: { kind: "directory", path: options.directory },
    });
  } catch (error) {
    options.log?.(
      "共享 workspace 不可用，回退为每话题独立会话：" +
        (error instanceof Error ? error.message : String(error)),
    );
    return null;
  }
}
