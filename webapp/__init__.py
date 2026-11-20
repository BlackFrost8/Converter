"""Flask web interface for the converter."""

from __future__ import annotations

import logging
import os
import shutil
import tempfile
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from flask import Flask, abort, jsonify, render_template, request, send_file
from werkzeug.utils import secure_filename

from converter.engine import ConversionError, Options, convert
from converter.formats import category_of, normalize, registry, targets_for
from converter.youtube_downloader import download, fetch_info, is_valid_url

logger = logging.getLogger(__name__)

JOB_TTL_SECONDS = 60 * 60  # results are deleted an hour after they finish


@dataclass
class Job:
    id: str
    workdir: Path
    status: str = "queued"          # queued | running | done | error
    progress: float = 0.0
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
            "error": self.error,
            "filename": self.download_name,
            "size": self.output.stat().st_size if self.output and self.output.exists() else None,
        }


class JobStore:
    def __init__(self, root: Path, workers: int):
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)
        self.jobs: dict[str, Job] = {}
        self.lock = threading.Lock()
        self.pool = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="convert")
        threading.Thread(target=self._reaper, daemon=True).start()

    def new(self) -> Job:
        job_id = uuid.uuid4().hex
        job = Job(id=job_id, workdir=self.root / job_id)
        job.workdir.mkdir()
        with self.lock:
            self.jobs[job_id] = job
        return job

    def get(self, job_id: str) -> Optional[Job]:
        with self.lock:
            return self.jobs.get(job_id)

    def submit(self, job: Job, fn) -> None:
        def run():
            job.status = "running"

            def progress(p: float):
                job.progress = max(job.progress, p)

            try:
                out = fn(progress)
                job.output = out
                job.download_name = out.name
                job.progress = 1.0
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
    app = Flask(__name__)
    max_mb = int(os.environ.get("CONVERTER_MAX_UPLOAD_MB", "1024"))
    app.config["MAX_CONTENT_LENGTH"] = max_mb * 1024 * 1024
    root = Path(work_root or os.environ.get("CONVERTER_WORKDIR") or Path(tempfile.gettempdir()) / "converter-jobs")
    store = JobStore(root, workers=int(os.environ.get("CONVERTER_WORKERS", "2")))
    app.extensions["jobs"] = store

    @app.errorhandler(ConversionError)
    def conversion_error(e):
        return jsonify(error=str(e)), 400

    @app.errorhandler(413)
    def too_large(_):
        return jsonify(error=f"File is larger than the {max_mb} MB limit."), 413

    @app.get("/")
    def index():
        return render_template("index.html", max_mb=max_mb)

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
