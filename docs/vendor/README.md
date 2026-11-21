# Vendored libraries

| Path      | Package                | Version | License          | Source                                   |
| --------- | ---------------------- | ------- | ---------------- | ---------------------------------------- |
| `ffmpeg/` | `@ffmpeg/ffmpeg` (ESM) | 0.12.15 | MIT              | https://github.com/ffmpegwasm/ffmpeg.wasm |
| `util/`   | `@ffmpeg/util` (ESM)   | 0.12.2  | MIT              | https://github.com/ffmpegwasm/ffmpeg.wasm |
| `core/`   | `@ffmpeg/core` (ESM)   | 0.12.10 | GPL-2.0-or-later | https://github.com/ffmpegwasm/ffmpeg.wasm |

`core/` is FFmpeg compiled to WebAssembly together with libx264, libvpx, LAME, Opus, Vorbis and other
libraries. It is distributed under the GNU GPL v2 or later (https://www.gnu.org/licenses/old-licenses/gpl-2.0.html).
Complete corresponding source and build scripts: https://github.com/ffmpegwasm/ffmpeg.wasm (core release 0.12.10)
(FFmpeg itself: https://ffmpeg.org/download.html). These files are unmodified copies from npm.

They are bundled here, rather than loaded from a CDN, because ffmpeg.wasm must start its worker from
the same origin as the page.
