# timeblend

A timelapse generator that blends time instead of skipping it.

## Overview

timeblend is a web-based timelapse generator that captures frames from your camera stream and blends them over time.

Unlike traditional timelapse techniques that simply drop frames, timeblend performs **temporal averaging** — combining multiple frames into one.

This results in:

- smoother motion
- reduced flicker
- natural motion blur-like effects
- unique "time melting" visuals

## How it works

Instead of:

> pick 1 frame every N seconds

timeblend does:

> accumulate multiple frames over time → average → output 1 frame

```

input: 30fps stream for 10 seconds → 300 frames
process: temporal accumulation
output: 1 blended frame

````

## Features (MVP)

- Real-time camera capture (via `getUserMedia`)
- Temporal frame accumulation
- Adjustable averaging window (e.g. 1s / 5s / 10s)
- Live preview
- Video recording (WebM)
- Download generated timelapse

## Why this exists

Most timelapse tools are based on frame skipping.

This creates:
- jittery motion
- flickering exposure
- unnatural transitions

timeblend explores a different approach:

> **What if we compress time by blending it instead of skipping it?**

## Tech Stack

- Web APIs
  - MediaDevices (camera)
  - Canvas API
  - MediaRecorder
- (Optional future)
  - WebGL / WebGPU for acceleration
  - WebCodecs for encoding

## Limitations

- Performance depends on device (especially mobile Safari)
- Long recordings may cause memory or thermal issues
- Currently optimized for short to mid-length captures

## Roadmap

- GPU acceleration (WebGL / WebGPU)
- Multiple blend modes (average / max / median / EMA)
- MP4 export support
- Better mobile stability
- YouTube upload integration (optional future)

## Getting Started

```bash
git clone https://github.com/yourname/timeblend
cd timeblend
npm install
npm run dev
````

Then open in your browser and allow camera access.

## License

MIT
