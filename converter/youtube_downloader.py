"""Download from YouTube (or any site yt-dlp supports) and convert to a target format."""

from __future__ import annotations

import copy
import logging
import os
import re
import shutil
import tempfile
import threading
import time
from collections import OrderedDict
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse

from .engine import Cancelled, ConversionError, Options, ProgressFn, convert, ffmpeg_path
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


# Info fetched for the preview is reused by the download a moment later, so YouTube sees one
# extraction per conversion instead of two (fewer requests, less bot-check pressure).
_INFO_TTL = 15 * 60
_INFO_MAX = 64
_info_cache: "OrderedDict[str, tuple[float, dict]]" = OrderedDict()
_info_lock = threading.Lock()


def _cache_put(url: str, info: dict) -> None:
    with _info_lock:
        _info_cache[url] = (time.time(), info)
        _info_cache.move_to_end(url)
        while len(_info_cache) > _INFO_MAX:
            _info_cache.popitem(last=False)


def _cache_get(url: str) -> Optional[dict]:
    with _info_lock:
        hit = _info_cache.get(url)
        if not hit or time.time() - hit[0] > _INFO_TTL:
            _info_cache.pop(url, None)
            return None
        return copy.deepcopy(hit[1])


def _heights(info: dict) -> list[int]:
    return sorted({
        f["height"] for f in info.get("formats") or []
        if f.get("height") and f.get("vcodec") not in (None, "none")
    })


def fetch_info(url: str) -> dict:
    import yt_dlp

    url = url.strip()
    if not is_valid_url(url):
        raise ConversionError("That does not look like a valid http(s) link.")
    info = _cache_get(url)
    if info is None:
        with tempfile.TemporaryDirectory() as tmp:
            try:
                with yt_dlp.YoutubeDL(_base_params(Path(tmp))) as ydl:
                    info = ydl.sanitize_info(ydl.extract_info(url, download=False))
            except yt_dlp.utils.DownloadError as e:
                raise ConversionError(_clean(str(e)))
        if info.get("_type") in ("playlist", "multi_video"):
            raise ConversionError("Playlists aren't supported. Paste a link to a single video.")
        _cache_put(url, info)
    return {
        "title": info.get("title"),
        "duration": info.get("duration"),
        "uploader": info.get("uploader"),
        "thumbnail": info.get("thumbnail"),
        "site": info.get("extractor_key"),
        "heights": _heights(info),
    }


def _clean(msg: str) -> str:
    msg = re.sub(r"\x1b\[[0-9;]*m", "", msg)
    msg = msg.replace("ERROR: ", "").split("; please report this issue")[0]
    if "Unsupported URL" in msg:
        return "That site or link is not supported."
    if "Unable to connect to proxy" in msg or "Failed to resolve" in msg or "getaddrinfo" in msg:
        return "Could not reach that site. Check the server's internet connection."
    if "confirm your age" in msg or "age-restricted" in msg or "inappropriate for some users" in msg:
        return "This video is age-restricted on YouTube, so it can't be downloaded without a signed-in account."
    if "not a bot" in msg or "Sign in to confirm" in msg:
        return ("YouTube is refusing this video to the server with its \"not a bot\" check. "
                "Some videos are refused more than others; try again later or try another video.")
    if "Private video" in msg:
        return "This video is private."
    if "Video unavailable" in msg or "This video is not available" in msg:
        return "This video is unavailable (removed, private, or blocked in the server's country)."
    return msg.strip()[:300]


def download(
    url: str,
    target: str,
    out_dir: str | Path,
    options: Options | None = None,
    progress: Optional[ProgressFn] = None,
) -> Path:
    """Download ``url`` and convert it to ``target``. Returns the output file path.

    Progress: 0–0.7 is the download, 0.7–1.0 the conversion. ``options.max_height`` caps the
    video quality fetched. Raise :class:`Cancelled` from ``progress`` to stop.
    """
    import yt_dlp

    url = url.strip()
    fmt = normalize(target)
    if fmt not in URL_OUT:
        raise ConversionError(f"Links can be converted to: {', '.join(URL_OUT)}.")
    if not is_valid_url(url):
        raise ConversionError("That does not look like a valid http(s) link.")
    opts = (options or Options()).validate()
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    max_mb = _max_download_mb()

    def hook(d):
        if not progress or d.get("status") != "downloading":
            return
        total = d.get("total_bytes") or d.get("total_bytes_estimate")
        fraction = 0.7 * min(d.get("downloaded_bytes", 0) / total, 1.0) if total else None
        try:
            progress(fraction, _speed_detail(d))
        except Cancelled:
            raise yt_dlp.utils.DownloadCancelled("Cancelled.")  # the exception yt-dlp lets through

    rejected: list[str] = []

    def too_long(info, *, incomplete):
        dur = info.get("duration")
        reason = None
        if info.get("is_live"):
            reason = "Live streams are not supported."
        elif dur and dur > MAX_SECONDS:
            reason = f"Video is too long ({int(dur // 60)} min; the limit is {MAX_SECONDS // 60} min)."
        if reason:
            rejected.append(reason)
        return reason

    # GIFs are small; don't fetch more video than they can use.
    height = opts.max_height or 1080
    if fmt == "gif":
        height = min(height, 720)

    with tempfile.TemporaryDirectory(dir=out_dir) as tmp:
        workdir = Path(tmp)
        params = _base_params(workdir) | {"progress_hooks": [hook], "match_filter": too_long}
        if max_mb:
            params["max_filesize"] = max_mb * 1024 * 1024
        if fmt in AUDIO_OUT:
            params["format"] = "bestaudio/best"
        else:
            # Prefer H.264 (avc1): it plays everywhere. YouTube's default pick is often AV1,
            # which many phones, older PCs and older Macs can't play.
            h = f"[height<={height}]"
            params["format"] = (
                f"bv*{h}[vcodec^=avc1]+ba[ext=m4a]/bv*{h}[ext=mp4]+ba[ext=m4a]"
                f"/bv*{h}+ba/b{h}/wv*+ba/w"
            )
            params["merge_output_format"] = "mp4"

        cached = _cache_get(url)
        try:
            with yt_dlp.YoutubeDL(params) as ydl:
                info = None
                if cached is not None:
                    try:
                        info = ydl.process_ie_result(cached, download=True)
                    except yt_dlp.utils.DownloadError:
                        # Stream URLs can expire; extract again from scratch.
                        for leftover in workdir.iterdir():
                            leftover.unlink(missing_ok=True)
                        info = None
                if info is None:
                    info = ydl.extract_info(url, download=True)
        except yt_dlp.utils.DownloadCancelled:
            raise Cancelled()
        except yt_dlp.utils.DownloadError as e:
            raise ConversionError(_clean(str(e)))
        if rejected:
            raise ConversionError(rejected[0])
        if info is None:
            raise ConversionError("Nothing was downloaded.")
        if info.get("_type") in ("playlist", "multi_video"):
            raise ConversionError("Playlists aren't supported. Paste a link to a single video.")

        files = [p for p in workdir.iterdir() if p.name.startswith("source.") and not p.name.endswith(".part")]
        if not files:
            if max_mb:
                raise ConversionError(f"Nothing was downloaded. The video may be larger than this server's {max_mb} MB limit.")
            raise ConversionError("Download finished but no media file was produced.")
        source = max(files, key=lambda p: p.stat().st_size)

        title = safe_filename(info.get("title") or "download")
        final = out_dir / f"{title}.{fmt}"
        trimmed = opts.start is not None or opts.end is not None

        sub = (lambda f: progress(None if f is None else 0.7 + 0.3 * f, None)) if progress else None
        if normalize(source.suffix) == fmt and not trimmed:
            source.replace(final)
        else:
            # Downloads often arrive as .webm/.m4a; the engine takes those as inputs.
            convert(source, fmt, final, opts, sub)

    if progress:
        progress(1.0)
    logger.info("Downloaded %s -> %s", url, final)
    return final


def _max_download_mb() -> int:
    try:
        return int(os.environ.get("CONVERTER_MAX_DOWNLOAD_MB", "2048"))
    except ValueError:
        return 2048


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
