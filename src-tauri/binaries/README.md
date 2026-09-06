# Bundled binaries (Tauri sidecars)

Two sidecars are bundled (declared in `tauri.conf.json` → `bundle.externalBin`):
`yt-dlp` (downloads) and `ffmpeg` (video duration + thumbnails). OCR no longer uses
a sidecar — it runs in WASM in the frontend (see `src/workers/ocr-worker.js`).

Each binary is named with the Rust target-triple suffix; Tauri strips it on bundling
(installed binary is just `yt-dlp` / `ffmpeg`). The app also falls back to the system
PATH in development.

## Committed (in this folder)

  yt-dlp   Windows x64:  yt-dlp-x86_64-pc-windows-msvc.exe
           macOS arm64:  yt-dlp-aarch64-apple-darwin
  ffmpeg   Windows x64:  ffmpeg-x86_64-pc-windows-msvc.exe

## Provisioned by CI (not committed — see .github/workflows/release.yml)

  ffmpeg   macOS arm64:  ffmpeg-aarch64-apple-darwin   ← fetched via `ffmpeg-static`

## Not yet provided (needed only for Intel Macs / Linux)

  yt-dlp / ffmpeg  x86_64-apple-darwin, x86_64-unknown-linux-gnu

Sources:
  yt-dlp:  https://github.com/yt-dlp/yt-dlp/releases/latest  (yt-dlp_macos is universal)
  ffmpeg:  static builds — CI uses the `ffmpeg-static` npm package for the runner's arch
