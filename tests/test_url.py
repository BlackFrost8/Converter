import shutil
from pathlib import Path

import pytest
import yt_dlp

from converter.engine import ConversionError, Options
from converter.youtube_downloader import download, safe_filename
from tests.conftest import needs_ffmpeg


class FakeYDL:
    """Stands in for yt_dlp.YoutubeDL: 'downloads' a local sample file."""
    source: Path = None
    calls = []

    def __init__(self, params):
        self.params = params
        FakeYDL.calls.append(params)

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def extract_info(self, url, download=True):
        info = {"title": "Me at the zoo / test", "duration": 3, "extractor_key": "Youtube"}
        reason = self.params.get("match_filter", lambda i, incomplete: None)(info, incomplete=False)
        if reason:
            raise yt_dlp.utils.DownloadError(reason)
        if download:
            dest = Path(self.params["outtmpl"].replace("%(ext)s", self.source.suffix.lstrip(".")))
            shutil.copy(self.source, dest)
            for hook in self.params.get("progress_hooks", []):
                hook({"status": "downloading", "downloaded_bytes": 5, "total_bytes": 10})
        return info


@pytest.fixture
def fake(monkeypatch, media):
    FakeYDL.calls = []
    monkeypatch.setattr(yt_dlp, "YoutubeDL", FakeYDL)
    return FakeYDL


def test_safe_filename():
    assert safe_filename('a/b:c*?"<>|') == "abc"
    assert safe_filename("   ") == "download"


@needs_ffmpeg
def test_link_to_mp3(fake, media, tmp_path):
    fake.source = media["mp4"]
    seen = []
    out = download("https://www.youtube.com/watch?v=x", "mp3", tmp_path, progress=seen.append)
    assert out.name == "Me at the zoo  test.mp3" and out.stat().st_size > 0
    assert fake.calls[0]["format"] == "bestaudio/best"
    assert "-generic" in fake.calls[0]["allowed_extractors"]
    assert seen[0] == pytest.approx(0.35) and seen[-1] == 1.0
    assert list(tmp_path.iterdir()) == [out]  # temp dir cleaned up


@needs_ffmpeg
def test_link_to_mp4_skips_reencode(fake, media, tmp_path):
    fake.source = media["mp4"]
    out = download("https://youtu.be/x", "mp4", tmp_path)
    assert out.read_bytes() == media["mp4"].read_bytes()


@needs_ffmpeg
def test_link_to_gif_trimmed(fake, media, tmp_path):
    fake.source = media["mp4"]
    out = download("https://youtu.be/x", "gif", tmp_path, Options(start=0.5, end=1.5))
    assert out.suffix == ".gif"


def test_link_validation(fake, media, tmp_path):
    with pytest.raises(ConversionError):
        download("ftp://example.com/a", "mp3", tmp_path)
    with pytest.raises(ConversionError):
        download("https://youtu.be/x", "png", tmp_path)
