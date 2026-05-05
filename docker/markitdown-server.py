import cgi
import hashlib
import json
import mimetypes
import os
import sqlite3
import tempfile
import time
from contextlib import closing
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Tuple

from markitdown import MarkItDown

try:
    from PIL import Image
except Exception:  # pragma: no cover - optional runtime helper
    Image = None


HOST = os.environ.get("MARKITDOWN_HOST", "0.0.0.0")
PORT = int(os.environ.get("MARKITDOWN_PORT", "18003"))
MAX_UPLOAD_BYTES = int(os.environ.get("MARKITDOWN_MAX_UPLOAD_BYTES", str(50 * 1024 * 1024)))
ENABLE_PLUGINS = os.environ.get("MARKITDOWN_ENABLE_PLUGINS", "false").lower() in {"1", "true", "yes", "on"}
MARKITDOWN_CACHE_DB_PATH = os.environ.get("MARKITDOWN_CACHE_DB_PATH", "/app/data/markitdown-cache.sqlite")
MARKITDOWN_CACHE_TTL_SECONDS = int(os.environ.get("MARKITDOWN_CACHE_TTL_SECONDS", "0"))
MARKITDOWN_CACHE_MAX_ENTRIES = int(os.environ.get("MARKITDOWN_CACHE_MAX_ENTRIES", "4096"))
MARKITDOWN = MarkItDown(enable_plugins=ENABLE_PLUGINS)
CACHE_SCHEMA = "daio.markitdown.cache.v1"


def env_setting(names: Tuple[str, ...], fallback: str) -> str:
    for name in names:
        value = os.environ.get(name)
        if value and value.strip():
            return value.strip()
    return fallback


CORS_ALLOW_ORIGIN = env_setting(("MARKITDOWN_CORS_ALLOW_ORIGIN", "CORS_ALLOW_ORIGIN"), "*")
CORS_ALLOW_METHODS = env_setting(("MARKITDOWN_CORS_ALLOW_METHODS", "CORS_ALLOW_METHODS"), "GET,POST,OPTIONS")
CORS_ALLOW_HEADERS = env_setting(
    ("MARKITDOWN_CORS_ALLOW_HEADERS", "CORS_ALLOW_HEADERS"),
    "Content-Type,Authorization,X-Requested-With,X-Filename",
)
CORS_EXPOSE_HEADERS = env_setting(("MARKITDOWN_CORS_EXPOSE_HEADERS", "CORS_EXPOSE_HEADERS"), "Content-Length,Content-Type")
CORS_MAX_AGE = env_setting(("MARKITDOWN_CORS_MAX_AGE", "CORS_MAX_AGE"), "86400")
CORS_ALLOW_CREDENTIALS = os.environ.get("MARKITDOWN_CORS_ALLOW_CREDENTIALS", os.environ.get("CORS_ALLOW_CREDENTIALS", "false")).lower() in {
    "1",
    "true",
    "yes",
    "on",
}


def allowed_origin(request_origin: str | None) -> str | None:
    entries = [origin.strip() for origin in CORS_ALLOW_ORIGIN.split(",") if origin.strip()]
    if "*" in entries:
        return request_origin if CORS_ALLOW_CREDENTIALS else "*"
    if request_origin and request_origin in entries:
        return request_origin
    return None


def json_response(handler: BaseHTTPRequestHandler, status: int, payload: object) -> None:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def now_ms() -> int:
    return int(time.time() * 1000)


def cache_enabled() -> bool:
    return MARKITDOWN_CACHE_MAX_ENTRIES > 0


def cache_conn() -> sqlite3.Connection:
    if MARKITDOWN_CACHE_DB_PATH != ":memory:":
        Path(MARKITDOWN_CACHE_DB_PATH).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(MARKITDOWN_CACHE_DB_PATH, timeout=5)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA busy_timeout=5000")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS markitdown_response_cache (
          cache_key TEXT PRIMARY KEY,
          markdown TEXT NOT NULL,
          byte_count INTEGER NOT NULL,
          webp_converted INTEGER NOT NULL,
          created_at_ms INTEGER NOT NULL,
          accessed_at_ms INTEGER NOT NULL
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_markitdown_response_cache_accessed_at "
        "ON markitdown_response_cache(accessed_at_ms)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_markitdown_response_cache_created_at "
        "ON markitdown_response_cache(created_at_ms)"
    )
    return conn


def cache_key(raw: bytes, suffix: str, content_type: str) -> str:
    body = {
        "schema": CACHE_SCHEMA,
        "raw_sha256": hashlib.sha256(raw).hexdigest(),
        "suffix": suffix.lower(),
        "content_type": content_type.split(";")[0].strip().lower(),
        "enable_plugins": ENABLE_PLUGINS,
        "webp_supported": Image is not None,
    }
    return hashlib.sha256(json.dumps(body, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()


def get_cached_response(key: str) -> dict[str, object] | None:
    if not cache_enabled():
        return None
    try:
        with closing(cache_conn()) as conn:
            row = conn.execute(
                """
                SELECT markdown, byte_count, webp_converted, created_at_ms
                FROM markitdown_response_cache
                WHERE cache_key = ?
                """,
                (key,),
            ).fetchone()
            if row is None:
                return None
            markdown, byte_count, webp_converted, created_at_ms = row
            if MARKITDOWN_CACHE_TTL_SECONDS > 0 and now_ms() - int(created_at_ms) >= MARKITDOWN_CACHE_TTL_SECONDS * 1000:
                conn.execute("DELETE FROM markitdown_response_cache WHERE cache_key = ?", (key,))
                conn.commit()
                return None
            conn.execute(
                "UPDATE markitdown_response_cache SET accessed_at_ms = ? WHERE cache_key = ?",
                (now_ms(), key),
            )
            conn.commit()
            return {
                "markdown": markdown,
                "bytes": int(byte_count),
                "webpConverted": bool(webp_converted),
            }
    except Exception as exc:
        print(f"[markitdown] cache read skipped: {exc}", flush=True)
        return None


def prune_cache(conn: sqlite3.Connection) -> None:
    if MARKITDOWN_CACHE_MAX_ENTRIES <= 0:
        conn.execute("DELETE FROM markitdown_response_cache")
        return
    if MARKITDOWN_CACHE_TTL_SECONDS > 0:
        conn.execute(
            "DELETE FROM markitdown_response_cache WHERE created_at_ms <= ?",
            (now_ms() - MARKITDOWN_CACHE_TTL_SECONDS * 1000,),
        )
    row = conn.execute("SELECT COUNT(*) FROM markitdown_response_cache").fetchone()
    count = int(row[0]) if row else 0
    excess = count - MARKITDOWN_CACHE_MAX_ENTRIES
    if excess <= 0:
        return
    conn.execute(
        """
        DELETE FROM markitdown_response_cache
        WHERE cache_key IN (
          SELECT cache_key
          FROM markitdown_response_cache
          ORDER BY accessed_at_ms ASC
          LIMIT ?
        )
        """,
        (excess,),
    )


def set_cached_response(key: str, markdown: str, byte_count: int, webp_converted: bool) -> None:
    if not cache_enabled():
        return
    try:
        with closing(cache_conn()) as conn:
            timestamp = now_ms()
            conn.execute(
                """
                INSERT INTO markitdown_response_cache (
                  cache_key,
                  markdown,
                  byte_count,
                  webp_converted,
                  created_at_ms,
                  accessed_at_ms
                ) VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(cache_key) DO UPDATE SET
                  markdown = excluded.markdown,
                  byte_count = excluded.byte_count,
                  webp_converted = excluded.webp_converted,
                  created_at_ms = excluded.created_at_ms,
                  accessed_at_ms = excluded.accessed_at_ms
                """,
                (key, markdown, byte_count, int(webp_converted), timestamp, timestamp),
            )
            prune_cache(conn)
            conn.commit()
    except Exception as exc:
        print(f"[markitdown] cache write skipped: {exc}", flush=True)


def extension_for(filename: str, content_type: str | None) -> str:
    suffix = Path(filename).suffix
    if suffix:
        return suffix
    if content_type:
        guessed = mimetypes.guess_extension(content_type.split(";")[0].strip())
        if guessed:
            return guessed
    return ".bin"


def maybe_convert_webp(path: str) -> Tuple[str, bool]:
    if not path.lower().endswith(".webp") or Image is None:
        return path, False
    converted = tempfile.NamedTemporaryFile(delete=False, suffix=".png")
    converted.close()
    with Image.open(path) as img:
        img.save(converted.name, "PNG")
    return converted.name, True


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args: object) -> None:
        print(f"[markitdown] {self.address_string()} {fmt % args}", flush=True)

    def end_headers(self) -> None:
        origin = allowed_origin(self.headers.get("Origin"))
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            if origin != "*":
                self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", CORS_ALLOW_METHODS)
        self.send_header(
            "Access-Control-Allow-Headers",
            self.headers.get("Access-Control-Request-Headers", CORS_ALLOW_HEADERS),
        )
        self.send_header("Access-Control-Expose-Headers", CORS_EXPOSE_HEADERS)
        self.send_header("Access-Control-Max-Age", CORS_MAX_AGE)
        if CORS_ALLOW_CREDENTIALS:
            self.send_header("Access-Control-Allow-Credentials", "true")
        super().end_headers()

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:
        if self.path == "/health":
            json_response(self, 200, {"ok": True})
            return
        json_response(self, 404, {"error": "not_found"})

    def do_POST(self) -> None:
        if self.path != "/convert":
            json_response(self, 404, {"error": "not_found"})
            return

        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0:
            json_response(self, 400, {"error": "empty_body"})
            return
        if length > MAX_UPLOAD_BYTES:
            json_response(self, 413, {"error": "upload_too_large", "maxBytes": MAX_UPLOAD_BYTES})
            return

        content_type = self.headers.get("Content-Type", "application/octet-stream")
        filename = self.headers.get("X-Filename", "document.bin")
        raw: bytes

        if content_type.lower().startswith("multipart/form-data"):
            form = cgi.FieldStorage(
                fp=self.rfile,
                headers=self.headers,
                environ={
                    "REQUEST_METHOD": "POST",
                    "CONTENT_TYPE": content_type,
                    "CONTENT_LENGTH": str(length),
                },
            )
            if "file" not in form:
                json_response(self, 400, {"error": "multipart_field_file_required"})
                return
            field = form["file"]
            if isinstance(field, list):
                field = field[0]
            filename = field.filename or filename
            raw = field.file.read()
        else:
            raw = self.rfile.read(length)

        suffix = extension_for(filename, content_type)
        key = cache_key(raw, suffix, content_type)
        cached = get_cached_response(key)
        if cached is not None:
            json_response(
                self,
                200,
                {
                    "filename": filename,
                    **cached,
                    "cached": True,
                },
            )
            return

        tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
        converted_path = None
        try:
            tmp.write(raw)
            tmp.close()
            input_path, converted = maybe_convert_webp(tmp.name)
            converted_path = input_path if converted else None
            result = MARKITDOWN.convert_local(input_path)
            set_cached_response(key, result.markdown, len(raw), converted)
            json_response(
                self,
                200,
                {
                    "filename": filename,
                    "markdown": result.markdown,
                    "bytes": len(raw),
                    "webpConverted": converted,
                    "cached": False,
                },
            )
        except Exception as exc:
            json_response(self, 422, {"error": "conversion_failed", "detail": str(exc)})
        finally:
            for path in [tmp.name, converted_path]:
                if path:
                    try:
                        os.unlink(path)
                    except FileNotFoundError:
                        pass


if __name__ == "__main__":
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(
        f"[markitdown] listening http://{HOST}:{PORT} cacheDb={MARKITDOWN_CACHE_DB_PATH} "
        f"cacheTtlSeconds={MARKITDOWN_CACHE_TTL_SECONDS} cacheMaxEntries={MARKITDOWN_CACHE_MAX_ENTRIES}",
        flush=True,
    )
    server.serve_forever()
