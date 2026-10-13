/**
 * Command links: an OSC 8 link to `shiro://cmd/<command>` types the command at
 * the prompt when it is clicked (the banner's `claude`, the desktop's "try:"
 * line).
 *
 * Any program can print such a link, and a `cat` of a file can too. So a click
 * runs a command only when tabcomputer itself offers it: the code that writes
 * a link gets its address from `offerCommand`, and the terminal asks
 * `offeredCommand` before it runs anything. A link to any other command does
 * nothing, whoever printed it.
 */

const PREFIX = 'shiro://cmd/';
const offered = new Set<string>();

/** The address of a link that types `cmd` at the prompt. Only tabcomputer's own code calls this, with a command it wrote itself. */
export function offerCommand(cmd: string): string {
  offered.add(cmd);
  return PREFIX + encodeURIComponent(cmd);
}

/** Whether `uri` is a command link at all (offered or not) */
export const isCommandLink = (uri: string): boolean => uri.startsWith(PREFIX);

/** The command a link runs: the one it names when tabcomputer offered it, else null */
export function offeredCommand(uri: string): string | null {
  if (!uri.startsWith(PREFIX)) return null;
  let cmd: string;
  try { cmd = decodeURIComponent(uri.slice(PREFIX.length)); } catch { return null; }
  return offered.has(cmd) ? cmd : null;
}
