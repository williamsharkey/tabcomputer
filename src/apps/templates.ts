/**
 * `app new` (docs/APPS.md "Templates"): the starting points an app is
 * scaffolded from. Each is a small working app in `apps/templates/<name>/`
 * of the repository, bundled here as text; a new app is that folder with its
 * id and name filled in. They need no toolchain: each runs as created.
 *
 * The Code app's "New app" and a Studio would list `TEMPLATES` and call
 * `scaffold` the same way.
 */
import { APP_ID, RESERVED_IDS, parseManifest } from './manifest';
import { AppError, type RegistryFs } from './registry';

export interface Template { name: string; title: string; description: string }

/** The templates `app new --template` takes (`script` is what `--from` uses) */
export const TEMPLATES: Template[] = [
  { name: 'file-tool', title: 'File in, file out', description: 'drop files, run a program on each, download the results' },
  { name: 'form', title: 'A form over a command', description: 'fields become a command\'s arguments; its output streams to the page' },
  { name: 'table', title: 'A table over a file', description: 'a CSV file shown as an editable table, saved on every edit' },
  { name: 'script', title: 'A script with a Run button', description: 'what `app new NAME --from script.sh` makes' },
];
export const DEFAULT_TEMPLATE = 'file-tool';

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

/** A name someone typed, as an app id: "My Notes!" → "my-notes"; '' when nothing usable is left */
export function idFromName(name: string): string {
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^[^a-z]+|-+$/g, '').slice(0, 32).replace(/-+$/, '');
  return APP_ID.test(id) && !RESERVED_IDS.has(id) ? id : '';
}

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
      const j = JSON.parse(text) as Record<string, unknown>;
      j.id = id;
      j.name = name;
      out = JSON.stringify(j, null, 2) + '\n';
      parseManifest(out);
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
