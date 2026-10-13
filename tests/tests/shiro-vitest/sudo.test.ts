/** sudo (src/commands/sudo.ts) runs its command with uid 0; Shiro's own id reports it. */
import { describe, it, expect } from 'vitest';
import { createTestShell, run } from './helpers';

describe('sudo', () => {
  it("runs Shiro's builtins as root", async () => {
    const { shell } = await createTestShell();
    expect((await run(shell, 'id -u')).output.trim()).toBe('1000');
    expect((await run(shell, 'sudo id -u')).output.trim()).toBe('0');
    expect((await run(shell, 'sudo id -un')).output.trim()).toBe('root');
    expect((await run(shell, 'sudo id')).output).toContain('uid=0(root) gid=0(root)');
  });

  it('runs as an account a package made, by its /etc/passwd entry', async () => {
    const { fs, shell } = await createTestShell();
    expect((await run(shell, 'sudo -u www-data id -u')).output).toContain('sudo: unknown user www-data');
    await fs.mkdir('/etc', { recursive: true });
    await fs.writeFile('/etc/passwd', 'root:x:0:0:root:/root:/bin/bash\nwww-data:x:33:33:www-data:/var/www:/usr/sbin/nologin\nuser:x:1000:1000::/home/user:/bin/bash\n');
    expect((await run(shell, 'sudo -u www-data id -u')).output.trim()).toBe('33');
    expect((await run(shell, `sudo -u www-data sh -c 'echo $USER $HOME $SUDO_USER'`)).output.trim()).toBe('www-data /var/www user');
    expect((await run(shell, `sudo -u '#33' sh -c 'echo $USER'`)).output.trim()).toBe('www-data');
    // no such account: postgres alone is let through, as the tab's user under that name (the tab's own PostgreSQL)
    expect((await run(shell, 'sudo -u nobody id -u')).output).toContain('sudo: unknown user nobody');
    expect((await run(shell, `sudo -u postgres sh -c 'echo $USER'; sudo -u postgres id -u`)).output.trim().split(/\r?\n/)).toEqual(['postgres', '1000']);
  });
});
