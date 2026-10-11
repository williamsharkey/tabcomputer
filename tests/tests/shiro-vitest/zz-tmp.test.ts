import { it } from 'vitest';
import { createTestShell } from './helpers';
it('t', async () => {
  const { shell, fs } = await createTestShell();
  await fs.mkdir('/home/user/cy', { recursive: true });
  const w = (p: string, t: string) => fs.writeFile('/home/user/cy/' + p, t);
  await w('main.mjs', `import { x } from './a.mjs'; console.log('main x =', x);`);
  await w('a.mjs', `import { useLater } from './b.mjs'; const x = 'X'; export { x }; console.log('a: b says', useLater());`);
  await w('b.mjs', `import { x } from './a.mjs'; export function useLater() { return 'later ' + x; }`);
  await w('c.mjs', `import { y as yy } from './d.mjs'; export const y = 1; console.log('c ok', typeof yy);`);
  await w('d.mjs', `export { y } from './c.mjs';`);
  await w('m2.mjs', `import { a } from './a2.mjs';\nconsole.log('main runs');\nexport let count = 1;\nexport function bump() { count++; }\nconsole.log('a sees', a());\n`);
  await w('a2.mjs', `import { count, bump } from './m2.mjs';\nexport const a = () => { bump(); return count; };\n`);
  await w('live.mjs', `import { n, inc } from './n.mjs';\nconsole.log(n); inc(); console.log(n);\n`);
  await w('n.mjs', `export let n = 1;\nexport function inc() { n++; }\n`);
  for (const c of ['node main.mjs', 'node c.mjs', 'node m2.mjs', 'node live.mjs']) {
    let out = ''; await shell.execute('cd /home/user/cy && ' + c, (s) => { out += s; }, (s) => { out += s; });
    console.log('RR', c, JSON.stringify(out));
  }
}, 30000);
