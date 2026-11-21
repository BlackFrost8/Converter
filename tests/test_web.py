import io
import time

import pytest

from tests.conftest import needs_ffmpeg
from webapp import create_app


@pytest.fixture
def client(tmp_path):
    app = create_app(str(tmp_path / "jobs"))
    app.testing = True
    return app.test_client()


def wait(client, job_id, timeout=30):
    end = time.time() + timeout
    while time.time() < end:
        job = client.get(f"/api/jobs/{job_id}").get_json()
        if job["status"] in ("done", "error"):
            return job
        time.sleep(0.1)
    raise AssertionError("job timed out")


def test_index_and_formats(client):
    assert b"Converter" in client.get("/").data
    reg = client.get("/api/formats").get_json()
    assert "mp3" in reg["targets"]["mp4"] and "mp3" in reg["url"]


def test_image_upload_roundtrip(client, media):
    data = {"file": (open(media["png"], "rb"), "my photo.png"), "target": "jpg", "quality": "80"}
    r = client.post("/api/convert", data=data, content_type="multipart/form-data")
    assert r.status_code == 202
    job = wait(client, r.get_json()["id"])
    assert job["status"] == "done" and job["filename"] == "my_photo.jpg"
    dl = client.get(f"/api/jobs/{job['id']}/download")
    assert dl.status_code == 200 and dl.data[:3] == b"\xff\xd8\xff"


@needs_ffmpeg
def test_video_upload_to_mp3(client, media):
    data = {"file": (open(media["mp4"], "rb"), "clip.mp4"), "target": "mp3", "bitrate": "128k"}
    r = client.post("/api/convert", data=data, content_type="multipart/form-data")
    job = wait(client, r.get_json()["id"])
    assert job["status"] == "done" and job["filename"] == "clip.mp3"


def test_bad_requests(client):
    r = client.post("/api/convert", data={"file": (io.BytesIO(b"x"), "a.docx"), "target": "pdf"},
                    content_type="multipart/form-data")
    assert r.status_code == 400
    r = client.post("/api/convert", data={"file": (io.BytesIO(b"x"), "a.png"), "target": "mp3"},
                    content_type="multipart/form-data")
    assert r.status_code == 400
    assert client.post("/api/url", json={"url": "file:///etc/passwd", "target": "mp3"}).status_code == 400
    assert client.get("/api/jobs/nope").status_code == 404
    assert client.get("/api/jobs/nope/download").status_code == 404


def test_corrupt_file_reports_error(client):
    r = client.post("/api/convert", data={"file": (io.BytesIO(b"not an image"), "a.png"), "target": "jpg"},
                    content_type="multipart/form-data")
    job = wait(client, r.get_json()["id"])
    assert job["status"] == "error" and "could not be read" in job["error"]


def test_cors_for_pages_origin(client):
    origin = "https://blackfrost8.github.io"
    r = client.get("/api/formats", headers={"Origin": origin})
    assert r.headers["Access-Control-Allow-Origin"] == origin
    pre = client.options("/api/url", headers={
        "Origin": origin,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Private-Network": "true",
    })
    assert pre.status_code == 200
    assert pre.headers["Access-Control-Allow-Private-Network"] == "true"
    assert "Content-Type" in pre.headers["Access-Control-Allow-Headers"]


def test_cors_rejects_other_origins(client):
    r = client.get("/api/formats", headers={"Origin": "https://evil.example"})
    assert "Access-Control-Allow-Origin" not in r.headers
    assert "Access-Control-Allow-Origin" not in client.get("/").headers


def test_serves_site_and_health(client):
    assert client.get("/app.js").status_code == 200
    assert client.get("/vendor/core/ffmpeg-core.js").status_code == 200
    assert client.get("/../README.md").status_code == 404
    assert client.get("/healthz").get_json() == {"ok": True}


def test_rate_limit(tmp_path, monkeypatch, media):
    monkeypatch.setenv("CONVERTER_RATE_LIMIT", "2")
    app = create_app(str(tmp_path / "jobs"))
    c = app.test_client()
    codes = []
    for _ in range(3):
        r = c.post("/api/convert", data={"file": (open(media["png"], "rb"), "a.png"), "target": "jpg"},
                   content_type="multipart/form-data")
        codes.append(r.status_code)
    assert codes == [202, 202, 429]
    assert "Hourly limit" in r.get_json()["error"]


def test_custom_domain_origin_and_served_config(client):
    origin = "https://convert.froststudio.org"
    assert client.get("/api/formats", headers={"Origin": origin}).headers["Access-Control-Allow-Origin"] == origin
    assert client.get("/healthz", headers={"Origin": origin}).headers["Access-Control-Allow-Origin"] == origin
    cfg = client.get("/config.js")
    assert cfg.status_code == 200 and b"servedByApp: true" in cfg.data
