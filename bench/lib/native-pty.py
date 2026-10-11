# Native Claude Code in a pty on this machine: the reference row for the
# `claude` bench suite (suites/claude.mjs). Usage:
#   python3 -I native-pty.py BINARY CWD PROMPT_REGEX KEYS GAP_MS
# with the environment (HOME, ANTHROPIC_BASE_URL, ...) set by the caller.
# Prints one JSON line: {first_output, prompt, echo: [ms per key]} in ms, or {error}.
# Times are from exec (start) or from the write of a key (echo) to the bytes
# arriving on the pty master: the terminal emulator's parse and paint are not
# included, unlike the in-tab numbers' `.frame` twins.
import json, os, pty, re, select, sys, time

binary, cwd, prompt_src, keys, gap_ms = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], int(sys.argv[5])
ANSI = re.compile(rb'\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[@-_]')
PROMPT = re.compile(prompt_src)

pid, fd = pty.fork()
if pid == 0:
    os.chdir(cwd)
    os.execv(binary, [binary])

import fcntl, struct, termios
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))
t0 = time.monotonic()
buf = b''

def read_until(pred, limit_s):
    global buf
    end = time.monotonic() + limit_s
    while time.monotonic() < end:
        r, _, _ = select.select([fd], [], [], 0.05)
        if r:
            try:
                d = os.read(fd, 65536)
            except OSError:
                return None
            if not d:
                return None
            buf += d
            # answer terminal queries Ink and the TUI send (cursor position, device attributes)
            if b'\x1b[6n' in d: os.write(fd, b'\x1b[1;1R')
            if b'\x1b[c' in d or b'\x1b[0c' in d: os.write(fd, b'\x1b[?62;22c')
            if pred(): return time.monotonic()
    return None

def text(b): return ANSI.sub(b'', b).decode('utf-8', 'replace')

out = {}
try:
    t = read_until(lambda: len(buf) > 0, 120)
    if t is None: raise RuntimeError('no output in 120 s')
    out['first_output'] = (t - t0) * 1000
    t = read_until(lambda: PROMPT.search(text(buf)) is not None and re.search(r'[❯>]', text(buf)) is not None, 120)
    if t is None: raise RuntimeError('no prompt in 120 s: ' + text(buf)[-400:])
    out['prompt'] = (t - t0) * 1000
    time.sleep(1.5)
    read_until(lambda: False, 0.2)
    echo = []
    for k in keys:
        mark = len(buf)
        tk = time.monotonic()
        os.write(fd, k.encode())
        t = read_until(lambda: k in text(buf[mark:]), 10)
        if t is None: raise RuntimeError('no echo of %r' % k)
        echo.append((t - tk) * 1000)
        time.sleep(gap_ms / 1000)
        read_until(lambda: False, 0.05)
    out['echo'] = echo
except Exception as e:
    out['error'] = str(e)
finally:
    for s in (b'\x15', b'\x03', b'\x03'):
        try: os.write(fd, s); time.sleep(0.3)
        except OSError: pass
    try: os.kill(pid, 9)
    except OSError: pass
    try: os.waitpid(pid, 0)
    except OSError: pass
print(json.dumps(out))
