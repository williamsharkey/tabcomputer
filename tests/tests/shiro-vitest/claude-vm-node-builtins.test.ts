/**
 * What native Claude Code 2.1.296's bundle imports from Node's builtins, as
 * node-compat must provide it for claude --vm (docs/CLAUDE_VM.md, "Parity").
 * A name node-compat lacks is auto-stubbed (auto-stub.ts): it exists but does
 * nothing (a `*Sync` returns ''), which hides the gap. The list is the named
 * imports in the bundle's modules; KNOWN_MISSING are the gaps left, each
 * with what it costs.
 */
import { describe, it, expect } from 'vitest';
import { createTestShell } from './helpers';

const IMPORTED: Record<string, string[]> = {
  async_hooks: ['AsyncLocalStorage', 'AsyncResource'],
  buffer: ['Buffer', 'constants', 'isUtf8'],
  child_process: ['ChildProcess', 'exec', 'execFile', 'execFileSync', 'execSync', 'spawn', 'spawnSync'],
  crypto: ['X509Certificate', 'createCipheriv', 'createDecipheriv', 'createHash', 'createHmac', 'createPrivateKey', 'createPublicKey', 'generateKeyPairSync', 'randomBytes', 'randomFillSync', 'randomInt', 'randomUUID', 'sign', 'timingSafeEqual', 'verify'],
  dns: ['lookup', 'promises'],
  'dns/promises': ['lookup'],
  events: ['EventEmitter', 'once', 'setMaxListeners'],
  fs: ['accessSync', 'appendFileSync', 'chmodSync', 'close', 'closeSync', 'constants', 'createReadStream', 'createWriteStream', 'existsSync', 'fchmod', 'fchmodSync', 'fchown', 'fstat', 'fstatSync', 'fsync', 'fsyncSync', 'ftruncateSync', 'lstatSync', 'mkdirSync', 'mkdtempSync', 'open', 'openSync', 'promises', 'read', 'readFileSync', 'readSync', 'readdirSync', 'readlinkSync', 'realpath', 'realpathSync', 'renameSync', 'rmSync', 'rmdirSync', 'stat', 'statSync', 'statfsSync', 'unlink', 'unlinkSync', 'unwatchFile', 'utimesSync', 'watch', 'watchFile', 'writeFile', 'writeFileSync', 'writeSync'],
  'fs/promises': ['access', 'appendFile', 'chmod', 'constants', 'copyFile', 'link', 'lstat', 'lutimes', 'mkdir', 'mkdtemp', 'open', 'opendir', 'readFile', 'readdir', 'readlink', 'realpath', 'rename', 'rm', 'rmdir', 'stat', 'statfs', 'symlink', 'unlink', 'utimes', 'writeFile'],
  http: ['Agent', 'STATUS_CODES', 'createServer', 'request'],
  http2: ['Http2ServerRequest', 'constants'],
  https: ['Agent', 'createServer', 'request'],
  module: ['createRequire'],
  net: ['BlockList', 'Socket', 'connect', 'createConnection', 'createServer', 'isIP', 'isIPv4', 'isIPv6'],
  os: ['EOL', 'arch', 'availableParallelism', 'constants', 'devNull', 'endianness', 'freemem', 'getPriority', 'homedir', 'hostname', 'networkInterfaces', 'platform', 'release', 'setPriority', 'tmpdir', 'totalmem', 'type', 'uptime', 'userInfo', 'version'],
  path: ['basename', 'delimiter', 'dirname', 'extname', 'isAbsolute', 'join', 'normalize', 'parse', 'posix', 'relative', 'resolve', 'sep', 'win32'],
  'path/posix': ['join'],
  'path/win32': ['basename', 'isAbsolute'],
  perf_hooks: ['monitorEventLoopDelay'],
  process: ['cwd'],
  readline: ['createInterface'],
  stream: ['PassThrough', 'Readable', 'Stream', 'Transform', 'pipeline'],
  'stream/consumers': ['text'],
  'stream/promises': ['finished', 'pipeline'],
  string_decoder: ['StringDecoder'],
  'timers/promises': ['setImmediate', 'setTimeout'],
  tls: ['checkServerIdentity', 'connect', 'createSecureContext', 'rootCertificates'],
  tty: ['ReadStream', 'isatty'],
  url: ['URL', 'domainToASCII', 'fileURLToPath', 'parse', 'pathToFileURL'],
  util: ['debuglog', 'format', 'getSystemErrorName', 'inspect', 'isDeepStrictEqual', 'promisify', 'stripVTControlCharacters', 'types'],
  'util/types': ['isArgumentsObject', 'isArrayBuffer', 'isBigIntObject', 'isBooleanObject', 'isDataView', 'isDate', 'isGeneratorObject', 'isMap', 'isMapIterator', 'isModuleNamespaceObject', 'isNativeError', 'isNumberObject', 'isPromise', 'isProxy', 'isRegExp', 'isSet', 'isSetIterator', 'isSharedArrayBuffer', 'isStringObject', 'isSymbolObject', 'isTypedArray', 'isUint8Array', 'isWeakMap', 'isWeakSet'],
  v8: ['getHeapSpaceStatistics', 'getHeapStatistics'],
  zlib: ['constants', 'createZstdDecompress', 'deflate', 'deflateRaw', 'deflateRawSync', 'deflateSync', 'gunzip', 'gzip', 'gzipSync', 'inflateRaw', 'inflateRawSync'],
};

/** Still auto-stubbed (docs/CLAUDE_VM.md, "Parity", has what each costs) */
const KNOWN_MISSING = [
  'child_process.ChildProcess', // instanceof checks only
  'crypto.X509Certificate', // custom CA / gateway certificate checks
  'crypto.createCipheriv', 'crypto.createDecipheriv', // the claude.ai MCP connectors' discovery cache (AES-256-GCM)
  'crypto.generateKeyPairSync', 'crypto.sign', 'crypto.verify', // device keys (P-256), DPoP proofs, a sandbox CA
  'http2.Http2ServerRequest', // instanceof checks in a bundled server adapter
  'zlib.createZstdDecompress', // the native updater, which tabcomputer's `claude update` replaces
];

describe("claude --vm: Node builtins native Claude Code's bundle imports", () => {
  it('node-compat has each of them (not an auto-stub), except the known gaps', async () => {
    const { fs, shell } = await createTestShell();
    await fs.writeFile('/tmp/want.json', JSON.stringify(IMPORTED));
    await fs.writeFile('/tmp/probe.js', `
      const want = JSON.parse(require('fs').readFileSync('/tmp/want.json', 'utf8'));
      const missing = [];
      for (const [m, names] of Object.entries(want)) {
        const mod = require(m);
        for (const n of names) if (!(n in mod)) missing.push(m + '.' + n);
      }
      console.log(JSON.stringify(missing));
    `);
    let out = '';
    await shell.execute('node /tmp/probe.js', (s) => { out += s; }, (s) => { out += s; });
    const missing: string[] = JSON.parse(out.trim().split('\n').pop()!);
    expect(missing.filter((m) => !KNOWN_MISSING.includes(m))).toEqual([]);
  }, 60_000);

  it('ftruncateSync cuts an open file (the in-place write fallback), mkdtempSync makes a directory, statfs answers, fchmodSync sets the mode', async () => {
    const { shell } = await createTestShell();
    let out = '';
    await shell.execute(`mkdir -p /tmp/bt && node -e '
      const fs = require("fs");
      fs.writeFileSync("/tmp/bt/f.txt", "a much longer old content\\n");
      const fd = fs.openSync("/tmp/bt/f.txt", "r+");
      fs.ftruncateSync(fd, 0);
      fs.writeSync(fd, "new\\n");
      fs.fchmodSync(fd, 0o755);
      fs.closeSync(fd);
      const d = fs.mkdtempSync("/tmp/bt/x-");
      const st = fs.statfsSync("/tmp/bt", { bigint: true });
      console.log(JSON.stringify([fs.readFileSync("/tmp/bt/f.txt", "utf8"), /^\\/tmp\\/bt\\/x-[A-Za-z0-9]{6}$/.test(d), fs.statSync(d).isDirectory(), typeof st.bavail, st.bavail * st.bsize > 1n << 30n]));
      try { fs.statfsSync("/tmp/bt/none") } catch (e) { console.log(e.code) }
      require("fs/promises").statfs("/tmp").then((s) => console.log(s.type === 0xef53));
    ' && stat -c %a /tmp/bt/f.txt`, (s) => { out += s; }, (s) => { out += s; });
    const lines = out.replace(/\r/g, '').trim().split('\n');
    expect(JSON.parse(lines[0])).toEqual(['new\n', true, true, 'bigint', true]);
    expect(lines.slice(1)).toEqual(['ENOENT', 'true', '755']);
  }, 60_000);
});
