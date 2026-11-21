# Screenshots

`WrexrOS` is a headless appliance; the pictures below are rendered from the actual UI
components in `web/` using demo data. They are checked in as SVG so they remain crisp and
small. CI replaces them with PNG captures from a headless browser on tagged releases.

| Screen | File | Shows |
| --- | --- | --- |
| Dashboard | [dashboard.svg](../screenshots/dashboard.svg) | Live metrics, VM list, array health, events |
| Virtual machines | [vms.svg](../screenshots/vms.svg) | VM table, create wizard, PCI passthrough |
| Storage | [storage.svg](../screenshots/storage.svg) | Parity array, disks, datasets |
| App store | [apps.svg](../screenshots/apps.svg) | Catalog categories and install modal |
| Settings | [settings.svg](../screenshots/settings.svg) | Network and advanced raw config editor |
| Console | [console.svg](../screenshots/console.svg) | First-boot banner and login prompt |

## Capturing real screenshots

Once the appliance or demo stack is running:

```bash
# Dashboard at 1440x900
chromium --headless --disable-gpu --window-size=1440,900 \
  --screenshot=screenshots/dashboard.png https://127.0.0.1:8443/dashboard

# Dark mode is persisted in localStorage; toggle in the UI first.
```

The CI workflow `capture-screenshots` uploads PNGs to the release. Until then the SVG
reference renders are the canonical visual documentation.
