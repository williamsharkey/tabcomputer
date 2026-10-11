/**
 * Bun.Transpiler for claude --vm, as Claude Code uses it: a mod's hooks module
 * written in TypeScript or JSX, `new Bun.Transpiler({ loader }).transformSync(code)`,
 * with the classic JSX pragmas (`@jsx h`, `@jsxFrag Fragment`) in front for
 * .jsx/.tsx. The output stays an ES module (Claude Code parses it again).
 *
 * As a kernel guest (the default), the page's esbuild compiles it while the
 * guest waits (SYS_shiro_transform). Node in the page can't wait for it, so
 * there node-compat's own synchronous transforms do the work (module-transform.ts,
 * the type stripping and JSX it uses for .ts and .tsx files, which miss some
 * syntax), with the JSX factory taken from the pragmas instead of React.
 */
import { transformJSX, transformTS } from '../../commands/jseval/module-transform';

type Loader = 'js' | 'jsx' | 'ts' | 'tsx';

const REACT_PRELUDE = 'var __jsx = require("react").createElement, __jsxFrag = require("react").Fragment;\n';

function pragma(code: string, name: string): string | undefined {
  return new RegExp(`@${name}\\s+([A-Za-z_$][\\w$.]*)`).exec(code)?.[1];
}

export function transpile(code: string, loader: Loader): string {
  let out = code;
  if (loader === 'ts' || loader === 'tsx') out = transformTS(out);
  if (loader === 'jsx' || loader === 'tsx') {
    const jsx = transformJSX(out);
    if (jsx !== out && jsx.startsWith(REACT_PRELUDE)) {
      const h = pragma(code, 'jsx') ?? 'React.createElement';
      const frag = pragma(code, 'jsxFrag') ?? 'React.Fragment';
      const root = (n: string) => n.split('.')[0];
      // (a module without a Fragment of its own still loads)
      out = `var __jsx = function () { return ${h}.apply(this, arguments); }, __jsxFrag = typeof ${root(frag)} === 'undefined' ? undefined : ${frag};\n`
        + jsx.slice(REACT_PRELUDE.length);
    } else out = jsx;
  }
  return out;
}

/** Compiles with the page's esbuild, synchronously (node as a kernel guest: SYS_shiro_transform) */
export type SyncTransform = (code: string, loader: Loader) => string;

export function transpilerClass(esbuild?: SyncTransform) {
  return class Transpiler {
    readonly #loader: Loader;
    constructor(opts: { loader?: Loader } = {}) {
      this.#loader = opts.loader ?? 'js';
    }
    transformSync(code: string | ArrayBufferView, loader?: Loader): string {
      const text = typeof code === 'string' ? code : new TextDecoder().decode(code);
      const l = loader ?? this.#loader;
      if (l === 'js') return text;
      return esbuild ? esbuild(text, l) : transpile(text, l);
    }
    async transform(code: string | ArrayBufferView, loader?: Loader): Promise<string> {
      return this.transformSync(code, loader);
    }
  };
}
