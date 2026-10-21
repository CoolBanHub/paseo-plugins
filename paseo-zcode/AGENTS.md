# Loading plugin changes

- Reloading this plugin terminates every connected ZCode turn. Never run
  `paseo plugin reload zcode` directly during development.
- Use `npm run reload:check` to inspect live ZCode agents and `npm run reload`
  to check again before reloading. If the guard reports busy or cannot read
  live state, leave the plugin running and wait for the work to finish.
- The guard is a snapshot check, not a server lock. Do not start new ZCode
  tasks between checking and reloading.
- Documentation, tests, and development-script edits do not need a plugin
  reload. Test them without restarting the live plugin.
- Preserve existing conversation history. Paseo's explicit agent reload
  replaces timeline history from provider replay; use a configuration read
  or normal next-message resume to verify an existing connection instead.
