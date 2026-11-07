/**
 * The Remote window: a tab per connection code, the agent's events, a line back.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createRemotePanel, setRemoteDeskActions } from '@shiro/remote-desk';

afterEach(() => {
  document.querySelectorAll('.rd-float').forEach((el) => el.remove());
});

describe('remote desk', () => {
  it('names a tab with the code, shows what the agent does, and sends a line back', () => {
    const sent: string[] = [];
    const panel = createRemotePanel('pro-slug-sunedayo', 'pro-slug-sunedayo');
    panel.setStatus('connected');
    panel.setDetail!('WebRTC');
    panel.setTitle('shiro-probe ↔ pro-slug-sunedayo');
    panel.onUserMessage = (m) => { sent.push(m); panel.log('user', m); };
    panel.log('exec', '$ doctor');
    panel.log('out', 'OK    storage      142 MB of 10382 MB');
    panel.log('read', '/home/user/AGENTS.md');

    const root = document.querySelector('.rd')!;
    expect(root.querySelector('.rd-name')!.textContent).toBe('pro-slug-sunedayo');
    expect(root.textContent).toContain('shiro-probe');
    expect(root.textContent).toContain('WebRTC');
    expect(root.textContent).toContain('$ doctor');
    expect(root.textContent).toContain('142 MB');
    expect(root.querySelector('.rd-row[data-kind="read"]')!.textContent).toContain('read');

    const input = root.querySelector('.rd-input') as HTMLInputElement;
    input.value = 'look at storage';
    root.querySelector('.rd-compose')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    expect(sent).toEqual(['look at storage']);
    expect(root.textContent).toContain('look at storage');

    let started = 0;
    setRemoteDeskActions({ onNew: () => { started++; } });
    (root.querySelector('[data-act="new"]') as HTMLElement).click();
    expect(started).toBe(1);

    const other = createRemotePanel('quiet-river-takara', 'quiet-river-takara');
    other.deactivate();
    expect(document.querySelectorAll('.rd-tab').length).toBe(2);
    expect((document.querySelector('.rd-input') as HTMLInputElement).disabled).toBe(true);

    (document.querySelector('[data-id="pro-slug-sunedayo"]') as HTMLElement).click();
    expect(document.querySelector('[data-tab="pro-slug-sunedayo"]')).toBeNull();
    expect(document.querySelector('.rd-name')!.textContent).toBe('quiet-river-takara');
    other.close();
  });
});
