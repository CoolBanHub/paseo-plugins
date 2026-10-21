# dsh (DeepSeek) for Paseo

Registers the local DeepSeek coding agent (`dsh`, from
`@deepseek-ai/dsh`) as a native Paseo provider. dsh sessions appear in
Paseo alongside Claude Code, Codex and ZCode: you can start sessions in
any project directory, send prompts, watch the timeline (reasoning, tool
calls, replies), answer permission prompts, and switch models, reasoning
effort, and the standard/plan mode in Paseo.

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

Because `session/resume` does not replay history, a dsh session imported
or reopened in Paseo opens with an empty timeline while the underlying
dsh session keeps its full context. New sessions stream normally.

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

- Node 18+ available to the Paseo daemon.
- dsh installed via npx cache (run `npx @deepseek-ai/dsh web` once) or
  globally, or `DSH_BIN` pointing at its bin script.
- A working LLM route for the `acp` profile. The auto-initialized profile
  defaults to `deepseek-official` with an API key; if your web profile
  uses a custom provider instead (for example a pi-ai route), mirror that
  `llm-pi-ai` + `agent-default-model` + `acp` configuration into
  `~/.dsh/profiles/acp/cordis.patch.yml` so Paseo sessions authenticate
  the same way. Credentials resolve from `~/.dsh/.credentials.yaml`.
- Paseo >= 0.11.4.

## Permission preset

Choose **dsh 权限** from the Paseo sidebar (also available under Settings)
and select the permission mode (`default`, `workspace-write`, `read-only`,
`danger-full-access`). It is injected as
`DSH_PERMISSION_MODE` when Paseo starts a new dsh process, so changes apply
to new sessions. `default` leaves the daemon environment unchanged; when
unset, dsh uses `workspace-write`.

## Modes

Paseo shows **标准模式** and **计划模式** in its native session mode
selector. dsh ACP does not expose native modes, so this plugin translates
the selection: standard mode leaves prompts unchanged; plan mode prepends
read-only planning instructions to each prompt. This is prompt-guided and
is not a hard tool sandbox like dsh's native plan mode.

## Capabilities and limits

- Prompting, interrupting, model and reasoning-effort selection, standard
  and prompt-guided plan modes, and permission prompts. Model choices come
  from dsh's live catalog (provider-grouped, flattened by Paseo).
- Thinking options require the model to declare reasoning support in the
  `acp` profile (`reasoningEfforts` per model in `cordis.patch.yml`); the web
  profile's model settings do not automatically carry over. Models
  without it show no thinking selector. dsh's "Provider default" effort
  (empty string) is stripped by the connector because Paseo's schema
  requires non-empty option ids.
- Permissions: dsh runs sessions under the `workspace-write` preset by
  default — sandboxed in-workspace operations run without prompts, and
  escalations (outside-workspace writes, wider sandbox) surface as
  permission prompts in Paseo. dsh's permission requests carry only a
  tool call id, so the connector enriches them with the title and input
  from the observed tool-call updates (Paseo's adapter otherwise fails on
  the missing raw input and dsh reports "no approval channel available").
  Set **Settings > dsh 权限 > Permission mode** (or
  `DSH_PERMISSION_MODE=danger-full-access` / `read-only` in the daemon's
  environment) to change the preset for Paseo-spawned sessions.
- Plan mode is prompt-guided because dsh ACP does not expose its native
  plan-mode command or a hard mode switch.
- Session import lists persisted dsh sessions for the project directory
  (dsh returns no titles, so entries appear by session id).
- Paseo's catalog probe and every session open spawn a fresh
  `dsh --profile acp` process; dsh persists each ACP-created session, so
  catalog probes can leave short empty sessions in `~/.dsh/sessions`
  that also show up in the dsh web UI sidebar (hidden from Paseo's list
  by the connector).
- Tool output, images and dsh-specific presentation cards outside the
  standard ACP update surface are not carried over.

## Development

Run `npm run typecheck` for TypeScript checks. After editing this
directory, run `paseo plugin reload dsh` to load the changes into the
daemon.
