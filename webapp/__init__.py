"""Flask server: serves the converter page (docs/) and the API used for links.

Files are converted in the visitor's browser; this server does the work browsers can't:
downloading from YouTube and other sites. /api/convert (server-side file conversion) is
kept for API and script use.
"""

from __future__ import annotations

import logging
import os
import shutil
import tempfile
import threading
import time
import uuid
from collections import defaultdict, deque
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from flask import Flask, abort, jsonify, request, send_file, send_from_directory
from werkzeug.middleware.proxy_fix import ProxyFix
from werkzeug.utils import secure_filename

from converter.engine import ConversionError, Options, convert
from converter.formats import category_of, normalize, registry, targets_for
from converter.youtube_downloader import download, fetch_info, is_valid_url

logger = logging.getLogger(__name__)

SITE_DIR = Path(__file__).resolve().parent.parent / "docs"
JOB_TTL_SECONDS = 60 * 60  # results are deleted an hour after they finish


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except ValueError:
        return default


@dataclass
class Job:
    id: str
    workdir: Path
    status: str = "queued"          # queued | running | done | error
    progress: float = 0.0
    detail: Optional[str] = None    # e.g. "3.1 MB/s · 0:12 left"
    error: Optional[str] = None
    output: Optional[Path] = None
    download_name: Optional[str] = None
    finished_at: Optional[float] = None
    created_at: float = field(default_factory=time.time)

    def public(self) -> dict:
        return {
            "id": self.id,
            "status": self.status,
            "progress": round(self.progress, 3),
            "detail": self.detail,
            "error": self.error,
            "filename": self.download_name,
            "size": self.output.stat().st_size if self.output and self.output.exists() else None,
        }


class JobStore:
    def __init__(self, root: Path, workers: int, max_queue: int):
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)
        self.jobs: dict[str, Job] = {}
        self.lock = threading.Lock()
        self.max_queue = max_queue
        self.pool = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="convert")
        threading.Thread(target=self._reaper, daemon=True).start()

    def new(self) -> Job:
        with self.lock:
            pending = sum(1 for j in self.jobs.values() if j.status in ("queued", "running"))
            if pending >= self.max_queue:
                raise ConversionError("The converter is busy right now. Try again in a minute.")
            job_id = uuid.uuid4().hex
            job = Job(id=job_id, workdir=self.root / job_id)
            job.workdir.mkdir()
            self.jobs[job_id] = job
        return job

    def get(self, job_id: str) -> Optional[Job]:
        with self.lock:
            return self.jobs.get(job_id)

    def submit(self, job: Job, fn) -> None:
        def run():
            job.status = "running"

            def progress(p: float, detail: Optional[str] = None):
                job.progress = max(job.progress, p)
                job.detail = detail

            try:
                out = fn(progress)
                job.output = out
                job.download_name = out.name
                job.progress = 1.0
                job.detail = None
                job.status = "done"
            except ConversionError as e:
                job.error, job.status = str(e), "error"
            except Exception:  # never leak tracebacks to the browser
                logger.exception("Job %s crashed", job.id)
                job.error, job.status = "Unexpected error during conversion.", "error"
            finally:
                job.finished_at = time.time()

        self.pool.submit(run)

    def _reaper(self) -> None:
        while True:
            time.sleep(60)
            now = time.time()
            with self.lock:
                stale = [j for j in self.jobs.values() if j.finished_at and now - j.finished_at > JOB_TTL_SECONDS]
                for j in stale:
                    self.jobs.pop(j.id, None)
            for j in stale:
                shutil.rmtree(j.workdir, ignore_errors=True)


class RateLimiter:
    """Sliding-window limit of N job submissions per client IP per hour."""

    def __init__(self, per_hour: int):
        self.per_hour = per_hour
        self.hits: dict[str, deque] = defaultdict(deque)
        self.lock = threading.Lock()

    def check(self, key: str) -> None:
        if self.per_hour <= 0:
            return
        now = time.time()
        with self.lock:
            q = self.hits[key]
            while q and now - q[0] > 3600:
                q.popleft()
            if len(q) >= self.per_hour:
                wait = int(3600 - (now - q[0])) // 60 + 1
                raise ConversionError(f"Hourly limit reached ({self.per_hour} conversions). Try again in {wait} min.")
            q.append(now)


def _float(value) -> Optional[float]:
    if value in (None, ""):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        raise ConversionError(f"'{value}' is not a valid number of seconds.")


def _options(data) -> Options:
    try:
        return Options(
            audio_bitrate=str(data.get("bitrate") or "192k"),
            gif_fps=int(data.get("gif_fps") or 12),
            gif_width=int(data.get("gif_width") if data.get("gif_width") not in (None, "") else 480),
            image_quality=int(data.get("quality") or 90),
            start=_float(data.get("start")),
            end=_float(data.get("end")),
        ).validate()
    except ValueError:
        raise ConversionError("One of the options is not a valid number.")


def create_app(work_root: Optional[str] = None) -> Flask:
    app = Flask(__name__, static_folder=None)
    if os.environ.get("CONVERTER_BEHIND_PROXY") == "1":
        # Trust one reverse proxy (Render, Fly, nginx...) for the client IP and scheme.
        app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)

    max_mb = _env_int("CONVERTER_MAX_UPLOAD_MB", 1024)
    app.config["MAX_CONTENT_LENGTH"] = max_mb * 1024 * 1024
    root = Path(work_root or os.environ.get("CONVERTER_WORKDIR") or Path(tempfile.gettempdir()) / "converter-jobs")
    store = JobStore(root, workers=_env_int("CONVERTER_WORKERS", 2), max_queue=_env_int("CONVERTER_MAX_QUEUE", 20))
    limiter = RateLimiter(_env_int("CONVERTER_RATE_LIMIT", 0))  # 0 = unlimited (local use)
    app.extensions["jobs"] = store

    allowed_origins = {
        o.strip().rstrip("/")
        for o in os.environ.get("CONVERTER_ALLOWED_ORIGINS", "https://blackfrost8.github.io").split(",")
        if o.strip()
    }

    @app.after_request
    def headers(response):
        origin = request.headers.get("Origin", "").rstrip("/")
        if request.path.startswith("/api/") and (origin in allowed_origins or "*" in allowed_origins):
            response.headers["Access-Control-Allow-Origin"] = origin
            response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
            response.headers["Access-Control-Allow-Headers"] = "Content-Type"
            response.headers["Access-Control-Max-Age"] = "600"
            response.headers.add("Vary", "Origin")
            # Chrome asks before a public site may call a server on localhost / the LAN.
            if request.headers.get("Access-Control-Request-Private-Network") == "true":
                response.headers["Access-Control-Allow-Private-Network"] = "true"
        return response

    @app.errorhandler(ConversionError)
    def conversion_error(e):
        status = 429 if "limit" in str(e) or "busy" in str(e) else 400
        return jsonify(error=str(e)), status

    @app.errorhandler(413)
    def too_large(_):
        return jsonify(error=f"File is larger than the {max_mb} MB limit."), 413

    # ---------------------------------------------------------------- site

    @app.get("/")
    def index():
        return send_from_directory(SITE_DIR, "index.html")

    @app.get("/<path:filename>")
    def site_file(filename):
        if filename.startswith("api/"):
            abort(404)
        response = send_from_directory(SITE_DIR, filename)
        if filename.startswith("vendor/"):
            response.cache_control.max_age = 7 * 24 * 3600  # 31 MB wasm: cache it
        return response

    @app.get("/healthz")
    def healthz():
        return jsonify(ok=True)

    # ---------------------------------------------------------------- api

    @app.get("/api/formats")
    def formats():
        return jsonify(registry())

    @app.post("/api/convert")
    def convert_upload():
        upload = request.files.get("file")
        if not upload or not upload.filename:
            raise ConversionError("No file was uploaded.")
        name = secure_filename(upload.filename) or "upload"
        ext = normalize(Path(name).suffix)
        if category_of(ext) is None:
            raise ConversionError(f"Unsupported file type: .{ext or '?'}")
        target = normalize(request.form.get("target", ""))
        if target not in targets_for(ext):
            raise ConversionError(f"Cannot convert .{ext} to .{target or '?'}.")
        opts = _options(request.form)
        limiter.check(request.remote_addr or "?")

        job = store.new()
        src = job.workdir / f"input.{ext}"
        upload.save(src)
        stem = Path(name).stem or "converted"
        dst = job.workdir / "out" / f"{stem}.{target}"
        store.submit(job, lambda progress: convert(src, target, dst, opts, progress))
        return jsonify(job.public()), 202

    @app.post("/api/url")
    def convert_url():
        data = request.get_json(silent=True) or {}
        url = str(data.get("url", "")).strip()
        if not is_valid_url(url):
            raise ConversionError("Enter a valid http(s) link.")
        target = normalize(str(data.get("target", "")))
        opts = _options(data)
        limiter.check(request.remote_addr or "?")
        job = store.new()
        store.submit(job, lambda progress: download(url, target, job.workdir / "out", opts, progress))
        return jsonify(job.public()), 202

    @app.post("/api/url/info")
    def url_info():
        data = request.get_json(silent=True) or {}
        return jsonify(fetch_info(str(data.get("url", "")).strip()))

    @app.get("/api/jobs/<job_id>")
    def job_status(job_id):
        job = store.get(job_id)
        if not job:
            abort(404)
        return jsonify(job.public())

    @app.get("/api/jobs/<job_id>/download")
    def job_download(job_id):
        job = store.get(job_id)
        if not job or job.status != "done" or not job.output or not job.output.exists():
            abort(404)
        return send_file(job.output, as_attachment=True, download_name=job.download_name)

    return app
