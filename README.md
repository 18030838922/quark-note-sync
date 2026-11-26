**English** · [简体中文](README.zh-CN.md)

# Quark Note Sync

Sync Obsidian notes, canvases, and attachments through Quark Drive on Windows, Android, and iOS/iPadOS. Each device connects to Quark directly over HTTPS.

The plugin uses Quark Drive's unofficial web API. Changes to that API or to account permissions may interrupt sign-in or sync. Mobile sync uses Obsidian's native HTTPS bridge and should be verified on your device.

## Features

- Sync Markdown notes, Canvas files, and ordinary attachments. File transfers depend on available device memory and Quark Drive limits. Update the plugin on every device before syncing files larger than 10 MiB because earlier versions reject their sync records.
- Preview the first sync and confirm it manually before any sync changes are applied.
- Enable sync when Obsidian opens, periodic sync, or both. Both settings are off by default. Startup sync runs once after the vault loads. Periodic sync defaults to every five minutes while Obsidian is open.
- Sign in by QR code on Windows, Android, or iOS/iPadOS. Mobile devices can also import an encrypted authorization code. Manage the saved session in the Quark account section of the plugin settings.
- Preserve concurrent edits as local conflict copies. The vault's Obsidian configuration and conflict copies are excluded from sync.

## Sync dashboard

Select the cloud icon in the left ribbon or run **Open sync dashboard** to show the dashboard in the left sidebar. Run a sync, review and confirm the first-sync preview, or adjust automatic sync directly in that tab. The sidebar also shows the latest sync results, Quark Drive capacity, vault usage by file type, and the five largest files.

Vault usage comes from the file sizes Obsidian has indexed. The dashboard does not read note contents. Quark storage is account-wide and is shown only when the drive reports valid totals.

- **Sync scope** lets you include folders and file extensions and set an optional size limit on this device. Preview which paths would be included before saving. Files outside the scope stay where they are. Re-including a path resumes sync using its saved history.
- The dashboard shows the current file and transfer progress. Upload progress updates per completed part. On mobile, download progress updates when the native bridge returns the file. To retry a failed path, select **Retry file** in the sync details. The plugin rechecks the current local and cloud versions before retrying that file.
- Right-click a synced file and choose **View Quark version history**. You can compare earlier text versions with the current note, restore a copy, or explicitly restore at the original path. Use **Version history** on the dashboard to find files deleted through sync.

### On-demand attachments and conflict resolution

Open **Offline storage** and turn on **Download attachments on demand** on the devices where you want to save space. After a sync, new cloud-only attachments appear in the panel with their filename and size. In a note’s Reading View, unresolved links to those attachments also show a download button. Use **Keep offline** to download and pin a file. The panel lists the space used by managed local copies, related notes, and when each copy was last opened. Local removal preserves the cloud file and is available for unchanged copies.

Multipart uploads keep confirmed parts on this device in Obsidian’s secret storage. Retrying identical content under the same account and destination resumes those parts when Quark still recognizes the upload task. An expired task restarts. Downloads retry from the beginning.

Open **Resolve conflicts** to compare local content with the active cloud versions. You can keep one version or choose sections of a text merge. Confirming writes a new sync version linked to the reviewed branches, so earlier versions remain available in history.

## Use Quark files in notes

Right-click in a note and select **Insert Quark Drive file**. You can also run it from the command palette on desktop or mobile. Browse your drive, then choose **Insert link only** or **Download to vault and insert**. Both actions write the same Markdown link. The private link opens on another device after you sign in with the same Quark account.

In Reading View and Live Preview, personal images and audio load when their links come into view. For images, the plugin first tries Quark’s image preview, which can work when downloading the original fails. PDF and plain-text links open in a main workspace tab. On mobile, the PDF preview supports page jumps, zoom, and fit-to-width. Reopening a PDF restores its reading position on the same device.

For personal videos and supported public shares, select **Play from Quark** to stream the video in Obsidian. Streaming can play videos larger than 50 MiB and lets you seek while the player loads segments. Windows playback has been verified. Android and iOS/iPadOS playback still needs device testing. If the player or stream is unavailable, you can open Quark to watch.

Paste an official `pan.quark.cn` share URL to browse shared folders, enter a passcode when required, and preview supported images, PDFs, and videos. Buffered previews are limited to 20 MiB for images and documents and 50 MiB for audio or video. Original-file downloads depend on Quark’s access rules.

**Download to vault and insert** saves a local copy in `Quark Downloads/`. Personal downloads are capped at 100 MiB. The plugin uses that copy when available and syncs the note with its Quark link. It excludes files it downloaded and tracks from Quark sync, while ordinary attachments in the same folder remain eligible for sync. Save a copy to a regular attachment folder and link to it if you want to edit and sync the file itself.

In the personal Drive browser, search by filename under the current folder or across the drive. Searches read folder pages in batches. You can continue if the first batch does not cover the whole scope. Favorite folders and recent folders are saved on this device for the current Quark account.

Open **Quark references** from the dashboard to see which notes link to Quark and which references have local copies. Check links on demand and choose a replacement file for a selected reference. An unavailable account, missing passcode, or request failure can leave a link unverified.

## Install

1. Download `main.js`, `manifest.json`, and `styles.css` from [GitHub Releases](https://github.com/18030838922/quark-note-sync/releases/latest).
2. Put the three files directly inside `<vault>/.obsidian/plugins/quark-note-sync/`. Use the vault Obsidian has actually opened. On iOS/iPadOS, the Files app does not show hidden folders. See [how to access the configuration folder](https://obsidian.md/help/Files%2Band%2Bfolders/Configuration%2Bfolder) for manual installation.
3. In Obsidian Settings → Community plugins, turn off Restricted mode if needed and enable **Quark Note Sync**.

Requires Obsidian 1.11.4 or later. To update a manual installation, replace the three release files, keep any existing `data.json`, and reload Obsidian.

## Set up sync

The plugin settings default to Simplified Chinese. Open the plugin’s settings and select **English** in the language dropdown at the top of the page.

1. On Windows or a mobile device, select **Sign in with QR code** and confirm the login in the Quark app. For same-device sign-in, capture the QR code and use the scanner’s album picker if available. Return to the open Obsidian login window after confirming. The plugin verifies the account and drive access before saving the session.
2. Set a dedicated top-level Quark Drive folder for this vault. Use the same folder on both devices and a separate folder for every other vault.
3. Select **Preview sync changes** to preview changes, then select **Sync now** and confirm the first sync. This first sync can create the target folder if needed.
4. To use a pairing code as an alternative, wait until the target folder exists, then select **Export to phone** on Windows and set a password of at least 12 characters. On the mobile device, select **Import desktop authorization**, paste the code, and enter the same password. A code expires after 15 minutes. Import validates the account and target folder. Complete the first sync on each mobile device separately.
5. Once the first sync is complete on a device, you can enable **Sync when Obsidian opens** or **Periodic sync** in its plugin settings.

If a session expires, scan a fresh QR code or import a fresh authorization code on your mobile device. Signing out clears the session on the current device and keeps its sync history. Advanced settings offer manual Cookie entry.

## Data and conflict handling

- The plugin lists the vault’s registered files to plan sync and calculate storage usage. It filters out the active Obsidian configuration folder, local conflict copies, and tracked Quark downloads when planning sync.
- To copy a mobile authorization code, choose **Select authorization code**, then use your system’s copy command. The plugin does not access the clipboard.
- The plugin stores the Quark session in Obsidian SecretStorage. It sends the session only to allowed Quark HTTPS endpoints. The session and pairing password are excluded from plugin settings, sync data, and logs.
- The mobile authorization code is encrypted on the device using PBKDF2-SHA256 and AES-256-GCM. It contains the session and target folder information. Share the code and its password through separate channels.
- Concurrent versions can produce files under `.quark-sync-conflicts/`. Concurrent edits and deletes preserve the edited content. Synced local deletions use Obsidian's configured file deletion preference.
- The plugin appends version records in the configured Quark Drive folder. Cloud history is retained.

## Build and test

Use Node.js 24 and npm.

```sh
npm ci
npm run check
npm run build
```

On Windows, `npm run package` runs the checks, builds the plugin, and creates `dist/quark-note-sync-<version>.zip` using Windows PowerShell. Automated tests use simulated requests. Live accounts and native network behavior must be tested on real devices. The iOS/iPadOS transport is covered with simulated bridge responses and has not yet been verified on a physical device.

## License

[MIT](LICENSE). The bundled dependency licenses are listed in [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES).
