import pytest
from PIL import Image

from converter.engine import ConversionError, Options, convert, probe_duration
from converter.formats import targets_for
from tests.conftest import needs_ffmpeg


def test_targets():
    assert "mp3" in targets_for("x.mp4") and "gif" in targets_for("x.mp4")
    assert "mp4" not in targets_for("x.mp4")
    assert "mp4" in targets_for("x.gif") and "mp4" not in targets_for("x.png")
    assert targets_for("x.docx") == []


@pytest.mark.parametrize("fmt", ["jpg", "webp", "bmp", "tiff", "gif", "ico", "pdf"])
def test_image_formats(media, tmp_path, fmt):
    out = convert(media["png"], fmt, tmp_path / f"o.{fmt}")
    assert out.stat().st_size > 0
    if fmt != "pdf":
        Image.open(out).verify()


def test_animated_gif_to_webp_keeps_frames(media, tmp_path):
    out = convert(media["gif"], "webp", tmp_path / "a.webp")
    assert Image.open(out).n_frames == 5


def test_rejects_unsupported(media, tmp_path):
    with pytest.raises(ConversionError):
        convert(media["png"], "mp3", tmp_path / "o.mp3")
    with pytest.raises(ConversionError):
        convert(tmp_path / "missing.mp4", "mp3")
    with pytest.raises(ConversionError):
        Options(audio_bitrate="lots").validate()
    with pytest.raises(ConversionError):
        Options(start=5, end=2).validate()


@needs_ffmpeg
@pytest.mark.parametrize("fmt", ["mp3", "wav", "flac", "m4a", "ogg", "opus"])
def test_video_to_audio(media, tmp_path, fmt):
    seen = []
    out = convert(media["mp4"], fmt, tmp_path / f"o.{fmt}", progress=seen.append)
    assert out.stat().st_size > 0
    assert seen[-1] == 1.0
    assert abs(probe_duration(out) - 3) < 0.3


@needs_ffmpeg
@pytest.mark.parametrize("fmt", ["webm", "mkv", "mov", "avi"])
def test_video_to_video(media, tmp_path, fmt):
    out = convert(media["mp4"], fmt, tmp_path / f"o.{fmt}")
    assert probe_duration(out) > 2


@needs_ffmpeg
def test_video_to_gif_trimmed(media, tmp_path):
    out = convert(media["mp4"], "gif", tmp_path / "o.gif", Options(start=1, end=2, gif_fps=10, gif_width=80))
    with Image.open(out) as g:
        assert g.size[0] == 80
        assert 8 <= g.n_frames <= 12


@needs_ffmpeg
def test_video_frame_and_gif_to_mp4(media, tmp_path):
    frame = convert(media["mp4"], "png", tmp_path / "f.png", Options(start=1))
    assert Image.open(frame).size == (160, 120)
    mp4 = convert(media["gif"], "mp4", tmp_path / "g.mp4")
    assert mp4.stat().st_size > 0


@needs_ffmpeg
def test_audio_to_audio(media, tmp_path):
    out = convert(media["wav"], "mp3", tmp_path / "t.mp3", Options(audio_bitrate="128k"))
    assert abs(probe_duration(out) - 2) < 0.2


@needs_ffmpeg
def test_no_audio_track_is_friendly(media, tmp_path):
    with pytest.raises(ConversionError, match="no stream"):
        convert(media["silent"], "mp3", tmp_path / "s.mp3")


@needs_ffmpeg
def test_trim_past_end_is_an_error(media, tmp_path):
    with pytest.raises(ConversionError, match="past the end"):
        convert(media["mp4"], "webm", tmp_path / "late.webm", Options(start=30, end=31))
    assert not (tmp_path / "late.webm").exists()


@needs_ffmpeg
def test_gif_never_upscales(media, tmp_path):
    out = convert(media["mp4"], "gif", tmp_path / "small.gif", Options(end=1, gif_width=480))
    with Image.open(out) as g:
        assert g.size[0] == 160


@needs_ffmpeg
def test_max_height_scales_down_never_up(media, tmp_path):
    small = convert(media["mp4"], "mkv", tmp_path / "s.mkv", Options(max_height=60))
    big = convert(media["mp4"], "mov", tmp_path / "b.mov", Options(max_height=1080))
    import subprocess
    def size(p):
        out = subprocess.run(["ffmpeg", "-hide_banner", "-i", str(p)], capture_output=True, text=True).stderr
        import re
        return re.search(r"Video: .*?(\d{2,5})x(\d{2,5})", out).groups()
    assert size(small) == ("80", "60")
    assert size(big) == ("160", "120")


@needs_ffmpeg
def test_cancel_kills_ffmpeg_and_removes_output(media, tmp_path):
    from converter.engine import Cancelled
    calls = []

    def progress(p, detail=None):
        calls.append(p)
        if len(calls) >= 1:
            raise Cancelled()

    dst = tmp_path / "c.webm"
    with pytest.raises(Cancelled):
        convert(media["mp4"], "webm", dst, progress=progress)
    assert not dst.exists()
