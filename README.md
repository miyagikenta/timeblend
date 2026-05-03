# timeblend

A browser demo that builds a timelapse-like clip by **temporal averaging** (blending frames over a time window) instead of only dropping frames.

## Overview

The camera stream is accumulated on the GPU, averaged over a configurable window, encoded to **H.264**, and muxed to **MP4** in the browser.

## How it works

Instead of “keep one frame every *N* seconds”, timeblend does:

> sample the live stream → add frames in a GPU buffer → divide by count → emit one output frame per window

## Features

- Live camera capture (`getUserMedia`)
- WebGL2 accumulation (`EXT_color_buffer_float` required)
- Adjustable **average window** (1 s–60 min)
- **Output resolution** presets (720p / 1080p / 4K, portrait swap for tall framing)
- Presets are checked against `MediaStreamTrack.getCapabilities()` after the camera opens; **Start is aborted** if the chosen preset is not supported or `applyConstraints` fails (the UI selection is not silently changed)
- MP4 download and in-page playback (`WebCodecs` + [mp4-muxer](https://github.com/Vanilagy/mp4-muxer) via CDN)

## Tech stack

- MediaDevices / `getUserMedia`
- WebGL2 (float accumulation, ping-pong textures)
- WebCodecs `VideoEncoder` (H.264; codec string chosen with `isConfigSupported`)
- `Canvas` + `VideoFrame` for encoder input
- `requestVideoFrameCallback` for sampling when available (falls back to `setInterval`)

## Requirements

- A recent desktop **Chrome** or **Edge** is the most reliable target (WebGL2 + WebCodecs + float render targets).
- **HTTPS or localhost** for camera access in real deployments.

## Run locally

There is **no npm install** or bundler. Serve the folder over HTTP (modules may fail on `file://`):

```bash
cd timeblend
python3 -m http.server 8080
```

Open `http://localhost:8080/` and allow the camera.

## Repository layout

| File | Role |
|------|------|
| `index.html` | Page structure |
| `app.css` | Styles |
| `app.js` | Application logic (`type="module"`) |

More context (Japanese): [`docs/handoff_ja.md`](docs/handoff_ja.md).

## Limitations

- Heavy at 4K; long runs depend on thermals, memory, and encoder throughput.
- Long average windows rely on timers; background tabs may throttle timers.

## License

MIT
