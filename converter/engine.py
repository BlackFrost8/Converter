"""Conversion engine: ffmpeg for audio/video, Pillow for images."""

from __future__ import annotations

import logging
import re
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional

from PIL import Image, ImageOps

from .formats import AUDIO_OUT, FRAME_OUT, IMAGE_OUT, VIDEO_OUT, category_of, normalize, targets_for

logger = logging.getLogger(__name__)

ProgressFn = Callable[..., None]  # progress(fraction) or progress(fraction, detail)


class ConversionError(Exception):
    """Raised when a conversion cannot be performed. The message is user-facing."""


@dataclass
class Options:
    audio_bitrate: str = "192k"   # mp3 / aac / m4a / opus / ogg
    gif_fps: int = 12
    gif_width: int = 480          # 0 keeps the original width
    image_quality: int = 90       # jpg / webp
    start: Optional[float] = None  # seconds, trims audio/video/gif
    end: Optional[float] = None

    def validate(self) -> "Options":
        if not re.fullmatch(r"\d{2,3}k", self.audio_bitrate):
            raise ConversionError("Bitrate must look like 128k, 192k or 320k.")
        self.gif_fps = max(1, min(int(self.gif_fps), 50))
        self.gif_width = max(0, min(int(self.gif_width), 1920))
        self.image_quality = max(1, min(int(self.image_quality), 100))
        if self.start is not None and self.start < 0:
            raise ConversionError("Start time cannot be negative.")
        if self.start is not None and self.end is not None and self.end <= self.start:
            raise ConversionError("End time must be after the start time.")
        return self

    @property
    def clip_length(self) -> Optional[float]:
        if self.end is None:
            return None
        return self.end - (self.start or 0)


# --------------------------------------------------------------------------- ffmpeg

def ffmpeg_path() -> str:
    found = shutil.which("ffmpeg")
    if found:
        return found
    try:  # optional pip fallback: `pip install imageio-ffmpeg`
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        raise ConversionError("ffmpeg is not installed. Install it and make sure it is on your PATH.")


def _parse_ts(value: str) -> float:
    h, m, s = value.split(":")
    return int(h) * 3600 + int(m) * 60 + float(s)


def probe_duration(src: Path) -> Optional[float]:
    """Media duration in seconds, read from ffmpeg's banner (no ffprobe needed)."""
    proc = subprocess.run(
        [ffmpeg_path(), "-hide_banner", "-i", str(src)],
        capture_output=True, text=True, errors="replace",
    )
    match = re.search(r"Duration:\s*(\d+:\d+:\d+(?:\.\d+)?)", proc.stderr)
    return _parse_ts(match.group(1)) if match else None


EMPTY_OUTPUT = ("Output file is empty", "nothing was encoded")


def _friendly(stderr: str) -> str:
    text = stderr.strip()
    if any(m in text for m in EMPTY_OUTPUT):
        return "Nothing to convert: the chosen start/end range is past the end of the file."
    if "matches no streams" in text or "does not contain any stream" in text:
        return "The file has no stream of the type needed for that format (for example, a video with no audio track)."
    if "Invalid data found" in text:
        return "The file could not be read. It may be corrupt or not really the format its name says."
    last = [ln for ln in text.splitlines() if ln.strip()][-3:]
    return "ffmpeg failed: " + (" | ".join(last) if last else "unknown error")


def run_ffmpeg(
    input_args: list[str],
    output_args: list[str],
    dst: Path,
    duration: Optional[float] = None,
    progress: Optional[ProgressFn] = None,
) -> None:
    cmd = [
        ffmpeg_path(), "-hide_banner", "-nostdin", "-y",
        *input_args, *output_args,
        "-progress", "pipe:1", "-nostats", "-loglevel", "warning", str(dst),
    ]
    logger.debug("Running: %s", " ".join(cmd))
    with tempfile.TemporaryFile(mode="w+") as err:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=err, text=True)
        assert proc.stdout is not None
        for line in proc.stdout:
            if progress and duration and line.startswith("out_time_us="):
                try:
                    done = int(line.split("=", 1)[1]) / 1_000_000
                    progress(max(0.0, min(done / duration, 0.99)))
                except ValueError:
                    pass
        code = proc.wait()
        err.seek(0)
        errors = err.read()
        if code != 0 or any(m in errors for m in EMPTY_OUTPUT):
            dst.unlink(missing_ok=True)
            raise ConversionError(_friendly(errors))
    if progress:
        progress(1.0)


def _trim_input(opts: Options) -> list[str]:
    return ["-ss", f"{opts.start:.3f}"] if opts.start else []


def _trim_output(opts: Options) -> list[str]:
    length = opts.clip_length
    return ["-t", f"{length:.3f}"] if length else []


EVEN_DIMS = "scale=trunc(iw/2)*2:trunc(ih/2)*2"

AUDIO_CODECS = {
    "mp3": lambda br: ["-c:a", "libmp3lame", "-b:a", br],
    "wav": lambda br: ["-c:a", "pcm_s16le"],
    "aiff": lambda br: ["-c:a", "pcm_s16be"],
    "flac": lambda br: ["-c:a", "flac"],
    "m4a": lambda br: ["-c:a", "aac", "-b:a", br],
    "aac": lambda br: ["-c:a", "aac", "-b:a", br],
    "ogg": lambda br: ["-c:a", "libvorbis", "-b:a", br],
    "opus": lambda br: ["-c:a", "libopus", "-b:a", br],
}

VIDEO_CODECS = {
    "mp4": ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart"],
    "mov": ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "160k"],
    "mkv": ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "160k"],
    "webm": ["-c:v", "libvpx-vp9", "-crf", "33", "-b:v", "0", "-deadline", "realtime",
             "-cpu-used", "8", "-row-mt", "1", "-c:a", "libopus", "-b:a", "128k"],
    "avi": ["-c:v", "mpeg4", "-q:v", "4", "-c:a", "libmp3lame", "-b:a", "192k"],
}


def _media_length(src: Path, opts: Options) -> Optional[float]:
    total = probe_duration(src)
    if total is not None and opts.start:
        total = max(total - opts.start, 0.01)
    if opts.clip_length:
        total = min(total, opts.clip_length) if total else opts.clip_length
    return total


def _to_audio(src: Path, dst: Path, fmt: str, opts: Options, progress) -> None:
    run_ffmpeg(
        [*_trim_input(opts), "-i", str(src)],
        ["-map", "0:a:0", "-vn", *_trim_output(opts), *AUDIO_CODECS[fmt](opts.audio_bitrate)],
        dst, _media_length(src, opts), progress,
    )


def _to_video(src: Path, dst: Path, fmt: str, opts: Options, progress) -> None:
    run_ffmpeg(
        [*_trim_input(opts), "-i", str(src)],
        ["-map", "0:v:0", "-map", "0:a:0?", *_trim_output(opts), "-vf", EVEN_DIMS, *VIDEO_CODECS[fmt]],
        dst, _media_length(src, opts), progress,
    )


def _to_gif(src: Path, dst: Path, opts: Options, progress) -> None:
    scale = f",scale='min({opts.gif_width},iw)':-1:flags=lanczos" if opts.gif_width else ""  # never upscale
    graph = (
        f"[0:v]fps={opts.gif_fps}{scale},split[a][b];"
        f"[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5"
    )
    run_ffmpeg(
        [*_trim_input(opts), "-i", str(src)],
        [*_trim_output(opts), "-filter_complex", graph, "-an", "-loop", "0"],
        dst, _media_length(src, opts), progress,
    )


def _to_frame(src: Path, dst: Path, fmt: str, opts: Options, progress) -> None:
    quality = ["-q:v", "2"] if fmt == "jpg" else []
    run_ffmpeg([*_trim_input(opts), "-i", str(src)], ["-frames:v", "1", *quality], dst, None, progress)


# --------------------------------------------------------------------------- images

def _flatten(img: Image.Image, background=(255, 255, 255)) -> Image.Image:
    """Drop transparency onto a solid background (for JPG / PDF)."""
    if img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info):
        rgba = img.convert("RGBA")
        base = Image.new("RGB", rgba.size, background)
        base.paste(rgba, mask=rgba.split()[-1])
        return base
    return img.convert("RGB")


def _to_image(src: Path, dst: Path, fmt: str, opts: Options) -> None:
    try:
        img = Image.open(src)
    except Exception:
        raise ConversionError("The image could not be read. It may be corrupt or an unsupported variant.")

    with img:
        animated = getattr(img, "is_animated", False)
        if animated and fmt in ("gif", "webp"):
            frames = []
            for i in range(img.n_frames):
                img.seek(i)
                frames.append(img.convert("RGBA"))
            frames[0].save(
                dst, save_all=True, append_images=frames[1:], loop=0,
                duration=img.info.get("duration", 100), disposal=2,
                **({"quality": opts.image_quality} if fmt == "webp" else {}),
            )
            return

        img = ImageOps.exif_transpose(img)
        if fmt == "jpg":
            _flatten(img).save(dst, "JPEG", quality=opts.image_quality, optimize=True)
        elif fmt == "pdf":
            _flatten(img).save(dst, "PDF", resolution=150)
        elif fmt == "webp":
            img.convert("RGBA").save(dst, "WEBP", quality=opts.image_quality)
        elif fmt == "ico":
            square = img.convert("RGBA")
            square.thumbnail((256, 256))
            sizes = [s for s in [(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
                     if s[0] <= max(square.size)] or [(16, 16)]
            square.save(dst, "ICO", sizes=sizes)
        elif fmt == "bmp":
            (img.convert("RGBA") if img.mode in ("RGBA", "LA", "P") else img.convert("RGB")).save(dst, "BMP")
        elif fmt == "gif":
            img.convert("RGBA").save(dst, "GIF")
        elif fmt == "tiff":
            img.save(dst, "TIFF", compression="tiff_lzw")
        else:  # png
            img.save(dst, "PNG", optimize=True)


# --------------------------------------------------------------------------- public API

def convert(
    src: str | Path,
    target: str,
    dst: str | Path | None = None,
    options: Options | None = None,
    progress: ProgressFn | None = None,
) -> Path:
    """Convert ``src`` to ``target`` format. Returns the output path.

    ``dst`` defaults to the source path with the new extension.
    """
    src = Path(src)
    fmt = normalize(target)
    opts = (options or Options()).validate()

    if not src.is_file():
        raise ConversionError(f"Input file not found: {src}")
    in_ext = normalize(src.suffix)
    category = category_of(in_ext)
    if category is None:
        raise ConversionError(f"Unsupported input format: .{in_ext or '?'}")
    if fmt not in targets_for(in_ext) and fmt != in_ext:
        raise ConversionError(f"Cannot convert .{in_ext} to .{fmt}.")

    dst = Path(dst) if dst else src.with_suffix(f".{fmt}")
    if dst.resolve() == src.resolve():
        raise ConversionError("Output would overwrite the input file.")
    dst.parent.mkdir(parents=True, exist_ok=True)

    if category == "image" and fmt in IMAGE_OUT:
        _to_image(src, dst, fmt, opts)
        if progress:
            progress(1.0)
    elif fmt == "gif":
        _to_gif(src, dst, opts, progress)
    elif fmt in VIDEO_OUT:
        _to_video(src, dst, fmt, opts, progress)
    elif fmt in AUDIO_OUT:
        _to_audio(src, dst, fmt, opts, progress)
    elif fmt in FRAME_OUT:
        _to_frame(src, dst, fmt, opts, progress)
    else:  # pragma: no cover - guarded by targets_for
        raise ConversionError(f"No route for .{in_ext} to .{fmt}.")

    logger.info("Converted %s -> %s", src, dst)
    return dst
