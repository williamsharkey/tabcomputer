/**
 * An exported app dropped on the page (docs/APPS.md "Export and import"): a
 * file whose name ends in `.app.zip`, dropped anywhere on the desktop, is
 * imported as `app import FILE` does, and the app opens. Any other file is
 * left to whatever else takes drops (a terminal pastes its path).
 *
 * Small on purpose: the page loads this at boot, and the toolkit only when
 * such a file is dropped.
 */

/** The ending `app export` gives its files (export.ts `EXPORT_SUFFIX`) */
const SUFFIX = '.app.zip';

export interface AppDropDeps {
  /** Import one file; resolves to the app's id, or null when the person said no */
  import(bytes: Uint8Array, name: string): Promise<string | null>;
  open(id: string): Promise<void>;
  /** One line for the person: why a file was not imported */
  report(message: string): void;
}

/** Take exported apps dropped on the page from now on. Returns stop. */
export function initAppDrop(deps: AppDropDeps, target: Pick<Window, 'addEventListener' | 'removeEventListener'> = window): () => void {
  const files = (e: DragEvent): File[] => [...(e.dataTransfer?.files ?? [])].filter((f) => f.name.toLowerCase().endsWith(SUFFIX));
  // (a drop is only delivered where the drag was accepted: a file may be dropped anywhere on the page)
  const onOver = (e: Event) => { if ([...((e as DragEvent).dataTransfer?.types ?? [])].includes('Files')) e.preventDefault(); };
  const onDrop = (e: Event) => {
    const dropped = files(e as DragEvent);
    if (!dropped.length) return;
    e.preventDefault();
    e.stopPropagation();
    void (async () => {
      for (const f of dropped) {
        try {
          const id = await deps.import(new Uint8Array(await f.arrayBuffer()), f.name);
          if (id) await deps.open(id);
        } catch (err) { deps.report(`${f.name} was not imported: ${(err as Error)?.message ?? err}`); }
      }
    })();
  };
  target.addEventListener('dragover', onOver);
  // Before a terminal under the pointer takes the file as a path to paste
  target.addEventListener('drop', onDrop, true);
  return () => { target.removeEventListener('dragover', onOver); target.removeEventListener('drop', onDrop, true); };
}
