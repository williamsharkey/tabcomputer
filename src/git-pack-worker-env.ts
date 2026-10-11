// Node's Buffer as a global for isomorphic-git in the pack worker (imported first: before isomorphic-git runs)
import { Buffer } from 'buffer';
(globalThis as { Buffer?: unknown }).Buffer ??= Buffer;
