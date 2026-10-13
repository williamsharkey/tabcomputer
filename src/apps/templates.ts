/**
 * `app new` (docs/APPS.md "Templates"): the starting points an app is
 * scaffolded from. Each is a small working app in `apps/templates/<name>/`
 * of the repository, bundled here as text; a new app is that folder with its
 * name filled in. `files`, `form` and `table` are one file, `app.json`:
 * tabcomputer supplies their page (declare.ts). `page` is an app with a page
 * of its own. They need no toolchain: each runs as created.
 *
 * The Code app's "New app" and a Studio would list `TEMPLATES` and call
 * `scaffold` the same way.
 */
import { APP_ID, RESERVED_IDS, idFromName, parseManifest } from './manifest';
import { AppError, type RegistryFs } from './registry';

export interface Template { name: string; title: string; description: string }

/** The templates `app new --template` takes (`page` is what `--page` uses, `script` what `--from` uses) */
export const TEMPLATES: Template[] = [
  { name: 'files', title: 'A command on each file', description: 'one file, app.json: give it files, a command runs on each, download the results' },
  { name: 'form', title: 'A form over a command', description: 'one file, app.json: labelled fields fill a command; its output shows as it is written' },
  { name: 'table', title: 'A table in a file', description: 'one file, app.json: a CSV or SQLite file as a table to add to, edit, sort and filter' },
  { name: 'page', title: 'An app with its own page', description: 'five files: app.json, an icon, and a page (HTML, CSS, JavaScript) that uses tab.js' },
  { name: 'script', title: 'A script with a Run button', description: 'what `app new NAME --from script.sh` makes' },
];
export const DEFAULT_TEMPLATE = 'files';

const RAW = import.meta.glob('../../apps/templates/**/*', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

/** A template's files: relative path → text */
export function templateFiles(name: string): Map<string, string> {
  const prefix = `../../apps/templates/${name}/`;
  const out = new Map<string, string>();
  for (const [path, text] of Object.entries(RAW)) if (path.startsWith(prefix)) out.set(path.slice(prefix.length), text);
  return out;
}

/** "my-notes" → "My notes" */
export const titleFromId = (id: string): string => {
  const s = id.replace(/-+/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
};

export { idFromName };

export interface ScaffoldOptions {
  template?: string;
  /** The display name (default: from the id) */
  name?: string;
  /** `--from`: the script the app wraps (its text) */
  script?: string;
}

/**
 * Write a new app into the folder `dir` (which must not exist, or be empty).
 * Returns the files written.
 */
export async function scaffold(fs: RegistryFs, dir: string, id: string, o: ScaffoldOptions = {}): Promise<string[]> {
  if (!APP_ID.test(id)) throw new AppError(`an app's id is 2 to 32 of a-z, 0-9 and -, starting with a letter (got ${JSON.stringify(id)})`);
  if (RESERVED_IDS.has(id)) throw new AppError(`the id ${id} is taken by tabcomputer itself`);
  const template = o.script !== undefined ? 'script' : o.template ?? DEFAULT_TEMPLATE;
  const files = templateFiles(template);
  if (!files.size) throw new AppError(`no template named ${template} (templates: ${TEMPLATES.map((t) => t.name).join(', ')})`);
  if (await fs.exists(dir)) {
    const st = await fs.stat(dir);
    if (!st.isDirectory() || (await fs.readdir(dir)).length) throw new AppError(`${dir} already exists and is not empty`);
  }
  const name = (o.name ?? titleFromId(id)).replace(/[<>]/g, '').slice(0, 60) || titleFromId(id);
  const written: string[] = [];
  for (const [rel, text] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    let out = text;
    if (rel === 'app.json') {
      const folder = dir.slice(dir.lastIndexOf('/') + 1);
      if (files.size === 1) {
        // One file, kept as it was written by hand: only the name changes, and the folder's name is the id
        out = text.replace(/"name": "[^"]*"/, () => `${folder === id ? '' : `"id": ${JSON.stringify(id)},\n  `}"name": ${JSON.stringify(name)}`);
      } else {
        const j = JSON.parse(text) as Record<string, unknown>;
        j.id = id;
        j.name = name;
        out = JSON.stringify(j, null, 2) + '\n';
      }
      parseManifest(out, { id: folder });
    } else if (rel.endsWith('.html')) {
      out = text.replace(/\{\{name\}\}/g, name.replace(/[&<>]/g, (c) => `&#${c.charCodeAt(0)};`));
    } else if (rel === 'run.sh' && o.script !== undefined) out = o.script.endsWith('\n') ? o.script : o.script + '\n';
    const p = `${dir}/${rel}`;
    await fs.mkdir(p.slice(0, p.lastIndexOf('/')), { recursive: true });
    await fs.writeFile(p, out);
    if (rel.endsWith('.sh')) await fs.chmod?.(p, 0o755).catch(() => {});
    written.push(rel);
  }
  return written;
}
