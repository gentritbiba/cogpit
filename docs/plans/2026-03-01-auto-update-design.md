# Auto-Update Design

## Summary

Add automatic update support to Cogpit. Linux AppImage gets silent auto-updates via `electron-updater`. macOS and Linux system-package installs get an in-app notification banner with "Download" and "Don't show again" buttons. Dismissed versions are persisted in Electron userData.

## Architecture

### Platform Matrix

| Platform | Install method | Update mechanism |
|----------|---------------|-----------------|
| macOS | DMG (unsigned) | Notification → opens GitHub release in browser |
| Linux | AppImage | `electron-updater` silent download + install on restart |
| Linux | pacman (AUR) | Notification → "update via your package manager" |

### Detection: How do we know which path to take?

- **AppImage**: `process.env.APPIMAGE` is set at runtime
- **macOS**: `process.platform === "darwin"`
- **System package (pacman)**: Linux + no `APPIMAGE` env var

### Component: `electron/updater.ts`

New module in the electron directory. Responsible for:

1. **AppImage auto-update** — imports `autoUpdater` from `electron-updater`, calls `checkForUpdatesAndNotify()`. electron-updater handles download, progress, and install-on-quit automatically.
2. **Notification check** (macOS + system-package Linux) — fetches `https://api.github.com/repos/gentritbiba/cogpit/releases/latest`, compares tag semver against `app.getVersion()`. If newer and not dismissed, sends update info to the renderer.

### IPC Bridge

Add to `electron/preload.ts`:

```ts
contextBridge.exposeInMainWorld("electronUpdater", {
  onUpdateAvailable: (cb) => ipcRenderer.on("update-available", (_, info) => cb(info)),
  dismissVersion: (version) => ipcRenderer.send("dismiss-update", version),
})
```

Main process listens for `"dismiss-update"` and writes the version to a JSON file in userData (`update-preferences.json`).

### Renderer: Update Banner

A small component rendered at the top of the app (inside the existing layout, below the header). Shows:

- Text: "Cogpit vX.Y.Z is available"
- **macOS**: "Download" button (opens release URL in system browser) + "Don't show again" button
- **Linux system pkg**: "Update via your package manager" text + "Don't show again" button
- **AppImage**: No banner needed (auto-updater handles it). Optionally show "Update ready — restart to apply" after download completes.

### Persistence: `update-preferences.json`

Stored in `app.getPath("userData")`:

```json
{
  "dismissedVersion": "0.2.0"
}
```

On startup, if the latest release matches `dismissedVersion`, skip the notification. When a *newer* version than the dismissed one appears, the notification shows again.

### electron-builder changes

In `electron-builder.yml`, add:

```yaml
publish:
  provider: github
  owner: gentritbiba
  repo: cogpit
```

For macOS, also add `zip` target (required by electron-updater for AppImage-style updates if we ever add code signing later):

```yaml
mac:
  target:
    - target: dmg
    - target: zip
```

### CI changes

Change `--publish never` to `--publish always` for the Linux AppImage build so electron-builder uploads `latest-linux.yml` alongside the AppImage. macOS and pacman keep `--publish never` (artifacts uploaded manually via `softprops/action-gh-release`).

Actually — simpler: change all builds to `--publish always` and remove the manual artifact upload step entirely. electron-builder will upload everything to the GitHub release directly. This also generates the `latest-mac.yml` and `latest-linux.yml` metadata files that electron-updater needs.

### Check frequency

Check once on app startup (after a 5-second delay to not block launch). No periodic polling — users restart the app often enough.

## Dependencies

- Add `electron-updater` as a production dependency

## Files Changed

| File | Change |
|------|--------|
| `package.json` | Add `electron-updater` dependency |
| `electron-builder.yml` | Add `publish` config, add `zip` to mac targets |
| `electron/updater.ts` | **New** — update checker + auto-updater logic |
| `electron/preload.ts` | Add IPC bridge for update notifications |
| `electron/main.ts` | Import and initialize updater after window creation |
| `src/components/UpdateBanner.tsx` | **New** — notification banner component |
| `src/App.tsx` or layout | Render UpdateBanner |
| `.github/workflows/release.yml` | Switch to `--publish always`, simplify artifact upload |
