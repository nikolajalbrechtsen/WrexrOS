# Security policy

WrexrOS is an appliance that owns hypervisor, storage and identity duties. Treat it as
security-critical infrastructure.

## Reporting a vulnerability

Please open a private security advisory on
[GitHub](https://github.com/nikolajalbrechtsen/WrexrOS/security/advisories/new)
or email `security@wrexros.local` (replace with a maintained inbox before public release).
Do **not** disclose exploit details in a public issue before a fix is released.

We aim to acknowledge reports within 72 hours and ship a patch or mitigation within
14 days for confirmed issues in the supported release channel.

## Supported versions

| Channel | Version | Security fixes |
| --- | --- | --- |
| stable | 0.1.x | Yes |
| beta | 0.2.x-preview | Best effort |

## Secure defaults

* No default password. First boot requires the setup wizard to set a root password
  and/or install an SSH key.
* TLS is enabled by default on port 8443 with a generated self-signed certificate.
  Replace it with your own certificate (or Let's Encrypt via the reverse proxy) for
  production.
* The web UI, REST API and `wrexctl` share one RBAC model. `viewer` is read-only.
* Every administrative mutation is written to an append-only audit log.
* Updates are verified against `SHA256SUMS` and, when a trust key is installed, a
  detached GPG signature before being applied.
* Daemon runs as an unprivileged `wrexr` user with systemd sandboxing; privileged
  helper calls are restricted through a narrow sudoers drop-in.
* Command execution uses `execFile` with argument arrays and explicit allowlists —
  never shell string interpolation of user input.

## Hardening notes

1. Put the management interface on a dedicated VLAN or management network.
2. Enable 2FA in **Settings → Users & access** before exposing the UI beyond LAN.
3. Rotate API tokens regularly and give automation the narrowest role possible.
4. Keep automatic security updates enabled unless you have a tested maintenance window.
5. Back up `/etc/wrexr` and `/var/lib/wrexr` together with the ZFS root pool.
