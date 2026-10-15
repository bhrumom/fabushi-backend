#!/usr/bin/env python3
import hmac
import json
import logging
import os
import re
import subprocess
from email.message import EmailMessage
from email.utils import formatdate, make_msgid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TOKEN = os.environ.get("MAIL_API_TOKEN", "")
MAIL_FROM = os.environ.get("MAIL_FROM", "amitabha@ombhrum.com")
LISTEN_HOST = os.environ.get("MAIL_API_HOST", "127.0.0.1")
LISTEN_PORT = int(os.environ.get("MAIL_API_PORT", "8790"))
SEND_PATH = "/internal/fabushi-mail/v1/send"
LEGACY_REGISTRATION_PATH = "/internal/fabushi-mail/v1/send-registration-code"
EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")
CODE_RE = re.compile(r"^\d{6}$")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")


def queue_mail(email: str, subject: str, text: str) -> None:
    if not EMAIL_RE.fullmatch(MAIL_FROM) or MAIL_FROM.startswith("-"):
        raise ValueError("invalid configured sender")
    msg = EmailMessage()
    msg["From"] = f"Fabushi <{MAIL_FROM}>"
    msg["To"] = email
    msg["Subject"] = subject
    msg["Date"] = formatdate(localtime=False)
    msg["Message-ID"] = make_msgid(domain="ombhrum.com")
    msg.set_content(text, charset="utf-8")
    completed = subprocess.run(
        ["/usr/sbin/sendmail", "-f", MAIL_FROM, "-t", "-i"],
        input=msg.as_bytes(),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=20,
        check=False,
    )
    if completed.returncode != 0:
        raise RuntimeError("mail submission failed")


class Handler(BaseHTTPRequestHandler):
    server_version = "FabushiMail/2.0"

    def log_message(self, fmt, *args):
        logging.info("http " + fmt, *args)

    def _json(self, status: int, body: dict):
        payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(payload)))
        self.send_header("cache-control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    def _authorized(self) -> bool:
        provided = self.headers.get("authorization", "")
        expected = f"Bearer {TOKEN}"
        return len(TOKEN) >= 32 and hmac.compare_digest(provided, expected)

    def _body(self):
        try:
            length = int(self.headers.get("content-length", "0"))
        except ValueError:
            return None
        if length <= 0 or length > 16384:
            return None
        try:
            return json.loads(self.rfile.read(length))
        except Exception:
            return None

    def do_GET(self):
        if self.path == "/healthz":
            return self._json(200, {"ok": True, "service": "fabushi-mail", "provider": "bhrum2-postfix"})
        return self._json(404, {"ok": False, "error": "not_found"})

    def do_POST(self):
        if self.path not in {SEND_PATH, LEGACY_REGISTRATION_PATH}:
            return self._json(404, {"ok": False, "error": "not_found"})
        if not self._authorized():
            return self._json(401, {"ok": False, "error": "unauthorized"})
        body = self._body()
        if not isinstance(body, dict):
            return self._json(400, {"ok": False, "error": "invalid_request"})
        email = str(body.get("email", "")).strip().lower()
        if len(email) > 254 or not EMAIL_RE.match(email):
            return self._json(400, {"ok": False, "error": "invalid_email"})

        if self.path == LEGACY_REGISTRATION_PATH:
            code = str(body.get("code", "")).strip()
            if not CODE_RE.match(code):
                return self._json(400, {"ok": False, "error": "invalid_registration_email"})
            subject = "Fabushi 注册验证码"
            text = f"你的 Fabushi 注册验证码是：{code}\n\n验证码 10 分钟内有效。如果不是你本人操作，请忽略这封邮件。"
        else:
            subject = str(body.get("subject", "")).strip()
            text = str(body.get("text", "")).strip()
            if not subject or len(subject) > 160 or not text or len(text) > 10000:
                return self._json(400, {"ok": False, "error": "invalid_message"})

        try:
            queue_mail(email, subject, text)
            logging.info("mail submitted provider=bhrum2-postfix")
            return self._json(200, {"ok": True, "provider": "bhrum2-postfix"})
        except Exception:
            logging.error("mail submission failed")
            return self._json(502, {"ok": False, "error": "mail_enqueue_failed"})


if __name__ == "__main__":
    if len(TOKEN) < 32:
        raise SystemExit("MAIL_API_TOKEN must be at least 32 characters")
    ThreadingHTTPServer((LISTEN_HOST, LISTEN_PORT), Handler).serve_forever()

