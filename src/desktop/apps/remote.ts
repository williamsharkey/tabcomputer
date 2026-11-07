/**
 * Remote: the window an outside agent shows up in. Tabs are connection
 * codes. The page is what the agent does, and the bottom line sends a
 * message back. The view itself is src/remote-desk.ts.
 */

import type { AppContext } from '../index';
import type { DesktopWindow } from '../wm';
import { mountRemoteDesk } from '../../remote-desk';

export function open(ctx: AppContext): DesktopWindow {
  const root = document.createElement('div');
  root.className = 'sd-app';
  const win = ctx.wm.createWindow({
    title: 'Remote',
    appId: 'remote',
    width: 760,
    height: 540,
    minWidth: 440,
    minHeight: 320,
    content: { kind: 'dom', element: root },
  });
  mountRemoteDesk(root);
  return win;
}
