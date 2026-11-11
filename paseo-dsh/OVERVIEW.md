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
the old timeline. Replay is limited to the latest 4,000 timeline rows and the
newest 50,000 log events; oversized logs keep their newest window instead of
disabling replay. dsh appends one Zstandard frame per durable flush and
Node's zstd APIs decode only the first frame, so the reader scans for frame
magics and decodes each frame from its own offset. `replace` surface
operations (rewind markers, compaction checkpoints) hide the events they
shadow, so a rewound or compacted session replays exactly its visible
transcript. The underlying dsh session keeps its full context either way.

### dsh discovery

The plugin resolves the dsh bin script in this order:

1. `DSH_BIN` environment variable (absolute path);
2. `dsh` on the daemon's `PATH`;
3. the newest `@deepseek-ai/dsh` copy in the npx cache
   (`~/.npm/_npx/…`), which exists once you have run
   `npx @deepseek-ai/dsh web`.

The script is spawned through a real node executable when one can be found
(`DSH_NODE_PATH`, else the newest `node` on the daemon's `PATH`, in nvm, or
in Homebrew) because the Paseo daemon itself runs on Electron and dsh's
launcher refuses Electron runtime fingerprints; when none of those exist the
daemon's own executable is the last resort, which dsh's launcher may still
reject by its Electron fingerprint.

## Requirements

- Node >=22.15.0 available to the Paseo daemon (the current dsh session store uses
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
- Paseo >= 0.15.3.

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
  requires non-empty option ids. A missing or malformed Web profile no
  longer fails the spawn: the last successfully written overlay is reused,
  and only when none exists does the session open without the overlay
  (dsh falls back to its own ACP profile models) with a log line explaining
  the degradation.
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
- Session import lists persisted dsh sessions for the project directory.
  Titles and last-activity times come from dsh's per-session projection
  cache, so entries no longer appear as bare session ids.
- `ask_user_question` is answered through Paseo's native question form.
  The bridge registers a `user-questions/request` answerer, the connector
  forwards the question batch as a `kind: "question"` permission request,
  and the wrapper returns the form's answers to dsh. Options, multi-select
  and free-text "Other" work; a single-select custom answer becomes dsh's
  `custom` field. `exit_plan_mode` uses the same channel, so plan review
  renders the plan in the timeline and accepts approve / keep-planning /
  feedback.
- Plan mode is also a session toggle next to the permission preset. dsh's
  own `/plan` changes flow back into the toggle, and dsh's command registry
  is published as Paseo slash commands (`/plan`, `/compact`, `/goal`,
  `/permission`, …). A slash command is executed by dsh's command service
  through the bridge instead of being sent to the model; the command's text
  result appears as a Paseo notice.
- Retries and compaction surface as they happen: `llm/retry` becomes a
  warning notice (with the failure's stable code mapped to a short Chinese
  explanation), and `compaction/start|summary|end` becomes Paseo's native
  compaction timeline item with manual/auto attribution and pre-compaction
  token counts.
- Failed turns surface in Paseo: dsh's ACP bridge reports every failed turn
  as a normal `end_turn`, so the connector mirrors `turn/end` reasons and
  renders errors (quota, context window, credentials, rate limit — see
  `dsh-error-present.ts` for the code table) as timeline error rows, with
  max-tokens and blocked endings as warning notices.
- Every assistant step reports its token accounting: the `usage` snapshot on
  `assistant/message` becomes a compact info notice (输入/缓存读/缓存写/输出),
  plus the step's decode speed (`速度 186 tok/s`). The bridge derives the speed
  from the first streamed token and the committed message time, matching dsh's
  own `sessionStats` decode figure; steps without a recorded stream timing
  simply omit it. Context-window pressure continues to arrive through dsh's
  own native `usage_update`.
- Long generations stream: dsh's ACP bridge only projects the settled
  assistant message, so the bridge plugin mirrors `agent/assistant-stream`
  frames and the connector renders one updating 生成中… row per attempt once
  it has run longer than ~1.5 seconds; quick replies never grow an extra
  row, and the settled row is a compact 已生成 N 字 marker because the full
  message follows it.
- Background jobs (`job/registered` / `job/settled`) render as Shell or
  labelled status rows with the originating command and terminal detail.
  Subagent runs update their `sub_agent` card with the child session id,
  provider, status and final output. Goal changes render as a stable Goal
  row, working-directory changes as a notice, and `present` tool calls list
  the delivered files. MCP and skill tools get readable `server · tool` /
  `Skill · name` labels instead of raw tool ids.
- History replay restores the same todo, background-job, compaction, goal
  and subagent identity rows in addition to the existing conversation and
  PTC rows.
- Subagent cards carry the child session id, but Paseo does not open them
  as nested sessions: the ACP adapter has no `session.subsession`
  capability, so child transcripts stay available in dsh's own clients.
- Image and file attachments in history replay render as annotated
  placeholders (`[文件 report.pdf · 3.0MB]`, `[图片 image/png · 2KB]`); live
  binary content is still not carried over. Commands come from dsh's live
  registry, so a preset without a command service exposes no slash commands;
  commands that start their own turn settle the ACP prompt when the command
  returns. When a timed `ask_user_question` expires, the Paseo form is
  dismissed with a notice instead of waiting forever; dsh does not re-ask.
- Session revert is slash-command driven; the native `session.revert`
  protocol path and the 可回退 revert-token marker rows are not advertised
  (the marker rows added timeline noise without a usable entry point):
  - **Conversation rewind** (`/rewind [n]`, rewind to the n-th previous
    user message) appends one marker user message through the in-dsh
    bridge under dsh's exclusive maintenance lock; its native
    `surfaceOp replace` shadows everything after the chosen message, and a
    successful flush confirms durability. The connector then closes the
    connection (Paseo cannot retract rendered rows); reopening replays the
    rewound transcript.
  - **File revert** (`/revert-files [n]`) restores byte-level before-snapshots
    the bridge checkpointed for `write`/`edit` tool calls (≤256 KiB each,
    persisted per dsh session under `plugin-data/dsh/file-receipts/`).
    Receipts are undone newest-first with the current file digest verified
    against what the tool produced; a mismatch stops the chain instead of
    clobbering divergent files, replaced inodes are kept as
    `*.dsh-backup-*`, and files the call created are moved aside rather
    than deleted. `/revert-files [n]` undoes the last n checkpointed writes.
  - Rewind planning is deliberately conservative (mirrors dsh-web's own
    rules): only plain exchanges and fully settled `read`/`write`/`edit`
    calls can be rewound; sessions that used bash, background jobs, goals,
    PTC programs or any stateful projection fail closed with a clear
    message. Files written through bash or other tools are never
    checkpointed, so revert does not guess about them.
- The ACP adapter does not implement `session.archive` or
  `session.unarchive`; those operations remain dsh-client features.
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
- Standard (non-PTC) presets render each dsh tool call as a structured
  Paseo row — Shell, Read, Edit, Write, Search or Fetch — with its ACP
  content output, instead of the bare tool name; `todo_write` updates
  Paseo's native todo list, live and on history replay. The connector
  replaces dsh's `kind: "other"` tool updates in flight, so no opaque
  "unknown" row is left behind.
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
- Sidecar plumbing is incremental and bounded. The connector tails each
  sidecar by byte offset (only newly appended bytes are read) and dedups
  re-read records by their monotonic counter, while the bridge compacts a
  sidecar in place once it passes 8 MiB (keeping the newest 4 MiB of
  complete records) — long sessions no longer pay quadratic re-reads or
  unbounded file growth. The startup sweep removes every known leftover
  artifact older than an hour (event sidecars, control files, bridge
  request/response directories, connection receipt logs), not just PTC
  mirrors.

## Development

Run `npm run typecheck` for TypeScript checks. After editing this
directory, run `paseo plugin reload dsh` to load the changes into the
daemon.
