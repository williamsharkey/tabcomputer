import { createAssertModule } from './assert';
import { inspect, inspectCustom, styles, colors, formatWithOptions } from '../inspect';

let deepStrict: ((a: any, b: any) => boolean) | undefined;

/** `getProcess`: the script's process (parseArgs reads its argv) */
export function createUtilModule(getProcess?: () => { argv: string[]; execArgv?: string[] } | undefined): any {
  const _inspect: any = (obj: any, opts?: any, depth?: number, colors?: boolean): string => inspect(obj, opts, depth, colors);
  _inspect.custom = inspectCustom;
  _inspect.styles = styles;
  _inspect.colors = colors;
  _inspect.defaultOptions = { depth: 2, colors: false, compact: 3, breakLength: 80, maxArrayLength: 100, maxStringLength: 10000 };
  const _format = (...args: any[]): string => formatWithOptions({}, args);
  return {
    promisify: (fn: any) => {
      // Check for custom promisify implementation (e.g., child_process.exec)
      const customSym = Symbol.for('nodejs.util.promisify.custom');
      if (fn[customSym]) return fn[customSym];
      return (...args: any[]) => new Promise((resolve, reject) => {
        fn(...args, (err: any, result: any) => err ? reject(err) : resolve(result));
      });
    },
    callbackify: (fn: Function) => (...args: any[]) => {
      const cb = args.pop();
      fn(...args).then((r: any) => cb(null, r)).catch((e: any) => cb(e));
    },
    inspect: _inspect,
    format: _format,
    formatWithOptions: (opts: any, ...args: any[]) => formatWithOptions(opts ?? {}, args),
    types: {
      isDate: (v: any) => v instanceof Date,
      isRegExp: (v: any) => v instanceof RegExp,
      isCryptoKey: (key: any) => typeof CryptoKey !== 'undefined' && key instanceof CryptoKey,
      isTypedArray: (v: any) => ArrayBuffer.isView(v) && !(v instanceof DataView),
      isNativeError: (v: any) => v instanceof Error,
      isPromise: (v: any) => v instanceof Promise,
      isProxy: (_v: any) => false,
      isAnyArrayBuffer: (v: any) => v instanceof ArrayBuffer || v instanceof SharedArrayBuffer,
      isArrayBuffer: (v: any) => v instanceof ArrayBuffer,
      isSharedArrayBuffer: (v: any) => typeof SharedArrayBuffer !== 'undefined' && v instanceof SharedArrayBuffer,
      isDataView: (v: any) => v instanceof DataView,
      isMap: (v: any) => v instanceof Map,
      isSet: (v: any) => v instanceof Set,
      isWeakMap: (v: any) => v instanceof WeakMap,
      isWeakSet: (v: any) => v instanceof WeakSet,
      isUint8Array: (v: any) => v instanceof Uint8Array,
      isUint16Array: (v: any) => v instanceof Uint16Array,
      isUint32Array: (v: any) => v instanceof Uint32Array,
      isInt8Array: (v: any) => v instanceof Int8Array,
      isInt16Array: (v: any) => v instanceof Int16Array,
      isInt32Array: (v: any) => v instanceof Int32Array,
      isFloat32Array: (v: any) => v instanceof Float32Array,
      isFloat64Array: (v: any) => v instanceof Float64Array,
      isBigInt64Array: (v: any) => typeof BigInt64Array !== 'undefined' && v instanceof BigInt64Array,
      isBigUint64Array: (v: any) => typeof BigUint64Array !== 'undefined' && v instanceof BigUint64Array,
      isGeneratorFunction: (v: any) => v?.constructor?.name === 'GeneratorFunction',
      isAsyncFunction: (v: any) => v?.constructor?.name === 'AsyncFunction',
      isStringObject: (v: any) => typeof v === 'object' && v instanceof String,
      isNumberObject: (v: any) => typeof v === 'object' && v instanceof Number,
      isBooleanObject: (v: any) => typeof v === 'object' && v instanceof Boolean,
      isBigIntObject: (v: any) => typeof v === 'object' && v !== null && Object.prototype.toString.call(v) === '[object BigInt]',
      isSymbolObject: (v: any) => typeof v === 'object' && v !== null && Object.prototype.toString.call(v) === '[object Symbol]',
      isBoxedPrimitive: (v: any) => typeof v === 'object' && v !== null && (v instanceof String || v instanceof Number || v instanceof Boolean
        || ['[object BigInt]', '[object Symbol]'].includes(Object.prototype.toString.call(v))),
      isArrayBufferView: (v: any) => ArrayBuffer.isView(v),
      isArgumentsObject: (v: any) => Object.prototype.toString.call(v) === '[object Arguments]',
      isGeneratorObject: (v: any) => Object.prototype.toString.call(v) === '[object Generator]',
      isMapIterator: (v: any) => Object.prototype.toString.call(v) === '[object Map Iterator]',
      isSetIterator: (v: any) => Object.prototype.toString.call(v) === '[object Set Iterator]',
      isModuleNamespaceObject: (v: any) => Object.prototype.toString.call(v) === '[object Module]',
      isWeakRef: (v: any) => typeof WeakRef !== 'undefined' && v instanceof WeakRef,
      isExternal: (_v: any) => false,
      isKeyObject: (_v: any) => false,
      isUint8ClampedArray: (v: any) => v instanceof Uint8ClampedArray,
    },
    deprecate: (fn: Function, _msg: string) => fn, // Return function unchanged, skip warning
    inherits: (ctor: any, superCtor: any) => {
      if (superCtor && superCtor.prototype) {
        ctor.super_ = superCtor;
        ctor.prototype = Object.create(superCtor.prototype, {
          constructor: { value: ctor, writable: true, configurable: true }
        });
      }
    },
    isArray: Array.isArray,
    isBuffer: (obj: any) => obj instanceof Uint8Array,
    isString: (obj: any) => typeof obj === 'string',
    isNumber: (obj: any) => typeof obj === 'number',
    isBoolean: (obj: any) => typeof obj === 'boolean',
    isObject: (obj: any) => obj !== null && typeof obj === 'object',
    isFunction: (obj: any) => typeof obj === 'function',
    isNull: (obj: any) => obj === null,
    isUndefined: (obj: any) => obj === undefined,
    isNullOrUndefined: (obj: any) => obj == null,
    isPrimitive: (obj: any) => obj === null || (typeof obj !== 'object' && typeof obj !== 'function'),
    isDeepStrictEqual: (a: any, b: any) => (deepStrict ??= createAssertModule().isDeepStrictEqual)(a, b),
    debuglog: (_section: string) => Object.assign((..._args: any[]) => {}, { enabled: false }),
    debug: (_section: string) => Object.assign((..._args: any[]) => {}, { enabled: false }),
    getSystemErrorName: (err: number) => `ERRNO_${err}`,
    toUSVString: (s: string) => s,
    stripVTControlCharacters: (s: string) => s.replace(/\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?\x07/g, ''),
    styleText: (_style: string, text: string) => text,
    TextEncoder,
    TextDecoder,
    parseArgs: (config: any = {}) => parseArgs(config, getProcess?.()),
  };
}

const parseArgsError = (code: string, message: string) => Object.assign(new TypeError(message), { code });

/**
 * util.parseArgs as node's (lib/internal/util/parse_args): args from process.argv by
 * default, short groups (-abc) and attached values (-n3, --top=3), defaults applied after,
 * absent booleans left out, tokens only when asked for, node's errors in strict mode.
 */
function parseArgs(config: any, proc?: { argv: string[]; execArgv?: string[] }): any {
  const execArgv = proc?.execArgv ?? [];
  const evalMode = ['-e', '--eval', '-p', '--print'].some((f) => execArgv.includes(f));
  const args: string[] = config.args ?? (proc ? proc.argv.slice(evalMode ? 1 : 2) : []);
  const options: Record<string, any> = config.options ?? {};
  const strict = config.strict ?? true;
  const allowPositionals = config.allowPositionals ?? !strict;
  const allowNegative = config.allowNegative ?? false;
  const own = (name: string) => (Object.prototype.hasOwnProperty.call(options, name) ? options[name] : undefined);
  const longFor = (short: string) => Object.keys(options).find((k) => options[k]?.short === short) ?? short;
  const values: Record<string, any> = Object.create(null);
  const positionals: string[] = [];
  const tokens: any[] = [];

  const label = (name: string) => { const sh = own(name)?.short; return sh ? `-${sh}, --${name}` : `--${name}`; };
  const store = (name: string, value: any) => {
    if (name === '__proto__') return;
    const v = value ?? true;
    if (own(name)?.multiple) (values[name] ??= []).push(v);
    else values[name] = v;
  };

  // The tokens, as node makes them (its index bookkeeping included: a short group's
  // options share the group's index, a value taken from the next arg advances it)
  const rest = [...args];
  let index = -1;
  let groupCount = 0;
  while (rest.length) {
    const arg = rest.shift()!;
    const next = rest[0];
    if (groupCount > 0) groupCount--; else index++;
    if (arg === '--') {
      tokens.push({ kind: 'option-terminator', index });
      for (const p of rest) tokens.push({ kind: 'positional', index: ++index, value: p });
      break;
    }
    const short = arg.length >= 2 && arg[0] === '-' && arg[1] !== '-';
    if (short && arg.length === 2) {
      const name = longFor(arg[1]);
      let value: string | undefined, inlineValue: boolean | undefined;
      if (own(name)?.type === 'string' && next !== undefined) { value = rest.shift(); inlineValue = false; }
      tokens.push({ kind: 'option', name, rawName: arg, index, value, inlineValue });
      if (value !== undefined) index++;
      continue;
    }
    // -abc is -a -b -c; a string option in the middle takes the rest (-abfFILE: -a -b -fFILE)
    if (short && own(longFor(arg[1]))?.type !== 'string') {
      const expanded: string[] = [];
      for (let k = 1; k < arg.length; k++) {
        if (own(longFor(arg[k]))?.type !== 'string' || k === arg.length - 1) expanded.push(`-${arg[k]}`);
        else { expanded.push(`-${arg.slice(k)}`); break; }
      }
      rest.unshift(...expanded);
      groupCount = expanded.length;
      continue;
    }
    // -fVALUE (f a string option)
    if (short) {
      tokens.push({ kind: 'option', name: longFor(arg[1]), rawName: arg.slice(0, 2), index, value: arg.slice(2), inlineValue: true });
      continue;
    }
    if (arg.startsWith('--') && arg.length > 2) {
      const eq = arg.indexOf('=');
      if (eq > 0) {
        tokens.push({ kind: 'option', name: arg.slice(2, eq), rawName: arg.slice(0, eq), index, value: arg.slice(eq + 1), inlineValue: true });
        continue;
      }
      const name = arg.slice(2);
      let value: string | undefined, inlineValue: boolean | undefined;
      if (own(name)?.type === 'string' && next !== undefined) { value = rest.shift(); inlineValue = false; }
      tokens.push({ kind: 'option', name, rawName: arg, index, value, inlineValue });
      if (value !== undefined) index++;
      continue;
    }
    tokens.push({ kind: 'positional', index, value: arg });
  }

  for (const t of tokens) {
    if (t.kind === 'option') {
      let name = t.name;
      let negated = false;
      if (allowNegative && name.startsWith('no-') && own(name.slice(3))?.type === 'boolean' && !own(name)) { name = name.slice(3); negated = true; }
      if (strict) {
        const opt = own(name);
        if (!opt) throw parseArgsError('ERR_PARSE_ARGS_UNKNOWN_OPTION', `Unknown option '${t.rawName}'` + (allowPositionals ? `. To specify a positional argument starting with a '-', place it at the end of the command after '--', as in '-- ${JSON.stringify(t.rawName)}` : ''));
        // (a value taken from the next argument that looks like an option)
        if (opt.type === 'string' && t.inlineValue === false && typeof t.value === 'string' && t.value.startsWith('-')) {
          const example = opt.short ? `'--${name}=-XYZ' or '-${opt.short}-XYZ'` : `'--${name}=-XYZ'`;
          throw parseArgsError('ERR_PARSE_ARGS_INVALID_OPTION_VALUE', `Option '${t.rawName}' argument is ambiguous.\nDid you forget to specify the option argument for '${t.rawName}'?\nTo specify an option argument starting with a dash use ${example}.`);
        }
        if (opt.type === 'string' && typeof t.value !== 'string') throw parseArgsError('ERR_PARSE_ARGS_INVALID_OPTION_VALUE', `Option '${label(name)} <value>' argument missing`);
        if (opt.type === 'boolean' && t.value !== undefined) throw parseArgsError('ERR_PARSE_ARGS_INVALID_OPTION_VALUE', `Option '${label(name)}' does not take an argument`);
      }
      store(name, negated ? false : own(name)?.type === 'boolean' && t.value === undefined ? true : t.value);
    } else if (t.kind === 'positional') {
      if (!allowPositionals) throw parseArgsError('ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL', `Unexpected argument '${t.value}'. This command does not take positional arguments`);
      positionals.push(t.value);
    }
  }
  for (const [name, opt] of Object.entries(options)) {
    if (opt?.default !== undefined && values[name] === undefined) values[name] = opt.default;
  }
  return config.tokens ? { values, positionals, tokens } : { values, positionals };
}
