/**
 * `dahrk update` - the local, user-initiated self-update to the latest published client. The operator
 * runs it themselves on their own machine, so there is no hub involvement and no trust boundary: it is
 * the plain "upgrade me" counterpart to a future hub-triggered remote upgrade (DHK-341), which reuses
 * this same local path.
 *
 * It answers "am I current, and if not, upgrade me": read this build's version, ask the npm registry
 * for the latest published one (the single source of "latest" across every channel - Homebrew's formula
 * points at the same npm tarball), and compare. If current, it is a no-op. If behind, it detects how the
 * client was installed (npm / Homebrew / curl) from the resolved path of its own bin and does the right
 * thing: run the package manager where that is safe to automate, or print the exact upgrade command when
 * it cannot tell or cannot safely run it. `--check` reports `current -> latest` without applying.
 *
 * The decision logic is pure (channel inference, version comparison, command selection) so it unit-tests
 * without a network or a real install; `runUpdate` is the thin IO shell that fetches, prints, and spawns.
 */
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";

/** How this client was installed, which decides how it upgrades. `unknown` covers a curl install.sh, a
 *  run-from-source checkout, or anything we cannot positively identify - we print the command, never guess. */
export type Channel = "npm" | "homebrew" | "unknown";

/** The npm registry dist-tag endpoint that names the latest published version. This is the shared
 *  "latest" source for every channel: the Homebrew formula's `url` resolves to the same npm tarball, and
 *  the curl installer pulls from npm too, so one registry read answers "what is the newest release?". */
export const LATEST_URL = "https://registry.npmjs.org/dahrk-node/latest";

/** The exact per-channel upgrade commands, as a copy-paste line each. Re-running an install upgrades in
 *  place, so these double as the printed instructions when we cannot (or should not) run them ourselves. */
export const CHANNEL_COMMANDS = {
  npm: "npm install -g dahrk-node@latest",
  homebrew: "brew upgrade dahrkai/tap/dahrk",
  curl: "curl -fsSL https://dahrk.ai/install.sh | sh",
} as const;

/** The package-manager invocation that upgrades a given channel in place: argv (to spawn) and the same
 *  as a display string (to print). `unknown` has no single command - the caller prints all channels. */
export function upgradeCommand(channel: Channel): { argv: string[]; display: string } | null {
  switch (channel) {
    case "npm":
      return { argv: ["npm", "install", "-g", "dahrk-node@latest"], display: CHANNEL_COMMANDS.npm };
    case "homebrew":
      return { argv: ["brew", "upgrade", "dahrkai/tap/dahrk"], display: CHANNEL_COMMANDS.homebrew };
    case "unknown":
      return null;
  }
}

/** Infer the install channel from the resolved path of this client's bin. A global npm install resolves
 *  under `node_modules/dahrk-node`; a Homebrew install symlinks its bin into the Cellar. npm is checked
 *  first because a Homebrew-provided Node still installs global npm packages under the Homebrew prefix -
 *  those are npm installs and upgrade via npm, not `brew`. Anything else is `unknown`. */
export function detectChannel(binPath: string | undefined): Channel {
  if (!binPath) return "unknown";
  let resolved = binPath;
  try {
    resolved = realpathSync(binPath);
  } catch {
    // Use the raw path if it cannot be resolved (e.g. already deleted); the patterns still apply.
  }
  if (/[\\/]node_modules[\\/]dahrk-node[\\/]/.test(resolved)) return "npm";
  if (/[\\/](Cellar|homebrew)[\\/]/.test(resolved)) return "homebrew";
  return "unknown";
}

/** Parse a semver core (major.minor.patch, ignoring any `-prerelease`/`+build`) into a numeric tuple, or
 *  null when it is not a recognisable version. */
function core(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim().replace(/^v/, ""));
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** True iff `latest` is strictly newer than `current` by semver core. Either version being unparseable
 *  yields false: we never claim an update we cannot actually verify. Prereleases are compared by core
 *  only, which is sufficient here (releases are plain `x.y.z`). */
export function isNewer(latest: string, current: string): boolean {
  const a = core(latest);
  const b = core(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i]! > b[i]!) return true;
    if (a[i]! < b[i]!) return false;
  }
  return false;
}

/** Injectable IO so `runUpdate` exercises without a network or a real package manager. */
export interface UpdateDeps {
  /** This client's bin path (`process.argv[1]`), resolved to infer the install channel. */
  binPath?: string;
  /** Fetch the latest published version; throws on a network/registry failure. */
  fetchLatest: () => Promise<string>;
  /** Spawn the upgrade command and return its exit code (0 = success). */
  runUpgrade: (argv: string[]) => number;
  out: (line: string) => void;
}

export interface UpdateInputs {
  /** This build's version (the compiled `CLIENT_VERSION`). */
  currentVersion: string;
  /** `--check`: report whether an update is available without applying it. */
  check: boolean;
}

/** Print the per-channel upgrade commands - the fallback when we cannot tell how the client was installed. */
function printChannelCommands(out: (line: string) => void): void {
  out(`  npm:      ${CHANNEL_COMMANDS.npm}`);
  out(`  Homebrew: ${CHANNEL_COMMANDS.homebrew}`);
  out(`  curl:     ${CHANNEL_COMMANDS.curl}`);
}

/**
 * Run the update: read current vs latest, then either report a no-op, report availability (`--check`),
 * run the channel's upgrade command, or print it when the channel is unknown. Returns the process exit
 * code: 0 when current / reported / upgraded, the upgrade command's own code on a run, and 1 when the
 * latest version could not be determined.
 */
export async function runUpdate(inputs: UpdateInputs, deps: Partial<UpdateDeps> = {}): Promise<number> {
  const d = { ...defaultDeps(), ...deps };
  const current = inputs.currentVersion;

  d.out("dahrk update");
  d.out("");

  let latest: string;
  try {
    latest = await d.fetchLatest();
  } catch (e) {
    d.out(`Could not determine the latest version: ${(e as Error).message}`);
    d.out(`You are on ${current}. See https://www.npmjs.com/package/dahrk-node for releases.`);
    return 1;
  }

  if (!isNewer(latest, current)) {
    d.out(`Already on the latest version (${current}).`);
    return 0;
  }

  d.out(`Update available: ${current} -> ${latest}`);
  const channel = detectChannel(d.binPath);
  const cmd = upgradeCommand(channel);

  // `--check`: report availability and how to apply it, but change nothing.
  if (inputs.check) {
    d.out("");
    if (cmd) {
      d.out(`Run \`dahrk update\` to upgrade (${channel}: ${cmd.display}).`);
    } else {
      d.out("Run \`dahrk update\`, or upgrade with the command for your install channel:");
      printChannelCommands(d.out);
    }
    return 0;
  }

  // Unknown channel: we cannot safely automate the upgrade, so print the exact commands instead.
  if (!cmd) {
    d.out("");
    d.out("Could not tell how this client was installed. Upgrade with the command for your channel:");
    printChannelCommands(d.out);
    return 0;
  }

  // Known channel: run the package manager in place.
  d.out("");
  d.out(`Upgrading via ${channel}: ${cmd.display}`);
  d.out("");
  const code = d.runUpgrade(cmd.argv);
  d.out("");
  if (code === 0) {
    d.out(`Upgraded to ${latest}. Restart a running node (\`dahrk start\`) to pick it up.`);
  } else {
    d.out(`Upgrade exited with code ${code}. Run it yourself to see the error: ${cmd.display}`);
  }
  return code;
}

/** Fetch the latest published version from the npm registry's `latest` dist-tag. */
async function fetchLatestVersion(): Promise<string> {
  const res = await fetch(LATEST_URL, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`registry responded ${res.status}`);
  const body = (await res.json()) as { version?: unknown };
  if (typeof body.version !== "string" || !body.version) throw new Error("registry returned no version");
  return body.version;
}

/** Spawn an upgrade command, inheriting stdio so the operator sees the package manager's own output.
 *  A non-zero exit (or spawn failure) surfaces as its status code, defaulting to 1. */
function spawnUpgrade(argv: string[]): number {
  const [cmd, ...args] = argv;
  try {
    execFileSync(cmd as string, args, { stdio: "inherit" });
    return 0;
  } catch (e) {
    const status = (e as { status?: unknown }).status;
    return typeof status === "number" ? status : 1;
  }
}

const defaultDeps = (): UpdateDeps => ({
  binPath: process.argv[1],
  fetchLatest: fetchLatestVersion,
  runUpgrade: spawnUpgrade,
  out: (line: string) => void process.stdout.write(`${line}\n`),
});
