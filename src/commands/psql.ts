/**
 * psql, createdb, dropdb, pg_isready and `service postgresql ...` for the
 * tab's postgres service (src/postgres/service.ts, docs/POSTGRES.md).
 *
 * psql is a small one written for the tab: -c, -f, -d, -U, -h, -p, -l, -t,
 * -A, -F, -x, -q, -1, -v ON_ERROR_STOP=1, --csv, a script on stdin, and at a
 * terminal the prompt with \l, \dt, \d NAME, \du, \dn, \c, \i, \copy, \x,
 * \timing, \conninfo, \q. It speaks the wire protocol to localhost:5432, so
 * it starts the service by connecting. Debian's psql (`apt install
 * postgresql-client`) takes its place once installed.
 */
import type { Command, CommandContext } from './index';
import { getKernel } from '../kernel/kernel';
import { installNet, netStackOf, type NetStack } from '../kernel/net';
import { PgClient, PgError } from '../postgres/client';
import { defaultFormat, formatTable, type FormatOptions, type Table } from '../postgres/psql-format';
import { PG_DATA, PG_MAJOR, PG_PORT, currentPostgres, installPostgres, postgresService, type PostgresService } from '../postgres/service';
import { scanSql } from '../postgres/sql-split';
import { ident, literal, type Reply, type Result } from '../postgres/wire';

/** The tab's network stack with the postgres service on call (main.ts does this at boot; tests and odd boots get it here). */
export function postgresFor(ctx: Pick<CommandContext, 'fs'>): { stack: NetStack; service: PostgresService } {
  const kernel = getKernel();
  if (!netStackOf(kernel)) installNet(kernel);
  const stack = netStackOf(kernel)!;
  if (!stack.onDemand.has(PG_PORT) || !currentPostgres()) installPostgres({ fs: ctx.fs, stack, kernel });
  return { stack, service: postgresService({ fs: ctx.fs, stack, kernel }) };
}

const LOCAL = /^(localhost|127\.0\.0\.1|::1|)$/;

interface Target { host: string; port: number; user: string; database: string }

/** Where a libpq program would connect, from the environment (PGHOST, PGPORT, PGUSER, PGDATABASE). */
function defaultTarget(env: Record<string, string>): Target & { databaseGiven: boolean } {
  const user = env.PGUSER || env.USER || 'user';
  const host = env.PGHOST && !env.PGHOST.startsWith('/') ? env.PGHOST : 'localhost';
  return { host, port: parseInt(env.PGPORT || '', 10) || PG_PORT, user, database: env.PGDATABASE || user, databaseGiven: !!env.PGDATABASE };
}

/** A `postgresql://user:pw@host:port/db` address or a `key=value ...` string, into `t`. False when `word` is a plain database name. */
function applyConninfo(word: string, t: Target): boolean {
  if (/^postgres(ql)?:\/\//.test(word)) {
    try {
      const u = new URL(word.replace(/^postgres(ql)?:/, 'http:'));
      if (u.hostname) t.host = decodeURIComponent(u.hostname);
      if (u.port) t.port = parseInt(u.port, 10);
      if (u.username) t.user = decodeURIComponent(u.username);
      const db = decodeURIComponent(u.pathname.replace(/^\//, ''));
      if (db) t.database = db; else if (u.username) t.database = t.user;
      for (const [k, v] of u.searchParams) applyKey(k, v, t);
    } catch { return false; }
    return true;
  }
  if (!word.includes('=')) return false;
  for (const m of word.matchAll(/(\w+)\s*=\s*('(?:[^'\\]|\\.)*'|\S*)/g)) applyKey(m[1], m[2].replace(/^'|'$/g, ''), t);
  return true;
}

function applyKey(k: string, v: string, t: Target): void {
  if (k === 'host' && !v.startsWith('/')) t.host = v;
  else if (k === 'port') t.port = parseInt(v, 10) || t.port;
  else if (k === 'user') t.user = v;
  else if (k === 'dbname') t.database = v;
}

/**
 * The very first start downloads PostgreSQL and makes the cluster: say so at
 * a terminal, where a pause would look like a hang. Later starts are quick.
 */
async function firstStartNote(ctx: CommandContext, service: PostgresService, appName: string): Promise<void> {
  if (service.status === 'running' || !ctx.terminal || ctx.stderrIsTTY === false) return;
  if (await ctx.fs.exists(`${PG_DATA}/PG_VERSION`)) return;
  ctx.terminal.writeOutput(`${appName}: starting PostgreSQL ${PG_MAJOR} for the first time (a 4 MB download, then a new database cluster)\r\n`);
}

async function connect(ctx: CommandContext, t: Target, appName: string): Promise<PgClient> {
  const { stack, service } = postgresFor(ctx);
  if (LOCAL.test(t.host) && t.port === service.port) await firstStartNote(ctx, service, appName);
  const client = await PgClient.connect({ stack, host: t.host || 'localhost', port: t.port, user: t.user, database: t.database, appName });
  if (service.info?.fresh && !toldOfOld) {
    toldOfOld = true;
    const old = await earlierDatabases();
    if (old.length) ctx.stderr += `${appName}: this is a new PostgreSQL server; the databases the earlier built-in psql kept (${old.join(', ')}) are not in it.\n`;
  }
  return client;
}

let toldOfOld = false;

/** Databases of the psql command this one replaced (PGlite's own IndexedDB stores, one per name). */
async function earlierDatabases(): Promise<string[]> {
  try {
    const all = await (globalThis.indexedDB as IDBFactory & { databases?: () => Promise<{ name?: string }[]> })?.databases?.() ?? [];
    return all.map((d) => /^\/pglite\/shiro-pg-(.+)$/.exec(d.name ?? '')?.[1]).filter((n): n is string => !!n);
  } catch { return []; }
}

// ── psql ──

const HELP = `psql is the PostgreSQL interactive terminal (the tab's built-in one).

Usage:
  psql [OPTION]... [DBNAME [USERNAME]]

  -c, --command=COMMAND    run only single command (SQL or internal) and exit
  -d, --dbname=DBNAME      database name to connect to
  -f, --file=FILENAME      execute commands from file, then exit
  -l, --list               list available databases, then exit
  -v, --set=NAME=VALUE     set a variable (ON_ERROR_STOP=1 stops a script at an error)
  -1, --single-transaction execute as a single transaction
  -q, --quiet              run quietly (no messages, only query output)
  -A, --no-align           unaligned table output mode
      --csv                CSV (Comma-Separated Values) table output mode
  -F, --field-separator=STRING   field separator for unaligned output (default: "|")
  -t, --tuples-only        print rows only
  -x, --expanded           turn on expanded table output
  -o, --output=FILENAME    send query results to file
  -h, --host=HOSTNAME      database server host (default: "localhost")
  -p, --port=PORT          database server port (default: "5432")
  -U, --username=USERNAME  database user name

At the prompt: \\l databases, \\dt tables, \\d NAME a table, \\du roles, \\c DBNAME connect,
\\i FILE run a file, \\copy, \\x, \\timing, \\conninfo, \\q quit.
The server is the tab's own PostgreSQL ${PG_MAJOR}; it starts when something connects to localhost:${PG_PORT}.
`;

const META_HELP = `General
  \\q                     quit psql
  \\c DBNAME [USER]       connect to another database
  \\conninfo              show the connection
  \\i FILE                run the commands in a file
  \\! [COMMAND]           run a shell command
  \\echo TEXT             print text
Informational
  \\l                     list databases
  \\d [NAME]              list tables, views and sequences, or describe one
  \\dt [PATTERN]          list tables      \\dv views   \\ds sequences   \\di indexes
  \\dn                    list schemas
  \\du                    list roles
Formatting
  \\x [on|off]            expanded output
  \\t [on|off]            rows only
  \\a                     aligned or unaligned output
  \\timing [on|off]       show how long each statement took
Copy
  \\copy TABLE FROM 'FILE' [OPTIONS]   load a file of the tab into a table
  \\copy TABLE TO 'FILE' [OPTIONS]     write a table (or "(SELECT ...)") to a file
`;

interface Options {
  target: Target;
  commands: string[];
  files: string[];
  list: boolean;
  quiet: boolean;
  single: boolean;
  onErrorStop: boolean;
  echoAll: boolean;
  output: string;
  format: FormatOptions;
}

class UsageError extends Error {}

function parseArgs(args: string[], env: Record<string, string>): Options | 'help' | 'version' {
  const d = defaultTarget(env);
  const o: Options = {
    target: { host: d.host, port: d.port, user: d.user, database: d.database },
    commands: [], files: [], list: false, quiet: false, single: false, onErrorStop: false, echoAll: false, output: '', format: defaultFormat(),
  };
  let dbGiven = d.databaseGiven;
  let userGiven = false;
  const positional: string[] = [];
  const LONG: Record<string, string> = {
    command: 'c', dbname: 'd', file: 'f', list: 'l', set: 'v', variable: 'v', 'single-transaction': '1', quiet: 'q', 'no-align': 'A',
    'field-separator': 'F', 'tuples-only': 't', expanded: 'x', output: 'o', host: 'h', port: 'p', username: 'U', 'no-psqlrc': 'X',
    'no-password': 'w', password: 'W', 'echo-all': 'a', 'echo-queries': 'e', 'echo-errors': 'b', 'echo-hidden': 'E', pset: 'P', 'no-readline': 'n',
  };
  const VALUE = new Set(['c', 'd', 'f', 'v', 'F', 'o', 'h', 'p', 'U', 'P', 'L', 'R', 'T']);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    let flag = '';
    let value: string | undefined;
    if (a === '--') { positional.push(...args.slice(i + 1)); break; }
    if (a === '--help' || a === '-?') return 'help';
    if (a === '--version' || a === '-V') return 'version';
    if (a === '--csv') { o.format.format = 'csv'; continue; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq < 0 ? a.slice(2) : a.slice(2, eq);
      flag = LONG[name];
      if (!flag) throw new UsageError(`unrecognized option '${a}'`);
      if (eq >= 0) value = a.slice(eq + 1);
    } else if (a.startsWith('-') && a.length > 1) {
      flag = a[1];
      if (a.length > 2) {
        if (VALUE.has(flag)) value = a.slice(2);
        else { args.splice(i + 1, 0, '-' + a.slice(2)); }
      }
    } else { positional.push(a); continue; }
    if (VALUE.has(flag) && value === undefined) {
      if (i + 1 >= args.length) throw new UsageError(`option requires an argument -- '${flag}'`);
      value = args[++i];
    }
    switch (flag) {
      case 'c': o.commands.push(value!); break;
      case 'f': o.files.push(value!); break;
      case 'd': if (!applyConninfo(value!, o.target)) o.target.database = value!; dbGiven = true; break;
      case 'U': o.target.user = value!; userGiven = true; break;
      case 'h': if (!value!.startsWith('/')) o.target.host = value!; break;
      case 'p': o.target.port = parseInt(value!, 10) || o.target.port; break;
      case 'l': o.list = true; break;
      case 'q': o.quiet = true; break;
      case '1': o.single = true; break;
      case 'A': o.format.format = 'unaligned'; break;
      case 't': o.format.tuplesOnly = true; break;
      case 'x': o.format.expanded = true; break;
      case 'F': o.format.fieldSep = value!; break;
      case 'o': o.output = value!; break;
      case 'a': o.echoAll = true; break;
      case 'v': if (/^ON_ERROR_STOP=(1|on|true)$/i.test(value!)) o.onErrorStop = true; break;
      case 'P': {
        const [k, v = ''] = value!.split('=');
        if (k === 'format' && (v === 'aligned' || v === 'unaligned' || v === 'csv')) o.format.format = v;
        else if (k === 'tuples_only' || k === 't') o.format.tuplesOnly = v !== 'off';
        else if (k === 'null') o.format.nullText = v;
        else if (k === 'fieldsep') o.format.fieldSep = v;
        break;
      }
      case 'X': case 'w': case 'W': case 'e': case 'b': case 'E': case 'n': case 'L': case 'R': case 'T': break;
      default: throw new UsageError(`invalid option -- '${flag}'`);
    }
  }
  if (positional[0] !== undefined) { if (!applyConninfo(positional[0], o.target)) o.target.database = positional[0]; dbGiven = true; }
  if (positional[1] !== undefined) { o.target.user = positional[1]; userGiven = true; }
  if (positional.length > 2) throw new UsageError(`extra command-line argument "${positional[2]}" ignored`);
  // libpq: with no database named, it is the user's name
  if (!dbGiven && userGiven) o.target.database = o.target.user;
  if (o.list && !dbGiven) o.target.database = 'postgres';
  return o;
}

/** A psql \d pattern (`foo*`, `"Quoted"`, `schema.name`) as a regular expression for the name. */
function namePattern(pattern: string): string {
  let name = pattern.includes('.') ? pattern.slice(pattern.lastIndexOf('.') + 1) : pattern;
  if (/^".*"$/.test(name)) name = name.slice(1, -1).replace(/""/g, '"'); else name = name.toLowerCase();
  return '^(' + name.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + ')$';
}

const KINDS: Record<string, string> = { t: "'r','p'", v: "'v'", m: "'m'", s: "'S'", i: "'i','I'", E: "'f'" };

class Session {
  format: FormatOptions;
  timing = false;
  quiet: boolean;
  onErrorStop: boolean;
  /** Where errors of the script being run are reported from ("psql:file.sql:12: ") */
  where = '';
  failed = false;
  /** Results are written here instead of standard output (-o) */
  outText: string[] | null = null;

  constructor(
    public client: PgClient, private ctx: CommandContext, o: Options,
    private out: (s: string) => void, private err: (s: string) => void,
  ) {
    this.format = o.format;
    this.quiet = o.quiet;
    this.onErrorStop = o.onErrorStop;
  }

  get database(): string { return this.client.options.database; }
  get superuser(): boolean { return this.client.params.is_superuser === 'on'; }

  private print(s: string): void { if (this.outText) this.outText.push(s); else this.out(s); }

  private showError(e: Record<string, string>, sql: string): void {
    let text = `${this.where}${e.S ?? 'ERROR'}:  ${e.M ?? ''}\n`;
    const pos = parseInt(e.P ?? '', 10);
    if (pos > 0 && pos <= sql.length + 1) {
      const before = sql.slice(0, pos - 1);
      const lineNo = before.split('\n').length;
      const start = before.lastIndexOf('\n') + 1;
      const end = sql.indexOf('\n', start);
      const line = sql.slice(start, end < 0 ? sql.length : end);
      const head = `LINE ${lineNo}: `;
      text += `${head}${line}\n${' '.repeat(head.length + [...sql.slice(start, pos - 1)].length)}^\n`;
    }
    if (e.D) text += `DETAIL:  ${e.D}\n`;
    if (e.H) text += `HINT:  ${e.H}\n`;
    this.err(text);
  }

  private showReply(reply: Reply, sql: string): boolean {
    let ok = true;
    for (const n of reply.notices) this.err(`${n.S ?? 'NOTICE'}:  ${n.M ?? ''}\n${n.D ? `DETAIL:  ${n.D}\n` : ''}${n.H ? `HINT:  ${n.H}\n` : ''}`);
    for (const r of reply.results) {
      if (r.error) { this.showError(r.error, sql); ok = false; continue; }
      if (r.copyOut) { for (const d of r.copyOut) this.print(new TextDecoder().decode(d)); continue; }
      if (r.columns) this.print(formatTable({ columns: r.columns, rows: r.rows }, this.format));
      else if (r.tag && !this.quiet) this.print(r.tag + '\n');
    }
    if (!ok) this.failed = true;
    return ok;
  }

  /** Run SQL and show what comes back. False when a statement failed. */
  async run(sql: string, copyData?: () => Promise<Uint8Array | null>): Promise<boolean> {
    const t0 = performance.now();
    let reply: Reply;
    try {
      reply = await this.client.query(sql, copyData);
    } catch (e) {
      this.err(`${this.where}${(e as Error).message}\n`);
      this.failed = true;
      return false;
    }
    const ok = this.showReply(reply, sql);
    if (!this.client.open) { this.err(`${this.where}server closed the connection unexpectedly\n`); this.failed = true; return false; }
    if (this.timing) this.print(`Time: ${(performance.now() - t0).toFixed(3)} ms\n`);
    return ok;
  }

  /** A query of psql's own: its first result, or null after printing the error. */
  private async ask(sql: string): Promise<Result | null> {
    try {
      const reply = await this.client.query(sql);
      const r = reply.results[0];
      if (!r || r.error) { if (r?.error) this.showError(r.error, ''); this.failed = true; return null; }
      return r;
    } catch (e) {
      this.err(`${(e as Error).message}\n`);
      this.failed = true;
      return null;
    }
  }

  private async table(title: string, sql: string, none?: string): Promise<void> {
    const r = await this.ask(sql);
    if (!r?.columns) return;
    if (!r.rows.length && none) { this.err(none + '\n'); return; }
    this.print(formatTable({ title, columns: r.columns, rows: r.rows }, this.format));
  }

  private async listRelations(kinds: string, pattern: string): Promise<void> {
    const where = pattern
      ? `AND c.relname OPERATOR(pg_catalog.~) ${literal(namePattern(pattern))}`
      : `AND n.nspname <> 'pg_catalog' AND n.nspname !~ '^pg_toast' AND n.nspname <> 'information_schema'`;
    await this.table('List of relations', `SELECT n.nspname AS "Schema", c.relname AS "Name",
  CASE c.relkind WHEN 'r' THEN 'table' WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized view' WHEN 'i' THEN 'index' WHEN 'S' THEN 'sequence' WHEN 'f' THEN 'foreign table' WHEN 'p' THEN 'partitioned table' WHEN 'I' THEN 'partitioned index' END AS "Type",
  pg_catalog.pg_get_userbyid(c.relowner) AS "Owner"
FROM pg_catalog.pg_class c LEFT JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN (${kinds}) ${where} AND pg_catalog.pg_table_is_visible(c.oid)
ORDER BY 1, 2`, pattern ? `Did not find any relation named "${pattern}".` : 'Did not find any relations.');
  }

  private async describe(pattern: string): Promise<void> {
    const found = await this.ask(`SELECT c.oid, n.nspname, c.relname, c.relkind
FROM pg_catalog.pg_class c LEFT JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE c.relname OPERATOR(pg_catalog.~) ${literal(namePattern(pattern))} AND pg_catalog.pg_table_is_visible(c.oid)
ORDER BY 2, 3`);
    if (!found) return;
    if (!found.rows.length) { this.err(`Did not find any relation named "${pattern}".\n`); return; }
    for (const [oid, schema, name, kind] of found.rows as string[][]) {
      const full = `"${schema}.${name}"`;
      if (kind === 'S') {
        await this.table(`Sequence ${full}`, `SELECT pg_catalog.format_type(seqtypid, NULL) AS "Type", seqstart AS "Start", seqmin AS "Minimum", seqmax AS "Maximum", seqincrement AS "Increment", CASE WHEN seqcycle THEN 'yes' ELSE 'no' END AS "Cycles?", seqcache AS "Cache" FROM pg_catalog.pg_sequence WHERE seqrelid = ${oid}`);
        continue;
      }
      const cols = await this.ask(kind === 'i' || kind === 'I'
        ? `SELECT a.attname AS "Column", pg_catalog.format_type(a.atttypid, a.atttypmod) AS "Type", CASE WHEN a.attnum <= (SELECT i.indnkeyatts FROM pg_catalog.pg_index i WHERE i.indexrelid = ${oid}) THEN 'yes' ELSE 'no' END AS "Key?", pg_catalog.pg_get_indexdef(a.attrelid, a.attnum, TRUE) AS "Definition"
FROM pg_catalog.pg_attribute a WHERE a.attrelid = ${oid} AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`
        : `SELECT a.attname AS "Column", pg_catalog.format_type(a.atttypid, a.atttypmod) AS "Type",
  (SELECT c.collname FROM pg_catalog.pg_collation c, pg_catalog.pg_type t WHERE c.oid = a.attcollation AND t.oid = a.atttypid AND a.attcollation <> t.typcollation) AS "Collation",
  CASE WHEN a.attnotnull THEN 'not null' END AS "Nullable",
  CASE WHEN a.attidentity = 'a' THEN 'generated always as identity' WHEN a.attidentity = 'd' THEN 'generated by default as identity'
       WHEN a.attgenerated <> '' THEN 'generated always as (' || pg_catalog.pg_get_expr(d.adbin, d.adrelid, true) || ')' || CASE a.attgenerated WHEN 's' THEN ' stored' ELSE '' END
       ELSE pg_catalog.pg_get_expr(d.adbin, d.adrelid, true) END AS "Default"
FROM pg_catalog.pg_attribute a LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
WHERE a.attrelid = ${oid} AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`);
      if (!cols?.columns) return;
      const footers: string[] = [];
      const section = async (title: string, sql: string) => {
        const r = await this.ask(sql);
        if (r?.rows.length) { footers.push(title); for (const row of r.rows) footers.push('    ' + row[0]); }
      };
      if (kind === 'r' || kind === 'p' || kind === 'm') {
        await section('Indexes:', `SELECT '"' || c2.relname || '"' ||
    CASE WHEN i.indisprimary THEN ' PRIMARY KEY,' WHEN i.indisunique THEN CASE WHEN con.contype = 'u' THEN ' UNIQUE CONSTRAINT,' ELSE ' UNIQUE,' END ELSE '' END ||
    ' ' || pg_catalog.regexp_replace(pg_catalog.pg_get_indexdef(i.indexrelid, 0, true), '^.*? USING ', '')
FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c2 ON c2.oid = i.indexrelid
  LEFT JOIN pg_catalog.pg_constraint con ON con.conrelid = i.indrelid AND con.conindid = i.indexrelid AND con.contype IN ('p', 'u', 'x')
WHERE i.indrelid = ${oid} ORDER BY i.indisprimary DESC, c2.relname`);
        await section('Check constraints:', `SELECT '"' || conname || '" ' || pg_catalog.pg_get_constraintdef(oid, true) FROM pg_catalog.pg_constraint WHERE conrelid = ${oid} AND contype = 'c' ORDER BY conname`);
        await section('Foreign-key constraints:', `SELECT '"' || conname || '" ' || pg_catalog.pg_get_constraintdef(oid, true) FROM pg_catalog.pg_constraint WHERE conrelid = ${oid} AND contype = 'f' AND conparentid = 0 ORDER BY conname`);
        await section('Referenced by:', `SELECT 'TABLE "' || conrelid::pg_catalog.regclass || '" CONSTRAINT "' || conname || '" ' || pg_catalog.pg_get_constraintdef(oid, true) FROM pg_catalog.pg_constraint WHERE confrelid = ${oid} AND contype = 'f' ORDER BY conname`);
      } else if (kind === 'i' || kind === 'I') {
        const def = await this.ask(`SELECT CASE WHEN i.indisprimary THEN 'primary key, ' WHEN i.indisunique THEN 'unique, ' ELSE '' END || am.amname || ', for table "' || i.indrelid::pg_catalog.regclass || '"'
FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid JOIN pg_catalog.pg_am am ON am.oid = c.relam WHERE i.indexrelid = ${oid}`);
        if (def?.rows[0]?.[0]) footers.push(def.rows[0][0]);
      }
      const what = kind === 'v' ? 'View' : kind === 'm' ? 'Materialized view' : kind === 'i' || kind === 'I' ? 'Index' : kind === 'f' ? 'Foreign table' : kind === 'p' ? 'Partitioned table' : 'Table';
      this.print(formatTable({ title: `${what} ${full}`, columns: cols.columns, rows: cols.rows, footers }, this.format));
    }
  }

  private async copy(args: string): Promise<void> {
    const m = /^\s*(\(.*\)|"[^"]+"(?:\s*\([^)]*\))?|[^\s(]+(?:\s*\([^)]*\))?)\s+(from|to)\s+(?:'((?:[^']|'')*)'|(\S+))\s*([\s\S]*)$/i.exec(args);
    if (!m) { this.err("\\copy: write it as \\copy TABLE FROM 'FILE' [OPTIONS] or \\copy TABLE TO 'FILE' [OPTIONS]\n"); this.failed = true; return; }
    const [, what, dir, quoted, bare, rest] = m;
    const name = quoted !== undefined ? quoted.replace(/''/g, "'") : bare;
    const std = /^(stdin|stdout|pstdin|pstdout)$/i.test(name) && quoted === undefined;
    const path = std ? '' : this.ctx.fs.resolvePath(name, this.ctx.cwd);
    if (/^from$/i.test(dir)) {
      let data: Uint8Array;
      try {
        data = std ? new TextEncoder().encode(this.ctx.stdin ?? '') : await this.ctx.fs.readFile(path) as Uint8Array;
      } catch { this.err(`${name}: No such file or directory\n`); this.failed = true; return; }
      await this.run(`COPY ${what} FROM STDIN ${rest}`, async () => data);
      return;
    }
    try {
      const reply = await this.client.query(`COPY ${what} TO STDOUT ${rest}`);
      const r = reply.results[0];
      if (!r || r.error) { if (r?.error) this.showError(r.error, ''); this.failed = true; return; }
      const parts = r.copyOut ?? [];
      const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
      let off = 0;
      for (const p of parts) { bytes.set(p, off); off += p.length; }
      if (std) this.print(new TextDecoder().decode(bytes)); else await this.ctx.fs.writeFile(path, bytes);
      if (!this.quiet) this.print(r.tag + '\n');
    } catch (e) { this.err(`${(e as Error).message}\n`); this.failed = true; }
  }

  /** Connect again as \c asks; the old connection stays when the new one fails. */
  private async reconnect(db: string | undefined, user: string | undefined): Promise<void> {
    const t = { ...this.client.options };
    const target: Target = { host: t.host, port: t.port, user: user && user !== '-' ? user : t.user, database: db && db !== '-' ? db : t.database };
    try {
      const next = await connect(this.ctx, target, 'psql');
      this.client.close();
      this.client = next;
      if (!this.quiet) this.print(`You are now connected to database "${target.database}" as user "${target.user}".\n`);
    } catch (e) {
      this.err(`${(e as Error).message}\nPrevious connection kept\n`);
      this.failed = true;
    }
  }

  /** A backslash command. 'quit' ends psql. */
  async meta(line: string): Promise<'quit' | void> {
    const m = /^\\(\S*)\s*([\s\S]*)$/.exec(line.trim());
    if (!m) return;
    const cmd = m[1].replace(/;$/, '');
    const rest = m[2].trim().replace(/;$/, '');
    const words = rest.match(/"[^"]*"|'[^']*'|\S+/g)?.map((w) => (/^'.*'$/.test(w) ? w.slice(1, -1) : w)) ?? [];
    const toggle = (cur: boolean) => (words[0] === 'on' ? true : words[0] === 'off' ? false : !cur);
    switch (cmd) {
      case 'q': case 'quit': return 'quit';
      case '?': this.print(META_HELP); return;
      case 'h': case 'help': this.print('SQL help is at https://www.postgresql.org/docs/current/sql-commands.html; \\? lists the backslash commands.\n'); return;
      case 'l': case 'list': case 'l+':
        await this.table('List of databases', `SELECT d.datname AS "Name", pg_catalog.pg_get_userbyid(d.datdba) AS "Owner", pg_catalog.pg_encoding_to_char(d.encoding) AS "Encoding",
  CASE d.datlocprovider WHEN 'b' THEN 'builtin' WHEN 'c' THEN 'libc' WHEN 'i' THEN 'icu' END AS "Locale Provider",
  d.datcollate AS "Collate", d.datctype AS "Ctype", d.datlocale AS "Locale", d.daticurules AS "ICU Rules",
  pg_catalog.array_to_string(d.datacl, E'\\n') AS "Access privileges"
FROM pg_catalog.pg_database d ORDER BY 1`);
        return;
      case 'du': case 'dg':
        await this.table('List of roles', `SELECT r.rolname AS "Role name", pg_catalog.array_to_string(pg_catalog.array_remove(ARRAY[
  CASE WHEN r.rolsuper THEN 'Superuser' END, CASE WHEN r.rolcreaterole THEN 'Create role' END, CASE WHEN r.rolcreatedb THEN 'Create DB' END,
  CASE WHEN NOT r.rolcanlogin THEN 'Cannot login' END, CASE WHEN r.rolreplication THEN 'Replication' END, CASE WHEN r.rolbypassrls THEN 'Bypass RLS' END], NULL), ', ') AS "Attributes"
FROM pg_catalog.pg_roles r WHERE r.rolname !~ '^pg_' ORDER BY 1`);
        return;
      case 'dn':
        await this.table('List of schemas', `SELECT n.nspname AS "Name", pg_catalog.pg_get_userbyid(n.nspowner) AS "Owner" FROM pg_catalog.pg_namespace n WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' ORDER BY 1`);
        return;
      case 'd': case 'd+':
        if (words[0]) await this.describe(words[0]); else await this.listRelations("'r','p','v','m','S','f'", '');
        return;
      case 'dt': case 'dv': case 'dm': case 'ds': case 'di': case 'dE': case 'dt+': case 'dv+': case 'ds+': case 'di+':
        await this.listRelations(KINDS[cmd[1]], words[0] ?? '');
        return;
      case 'c': case 'connect': await this.reconnect(words[0], words[1]); return;
      case 'conninfo':
        this.print(`You are connected to database "${this.database}" as user "${this.client.options.user}" on host "${this.client.options.host}" at port "${this.client.options.port}".\n`);
        return;
      case 'x': this.format.expanded = toggle(this.format.expanded); if (!this.quiet) this.print(`Expanded display is ${this.format.expanded ? 'on' : 'off'}.\n`); return;
      case 't': this.format.tuplesOnly = toggle(this.format.tuplesOnly); if (!this.quiet) this.print(`Tuples only is ${this.format.tuplesOnly ? 'on' : 'off'}.\n`); return;
      case 'a': this.format.format = this.format.format === 'aligned' ? 'unaligned' : 'aligned'; if (!this.quiet) this.print(`Output format is ${this.format.format}.\n`); return;
      case 'timing': this.timing = toggle(this.timing); if (!this.quiet) this.print(`Timing is ${this.timing ? 'on' : 'off'}.\n`); return;
      case 'echo': this.print(words.join(' ') + '\n'); return;
      case 'qecho': this.print(words.join(' ') + '\n'); return;
      case 'pset': case 'set': case 'unset': case 'encoding': case 'pager':
        if (cmd === 'set' && /^ON_ERROR_STOP$/i.test(words[0] ?? '')) this.onErrorStop = !/^(0|off|false)$/i.test(words[1] ?? 'on');
        return;
      case 'i': case 'include': case 'ir': case 'include_relative': {
        if (!words[0]) { this.err(`\\${cmd}: missing required argument\n`); this.failed = true; return; }
        const path = this.ctx.fs.resolvePath(words[0], this.ctx.cwd);
        let text: string;
        try { text = await this.ctx.fs.readFile(path, 'utf8') as string; } catch { this.err(`${words[0]}: No such file or directory\n`); this.failed = true; return; }
        await this.script(text, words[0]);
        return;
      }
      case 'copy': await this.copy(rest); return;
      case '!': {
        const code = await this.ctx.shell.execute(rest || 'true', (s: string) => this.print(s), (s: string) => this.err(s));
        if (code !== 0) this.failed = true;
        return;
      }
      case 'cd': if (words[0]) this.ctx.cwd = this.ctx.fs.resolvePath(words[0], this.ctx.cwd); return;
      case 'g': case 'gx': return;
      default:
        this.err(`invalid command \\${cmd}\nTry \\? for help.\n`);
        this.failed = true;
    }
  }

  /**
   * Run the lines of a script: statements as their `;` arrives, backslash
   * commands on lines of their own, and after a COPY ... FROM STDIN the data
   * lines up to `\.`. False when it stopped at an error (ON_ERROR_STOP).
   */
  async script(text: string, name = ''): Promise<boolean | 'quit'> {
    const lines = text.split('\n');
    const outer = this.where;
    let pending = '';
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].replace(/\r$/, '');
      if (name) this.where = `psql:${name}:${i + 1}: `;
      const scan = scanSql(pending);
      if (!scan.open && !scan.restHasCode && /^\s*\\/.test(line)) {
        pending = '';
        if ((await this.meta(line)) === 'quit') { this.where = outer; return 'quit'; }
        if (this.failed && this.onErrorStop) { this.where = outer; return false; }
        continue;
      }
      pending += (pending ? '\n' : '') + line;
      const s = scanSql(pending);
      if (!s.statements.length) continue;
      pending = s.rest.replace(/^\s*\n/, '');
      for (const stmt of s.statements) {
        const ok = await this.run(stmt, async () => {
          // the data of COPY ... FROM STDIN follows it in the script
          const data: string[] = [];
          while (i + 1 < lines.length) {
            const d = lines[++i].replace(/\r$/, '');
            if (d === '\\.') break;
            data.push(d);
          }
          return new TextEncoder().encode(data.length ? data.join('\n') + '\n' : '');
        });
        if (!ok && this.onErrorStop) { this.where = outer; return false; }
      }
    }
    if (scanSql(pending).restHasCode) {
      const ok = await this.run(pending.trim());
      if (!ok && this.onErrorStop) { this.where = outer; return false; }
    }
    this.where = outer;
    return true;
  }
}

/** The prompt psql shows: the database, then what the input is inside of, then # for a superuser. */
function promptFor(s: Session, pending: string): string {
  const scan = scanSql(pending);
  const mark = !pending.trim() ? '=' : scan.open === '$' ? '$' : scan.open === '*' ? '*' : scan.open || '-';
  return `${s.database}${mark}${s.superuser ? '#' : '>'} `;
}

const KEY_BYTES: Record<string, string> = {
  Enter: '\r', Backspace: '\x7f', Tab: '\t', Escape: '\x1b', Delete: '\x1b[3~', Home: '\x1b[H', End: '\x1b[F',
  ArrowUp: '\x1b[A', ArrowDown: '\x1b[B', ArrowRight: '\x1b[C', ArrowLeft: '\x1b[D',
};

/** The prompt at a terminal: a line editor with history, statements run as their `;` is entered. */
function interactive(ctx: CommandContext, s: Session): Promise<number> {
  const term = ctx.terminal!;
  const write = (t: string) => term.writeOutput(t.replace(/\r?\n/g, '\r\n'));
  return new Promise<number>((resolve) => {
    let line = '';
    let cursor = 0;
    let pending = '';
    let busy = false;
    const queue: string[] = [];
    const history: string[] = [];
    let at = 0;
    const prompt = () => write(promptFor(s, pending));
    const redraw = () => {
      // back to the start of the input, the line again, then the cursor where it belongs
      term.writeOutput('\r\x1b[K' + promptFor(s, pending) + line + (cursor < line.length ? `\x1b[${line.length - cursor}D` : ''));
    };
    const finish = (code: number) => { term.exitRawMode(); s.client.close(); resolve(code); };
    const submit = async (text: string) => {
      busy = true;
      try {
        if (text.trim()) { history.push(text); at = history.length; }
        const scan = scanSql(pending);
        if (!scan.open && !scan.restHasCode && /^\s*\\/.test(text)) {
          pending = '';
          if ((await s.meta(text)) === 'quit') { finish(0); return; }
        } else if (!pending.trim() && /^\s*(quit|exit)\s*;?\s*$/i.test(text)) {
          finish(0);
          return;
        } else if (!pending.trim() && /^\s*help\s*;?\s*$/i.test(text)) {
          write('You are using psql, the command-line interface to PostgreSQL.\nType:  \\? for help with psql commands\n       \\q to quit\n');
        } else {
          pending += (pending ? '\n' : '') + text;
          const done = scanSql(pending);
          if (done.statements.length) {
            pending = done.rest.trim();
            for (const stmt of done.statements) await s.run(stmt);
          }
        }
      } finally { busy = false; }
      prompt();
      const next = queue.shift();
      if (next !== undefined) void submit(next);
    };
    const enter = () => {
      term.writeOutput('\r\n');
      const text = line;
      line = '';
      cursor = 0;
      if (busy) queue.push(text); else void submit(text);
    };
    prompt();
    term.enterRawMode((input: string) => {
      // The full-page terminal names its special keys ("Enter", "Ctrl+D"); a window's terminal sends their bytes
      const data = KEY_BYTES[input] ?? (/^Ctrl\+[A-Z]$/.test(input) ? String.fromCharCode(input.charCodeAt(5) - 64) : input);
      for (let i = 0; i < data.length; i++) {
        const key = data[i];
        if (key === '\x1b') {
          const seq = /^\x1b(?:\[[0-9;]*[A-Za-z~]|O[A-Za-z])/.exec(data.slice(i))?.[0] ?? key;
          i += seq.length - 1;
          const final = seq[seq.length - 1];
          if (final === 'A' || final === 'B') {
            if (!history.length) continue;
            at = Math.max(0, Math.min(history.length, at + (final === 'A' ? -1 : 1)));
            line = history[at] ?? '';
            cursor = line.length;
            redraw();
          } else if (final === 'C') { if (cursor < line.length) { cursor++; term.writeOutput('\x1b[C'); } }
          else if (final === 'D') { if (cursor > 0) { cursor--; term.writeOutput('\x1b[D'); } }
          else if (final === 'H') { cursor = 0; redraw(); }
          else if (final === 'F') { cursor = line.length; redraw(); }
          else if (seq === '\x1b[3~') { if (cursor < line.length) { line = line.slice(0, cursor) + line.slice(cursor + 1); redraw(); } }
          continue;
        }
        if (key === '\r' || key === '\n') { if (key === '\n' && data[i - 1] === '\r') continue; enter(); continue; }
        if (key === '\x7f' || key === '\b') {
          if (cursor > 0) { line = line.slice(0, cursor - 1) + line.slice(cursor); cursor--; redraw(); }
        } else if (key === '\x03') {
          term.writeOutput('^C\r\n');
          line = ''; cursor = 0; pending = '';
          if (!busy) prompt();
        } else if (key === '\x04') {
          if (!line && !busy) { term.writeOutput('\\q\r\n'); finish(0); return; }
        } else if (key === '\x01') { cursor = 0; redraw(); }
        else if (key === '\x05') { cursor = line.length; redraw(); }
        else if (key === '\x15') { line = line.slice(cursor); cursor = 0; redraw(); }
        else if (key === '\x0b') { line = line.slice(0, cursor); redraw(); }
        else if (key === '\x17') {
          const head = line.slice(0, cursor).replace(/\S+\s*$/, '');
          line = head + line.slice(cursor); cursor = head.length; redraw();
        } else if (key === '\x0c') { term.writeOutput('\x1b[2J\x1b[H'); redraw(); }
        else if (key >= ' ' || key === '\t') {
          const ch = key === '\t' ? ' ' : key;
          line = line.slice(0, cursor) + ch + line.slice(cursor);
          cursor++;
          if (cursor === line.length) term.writeOutput(ch); else redraw();
        }
      }
    });
  });
}

function fatal(ctx: CommandContext, name: string, e: unknown): number {
  ctx.stderr += `${name}: error: ${(e as Error)?.message ?? e}\n`;
  return 2;
}

export const psqlCmd: Command = {
  name: 'psql',
  description: 'PostgreSQL interactive terminal (the tab\'s own PostgreSQL starts on first use)',
  async exec(ctx) {
    let o: Options | 'help' | 'version';
    try { o = parseArgs([...ctx.args], ctx.env); } catch (e) {
      if (!(e instanceof UsageError)) throw e;
      ctx.stderr += `psql: ${e.message}\npsql: hint: Try "psql --help" for more information.\n`;
      return 2;
    }
    if (o === 'help') { ctx.stdout += HELP; return 0; }
    if (o === 'version') { ctx.stdout += `psql (PostgreSQL) ${PG_MAJOR} (tabcomputer)\n`; return 0; }
    const scripted = o.commands.length > 0 || o.files.length > 0 || o.list;
    const piped = !scripted && (ctx.stdinIsTTY === false || !ctx.terminal || !!ctx.stdin);
    let client: PgClient;
    try { client = await connect(ctx, o.target, 'psql'); } catch (e) {
      if (!(e instanceof PgError)) throw e;
      return fatal(ctx, 'psql', e);
    }
    const live = !scripted && !piped;
    const out = live
      ? (s: string) => ctx.terminal!.writeOutput(s.replace(/\r?\n/g, '\r\n'))
      : (s: string) => { ctx.stdout += s; };
    const err = live ? (s: string) => ctx.terminal!.writeOutput(s.replace(/\r?\n/g, '\r\n')) : (s: string) => { ctx.stderr += s; };
    const s = new Session(client, ctx, o, out, err);
    if (o.output) s.outText = [];
    const save = async () => { if (o.output && s.outText) await ctx.fs.writeFile(ctx.fs.resolvePath(o.output, ctx.cwd), s.outText.join('')); };
    if (live) {
      out(`psql (${client.params.server_version ?? PG_MAJOR})\nType "help" for help.\n\n`);
      const code = await interactive(ctx, s);
      await save();
      return code;
    }
    let stopped = false;
    try {
      if (o.list) await s.meta('\\l');
      if (o.single) await s.run('BEGIN');
      for (const c of o.commands) {
        if (stopped) break;
        // -c takes one backslash command or SQL sent as one string
        if (/^\s*\\/.test(c)) { if ((await s.meta(c)) === 'quit') break; }
        else if (!(await s.run(c)) && o.onErrorStop) stopped = true;
        if (s.failed && o.onErrorStop) stopped = true;
      }
      for (const f of o.files) {
        if (stopped) break;
        let text: string;
        if (f === '-') text = ctx.stdin ?? '';
        else {
          try { text = await ctx.fs.readFile(ctx.fs.resolvePath(f, ctx.cwd), 'utf8') as string; } catch {
            ctx.stderr += `psql: error: ${f}: No such file or directory\n`;
            client.close();
            return 1;
          }
        }
        const r = await s.script(text, f === '-' ? '' : f);
        if (r === false) stopped = true;
        if (r === 'quit') break;
      }
      if (piped) {
        const text = ctx.stdin || (ctx.readStdin ? await ctx.readStdin() : '');
        if ((await s.script(text)) === false) stopped = true;
      }
      if (o.single) await s.run(stopped ? 'ROLLBACK' : 'COMMIT');
    } finally {
      client.close();
      await save();
    }
    // psql: 3 when a script stopped at an error; 1 when the last -c failed
    if (stopped) return 3;
    return s.failed && o.commands.length && !o.files.length ? 1 : 0;
  },
};

// ── createdb, dropdb, pg_isready ──

function simpleTarget(ctx: CommandContext, usage: string): { t: Target; names: string[]; flags: Set<string> } | number {
  const d = defaultTarget(ctx.env);
  const t: Target = { host: d.host, port: d.port, user: d.user, database: 'postgres' };
  const names: string[] = [];
  const flags = new Set<string>();
  const args = ctx.args;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const val = (long: string, short: string): string | undefined => {
      if (a === short || a === long) return args[++i] ?? '';
      if (a.startsWith(long + '=')) return a.slice(long.length + 1);
      if (a.startsWith(short) && a.length > 2 && !a.startsWith('--')) return a.slice(2);
      return undefined;
    };
    let v: string | undefined;
    if (a === '--help' || a === '-?') { ctx.stdout += usage; return 0; }
    if ((v = val('--host', '-h')) !== undefined) { if (!v.startsWith('/')) t.host = v; }
    else if ((v = val('--port', '-p')) !== undefined) t.port = parseInt(v, 10) || t.port;
    else if ((v = val('--username', '-U')) !== undefined) t.user = v;
    else if ((v = val('--dbname', '-d')) !== undefined) { if (!applyConninfo(v, t)) flags.add('dbname=' + v); }
    else if ((v = val('--owner', '-O')) !== undefined) flags.add('owner=' + v);
    else if ((v = val('--template', '-T')) !== undefined) flags.add('template=' + v);
    else if ((v = val('--encoding', '-E')) !== undefined) flags.add('encoding=' + v);
    else if ((v = val('--timeout', '-t')) !== undefined) flags.add('timeout=' + v);
    else if (a === '--if-exists') flags.add('if-exists');
    else if (a === '-q' || a === '--quiet') flags.add('quiet');
    else if (a === '-e' || a === '--echo') flags.add('echo');
    else if (a === '-w' || a === '-W' || a === '--no-password' || a === '--password' || a === '-f' || a === '--force' || a === '-i' || a === '--interactive') continue;
    else if (a.startsWith('-')) { ctx.stderr += `${usage.split(' ')[1]}: invalid option ${a}\n`; return 1; }
    else names.push(a);
  }
  return { t, names, flags };
}

async function oneStatement(ctx: CommandContext, name: string, t: Target, sql: string, echo: boolean): Promise<number> {
  let client: PgClient;
  try { client = await connect(ctx, t, name); } catch (e) {
    if (!(e instanceof PgError)) throw e;
    ctx.stderr += `${name}: error: ${e.message}\n`;
    return 1;
  }
  try {
    if (echo) ctx.stdout += sql + ';\n';
    const reply = await client.query(sql);
    for (const n of reply.notices) ctx.stderr += `${n.S ?? 'NOTICE'}:  ${n.M ?? ''}\n`;
    const err = reply.results.find((r) => r.error)?.error;
    if (err) { ctx.stderr += `${name}: error: ${name === 'createdb' ? 'database creation' : 'database removal'} failed: ERROR:  ${err.M ?? ''}\n`; return 1; }
    return 0;
  } finally { client.close(); }
}

export const createdbCmd: Command = {
  name: 'createdb',
  description: 'Create a PostgreSQL database',
  async exec(ctx) {
    const p = simpleTarget(ctx, 'Usage: createdb [-O OWNER] [-T TEMPLATE] [-h HOST] [-p PORT] [-U USERNAME] [DBNAME]\n');
    if (typeof p === 'number') return p;
    const name = p.names[0] ?? ctx.env.PGDATABASE ?? p.t.user;
    const get = (k: string) => [...p.flags].find((f) => f.startsWith(k + '='))?.slice(k.length + 1);
    let sql = `CREATE DATABASE ${ident(name)}`;
    if (get('owner')) sql += ` OWNER ${ident(get('owner')!)}`;
    if (get('template')) sql += ` TEMPLATE ${ident(get('template')!)}`;
    if (get('encoding')) sql += ` ENCODING ${literal(get('encoding')!)}`;
    return oneStatement(ctx, 'createdb', p.t, sql, p.flags.has('echo'));
  },
};

export const dropdbCmd: Command = {
  name: 'dropdb',
  description: 'Remove a PostgreSQL database',
  async exec(ctx) {
    const p = simpleTarget(ctx, 'Usage: dropdb [--if-exists] [-h HOST] [-p PORT] [-U USERNAME] DBNAME\n');
    if (typeof p === 'number') return p;
    if (!p.names[0]) { ctx.stderr += 'dropdb: error: missing required argument database name\n'; return 1; }
    return oneStatement(ctx, 'dropdb', p.t, `DROP DATABASE ${p.flags.has('if-exists') ? 'IF EXISTS ' : ''}${ident(p.names[0])}`, p.flags.has('echo'));
  },
};

export const pgIsreadyCmd: Command = {
  name: 'pg_isready',
  description: 'Check whether a PostgreSQL server accepts connections',
  async exec(ctx) {
    const p = simpleTarget(ctx, 'Usage: pg_isready [-h HOST] [-p PORT] [-U USERNAME] [-d DBNAME] [-q]\n');
    if (typeof p === 'number') return p;
    const where = `${p.t.host}:${p.t.port}`;
    const say = (s: string) => { if (!p.flags.has('quiet')) ctx.stdout += s; };
    try {
      const client = await connect(ctx, p.t, 'pg_isready');
      client.close();
      say(`${where} - accepting connections\n`);
      return 0;
    } catch (e) {
      if (!(e instanceof PgError)) throw e;
      // (a server that answers with an error is up: libpq's PQPING_OK needs only the startup's reply)
      if (e.fields.C && e.fields.C !== '57P03') { say(`${where} - accepting connections\n`); return 0; }
      say(`${where} - no response\n`);
      return 2;
    }
  },
};

// ── pg_dump ──

export const pgDumpCmd: Command = {
  name: 'pg_dump',
  description: 'Write a PostgreSQL database as a script of SQL',
  async exec(ctx) {
    const d = defaultTarget(ctx.env);
    const t: Target = { host: d.host, port: d.port, user: d.user, database: d.database };
    const pass: string[] = [];
    let file = '';
    let dbGiven = d.databaseGiven;
    const args = ctx.args;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      const val = (long: string, short: string): string | undefined => {
        if (a === short || a === long) return args[++i] ?? '';
        if (a.startsWith(long + '=')) return a.slice(long.length + 1);
        if (a.startsWith(short) && a.length > 2 && !a.startsWith('--')) return a.slice(2);
        return undefined;
      };
      let v: string | undefined;
      if (a === '--help' || a === '-?') {
        ctx.stdout += 'Usage: pg_dump [-U USERNAME] [-f FILE] [-s | -a] [-t TABLE] [-n SCHEMA] [-c] [-C] [-O] [-x] [--if-exists] [DBNAME]\n'
          + 'PostgreSQL\'s pg_dump, for the tab\'s own server. Rows are written as INSERT statements.\n';
        return 0;
      }
      if (a === '--version' || a === '-V') { ctx.stdout += `pg_dump (PostgreSQL) ${PG_MAJOR} (tabcomputer)\n`; return 0; }
      if ((v = val('--host', '-h')) !== undefined) { if (!v.startsWith('/')) t.host = v; }
      else if ((v = val('--port', '-p')) !== undefined) t.port = parseInt(v, 10) || t.port;
      else if ((v = val('--username', '-U')) !== undefined) { t.user = v; if (!dbGiven) t.database = v; }
      else if ((v = val('--dbname', '-d')) !== undefined) { if (!applyConninfo(v, t)) t.database = v; dbGiven = true; }
      else if ((v = val('--file', '-f')) !== undefined) file = v;
      else if (a === '-w' || a === '-W' || a === '--no-password' || a === '--password') continue;
      else if (a === '-j' || a === '--jobs' || a === '-F' || a === '--format') {
        const fmt = args[++i] ?? '';
        if ((a === '-F' || a === '--format') && !/^(p|plain)$/.test(fmt)) { ctx.stderr += 'pg_dump: error: this pg_dump writes the plain format only (a script of SQL)\n'; return 1; }
      } else if (a.startsWith('-')) {
        pass.push(a);
        // (options whose value is the next word)
        if (/^(-t|-T|-n|-N|-E|-S|--table|--exclude-table|--schema|--exclude-schema|--encoding|--superuser|--exclude-table-data|--extra-float-digits|--rows-per-insert|--section|--role)$/.test(a) && i + 1 < args.length) pass.push(args[++i]);
      } else { t.database = a; dbGiven = true; }
    }
    const { service } = postgresFor(ctx);
    if (!LOCAL.test(t.host) || t.port !== service.port) {
      ctx.stderr += `pg_dump: error: this pg_dump reads the tab's own server only (localhost:${service.port}); apt install postgresql-client has one for other servers\n`;
      return 1;
    }
    await firstStartNote(ctx, service, 'pg_dump');
    let dump;
    try { dump = await service.dump(t.user, t.database, pass); } catch (e) {
      ctx.stderr += `pg_dump: error: ${(e as Error)?.message ?? e}\n`;
      return 1;
    }
    if (dump.error) { ctx.stderr += `pg_dump: error: ${dump.error.replace(/^pg_dump: (error: )?/, '').trim()}\n`; return 1; }
    if (file) await ctx.fs.writeFile(ctx.fs.resolvePath(file, ctx.cwd), dump.text); else ctx.stdout += dump.text;
    return 0;
  },
};

// ── service postgresql start|stop|restart|status ──

const UNITS = /^postgres(ql)?(@.*)?(\.service)?$/;

/** `service postgresql ...` / `systemctl ... postgresql`: null when `unit` is not the tab's postgres. */
export async function postgresUnit(ctx: CommandContext, action: string, unit: string): Promise<number | null> {
  if (!UNITS.test(unit)) return null;
  const { service } = postgresFor(ctx);
  const line = () => (service.running
    ? `postgresql: active (running), PostgreSQL ${PG_MAJOR} on 127.0.0.1:${service.port}, data in ${PG_DATA}, ${service.clients} connection${service.clients === 1 ? '' : 's'}\n`
    : `postgresql: inactive${service.error ? ` (${service.error})` : ''}. It starts when something connects to localhost:${service.port}; psql does.\n`);
  try {
    switch (action) {
      case 'start': await service.start(); return 0;
      case 'stop': await service.stop(); return 0;
      case 'restart': case 'reload': case 'force-reload': await service.stop(); await service.start(); return 0;
      case 'status': case 'is-active':
        ctx.stdout += action === 'is-active' ? (service.running ? 'active\n' : 'inactive\n') : line();
        return service.running ? 0 : 3;
      case 'enable': case 'disable': return 0; // (it is always there: it starts on the first connection)
      default:
        ctx.stderr += 'Usage: service postgresql {start|stop|restart|status}\n';
        return 1;
    }
  } catch (e) {
    ctx.stderr += `postgresql: did not start: ${(e as Error)?.message ?? e}\n`;
    return 1;
  }
}

/**
 * service NAME start|stop|restart|status. The tab's postgres is the one
 * service it runs itself; a Debian package's own init script (the real
 * /usr/sbin/service) and the units of systemctl get the rest.
 */
export const serviceCmd: Command = {
  name: 'service',
  description: 'Start, stop or ask about a service (service postgresql status)',
  keepOverPackage: (args) => UNITS.test(args[0] ?? ''),
  async exec(ctx) {
    const [unit, action = ''] = ctx.args;
    if (!unit || unit === '--help' || unit === '-h') {
      ctx.stdout += 'Usage: service NAME {start|stop|restart|status}\n       service --status-all\n';
      return unit ? 0 : 1;
    }
    const q = (v: string) => "'" + v.replace(/'/g, "'\\''") + "'";
    const pass = (line: string) => ctx.shell.execute(line, (s: string) => { ctx.stdout += s; }, (s: string) => { ctx.stderr += s; });
    // Debian's own PostgreSQL, once installed, is that package's to run
    if (await ctx.fs.exists('/usr/sbin/service') && await ctx.fs.exists(`/etc/init.d/${unit}`)) {
      // (its server takes port 5432: the tab's own gives it up)
      if (UNITS.test(unit) && /^(start|restart)$/.test(action)) await currentPostgres()?.stop();
      return pass(`/usr/sbin/service ${ctx.args.map(q).join(' ')}`);
    }
    if (unit === '--status-all') {
      const { service } = postgresFor(ctx);
      ctx.stdout += ` [ ${service.running ? '+' : '-'} ]  postgresql\n`;
      return 0;
    }
    const r = await postgresUnit(ctx, action, unit);
    if (r !== null) return r;
    if (!action) { ctx.stderr += 'Usage: service NAME {start|stop|restart|status}\n'; return 1; }
    return pass(`systemctl ${q(action)} ${q(unit)}`);
  },
};

export const postgresCommands: Command[] = [psqlCmd, createdbCmd, dropdbCmd, pgIsreadyCmd, pgDumpCmd, serviceCmd];
