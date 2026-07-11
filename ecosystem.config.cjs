// pm2 process definition for the Dahrk edge node. Self-contained: run `pm2 start ecosystem.config.cjs`
// from anywhere inside this clone - no dependency on any other repo. The only value you must supply is
// the enrolment token (a secret): put DAHRK_ENROL_TOKEN in a gitignored .env (loaded via direnv) or
// export it in your shell before starting. Everything else is defaulted or auto-detected:
//   - hub URL defaults to wss://api.dahrk.ai (override with DAHRK_HUB_URL);
//   - a stable node id is minted and persisted at ~/.dahrk/node.json;
//   - installed runtimes (claude / codex / pi) are auto-detected.
// Runs from source via the bundled tsx - no build step. The legacy SKAKEL_* env names are still
// accepted. Do NOT set ANTHROPIC_API_KEY here; Claude auth is the interactive `claude` OAuth login.
//
// Lifecycle:
//   pm2 start ecosystem.config.cjs    # start
//   pm2 logs dahrk-node               # tail; watch for the connect / welcome handshake
//   pm2 restart dahrk-node            # after a git pull
//   pm2 stop dahrk-node               # stop
//   pm2 delete dahrk-node             # remove
const path = require('node:path');

module.exports = {
  apps: [
    {
      name: 'dahrk-node',
      cwd: path.join(__dirname, 'apps/edge-node'),
      script: 'node_modules/.bin/tsx',
      // --foreground is REQUIRED here. A bare `dahrk start` means "ensure the node is running as a
      // service", which would have the node install a launchd/systemd unit behind pm2's back - two
      // supervisors for one node, and pm2 supervising a process that immediately exits. pm2 IS the
      // supervisor, so the process it starts must be the worker.
      args: 'src/main.ts start --foreground',
      interpreter: 'none',
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      // A bad/missing enrolment token exits 78 (EX_CONFIG). Stop rather than crash-loop so the
      // misconfig is visible; any other non-zero exit still autorestarts.
      stop_exit_codes: [78],
      env: {
        // Required, secret - from the host env / .env, never committed. Legacy SKAKEL_ name accepted.
        DAHRK_ENROL_TOKEN: process.env.DAHRK_ENROL_TOKEN || process.env.SKAKEL_ENROL_TOKEN,
        // Optional overrides (DAHRK_HUB_URL, DAHRK_NODE_NAME, DAHRK_RUNTIMES, DAHRK_REPOS) are read
        // straight from the environment - set them in your shell / .env and pm2 passes them through.
      },
    },
  ],
};
