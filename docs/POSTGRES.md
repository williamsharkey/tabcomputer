# PostgreSQL

A web lab needs a database: `psql`, and a server on `localhost:5432` that an Express or Flask app connects to (tabcomputer#126). The tab has one. Nothing is installed or configured: the first connection starts it.

```
$ psql
psql (18.6)
Type "help" for help.

user=# CREATE TABLE galaxy(galaxy_id SERIAL PRIMARY KEY, name VARCHAR(30) UNIQUE NOT NULL);
CREATE TABLE
user=# \dt
```

Code: `src/postgres/` (the service), `src/commands/psql.ts` (the commands). Tests: `tests/tests/shiro-vitest/postgres.test.ts`, `tests/browser/postgres.mjs`.

## What is there

| | |
| --- | --- |
| Server | PostgreSQL 18 on `127.0.0.1:5432` and on the socket `/var/run/postgresql/.s.PGSQL.5432`. It starts when something connects to port 5432. `ps` shows it as `postgres -D /var/lib/postgresql/18/main`. |
| `psql` | `-c`, `-f`, `-d`, `-U`, `-h`, `-p`, `-l`, `-t`, `-A`, `-F`, `-x`, `-q`, `-1`, `-o`, `--csv`, `-v ON_ERROR_STOP=1`, a `postgresql://` address, SQL on standard input. At the prompt: `\l`, `\dt` (`\dv`, `\ds`, `\di`), `\d NAME`, `\du`, `\dn`, `\c DB [USER]`, `\i FILE`, `\copy`, `\x`, `\t`, `\a`, `\timing`, `\conninfo`, `\!`, `\q`. Tables, errors and `\d` are laid out as PostgreSQL's psql lays them out. |
| `createdb`, `dropdb` | With `-U`, `-O`, `-T`, `--if-exists`. |
| `pg_isready` | Exit status 0 when the server answers. It starts the server, like any connection. |
| `pg_dump` | PostgreSQL's own, for the tab's server: `pg_dump DB > file.sql`, `-s`, `-a`, `-t TABLE`, `-c`, `-O`. Rows are written as `INSERT` statements. `psql -f file.sql` loads it. |
| `service postgresql start\|stop\|restart\|status` | Also `systemctl ... postgresql`. `sudo` in front changes nothing. |
| `sudo -u postgres psql` | Connects as the role `postgres` to the database `postgres`. There is no `postgres` account: the command runs as the tab's user under that name. |
| Programs | Anything that speaks the PostgreSQL protocol over TCP: node's `pg`, Python's `pg8000` on the built-in Python. Debian's own clients, which use libpq (`psql`, `createdb` from `apt install postgresql-client`), connect to it too. psycopg needs libpq and so Debian's Python (`toolchain install python`); that pair was not tried. |

Any user name connects, with any password or none: a role that does not exist is made, as a superuser. The tab has one person. A database named after the role is made when that is the database asked for, which is what `psql` and most drivers ask for when given no name. So `psql` alone works, and so does `psql --username=freecodecamp --dbname=postgres`. Any other database that does not exist is an error, in PostgreSQL's words.

```js
// node: npm install pg
const { Pool } = require('pg');
const pool = new Pool({ host: 'localhost', user: 'me', database: 'shop' });   // after: createdb shop
```

```python
# python3: pip install pg8000
import pg8000.native
con = pg8000.native.Connection("me", host="localhost", database="shop")
```

## How it works

The server is [PGlite](https://pglite.dev) 0.5.9: PostgreSQL 18.6 compiled to WebAssembly, Apache-2.0 (PostgreSQL itself is under the PostgreSQL licence). It is an npm dependency (`@electric-sql/pglite`, and `@electric-sql/pglite-tools` for `pg_dump`), bundled as lazy chunks, so a build has it and nothing is uploaded by hand.

- `src/postgres/engine.ts` runs it, in a Worker (`engine-worker.ts`), so a query never holds the page. Under Node (vitest) it runs in process.
- `src/postgres/service.ts` listens on port 5432 of the kernel's network (`src/kernel/net.ts`: `NetStack.onDemand` starts it on the first loopback connection that finds no listener) and passes the wire protocol to the backend. No TLS and no password: the connection never leaves the tab.
- PGlite is one backend process. Every connection is served by it in turn. A connection holds the backend from its first message until the server is idle again (`ReadyForQuery` outside a transaction), so statements and transactions of two clients never interleave. A connection that goes away inside a transaction is rolled back.
- What a connection `SET`s is noted when the backend turns to another connection and put back when it returns. Prepared statements are renamed per connection. Temporary tables, advisory locks and `LISTEN` are shared by all connections.
- One backend serves one database. A connection to another database stops the backend cleanly and starts it on the same files with that database (a fraction of a second). Two programs that use two databases at the same moment make it switch for every statement.
- `COPY ... FROM STDIN` is taken by the service and handed to the backend whole, as a simple query of its own. In the extended protocol, or inside a string of several statements, it is refused.

### The data directory

`/var/lib/postgresql/18/main` in the tab's filesystem holds the files PostgreSQL writes: `PG_VERSION`, `base/`, `global/`, `pg_wal/`. The files that changed are written there after a statement, at once when it comes on its own and four times a second while statements keep coming. WAL goes first and `pg_control` last, so a reload at any moment leaves a cluster that recovers like after a crash. What a reload can lose is the last quarter second of a script. A page that closes stops nothing cleanly; the next start replays the WAL. `service postgresql stop` is a clean shutdown.

WAL files are 1 MB (`initdb --wal-segsize=1`; the default is 16), because each write to the database rewrites the newest one. A new cluster is 30 MB in about 1000 files; each database adds 7.5 MB. A seed (`seed`) carries the directory like any other.

`/var/lib/postgresql/18/tabcomputer.json` is written after a whole new cluster is. A directory without it was cut short by a reload and is made again.

A later PGlite with PostgreSQL 19 starts a new cluster in `/var/lib/postgresql/19/main`; `pg_dump` before the upgrade is how data moves.

## Measured

`node tests/browser/postgres.mjs` on a local build and a local server, headless Chrome 155, Apple M3, 2026-10-13, each from a new profile. A school Chromebook and a school network will be slower: the download is the part that grows.

| | |
| --- | --- |
| First use (`pg_isready`: the download, a new cluster, the server answering) | 0.9 s |
| First connection after a reload (the kept cluster) | 0.9 s |
| Download for the first connection | 4.0 MB (4 036 567 bytes; the same files are 17.5 MB as they are) |
| `psql -c 'select 1'`, the statement alone (`\timing`) | 3 ms |
| A query round trip from node's `pg` (`SELECT 1`, 200 in a row) | 5.0 ms |
| A join by key with a parameter, from node's `pg` | 5.1 ms |
| 20 000 rows inserted by one statement | 50 to 70 ms |
| A `pg_dump` script with 20 000 `INSERT` statements, loaded with `psql -f` | 2.3 s |
| `pg_dump` of that database | 0.5 s |
| `npm install express pg` | 1 to 3 s |
| `pip install pg8000` | 0.7 s |

Most of a round trip from node is not PostgreSQL: the same statement takes 0.2 ms in the backend (PGlite under Node, `SELECT 1` 200 times). The rest is the hops between the program's Worker, the page and the backend's Worker.

The download is `pglite.wasm` (10.1 MB, 2.66 MB as brotli), `pglite.data` (6.3 MB, 1.06 MB), `initdb.wasm` (0.40 MB, 0.12 MB), PGlite's script (0.54 MB, 0.09 MB) and 0.1 MB of tabcomputer's own. The build makes the brotli copies (`vite-plugin-precompress.ts`) and `server.mjs` sends them to a browser that accepts `br`; nothing else of the site is sent compressed. `pg_dump` is another 0.3 MB on its first use. The build grows by 23 MB on disk.

A new cluster is 30 MB in about 1000 files (`du -sh /var/lib/postgresql` said 45M after the check: four databases and a 20 000-row table).

## What it does not do

- Extensions: `CREATE EXTENSION` finds none but `plpgsql`. PGlite has builds of some (pgcrypto, hstore, pg_trgm, pgvector); they are not loaded.
- More than one backend: a long query makes every other connection wait. There is no parallel query, no `LISTEN`/`NOTIFY` delivered to a waiting connection, no query cancel (`^C` in a client does not stop a running statement), no replication, no `pg_basebackup`.
- Roles as a boundary: every role is a superuser and no password is checked. `CREATE ROLE`, `GRANT` and ownership work and show in `\du` and `\dt`, for learning them.
- Big tables: PGlite is a 32-bit program with at most 2 GB of memory, the files are also kept in memory, and a table's file is rewritten whole in the tab's filesystem when it changes. A few hundred megabytes is the practical top.
- Reach from outside: only programs in the tab connect. Nothing on the internet can.
- `psql`: no tab completion, no `\e`, no variables but `ON_ERROR_STOP`, no `\df` or `\dp`. Debian's psql (`apt install postgresql-client`) replaces the built-in one and connects to the same server with `-h localhost`.
- `pg_dump`: the plain format only, the tab's own server only. It ends with `DEALLOCATE ALL`, so statements other connections had prepared are gone after it.
- The psql command of earlier builds (`psql NAME "SQL"`, PGlite from a CDN, one IndexedDB store per name) is gone. Its databases are not read by this server; the first start says so when it finds any.

## Debian's PostgreSQL

`apt install postgresql` is the other route: PostgreSQL 17 from Debian, its own processes in the x86-64 emulator. It installs and its server can run, but not in time for a lab, and not without changes by hand. Measured 2026-10-13 with `scripts/browser-check.mjs` on a local build (headless Chrome 155, Apple M3, a new profile each time, the packages already in the server's cache), three runs.

| Step | Time |
| --- | --- |
| `apt-get update` | 13 s |
| Downloading the 47 packages | 9 s |
| `apt-get install -y postgresql` after that | 5 min 24 s (7 min 5 s and 8 min 29 s in the other two runs, which include `apt-get update`) |
| of it: unpacking | 31 s |
| of it: configuring the other packages (locales 7 s, ssl-cert 9 s, postgresql-common 24 s) | 47 s |
| of it: configuring postgresql-17, which is `pg_createcluster`, which is `initdb` | 3 min 52 s |

So the time is `initdb`: 3 min 16 s when run by hand, 3 min 28 s as `pg_createcluster`. Its bootstrap runs the server as one process through a long script of catalog work, all of it interpreted. A stand-alone backend (`postgres --single`) takes 59 s to answer one query. The kernel log stayed empty in every run: nothing is missing, it is slow.

What tabcomputer#126 reported, and what each turned out to be:

- **"unknown user" from `sudo -u postgres`.** The package does create the account (`postgres:x:100:102` in `/etc/passwd`). The built-in `sudo` knew two users, root and the tab's. It now runs a command as any account of `/etc/passwd`, with that uid: `sudo -u postgres /usr/bin/id` prints `uid=100(postgres)`.
- **The install does not start the server.** `invoke-rc.d: policy-rc.d denied execution of start`: the Debian image has a `/usr/sbin/policy-rc.d` that tabcomputer writes, so that packages do not start services. The cluster is there (`pg_lsclusters`: `17 main 5432 down`).
- **`sudo service postgresql start` fails.** `FATAL: private key file "/etc/ssl/private/ssl-cert-snakeoil.key" has group or world access`. Debian's configuration has `ssl = on` with a key that is root's, mode 0640. In the tab a file has no owner of its own and stats as the caller's, so PostgreSQL takes the key for its own and wants 0600. After `sudo chmod 600 /etc/ssl/private/ssl-cert-snakeoil.key` the same command starts the server in 37 s: `database system is ready to accept connections`, `pg_lsclusters` says online, six processes share a System V segment. The init script still prints "failed!".
- **Nobody can log in to it.** `sudo -u postgres /usr/lib/postgresql/17/bin/psql`, as uid 100: `FATAL: Peer authentication failed for user "postgres"`. The server asks the socket who is on the other end and does not get uid 100; why was not looked into. Over TCP the default asks for a password no role has. A cluster made by `initdb -A trust` and started with `pg_ctl` (1.3 s) does answer Debian's psql over TCP (`select version()` in 2 s).
- **A `#!` script under `sudo -u NAME` runs as the tab's user.** Found on the way: `/usr/bin/psql` is Debian's Perl wrapper, and the shell starts a script's interpreter through `runElfWithBlink` (`src/x86-engine/blink.ts`), whose `kernel.spawn` passes no `uid`; the pipeline path in `src/shell-kernel.ts` does. A program run directly gets the uid. Not fixed.

Once Debian's packages are installed, `psql` is Debian's (a file in `/usr/bin` replaces a builtin of the same name) and `service postgresql ...` is the package's init script; the tab's own server gives up port 5432 when that one is started. While Debian's server is down, Debian's psql reaches the tab's own, because a connection to the socket or to `localhost:5432` starts it. Checked with PostgreSQL 17's `psql` (also `-h localhost -U postgres`, `\dt`, `\l`), `createdb` and `createuser`. Debian's cluster is `/var/lib/postgresql/17/main`, beside the tab's.

## Changing it

- Run `cd tests && npx vitest run tests/shiro-vitest/postgres.test.ts` (the whole service in process, a course's steps, two connections, the data directory across a stop and a reload) and `node tests/browser/postgres.mjs` (the Worker, the real terminal, node and Python programs).
- A new PGlite version: change both versions in `package.json`, `PG_MAJOR` in `service.ts` when PostgreSQL's major version moves, and run both. The service uses three things PGlite does not promise: `_handleBlob`/`_cleanupBlob` (for `COPY FROM STDIN`), the path `/pglite/data`, and the `fs.closeFs` hook that reads the files of a stopped cluster.
