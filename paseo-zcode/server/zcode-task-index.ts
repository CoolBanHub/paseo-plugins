import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

interface TaskIndexResult {
  sessionId?: string;
  archived?: boolean;
  workspacePath?: string;
  hiddenSessionIds?: string[];
  saved?: boolean;
}

// The stdio protocol has no archive RPC. Use the installed desktop's own
// repository so its schema migrations and task-group rules remain authoritative.
const TASK_INDEX_SCRIPT = String.raw`
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";
const [resources, rawOperation] = process.argv.slice(1);
const operation = JSON.parse(rawOperation);
const hostRoot = join(resources, "app.asar", "out", "host");
let TaskIndexRepo;
for (const name of readdirSync(hostRoot)) {
  if (!/^chunk-.*\.js$/.test(name)) continue;
  const file = join(hostRoot, name);
  if (!readFileSync(file, "utf8").includes('"TaskIndexRepo"')) continue;
  const module = await import(pathToFileURL(file).href);
  TaskIndexRepo = Object.values(module).find(value => typeof value === "function" && value.name === "TaskIndexRepo");
  if (TaskIndexRepo) break;
}
if (!TaskIndexRepo) throw new Error("The installed ZCode desktop does not expose TaskIndexRepo");
const repo = new TaskIndexRepo();
try {
  const database = await repo.getOrganizationDatabase();
  let result;
  if (operation.type === "hidden") {
    result = { hiddenSessionIds: database.prepare("SELECT task_id FROM tasks WHERE archived=1 OR deleted=1 OR coalesce(cli_deleted,0)=1").all().map(row => row.task_id) };
  } else {
    if (typeof operation.sessionId !== "string" || !operation.sessionId.startsWith("sess_")) throw new Error("Invalid ZCode session ID");
    let rows = database.prepare("SELECT workspace_path,workspace_identity,workspace_key,archived,deleted,cli_deleted FROM tasks WHERE task_id=?").all(operation.sessionId);
    if (rows.length === 0 && operation.type === "archive") {
      const sessions = new DatabaseSync(join(homedir(), ".zcode", "cli", "db", "db.sqlite"), { readOnly: true });
      try {
        const session = sessions.prepare("SELECT id,directory,title,title_source,time_created,time_updated,trace_id,last_outcome,time_deleted,task_type FROM session WHERE id=?").get(operation.sessionId);
        if (!session) {
          if (operation.archived !== true) throw new Error("No saved ZCode session exists to restore: " + operation.sessionId);
          // An untouched new session has no saved record or task to hide.
          result = { sessionId: operation.sessionId, archived: operation.archived, saved: false };
        } else {
          if (session.time_deleted || session.task_type !== "interactive") throw new Error("No saved interactive ZCode session exists: " + operation.sessionId);
          await repo.applyCliFacts({
            meta: {
              taskId: session.id, workspacePath: session.directory,
              traceId: session.trace_id || "zcode-" + session.id,
              title: session.title, createdAt: session.time_created, updatedAt: session.time_updated,
              mode: "default", provider: "glm",
            },
            titleSource: session.title_source, lastOutcome: session.last_outcome,
          });
        }
      } finally { sessions.close(); }
      rows = database.prepare("SELECT workspace_path,workspace_identity,workspace_key,archived,deleted,cli_deleted FROM tasks WHERE task_id=?").all(operation.sessionId);
    }
    if (!result) {
      if (rows.length !== 1) throw new Error("ZCode task index requires exactly one matching task: " + operation.sessionId);
      const row = rows[0];
      if (row.deleted || row.cli_deleted) throw new Error("ZCode task has been deleted: " + operation.sessionId);
      if (operation.type === "archive") {
        if (typeof operation.archived !== "boolean") throw new Error("Invalid archive state");
        await repo.updateTaskState({
          taskId: operation.sessionId,
          workspacePath: row.workspace_path,
          ...(row.workspace_identity ? { workspaceIdentity: row.workspace_identity } : {}),
          patch: { archived: operation.archived },
        });
      } else if (operation.type !== "read") throw new Error("Unsupported task-index operation");
      const updated = database.prepare("SELECT archived FROM tasks WHERE workspace_key=? AND task_id=?").get(row.workspace_key, operation.sessionId);
      result = { sessionId: operation.sessionId, workspacePath: row.workspace_path, archived: updated.archived === 1 };
      if (operation.type === "archive" && result.archived !== operation.archived) throw new Error("ZCode archive state was not committed");
    }
  }
  console.log("PASEO_ZCODE_TASK_INDEX:" + JSON.stringify(result));
} finally {
  repo.close();
}
`;

export class ZcodeTaskIndex {
  private readonly resources: string;
  private readonly helper: string;

  constructor(cliPath: string) {
    this.resources = dirname(dirname(cliPath));
    this.helper = join(this.resources, "..", "Frameworks", "ZCode Helper.app", "Contents", "MacOS", "ZCode Helper");
  }

  get available(): boolean {
    return existsSync(this.helper) && existsSync(join(this.resources, "app.asar"));
  }

  private async run(operation: Record<string, unknown>): Promise<TaskIndexResult> {
    if (!this.available) throw new Error("ZCode desktop task index is unavailable; archiving requires the installed macOS desktop app");
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync(
        this.helper,
        ["--input-type=module", "-e", TASK_INDEX_SCRIPT, this.resources, JSON.stringify(operation)],
        { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, timeout: 20_000, maxBuffer: 1024 * 1024 },
      ));
    } catch (error) {
      const stderr = String((error as { stderr?: string }).stderr ?? "");
      const reason = stderr.split("\n").findLast((line) => /^\w*Error:/.test(line));
      throw new Error(`ZCode task index failed: ${reason ?? "desktop repository operation failed"}`);
    }
    const line = stdout.split("\n").findLast((entry) => entry.startsWith("PASEO_ZCODE_TASK_INDEX:"));
    if (!line) throw new Error("ZCode desktop task index returned no result");
    return JSON.parse(line.slice("PASEO_ZCODE_TASK_INDEX:".length)) as TaskIndexResult;
  }

  async hiddenSessionIds(): Promise<Set<string>> {
    return new Set((await this.run({ type: "hidden" })).hiddenSessionIds ?? []);
  }

  read(sessionId: string): Promise<TaskIndexResult> {
    return this.run({ type: "read", sessionId });
  }

  setArchived(sessionId: string, archived: boolean): Promise<TaskIndexResult> {
    return this.run({ type: "archive", sessionId, archived });
  }
}
