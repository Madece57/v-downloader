# `lib/` — vendored libraries

This folder is intentionally empty apart from this note. **Video Downloader has no
runtime dependencies and no build step** — every script it ships is plain ES2020
that Chrome loads directly.

It is reserved for optional, third-party libraries you may want to vendor if you
extend the extension:

| Library | What it would enable | Notes |
| --- | --- | --- |
| [hls.js](https://github.com/video-dev/hls.js) | In-page playback of HLS in Chrome | Not needed for downloading; Chrome already plays HLS on some platforms. |
| [mux.js](https://github.com/videojs/mux.js) | Remuxing MPEG-TS segments to MP4 | Only useful if you add a full segment downloader. |
| [ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm) | Client-side muxing/transcoding | Huge download (~25 MB+), needs cross-origin isolation. |
| [dash.js](https://github.com/Dash-Industry-Forum/dash.js) | DASH playback support | Playback only, not downloading. |

## Rules for vendored code

1. Keep the upstream license file next to the library.
2. Add the library's files to `web_accessible_resources` in `manifest.json` only
   if a content script or page actually loads them.
3. Prefer a pinned release over a moving branch, and record the version here.
4. Remember MV3 constraints: no remote code execution, no `eval`, and service
   workers cannot use `DOMParser` or `XMLHttpRequest`.

The current extension deliberately **does not** bundle a muxer. HLS/DASH streams
are detected, their manifests can be saved, and users are pointed at VLC,
ffmpeg or yt-dlp for the actual merge/download.
