"""Хостинг виджетов AnyQ и загрузка вложений в Grist.

Зачем сервис, а не GitHub Pages:
  1. виджеты отдаются с домена компании, а не со стороннего github.io;
  2. Grist 1.7.18 не выдаёт виджету токен доступа (эндпоинта /access/token
     нет), поэтому браузер не может сам залить файл в документ. Файл идёт
     сюда, а сервер докладывает API-ключ, который не покидает контейнер.

Переменные окружения:
    grist_url  — https://work.anyq.chat
    api_key    — ключ бота Grist (только здесь, в браузер не уходит)
    PORT       — задаёт Railway

Маршруты:
    GET  /                  → dashboard.html
    GET  /<файл>.html       → статика рядом со скриптом
    POST /upload?doc=<id>   → multipart «upload», отдаёт [id вложения]
    GET  /file?doc=&att=    → отдаёт вложение из Grist (счёт на оплату)
    GET  /healthz           → ok
"""
import json
import os
import urllib.error
import urllib.parse
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).parent
GRIST_URL = (os.environ.get("grist_url") or os.environ.get("GRIST_URL") or "").rstrip("/")
API_KEY = os.environ.get("api_key") or os.environ.get("API_KEY") or ""
MAX_UPLOAD = 25 * 1024 * 1024  # 25 МБ: счёт-фактура столько не весит
ALLOWED_DOC = None  # можно сузить до конкретных доков через env, см. main()


def _multipart(body, boundary):
    """Достаёт первый файл из multipart/form-data. Возвращает (имя, байты)."""
    sep = b"--" + boundary
    for part in body.split(sep):
        if b"filename=" not in part:
            continue
        head, _, data = part.partition(b"\r\n\r\n")
        name = "upload.bin"
        for token in head.split(b";"):
            token = token.strip()
            if token.startswith(b"filename="):
                name = token.split(b"=", 1)[1].strip(b'"').decode("utf-8", "replace")
        return name, data.rstrip(b"\r\n")
    return None, None


class Handler(BaseHTTPRequestHandler):
    server_version = "anyq-widgets"

    def log_message(self, fmt, *args):  # без шумного access-лога
        pass

    def _send(self, code, body=b"", ctype="text/plain; charset=utf-8"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        if body:
            self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/healthz":
            return self._send(200, b"ok")
        if path == "/file":
            qs = dict(p.split("=", 1) for p in self.path.split("?", 1)[-1].split("&") if "=" in p)
            return self._proxy_attachment(qs)
        name = "dashboard.html" if path in ("/", "") else path.lstrip("/")
        if "/" in name or ".." in name or not name.endswith((".html", ".js", ".css", ".svg")):
            return self._send(404, b"not found")
        f = ROOT / name
        if not f.exists():
            return self._send(404, b"not found")
        ctype = {"html": "text/html; charset=utf-8", "js": "application/javascript",
                 "css": "text/css", "svg": "image/svg+xml"}[name.rsplit(".", 1)[1]]
        body = f.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        # виджет живёт в iframe Grist
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    def _proxy_attachment(self, qs):
        """GET /file?doc=<docId>&att=<id> — отдаёт вложение из Grist.

        Виджету казначея нужен файл счёта, который лежит в ДРУГОМ документе
        (Закупки), и без ключа браузер его не получит. Ключ подкладывает
        сервер, наружу уходит только сам файл.
        """
        doc = urllib.parse.unquote(qs.get("doc", ""))
        att = urllib.parse.unquote(qs.get("att", ""))
        if not doc.replace("-", "").replace("_", "").isalnum() or not att.isdigit():
            return self._send(400, "нужны doc и att".encode())
        if ALLOWED_DOC and doc not in ALLOWED_DOC:
            return self._send(403, "документ не разрешён".encode())
        req = urllib.request.Request(
            f"{GRIST_URL}/api/docs/{doc}/attachments/{att}/download",
            headers={"Authorization": f"Bearer {API_KEY}",
                     "User-Agent": "Mozilla/5.0 (widgets.anyq)"})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                body = r.read()
                self.send_response(200)
                self.send_header("Content-Type", r.headers.get("Content-Type", "application/octet-stream"))
                cd = r.headers.get("Content-Disposition")
                if cd:
                    self.send_header("Content-Disposition", cd)
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "private, max-age=300")
                self.end_headers()
                self.wfile.write(body)
        except urllib.error.HTTPError as e:
            self._send(e.code, f"Grist: {e.code}".encode())
        except Exception as e:
            self._send(502, f"Grist недоступен: {e}".encode())

    def do_POST(self):
        if not self.path.startswith("/upload"):
            return self._send(404, b"not found")
        if not (GRIST_URL and API_KEY):
            return self._send(500, "сервер не настроен: нет grist_url или api_key".encode())
        qs = dict(p.split("=", 1) for p in self.path.split("?", 1)[-1].split("&") if "=" in p)
        doc = urllib.parse.unquote(qs.get("doc", ""))
        if not doc or not doc.replace("-", "").replace("_", "").isalnum():
            return self._send(400, "не указан документ".encode())
        if ALLOWED_DOC and doc not in ALLOWED_DOC:
            return self._send(403, "документ не разрешён".encode())
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_UPLOAD:
            return self._send(413, "файл слишком большой".encode())
        ctype = self.headers.get("Content-Type") or ""
        if "boundary=" not in ctype:
            return self._send(400, "ожидается multipart/form-data".encode())
        boundary = ctype.split("boundary=", 1)[1].strip('"').encode()
        name, data = _multipart(self.rfile.read(length), boundary)
        if not data:
            return self._send(400, "файл не найден в запросе".encode())

        # пересобираем multipart для Grist (тот же файл, наш заголовок авторизации)
        b2 = uuid.uuid4().hex.encode()
        payload = (b"--" + b2 + b"\r\n"
                   b'Content-Disposition: form-data; name="upload"; filename="'
                   + name.encode("utf-8") + b'"\r\n'
                   b"Content-Type: application/octet-stream\r\n\r\n"
                   + data + b"\r\n--" + b2 + b"--\r\n")
        req = urllib.request.Request(
            f"{GRIST_URL}/api/docs/{doc}/attachments", data=payload, method="POST",
            headers={"Authorization": f"Bearer {API_KEY}",
                     "Content-Type": f"multipart/form-data; boundary={b2.decode()}",
                     "User-Agent": "Mozilla/5.0 (widgets.anyq)"})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return self._send(200, r.read(), "application/json")
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")[:300]
            return self._send(e.code, f"Grist: {e.code} {detail}".encode())
        except Exception as e:  # сеть, таймаут
            return self._send(502, f"Grist недоступен: {e}".encode())

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()


def main():
    global ALLOWED_DOC
    docs = os.environ.get("allowed_docs") or ""
    ALLOWED_DOC = {d.strip() for d in docs.split(",") if d.strip()} or None
    port = int(os.environ.get("PORT", "8080"))
    print(f"виджеты AnyQ на :{port}; Grist: {GRIST_URL or 'НЕ ЗАДАН'}; "
          f"ключ: {'есть' if API_KEY else 'НЕТ'}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()


if __name__ == "__main__":
    main()
