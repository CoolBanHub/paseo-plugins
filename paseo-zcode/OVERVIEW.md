# ZCode for Paseo

Registers the local ZCode (GLM) coding agent as a native Paseo provider. ZCode
sessions appear in Paseo alongside Claude Code and Codex: you can start
sessions, send prompts, watch the timeline (reasoning, tool calls, replies),
interrupt turns, switch models, modes and thinking levels, and answer
permission prompts without leaving Paseo.

## Coding plan quota

The plugin also registers a usage source showing your Zhipu coding plan
allowances in Paseo's usage view (`paseo usage` or the usage screen), one
account per plan:

- BigModel account plans (logged in inside the ZCode desktop app): 5-hour and
  weekly windows with reset times, plus the monthly bundled MCP tool quota.
- API-key coding plans configured as personal providers (for example a
  `zhipu-coding-plan-api-key` provider): the same windows plus exact credit
  counts (used / remaining / limit) and reset times.

Both query BigModel's official quota endpoint with the credentials stored by
the ZCode desktop app, so the numbers match what the desktop shows.

## How it works

The plugin spawns `zcode app-server --stdio` from the installed ZCode desktop
app and speaks the ZCode Protocol (newline-delimited JSON over stdio). Because
the app-server shares the same session store as the ZCode desktop app
(`~/.zcode`), sessions created from Paseo also show up in ZCode, and existing
local ZCode sessions are listed in Paseo's session picker.

## Requirements

- macOS with the ZCode desktop app installed at
  `/Applications/ZCode.app` (or set `ZCODE_CLI_PATH` to a `zcode.cjs`).
- The ZCode CLI must be signed in (`zcode login`) — credentials are shared
  with the desktop app.
- Paseo >= 0.11.4.

## Capabilities and limits

- Prompting, interrupting, model / mode / thinking-level switching, permission
  prompts, usage accounting per turn.
- Model labels include the provider name. Model and reasoning selections are
  confirmed before the session becomes ready and travel with every prompt;
  changing the mode or reasoning level preserves the selected model.
- Configuration follows official snapshots and `state.updated` notifications.
  The plugin rereads the session before sending or configuring and supplies
  its revision so a concurrent change cannot silently send with stale state.
  Plan mode follows the official `session.updated` event's `planEnabled` flag;
  ZCode snapshots report the underlying permission mode.
- ZCode todo snapshots and background terminal lifecycle events are mirrored
  into Paseo's todo and shell-call timeline items. Paseo's provider timeline
  does not expose the per-process stop control shown in ZCode's own panel.
- Permission cards include the requested command and reason. ZCode's repeated
  announcements for one outstanding permission are coalesced into one card;
  separate permission request IDs remain separate prompts.
- Plan approval requests from `ExitPlanMode` appear as actionable plan cards in
  Paseo; approving returns the answer ZCode expects to leave plan mode and
  begin implementation.
- Image prompts are supported through ZCode's native image attachments on
  `session/send`; they do not depend on MCP. Paseo passes image MIME type and
  base64 data through the official ZCode app-server protocol.
- Archiving and restoring from Paseo update the ZCode desktop task index using
  the installed app's own repository. Archived and deleted ZCode tasks are
  hidden from the import picker. This uses an internal desktop component;
  incompatible ZCode updates report an error rather than claiming success.
  A desktop window may need its task list refreshed after a change from Paseo.
- ZCode's own archive button can fail before reaching the archive operation:
  `window-controller.mutateTask` reports `没有与任务地址匹配的 source`.
  This is a desktop controller/source matching error, including for tasks
  created outside Paseo. The plugin's archive operation does not fix that
  desktop button. Keeping the shared session store is intentional.
- Model-catalog probes use deferred persistence and leave no saved session.
- Paseo caches the provider catalog (models, mode labels) per agent and only
  re-discovers when the catalog cache key changes, so the key hashes the
  zcode CLI's identity (the model list is queried live from it) plus this
  plugin's own server sources and package.json. Plugin updates and ZCode app
  updates both invalidate the cached catalog on the next plugin reload.
- Coding-plan account providers (BigModel / Z.ai plans logged in inside the
  ZCode desktop app) are registered into the CLI at runtime and their models
  are selectable; credentials are read and decrypted locally from
  `~/.zcode/v2/credentials.json` and supplied per model request, mirroring
  what the desktop app does. Plan rate limits apply as usual.
- When Paseo reopens a persisted session with `history: replay`, the provider
  reads up to the latest 1,000 messages from the native ZCode snapshot and
  replays visible user, reasoning, assistant and tool rows before marking the
  session ready. Hidden runtime context remains hidden. A `history: skip` open
  still reconnects without rebuilding the old timeline.
- The plugin runs unsandboxed as the Paseo daemon user and launches the ZCode
  CLI with your existing credentials. Official-plugin MCP servers that need
  desktop auth headers (for example hexin) are not available inside
  provider sessions.

## Development

Run `npm test` for regression coverage and `npm run typecheck` for TypeScript
checks. Reloading the plugin closes every connected ZCode turn. Use
`npm run reload:check` to inspect live ZCode agents, then `npm run reload` to
check again and load server changes. It refuses to reload when any ZCode
agent is running, initializing, awaiting permission, or cannot be inspected.
This is a snapshot check: avoid starting tasks during the reload. Changes to
documentation, tests, or development scripts do not require a reload.
