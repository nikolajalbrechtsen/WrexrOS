# `wrexctl` reference

`wrexctl` is the command-line twin of the web UI. It speaks the same REST/WebSocket API,
so anything done in the UI can be scripted.

## Installation

The CLI ships with the appliance at `/usr/local/bin/wrexctl`. For development:

```bash
git clone https://github.com/nikolajalbrechtsen/WrexrOS.git
cd WrexrOS/cli
npm link           # optional; Node 24 is the only requirement
node --experimental-strip-types src/wrexctl.ts --help
```

## Configuration

```bash
wrexctl --url https://wrexr.local:8443 --token "$TOKEN" status
wrexctl login                       # prompts for password (and TOTP if enabled)
wrexctl status --json
```

Config lives in `$XDG_CONFIG_HOME/wrexr/cli.json` (or `~/.config/wrexr/cli.json`) with mode
0600:

```json
{"url":"https://wrexr.local:8443","token":"...","allowInsecure":false}
```

`WREXR_TOKEN` and `WREXR_URL` environment variables override the file. `--insecure` skips
TLS verification for self-signed dev certificates; prefer installing your CA.

## Commands

| Area | Examples |
| --- | --- |
| Overview | `wrexctl status`, `wrexctl events`, `wrexctl audit` |
| VMs | `wrexctl vm list`, `vm create --name x --type kvm --cpu 4 --memory 8192 --disk 80`, `vm start x`, `vm stop x`, `vm snapshot x --name clean`, `vm vnc x`, `vm firewall x` |
| LXC | `wrexctl container list`, `container create --name ct --template debian-12 --cpu 2 --memory 2048`, `container start ct` |
| Storage | `wrexctl storage disks`, `storage array`, `storage sync`, `storage datasets`, `storage snapshot --dataset rpool/data --name daily` |
| Shares | `wrexctl share list`, `share create --name media --path /mnt/array/media --protocol smb --recycle`, `share acl media --user alice --perm rw` |
| Users | `wrexctl user list`, `user create --name alice --roles operator`, `group create --name media` |
| Apps | `wrexctl app catalog`, `app installed`, `app install jellyfin --port 8096:8096`, `app upgrade jellyfin`, `app logs jellyfin`, `app repo add URL --trusted` |
| Settings | `wrexctl settings get network`, `settings set general --file changes.json`, `settings set advanced --key kernelOptions --value '["quiet"]'` |
| Updates | `wrexctl update check`, `update install`, `update status`, `update apps` |
| Operations | `wrexctl alert create --type disk-temp --threshold 50`, `backup list`, `backup create --schedule daily`, `backup run ID`, `plugin list`, `plugin enable ID`, `cluster add URL` |
| Terminal | `wrexctl shell` opens the WebSSH session in the local terminal |

Add `--json` to any command for machine-readable output. Errors print to stderr and exit
with a non-zero status suitable for CI.

## Scripting examples

```bash
#!/usr/bin/env bash
set -euo pipefail
export WREXR_TOKEN="$(cat /run/secrets/wrexr-token)"

# Start all stopped VMs tagged with auto-start (simple jq pipeline)
for id in $(wrexctl vm list --json | jq -r '.data[] | select(.status=="stopped" and .autostart) | .id'); do
  wrexctl vm start "$id"
done

# Fail if a new release exists
wrexctl update check --json | jq -e '.data.updateAvailable == false'
```

## Safety

* Never store an admin token in a world-readable file; the CLI creates its config 0600.
* Give automation a scoped token with only the permissions it needs.
* `--insecure` exists for development only; it disables certificate verification.
