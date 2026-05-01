FROM python:3.12-slim-bookworm

ENV PYTHONUNBUFFERED=1
ENV EXIFTOOL_PATH=/usr/bin/exiftool
ENV FFMPEG_PATH=/usr/bin/ffmpeg

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates ffmpeg exiftool \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY tools/markitdown /opt/markitdown
COPY docker/markitdown-server.py /app/server.py

RUN pip install --no-cache-dir --upgrade pip \
  && pip install --no-cache-dir "/opt/markitdown/packages/markitdown[all]" Pillow

EXPOSE 18003

CMD ["python", "/app/server.py"]
