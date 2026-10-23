# dsh (DeepSeek) for Paseo

Registers the local DeepSeek coding agent (`dsh`, from
`@deepseek-ai/dsh`) as a native Paseo provider. dsh sessions appear in
Paseo alongside Claude Code, Codex and ZCode: you can start sessions in
any project directory, send prompts, watch the timeline (reasoning, tool
calls, replies), answer permission prompts, and switch models, reasoning
effort, dsh Agent presets, and dsh permission presets independently.

## How it works

The plugin uses Paseo's built-in ACP adapter (`runAcpProvider`) with a
custom connector that spawns:

```
<node> <dsh> --profile acp
```

`dsh --profile acp` serves the standard Agent Client Protocol (ACP v1)
over stdio, which is dsh's supported automation surface (the same one
used by out-of-process subagents and test harnesses). The already-running
`dsh web` instance is not controlled by this plugin; both share the same
`~/.dsh` home, so the DeepSeek account you logged in with on the web (or
desktop) profile authorizes ACP sessions too, and persisted sessions are
visible to both.

### Why a custom connector

Paseo's adapter reattaches persisted sessions with ACP `session/load`,
while dsh only implements `session/resume` (and rejects `session/load`).
The connector translates in flight:

- `initialize` responses gain `agentCapabilities.loadSession = true` so
  Paseo enables session persistence and listing;
- outgoing `session/load` requests are rewritten to `session/resume`.

Because `session/resume` does not replay history, the plugin reads the bounded
dsh JSONL session log when Paseo reopens a persisted session with
`history: replay`. Visible user, assistant, reasoning, tool and PTC sub-call
rows are emitted before the restored session becomes ready; injected runtime
context remains hidden. A `history: skip` open reconnects without rebuilding
the old timeline. Replay is limited to the latest 4,000 timeline rows; the
compressed session log and decompressed content are capped at 32 MiB and
128 MiB. The underlying dsh session keeps its full context either way.

### dsh discovery

The plugin resolves the dsh bin script in this order:

1. `DSH_BIN` environment variable (absolute path);
2. `dsh` on the daemon's `PATH`;
3. the newest `@deepseek-ai/dsh` copy in the npx cache
   (`~/.npm/_npx/…`), which exists once you have run
   `npx @deepseek-ai/dsh web`.

The script is always spawned through an explicit node executable
(`DSH_NODE_PATH`, else the newest `node` found on the daemon's `PATH`, in
nvm, or in Homebrew) because the Paseo daemon itself runs on Electron and
dsh's launcher refuses Electron runtime fingerprints.

## Requirements

- Node 22.15+ available to the Paseo daemon (the current dsh session store uses
  Node's built-in Zstandard support).
- dsh installed via npx cache (run `npx @deepseek-ai/dsh web` once) or
  globally, or `DSH_BIN` pointing at its bin script.
- A working LLM route for the `acp` profile. The auto-initialized profile
  defaults to `deepseek-official` with an API key; if your web profile
  uses a custom provider instead (for example a pi-ai route), configure the
  matching provider endpoint and credentials in
  `~/.dsh/profiles/acp/cordis.patch.yml` so Paseo sessions authenticate
  the same way. The Web profile's current model definitions, including
  reasoning-effort options, are overlaid automatically at discovery and
  session startup. Credentials resolve from `~/.dsh/.credentials.yaml`.
- Paseo >= 0.11.4.

## Project modes

Paseo's native Agent mode selector offers dsh's **标准模式**, **PTC 模式**,
**极简模式**, and **创造模式**. Each selection mounts the matching dsh
agent-preset composition, so PTC changes the tool presentation and Minimal
and Creator load their dsh-defined tool and prompt sets. Paseo stores the
selection in the project agent configuration and passes it to the ACP process
when a session starts. Existing sessions retain their composition; create a
new session to use another mode.

The dsh permission preset is exposed as a separate **权限** session
setting. It uses dsh's live permission-preset catalog and service, so changing
it updates that dsh session's sandbox and approval policy without changing its
Agent preset. Option labels mirror the dsh desktop app's zh-CN strings
(仅可查看 / 工作区内修改 / 完全权限) while the underlying values passed to
dsh stay protocol-level (`read-only` / `workspace-write` /
`danger-full-access`). Paseo remembers the selection by project path and
applies it to new dsh sessions opened in that project. Paseo persists
discovered settings per agent and only re-discovers when the catalog cache
key changes, so the key hashes the plugin's own server sources and
package.json besides the dsh profiles — every plugin update automatically
invalidates the cached catalog on the next plugin reload. (Plugins run as
esbuild CommonJS bundles where `import.meta` is unavailable, so the source
root is resolved from `plugins.dsh.path` in Paseo's `config.json`, with
`DSH_PLUGIN_ROOT` as an override.)

## Capabilities and limits

- Prompting, interrupting, model and reasoning-effort selection, dsh agent
  presets, and permission prompts. Model choices come
  from dsh's live catalog (provider-grouped, flattened by Paseo).
- Paseo mirrors the `bai` model list and `reasoningEfforts` from the Web
  profile's `llm-pi-ai` patch into a temporary ACP overlay. Removing a model
  or changing its effort list in dsh Web invalidates Paseo's catalog cache;
  refresh the provider catalog to see the update. The ACP profile still owns
  the provider endpoint and credential configuration. dsh's "Provider default" effort
  (empty string) is stripped by the connector because Paseo's schema
  requires non-empty option ids.
- Permissions: dsh runs sessions under the `workspace-write` permission preset by
  default — sandboxed in-workspace operations run without prompts, and
  escalations (outside-workspace writes, wider sandbox) surface as
  permission prompts in Paseo. dsh's permission requests carry only a
  tool call id, so the connector enriches them with the title and input
  from the observed tool-call updates (Paseo's adapter otherwise fails on
  the missing raw input and dsh reports "no approval channel available").
  The separate 权限 setting maps to dsh's current permission preset
  service, including optional presets such as Auto review when the ACP profile
  has them enabled.
- Session import lists persisted dsh sessions for the project directory
  (dsh returns no titles, so entries appear by session id).
- The plugin is kept on the same `@getpaseo/plugin` protocol version as the
  Paseo daemon. It also normalizes dsh failed tool updates that omit an error
  payload, because Paseo requires a JSON error for failed timeline tool items.
- Paseo's catalog probe and every session open spawn a fresh
  `dsh --profile acp` process; dsh persists each ACP-created session.
  The connector removes probe sessions after the catalog connection closes
  (and sweeps probes older than a minute after a reload), so they no longer accumulate as
  untitled rows in the dsh web UI sidebar. Sessions containing user,
  assistant or tool events, archived sessions, and Workspace members are
  never removed.
- Tool output, images and dsh-specific presentation cards outside the
  standard ACP update surface are not carried over.
- In PTC presets every tool runs inside one `run_code` program, and dsh's
  ACP bridge only reports that aggregate call. The bridge plugin mounted
  into each spawn mirrors dsh's internal per-tool dispatch events into a
  JSONL sidecar; the connector tails it and surfaces every sub-call as its
  own detailed Paseo timeline row (Shell, Read, Edit, Search, Fetch — the
  same rows the ZCode provider shows), including per-call status, output
  and todo list updates. The aggregate `run_code` tool-call updates are
  dropped from the wire so no opaque "Run code" JSON rows remain; a program
  that dispatched no tools still leaves one row labeled with its
  description and carrying its printed output (or error). Only live
  sessions' records are mirrored, and the sidecar is removed when the
  process exits.

## Development

Run `npm run typecheck` for TypeScript checks. After editing this
directory, run `paseo plugin reload dsh` to load the changes into the
daemon.
