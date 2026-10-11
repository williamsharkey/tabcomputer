/**
 * util.parseArgs, as node 22 does it (lib/internal/util/parse_args): the
 * arguments become tokens, strict mode checks each one, then values are
 * stored and defaults filled in. Without `args` it parses the process's
 * own (getMainArgs). Absent options stay absent (no `false` for booleans),
 * and `tokens` is returned only when asked for (tabcomputer#67).
 */

type OptionType = 'string' | 'boolean';
interface OptionConfig { type: OptionType; short?: string; multiple?: boolean; default?: unknown }
type Token =
  | { kind: 'option'; name: string; rawName: string; index: number; value: string | undefined; inlineValue: boolean | undefined }
  | { kind: 'positional'; index: number; value: string }
  | { kind: 'option-terminator'; index: number };

function nodeError(Ctor: ErrorConstructor, code: string, message: string): Error {
  const e = new Ctor(message) as Error & { code: string };
  e.code = code;
  // node's errors name their code: "TypeError [ERR_PARSE_ARGS_UNKNOWN_OPTION]: ..."
  Object.defineProperty(e, 'toString', { value() { return `${Ctor.name} [${code}]: ${message}`; }, enumerable: false });
  return e;
}

const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const describe = (v: unknown) => typeof v === 'string' ? `'${v}'` : typeof v === 'object' && v !== null ? (Array.isArray(v) ? 'an instance of Array' : 'an instance of Object') : `type ${typeof v} (${String(v)})`;

function invalidType(name: string, expected: string, v: unknown): Error {
  return nodeError(TypeError, 'ERR_INVALID_ARG_TYPE', `The "${name}" property must be ${expected}. Received ${describe(v)}`);
}

export function parseArgs(config: any = {}, getMainArgs: () => string[] = () => []): { values: Record<string, unknown>; positionals: string[]; tokens?: Token[] } {
  if (config === null || typeof config !== 'object') throw invalidType('config', 'of type object', config);
  const args: string[] = config.args ?? getMainArgs();
  const strict: boolean = config.strict ?? true;
  const allowPositionals: boolean = config.allowPositionals ?? !strict;
  const returnTokens: boolean = config.tokens ?? false;
  const allowNegative: boolean = config.allowNegative ?? false;
  const options: Record<string, OptionConfig> = config.options ?? { __proto__: null };

  if (!Array.isArray(args)) throw invalidType('args', 'an instance of Array', args);
  for (const [k, v] of [['strict', strict], ['allowPositionals', allowPositionals], ['tokens', returnTokens], ['allowNegative', allowNegative]] as const) {
    if (typeof v !== 'boolean') throw invalidType(k, 'of type boolean', v);
  }
  if (options === null || typeof options !== 'object') throw invalidType('options', 'of type object', options);
  for (const [long, opt] of Object.entries(options)) {
    if (opt === null || typeof opt !== 'object') throw invalidType(`options.${long}`, 'of type object', opt);
    if (opt.type !== 'string' && opt.type !== 'boolean') {
      throw nodeError(TypeError, 'ERR_INVALID_ARG_VALUE', `The property 'options.${long}.type' must be one of: 'string', 'boolean'. Received ${describe(opt.type)}`);
    }
    if (has(opt, 'short')) {
      if (typeof opt.short !== 'string') throw invalidType(`options.${long}.short`, 'of type string', opt.short);
      if (opt.short.length !== 1) throw nodeError(TypeError, 'ERR_INVALID_ARG_VALUE', `The property 'options.${long}.short' must be a single character. Received '${opt.short}'`);
    }
    if (has(opt, 'multiple') && typeof opt.multiple !== 'boolean') throw invalidType(`options.${long}.multiple`, 'of type boolean', opt.multiple);
    if (has(opt, 'default') && opt.default !== undefined) {
      const d = opt.default;
      const ok = opt.multiple
        ? Array.isArray(d) && d.every((x) => typeof x === opt.type)
        : typeof d === opt.type;
      if (!ok) throw invalidType(`options.${long}.default`, opt.multiple ? `an instance of Array` : `of type ${opt.type}`, d);
    }
  }

  const typeOf = (long: string): OptionType | undefined => (has(options, long) ? options[long].type : undefined);
  const longForShort = (short: string): string => {
    for (const [long, opt] of Object.entries(options)) if (opt.short === short) return long;
    return short;
  };

  // Tokens
  const tokens: Token[] = [];
  const remaining = [...args];
  let index = -1;
  let groupCount = 0; // args that are the expansion of a short option group: they share its index
  while (remaining.length) {
    const arg = remaining.shift()!;
    const next = remaining[0];
    if (groupCount > 0) groupCount--; else index++;

    if (arg === '--') {
      tokens.push({ kind: 'option-terminator', index });
      for (const rest of remaining) tokens.push({ kind: 'positional', index: ++index, value: rest });
      break;
    }
    if (arg.length === 2 && arg[0] === '-' && arg[1] !== '-') {
      // -f
      const name = longForShort(arg[1]);
      let value: string | undefined, inlineValue: boolean | undefined;
      if (typeOf(name) === 'string' && next !== undefined) {
        value = remaining.shift();
        inlineValue = false;
      }
      tokens.push({ kind: 'option', name, rawName: arg, index, value, inlineValue });
      if (value !== undefined) index++;
      continue;
    }
    if (arg.length > 2 && arg[0] === '-' && arg[1] !== '-') {
      const firstLong = longForShort(arg[1]);
      if (typeOf(firstLong) !== 'string') {
        // -abc: -a -b -c; a string option before the end takes the rest (-abfFILE: -a -b -fFILE)
        const expanded: string[] = [];
        for (let k = 1; k < arg.length; k++) {
          const short = arg[k];
          if (typeOf(longForShort(short)) !== 'string' || k === arg.length - 1) expanded.push(`-${short}`);
          else { expanded.push(`-${arg.slice(k)}`); break; }
        }
        remaining.unshift(...expanded);
        groupCount = expanded.length; // (they all take the group's index)
        continue;
      }
      // -fFILE
      tokens.push({ kind: 'option', name: firstLong, rawName: `-${arg[1]}`, index, value: arg.slice(2), inlineValue: true });
      continue;
    }
    if (arg.startsWith('--') && arg.length > 2) {
      const eq = arg.indexOf('=', 3); // (as node: '--=x' is an option named '=x')
      if (eq >= 0) {
        // --foo=bar
        tokens.push({ kind: 'option', name: arg.slice(2, eq), rawName: arg.slice(0, eq), index, value: arg.slice(eq + 1), inlineValue: true });
        continue;
      }
      // --foo
      const name = arg.slice(2);
      let value: string | undefined, inlineValue: boolean | undefined;
      if (typeOf(name) === 'string' && next !== undefined) {
        value = remaining.shift();
        inlineValue = false;
      }
      tokens.push({ kind: 'option', name, rawName: arg, index, value, inlineValue });
      if (value !== undefined) index++;
      continue;
    }
    tokens.push({ kind: 'positional', index, value: arg });
  }

  // Values
  const values: Record<string, unknown> = { __proto__: null } as any;
  const positionals: string[] = [];
  for (const token of tokens) {
    if (token.kind === 'option') {
      let name = token.name;
      let negated = false;
      // --no-foo: false for boolean foo (strict mode: foo must be one); not --no-foo=x
      if (allowNegative && name.startsWith('no-') && !has(options, name) && token.value === undefined && (typeOf(name.slice(3)) === 'boolean' || !strict)) {
        name = name.slice(3);
        negated = true;
      }
      if (strict) {
        if (!has(options, name)) {
          const hint = allowPositionals ? `. To specify a positional argument starting with a '-', place it at the end of the command after '--', as in '-- ${JSON.stringify(token.rawName)}` : '';
          throw nodeError(TypeError, 'ERR_PARSE_ARGS_UNKNOWN_OPTION', `Unknown option '${token.rawName}'${hint}`);
        }
        const opt = options[name];
        const label = opt.short ? `-${opt.short}, --${name}` : `--${name}`;
        if (opt.type === 'string' && typeof token.value !== 'string') {
          throw nodeError(TypeError, 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE', `Option '${label} <value>' argument missing`);
        }
        if (opt.type === 'boolean' && token.value !== undefined) {
          throw nodeError(TypeError, 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE', `Option '${label}' does not take an argument`);
        }
        if (opt.type === 'string' && !token.inlineValue && token.value!.length > 1 && token.value!.startsWith('-')) {
          const example = opt.short ? `'--${name}=-XYZ' or '-${opt.short}-XYZ'` : `'--${name}=-XYZ'`;
          throw nodeError(TypeError, 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE',
            `Option '${label} <value>' argument is ambiguous.\nDid you forget to specify the option argument for '${token.rawName}'?\nTo specify an option argument starting with a dash use ${example}.`);
        }
      }
      if (name === '__proto__') continue;
      const value: unknown = negated ? false : token.value ?? true;
      if (has(options, name) && options[name].multiple) {
        if (values[name] === undefined) values[name] = [];
        (values[name] as unknown[]).push(value);
      } else values[name] = value;
    } else if (token.kind === 'positional') {
      if (!allowPositionals) {
        throw nodeError(TypeError, 'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL', `Unexpected argument '${token.value}'. This command does not take positional arguments`);
      }
      positionals.push(token.value);
    }
  }
  for (const [long, opt] of Object.entries(options)) {
    if (opt.default !== undefined && values[long] === undefined) values[long] = opt.default;
  }
  return returnTokens ? { values, positionals, tokens } : { values, positionals };
}
