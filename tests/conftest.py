import shutil
import subprocess
import sys
from pathlib import Path

import pytest
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

needs_ffmpeg = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")


def _ff(*args):
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *args], check=True)


@pytest.fixture(scope="session")
def media(tmp_path_factory):
    d = tmp_path_factory.mktemp("media")
    files = {}
    img = Image.new("RGBA", (64, 48), (20, 120, 130, 200))
    files["png"] = d / "sample.png"
    img.save(files["png"])

    frames = [Image.new("RGB", (40, 40), (i * 40, 80, 120)) for i in range(5)]
    files["gif"] = d / "anim.gif"
    frames[0].save(files["gif"], save_all=True, append_images=frames[1:], duration=100, loop=0)

    if shutil.which("ffmpeg"):
        files["mp4"] = d / "clip.mp4"
        _ff("-f", "lavfi", "-i", "testsrc=size=160x120:rate=15:duration=3",
            "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", str(files["mp4"]))
        files["silent"] = d / "silent.mp4"
        _ff("-f", "lavfi", "-i", "testsrc=size=160x120:rate=15:duration=1",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", str(files["silent"]))
        files["wav"] = d / "tone.wav"
        _ff("-f", "lavfi", "-i", "sine=frequency=220:duration=2", str(files["wav"]))
    return files
