# Link service + converter page, for Render / Fly.io / any Docker host.
FROM python:3.12-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt gunicorn==23.0.0

COPY converter converter
COPY webapp webapp
COPY docs docs
COPY app.py main.py ./

RUN useradd --create-home app && chown -R app /app
USER app

# Public-server defaults; override in your host's environment settings.
ENV PYTHONUNBUFFERED=1 \
    CONVERTER_BEHIND_PROXY=1 \
    CONVERTER_RATE_LIMIT=30 \
    CONVERTER_MAX_UPLOAD_MB=200 \
    CONVERTER_WORKERS=2 \
    CONVERTER_ALLOWED_ORIGINS=https://blackfrost8.github.io

EXPOSE 8000
# One process (jobs live in memory), several threads for concurrent requests.
CMD ["sh", "-c", "exec gunicorn --workers 1 --threads 8 --timeout 120 --bind 0.0.0.0:${PORT:-8000} app:app"]
