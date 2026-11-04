# Video Downloader

A dependency-free Chrome extension (Manifest V3) that finds videos and audio on
the pages you visit and saves direct media files to your computer.

It combines **DOM detection** (media elements, links, metadata, JSON-LD, lazy
attributes) with **network observation** (`chrome.webRequest`) so media loaded by
JavaScript players is still discovered. Detection and download management run
in your browser. Optional ad content and aggregate ad/credit totals use the
website API only when its URL is configured in Settings.

Finds media on YouTube, TikTok, and most video sites. YouTube media is detected,
but direct downloads are disabled because its requests can be separate audio/video
tracks or partial data rather than a complete file.

## Features

- **Detection from two directions**
  - `<video>` / `<audio>` / `<source>` elements and media links
  - OpenGraph, Twitter Player and `itemprop` metadata
  - JSON-LD `VideoObject` / `AudioObject` entries
  - Lazy-load `data-*` attributes and Performance API resource entries
  - Network requests for common video, audio, HLS and DASH URLs
- **Merged, deduplicated results** with titles, posters, duration, resolution,
  file size when available (otherwise marked unavailable) and per-format quality options
- **One-click downloads** through `chrome.downloads`, with conflict-safe naming
- **Download history** with live progress, cancel, open file, show in folder,
  redownload and JSON export
- **Custom file names** using `{title}`, `{quality}`, `{format}`, `{ext}`,
  `{domain}`, `{date}`, `{time}` and `{timestamp}`
- **Settings** for detection, overlay, badge, notifications, default quality,
  preferred format, folder, history size, theme, support URL and optional website API
- **Support link** configurable in Settings, plus a one-click page URL copy for
  yt-dlp
- **Light / dark / system theme** across the popup, settings and history pages
- **HLS/DASH discovery** with variant quality lists, encryption detection and
  playlist export (see [limitations](#what-it-cannot-do))

## Install (unpacked)

1. Download or clone this folder.
2. Open `chrome://extensions` in Chrome (or any Chromium browser with MV3 support).
3. Turn on **Developer mode** (top-right).
4. Click **Load unpacked** and select the project folder — the one containing
   `manifest.json`.
5. Pin **Video Downloader** to the toolbar.

After changing any extension file, click the reload button on the extension card
and refresh the web page you are testing.

> Requires Chrome 102 or newer. No build step, no `npm install`, no generated
> bundles.

## Usage

1. Open a page that plays a video or audio file.
2. If the media is lazy-loaded, press play first.
3. Click the toolbar icon (or the floating media pill on the page).
4. Pick a quality/format chip if more than one is available.
5. Click **Download**.

The popup shows only media it can see; if the list is empty, press the refresh
button to rescan the page. YouTube detections show a warning instead of a
download button; use YouTube's built-in download option where available.

### Streams (HLS/DASH)

Streams are marked **Playlist only**. They are not saved as a single video
because that requires downloading and muxing many segments. For these items you can:

- **Copy link** and open it in VLC, ffmpeg or yt-dlp.
- **Copy page URL for yt-dlp** from the popup and pass the copied page URL to
  yt-dlp when a site requires page context.
- **Save playlist** to download the `.m3u8` / `.mpd` manifest itself. Relative
  HLS segment URLs are rewritten as absolute URLs so the file is portable.

## What it cannot do

- **DRM-protected media** (Netflix, Disney+, Prime Video, Spotify and similar)
  cannot be downloaded. The extension detects the stream, but decryption is out
  of scope and is not implemented.
- **HLS/DASH are not merged into MP4.** No muxer is bundled. Use VLC, ffmpeg or
  yt-dlp for adaptive streams.
- **YouTube files cannot be downloaded directly.** YouTube often serves separate
  audio/video tracks or partial requests, so the extension disables direct
  downloads rather than saving an incomplete or incorrect file.
- **Segment-level downloads are not offered.** `.ts`, `.m4s`, init and fragment
  URLs are filtered out so the list stays useful.
- **Sites that require special headers** (for example a `Referer` check) may
  reject the browser download with `403` even though the video plays. The
  extension cannot attach arbitrary headers to `chrome.downloads` requests.
- **Browser pages and local files** (`chrome://`, `edge://`, `file://`, extension
  pages) cannot be inspected.
- **Post-processing and conversion** (extracting audio, changing containers) are
  not included.

Only download media you have the right to save. Respect each site's terms and
applicable copyright law.

## Website services deployment

The static website is under `public/`; its admin dashboard and PHP API require a
PHP 8.1+ host with PDO MySQL enabled and a MySQL database. The API creates its
tables on first request, so the configured database account needs permission to
create tables and perform normal CRUD operations. Serve the site over HTTPS.

Configure these environment variables in the PHP hosting environment (do not
put real secrets in source control):

| Variable | Purpose |
| --- | --- |
| `VD_DB_HOST` | MySQL server hostname |
| `VD_DB_NAME` | Database name |
| `VD_DB_USER` | Database username |
| `VD_DB_PASSWORD` | Database password |
| `VD_ADMIN_SETUP_TOKEN` | One-time secret required to create the first admin |

Set a long, random `VD_ADMIN_SETUP_TOKEN`, then open `/admin.html` and create the
administrator with that token. Once setup succeeds, remove the setup token from
the server environment; the existing admin can still sign in. The setup route
is also locked after an admin has been created.

In the extension, open **Settings → Website services** and enter the deployed
API URL, for example `https://example.com/api/index.php`. An empty URL disables
the website ad service; requesting an ad then returns an explicit configuration
error. The extension stores its ad unlock and remaining-download credits
locally. Admin **Credits used** is a website-wide aggregate counter, not a
per-user balance.

Ad impressions, completed views, clicks and credits used are sent as aggregate
counters to this API. The extension does not send media files, media URLs, page
URLs or download filenames. Browser-local admin credentials/statistics from
older extension versions are not migrated to the website database. See
[Privacy](public/privacy.html) for the disclosure and deployment considerations.

## File structure

```
videolink/
├── manifest.json               # MV3 manifest, permissions, entry points
├── background/
│   └── service-worker.js       # network sniffing, merging, routing, badges
├── content/
│   ├── video-detector.js       # DOM/media detector (classic content script)
│   ├── content.js              # message bridge + floating overlay
│   └── content.css             # scoped overlay styles
├── popup/
│   ├── popup.html              # toolbar popup markup
│   ├── popup.css               # popup theme and layout
│   └── popup.js                # detection list, formats, download actions
├── options/
│   ├── options.html            # settings page
│   ├── options.css
│   └── options.js              # auto-saving settings and previews
├── history/
│   ├── history.html            # download history page
│   ├── history.css
│   └── history.js              # filtering, progress, export, actions
├── scripts/
│   ├── url-validator.js        # URL/media classification and validation
│   ├── format-detector.js      # HLS/DASH parsing and format selection
│   ├── video-parser.js         # canonical media normalization and merging
│   └── download-manager.js     # downloads, filenames, history tracking
├── utils/
│   ├── constants.js            # shared constants and defaults
│   ├── helpers.js              # formatting, sanitizing, template helpers
│   ├── storage.js              # chrome.storage wrappers and data model
│   └── messaging.js            # timeouts, message routing, injection
├── public/
│   ├── api/index.php           # PHP/MySQL website services API
│   ├── admin.html              # website admin dashboard
│   ├── privacy.html            # privacy disclosure
│   ├── releases.html           # product release notes
│   └── index.html              # product landing page
├── lib/
│   └── README.md               # reserved for optional vendored libraries
├── assets/
│   ├── icons/                  # icon16/32/48/128.png
│   └── images/logo.png
├── README.md
├── LICENSE
└── .gitignore
```

## How it works

### 1. Detection

The service worker observes requests matching `MEDIA_URL_PATTERNS` and all
requests the browser classifies as `media`. Response headers enrich entries with
MIME type and `Content-Length`; responses that turn out to be HTML/JSON are
discarded. Per-tab findings live in memory and are mirrored to
`chrome.storage.session`.

Content scripts scan the page at load, on DOM mutations (debounced), and when
the popup asks for a rescan. Detections are normalized by
`scripts/video-parser.js` before they are merged with network findings.

### 2. Normalization and formats

Every item is reduced to a predictable shape (`url`, `kind`, `type`, `title`,
`pageUrl`, `variants`, `formats`, …). `buildFormats()` produces selectable
formats, sorts them best-first and marks adaptive manifests as
`requiresExternal`. HLS master playlists are parsed with regex in the service
worker because `DOMParser` is unavailable there.

### 3. Downloading

Direct files are passed to `chrome.downloads.download()`. Conflicts are
resolved with `uniquify`, and an invalid-filename failure is retried once with a
safe fallback name. Progress events update the history entry and are broadcast
to open extension pages; storage writes are throttled to about once per second
while progress is running.

### 4. Storage

| Key | Area | Purpose |
| --- | --- | --- |
| `vd_settings` | `local` | user preferences |
| `vd_history` | `local` | download records (bounded by history limit) |
| `vd_tab_media` | `session` | per-tab detection cache |
| `vd_download_map` | `session` | Chrome download id → history id |
| `vd_activity` | `local` | Capped activity timeline (no media URLs) |

History mutations are serialized through an in-memory promise queue so bursts
of progress events cannot overwrite each other.

Activity records contain event metadata and hostnames only; they do not store
full media URLs or page secrets.

## Permissions

| Permission | Why it is needed |
| --- | --- |
| `activeTab` | Inspect the current tab when you click the toolbar icon. |
| `clipboardWrite` | Copy a media, stream or page link in the popup. |
| `downloads` | Save files, show progress, cancel, open and reveal downloads. |
| `notifications` | Optional "download complete" system notification. |
| `scripting` | Inject the detector into a tab that was already open before install/reload. |
| `storage` | Settings, history and the session cache. |
| `tabs` | Read the tab title/URL, track tabs, and set per-tab badges. |
| `webRequest` | Observe media requests. Observation only — requests are never blocked or modified. |
| `<all_urls>` | Detect media on any http(s) site, fetch HLS/DASH manifests, and inject content scripts. |

## Privacy

- Detection results, settings, download history, activity and ad-unlock state
  stay in `chrome.storage` on your device.
- If an API URL is configured, the extension retrieves ad content and sends
  aggregate impression, completion, click and credit-use counters to that
  website. Those requests do not include media files, media URLs, page URLs,
  filenames or an extension account identifier.
- Website administrators can manage ad content and see aggregate totals. Admin
  email/password hash and advertisement content are stored in the website's
  MySQL database; the operator's host may also retain ordinary access/error logs.
- Manifest files are fetched directly from the media URL you are viewing (using
  the browser's normal cookies/credentials) so their variant lists can be shown.
- Downloaded files go through Chrome's regular download pipeline.
- Removing a history entry does **not** delete the file from disk.
- Read the website's [privacy notice](public/privacy.html) before configuring its
  optional API.

## Troubleshooting

**No media found**

- Press play, then hit the popup's refresh button.
- Reload the page after installing or reloading the extension; content scripts
  are only injected automatically into pages loaded afterwards.
- The page may use DRM, canvas/WebRTC playback, or a format the extension does
  not recognize.

**A download fails immediately**

- Check the file-name template in Settings. Reserved characters are stripped,
  but an empty or unusual template can still produce an invalid path.
- The server may require a signed URL, cookies or a `Referer` header.
- A complete error message is shown in **History**.

**The badge/overlay is missing**

- Enable **Show count badge** / **Show floating media indicator** in Settings.
- The overlay is only shown on the top frame and can be dismissed per tab.

**History says "Downloading" but nothing happens**

- Open `chrome://downloads` to see Chrome's own state.
- Cancel from History, then retry. Extremely large files may take a moment to
  report their total size.

## Development

The extension is purposefully plain JavaScript:

- The service worker and extension pages use ES modules.
- Content scripts are classic IIFEs, because MV3 content scripts do not support
  static `import`.
- No framework, bundler or runtime dependency is used.

### Local checks

```bash
# Syntax-check all scripts
npm run check

# Lint the codebase
npm run lint

# Run unit tests
npm test
```

You can also run the syntax check manually:

```powershell
# Syntax-check every script
Get-ChildItem -Recurse -File -Filter *.js | ForEach-Object { node --check $_.FullName }

# Validate the manifest
node -e "const m=require('./manifest.json'); console.log(m.version, m.manifest_version)"
```

Then reload the extension at `chrome://extensions` and test on a page with a
direct `.mp4` or `.mp3` file. See `lib/README.md` if you plan to vendor a media
library.

## License

[MIT](LICENSE) © 2026 Video Downloader contributors
