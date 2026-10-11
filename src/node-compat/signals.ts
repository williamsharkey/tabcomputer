/**
 * Signal names and numbers as node's os.constants.signals has them (Linux), for
 * child_process: kill(sig) takes either, and a child a signal ended reports its
 * name ('exit'/'close' (null, 'SIGTERM'), signalCode, spawnSync's and execSync's
 * signal), as node does (tabcomputer#89).
 */
export const SIGNALS: Record<string, number> = {
  SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4, SIGTRAP: 5, SIGABRT: 6, SIGIOT: 6,
  SIGBUS: 7, SIGFPE: 8, SIGKILL: 9, SIGUSR1: 10, SIGSEGV: 11, SIGUSR2: 12,
  SIGPIPE: 13, SIGALRM: 14, SIGTERM: 15, SIGSTKFLT: 16, SIGCHLD: 17, SIGCONT: 18, SIGSTOP: 19,
  SIGTSTP: 20, SIGTTIN: 21, SIGTTOU: 22, SIGURG: 23, SIGXCPU: 24, SIGXFSZ: 25,
  SIGVTALRM: 26, SIGPROF: 27, SIGWINCH: 28, SIGIO: 29, SIGPOLL: 29, SIGPWR: 30, SIGSYS: 31,
};

/** kill()'s signal as a number (default SIGTERM; 0 asks whether the child is there); node's ERR_UNKNOWN_SIGNAL otherwise */
export function signalNumber(sig: string | number | undefined | null): number {
  if (sig === undefined || sig === null) return SIGNALS.SIGTERM;
  if (typeof sig === 'number' && Number.isInteger(sig) && sig >= 0 && sig < 65) return sig;
  if (typeof sig === 'string' && SIGNALS[sig] !== undefined) return SIGNALS[sig];
  throw Object.assign(new TypeError(`Unknown signal: ${sig}`), { code: 'ERR_UNKNOWN_SIGNAL' });
}

/** A signal number's name ('SIGTERM'), or null for none */
export function signalName(n: number | null | undefined): string | null {
  if (n === null || n === undefined || n === 0) return null;
  for (const [name, v] of Object.entries(SIGNALS)) if (v === n && name !== 'SIGIOT' && name !== 'SIGPOLL') return name;
  return `SIG${n}`;
}
