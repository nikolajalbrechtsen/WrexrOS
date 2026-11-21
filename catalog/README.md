# WrexrOS app catalog

`index.json` is the signed, built-in Docker app template catalog served by the daemon at
`GET /api/v1/apps/catalog`. `example-custom-repo.json` shows the same shape for a community repo.

## Template format

Each entry in `apps[]` uses these fields:

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | Stable lowercase slug, unique across all repos |
| `name` | string | Display name |
| `category` | string | One of `networking`, `media`, `productivity`, `databases`, `monitoring`, `security`, `storage` |
| `description` | string | Short human-readable summary |
| `version` | string | Template / pinned image version |
| `icon` | string | Emoji or inline SVG path data |
| `image` | string | Fully qualified container image with tag |
| `dockerHub` | string | Source image page |
| `tags` | string[] | Search keywords |
| `ports` | `{container,host,protocol}[]` | Port mappings; `protocol` is `tcp` or `udp` |
| `volumes` | `{container,host,mode}[]` | `mode` is `rw` or `ro` |
| `env` | `{name,default,description,required}[]` | `default` is `""` for secrets; never ship default passwords |
| `limits` | `{cpus,memory}` | CPU count and memory limit such as `512m` or `2g` |
| `capabilities` | string[] | Linux capabilities, keep minimal |
| `trusted` | boolean | Official, signed templates are `true` |
| `signature` | string | Base64 Ed25519-style signature over the canonical template |
| `repo` | string | Repository slug (`wrexr-official` for built-ins) |
| `homepage` | string | Project homepage |
| `updateAvailable` | boolean | Set by the daemon after checking image tags |

Example minimal entry:

```json
{
  "id": "my-app",
  "name": "My App",
  "category": "productivity",
  "description": "Example only",
  "version": "1.0.0",
  "icon": "🧩",
  "image": "example/my-app:1.0.0",
  "dockerHub": "https://hub.docker.com/r/example/my-app",
  "tags": ["example"],
  "ports": [{ "container": 8080, "host": 18080, "protocol": "tcp" }],
  "volumes": [{ "container": "/data", "host": "/mnt/docker/apps/my-app", "mode": "rw" }],
  "env": [
    { "name": "ADMIN_PASSWORD", "default": "", "description": "Choose a strong password", "required": true }
  ],
  "limits": { "cpus": 1.0, "memory": "512m" },
  "capabilities": [],
  "trusted": false,
  "signature": "<base64 ed25519 signature>",
  "repo": "my-repo",
  "homepage": "https://example.invalid/my-app",
  "updateAvailable": false
}
```

Security rules:

* Pin image tags (or digests) — no floating `latest` in official templates.
* Never include default passwords, API keys or auth tokens. Secret env entries use `default: ""`
  and `required: true` so installation fails until the user supplies a value.
* Request the smallest capability set; avoid `privileged` equivalents.

## Custom repos

Add a repository through the CLI:

```sh
wrexctl app repo add --url https://example.com/wrexr-repo.json --trusted
wrexctl app repo sync
wrexctl app catalog
```

A repo file is an object with `name`, `description`, `maintainer`, `version`, `signature` and
`apps[]`, where each app uses the template format above. The repo `signature` signs the canonical
manifest; each app may also carry its own `signature`. `wrexctl app repo add --trusted` is only for
repos whose signing key has been enrolled in `/etc/wrexr/trusted-repos.gpg`.

### Trusted vs community

| | Trusted | Community |
| --- | --- | --- |
| `trusted` | `true` | `false` |
| Signature | Signed by WrexrOS release key or enrolled repo key | May be unsigned or self-signed |
| Install UI | No warning | Explicit warning and capability review |
| Default ports | Checked for host conflicts | Checked, plus confirmation |
| Auto-updates | Allowed | Opt-in per app |

Community templates are useful but run code from third parties. Review image source, capabilities,
volume paths and environment variables before installing.

## Submission process

1. Fork the WrexrOS repository and add your template to `catalog/index.json` (or publish a signed
   custom repo and open an issue with its URL).
2. Keep IDs stable and unique; bump `version` for every change.
3. Include a pinned image, minimal capabilities, safe defaults and a no-secret env policy.
4. Explain why new host mounts or capabilities are needed in the pull request.
5. A maintainer verifies the signature, image provenance and documentation, then merges. Signed
   official templates are set to `trusted: true`; community entries remain `trusted: false`.

See `example-custom-repo.json` for a complete two-app repository with signature fields.
