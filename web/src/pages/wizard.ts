import { h, Fragment, useState } from '../dom.ts';
import type { VNode } from '../dom.ts';
import { api } from '../api.ts';
import type { AuthStatus } from '../types.ts';
import { state, errorMessage, toast } from '../store.ts';
import { Icon, Input, Select, Toggle, TextArea, Loading, ErrorBanner } from '../components.ts';

const step = useState(0);
const busy = useState(false);
const error = useState('');
const status = useState<AuthStatus | null>(null);
const form = useState<any>({
  hostname: 'wrexr', timezone: 'UTC', password: '', passwordConfirm: '', sshKeys: '',
  networkMode: 'dhcp', address: '', gateway: '', dns: '', bridge: 'vmbr0',
  createShare: false, shareName: '', sharePath: '',
  createVm: false, vmName: '', vmType: 'kvm'
});

const STEPS = ['System identity', 'Network', 'Credentials', 'Optional services', 'Review'];

export function load(): void {
  if (status.value) return;
  api.auth.status().then(status.set).catch((err) => error.set(errorMessage(err)));
}

function next(): void {
  const f = form.value;
  if (step.value === 0 && !f.hostname.trim()) { toast('Hostname is required', 'warning'); return; }
  if (step.value === 2) {
    if (!f.password || f.password.length < 8) { toast('Root password must be at least 8 characters', 'warning'); return; }
    if (f.password !== f.passwordConfirm) { toast('Passwords do not match', 'warning'); return; }
  }
  step.set(Math.min(STEPS.length - 1, step.value + 1));
}

async function finish(): Promise<void> {
  const f = form.value;
  busy.set(true);
  error.set('');
  try {
    const result = await api.auth.setup({
      hostname: f.hostname,
      timezone: f.timezone,
      password: f.password,
      sshKeys: String(f.sshKeys || '').split('\n').map((s: string) => s.trim()).filter(Boolean),
      network: {
        mode: f.networkMode,
        bridge: f.bridge,
        address: f.networkMode === 'static' ? f.address : undefined,
        gateway: f.networkMode === 'static' ? f.gateway : undefined,
        dns: f.networkMode === 'static' ? String(f.dns || '').split(',').map((s: string) => s.trim()).filter(Boolean) : undefined
      },
      createShare: f.createShare ? { name: f.shareName || 'media', path: f.sharePath || '/mnt/data/media', protocol: 'smb' } : undefined,
      createVm: f.createVm ? { name: f.vmName || 'first-vm', type: f.vmType, cpu: 2, memory: 2048, disk: 20 } : undefined
    });
    state.user.set(result.user || { name: 'root', role: 'admin' });
    state.permissions.set(result.user?.permissions || []);
    state.authStatus.set({ setupRequired: false, version: status.value?.version || '', hostname: f.hostname, channel: status.value?.channel || 'stable' });
    toast('WrexrOS setup complete', 'success');
    window.dispatchEvent(new CustomEvent('wrexr:navigate', { detail: '/dashboard' }));
  } catch (err) { error.set(errorMessage(err)); }
  finally { busy.set(false); }
}

function set(key: string, value: any): void { form.set({ ...form.value, [key]: value }); }

export function View(): VNode {
  const f = form.value;
  return h('div', { class: 'auth-screen' },
    h('div', { class: 'card auth-card wide' },
      h('div', { class: 'auth-brand' },
        h('img', { src: '/logo.svg', alt: '' }),
        h('div', {}, h('h1', {}, 'WrexrOS'), h('p', {}, 'First-run setup · ' + (status.value?.version || 'installer')))
      ),
      error.value ? ErrorBanner({ message: error.value }) : null,
      h('div', { class: 'stepper' }, ...STEPS.map((_, i) => h('div', { key: i, class: i < step.value ? 'done' : i === step.value ? 'active' : '' }))),
      h('div', { class: 'tiny dim mb-2' }, 'Step ' + (step.value + 1) + ' of ' + STEPS.length + ' — ' + STEPS[step.value]),

      step.value === 0 ? h(Fragment, {},
        h('h2', { class: 'step-title' }, 'Name your appliance'),
        h('p', { class: 'step-desc' }, 'This hostname is used by the web UI, SSH and network shares.'),
        Input({ label: 'Hostname', name: 'wz-host', value: f.hostname, onChange: (v) => set('hostname', v) }),
        Select({
          label: 'Timezone', name: 'wz-tz', value: f.timezone,
          options: ['UTC', 'Europe/Berlin', 'Europe/London', 'America/New_York', 'America/Los_Angeles', 'Asia/Tokyo', 'Australia/Sydney'].map((z) => ({ value: z, label: z })),
          onChange: (v) => set('timezone', v)
        })
      ) : null,

      step.value === 1 ? h(Fragment, {},
        h('h2', { class: 'step-title' }, 'Network configuration'),
        h('p', { class: 'step-desc' }, 'Configure the management interface.'),
        Select({
          label: 'Mode', name: 'wz-netmode', value: f.networkMode,
          options: [{ value: 'dhcp', label: 'DHCP (automatic)' }, { value: 'static', label: 'Static address' }],
          onChange: (v) => set('networkMode', v)
        }),
        Input({ label: 'Bridge / interface', name: 'wz-br', value: f.bridge, onChange: (v) => set('bridge', v) }),
        f.networkMode === 'static' ? h(Fragment, {},
          Input({ label: 'Address (CIDR)', name: 'wz-addr', value: f.address, placeholder: '192.168.1.10/24', onChange: (v) => set('address', v) }),
          h('div', { class: 'form-grid' },
            Input({ label: 'Gateway', name: 'wz-gw', value: f.gateway, onChange: (v) => set('gateway', v) }),
            Input({ label: 'DNS servers', name: 'wz-dns', value: f.dns, placeholder: '1.1.1.1, 8.8.8.8', onChange: (v) => set('dns', v) })
          )
        ) : h('div', { class: 'alert-inline' }, 'An address will be obtained automatically from DHCP.')
      ) : null,

      step.value === 2 ? h(Fragment, {},
        h('h2', { class: 'step-title' }, 'Administrator credentials'),
        h('p', { class: 'step-desc' }, 'The root account has full access to the appliance.'),
        h('div', { class: 'form-grid' },
          Input({ label: 'Root password', name: 'wz-pass', type: 'password', value: f.password, onChange: (v) => set('password', v) }),
          Input({ label: 'Confirm password', name: 'wz-pass2', type: 'password', value: f.passwordConfirm, onChange: (v) => set('passwordConfirm', v) })
        ),
        TextArea({ label: 'SSH public keys (optional, one per line)', name: 'wz-keys', value: f.sshKeys, onChange: (v) => set('sshKeys', v) })
      ) : null,

      step.value === 3 ? h(Fragment, {},
        h('h2', { class: 'step-title' }, 'Optional first services'),
        h('p', { class: 'step-desc' }, 'You can skip this and configure everything later.'),
        Toggle({ label: 'Create a network share', name: 'wz-share', checked: !!f.createShare, onChange: (v) => set('createShare', v) }),
        f.createShare ? h('div', { class: 'form-grid' },
          Input({ label: 'Share name', name: 'wz-sname', value: f.shareName, placeholder: 'media', onChange: (v) => set('shareName', v) }),
          Input({ label: 'Path', name: 'wz-spath', value: f.sharePath, placeholder: '/mnt/data/media', onChange: (v) => set('sharePath', v) })
        ) : null,
        Toggle({ label: 'Create a virtual machine', name: 'wz-vm', checked: !!f.createVm, onChange: (v) => set('createVm', v) }),
        f.createVm ? h('div', { class: 'form-grid' },
          Input({ label: 'VM name', name: 'wz-vname', value: f.vmName, placeholder: 'first-vm', onChange: (v) => set('vmName', v) }),
          Select({ label: 'Type', name: 'wz-vtype', value: f.vmType, options: [{ value: 'kvm', label: 'KVM' }, { value: 'lxc', label: 'LXC' }], onChange: (v) => set('vmType', v) })
        ) : null
      ) : null,

      step.value === 4 ? h(Fragment, {},
        h('h2', { class: 'step-title' }, 'Review & finish'),
        h('p', { class: 'step-desc' }, 'Confirm the settings below to complete installation.'),
        h('dl', { class: 'kv' },
          h('dt', {}, 'Hostname'), h('dd', {}, f.hostname),
          h('dt', {}, 'Timezone'), h('dd', {}, f.timezone),
          h('dt', {}, 'Network'), h('dd', {}, f.networkMode === 'static' ? (f.address + ' via ' + f.bridge) : 'DHCP via ' + f.bridge),
          h('dt', {}, 'SSH keys'), h('dd', {}, String(f.sshKeys || '').split('\n').filter(Boolean).length + ' key(s)'),
          h('dt', {}, 'First share'), h('dd', {}, f.createShare ? (f.shareName || 'media') : 'none'),
          h('dt', {}, 'First VM'), h('dd', {}, f.createVm ? (f.vmName || 'first-vm') : 'none')
        )
      ) : null,

      h('div', { class: 'form-actions' },
        step.value > 0 ? h('button', { class: 'btn', onClick: () => step.set(step.value - 1) }, 'Back') : null,
        h('span', { class: 'spacer' }),
        step.value < STEPS.length - 1
          ? h('button', { class: 'btn btn-primary btn-lg', onClick: next }, 'Continue', h('span', { class: 'icon' }, Icon({ name: 'chevron', size: 16 })))
          : h('button', { class: 'btn btn-primary btn-lg', disabled: busy.value, onClick: finish }, busy.value ? 'Applying…' : 'Complete setup')
      )
    )
  );
}
