# REST API

The authoritative machine contract lives in [API_CONTRACT.md](API_CONTRACT.md); this page
adds practical examples. The daemon also serves an OpenAPI 3.1 document at
`GET /api/v1/openapi.json`.

## Base URL and authentication

```text
https://<host>:8443/api/v1
Authorization: Bearer <token>
```

During local development set `WREXR_INSECURE_HTTP=1` and use `http://127.0.0.1:8443`.

Every response is enveloped:

```json
{"ok": true, "data": {}}
```

Errors:

```json
{"ok": false, "error": {"code": "FORBIDDEN", "message": "Missing permission vm:start"}}
```

## First boot

```bash
curl -k https://wrexr.local:8443/api/v1/auth/status
# {"ok":true,"data":{"setupRequired":true,"version":"0.1.2","hostname":"wrexr","channel":"stable"}}

curl -k -X POST https://wrexr.local:8443/api/v1/auth/setup \
  -H 'Content-Type: application/json' \
  -d '{"hostname":"wrexr-node1","timezone":"Europe/Copenhagen","password":"correct horse battery staple"}'
# {"ok":true,"data":{"token":"...","user":{"username":"root","role":"admin"}}}
```

Use the returned token for subsequent calls. Tokens can be scoped API tokens or session
tokens; the browser uses a secure cookie as well.

## Dashboard and live metrics

```bash
curl -k -H "Authorization: Bearer $TOKEN" https://wrexr.local:8443/api/v1/dashboard
curl -k -H "Authorization: Bearer $TOKEN" https://wrexr.local:8443/api/v1/metrics/history
```

WebSocket frames from `/api/v1/ws/metrics` (the daemon also accepts `/ws/metrics`):

```json
{"type":"metrics","data":{"cpu":12.4,"ram":38.1,"disk":61.0,"network":{"rx":1203,"tx":840}}}
```

## VMs

```bash
# Create a KVM VM
curl -k -X POST .../vms -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"win11","type":"kvm","cpu":4,"memory":8192,"disk":80,"iso":"Win11.iso"}'

# Start / snapshot
curl -k -X POST .../vms/<id>/start -H "Authorization: Bearer $TOKEN"
curl -k -X POST .../vms/<id>/snapshot -H "Authorization: Bearer $TOKEN" -d '{"name":"clean"}'

# PCI passthrough candidates and bridges
curl -k .../pci -H "Authorization: Bearer $TOKEN"
curl -k .../bridges -H "Authorization: Bearer $TOKEN"
```

LXC containers use the same endpoints with `"type":"lxc"`; `/api/v1/containers` is a
convenience filter.

## Storage and shares

```bash
curl -k .../storage/array -H "Authorization: Bearer $TOKEN"
curl -k -X POST .../storage/array/sync -H "Authorization: Bearer $TOKEN"

curl -k -X POST .../shares -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"media","path":"/mnt/array/media","disk":"array0","protocol":"smb",
       "users":["alice"],"permissions":"rw","recycle":true}'
```

## Apps

```bash
curl -k .../apps/catalog -H "Authorization: Bearer $TOKEN"
curl -k -X POST .../apps/install -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"appId":"jellyfin","ports":[{"container":8096,"host":8096}],"limits":{"cpus":2,"memory":"2g"}}'
curl -k .../apps/<id>/logs -H "Authorization: Bearer $TOKEN"
```

## Updates

```bash
curl -k .../updates/check -H "Authorization: Bearer $TOKEN"
# {"ok":true,"data":{"current":"0.1.2","latest":"0.1.2","updateAvailable":false,...}}
```

## Errors and permissions

| Code | Meaning |
| --- | --- |
| `BAD_REQUEST` | Invalid JSON or validation failure |
| `UNAUTHENTICATED` | Missing/invalid/expired token |
| `FORBIDDEN` | RBAC denial |
| `NOT_FOUND` | Resource does not exist |
| `CONFLICT` | Duplicate name or invalid state transition |
| `UPSTREAM_ERROR` | External tool/API failed (virsh, GitHub, docker) |
| `INTERNAL` | Unexpected error (see logs) |

Mutations require the matching permission (`vm:write`, `share:write`, `app:install`, ...).
`viewer` can only issue GET requests; every mutation is audited.

## Rate limits and pagination

The appliance API is local and has no rate limit. Large collections accept
`?limit=100&offset=0` where supported and return `{items,total}` in `data`.
