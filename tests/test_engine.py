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
