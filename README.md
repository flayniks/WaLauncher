# Clipwave

A free video editor that runs in your browser. Multi-track timeline, 122 transitions, 60 effects, 32 filters, 115 clip animations, letter-by-letter text animations, keyframes, masks, chroma key, auto captions and frame-exact MP4 export. Your files never leave your computer.

**Run it:** open `dist/clipwave.html` in Chrome or Edge. That's the whole app in one file. No install, no account, no watermark.

## What's in it

| | |
|---|---|
| **Timeline** | Unlimited video, overlay, text, effect and audio tracks. Magnetic main track, snapping (clips, playhead, markers and music beats), trim, split, ripple delete, copy and paste, duplicate, freeze frame, extract audio, markers, track mute / hide / lock, undo and redo. |
| **Transitions** | 122 GPU transitions from [gl-transitions](https://gl-transitions.com) (MIT, credited per author): cube, cross zoom, glitch, page curl, ripple, dreamy, burn, doorway, wipes, mosaics and more. Adjustable length, live previews, "apply to all cuts". |
| **Effects** | 60 shader effects in 10 groups: glitch, RGB split, VHS, old film, CRT, camera shake, beat zoom, zoom blur, motion streak, tilt shift, soft glow, light leak, bokeh, sparkle, snow, rain, confetti, kaleidoscope, fisheye, swirl, wave, comic, pencil sketch, oil paint, neon edges, thermal, night vision, halftone, split screen, cinema bars, eye open and others. Put them on a clip, or on an effect track to hit everything below it. Several are ports of [glfx.js](https://github.com/evanw/glfx.js) (MIT). |
| **Color** | 32 filter looks with intensity, 14 adjustment sliders (exposure, contrast, temperature, highlights, shadows, vibrance, sharpen, grain, vignette…), and `.cube` LUT import so any free LUT pack works. |
| **Animation** | 98 in / out / loop presets parsed straight from [animate.css](https://animate.style) (MIT) plus 17 editor ones (Ken Burns zoom and pan, blur in, zoom punch, spin, float). Hover a preset to preview it. Keyframes for position, scale, rotation, opacity and volume. |
| **Text** | 36 Google Fonts, outline, shadow, glow, gradient fill, background boxes, wrapping, 29 letter-by-letter animations (typewriter, word pop, karaoke, wave, glitch, scatter, rainbow…) and 20 ready-made styles. |
| **Compositing** | Drag, scale and rotate on the preview with center snapping, 15 blend modes, 6 mask shapes with feather, crop, flip, chroma key with spill suppression, blurred / gradient / color backgrounds. |
| **Audio** | Waveforms, volume to 200%, fades you drag on the clip, beat detection on music, voiceover recording and 10 sound effects synthesized on the spot. |
| **Captions** | Speech-to-text with Whisper running in the browser ([transformers.js](https://github.com/huggingface/transformers.js), Apache-2.0). 18 languages or auto-detect, four caption styles including karaoke, SRT / VTT import and SRT export. |
| **Templates** | Six one-click edits (Fast Montage, Cinematic, Daily Vlog, Retro Tape, Hype Reel, Memories): pick your clips, get cuts, transitions, color, effects and a title. |
| **Export** | MP4 (H.264 + AAC) or WebM (VP9 + Opus) from 480p to 4K at 24 to 60 fps, rendered frame by frame with WebCodecs through [Mediabunny](https://mediabunny.dev) (MPL-2.0), so the file matches the preview exactly. Audio-only WAV and PNG frame grabs too. |
| **Formats** | 16:9, 9:16, 1:1, 4:5, 4:3, 21:9 and 3:4 canvases. Imports MP4, MOV, WebM, MKV, MP3, WAV, M4A, OGG, FLAC, PNG, JPG, GIF and WebP. |

Projects and imported files are saved automatically in the browser (IndexedDB). Open the project menu (click the Clipwave logo) to start new projects or switch between them.

## Shortcuts

| Key | Action |
|---|---|
| Space | Play / pause |
| S or Ctrl+B | Split at the playhead |
| Del / Shift+Del | Delete / ripple delete |
| Ctrl+C, Ctrl+V, Ctrl+X, Ctrl+D | Copy, paste, cut, duplicate |
| ← → / Shift+← → | One frame / one second |
| ↑ ↓ | Previous / next cut |
| Home / End | Start / end |
| J K L | Back 2s / pause / play |
| M | Marker |
| N | Snapping on or off |
| + / − | Zoom the timeline (Ctrl+scroll works too) |
| Ctrl+Z / Ctrl+Shift+Z | Undo / redo |
| Ctrl+E | Export |

## Building from source

```sh
npm install
npm run gen      # re-import gl-transitions and animate.css into src/data (only after updating them)
npm run build    # writes dist/clipwave.html
npm run dev      # rebuild on save
npm test         # headless Chromium: compiles every shader, edits a timeline, exports an MP4 and checks it with ffprobe
```

The test needs `ffmpeg` and Playwright's Chromium. Open-source Chromium has no H.264, so the test exports VP9 there; Chrome and Edge export H.264.

## How it works

- `src/engine/renderer.js` is a WebGL2 compositor. Each frame it draws tracks bottom to top: clip pixels, then chroma key, color, LUT and effect passes, then a single composite pass for transform, crop, mask, opacity and blend mode. Effect tracks run on everything drawn so far. Transitions render both sides and hand them to the gl-transitions shader.
- The preview (`playback.js`) keeps one media element per clip in step with the playhead, with audio routed through Web Audio. Export (`exporter.js`) uses the same compositor but decodes exact frames with WebCodecs and mixes audio offline, so nothing depends on real-time playback.
- `tools/gen-data.mjs` turns the open-source packs into data: it reads every animate.css source file and converts its keyframes into transform tracks, and copies the gl-transitions shaders with their authors and licenses.

## Credits

gl-transitions (MIT, each transition by its author), animate.css (MIT, Daniel Eden and contributors), glfx.js (MIT, Evan Wallace), Mediabunny (MPL-2.0, Vanilagy), transformers.js and Whisper (Apache-2.0 / MIT), Google Fonts (SIL Open Font License).
