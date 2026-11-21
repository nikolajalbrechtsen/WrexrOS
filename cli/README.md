# wrexctl

Command-line client for the WrexrOS daemon API (v1 contract). Zero npm dependencies: it uses the
Node.js built-ins and runs TypeScript directly with Node 22.6+/24 type stripping.

## Installation

```sh
# From the repository
cd cli
npm link                         # exposes wrexctl on PATH via the bin entry
# or make the launcher executable and symlink it yourself
chmod +x bin/wrexctl
sudo ln -s "$PWD/bin/wrexctl" /usr/local/bin/wrexctl
```

The launcher resolves symlinks before locating `../src/wrexctl.ts`, so linking into
`/usr/local/bin` works. Node.js 22.6+ is required.

Direct invocation (also works on Windows paths):

```sh
node --experimental-strip-types cli/src/wrexctl.ts --help
```

## Configuration

Settings are read from `~/.config/wrexr/cli.json`, or `$XDG_CONFIG_HOME/wrexr/cli.json` when set.
The file is created with mode `0600` and stores:

```json
{
  "url": "https://localhost:8443",
  "token": "…",
  "allowInsecure": false
}
```

Precedence for values: command-line flag → environment variable → config file → default.

| Flag | Environment | Purpose |
| --- | --- | --- |
| `--url` | `WREXR_URL` | Daemon base URL (default `https://localhost:8443`) |
| `--token` | `WREXR_TOKEN` | Bearer token |
| `--insecure` | `WREXR_INSECURE_HTTP=1` | Skip TLS verification / use plain HTTP in dev |
| `--json` | `WREXR_JSON=1` | JSON output |
| `--config PATH` | — | Alternative config file |
| `--no-color` | `NO_COLOR=1` | Plain output |
| — | `WREXR_TIMEOUT_MS` | Per-request timeout (default `15000`) |

Global flags must appear **before** the command (except `--json` and `--no-color`, which are
accepted anywhere). `--insecure` disables certificate verification; use it only on trusted local
networks.

```sh
wrexctl --url https://nas.local:8443 --token "$WREXR_TOKEN" status
wrexctl --config /etc/wrexr/ci-cli.json --json whoami
```

Authenticate once and store the returned token in the config file:

```sh
wrexctl login --password            # hidden prompt when stdin is a TTY
wrexctl login --password "$PASS"    # non-interactive
wrexctl whoami
wrexctl logout                      # also clears the stored token
```

## Output and exit codes

Human-readable aligned tables are the default. `--json` emits the API `data` payload as pretty JSON;
API failures emit `{"ok":false,"error":{"code","message","details"}}`.

| Code | Meaning |
| --- | --- |
| 0 | success |
| 2 | usage / validation error |
| 3 | unauthenticated or forbidden |
| 4 | resource not found |
| 5 | conflict |
| 6 | network or timeout error |
| 1 | other error |

## Command reference

```sh
# Dashboard / identity
wrexctl status
wrexctl --json status

# Virtual machines and LXC
wrexctl vm list
wrexctl vm create --name web --type kvm --cpu 2 --memory 4096 --disk 40 --iso Ubuntu-24.04.iso
wrexctl vm start 103
wrexctl vm stop 103
wrexctl vm reboot 103
wrexctl vm snapshot 103 --name pre-upgrade
wrexctl vm snapshot 103 --list
wrexctl vm vnc 103
wrexctl vm firewall 103
wrexctl vm firewall 103 --rule '{"rules":[]}'
wrexctl vm delete 103

# Containers (backed by the app endpoints in the API contract)
wrexctl container list
wrexctl container create --app nginx-proxy-manager --name proxy --env 'TZ=Europe/Berlin'
wrexctl container start <app-id>
wrexctl container stop <app-id>
wrexctl container delete <app-id>

# Storage
wrexctl storage disks
wrexctl storage array
wrexctl storage array --action scrub
wrexctl storage start
wrexctl storage stop
wrexctl storage sync
wrexctl storage datasets
wrexctl storage datasets --name tank/media --pool tank --compression zstd
wrexctl storage datasets --delete tank/media
wrexctl storage snapshot --dataset tank/media --name nightly
wrexctl storage smart --disk /dev/sda

# Shares, users and groups
wrexctl share list
wrexctl share create --name media --path /mnt/media --disk tank --protocol smb --users alice,bob --recycle
wrexctl share delete <share-id>
wrexctl share acl <share-id> --user alice --permissions rw
wrexctl user list
wrexctl user create --name alice --groups staff,admin     # prompts for password
wrexctl user delete <user-id>
wrexctl group list
wrexctl group create --name staff

# Docker app catalog
wrexctl app catalog
wrexctl app installed
wrexctl app install --app pihole --env 'WEBPASSWORD=<strong-password>,TZ=UTC'
wrexctl app start <app-id>
wrexctl app stop <app-id>
wrexctl app upgrade <app-id>
wrexctl app logs <app-id> --tail 100
wrexctl app repo add --url https://example.com/repo.json --trusted
wrexctl app repo sync

# Settings
wrexctl settings get network
wrexctl settings set general --key hostname --value nas.local
wrexctl settings set network --key dns.servers --value '["1.1.1.1","9.9.9.9"]'
wrexctl settings set advanced --file ./raw-config.json

# Updates and operations
wrexctl update check
wrexctl update install 0.2.0
wrexctl update status
wrexctl update apps
wrexctl audit
wrexctl events
wrexctl alert list
wrexctl alert create --type disk --target /mnt/data --threshold 90
wrexctl backup list
wrexctl backup create --name nightly --schedule '0 2 * * *'
wrexctl backup run <backup-id>
wrexctl plugin list
wrexctl plugin enable <plugin-id>
wrexctl plugin disable <plugin-id>
wrexctl cluster list
wrexctl cluster add --name node2 --address 10.0.0.12
wrexctl cluster remove <node-id>

# Interactive terminal (WebSocket /api/v1/ws/terminal)
wrexctl shell                       # Ctrl-D to exit; Ctrl-C is forwarded to the guest shell
```

Human output redacts fields named `token`, `password`, `secret` or `privateKey`; use `--json` only
in contexts where secrets are expected.

## Scripting

Every mutating command returns the API data payload, so scripts can consume it directly:

```sh
#!/usr/bin/env bash
set -euo pipefail

status="$(wrexctl --json status)"
hostname="$(printf '%s' "$status" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).host.hostname')"

if wrexctl --json update check | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).updateAvailable ? true : false' | grep -q true; then
  wrexctl update install
fi

wrexctl vm create --name "build-$RANDOM" --type lxc --cpu 2 --memory 2048 --disk 20 --json
```

Use `WREXR_TOKEN` from a secret store instead of putting tokens in shell history, and check the exit
code table above for branching. Set `WREXR_TIMEOUT_MS` higher for long-running mutations.

## Development / tests

```sh
npm test
# equivalent direct invocation:
node --experimental-strip-types tests/wrexctl.test.ts
```
