# WrexrOS internal API contract (v1)

All components (backend, web UI, `wrexctl`) MUST use this contract. It is the single source of truth
for endpoint names and response shapes, so the UI and CLI stay in sync with the daemon.

## Transport

* Base path: `/api/v1`
* TLS by default on port 8443. During development `WREXR_INSECURE_HTTP=1` allows plain HTTP.
* Authentication: `Authorization: Bearer <token>` (API token or session token). A cookie
  `wrexr_session` is also accepted for the browser.
* Every response uses the envelope:

```json
{ "ok": true, "data": { } }
```

or, on failure:

```json
{ "ok": false, "error": { "code": "NOT_FOUND", "message": "..." , "details": {} } }
```

HTTP status codes are conventional: 200/201 success, 400 validation, 401 unauthenticated,
403 forbidden, 404 missing, 409 conflict, 500 internal.

Collection endpoints return a named array inside `data`: `/vms` -> `{vms:[]}`,
`/bridges` -> `{bridges:[]}`, `/vm-templates` -> `{templates:[]}`, `/pci` -> `{devices:[]}`,
`/storage/disks` -> `{disks:[]}`, `/storage/datasets` -> `{datasets:[]}`,
`/storage/snapshots` -> `{snapshots:[]}`, `/shares` -> `{shares:[]}`, `/users` -> `{users:[]}`,
`/groups` -> `{groups:[]}`, `/apps/catalog` -> `{apps:[]}`, `/apps/installed` -> `{apps:[]}`,
`/apps/repos` -> `{repos:[]}`, `/updates/app` -> `{apps:[]}`, `/events` -> `{events:[]}`,
`/audit` -> `{audit:[]}`, `/alerts` -> `{alerts:[]}`, `/backups` -> `{backups:[]}`,
`/plugins` -> `{plugins:[]}`, `/cluster/nodes` -> `{nodes:[]}`, `/auth/tokens` -> `{tokens:[]}`,
`/vms/:id/snapshots` -> `{snapshots:[]}` and `/vms/:id/firewall` -> `{rules:[]}`.
Clients MUST unwrap the named key; pages MUST NOT assume a bare array.

## Endpoints

### Auth / first boot

| Method | Path | Description |
| --- | --- | --- |
| GET | `/auth/status` | `{ setupRequired, version, hostname, channel }` |
| POST | `/auth/setup` | First-run wizard: `{ hostname, timezone, password, sshKeys[], network, createShare?, createVm? }` -> `{ token, user }` |
| POST | `/auth/login` | `{ password, totp? }` -> `{ token, user, expiresAt }` |
| POST | `/auth/logout` | invalidate session |
| GET | `/auth/me` | current user + permissions |
| POST | `/auth/totp/enroll` | `{ secret, uri }` |
| POST | `/auth/totp/verify` | `{ code }` -> `{ enabled }` |
| GET/POST | `/auth/tokens` | API token management |
| DELETE | `/auth/tokens/:id` | revoke token |

### Dashboard

| Method | Path | Description |
| --- | --- | --- |
| GET | `/dashboard` | `{ host, metrics:{cpu,ram,disk,network}, counts:{vms,containers,shares,apps}, array, events[], alerts[] }` |
| GET | `/metrics/history` | `{ cpu:[], ram:[], network:[] }` for graphs |

### Virtual machines and LXC

| Method | Path | Description |
| --- | --- | --- |
| GET/POST | `/vms` | list / create `{name,type:'kvm'|'lxc',cpu,memory,disk,iso?,template?,network?}` |
| GET/PUT/DELETE | `/vms/:id` | inspect / update / delete |
| POST | `/vms/:id/:action` | action ∈ start,stop,reboot,shutdown,snapshot,resume,suspend |
| GET | `/vms/:id/vnc` | `{ url, port, websocket }` for in-browser console |
| GET | `/vms/:id/snapshots` | list snapshots |
| GET | `/pci` | `{ devices:[{id,vendor,device,iommuGroup,usable}] }` |
| GET | `/bridges` | list VLAN-aware bridges |
| POST | `/bridges` | create bridge `{name,ports,vlanAware,tag}` |
| GET/POST | `/vm-templates` | resource templates |
| GET/POST | `/vms/:id/firewall` | firewall rules |

### Storage (ZFS/Btrfs + Unraid-style array)

| Method | Path | Description |
| --- | --- | --- |
| GET | `/storage/disks` | `{ disks:[{id,model,size,type,temp,smart,role,state}] }` |
| GET | `/storage/array` | `{ status, parity:[], data:[], used, total, syncProgress, errors[] }` |
| POST | `/storage/array/:action` | action ∈ start,stop,sync,scrub,clear |
| POST | `/storage/array/disks` | assign `{disk,role:'parity'|'data'|'cache'}` |
| GET/POST | `/storage/datasets` | ZFS/Btrfs datasets `{name,pool,compression,quota,used}` |
| DELETE | `/storage/datasets/:name` | delete dataset |
| GET | `/storage/snapshots` | list snapshots |
| POST | `/storage/snapshots` | create `{dataset,name}` |
| GET/POST | `/storage/smart` | SMART test schedule and results |
| GET/PUT | `/storage/settings` | trim, parity schedule |

### File sharing

| Method | Path | Description |
| --- | --- | --- |
| GET/POST | `/shares` | list / create `{name,path,disk,protocol:'smb'|'nfs'|'ftp',users[],permissions,recycle,readOnly}` |
| GET/PUT/DELETE | `/shares/:id` | manage share |
| GET/POST | `/users` | local users/groups and ACLs |
| DELETE | `/users/:id` | delete user |
| GET/POST | `/groups` | groups |
| POST | `/shares/:id/acl` | update share-level ACL |

### Docker app store

| Method | Path | Description |
| --- | --- | --- |
| GET | `/apps/catalog` | `{ apps:[{id,name,category,version,description,icon,trusted,installed,updateAvailable}] }` |
| GET | `/apps/installed` | installed containers incl. status |
| POST | `/apps/install` | `{appId,name?,env?,ports?,volumes?,limits?}` |
| GET/PUT/DELETE | `/apps/:id` | inspect / edit / remove |
| POST | `/apps/:id/:action` | start,stop,restart,upgrade |
| GET | `/apps/:id/logs` | `{ lines:[] }` |
| GET/POST | `/apps/repos` | custom template repos `{url,trusted}` |
| DELETE | `/apps/repos/:id` | remove repo |
| POST | `/apps/repos/sync` | refresh catalog |

### Settings

| Method | Path | Description |
| --- | --- | --- |
| GET/PUT | `/settings/general` | hostname, timezone, language, theme, kiosk |
| GET/PUT | `/settings/network` | interfaces, bridges, VLAN, DHCP/static, DNS, proxy, firewall |
| GET/PUT | `/settings/storage` | array, parity schedule, SMART, trim |
| GET/PUT | `/settings/access` | roles, 2FA policy, API tokens, SSH keys |
| GET/PUT | `/settings/updates` | system/app updates, channel, repo sync |
| GET/PUT | `/settings/advanced` | kernel params, raw config editor |
| GET | `/settings/raw` | current raw config |
| PUT | `/settings/raw` | validated save with automatic backup -> `{backupPath}` |
| POST | `/settings/raw/validate` | validate without saving |

### Updates

| Method | Path | Description |
| --- | --- | --- |
| GET | `/updates/check` | `{ current, latest, updateAvailable, releaseUrl, publishedAt }` |
| POST | `/updates/install` | `{ version? }` -> `{ jobId }` |
| GET | `/updates/status` | `{ state, progress, message }` |
| GET | `/updates/app` | app update notifications |
| GET | `/updates/repo` | repository info + sync status |

### Operations

| Method | Path | Description |
| --- | --- | --- |
| GET | `/events` | recent events/alerts |
| GET | `/audit` | admin audit log |
| GET/POST | `/alerts` | alert rules `{type,target,threshold,enabled}` |
| GET/POST | `/backups` | schedules/jobs |
| POST | `/backups/:id/run` | run now |
| GET/POST | `/plugins` | signed plugins |
| POST | `/plugins/:id/:action` | enable/disable/install |
| GET/POST | `/cluster/nodes` | node linking / HA prep |
| DELETE | `/cluster/nodes/:id` | unlink node |
| GET | `/openapi.json` | OpenAPI 3.1 description |

### WebSockets

| Path | Payload |
| --- | --- |
| `/ws/metrics` | `{"type":"metrics","data":{cpu,ram,disk,network,...}}` every 2s |
| `/ws/events` | `{"type":"event","data":{id,level,message,time}}` |
| `/ws/terminal` | send `{"type":"input","data":"..."}`, receive `{"type":"output","data":"..."}`; also `resize` and `close`. |

## Frontend routes

`/dashboard`, `/vms`, `/containers`, `/storage`, `/shares`, `/apps`, `/settings`,
`/wizard`, `/terminal`, `/updates`, `/users`, `/alerts`, `/backups`, `/plugins`, `/cluster`.

## Role model

Roles: `admin`, `operator`, `viewer`, plus custom roles with granular actions of the form
`<domain>:<action>` (e.g. `vm:start`, `share:write`, `app:install`). `viewer` is read-only.
`admin` has every permission. Every mutating request is written to the audit log with actor, action,
resource, timestamp and source IP.
