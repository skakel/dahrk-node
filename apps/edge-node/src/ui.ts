/**
 * The client's one presentation layer: every command prints through here, so `dahrk` reads as one tool
 * rather than seven that happen to share a binary.
 *
 * Before this, each command invented its own formatting - `status` had a padded label gutter, `doctor` had
 * `[PASS]` / `[WARN]` / `[FAIL]` tags, `preflight` was the only place that had ever used a tick, and the
 * same `process.stdout.write` sink was copy-pasted into seven modules. Nothing was coloured, and nothing
 * agreed with anything else.
 *
 * Two rules hold the whole thing together:
 *
 *  - **Colour classifies; it never decorates.** Green / amber / red mean pass / warn / fail and nothing
 *    else, and dim means "chrome, not content" (labels, next-step hints). A line that is merely important
 *    does not get a colour, because if everything is coloured then nothing is.
 *  - **The answer comes first.** A command that reports state leads with a single symboled verdict line,
 *    then the detail, then the hints. You should be able to stop reading after the first line.
 *
 * There is no dependency here. Colour is `node:util`'s `styleText`, which has been in Node since 22 - the
 * floor this client already requires - so the whole layer costs nothing to install and nothing to audit.
 * We do our own capability gate rather than leaning on `styleText`'s (it only learned to check the stream
 * in 22.8, and we support 22.0), which also makes the decision injectable and therefore testable.
 */
import { styleText } from "node:util";

/** What the terminal on the other end can actually render. Resolved once, from the environment. */
export interface Capabilities {
  /** May we emit ANSI colour at all? */
  colour: boolean;
  /** May we emit non-ASCII glyphs (ticks, crosses)? */
  unicode: boolean;
}

/**
 * Work out what the terminal supports.
 *
 * Colour is off unless stdout is a real terminal, which is the rule that keeps `dahrk status | jq` and a CI
 * log free of escape codes without anybody having to pass a flag. On top of that we honour the two
 * conventions every CLI is expected to: `NO_COLOR` (any value at all means no colour) and `TERM=dumb`.
 * `FORCE_COLOR` is the escape hatch for someone who is piping deliberately and wants the colour anyway.
 *
 * Unicode follows the locale, because a terminal in a non-UTF-8 locale renders a tick as mojibake, which is
 * worse than the ASCII we would have used instead.
 */
export function detectCapabilities(
  env: NodeJS.ProcessEnv = process.env,
  isTty: boolean = Boolean(process.stdout.isTTY),
): Capabilities {
  const forced = env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "0";
  const colour = forced || (isTty && env.NO_COLOR === undefined && env.TERM !== "dumb");
  const locale = `${env.LC_ALL ?? ""}${env.LC_CTYPE ?? ""}${env.LANG ?? ""}`;
  const unicode = process.platform !== "win32" && (locale === "" || /UTF-?8/i.test(locale));
  return { colour, unicode };
}

/** The resolved capabilities for this process. Everything below reads them; tests override by calling the
 *  `*With` variants, so no test has to own a fake TTY. */
let caps: Capabilities = detectCapabilities();

/** Override the detected capabilities (tests, and `--no-color`). */
export function setCapabilities(next: Capabilities): void {
  caps = next;
}

export const capabilities = (): Capabilities => caps;

/** The styles we use, and nothing else. Keeping the palette closed is what stops the output drifting back
 *  into a christmas tree one well-meaning line at a time. */
type Style = "green" | "red" | "yellow" | "dim" | "bold" | "cyan";

const paint = (style: Style, text: string): string =>
  // `validateStream: false` because our own gate above has already decided; the option is ignored by the
  // Node 22.0-22.7 signature, which had no stream check at all, so this is correct on every supported Node.
  caps.colour ? styleText(style, text, { validateStream: false }) : text;

export const dim = (s: string): string => paint("dim", s);
export const bold = (s: string): string => paint("bold", s);
export const green = (s: string): string => paint("green", s);
export const red = (s: string): string => paint("red", s);

/** Amber `#f5a524` is the brand's only accent (see CLAUDE.md), so it is the only colour here that is not a
 *  plain status colour. Truecolor when the terminal has it, plain yellow when it does not - the point is the
 *  warmth, and yellow keeps that on a 16-colour terminal rather than falling back to nothing. */
export function amber(s: string): string {
  if (!caps.colour) return s;
  const depth = process.stdout.getColorDepth?.() ?? 4;
  return depth >= 24 ? `\x1b[38;2;245;165;36m${s}\x1b[39m` : paint("yellow", s);
}

/** The status vocabulary, shared by `status`, `doctor` and `preflight` so that a tick means the same thing
 *  wherever you see it. ASCII fallbacks for a terminal that cannot render the glyphs. */
export type Level = "ok" | "warn" | "fail" | "info";

const GLYPH: Record<Level, { unicode: string; ascii: string }> = {
  ok: { unicode: "✔", ascii: "OK" },
  warn: { unicode: "▲", ascii: "!" },
  fail: { unicode: "✖", ascii: "x" },
  info: { unicode: "•", ascii: "-" },
};

const COLOUR: Record<Level, (s: string) => string> = {
  ok: green,
  warn: amber,
  fail: red,
  info: dim,
};

/** The bare glyph for a level, coloured and capability-appropriate. */
export const symbol = (level: Level): string =>
  COLOUR[level](caps.unicode ? GLYPH[level].unicode : GLYPH[level].ascii);

/** The "from -> to" connector, e.g. in `0.1.12 -> 0.1.14`. A getter, not a constant, because capabilities
 *  can be reset by a test after this module is first evaluated. */
export const arrow = (): string => (caps.unicode ? "→" : "->");

/** A verdict line: the symbol, then the thing being judged. This is the line a command leads with, and
 *  ideally the only one anybody has to read. */
export const verdict = (level: Level, text: string): string => `  ${symbol(level)} ${bold(text)}`;

/** Width of the label gutter in a `kv` row. Wide enough for "Runtimes" and "Node id" without wrapping the
 *  values on an 80-column terminal. */
const LABEL_WIDTH = 11;

/** One label / value row: a dim label in a fixed gutter, then the value. The workhorse of every report.
 *  An empty label indents a continuation line under the previous row. */
export function kv(label: string, value: string): string {
  const gutter = label ? dim(label.padEnd(LABEL_WIDTH)) : " ".repeat(LABEL_WIDTH);
  return `  ${gutter}${value}`;
}

/** A next-step hint. Always dim, always last: it is the thing you read when the report did not already tell
 *  you what you wanted, so it must never compete with the report itself. */
export const hint = (text: string): string => `  ${dim(text)}`;

/** A row of next-step commands, rendered as one dim line: `logs: dahrk logs -f   stop: dahrk stop`. */
export const hints = (pairs: Array<[string, string]>): string =>
  hint(pairs.map(([label, cmd]) => `${label}: ${cmd}`).join("   "));

/** The single stdout sink, replacing the seven identical copies this module was extracted from. */
export const out = (line: string): void => void process.stdout.write(`${line}\n`);

/** Strip ANSI escapes from a rendered line.
 *
 *  Needed because not every consumer of a rendered line is a terminal. `dahrk diagnose` runs the doctor into
 *  a BUFFER and writes the result into a JSON support bundle: stdout is a TTY (the operator is right there),
 *  so colour is correctly on, but the bundle is a file that someone will read in an editor and paste into an
 *  issue. Escape codes belong on the terminal, not in the artefact. */
// eslint-disable-next-line no-control-regex
export const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

/** Errors and warnings go to stderr, so that `dahrk status --json > f` puts JSON in the file and the
 *  complaint on the terminal, rather than mixing the two into the file. */
export const err = (line: string): void => void process.stderr.write(`${line}\n`);

/** A human duration for an elapsed millisecond count: `4s`, `12m`, `2h 14m`, `3d 4h`. Used for job elapsed
 *  times and "last connected" ages, which is why it is deliberately coarse - nobody needs `2h 14m 09s`. */
export function humanDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 === 0 ? `${h}h` : `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return h % 24 === 0 ? `${d}d` : `${d}d ${h % 24}h`;
}

/** "4m ago" / "just now". The wording that keeps a cached fact honest: it says when we last knew, not what
 *  is true now. */
export const ago = (ms: number): string => (ms < 5000 ? "just now" : `${humanDuration(ms)} ago`);

/** Is there a human at a terminal to answer a question? A piped or redirected command - the curl installer,
 *  a provisioning script, CI - must never block waiting on an answer nobody is there to give. Both streams
 *  are checked: a TTY stdout with a redirected stdin still has nobody to type. */
export const isInteractive = (): boolean => Boolean(process.stdin.isTTY && process.stdout.isTTY);

/** Ask a yes/no question, defaulting to yes on a bare Enter. Only ever call this behind `isInteractive`. */
export async function confirm(question: string): Promise<boolean> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`  ${question} ${dim("[Y/n]")} `)).trim().toLowerCase();
    return answer === "" || answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}
