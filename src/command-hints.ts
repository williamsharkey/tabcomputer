/**
 * What "command not found" adds for a program people expect and that is not
 * a package here: what to use instead. Lines are printed indented under the
 * shell's own message.
 */
const HINTS: Record<string, string[]> = {
  // CS50's memory labs call it. Neither it nor the sanitizer has been checked
  // under the x86 emulator, so the text promises nothing.
  valgrind: [
    'valgrind is not in the C toolchain here and has not been made to run under tabcomputer\'s x86 emulator.',
    'For memory errors, try the compiler\'s own checker: gcc -g -fsanitize=address prog.c && ./a.out',
    '(gcc comes with: toolchain install c). gdb is there too: gdb ./a.out',
  ],
};

export function notFoundHint(name: string): string[] {
  return Object.prototype.hasOwnProperty.call(HINTS, name) ? HINTS[name] : [];
}
