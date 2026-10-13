/** The browser Worker for Pyodide as a kernel guest (host.ts creates it) */
import { pyodideGuestMain } from './guest';

const post = self.postMessage.bind(self);
pyodideGuestMain((h) => { self.addEventListener('message', (e: MessageEvent) => h(e.data)); }, (m) => post(m));
