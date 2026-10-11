/**
 * Bun's YAML and TOML for claude --vm (src/claude-vm/bun/): the expected values are what
 * Bun 1.4.2 returned for the same calls.
 */
import { describe, it, expect } from 'vitest';
import { YAML, TOML } from '@shiro/claude-vm/bun/formats';

describe('Bun.YAML', () => {
  it('parse: mappings, sequences, block scalars, several documents (an array), empty input', () => {
    const Y = ['a: 1\nb: [x, y]\nc:\n  d: true\n  e: null\n', '---\nname: x\ndescription: |\n  multi\n  line\n---\n', '- 1\n- two\n- 3.5\n', 'key: "quoted: value"\n', 'a: 1\n---\nb: 2\n', '', 'date: 2024-01-01\nver: 1.10\nhex: 0x1F\noct: 0o17\n'];
    expect(JSON.parse(JSON.stringify(Y.map((y) => { try { return YAML.parse(y); } catch (e: any) { return 'ERR ' + e.name; } })))).toEqual([{"a": 1, "b": ["x", "y"], "c": {"d": true, "e": null}}, [{"name": "x", "description": "multi\nline\n"}, null], [1, "two", 3.5], {"key": "quoted: value"}, [{"a": 1}, {"b": 2}], null, {"date": "2024-01-01", "ver": 1.1, "hex": 31, "oct": 15}]);
  });
  it("stringify: Bun's block style with an indent, its flow style without", () => {
    const vals: unknown[] = [{ a: 1, b: [1, 2], c: { d: 'x y', e: null, f: true } }, ['a', 'b'], 'plain', { s: 'needs: quoting', n: '123', m: 'multi\nline' }];
    expect(vals.map((v) => YAML.stringify(v, null, 2))).toEqual(["a: 1\nb: \n  - 1\n  - 2\nc: \n  d: x y\n  e: null\n  f: true", "- a\n- b", "plain", "s: \"needs: quoting\"\n\"n\": \"123\"\nm: \"multi\\nline\""]);
    expect(vals.map((v) => YAML.stringify(v))).toEqual(["{a: 1,b: [1,2],c: {d: x y,e: null,f: true}}", "[a,b]", "plain", "{s: \"needs: quoting\",\"n\": \"123\",m: \"multi\\nline\"}"]);
    const more: unknown[] = [{}, [], { a: {} }, { a: [] }, [{ a: 1, b: 2 }, { c: 3 }], [[1, 2], [3]], { k: '' }, { k: ' x' }, { k: 'true' }, { k: 'yes' }, { k: 'null' }, { k: '~' }, { k: '1e3' }, { k: '-' }, { k: 'a#b' }, { k: 'a #b' }, { k: '#x' }, { k: 'x:y' }, { k: '@x' }, { 'a b': 1 }, { k: 1.5 }, { k: -0 }, { k: NaN }, { k: Infinity }, { k: 'it\'s' }, { k: 'tab\there' }, { k: '日本' }, { k: [{ x: [1] }] }, { n: { m: { o: 1 } } }, { k: undefined, j: 1 }, { k: new Date(0) }, 'y', 'on', '0x10', '1_000', '.5', '+1', 'null', 'Null', 'NULL', 'True', 'abc '];
    expect(more.map((v) => [YAML.stringify(v, null, 2), YAML.stringify(v)])).toEqual([["{}", "{}"], ["[]", "[]"], ["a: \n  {}", "{a: {}}"], ["a: \n  []", "{a: []}"], ["- a: 1\n  b: 2\n- c: 3", "[{a: 1,b: 2},{c: 3}]"], ["- - 1\n  - 2\n- - 3", "[[1,2],[3]]"], ["k: \"\"", "{k: \"\"}"], ["k: \" x\"", "{k: \" x\"}"], ["k: \"true\"", "{k: \"true\"}"], ["k: \"yes\"", "{k: \"yes\"}"], ["k: \"null\"", "{k: \"null\"}"], ["k: \"~\"", "{k: \"~\"}"], ["k: \"1e3\"", "{k: \"1e3\"}"], ["k: \"-\"", "{k: \"-\"}"], ["k: \"a#b\"", "{k: \"a#b\"}"], ["k: \"a #b\"", "{k: \"a #b\"}"], ["k: \"#x\"", "{k: \"#x\"}"], ["k: x:y", "{k: x:y}"], ["k: \"@x\"", "{k: \"@x\"}"], ["a b: 1", "{a b: 1}"], ["k: 1.5", "{k: 1.5}"], ["k: -0", "{k: -0}"], ["k: .nan", "{k: .nan}"], ["k: .inf", "{k: .inf}"], ["k: \"it's\"", "{k: \"it's\"}"], ["k: \"tab\\there\"", "{k: \"tab\\there\"}"], ["k: \u65e5\u672c", "{k: \u65e5\u672c}"], ["k: \n  - x: \n      - 1", "{k: [{x: [1]}]}"], ["\"n\": \n  m: \n    o: 1", "{\"n\": {m: {o: 1}}}"], ["j: 1", "{j: 1}"], ["k: \n  {}", "{k: {}}"], ["\"y\"", "\"y\""], ["\"on\"", "\"on\""], ["\"0x10\"", "\"0x10\""], ["1_000", "1_000"], ["\".5\"", "\".5\""], ["\"+1\"", "\"+1\""], ["\"null\"", "\"null\""], ["\"Null\"", "\"Null\""], ["\"NULL\"", "\"NULL\""], ["\"True\"", "\"True\""], ["\"abc \"", "\"abc \""]]);
  });
  it('bad input is a SyntaxError', () => {
    expect(() => YAML.parse('a: [1, 2')).toThrow(SyntaxError);
  });
});

describe('Bun.TOML', () => {
  it('parse: tables, arrays of tables, inline tables; dates as text objects', () => {
    const T = ['a = 1\nb = "two"\n[sec]\nc = [1, 2]\nd = { e = true }\n', '[[arr]]\nx = 1\n[[arr]]\nx = 2\n', 'dt = 1979-05-27T07:32:00Z\nf = 3.14\n', 'bad = \n'];
    expect(T.map((t) => { try { return JSON.parse(JSON.stringify(TOML.parse(t))); } catch (e: any) { return 'ERR ' + e.name; } })).toEqual([{"a": 1, "b": "two", "sec": {"c": [1, 2], "d": {"e": true}}}, {"arr": [{"x": 1}, {"x": 2}]}, {"dt": "1979-05-27T07:32:00Z", "f": 3.14}, "ERR SyntaxError"]);
    const t: any = TOML.parse('dt = 1979-05-27T07:32:00Z\nd = 1979-05-27\nt = 07:32:00\nl = 1979-05-27T07:32:00\n');
    expect(JSON.stringify(Object.fromEntries(Object.entries(t).map(([k, v]: any) => [k, [typeof v, v instanceof Date, String(v)]])))).toBe("{\"dt\":[\"object\",false,\"1979-05-27T07:32:00Z\"],\"d\":[\"object\",false,\"1979-05-27\"],\"t\":[\"object\",false,\"07:32:00\"],\"l\":[\"object\",false,\"1979-05-27T07:32:00\"]}");
  });
});
