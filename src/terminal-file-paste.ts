/**
 * Images pasted (Cmd+V, the browser's paste event) or dropped on a terminal
 * arrive as a path: each image is written to /tmp (paste-<time>.png, its
 * own type kept) and the paths are pasted, bracketed when the program asked
 * for bracketed paste, as if the user had pasted a file's path. xterm.js
 * pastes only text/plain, so an image alone used to paste nothing.
 *
 * This is for every program, not only Claude Code: Claude Code attaches a
 * pasted absolute path to a .png/.jpg/.gif/.webp as [Image #N], the shell
 * prompt and editors get a path they can use, as a real terminal gives when
 * a file is dropped on it. A paste that has text (anything but the copied
 * files' own names, which is what a copy in Finder adds) stays text.
 *
 * Claude Code's own Ctrl+V reads the clipboard itself (xclip, src/commands/pbcopy.ts).
 */
import type { FileSystem } from './filesystem';

/** An image to save: the browser's File, or bytes read from navigator.clipboard */
export interface PastedImage {
  type: string;
  name?: string;
  bytes(): Promise<Uint8Array>;
}

const EXT: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
  'image/bmp': 'bmp', 'image/svg+xml': 'svg', 'image/avif': 'avif', 'image/heic': 'heic', 'image/tiff': 'tiff',
};

const isImage = (f: { type: string; name?: string }) => /^image\//i.test(f.type) || /\.(png|jpe?g|gif|webp|bmp|svg|avif|heic|tiff?)$/i.test(f.name ?? '');

const fromFile = (f: File): PastedImage => ({ type: f.type, name: f.name, bytes: async () => new Uint8Array(await f.arrayBuffer()) });

/**
 * The images a paste or drop carries when it should become paths, or [] to
 * leave it to xterm: a paste with real text stays text.
 */
export function imagesOf(data: DataTransfer | null | undefined, kind: 'paste' | 'drop'): PastedImage[] {
  if (!data) return [];
  const files: File[] = [];
  for (const f of Array.from(data.files ?? [])) if (isImage(f)) files.push(f);
  if (!files.length) {
    // (some paste events list the image only as an item)
    for (const it of Array.from(data.items ?? [])) {
      if (it.kind !== 'file' || !/^image\//i.test(it.type)) continue;
      const f = it.getAsFile();
      if (f) files.push(f);
    }
  }
  if (!files.length) return [];
  if (kind === 'paste') {
    const text = (data.getData('text/plain') ?? '').trim();
    // A file copied in Finder pastes its name as text beside the file
    const names = new Set(files.map((f) => f.name));
    if (text && !text.split(/\r?\n/).every((l) => names.has(l.trim()))) return [];
  }
  return files.map(fromFile);
}

const pad = (n: number) => String(n).padStart(2, '0');
function stamp(d = new Date()): string {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/** A name safe to paste unquoted: letters, digits, dot, dash, underscore */
const safeName = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._-]+/, '').slice(0, 80);

/**
 * Write the images to /tmp: `paste-<time>.<ext>` (a dropped file keeps its
 * name after the time). Returns their paths, in order.
 */
export async function saveImages(fs: FileSystem, images: PastedImage[], kind: 'paste' | 'drop', dir = '/tmp'): Promise<string[]> {
  await fs.mkdir(dir, { recursive: true }).catch(() => { /* there */ });
  const base = `${kind}-${stamp()}`;
  const paths: string[] = [];
  for (const img of images) {
    const ext = EXT[img.type.toLowerCase()] ?? (/\.([A-Za-z0-9]{1,5})$/.exec(img.name ?? '')?.[1]?.toLowerCase() || 'img');
    const named = kind === 'drop' && img.name ? safeName(img.name.replace(/\.[^.]*$/, '')) : '';
    const stem = named ? `${base}-${named}` : base;
    let path = `${dir}/${stem}.${ext}`;
    for (let n = 2; paths.includes(path) || await fs.exists(path); n++) path = `${dir}/${stem}-${n}.${ext}`;
    await fs.writeFile(path, await img.bytes());
    paths.push(path);
  }
  return paths;
}

export interface FilePasteTarget {
  fs: FileSystem;
  /** Paste text as the user's paste (xterm's term.paste: bracketed when the program asked) */
  paste(text: string): void;
  /** Called for a drop before its images are saved; true when it took the drop (a seed GIF) */
  claimDrop?: (files: File[]) => Promise<boolean>;
}

/** Save the images and paste their paths, space-separated */
export async function pasteImagePaths(t: FilePasteTarget, images: PastedImage[], kind: 'paste' | 'drop'): Promise<string[]> {
  if (!images.length) return [];
  const paths = await saveImages(t.fs, images, kind);
  if (paths.length) t.paste(paths.join(' '));
  return paths;
}

/**
 * Paste and drop handling on a terminal's container: a capture listener, so
 * it runs before xterm's own paste handler (on its textarea), which would
 * paste the empty text.
 */
export function installFilePaste(container: HTMLElement, target: () => FilePasteTarget, element?: () => HTMLElement | undefined): () => void {
  // (an event inside another terminal's xterm nested in this container is that terminal's)
  const elsewhere = (e: Event) => {
    const xt = (e.target as Element | null)?.closest?.('.xterm');
    const mine = element?.();
    return !!(xt && mine && xt !== mine);
  };
  const onPaste = (e: Event) => {
    if (elsewhere(e)) return;
    const images = imagesOf((e as ClipboardEvent).clipboardData, 'paste');
    if (!images.length) return; // text: xterm pastes it
    e.preventDefault();
    e.stopImmediatePropagation();
    void pasteImagePaths(target(), images, 'paste').catch((err) => console.warn('[paste] could not save the image:', err));
  };
  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
  const outline = (on: boolean) => {
    container.style.outline = on ? '2px solid #51cf66' : '';
    container.style.outlineOffset = on ? '-2px' : '';
  };
  const onDragOver = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); // (or the browser opens the file in place of the page)
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    outline(true);
  };
  const onDragLeave = () => outline(false);
  const onDrop = (e: DragEvent) => {
    if (!hasFiles(e) || elsewhere(e)) return;
    e.preventDefault();
    e.stopPropagation();
    outline(false);
    const files = Array.from(e.dataTransfer?.files ?? []);
    const images = imagesOf(e.dataTransfer, 'drop');
    const t = target();
    void (async () => {
      if (t.claimDrop && await t.claimDrop(files).catch(() => false)) return;
      await pasteImagePaths(t, images, 'drop');
    })().catch((err) => console.warn('[drop] could not save the image:', err));
  };
  container.addEventListener('paste', onPaste, true);
  container.addEventListener('dragover', onDragOver);
  container.addEventListener('dragleave', onDragLeave);
  container.addEventListener('drop', onDrop);
  return () => {
    container.removeEventListener('paste', onPaste, true);
    container.removeEventListener('dragover', onDragOver);
    container.removeEventListener('dragleave', onDragLeave);
    container.removeEventListener('drop', onDrop);
  };
}
