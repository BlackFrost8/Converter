# Converter

Convert video, audio, images and links between formats — from a web page or the command line.

- **Video → video:** MP4, WebM, MKV, MOV, AVI
- **Video → GIF:** palette-optimised, with frame rate, width and trim controls
- **Video → audio:** MP3, WAV, FLAC, M4A, AAC, OGG, Opus, AIFF
- **Video → still frame:** PNG, JPG
- **Audio → audio:** any of the audio formats above
- **Image → image:** PNG, JPG, WebP, BMP, TIFF, GIF, ICO, PDF (animated GIF → WebP keeps animation; GIF → MP4/WebM)
- **Link → file:** YouTube (and the other sites [yt-dlp](https://github.com/yt-dlp/yt-dlp) supports) to MP3, M4A, WAV, FLAC, OGG, Opus, MP4, WebM, MKV or GIF

Inputs accepted: `mp4 mkv mov avi webm flv m4v wmv mpeg 3gp ts`, `mp3 wav aac m4a ogg flac opus wma aiff amr`, `jpg png webp bmp tiff gif ico`.

## Setup

Requires Python 3.10+ and [ffmpeg](https://ffmpeg.org/download.html) on your `PATH`. `requirements.txt` also
installs Deno, the JavaScript runtime yt-dlp now needs for YouTube.

```bash
git clone https://github.com/BlackFrost8/Converter.git
cd Converter
pip install -r requirements.txt
```

No system ffmpeg? `pip install imageio-ffmpeg` provides a bundled binary that is picked up automatically.

## How it fits together

- **The page** (`docs/`) converts files **in the visitor's browser** with
  [ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm). Nothing is uploaded. Drop several files at once
  and download them individually or as one zip; preview the result before downloading; paste a link or an
  image anywhere on the page. A progress bar shows the one-time engine download (31 MB, cached afterwards)
  and then the conversion percentage.
- **The link service** (`app.py`) downloads YouTube and other links with yt-dlp, converts them with ffmpeg,
  and hands back the file, with download speed and time left shown in the progress bar. Browsers can't download
  YouTube media themselves, so links always need this service running somewhere.

`app.py` also serves the page itself, so one deployment gives you a complete online converter.

## Put it online (works like any online converter)

1. **Deploy the link service.** The repo includes a `Dockerfile` and a Render Blueprint (`render.yaml`):
   create a free account at [render.com](https://render.com), then **New → Blueprint**, pick this repository and
   click **Apply**. After the build, Render gives you an address like `https://converter-xxxx.onrender.com`.
   That address alone is already a full converter site.
2. **Point the GitHub Pages site at it.** Edit `docs/config.js` and set
   `linkServer: "https://converter-xxxx.onrender.com"`. Commit and push.
3. **Turn on Pages:** Settings → Pages → Deploy from a branch → `main`, folder **`/docs`**. The custom domain
   `convert.froststudio.org` is set by `docs/CNAME`.

Visitors then paste a link, pick MP3 or MP4, and download, with no setup on their side.

Things to know about free hosting:

- Render's free tier sleeps after about 15 minutes idle. The page pings the service when it opens, and shows
  "Waking up the link service" if a conversion starts before it is awake (up to about a minute).
- YouTube often blocks or rate-limits downloads from data-centre servers ("Sign in to confirm you're not a bot").
  If that happens, add a `cookies.txt` exported from a logged-in browser as a Render **Secret File** and set
  `YTDLP_COOKIES_FILE=/etc/secrets/cookies.txt`, or route downloads through a proxy with `YTDLP_PROXY`.
  Cookies tie downloads to that account; use a spare one.
- Keep yt-dlp current: redeploying rebuilds the image with the newest version.

## Run it locally

```bash
python app.py
```

Open http://127.0.0.1:5000. The Pages site also uses this local service for links when `config.js` has no
`linkServer` set (Chrome may ask permission first; Safari may block it).

| Environment variable        | Default                         | Meaning                                         |
| --------------------------- | ------------------------------- | ----------------------------------------------- |
| `HOST` / `PORT`             | `127.0.0.1` / `5000`            | Where `app.py` listens                          |
| `CONVERTER_ALLOWED_ORIGINS` | `https://convert.froststudio.org,https://blackfrost8.github.io` | Other sites allowed to use this service (CORS) |
| `CONVERTER_RATE_LIMIT`      | `0` (unlimited); Docker: `30`   | Conversions per visitor IP per hour             |
| `CONVERTER_MAX_QUEUE`       | `20`                            | Jobs waiting or running before "busy" replies   |
| `CONVERTER_WORKERS`         | `2`                             | Conversions run in parallel                     |
| `CONVERTER_MAX_UPLOAD_MB`   | `1024`; Docker: `200`           | Upload limit for the `/api/convert` endpoint    |
| `CONVERTER_MAX_DOWNLOAD_MB` | `2048`; Docker: `500`           | Largest file a link may download (0 = no limit) |
| `CONVERTER_BEHIND_PROXY`    | unset; Docker: `1`              | Trust one reverse proxy for the client IP       |
| `CONVERTER_WORKDIR`         | system temp dir                 | Where downloads and results live (1 hour)       |
| `YTDLP_COOKIES_FILE`        | unset                           | Cookies file for yt-dlp                         |
| `YTDLP_PROXY`               | unset                           | Proxy URL for yt-dlp                            |

Jobs live in memory, so run a single server process (the Dockerfile uses one gunicorn worker with threads).

## Command line

```bash
python main.py convert input.mp4 mp3                       # -> input.mp3
python main.py convert input.mp4 clip.gif --start 5 --end 9 --fps 15 --width 640
python main.py convert photo.png photo.webp --quality 80
python main.py convert talk.mov talk.mp4 --height 720           # shrink to 720p
python main.py convert "https://www.youtube.com/watch?v=VIDEO_ID" mp3
python main.py formats video.mkv                           # list possible outputs
python main.py serve --port 8000                           # same as app.py
```

The aliases `image`, `audio`, `video` and `youtube` are the same as `convert`, so the older
`python main.py audio input.mp4 output.mp3` style still works.

## As a library

```python
from converter import convert, download, Options

convert("talk.mov", "mp3", options=Options(audio_bitrate="320k"))
convert("clip.mp4", "gif", "clip.gif", Options(start=2, end=6, gif_width=360))
download("https://youtu.be/VIDEO_ID", "mp3", "downloads/")
```

## Tests

```bash
pip install -r requirements-dev.txt
pytest
```

## Notes

- Downloading from YouTube may be against its Terms of Service unless you have rights to the content.
  Use the link converter for your own videos, Creative Commons material, or other content you are allowed to save.
- YouTube changes often. If links stop working, update yt-dlp: `pip install -U yt-dlp`.
- For safety, yt-dlp's generic "any web page" extractor is disabled, so only links from sites yt-dlp explicitly supports are accepted.

## License

MIT. The bundled ffmpeg.wasm core in `docs/vendor/core/` is GPL-2.0-or-later; see `docs/vendor/README.md`.
