# Updating and recovering plugins

Plugins belong to the connected Cogpit host. Installing, updating, disabling or uninstalling affects every client and enabled project on that host. Fresh hosts start with no optional plugins installed; existing hosts preserve their integrations during migration. Removing a plugin records that choice so a later app update does not reinstall it.

## Updates and rollback

Updates are manual. In Plugins, use **Update from file**, choose a signed `.cogpit-plugin` package and review its exact version, publisher, access changes, credential destinations and project scope. Packages from outside a Cogpit release are signed with the `cogpit-plugin` CLI (`packages/plugin-tools`); enroll their publisher once under **Publishers** with the root file and the fingerprint you obtained separately, then install with **Install from file**. A file selected for one installed plugin cannot replace a different plugin. Unpin the current version before changing versions.

The candidate first runs in a provisional frame without provider, storage or composer access. Only a successful readiness check selects it on the host. A failed check leaves the current version selected. If the connection drops during promotion, reconnect and inspect Installed before trying again.

Expand **Projects and previous versions** to review a rollback. Cogpit retains up to eight versions, including the selected version and its immediate predecessor. Rollback keeps current settings and connections, including changes made after an update. Version 1 refuses packages whose state schema differs from retained data, including data belonging to unopened projects or other administrators.

A previously verified retained version can be restored while offline after catalog metadata expires. A known revocation still blocks that version. New signed installations require valid, unexpired metadata. An offline host cannot discover revocations it has not received.

The review warns about incompatible clients currently connected to the host. This list uses coarse app/API versions and contains no user identities. Offline clients are checked when they reconnect. Each client and host must satisfy the package's declared compatibility requirements.

## Disable, uninstall and saved data

**Disable** stops execution while retaining the package and all settings. **Uninstall** removes the installation from the host and keeps data by default. The confirmation offers **Delete my saved settings and connections on this host** as an explicit additional choice.

Deletion applies to the current administrator's plugin data across projects. It does not delete another administrator's records, revoke tokens at a provider, remove environment variables or remove legacy backup files. Once the host records the deletion decision, it completes that decision after a restart if interrupted. Reinstallation waits until pending deletion finishes.

## Safe mode and damaged files

**Pause plugins in this browser** stops this browser's plugin panels immediately. **Resume plugins in this browser** starts fresh activations. This browser setting does not disable packages for other connected clients. The equivalent URL option is `?pluginSafeMode=1`.

To stop execution for the entire host, launch Cogpit with `COGPIT_DISABLE_PLUGINS=1`. Core Cogpit and the Plugins manager remain available so an administrator can disable or uninstall packages. Restart the host without that environment setting to resume execution.

A damaged retained package is quarantined and its selected plugin is disabled; other valid packages remain usable. Use another verified retained version, or review a repair from the bundled package when available. A signed file with the exact verified bytes can also repair the package. Repair preserves the damaged entry for inspection and keeps the plugin disabled until explicitly enabled.

If the registry, trust records or transaction journal cannot be read safely, Cogpit leaves the store intact and stops plugin management. A newer store format requires the Cogpit version that last wrote it or a compatible newer version. A store lock requires closing the other process using that data directory. Do not delete the store to clear either error; retain the host log and restore a verified backup only after identifying the cause.

Runtime data lives under `<host-data-root>/runtime-plugins`; private connections live in the sibling `runtime-plugin-connections` directory. Returning to a Cogpit release older than the first runtime-plugin release requires the explicit legacy backup/restore procedure. New runtime settings are not written back into legacy configuration files.

Browser requirements and the distinction between documented feature floors and executed platform checks are in [browser support](runtime-plugin-browser-support.md). This documentation describes the local rollout implementation; public release and Windows CI verification are recorded in the [implementation plan](plans/2026-09-14-runtime-plugins.md).
