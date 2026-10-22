# Development notes

- `npm run typecheck` / `npm test` before handing changes over. Tests run the
  real `git` binary against a temp-dir fixture repo; keep them hermetic.
- The client bundle must not import anything from `server/`, not even types —
  shared data types live in `shared/types.ts`.
- Reloading is safe anytime (no provider sessions to lose):
  `paseo plugin reload git-manager`. Client-side changes may need the Paseo
  app to reload the plugin bundle (reopen the panel or restart the app).
- The daemon runs Paseo 0.11.4 — keep `paseo-plugin.json` requirements and the
  `@getpaseo/plugin` devDependency aligned with it.
- New git read paths: add the parsing as an exported pure-ish function in
  `server/git-ops.ts` plus a fixture-repo test before wiring an RPC contract
  in `shared/contracts.ts` and a handler in `index.server.ts`.
