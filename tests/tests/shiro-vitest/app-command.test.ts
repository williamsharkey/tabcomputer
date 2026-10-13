/**
 * The `app` command and a running app (src/commands/app.ts, src/apps/registry.ts,
 * src/apps/runtime.ts, src/apps/templates.ts; docs/APPS.md): scaffolding from
 * the templates (each runs as created), installing, listing, removing, what an
 * app's page is served, and the backend's life with the app's views.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestShell, run } from './helpers';
import type { FileSystem } from '@shiro/filesystem';
import type { Shell } from '@shiro/shell';
import { appCmd } from '@shiro/commands/app';
import { getActiveServers } from '@shiro/commands/serve';
import { iframeServer } from '@shiro/iframe-server';
import { parseManifest } from '@shiro/apps/manifest';
import { REGISTRY_FILE, listInstalled, loadManifest, readRegistry } from '@shiro/apps/registry';
import { configureApps, instanceFor, instanceOf, resetApps, setTabJsSource, NO_NETWORK_CSP, TAB_JS_PATH, type AppView } from '@shiro/apps/runtime';
import { TEMPLATES, idFromName, templateFiles, titleFromId } from '@shiro/apps/templates';
import { setInstallConfirm } from '@shiro/apps/install';
import { stopApp } from '@shiro/apps/window';
import type { InstallPromptInfo } from '@shiro/apps/links';
import { BACKOFF_MS } from '@shiro/apps/supervisor';

const HOME = '/home/user';
const text = (b: unknown) => (typeof b === 'string' ? b : new TextDecoder().decode(b as Uint8Array));
const until = async (fn: () => boolean, ms = 4000) => { const t0 = Date.now(); while (!fn() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 20)); return fn(); };
const view = (): AppView => ({ kind: 'pane', close: () => {} });

describe('app command', () => {
  let fs: FileSystem;
  let shell: Shell;
  let installed: string[];
  const realFetch = globalThis.fetch;

  beforeEach(async () => {
    ({ fs, shell } = await createTestShell());
    shell.commands.register(appCmd);
    // (the test filesystem is one database for the whole file: start each test without apps)
    for (const p of ['/var/lib/tabcomputer/apps.json', `${HOME}/Apps`, `${HOME}/src`, `${HOME}/.local/share/apps`, `${HOME}/work`]) await fs.rm(p, { recursive: true }).catch(() => {});
    for (const n of await fs.readdir(HOME).catch(() => [] as string[])) if (/^(photo-tool|my-notes-lists|twice|backup|try-.*|okay|other|ToolsOut|NeedsOut|outside\.txt|backup\.sh)$/.test(n)) await fs.rm(`${HOME}/${n}`, { recursive: true }).catch(() => {});
    installed = [];
    configureApps({
      fs, shell,
      toolchains: {
        installed: async (sets) => Object.fromEntries(sets.map((s) => [s, installed.includes(s)])),
        install: async (set, onLine) => { onLine(`unpacking ${set}`); if (set === 'broken') return 1; installed.push(set); return 0; },
      },
      download: () => {},
    });
    setTabJsSource('// tab.js stand-in');
    shell.cwd = HOME;
  });

  afterEach(() => {
    resetApps();
    configureApps(null);
    setInstallConfirm(null);
    setTabJsSource(null);
    iframeServer.cleanup();
    getActiveServers().clear();
    globalThis.fetch = realFetch;
  });

  const app = async (line: string) => { const r = await run(shell, `app ${line}`); return { ...r, output: r.output.replace(/\r\n/g, '\n') }; };
  async function makeApp(id: string, manifest: Record<string, unknown> = {}, files: Record<string, string> = {}): Promise<string> {
    const dir = `${HOME}/src/${id}`;
    await fs.mkdir(`${dir}/public`, { recursive: true });
    await fs.writeFile(`${dir}/app.json`, JSON.stringify({ manifest: 1, id, name: id.toUpperCase(), entry: 'public', ...manifest }));
    await fs.writeFile(`${dir}/public/index.html`, `<!doctype html><title>${id}</title><script src="/__tabcomputer/tab.js"></script>`);
    for (const [rel, body] of Object.entries(files)) {
      await fs.mkdir(`${dir}/${rel}`.replace(/\/[^/]+$/, ''), { recursive: true });
      await fs.writeFile(`${dir}/${rel}`, body);
    }
    return dir;
  }

  it('usage, help and mistakes follow the other commands', async () => {
    const none = await app('');
    expect(none.exitCode).toBe(2);
    expect(none.output).toMatch(/^Usage: app new NAME/);
    expect((await app('help')).exitCode).toBe(0);
    expect((await app('--help')).output).toMatch(/app install gh:OWNER\/REPO/);
    const bad = await app('frobnicate');
    expect(bad.exitCode).toBe(2);
    expect(bad.output).toMatch(/app: unknown subcommand 'frobnicate'/);
    expect((await app('list --wat')).exitCode).toBe(2);
    expect((await app('new')).exitCode).toBe(2);
    expect((await app('new a b')).exitCode).toBe(2);
    expect((await app('open')).exitCode).toBe(2);
    expect((await app('new x --template')).output).toMatch(/--template needs a value/);
  });

  it('templates: the three starting points and the script wrapper', async () => {
    const r = await app('templates');
    expect(r.exitCode).toBe(0);
    for (const t of ['file-tool', 'form', 'table', 'script']) expect(r.output).toContain(t);
    expect(TEMPLATES.map((t) => t.name)).toEqual(['file-tool', 'form', 'table', 'script']);
    for (const t of TEMPLATES) {
      const files = templateFiles(t.name);
      expect([...files.keys()], t.name).toEqual(expect.arrayContaining(['app.json', 'icon.svg', 'public/index.html', 'public/app.js']));
      const m = parseManifest(files.get('app.json')!);
      // each needs nothing installed first, and asks for no folder outside its own data
      expect(m.toolchains, t.name).toEqual([]);
      expect(m.access.fs, t.name).toEqual([]);
      expect(m.access.network, t.name).toBe(false);
      expect(m.access.shell, t.name).toBe(false);
      expect(files.get('public/index.html'), t.name).toContain('<script src="/__tabcomputer/tab.js"></script>');
    }
  });

  it('new: a folder with a valid manifest under the given name', async () => {
    const r = await app('new photo-tool');
    expect(r.exitCode).toBe(0);
    expect(r.output).toMatch(/Created photo-tool in ~\/photo-tool \(template file-tool\):/);
    expect(r.output).toMatch(/Try it: +app dev ~\/photo-tool/);
    const m = await loadManifest(fs, `${HOME}/photo-tool`);
    expect(m).toMatchObject({ id: 'photo-tool', name: 'Photo tool', entry: 'public' });
    expect(await fs.readFile(`${HOME}/photo-tool/public/index.html`, 'utf8')).toContain('<title>Photo tool</title>');
    // a name with capitals and spaces: an id is made, the name is kept
    expect((await app('new "My Notes & <Lists>!" --template table')).exitCode).toBe(0);
    const n = await loadManifest(fs, `${HOME}/my-notes-lists`);
    expect(n).toMatchObject({ id: 'my-notes-lists', name: 'My Notes & Lists!' });
    expect(await fs.readFile(`${HOME}/my-notes-lists/public/index.html`, 'utf8')).toContain('<h1>My Notes &#38; Lists!</h1>');
    expect((await app('new forms --template form --name "Order form" --dir work/order')).exitCode).toBe(0);
    expect(await loadManifest(fs, `${HOME}/work/order`)).toMatchObject({ id: 'forms', name: 'Order form' });
  });

  it('new refuses names it cannot use, an unknown template, a folder that is not empty', async () => {
    for (const name of ['terminal', 'x', '123', '"!!!"', 'api']) {
      const r = await app(`new ${name}`);
      expect(r.exitCode, name).toBe(1);
      expect(r.output, name).toMatch(/does not make an id/);
    }
    expect((await app('new okay --template nope')).output).toMatch(/no template named nope \(app templates\)/);
    expect((await app('new okay --template form --from x.sh')).exitCode).toBe(2);
    await app('new twice');
    const again = await app('new twice');
    expect(again.exitCode).toBe(1);
    expect(again.output).toMatch(/twice already exists and is not empty/);
    expect(idFromName('My  App_2')).toBe('my-app-2');
    expect(idFromName('--x--')).toBe('');
    expect(titleFromId('my-app')).toBe('My app');
  });

  it('new --from wraps a script, named by its title header', async () => {
    await fs.writeFile(`${HOME}/backup.sh`, '#!/bin/sh\n# title: Nightly backup\necho "backing up $1"\n');
    const r = await app('new backup --from backup.sh');
    expect(r.exitCode).toBe(0);
    expect(r.output).toMatch(/Created backup in ~\/backup \(from backup\.sh\)/);
    const m = await loadManifest(fs, `${HOME}/backup`);
    expect(m).toMatchObject({ id: 'backup', name: 'Nightly backup' });
    expect(m.access.commands).toEqual(['sh']);
    expect(await fs.readFile(`${HOME}/backup/run.sh`, 'utf8')).toBe('#!/bin/sh\n# title: Nightly backup\necho "backing up $1"\n');
    expect((await app('new other --from missing.sh')).output).toMatch(/missing\.sh: no such file/);
    // it runs as created: the page's own call, through the host
    const inst = instanceFor({ manifest: m, dir: `${HOME}/backup`, source: 'dev:test' });
    let out = '';
    const res = await inst.host.call('run', { cmd: ['sh', `${HOME}/backup/run.sh`, 'the photos'], cwd: inst.dataDir }, (e, d) => { if (e === 'out') out += d; }, () => {}).catch((e) => e);
    await fs.mkdir(inst.dataDir, { recursive: true });
    const ok = await inst.host.call('run', { cmd: ['sh', `${HOME}/backup/run.sh`, 'the photos'] }, (e, d) => { if (e === 'out') out += d; }, () => {});
    expect(res).toBeTruthy();
    expect(ok).toEqual({ value: { code: 0 } });
    expect(out).toContain('backing up the photos');
  });

  it('every template runs as created: its page is served and its call to the tab works', async () => {
    const work: Record<string, (inst: ReturnType<typeof instanceFor>) => Promise<void>> = {
      'file-tool': async (inst) => {
        const put = await inst.host.call('files.put', { batch: 't', rel: 'hello.txt', data: 'hello\n' }, () => {}, () => {}) as { value: { path: string } };
        const r = await inst.host.call('run', { cmd: ['base64', put.value.path], stdout: `${inst.dataDir}/out/hello.txt.b64` }, () => {}, () => {});
        expect(r).toEqual({ value: { code: 0 } });
        expect(((await fs.readFile(`${inst.dataDir}/out/hello.txt.b64`, 'utf8')) as string).trim()).toBe('aGVsbG8K');
      },
      form: async (inst) => {
        let out = '';
        expect(await inst.host.call('run', { cmd: ['seq', '2', '2', '8'] }, (e, d) => { if (e === 'out') out += d; }, () => {})).toEqual({ value: { code: 0 } });
        expect(out).toBe('2\n4\n6\n8\n');
      },
      table: async (inst) => {
        await inst.host.call('fs.write', { path: `${inst.dataDir}/table.csv`, data: 'Name\nAda\n' }, () => {}, () => {});
        expect(await inst.host.call('fs.read', { path: 'table.csv', as: 'text' }, () => {}, () => {})).toEqual({ value: 'Name\nAda\n' });
      },
      script: async (inst) => {
        let out = '';
        await inst.host.call('run', { cmd: ['sh', `${inst.dir}/run.sh`, 'one', 'two words'] }, (e, d) => { if (e === 'out') out += d; }, () => {});
        expect(out).toContain('Arguments: 2');
        expect(out).toContain('  two words');
      },
    };
    for (const t of TEMPLATES) {
      const id = `try-${t.name}`.replace(/-tool$/, '');
      expect((await app(`new ${id} --template ${t.name}`)).exitCode, t.name).toBe(0);
      const check = await app(`check ${id}`);
      expect(check.exitCode, check.output).toBe(0);
      expect(check.output).toMatch(new RegExp(`^${id}: .* \\(app\\.json is valid\\)`));
      const dir = `${HOME}/${id}`;
      const inst = instanceFor({ manifest: await loadManifest(fs, dir), dir, source: `dev:${dir}` });
      await inst.prepare();
      const page = await inst.fetch({ method: 'GET', path: '/' });
      expect(page.status, t.name).toBe(200);
      expect(text(page.body), t.name).toContain('<script src="app.js"></script>');
      expect(page.headers?.['content-security-policy'], t.name).toBe(NO_NETWORK_CSP);
      for (const p of ['/app.js', '/style.css']) expect((await inst.fetch({ method: 'GET', path: p })).status, `${t.name} ${p}`).toBe(200);
      await work[t.name](inst);
      inst.stop();
    }
  });

  it('check names every problem of a manifest', async () => {
    const dir = await makeApp('broken');
    await fs.writeFile(`${dir}/app.json`, JSON.stringify({ manifest: 1, id: 'broken', name: 'B', entry: 'nowhere', icon: 'missing.svg', window: { width: 5 } }));
    const r = await app(`check ${dir}`);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain('app.json: window.width must be a number from 120 to 10000 (got 5)');
    await fs.writeFile(`${dir}/app.json`, JSON.stringify({ manifest: 1, id: 'broken', name: 'B', entry: 'nowhere', icon: 'missing.svg' }));
    const files = await app(`check ${dir}`);
    expect(files.output).toContain('app.json: entry "nowhere" does not exist');
    expect(files.output).toContain('app.json: icon "missing.svg" does not exist');
    expect((await app('check /tmp')).output).toMatch(/\/tmp has no app\.json: it is not an app/);
    await fs.writeFile(`${dir}/app.json`, '{ not json');
    expect((await app(`check ${dir}`)).output).toMatch(/app\.json: it is not valid JSON/);
  });

  it('install copies the folder to ~/Apps, lists it, and keeps its data across an update and a removal', async () => {
    const dir = await makeApp('notes', { version: '1.0.0', icon: 'icon.svg', access: { fs: ['~/Notes'] } }, { 'icon.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>', 'lib/util.js': '1', '.git/HEAD': 'ref' });
    const r = await app(`install ${dir}`);
    expect(r.exitCode, r.output).toBe(0);
    expect(r.output).toMatch(/Installed NOTES \(notes\) in ~\/Apps\/notes: 4 files\./);
    expect(r.output).toMatch(/Open it: app open notes/);
    expect(await fs.exists(`${HOME}/Apps/notes/lib/util.js`)).toBe(true);
    expect(await fs.exists(`${HOME}/Apps/notes/.git`)).toBe(false);
    const reg = await readRegistry(fs);
    expect(reg.apps.notes).toMatchObject({ id: 'notes', name: 'NOTES', version: '1.0.0', dir: `${HOME}/Apps/notes`, source: `dir:${dir}` });
    expect(reg.apps.notes.icon).toMatch(/^data:image\/svg\+xml;base64,/);
    await fs.writeFile(`${HOME}/.local/share/apps/notes/saved.txt`, 'kept');

    const list = await app('list');
    expect(list.output).toMatch(/^ID +NAME +STATE +FROM/);
    expect(list.output).toMatch(/notes +NOTES +- +\/home\/user\/src\/notes/);
    expect((await app('list -l')).output).toMatch(/Files +~\/Notes, and its own data folder/);

    await fs.writeFile(`${dir}/public/new.js`, '2');
    await fs.rm(`${dir}/lib`, { recursive: true });
    const again = await app(`install ${dir}`);
    expect(again.output).toMatch(/Updated NOTES \(notes\)/);
    expect(await fs.exists(`${HOME}/Apps/notes/public/new.js`)).toBe(true);
    expect(await fs.exists(`${HOME}/Apps/notes/lib`)).toBe(false);
    expect(await fs.readFile(`${HOME}/.local/share/apps/notes/saved.txt`, 'utf8')).toBe('kept');

    const rm = await app('remove notes');
    expect(rm.exitCode).toBe(0);
    expect(rm.output).toMatch(/Removed NOTES \(notes\)\. What it stored is still in ~\/\.local\/share\/apps\/notes/);
    expect(await fs.exists(`${HOME}/Apps/notes`)).toBe(false);
    expect(await listInstalled(fs)).toEqual([]);
    expect(await fs.exists(`${HOME}/.local/share/apps/notes/saved.txt`)).toBe(true);
    await app(`install ${dir}`);
    expect((await app('remove notes --data')).output).toBe('Removed NOTES (notes).\n');
    expect(await fs.exists(`${HOME}/.local/share/apps/notes`)).toBe(false);
    expect((await app('remove notes')).output).toMatch(/no app named notes is installed/);
    expect((await app('stop notes')).output).toMatch(/notes is not running/);
    expect((await app('list')).output).toMatch(/No apps are installed/);
  });

  it('install with no argument takes the folder it is in, and refuses what is not an app', async () => {
    const dir = await makeApp('here');
    shell.cwd = dir;
    expect((await app('install')).output).toMatch(/Installed HERE \(here\)/);
    shell.cwd = HOME;
    const no = await app('install /tmp');
    expect(no.exitCode).toBe(1);
    expect(no.output).toMatch(/has no app\.json/);
    expect((await app('install nowhere/at/all')).output).toMatch(/no such folder/);
    const bad = await makeApp('bad');
    await fs.writeFile(`${bad}/app.json`, JSON.stringify({ manifest: 1, id: 'files', name: 'Fake Files', entry: 'public' }));
    const r = await app(`install ${bad}`);
    expect(r.exitCode).toBe(1);
    expect(r.output).toMatch(/app\.json: id "files" is taken by tabcomputer itself/);
    expect(await fs.exists(`${HOME}/Apps/files`)).toBe(false);
    expect((await app(`install ${dir} --guest`)).output).toMatch(/cannot be installed into a guest/);
  });

  it('install installs the manifest\'s toolchain sets, once', async () => {
    const dir = await makeApp('tools', { toolchains: ['c', 'python'], files: ['~/ToolsOut/'] });
    const r = await app(`install ${dir}`);
    expect(r.exitCode, r.output).toBe(0);
    // the stage is a sentence for the person (src/apps/progress.ts); the installer's lines follow
    expect(r.output).toContain('TOOLS needs some programs. They are being downloaded. This happens once.');
    expect(r.output).toContain('unpacking python');
    expect(installed).toEqual(['c', 'python']);
    expect(await fs.exists(`${HOME}/ToolsOut`)).toBe(true);
    // (the instance made for it is gone again: nothing is open)
    expect(instanceOf('tools')).toBeUndefined();
    installed = [];
    await app(`install ${dir}`);
    // marked done in its data folder: not asked for again
    expect(installed).toEqual([]);
    const broken = await makeApp('needy', { toolchains: ['broken'] });
    const f = await app(`install ${broken}`);
    expect(f.exitCode).toBe(1);
    expect(f.output).toMatch(/toolchain install broken failed \(exit 1\); NEEDY needs it/);
  });

  it('an app from GitHub is shown first; Cancel installs nothing, Install installs that commit', async () => {
    const COMMIT = 'a'.repeat(40);
    const manifest = JSON.stringify({ manifest: 1, id: 'remote', name: 'Remote', entry: 'public', backend: { start: 'node server.js' }, access: { commands: ['zip'] } });
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      const body: Record<string, string> = {
        'https://api.github.com/repos/someone/tool/commits/HEAD': COMMIT,
        [`https://raw.githubusercontent.com/someone/tool/${COMMIT}/app.json`]: manifest,
        [`https://api.github.com/repos/someone/tool/git/trees/${COMMIT}?recursive=1`]: JSON.stringify({ tree: [
          { path: 'app.json', type: 'blob', mode: '100644', size: manifest.length }, { path: 'public', type: 'tree', mode: '040000' },
          { path: 'public/index.html', type: 'blob', mode: '100644', size: 10 }, { path: 'server.js', type: 'blob', mode: '100644', size: 5 },
          { path: 'link', type: 'blob', mode: '120000', size: 9 }, { path: '.github/workflows/ci.yml', type: 'blob', mode: '100644', size: 3 },
        ] }),
        [`https://raw.githubusercontent.com/someone/tool/${COMMIT}/public/index.html`]: '<h1>remote</h1>',
        [`https://raw.githubusercontent.com/someone/tool/${COMMIT}/server.js`]: '// srv',
      };
      if (!(url in body)) return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
      return new Response(body[url], { status: 200, headers: { 'content-type': 'text/plain' } });
    }) as typeof fetch;

    let shown: InstallPromptInfo | null = null;
    setInstallConfirm(async (info) => { shown = info; return 'cancel'; });
    const no = await app('install gh:someone/tool');
    expect(no.exitCode).toBe(1);
    expect(no.output).toMatch(/Cancelled: nothing was installed/);
    expect(shown!.from).toBe(`github.com/someone/tool at commit ${COMMIT.slice(0, 10)}`);
    expect(shown!.manifestText).toBe(manifest);
    expect(shown!.manifest.backend?.start).toBe('node server.js');
    expect(await listInstalled(fs)).toEqual([]);
    expect(await fs.exists(`${HOME}/Apps/remote`)).toBe(false);
    // nothing but the commit and the manifest was fetched from GitHub before the answer
    expect(calls.filter((u) => u.startsWith('https://'))).toEqual(['https://api.github.com/repos/someone/tool/commits/HEAD', `https://raw.githubusercontent.com/someone/tool/${COMMIT}/app.json`]);

    setInstallConfirm(async () => 'install');
    const yes = await app('install gh:someone/tool');
    expect(yes.exitCode, yes.output).toBe(0);
    expect(yes.output).toMatch(/Installed Remote \(remote\) in ~\/Apps\/remote: 3 files\./);
    expect((await readRegistry(fs)).apps.remote.source).toBe(`gh:someone/tool@${COMMIT}`);
    expect(await fs.readFile(`${HOME}/Apps/remote/app.json`, 'utf8')).toBe(manifest);
    expect(await fs.exists(`${HOME}/Apps/remote/link`)).toBe(false);
    expect(await fs.exists(`${HOME}/Apps/remote/.github`)).toBe(false);
    expect((await app('install gh:someone/missing')).output).toMatch(/github\.com\/someone\/missing does not exist, or it is private/);
    expect((await app('install gh:../x')).output).toMatch(/a gh: app is gh:<owner>\/<repo>/);
    expect((await app('install http://example.com/app.zip')).output).toMatch(/an app is fetched over https/);
    expect((await app('install https://example.com/page')).output).toMatch(/must be a \.zip, \.tar\.gz or \.tgz archive/);
  });

  it('an app\'s page is served from its entry: nothing outside it, no link out of the app', async () => {
    const dir = await makeApp('pages', {}, { 'public/sub/index.html': 'sub', 'public/data.json': '{"a":1}', 'secret.txt': 'not for the page' });
    await fs.writeFile(`${HOME}/outside.txt`, 'outside');
    await fs.symlink(`${HOME}/outside.txt`, `${dir}/public/leak.txt`);
    await fs.symlink(`${dir}/secret.txt`, `${dir}/public/inside.txt`);
    const inst = instanceFor({ manifest: await loadManifest(fs, dir), dir, source: `dir:${dir}` });
    const get = (path: string, method = 'GET') => inst.fetch({ method, path });
    expect(text((await get('/')).body)).toContain('<title>pages</title>');
    expect(text((await get('/index.html?x=1#frag')).body)).toContain('<title>pages</title>');
    expect(text((await get('/sub/')).body)).toBe('sub');
    expect((await get('/data.json')).headers?.['content-type']).toBe('application/json');
    expect((await get('/data.json')).headers?.['content-security-policy']).toBeUndefined();
    for (const p of ['/../secret.txt', '/%2e%2e/secret.txt', '/..%2fapp.json', '/../app.json', '/sub/../../secret.txt', '/leak.txt', '/nope.js', '//etc/passwd']) {
      expect((await get(p)).status, p).toBe(404);
    }
    // a link that stays inside the app's folder is the app's own business
    expect(text((await get('/inside.txt')).body)).toBe('not for the page');
    // no backend: nothing takes a POST
    expect((await get('/data.json', 'POST')).status).toBe(404);
    expect(text((await get(TAB_JS_PATH)).body)).toBe('// tab.js stand-in');
  });

  it('an app with network access gets no Content-Security-Policy; an .html entry serves its folder', async () => {
    const dir = await makeApp('online', { access: { network: true }, entry: 'public/start.html' }, { 'public/start.html': '<p>start</p>' });
    const inst = instanceFor({ manifest: await loadManifest(fs, dir), dir, source: `dir:${dir}` });
    const page = await inst.fetch({ method: 'GET', path: '/' });
    expect(text(page.body)).toBe('<p>start</p>');
    expect(page.headers?.['content-security-policy']).toBeUndefined();
    expect((await inst.fetch({ method: 'GET', path: '/index.html' })).status).toBe(200);
  });

  it('the backend lives with the app\'s views: started, restarted when it dies, stopped with the last view', async () => {
    // `serve` hands its port to the tab and returns: a stand-in for a server process
    const dir = await makeApp('served', { backend: { start: 'serve api $PORT', port: 4871 } }, { 'api/hello.txt': 'from the backend' });
    const inst = instanceFor({ manifest: await loadManifest(fs, dir), dir, source: `dir:${dir}` });
    const states: string[] = [];
    inst.on((ev) => { if (ev === 'state' && states[states.length - 1] !== inst.state) states.push(inst.state); });
    const a = view(), b = view();
    inst.attach(a);
    expect(await inst.startBackend()).toBe(true);
    expect(inst.state).toBe('running');
    expect(iframeServer.isPortInUse(4871)).toBe(true);
    // a request that is not a file of the page goes to the backend
    expect(text((await inst.fetch({ method: 'GET', path: '/hello.txt' })).body)).toBe('from the backend');
    expect(text((await inst.fetch({ method: 'GET', path: '/' })).body)).toContain('<title>served</title>');
    inst.attach(b);

    // it dies: the supervisor waits, then starts it again
    iframeServer.close(4871);
    getActiveServers().delete(4871);
    expect(inst.state).toBe('backoff');
    expect(await until(() => inst.state === 'running', BACKOFF_MS[0] + 3000)).toBe(true);
    expect(iframeServer.isPortInUse(4871)).toBe(true);
    expect(states).toEqual(['starting', 'running', 'backoff', 'starting', 'running']);
    expect(inst.log.join('\n')).toMatch(/\$ serve api \$PORT/);

    // one view closes: still running. The last one: stopped and forgotten
    inst.detach(a);
    expect(inst.state).toBe('running');
    expect(instanceOf('served')).toBe(inst);
    inst.detach(b);
    expect(inst.state).toBe('stopped');
    expect(iframeServer.isPortInUse(4871)).toBe(false);
    expect(instanceOf('served')).toBeUndefined();
    getActiveServers().clear();
  });

  it('keepAlive keeps the backend after the last view; app stop ends it', async () => {
    const dir = await makeApp('daemon', { backend: { start: 'serve api $PORT', port: 4872, keepAlive: true } }, { 'api/x.txt': 'x' });
    await app(`install ${dir}`);
    const inst = instanceFor({ manifest: await loadManifest(fs, `${HOME}/Apps/daemon`), dir: `${HOME}/Apps/daemon`, source: `dir:${dir}` });
    const v = view();
    inst.attach(v);
    await inst.startBackend();
    inst.detach(v);
    expect(inst.state).toBe('running');
    expect(instanceOf('daemon')).toBe(inst);
    expect((await app('list')).output).toMatch(/daemon +DAEMON +running :4872/);
    const r = await app('stop daemon');
    expect(r.output).toBe('Stopped daemon.\n');
    expect(iframeServer.isPortInUse(4872)).toBe(false);
    expect(stopApp('daemon')).toBe(false);
    getActiveServers().clear();
  });

  it('a lazy backend starts on the first request that needs it; "auto" picks a free port', async () => {
    const dir = await makeApp('lazy', { backend: { start: 'serve api $PORT', lazy: true } }, { 'api/late.txt': 'late' });
    const inst = instanceFor({ manifest: await loadManifest(fs, dir), dir, source: `dir:${dir}` });
    const port = inst.supervisor!.port;
    expect(port).toBeGreaterThanOrEqual(4800);
    inst.attach(view());
    expect(await inst.startBackend()).toBe(true);
    expect(inst.state).toBe('stopped');
    await inst.fetch({ method: 'GET', path: '/' });
    expect(inst.state).toBe('stopped');
    expect(text((await inst.fetch({ method: 'GET', path: '/late.txt' })).body)).toBe('late');
    expect(inst.state).toBe('running');
    expect(iframeServer.isPortInUse(port)).toBe(true);
    // a second app whose "auto" would be the same port gets another
    const other = await makeApp('lazy2', { backend: { start: 'serve api $PORT' } }, { 'api/x.txt': 'x' });
    const inst2 = instanceFor({ manifest: await loadManifest(fs, other), dir: other, source: `dir:${other}` });
    expect(inst2.supervisor!.port).not.toBe(port);
    getActiveServers().clear();
  });

  it('a backend that cannot start answers the page with the reason', async () => {
    const dir = await makeApp('dead', { backend: { start: 'false', port: 4873 }, entry: undefined });
    await fs.writeFile(`${dir}/app.json`, JSON.stringify({ manifest: 1, id: 'dead', name: 'Dead', backend: { start: 'false', port: 4873 } }));
    const inst = instanceFor({ manifest: await loadManifest(fs, dir), dir, source: `dir:${dir}` });
    inst.attach(view());
    void inst.startBackend();
    expect(await until(() => inst.state === 'backoff')).toBe(true);
    expect(inst.supervisor!.error).toMatch(/exited with status 1 before listening on port 4873/);
    inst.supervisor!.stop();
    const res = await Promise.race([inst.fetch({ method: 'GET', path: '/' }), new Promise<null>((r) => setTimeout(() => r(null), 300))]);
    // (a new request starts it again; stop it so the test ends)
    inst.close();
    expect(res === null || res.status === 502).toBe(true);
  });

  it('prepare: a missing file the manifest expects stops the app, naming it', async () => {
    const dir = await makeApp('needs', { files: ['data/seed.csv', '~/NeedsOut/'] });
    const inst = instanceFor({ manifest: await loadManifest(fs, dir), dir, source: `dir:${dir}` });
    await expect(inst.prepare()).rejects.toThrow(/NEEDS expects data\/seed\.csv, which is not there/);
    expect(await fs.exists(`${HOME}/NeedsOut`)).toBe(true);
    await fs.mkdir(`${dir}/data`, { recursive: true });
    await fs.writeFile(`${dir}/data/seed.csv`, 'a,b');
    await expect(inst.prepare()).resolves.toBeUndefined();
  });

  it('two folders with one id cannot be open at once', async () => {
    const a = await makeApp('same');
    const m = await loadManifest(fs, a);
    instanceFor({ manifest: m, dir: a, source: `dir:${a}` });
    expect(() => instanceFor({ manifest: m, dir: '/somewhere/else', source: 'dev:x' })).toThrow(/same is already open from/);
  });

  it('the registry survives a file that is not a registry', async () => {
    await fs.mkdir('/var/lib/tabcomputer', { recursive: true });
    await fs.writeFile(REGISTRY_FILE, 'not json');
    expect(await listInstalled(fs)).toEqual([]);
    await fs.writeFile(REGISTRY_FILE, JSON.stringify({ apps: { x: { id: 'y', dir: '/a' }, ok: { id: 'ok', dir: '/b', name: 'Ok', installedAt: 1 } } }));
    expect((await listInstalled(fs)).map((a) => a.id)).toEqual(['ok']);
  });
});
