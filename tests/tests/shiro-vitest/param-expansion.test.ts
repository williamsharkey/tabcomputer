/**
 * Parameter expansion details, as bash: tilde in assignments and ${x:-~},
 * ~root and ~$USER, a ${x:-word} word expanded only when used, operators on
 * $@ and $* applied to each parameter, an empty strip pattern.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestShell } from './helpers';
import type { Shell } from '@shiro/shell';

let shell: Shell;

beforeEach(async () => {
  ({ shell } = await createTestShell());
  await sh('HOME=/home/bar');
});

async function sh(cmd: string) {
  let out = '';
  const code = await shell.execute(cmd, (s) => { out += s; }, (s) => { out += s; });
  return { out: out.replace(/\r\n/g, '\n'), code };
}

describe('tilde', () => {
  it('in a ${x:-~} word: unquoted yes, quoted no', async () => {
    expect((await sh('echo ${undef:-~} "${undef:-~}" ${HOME:+~/z}')).out).toBe('/home/bar ~ /home/bar/z\n');
  });

  it('~root and ~USER', async () => {
    expect((await sh('echo ~root ~root/x; echo ~$USER; u=$USER; eval echo ~$u; echo ~nosuchuser')).out)
      .toBe('/root /root/x\n~user\n/home/bar\n~nosuchuser\n');
  });

  it('in assignments: at the start and after : (with $ in the value, in array elements, in env prefixes)', async () => {
    expect((await sh('x=~:$HOME; echo $x; y=a:~:${undef-b}; echo $y')).out).toBe('/home/bar:/home/bar\na:/home/bar:b\n');
    expect((await sh('declare -a a; a[0]=foo:~; echo ${a[0]}')).out).toBe('foo:/home/bar\n');
    expect((await sh('xx=~root:~:~ env | grep ^xx=')).out).toBe('xx=/root:/home/bar:/home/bar\n');
  });
});

describe('${x:-word}', () => {
  it('expands the word only when it is used', async () => {
    expect((await sh('i=0; x=x; echo ${x:-$((i++))} "${x:-$((i++))}"; echo $i; echo ${u:-$((i++))}; echo $i')).out).toBe('x x\n0\n0\n1\n');
    expect((await sh('n=3; echo "${u:-$((n+1))}" ${u:=$((n*2))}; echo $u')).out).toBe('4 6\n6\n');
  });
});

describe('operators on $@ and $*', () => {
  it('apply to each parameter', async () => {
    expect((await sh('set -- 1a 2a 3a; echo ${@%a}; echo "${*%a}"')).out).toBe('1 2 3\n1 2 3\n');
    expect((await sh('set -- ab cb; p=b; printf "<%s>" "${@//$p/X}"; echo; echo ${@^^}')).out).toBe('<aX><cX>\nAB CB\n');
  });

  it('an empty strip pattern strips nothing', async () => {
    expect((await sh('x=abc; echo "${x#}" "${x##}" "${x%}" "${x%%}"')).out).toBe('abc abc abc abc\n');
  });
});
