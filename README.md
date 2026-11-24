**English** · [简体中文](README.zh-CN.md)

# Quark Note Sync

Sync Obsidian notes, canvases, and attachments through Quark Drive between Windows and Android. Each device connects to Quark directly over HTTPS.

The plugin uses Quark Drive's unofficial web API. Changes to that API or to account permissions may interrupt sign-in or sync. Android behavior depends on Obsidian's native HTTPS support and should be verified on your device.

## Features

- Sync Markdown notes, Canvas files, and ordinary attachments up to 10 MiB per file.
- Preview the first sync and confirm it manually before any sync changes are applied.
- Enable sync when Obsidian opens, periodic sync, or both. Both settings are off by default. Startup sync runs once after the vault loads. Periodic sync defaults to every five minutes while Obsidian is open.
- Sign in by QR code on Windows and import an encrypted authorization code on Android. Manage the saved session in the Quark account section of the plugin settings.
- Preserve concurrent edits as local conflict copies. The vault's Obsidian configuration and conflict copies are excluded from sync.

## Install

1. Download the ZIP from [GitHub Releases](https://github.com/18030838922/quark-note-sync/releases/latest) and extract it.
2. Copy the extracted `quark-note-sync` folder into `<vault>/.obsidian/plugins/`. Its `manifest.json` and `main.js` should sit directly inside that folder. On Android, use the folder for the vault Obsidian has actually opened. Your file manager may need to show hidden files.
3. In Obsidian Settings → Community plugins, turn off Restricted mode if needed and enable **夸克笔记同步**.

Requires Obsidian 1.11.4 or later. To update a manual installation, replace `manifest.json` and `main.js`, keep any existing `data.json`, and reload Obsidian.

## Set up sync

1. On Windows, open Settings → **夸克笔记同步**. Select **扫码登录** and scan the QR code with the Quark app. The plugin verifies the account and drive access before saving the session.
2. Set a dedicated top-level Quark Drive folder for this vault. Use the same folder on both devices and a separate folder for every other vault.
3. Select **预览同步变化** to preview changes, then select **立即同步夸克** and confirm the first sync. This first sync can create the target folder if needed.
4. Once the target folder exists, select **导出到手机** on Windows and set a password of at least 12 characters. On Android, select **导入电脑授权**, paste the code, and enter the same password. A code expires after 15 minutes. Import validates the account and target folder. Complete the first sync on Android separately.
5. Once the first sync is complete on a device, you can enable **打开 Obsidian 时同步** or **自动同步** in its plugin settings.

If a session expires, scan again on Windows or import a fresh authorization code on Android. Signing out clears the session on the current device and keeps its sync history. Advanced settings offer manual Cookie entry.

## Data and conflict handling

- The plugin stores the Quark session in Obsidian SecretStorage. It sends the session only to allowed Quark HTTPS endpoints. The session and pairing password are excluded from plugin settings, sync data, and logs.
- The mobile authorization code is encrypted on the device using PBKDF2-SHA256 and AES-256-GCM. It contains the session and target folder information. Share the code and its password through separate channels.
- Concurrent versions can produce files under `.quark-sync-conflicts/`. Concurrent edits and deletes preserve the edited content. Synced local deletions use the vault's `.trash` folder where available.
- The plugin appends version records in the configured Quark Drive folder. Cloud history is retained.

## Build and test

Use Node.js 24 and npm.

```sh
npm ci
npm run check
npm run build
```

On Windows, `npm run package` runs the checks, builds the plugin, and creates `dist/quark-note-sync-<version>.zip` using Windows PowerShell. Automated tests use simulated requests. Live account and Android network behavior require testing on a real device.

## License

[MIT](LICENSE). The bundled dependency licenses are listed in [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES).
