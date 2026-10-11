/**
 * A project's own programs (node_modules/.bin) come before Shiro's commands of the
 * same name: `npm test` with "test": "jest" and `npx jest` ran Shiro's built-in
 * test runner instead of the project's jest. npm run puts each node_modules/.bin
 * from the package up first on PATH, as npm does, and the shell then prefers them
 * over registered commands (but not node, npm, npx, sh, bash, env).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createTestShell, run } from './helpers';
import type { Shell } from '@shiro/shell';
import type { FileSystem } from '@shiro/filesystem';

let shell: Shell;
let fs: FileSystem;
const out = async (cmd: string) => (await run(shell, `${cmd} < /dev/null`)).output.replace(/\r\n/g, '\n');

beforeAll(async () => {
  ({ shell, fs } = await createTestShell());
  await fs.mkdir('/tmp/lb/node_modules/.bin', { recursive: true });
  await fs.mkdir('/tmp/lb/sub', { recursive: true });
  await fs.writeFile('/tmp/lb/package.json', JSON.stringify({ name: 'lb', version: '1.0.0', scripts: { test: 'jest --flag', which: 'echo PATH0=${PATH%%:*}', usenode: 'node -e "console.log(1 + 1)"' } }));
  await fs.writeFile('/tmp/lb/node_modules/.bin/jest', '#!/usr/bin/env node\nconsole.log("project jest", process.argv.slice(2).join(" "));\n');
  await fs.writeFile('/tmp/lb/node_modules/.bin/node', '#!/bin/sh\necho "not the real node"\n');
  await run(shell, 'chmod +x /tmp/lb/node_modules/.bin/jest /tmp/lb/node_modules/.bin/node');
});

describe("a project's node_modules/.bin", () => {
  it('npm test runs the project\'s jest, not Shiro\'s', async () => {
    expect(await out('cd /tmp/lb && npm test')).toContain('project jest --flag');
  });

  it('npm run puts node_modules/.bin first on PATH, and puts PATH back after', async () => {
    expect(await out('cd /tmp/lb && npm run which')).toContain('PATH0=/tmp/lb/node_modules/.bin');
    expect(await out('cd /tmp/lb && echo "after=${PATH%%:*}"')).not.toContain('after=/tmp/lb/node_modules/.bin');
  });

  it('npx jest runs it too, from a subdirectory', async () => {
    expect(await out('cd /tmp/lb/sub && npx jest a b')).toContain('project jest a b');
  });

  it('node, npm and the shell stay Shiro\'s', async () => {
    expect(await out('cd /tmp/lb && npm run usenode')).toContain('2');
  });
});
