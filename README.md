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

Requires Python 3.10+ and [ffmpeg](https://ffmpeg.org/download.html) on your `PATH`.

```bash
git clone https://github.com/BlackFrost8/Converter.git
cd Converter
pip install -r requirements.txt
```

No system ffmpeg? `pip install imageio-ffmpeg` provides a bundled binary that is picked up automatically.

## Web interface

```bash
python app.py
```

Open http://127.0.0.1:5000, drop a file (or paste a link), pick a format, convert, download.
Conversions run in the background with live progress; results are deleted an hour after they finish.

| Environment variable       | Default                  | Meaning                         |
| -------------------------- | ------------------------ | ------------------------------- |
| `HOST` / `PORT`            | `127.0.0.1` / `5000`     | Where `app.py` listens          |
| `CONVERTER_MAX_UPLOAD_MB`  | `1024`                   | Upload size limit               |
| `CONVERTER_WORKERS`        | `2`                      | Conversions run in parallel     |
| `CONVERTER_WORKDIR`        | system temp dir          | Where uploads and results live  |

The built-in server is meant for personal or local-network use. To expose it publicly, run it behind a
production WSGI server (e.g. `gunicorn -w 1 --threads 8 app:app`) and add authentication: anyone with
access can make the server download and transcode media. Use a single worker process, because job state
lives in memory.

## Command line

```bash
python main.py convert input.mp4 mp3                       # -> input.mp3
python main.py convert input.mp4 clip.gif --start 5 --end 9 --fps 15 --width 640
python main.py convert photo.png photo.webp --quality 80
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

MIT
