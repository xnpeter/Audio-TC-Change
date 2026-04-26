# AudioTCChange

A local-first PWA for batch viewing and updating BWF WAV `bext TimeReference` metadata.

## Features

- Select a local folder and scan WAV/BWF files in the browser.
- Preview original start/end timecode before making changes.
- Apply positive or negative offsets at common frame rates.
- Edit timecode with a fixed `HH:MM:SS:FF` input, per-frame steppers, and arrow-key digit stepping.
- Write only the 8-byte BWF `TimeReference` field with `keepExistingData: true`.
- Export a `timecode_fix_manifest_*.csv` report after writing.
- Installable PWA with offline caching.

## Use Locally

Serve the folder over HTTP. Browsers do not allow PWA install/service workers from `file://`.

```bash
python3 -m http.server 8765 --bind 127.0.0.1
```

Open:

```text
http://127.0.0.1:8765/
```

Use Chrome or Edge for the File System Access API required to write WAV metadata.

## Deploy With GitHub Pages

Enable Pages for the repository from `Settings -> Pages`, using the `main` branch and root folder. The app can then be shared as a normal HTTPS link and installed from the browser.
