/**
 * What the stdio process is told on its command line and in its environment, read into the options
 * `createVideoKitMcpServer` takes.
 *
 * A file of its own rather than a few lines in `stdio.ts`, because `stdio.ts` starts a server the
 * moment it is imported and this is the part worth testing: a test imports this, hands it an argv
 * and an environment of its own, and never opens a transport. It reads nothing global for the same
 * reason - `stdio.ts` passes `process.argv` and `process.env` in.
 *
 * An MCP client launches this process from a configuration it never shows anyone, so there is one
 * switch, and two ways to throw it:
 *
 *   --no-zoom                         in `args`, for a client that passes arguments, which is all of
 *                                     the common ones.
 *   CAPACITOR_VIDEO_KIT_MCP_ZOOM=0    in `env`, for one that can set the environment and not the
 *                                     command line, or a launcher that owns the command line itself.
 *                                     Also 'false', 'off', 'no', as `CAPACITOR_VIDEO_KIT_MCP` reads at
 *                                     build time; '1', 'true', 'on', 'yes' or unset leave Zoom on.
 *
 * Either one turns Zoom off, and neither can turn it back on against the other: on is the default,
 * so the only thing either can usefully say is off, and a host that said it in either place meant
 * it.
 *
 * ANYTHING ELSE IS REFUSED, and the process does not start. A server that shrugged at an argument it
 * did not know would start with Zoom ON for `--no-zooms`, `--nozoom` or `--zoom=false`, which is
 * precisely the leak the switch exists to close, and nothing would say so until an agent put a zoom
 * in a post. Refused, the client shows the server as failed with the reason on stderr, which is a
 * thing somebody reads the day they write the configuration. The same goes for a value in the
 * environment variable that is neither on nor off.
 */
import type { McpEditingOptions } from './ops';

/** The one argument there is. */
export const NO_ZOOM_FLAG = '--no-zoom';

/** The environment's way to say the same, for a client that cannot pass arguments. */
export const ZOOM_ENV = 'CAPACITOR_VIDEO_KIT_MCP_ZOOM';

const OFF = ['0', 'false', 'off', 'no'];
const ON = ['1', 'true', 'on', 'yes'];

/** An argument or a value this process will not start with. `stdio.ts` prints it and exits 2. */
export class StdioUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StdioUsageError';
  }
}

export interface StdioOptions {
  /** For `createVideoKitMcpServer`. `zoom` is always settled, true or false, and is all it holds. */
  editing: Required<Pick<McpEditingOptions, 'zoom'>>;
  /**
   * What the startup line on stderr adds: empty with Zoom on, and with it off, which switch turned
   * it off. Whoever reads a client's server log to find out why an agent cannot add a zoom should
   * find the answer on the line that says the server started.
   */
  note: string;
}

/**
 * Reads the arguments after the script's own path - `process.argv.slice(2)` - and the environment.
 *
 * Throws [StdioUsageError] for anything it does not recognise, for the reason at the top of the file.
 */
export function readStdioOptions(args: readonly string[], env: Readonly<Record<string, string | undefined>>): StdioOptions {
  const by: string[] = [];

  for (const arg of args) {
    if (arg !== NO_ZOOM_FLAG) {
      throw new StdioUsageError(`unknown argument "${arg}". The one argument this server takes is ${NO_ZOOM_FLAG}.`);
    }
    // Said twice is still said once; a launcher that appends its own copy should not stop the server.
    if (!by.includes(NO_ZOOM_FLAG)) by.push(NO_ZOOM_FLAG);
  }

  const raw = env[ZOOM_ENV];
  const value = (raw ?? '').trim().toLowerCase();
  if (OFF.includes(value)) by.push(`${ZOOM_ENV}=${raw}`);
  else if (value !== '' && !ON.includes(value)) {
    throw new StdioUsageError(
      `${ZOOM_ENV}="${raw}" is neither off (${OFF.join(', ')}) nor on (${ON.join(', ')}).`,
    );
  }

  const zoom = by.length === 0;
  return {
    editing: { zoom },
    note: zoom ? '' : ` with Zoom off (${by.join(', ')}): no zoom op, and no manifest holding a zoom, is taken`,
  };
}
