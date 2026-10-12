/**
 * The system gdbinit that makes `gdb ./prog` then `run` work in tabcomputer
 * (docs/research/GDB.md): Debian's gdb reads every file in
 * /etc/gdb/gdbinit.d at startup. Kept apart from gdbserver.ts so that boot
 * (path-shims.ts) loads only this text.
 */
/** `/etc/gdb/gdbinit.d/tabcomputer.gdb`: `run` starts the program through tabcomputer-gdbserver. */
export const GDBINIT_PATH = '/etc/gdb/gdbinit.d/tabcomputer.gdb';
export const GDBINIT = `# tabcomputer: programs run in the x86-64 engine, which has no ptrace. gdb
# debugs them through the engine's debug stub (tabcomputer-gdbserver), which
# \`run\`, \`start\` and \`starti\` connect to. Libraries are read from the
# filesystem, not over the connection.
set sysroot /
python
import gdb
def _tabcomputer_connect():
    inf = gdb.selected_inferior()
    conn = getattr(inf, "connection", None)
    if conn is None or not conn.is_valid():
        gdb.execute("target extended-remote | exec tabcomputer-gdbserver", to_string=True)
    name = gdb.current_progspace().filename
    if name:
        gdb.execute("set remote exec-file " + name, to_string=True)
end
define hook-run
python _tabcomputer_connect()
end
define hook-start
python _tabcomputer_connect()
end
define hook-starti
python _tabcomputer_connect()
end
`;
