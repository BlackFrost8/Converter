"""Download from YouTube (or any site yt-dlp supports) and convert to a target format."""

from __future__ import annotations

import logging
import os
import re
import shutil
import tempfile
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse

from .engine import ConversionError, Options, ProgressFn, convert, ffmpeg_path
from .formats import AUDIO_OUT, URL_OUT, normalize

logger = logging.getLogger(__name__)

MAX_SECONDS = 3 * 60 * 60  # refuse anything longer than 3 hours


def is_valid_url(url: str) -> bool:
    parsed = urlparse(url.strip())
    return parsed.scheme in ("http", "https") and bool(parsed.netloc)


def safe_filename(name: str, fallback: str = "download") -> str:
    name = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "", name).strip(" .")
    return (name[:120] or fallback)


_cookie_copy: Optional[str] = None


def _cookie_file() -> Optional[str]:
    """YTDLP_COOKIES_FILE, copied once to a writable temp file (yt-dlp rewrites it on exit,
    and hosted secret files are usually read-only)."""
    global _cookie_copy
    src = os.environ.get("YTDLP_COOKIES_FILE")
    if not src or not Path(src).is_file():
        return None
    if _cookie_copy is None:
        fd, _cookie_copy = tempfile.mkstemp(prefix="ytdlp-cookies-", suffix=".txt")
        os.close(fd)
        shutil.copyfile(src, _cookie_copy)
    return _cookie_copy


def _base_params(workdir: Path) -> dict:
    extra = {}
    if cookies := _cookie_file():
        extra["cookiefile"] = cookies
    if proxy := os.environ.get("YTDLP_PROXY"):
        extra["proxy"] = proxy
    return extra | {
        "outtmpl": str(workdir / "source.%(ext)s"),
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "restrictfilenames": True,
        "ffmpeg_location": ffmpeg_path(),
        # Only named site extractors; the generic extractor would fetch arbitrary URLs.
        "allowed_extractors": ["default", "-generic"],
    }


def fetch_info(url: str) -> dict:
    import yt_dlp

    if not is_valid_url(url):
        raise ConversionError("That does not look like a valid http(s) link.")
    with tempfile.TemporaryDirectory() as tmp:
        try:
            with yt_dlp.YoutubeDL(_base_params(Path(tmp))) as ydl:
                info = ydl.extract_info(url, download=False)
        except yt_dlp.utils.DownloadError as e:
            raise ConversionError(_clean(str(e)))
    return {
        "title": info.get("title"),
        "duration": info.get("duration"),
        "uploader": info.get("uploader"),
        "thumbnail": info.get("thumbnail"),
        "site": info.get("extractor_key"),
    }


def _clean(msg: str) -> str:
    msg = re.sub(r"\x1b\[[0-9;]*m", "", msg)
    msg = msg.replace("ERROR: ", "").split("; please report this issue")[0]
    if "Unsupported URL" in msg:
        return "That site or link is not supported."
    if "Unable to connect to proxy" in msg or "Failed to resolve" in msg or "getaddrinfo" in msg:
        return "Could not reach that site. Check the server's internet connection."
    if "Sign in to confirm" in msg:
        return "YouTube is asking this server to sign in (often due to rate limiting). Try again later."
    return msg.strip()[:300]


def download(
    url: str,
    target: str,
    out_dir: str | Path,
    options: Options | None = None,
    progress: Optional[ProgressFn] = None,
) -> Path:
    """Download ``url`` and convert it to ``target``. Returns the output file path.

    Progress: 0–0.7 is the download, 0.7–1.0 the conversion.
    """
    import yt_dlp

    fmt = normalize(target)
    if fmt not in URL_OUT:
        raise ConversionError(f"Links can be converted to: {', '.join(URL_OUT)}.")
    if not is_valid_url(url):
        raise ConversionError("That does not look like a valid http(s) link.")
    opts = (options or Options()).validate()
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    def hook(d):
        if progress and d.get("status") == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate")
            if total:
                progress(0.7 * min(d.get("downloaded_bytes", 0) / total, 1.0), _speed_detail(d))

    def too_long(info, *, incomplete):
        dur = info.get("duration")
        if info.get("is_live"):
            return "Live streams are not supported."
        if dur and dur > MAX_SECONDS:
            return f"Video is too long ({int(dur // 60)} min; limit is {MAX_SECONDS // 60} min)."
        return None

    with tempfile.TemporaryDirectory(dir=out_dir) as tmp:
        workdir = Path(tmp)
        params = _base_params(workdir) | {"progress_hooks": [hook], "match_filter": too_long}
        if fmt in AUDIO_OUT:
            params["format"] = "bestaudio/best"
        else:
            params["format"] = "bv*[height<=1080][ext=mp4]+ba[ext=m4a]/bv*[height<=1080]+ba/b[height<=1080]/b"
            params["merge_output_format"] = "mp4"

        try:
            with yt_dlp.YoutubeDL(params) as ydl:
                info = ydl.extract_info(url, download=True)
        except yt_dlp.utils.DownloadError as e:
            raise ConversionError(_clean(str(e)))
        if info is None:
            raise ConversionError("Nothing was downloaded (the video may have been filtered out).")

        files = [p for p in workdir.iterdir() if p.name.startswith("source.") and not p.name.endswith(".part")]
        if not files:
            raise ConversionError("Download finished but no media file was produced.")
        source = max(files, key=lambda p: p.stat().st_size)

        title = safe_filename(info.get("title") or "download")
        final = out_dir / f"{title}.{fmt}"
        trimmed = opts.start is not None or opts.end is not None

        sub = (lambda f: progress(0.7 + 0.3 * f, None)) if progress else None
        if normalize(source.suffix) == fmt and not trimmed:
            source.replace(final)
        else:
            # Some downloads arrive as .webm/.m4a etc; the engine handles those as inputs.
            convert(source, fmt, final, opts, sub)

    if progress:
        progress(1.0)
    logger.info("Downloaded %s -> %s", url, final)
    return final


def _speed_detail(d: dict) -> Optional[str]:
    parts = []
    speed, eta = d.get("speed"), d.get("eta")
    if speed:
        parts.append(f"{speed / 1_048_576:.1f} MB/s")
    if eta is not None:
        parts.append(f"{int(eta) // 60}:{int(eta) % 60:02d} left")
    return " · ".join(parts) or None


class YouTubeDownloader:
    """Backwards-compatible wrapper around :func:`download`."""

    @staticmethod
    def is_valid_youtube_url(url: str) -> bool:
        host = urlparse(url).netloc.lower()
        return host.endswith("youtube.com") or host.endswith("youtu.be")

    @staticmethod
    def download_audio(url: str, output_path: str, bitrate: str = "192k") -> bool:
        out = Path(output_path)
        try:
            result = download(url, out.suffix or "mp3", out.parent, Options(audio_bitrate=bitrate))
            result.replace(out)
            return True
        except ConversionError as e:
            logger.error("YouTube download failed: %s", e)
            return False

    @staticmethod
    def get_video_info(url: str) -> dict:
        try:
            return fetch_info(url)
        except ConversionError as e:
            logger.error("Failed to get video info: %s", e)
            return {}
