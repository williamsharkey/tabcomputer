/**
 * PostgreSQL in the tab (docs/POSTGRES.md, tabcomputer#126): the service on
 * 127.0.0.1:5432 of the kernel's network, started by the first connection,
 * with PGlite in this process (the page uses a Worker); psql, createdb,
 * dropdb, pg_isready, pg_dump and `service postgresql`; what a database course types;
 * several connections at once; the data directory in the tab's filesystem
 * across a clean stop and across a reload that stops nothing.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FileSystem } from '@shiro/filesystem';
import type { Shell } from '@shiro/shell';
import { getKernel } from '@shiro/kernel/kernel';
import { installNet, netStackOf, KSocket, type NetStack } from '@shiro/kernel/net';
import { AF_INET, AF_UNIX, SOCK_STREAM } from '@shiro/kernel/abi';
import { postgresCommands, postgresFor } from '@shiro/commands/psql';
import { sudoCmd } from '@shiro/commands/sudo';
import { PgClient } from '@shiro/postgres/client';
import { PostgresService, PG_DATA, PG_PORT, PG_SOCKET, currentPostgres } from '@shiro/postgres/service';
import { Engine } from '@shiro/postgres/engine';
import { scanSql, statementsOf, copyFromStdin, copyFromPath } from '@shiro/postgres/sql-split';
import { formatTable, defaultFormat } from '@shiro/postgres/psql-format';
import { Frames, concat, lastStatus, message, parseReply, renameStatement, startupPacket } from '@shiro/postgres/wire';
import { createTestShell } from './helpers';

let fs: FileSystem;
let shell: Shell;
let stack: NetStack;

async function sh(cmd: string): Promise<{ out: string; err: string; code: number }> {
  let out = '';
  let err = '';
  const code = await shell.execute(cmd, (s: string) => { out += s; }, (s: string) => { err += s; });
  return { out: out.replace(/\r\n/g, '\n'), err: err.replace(/\r\n/g, '\n'), code };
}

beforeAll(async () => {
  ({ fs, shell } = await createTestShell());
  for (const c of postgresCommands) shell.commands.register(c);
  shell.commands.register(sudoCmd);
  const kernel = getKernel();
  if (!netStackOf(kernel)) installNet(kernel);
  stack = netStackOf(kernel)!;
  postgresFor({ fs });
}, 60_000);

afterAll(async () => {
  await currentPostgres()?.stop();
});

describe('SQL text', () => {
  it('cuts statements at the semicolons that end them', () => {
    expect(statementsOf("select 1; select ';' as a; select $$a;b$$; -- no; more\nselect 4")).toEqual([
      'select 1', "select ';' as a", 'select $$a;b$$', '-- no; more\nselect 4',
    ]);
    expect(statementsOf('create rule r as on insert to t do (insert into u values (1); insert into u values (2));')).toHaveLength(1);
    expect(statementsOf("select E'it\\'s; fine'; select 2")).toEqual(["select E'it\\'s; fine'", 'select 2']);
    expect(statementsOf('/* a; /* nested; */ b; */ select 1;')).toEqual(['/* a; /* nested; */ b; */ select 1']);
  });

  it('says what an unfinished statement is inside of', () => {
    expect(scanSql("select 'abc").open).toBe("'");
    expect(scanSql('select "abc').open).toBe('"');
    expect(scanSql('do $fn$ begin').open).toBe('$');
    expect(scanSql('select (1,').open).toBe('(');
    expect(scanSql('select 1 /* note').open).toBe('*');
    expect(scanSql('select 1; -- done').restHasCode).toBe(false);
    expect(scanSql('select 1; select').restHasCode).toBe(true);
  });

  it('finds COPY ... FROM STDIN, alone or among other statements', () => {
    expect(copyFromStdin('COPY t (a, b) FROM stdin;')).toBe('one');
    expect(copyFromStdin("COPY t FROM STDIN WITH (FORMAT csv)")).toBe('one');
    expect(copyFromStdin('select 1; copy t from stdin')).toBe('mixed');
    expect(copyFromStdin("insert into t values ('copy t from stdin')")).toBe('');
    expect(copyFromStdin("copy t from '/tmp/x'")).toBe('');
    expect(copyFromPath("COPY t FROM STDIN WITH (FORMAT csv)", '/dev/blob')).toBe("COPY t FROM '/dev/blob' WITH (FORMAT csv)");
  });
});

describe('psql output', () => {
  const cols = [{ name: 'id', typeOid: 23, tableOid: 0 }, { name: 'name', typeOid: 25, tableOid: 0 }];

  it('lays a table out as psql does', () => {
    expect(formatTable({ columns: cols, rows: [['1', 'Earth'], ['12', null]] }, defaultFormat())).toBe(
      ' id | name  \n' +
      '----+-------\n' +
      '  1 | Earth\n' +
      ' 12 | \n' +
      '(2 rows)\n\n');
    expect(formatTable({ columns: cols, rows: [] }, defaultFormat())).toBe(' id | name \n----+------\n(0 rows)\n\n');
  });

  it('does rows only, unaligned, CSV and expanded', () => {
    expect(formatTable({ columns: cols, rows: [['1', 'a']] }, { ...defaultFormat(), tuplesOnly: true })).toBe('  1 | a\n\n');
    expect(formatTable({ columns: cols, rows: [['1', 'a']] }, { ...defaultFormat(), format: 'unaligned' })).toBe('id|name\n1|a\n(1 row)\n');
    expect(formatTable({ columns: cols, rows: [['1', 'a,b']] }, { ...defaultFormat(), format: 'unaligned', tuplesOnly: true, fieldSep: '\t' })).toBe('1\ta,b\n');
    expect(formatTable({ columns: cols, rows: [['1', 'a,b'], ['2', 'say "hi"']] }, { ...defaultFormat(), format: 'csv' })).toBe('id,name\n1,"a,b"\n2,"say ""hi"""\n');
    expect(formatTable({ columns: cols, rows: [['1', 'Earth']] }, { ...defaultFormat(), expanded: true })).toBe(
      '-[ RECORD 1 ]\n' +
      'id   | 1\n' +
      'name | Earth\n\n');
  });
});

describe('the wire', () => {
  it('frames messages, before and after the startup packet', () => {
    const f = new Frames();
    const start = startupPacket({ user: 'ann', database: 'lab' });
    const q = message('Q', 'select 1\0');
    const all = concat([start, q, q]);
    f.push(all.subarray(0, 5));
    expect(f.next(true)).toBeNull();
    f.push(all.subarray(5, start.length + 3));
    expect(f.next(true)).toEqual(start);
    expect(f.next()).toBeNull();
    f.push(all.subarray(start.length + 3));
    expect(f.next()).toEqual(q);
    expect(f.next()).toEqual(q);
    expect(f.next()).toBeNull();
  });

  it("gives a prepared statement a connection's own name", () => {
    const names = new Set<string>();
    const parse = renameStatement(message('P', 's1\0select 1\0', new Uint8Array([0, 0])), 'c7_', names);
    expect(new TextDecoder().decode(parse.subarray(5, 11))).toBe('c7_s1\0');
    expect(new DataView(parse.buffer, parse.byteOffset).getInt32(1)).toBe(parse.length - 1);
    expect([...names]).toEqual(['c7_s1']);
    const bind = renameStatement(message('B', 'portal\0s1\0', new Uint8Array([0, 0, 0, 0, 0, 0])), 'c7_');
    expect(new TextDecoder().decode(bind.subarray(5, 18))).toBe('portal\0c7_s1\0');
    const unnamed = message('P', '\0select 1\0', new Uint8Array([0, 0]));
    expect(renameStatement(unnamed, 'c7_')).toBe(unnamed);
    // Describe and Close of a portal are left alone
    const portal = message('D', 'Pp1\0');
    expect(renameStatement(portal, 'c7_')).toBe(portal);
    renameStatement(message('C', 'Ss1\0'), 'c7_', names);
    expect(names.size).toBe(0);
  });
});

describe('the postgres service', () => {
  it('is not running until something connects, and pg_isready starts it', async () => {
    const svc = currentPostgres()!;
    expect(svc.status).toBe('stopped');
    expect((await sh('service postgresql status')).out).toMatch(/inactive.*starts when something connects to localhost:5432/);
    const r = await sh('pg_isready');
    expect(r.out).toBe('localhost:5432 - accepting connections\n');
    expect(r.code).toBe(0);
    expect(svc.status).toBe('running');
    expect(svc.info!.fresh).toBe(true);
    expect(svc.info!.version).toMatch(/^PostgreSQL 18\./);
    expect((await sh('service postgresql status')).out).toMatch(/active \(running\), PostgreSQL 18 on 127\.0\.0\.1:5432/);
    // it shows as a process, and its port is taken
    expect([...getKernel().procs.values()].some((p) => p.argv[0] === 'postgres')).toBe(true);
    expect(stack.listenerFor(PG_PORT, '127.0.0.1')).toBeTruthy();
  }, 120_000);

  it('psql with no arguments connects as the tab\'s user to a database of that name', async () => {
    const r = await sh('psql -c "select current_user, current_database()"');
    expect(r.err).toBe('');
    expect(r.out).toBe(
      ' current_user | current_database \n' +
      '--------------+------------------\n' +
      ' user         | user\n' +
      '(1 row)\n\n');
    // a database that was never made is an error, in PostgreSQL's words
    const missing = await sh('psql -d nosuchdb -c "select 1"');
    expect(missing.code).toBe(2);
    expect(missing.err).toMatch(/psql: error: connection to server at "localhost", port 5432 failed: FATAL: {2}database "nosuchdb" does not exist/);
  }, 60_000);

  it('sudo -u postgres psql is the postgres role', async () => {
    const r = await sh('sudo -u postgres psql -At -c "select current_user, current_database()"');
    expect(r.out).toBe('postgres|postgres\n');
    expect(r.code).toBe(0);
  }, 60_000);

  it('runs what a relational database course types', async () => {
    // freeCodeCamp's course: psql --username=freecodecamp --dbname=postgres, then SQL and backslash commands
    const P = 'psql --username=freecodecamp --dbname=postgres';
    expect((await sh(`${P} -c "CREATE DATABASE universe;"`)).out).toBe('CREATE DATABASE\n');
    const lst = await sh(`${P} -l`);
    expect(lst.out).toMatch(/^ +List of databases\n/);
    expect(lst.out).toMatch(/\n universe +\| freecodecamp \| UTF8/);
    await fs.writeFile('/tmp/universe.sql', [
      '\\c universe',
      'CREATE TABLE galaxy(galaxy_id SERIAL PRIMARY KEY, name VARCHAR(30) UNIQUE NOT NULL, age_in_millions_of_years INT, has_life BOOLEAN DEFAULT false);',
      'CREATE TABLE star(star_id SERIAL PRIMARY KEY, name VARCHAR(30) UNIQUE NOT NULL,',
      '  galaxy_id INT NOT NULL REFERENCES galaxy(galaxy_id), mass NUMERIC(6,2));',
      "INSERT INTO galaxy(name, age_in_millions_of_years, has_life) VALUES ('Milky Way', 13600, true), ('Andromeda', 10000, false);",
      "INSERT INTO star(name, galaxy_id, mass) VALUES ('Sun', 1, 1.00), ('Sirius', 1, 2.06), ('Alpheratz', 2, 3.80);",
      'SELECT s.name AS star, g.name AS galaxy FROM star s JOIN galaxy g USING (galaxy_id) ORDER BY s.name;',
      'SELECT g.name, COUNT(*) AS stars, SUM(mass) AS mass FROM galaxy g LEFT JOIN star USING (galaxy_id) GROUP BY g.name ORDER BY 2 DESC;',
      '\\dt',
      '\\d star',
      "INSERT INTO star(name, galaxy_id) VALUES ('Nowhere', 99);",
      '',
    ].join('\n'));
    const r = await sh(`${P} -f /tmp/universe.sql`);
    expect(r.out).toBe(
      'You are now connected to database "universe" as user "freecodecamp".\n' +
      'CREATE TABLE\n' +
      'CREATE TABLE\n' +
      'INSERT 0 2\n' +
      'INSERT 0 3\n' +
      '   star    |  galaxy   \n' +
      '-----------+-----------\n' +
      ' Alpheratz | Andromeda\n' +
      ' Sirius    | Milky Way\n' +
      ' Sun       | Milky Way\n' +
      '(3 rows)\n\n' +
      '   name    | stars | mass \n' +
      '-----------+-------+------\n' +
      ' Milky Way |     2 | 3.06\n' +
      ' Andromeda |     1 | 3.80\n' +
      '(2 rows)\n\n' +
      '           List of relations\n' +
      ' Schema |  Name  | Type  |    Owner     \n' +
      '--------+--------+-------+--------------\n' +
      ' public | galaxy | table | freecodecamp\n' +
      ' public | star   | table | freecodecamp\n' +
      '(2 rows)\n\n' +
      '                                       Table "public.star"\n' +
      '  Column   |         Type          | Collation | Nullable |                Default                \n' +
      '-----------+-----------------------+-----------+----------+---------------------------------------\n' +
      ' star_id   | integer               |           | not null | nextval(\'star_star_id_seq\'::regclass)\n' +
      ' name      | character varying(30) |           | not null | \n' +
      ' galaxy_id | integer               |           | not null | \n' +
      ' mass      | numeric(6,2)          |           |          | \n' +
      'Indexes:\n' +
      '    "star_pkey" PRIMARY KEY, btree (star_id)\n' +
      '    "star_name_key" UNIQUE CONSTRAINT, btree (name)\n' +
      'Foreign-key constraints:\n' +
      '    "star_galaxy_id_fkey" FOREIGN KEY (galaxy_id) REFERENCES galaxy(galaxy_id)\n\n');
    expect(r.err).toBe(
      'psql:/tmp/universe.sql:11: ERROR:  insert or update on table "star" violates foreign key constraint "star_galaxy_id_fkey"\n' +
      'DETAIL:  Key (galaxy_id)=(99) is not present in table "galaxy".\n');
    expect(r.code).toBe(0);
    // the same file with ON_ERROR_STOP stops at its first error (the tables exist now)
    const stop = await sh(`${P} -v ON_ERROR_STOP=1 -f /tmp/universe.sql`);
    expect(stop.code).toBe(3);
    expect(stop.err).toMatch(/universe\.sql:2: ERROR: {2}relation "galaxy" already exists/);
    // \d of the referenced table names who refers to it; an error shows where it is
    const d = await sh('psql -U freecodecamp -d universe -c "\\d galaxy"');
    expect(d.out).toMatch(/Referenced by:\n {4}TABLE "star" CONSTRAINT "star_galaxy_id_fkey" FOREIGN KEY \(galaxy_id\) REFERENCES galaxy\(galaxy_id\)\n/);
    const bad = await sh('psql -U freecodecamp -d universe -c "SELECT nam FROM galaxy"');
    expect(bad.err).toBe('ERROR:  column "nam" does not exist\nLINE 1: SELECT nam FROM galaxy\n               ^\nHINT:  Perhaps you meant to reference the column "galaxy.name".\n');
    expect(bad.code).toBe(1);
  }, 120_000);

  it('takes SQL on standard input, and COPY data with it', async () => {
    await fs.writeFile('/tmp/dump.sql', [
      'CREATE TABLE planet (planet_id integer NOT NULL, name text, moons integer);',
      'COPY planet (planet_id, name, moons) FROM stdin;',
      '1\tEarth\t1',
      '2\tMars\t2',
      '3\tVenus\t\\N',
      '\\.',
      'SELECT count(*), sum(moons) FROM planet;',
      '',
    ].join('\n'));
    const r = await sh('psql -U freecodecamp -d universe -At < /tmp/dump.sql');
    expect(r.err).toBe('');
    expect(r.out).toBe('CREATE TABLE\nCOPY 3\n3|3\n');
    // \copy reads and writes the tab's files
    await fs.writeFile('/tmp/more.csv', '4,Jupiter,95\n5,"Saturn, ringed",146\n');
    const c = await sh(`psql -U freecodecamp -d universe -c "\\copy planet from '/tmp/more.csv' with (format csv)"`);
    expect(c.err).toBe('');
    expect(c.out).toBe('COPY 2\n');
    await sh(`psql -U freecodecamp -d universe -c "\\copy (select name, moons from planet order by planet_id) to '/tmp/out.csv' with (format csv, header)"`);
    expect(await fs.readFile('/tmp/out.csv', 'utf8')).toBe('name,moons\nEarth,1\nMars,2\nVenus,\nJupiter,95\n"Saturn, ringed",146\n');
    // COPY ... TO STDOUT comes straight back
    expect((await sh('psql -U freecodecamp -d universe -c "COPY (select name from planet where moons > 90 order by 1) TO STDOUT"')).out).toBe('Jupiter\nSaturn, ringed\n');
  }, 60_000);

  it('createdb and dropdb', async () => {
    expect((await sh('createdb shop')).code).toBe(0);
    expect((await sh('psql shop -At -c "select current_database()"')).out).toBe('shop\n');
    const again = await sh('createdb shop');
    expect(again.code).toBe(1);
    expect(again.err).toBe('createdb: error: database creation failed: ERROR:  database "shop" already exists\n');
    expect((await sh('dropdb shop')).code).toBe(0);
    expect((await sh('dropdb shop')).err).toBe('dropdb: error: database removal failed: ERROR:  database "shop" does not exist\n');
    expect((await sh('dropdb --if-exists shop')).code).toBe(0);
    expect((await sh('psql shop -c "select 1"')).err).toMatch(/database "shop" does not exist/);
  }, 60_000);

  it('serves several connections: transactions never interleave, prepared statements never collide', async () => {
    const connect = (database: string) => PgClient.connect({ stack, host: 'localhost', port: PG_PORT, user: 'freecodecamp', database });
    const a = await connect('universe');
    const b = await connect('universe');
    await a.query('CREATE TABLE counter(n int); INSERT INTO counter VALUES (0)');
    // what one connection SETs is its own, though one session serves both
    expect((await a.query('SHOW application_name')).results[0].rows).toEqual([['psql']]);
    await a.query('SET search_path TO nowhere; SET statement_timeout = 1234');
    expect((await b.query('SHOW search_path')).results[0].rows).toEqual([['public']]);
    expect((await a.query('SHOW search_path; SHOW statement_timeout')).results.map((r) => r.rows[0][0])).toEqual(['nowhere', '1234ms']);
    await a.query('RESET search_path; RESET statement_timeout');
    // a holds the backend for its whole transaction: b's statement waits for the COMMIT
    expect((await a.query('BEGIN; UPDATE counter SET n = n + 1')).status).toBe('T');
    let bDone = false;
    const pending = b.query('UPDATE counter SET n = n + 10 RETURNING n').then((r) => { bDone = true; return r; });
    await new Promise((r) => setTimeout(r, 50));
    expect(bDone).toBe(false);
    expect((await a.query('SELECT n FROM counter')).results[0].rows).toEqual([['1']]);
    await a.query('COMMIT');
    expect((await pending).results[0].rows).toEqual([['11']]);
    // a connection that goes away in a transaction is rolled back
    await b.query('BEGIN; UPDATE counter SET n = 500');
    b.close();
    expect((await a.query('SELECT n FROM counter')).results[0].rows).toEqual([['11']]);
    a.close();

    // the extended protocol from two raw connections, each preparing "s1"
    const raw = async () => {
      const s = stack.socket(AF_INET, SOCK_STREAM) as KSocket;
      expect(await s.connectHost('127.0.0.1', PG_PORT)).toBe(0);
      const frames = new Frames();
      const buf = new Uint8Array(65536);
      const until = async (type: number): Promise<Uint8Array> => {
        const parts: Uint8Array[] = [];
        for (;;) {
          let m = frames.next();
          while (!m) { const n = await s.recv(buf); if (n <= 0) return concat(parts.length ? parts : [new Uint8Array(0)]); frames.push(buf.slice(0, n)); m = frames.next(); }
          parts.push(m);
          if (m[0] === type) return concat(parts);
        }
      };
      await s.send(startupPacket({ user: 'freecodecamp', database: 'universe' }));
      expect(lastStatus(await until(0x5a))).toBe('I');
      return { s, until };
    };
    const int16 = (n: number) => new Uint8Array([n >> 8, n & 255]);
    const one = await raw();
    const two = await raw();
    const prepare = (sql: string) => concat([message('P', 's1\0', sql + '\0', int16(0)), message('S')]);
    const exec = concat([message('B', '\0s1\0', int16(0), int16(0), int16(0)), message('E', '\0', new Uint8Array([0, 0, 0, 0])), message('S')]);
    await one.s.send(prepare("select 'one'"));
    expect(parseReply(await one.until(0x5a)).results.some((r) => r.error)).toBe(false);
    await two.s.send(prepare("select 'two'"));
    const second = parseReply(await two.until(0x5a));
    expect(second.results.map((r) => r.error?.M)).toEqual([]);
    await one.s.send(exec);
    expect(parseReply(await one.until(0x5a)).results[0].rows).toEqual([['one']]);
    await two.s.send(exec);
    expect(parseReply(await two.until(0x5a)).results[0].rows).toEqual([['two']]);
    // COPY ... FROM STDIN in the extended protocol is refused instead of hanging the backend
    await one.s.send(concat([message('P', '\0COPY counter FROM STDIN\0', int16(0)), message('B', '\0\0', int16(0), int16(0), int16(0)), message('E', '\0', new Uint8Array([0, 0, 0, 0])), message('S')]));
    const refused = parseReply(await one.until(0x5a));
    expect(refused.results[0].error?.C).toBe('0A000');
    expect(refused.status).toBe('I');
    // TLS is declined with one byte, as a server without it does
    const tls = stack.socket(AF_INET, SOCK_STREAM) as KSocket;
    await tls.connectHost('127.0.0.1', PG_PORT);
    await tls.send(new Uint8Array([0, 0, 0, 8, 0x04, 0xd2, 0x16, 0x2f]));
    const answer = new Uint8Array(4);
    expect(await tls.recv(answer)).toBe(1);
    expect(answer[0]).toBe(0x4e);
    for (const c of [one.s, two.s, tls]) await c.close();
    // the statements the two made are gone from the shared session
    await new Promise((r) => setTimeout(r, 50));
    expect((await sh('psql -U freecodecamp -d universe -At -c "select count(*) from pg_prepared_statements"')).out).toBe('0\n');
  }, 60_000);

  it('pg_dump writes a script that psql loads into another database', async () => {
    const dump = await sh('pg_dump -U freecodecamp universe -f /tmp/universe-dump.sql');
    expect(dump.err).toBe('');
    expect(dump.code).toBe(0);
    const text = await fs.readFile('/tmp/universe-dump.sql', 'utf8') as string;
    expect(text).toMatch(/^-- PostgreSQL database dump/m);
    expect(text).toMatch(/CREATE TABLE public\.galaxy \(/);
    expect(text).toMatch(/INSERT INTO public\.star VALUES \(1, 'Sun', 1, 1\.00\);/);
    expect(text).toMatch(/ADD CONSTRAINT star_galaxy_id_fkey FOREIGN KEY \(galaxy_id\) REFERENCES public\.galaxy\(galaxy_id\);/);
    expect((await sh('createdb -U freecodecamp copy')).code).toBe(0);
    const load = await sh('psql -U freecodecamp -d copy -q -v ON_ERROR_STOP=1 -f /tmp/universe-dump.sql');
    expect(load.err).toBe('');
    expect(load.code).toBe(0);
    expect((await sh('psql -U freecodecamp -d copy -At -c "select count(*) from star" -c "select count(*) from planet"')).out).toBe('3\n5\n');
    // the keys came along: the copy refuses what the original refuses
    expect((await sh(`psql -U freecodecamp -d copy -c "INSERT INTO star(name, galaxy_id) VALUES ('Nowhere', 99)"`)).err).toMatch(/violates foreign key constraint/);
    // pg_dump's own options: one table, no rows
    const schema = await sh('pg_dump -U freecodecamp -s -t star universe');
    expect(schema.out).toMatch(/CREATE TABLE public\.star \(/);
    expect(schema.out).not.toMatch(/INSERT INTO|CREATE TABLE public\.galaxy/);
    const missing = await sh('pg_dump nosuch');
    expect(missing.code).toBe(1);
    expect(missing.err).toMatch(/pg_dump: error: .*database "nosuch" does not exist/);
    expect((await sh('dropdb -U freecodecamp copy')).code).toBe(0);
  }, 120_000);

  it('keeps its data directory in the tab\'s filesystem, through a stop and through a reload', async () => {
    const svc = currentPostgres()!;
    await svc.kept();
    expect(await fs.readFile(`${PG_DATA}/PG_VERSION`, 'utf8')).toBe('18\n');
    expect((await fs.readdir(`${PG_DATA}/pg_wal`)).some((n) => /^[0-9A-F]{24}$/.test(n))).toBe(true);
    // WAL files are 1 MB, so a small write rewrites 1 MB
    const wal = (await fs.readdir(`${PG_DATA}/pg_wal`)).find((n) => /^[0-9A-F]{24}$/.test(n))!;
    expect((await fs.stat(`${PG_DATA}/pg_wal/${wal}`)).size).toBe(1 << 20);

    // a reload: the page is gone with no shutdown; another service starts on what was kept
    await sh(`psql -U freecodecamp -d universe -c "INSERT INTO galaxy(name) VALUES ('Triangulum')"`);
    await svc.kept();
    const reloaded = new PostgresService({ fs, stack, engine: () => new Engine(), port: 5433 });
    await reloaded.start();
    expect(reloaded.info!.fresh).toBe(false);
    const c = await PgClient.connect({ stack, host: 'localhost', port: 5433, user: 'freecodecamp', database: 'universe' });
    expect((await c.query('SELECT name FROM galaxy ORDER BY galaxy_id')).results[0].rows).toEqual([['Milky Way'], ['Andromeda'], ['Triangulum']]);
    c.close();
    // (two servers on one directory is not a thing to keep: the copy is dropped without writing)
    await (reloaded as unknown as { failed(why: string): Promise<void> }).failed('test over');

    // a clean stop, then the next connection starts it again with everything there
    expect((await sh('service postgresql stop')).code).toBe(0);
    expect(svc.status).toBe('stopped');
    expect(stack.listenerFor(PG_PORT, '127.0.0.1')).toBeFalsy();
    expect((await sh('service postgresql status')).code).toBe(3);
    const r = await sh('psql -U freecodecamp -d universe -At -c "select count(*) from star" -c "select count(*) from planet"');
    expect(r.out).toBe('3\n5\n');
    expect(svc.info!.fresh).toBe(false);
    expect((await sh('systemctl is-active postgresql')).out).toBe('active\n');

    // libpq's default is the socket file, and a connection to it starts the server too
    await sh('service postgresql stop');
    expect(await fs.exists(PG_SOCKET)).toBe(false);
    const unix = stack.socket(AF_UNIX, SOCK_STREAM) as KSocket;
    const ops = { resolve: (path: string) => path, exists: (path: string) => fs.exists(path), create: async () => 0 };
    expect(await stack.connectUnix(unix, { family: AF_UNIX, address: PG_SOCKET, port: 0 }, ops)).toBe(0);
    expect(svc.status).toBe('running');
    await unix.send(startupPacket({ user: 'freecodecamp', database: 'universe' }));
    const hello = new Uint8Array(4096);
    const n = await unix.recv(hello);
    expect(hello[0]).toBe(0x52); // AuthenticationOk
    expect(n).toBeGreaterThan(9);
    await unix.close();
  }, 120_000);
});
