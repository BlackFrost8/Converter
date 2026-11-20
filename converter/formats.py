"""Registry of supported formats and which conversions are allowed."""

from pathlib import Path

VIDEO_IN = {"mp4", "mkv", "mov", "avi", "webm", "flv", "m4v", "wmv", "mpeg", "mpg", "3gp", "ts"}
AUDIO_IN = {"mp3", "wav", "aac", "m4a", "ogg", "oga", "flac", "opus", "wma", "aiff", "aif", "amr"}
IMAGE_IN = {"jpg", "jpeg", "png", "webp", "bmp", "tiff", "tif", "gif", "ico"}

VIDEO_OUT = ["mp4", "webm", "mkv", "mov", "avi", "gif"]
AUDIO_OUT = ["mp3", "wav", "flac", "m4a", "aac", "ogg", "opus", "aiff"]
IMAGE_OUT = ["png", "jpg", "webp", "bmp", "tiff", "gif", "ico", "pdf"]
FRAME_OUT = ["png", "jpg"]  # single still frame from a video

# What a link (YouTube or any site yt-dlp supports) can become.
URL_OUT = ["mp3", "m4a", "wav", "flac", "ogg", "opus", "mp4", "webm", "mkv", "gif"]

LABELS = {
    "video": "Video",
    "audio": "Audio",
    "image": "Image",
    "url": "Link",
}


def normalize(fmt: str) -> str:
    fmt = fmt.lower().lstrip(".")
    return {"jpeg": "jpg", "tif": "tiff", "aif": "aiff", "oga": "ogg", "mpg": "mpeg"}.get(fmt, fmt)


def category_of(path_or_ext: str) -> str | None:
    ext = Path(path_or_ext).suffix.lstrip(".") if "." in str(path_or_ext) else str(path_or_ext)
    ext = ext.lower()
    if ext in VIDEO_IN:
        return "video"
    if ext in AUDIO_IN:
        return "audio"
    if ext in IMAGE_IN:
        return "image"
    return None


def targets_for(path_or_ext: str) -> list[str]:
    """Output formats available for a given input file name or extension."""
    ext = normalize(Path(path_or_ext).suffix or str(path_or_ext))
    cat = category_of(ext)
    if cat == "video":
        out = VIDEO_OUT + AUDIO_OUT + FRAME_OUT
    elif cat == "audio":
        out = AUDIO_OUT
    elif cat == "image":
        out = list(IMAGE_OUT)
        if ext == "gif":  # animated GIF -> video
            out += ["mp4", "webm"]
    else:
        return []
    return [f for f in dict.fromkeys(out) if f != ext]


def registry() -> dict:
    """Serializable description used by the web UI."""
    return {
        "inputs": {
            "video": sorted(VIDEO_IN),
            "audio": sorted(AUDIO_IN),
            "image": sorted(IMAGE_IN),
        },
        "targets": {
            ext: targets_for(ext) for ext in sorted(VIDEO_IN | AUDIO_IN | IMAGE_IN)
        },
        "url": URL_OUT,
    }
