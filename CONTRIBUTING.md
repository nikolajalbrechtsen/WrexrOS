# Contributing to WrexrOS

Thanks for helping build the appliance. A few rules keep the project reviewable and safe.

## Before you start

* Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and
  [docs/API_CONTRACT.md](docs/API_CONTRACT.md).
* Check the issue tracker on the canonical repository to avoid duplicate work.
* For large features, open an issue first describing the user-facing behaviour.

## Development loop

```bash
node --experimental-strip-types --test core/tests/*.test.ts
node --experimental-strip-types --test cli/tests/*.test.ts
node web/build.mjs
node installer/validate-config.mjs installer/examples/unattended-standard.json
```

No npm dependencies are required for development. Node 24+ is the only host tool needed
for tests and the web build. ISO builds require Docker on Linux.

## Coding rules

1. **No shell injection.** Use `execFile` (or explicit argument arrays in bash) with
   allowlists. Never concatenate user input into a shell string.
2. **No new runtime dependencies** in `core/`, `cli/` or `web/` without an architecture
   decision record. The small ISO is a product goal.
3. **Contract first.** If you add an endpoint, update `docs/API_CONTRACT.md` in the same
   commit and keep the UI/CLI in sync.
4. **Fail safely.** Destructive installer steps need a `--dry-run` equivalent and explicit
   confirmation.
5. **Audit everything.** Any mutation must produce an audit entry and an event.
6. **Tests for behaviour.** Add a node:test case for each new endpoint or service branch.

## Commits and releases

* Use clear imperative commit messages (`Add ZFS dataset snapshots`, `Fix TOTP replay`).
* Add a `CHANGELOG.md` entry under **Unreleased**.
* Release commits bump `VERSION` and are tagged `vX.Y.Z` by CI.
* Never commit secrets, passwords, private keys or generated state.

## Reporting bugs

Include version (`wrexctl status --json`), hardware, steps to reproduce, expected vs actual
behaviour, and relevant logs (`journalctl -u wrexrd -n 200`). Security issues must go through
the private advisory flow in [SECURITY.md](SECURITY.md).
