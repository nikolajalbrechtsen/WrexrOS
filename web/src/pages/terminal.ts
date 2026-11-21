import { h } from '../dom.ts';
import type { VNode } from '../dom.ts';
import { state } from '../store.ts';
import { PageHead, Panel, TerminalView, Badge, Icon } from '../components.ts';

export function load(): void { /* the terminal owns its own WebSocket session */ }

export function View(): VNode {
  return h('div', { class: 'page' },
    PageHead({
      title: 'Terminal',
      subtitle: 'Interactive shell over /api/v1/ws/terminal'
    }),
    h('div', { class: 'grid grid-main' },
      TerminalView({ title: 'root@' + (state.authStatus.value?.hostname || 'wrexr') + ':~#', keyName: 'main' }),
      h('div', { class: 'stack' },
        Panel({ title: 'Session' },
          h('dl', { class: 'kv small' },
            h('dt', {}, 'Transport'), h('dd', {}, 'WebSocket'),
            h('dt', {}, 'Endpoint'), h('dd', { class: 'mono' }, '/api/v1/ws/terminal'),
            h('dt', {}, 'Authentication'), h('dd', {}, 'Bearer token / session cookie'),
            h('dt', {}, 'State'), h('dd', {}, Badge({ kind: 'success', text: 'auto-reconnect' }))
          )
        ),
        Panel({ title: 'Useful commands' },
          h('div', { class: 'stack small' },
            h('div', {}, h('code', { class: 'mono' }, 'wrexctl status'), h('div', { class: 'dim tiny' }, 'Show appliance status')),
            h('div', {}, h('code', { class: 'mono' }, 'wrexctl vm list'), h('div', { class: 'dim tiny' }, 'List virtual machines')),
            h('div', {}, h('code', { class: 'mono' }, 'zpool status'), h('div', { class: 'dim tiny' }, 'ZFS pool health')),
            h('div', {}, h('code', { class: 'mono' }, 'journalctl -fu wrexrd'), h('div', { class: 'dim tiny' }, 'Follow daemon logs'))
          )
        ),
        h('div', { class: 'alert-inline' },
          h('span', { class: 'icon' }, Icon({ name: 'info', size: 14 })),
          ' Commands run with the privileges of the WrexrOS daemon user.'
        )
      )
    )
  );
}
