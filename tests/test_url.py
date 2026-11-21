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
    extractions = 0
    duration = 3

    def __init__(self, params):
        self.params = params
        FakeYDL.calls.append(params)

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    @staticmethod
    def sanitize_info(info):
        return info

    def extract_info(self, url, download=True):
        FakeYDL.extractions += 1
        info = {"title": "Me at the zoo / test", "duration": FakeYDL.duration, "extractor_key": "Youtube",
                "formats": [{"height": 240, "vcodec": "avc1"}, {"height": 720, "vcodec": "vp9"},
                            {"height": None, "vcodec": "none"}]}
        return self.process_ie_result(info, download) if download else info

    def process_ie_result(self, info, download=True):
        reason = self.params.get("match_filter", lambda i, incomplete: None)(info, incomplete=False)
        if reason:
            return info  # yt-dlp skips filtered videos without raising
        if download:
            dest = Path(self.params["outtmpl"].replace("%(ext)s", self.source.suffix.lstrip(".")))
            shutil.copy(self.source, dest)
            for hook in self.params.get("progress_hooks", []):
                hook({"status": "downloading", "downloaded_bytes": 5, "total_bytes": 10, "speed": 2_097_152, "eta": 75})
        return info


@pytest.fixture
def fake(monkeypatch, media):
    from converter import youtube_downloader
    FakeYDL.calls = []
    FakeYDL.extractions = 0
    FakeYDL.duration = 3
    youtube_downloader._info_cache.clear()
    monkeypatch.setattr(yt_dlp, "YoutubeDL", FakeYDL)
    return FakeYDL


def test_safe_filename():
    assert safe_filename('a/b:c*?"<>|') == "abc"
    assert safe_filename("   ") == "download"


@needs_ffmpeg
def test_link_to_mp3(fake, media, tmp_path):
    fake.source = media["mp4"]
    seen = []
    out = download("https://www.youtube.com/watch?v=x", "mp3", tmp_path, progress=lambda p, d=None: seen.append(p))
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


def test_speed_detail():
    from converter.youtube_downloader import _speed_detail
    assert _speed_detail({"speed": 2_097_152, "eta": 75}) == "2.0 MB/s · 1:15 left"
    assert _speed_detail({}) is None


@needs_ffmpeg
def test_info_is_reused_by_download(fake, media, tmp_path):
    from converter.youtube_downloader import fetch_info
    fake.source = media["mp4"]
    info = fetch_info("https://youtu.be/abc")
    assert info["heights"] == [240, 720]
    download("https://youtu.be/abc", "mp3", tmp_path)
    assert fake.extractions == 1


@needs_ffmpeg
def test_quality_cap_in_format(fake, media, tmp_path):
    fake.source = media["mp4"]
    download("https://youtu.be/q", "webm", tmp_path, Options(max_height=480))
    assert "height<=480" in fake.calls[-1]["format"]
    download("https://youtu.be/q", "gif", tmp_path, Options(end=1))
    assert "height<=720" in fake.calls[-1]["format"]


def test_too_long_reports_reason(fake, media, tmp_path):
    fake.source = media["mp4"]
    fake.duration = 5 * 3600
    with pytest.raises(ConversionError, match="too long"):
        download("https://youtu.be/long", "mp3", tmp_path)
