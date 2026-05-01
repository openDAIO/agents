import cgi
import json
import mimetypes
import os
import tempfile
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
MARKITDOWN = MarkItDown(enable_plugins=os.environ.get("MARKITDOWN_ENABLE_PLUGINS", "false").lower() in {"1", "true", "yes", "on"})


def json_response(handler: BaseHTTPRequestHandler, status: int, payload: object) -> None:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


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
        tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
        converted_path = None
        try:
            tmp.write(raw)
            tmp.close()
            input_path, converted = maybe_convert_webp(tmp.name)
            converted_path = input_path if converted else None
            result = MARKITDOWN.convert_local(input_path)
            json_response(
                self,
                200,
                {
                    "filename": filename,
                    "markdown": result.markdown,
                    "bytes": len(raw),
                    "webpConverted": converted,
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
    print(f"[markitdown] listening http://{HOST}:{PORT}", flush=True)
    server.serve_forever()
