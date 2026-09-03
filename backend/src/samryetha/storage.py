"""本地磁盘对象存储 + HMAC presign — 镜像 infrastructure/storage/local.ts。

URL pathname 语义与 S3 presigned 对齐；签名 = HMAC-SHA256("{method}|{pathname}|{expires}") hex。
"""

from __future__ import annotations

import hmac
import os
import re
import time
import uuid
from pathlib import Path

ALLOWED_EXTENSIONS = {
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif",
    ".pdf", ".txt", ".md", ".csv",
    ".zip", ".rar", ".7z",
    ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
    ".mp4", ".mov", ".mp3", ".wav",
}

OBJECT_KEY_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[^/]{1,255}$")

MAX_UPLOAD_BYTES = 50 * 1024 * 1024


def sanitize_filename(name: str) -> str:
    base = re.sub(r'[\\/:*?"<>|]', "_", name)
    base = re.sub(r"\s+", "_", base)[:80]
    return base or "file"


from .errors import internal_error


def _now_sec() -> int:
    return int(time.time())


class Storage:
    def __init__(self, root_dir: str, secret: str) -> None:
        self.root = root_dir
        self.secret = secret

    def _sign(self, method: str, pathname: str, expires: str) -> str:
        return hmac.new(self.secret.encode(), f"{method}|{pathname}|{expires}".encode(), "sha256").hexdigest()

    def _abspath(self, object_key: str) -> str:
        base = os.path.abspath(self.root)
        full = os.path.abspath(os.path.join(base, object_key))
        if not full.startswith(base + os.sep):
            raise PermissionError("Invalid object key")
        return full

    def create_upload_session(self, uploader_id: int, original_filename: str, mime_type: str, size_bytes: int) -> str:
        ext = os.path.splitext(original_filename)[1].lower()
        if ext and ext not in ALLOWED_EXTENSIONS:
            # 复刻 TS bug：白名单外扩展名抛普通 Error → 500
            raise internal_error()
        object_key = f"{uuid.uuid4()}/{sanitize_filename(original_filename)}"
        os.makedirs(os.path.join(self.root, os.path.dirname(object_key)), exist_ok=True)
        return object_key

    def generate_upload_url(self, object_key: str, content_type: str, expires_in_sec: int = 900) -> dict:
        expires = str(_now_sec() + expires_in_sec)
        pathname = f"/api/attachments/upload/{object_key}"
        sig = self._sign("PUT", pathname, expires)
        return {
            "url": f"{pathname}?expires={expires}&sig={sig}",
            "method": "PUT",
            "headers": {"content-type": content_type},
        }

    def generate_download_url(self, object_key: str, expires_in_sec: int = 3600) -> str:
        expires = str(_now_sec() + expires_in_sec)
        pathname = f"/api/attachments/serve/{object_key}"
        sig = self._sign("GET", pathname, expires)
        return f"{pathname}?expires={expires}&sig={sig}"

    def verify_signature(self, method: str, pathname: str, expires: str, sig: str) -> bool:
        if not re.fullmatch(r"\d+", expires) or int(expires) < _now_sec():
            return False
        expected = self._sign(method, pathname, expires)
        try:
            return hmac.compare_digest(expected, sig)
        except Exception:
            return False

    def delete_object(self, object_key: str) -> None:
        try:
            os.remove(self._abspath(object_key))
        except FileNotFoundError:
            pass

    def path_for(self, object_key: str) -> str:
        return self._abspath(object_key)
