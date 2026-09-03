"""Environment configuration.

Mirrors backend/src/config/env.ts key-for-key so the TS ``.env`` can be reused.
Timestamp/cursor units: epoch MILLISECONDS as integers (same as the TS/DB layer).
"""

from __future__ import annotations

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    node_env: str = "development"  # NODE_ENV
    port: int = 3001  # PORT
    app_origin: str = "http://localhost:3000"  # APP_ORIGIN
    database_url: str = "./data/app.db"  # DATABASE_URL
    cookie_secure: bool = False  # COOKIE_SECURE ("true"/"false"/"1"/"0")
    trust_proxy: bool = False  # TRUST_PROXY：是否信任反向代理的 X-Forwarded-For（直连公网保持 false）
    session_ttl_ms: int = 30 * 24 * 3600 * 1000  # SESSION_TTL_MS
    allowed_email_domains: str = "example.edu.cn"  # ALLOWED_EMAIL_DOMAINS
    storage_secret: str = "dev-storage-secret-change-me"  # STORAGE_SECRET
    upload_dir: str = "./uploads"  # UPLOAD_DIR
    admin_password: str = "SamryethaAdmin@NeatAvocado2026!"  # ADMIN_PASSWORD
    dev_password: str = "NeatAvocadoOnTop2026"  # DEV_PASSWORD
    smtp_url: str | None = None  # SMTP_URL
    smtp_from: str = "Samryetha <no-reply@samryetha.local>"  # SMTP_FROM
    outbox_poll_interval_ms: int = 500  # OUTBOX_POLL_INTERVAL_MS

    @property
    def is_production(self) -> bool:
        return self.node_env == "production"

    @property
    def email_domain_allowlist(self) -> list[str]:
        return [
            d.strip().lower()
            for d in self.allowed_email_domains.split(",")
            if d.strip()
        ]


# 生产环境禁止使用的默认凭据/密钥（代码兜底默认值，防误用公开已知默认凭据上线）
_PROD_FORBIDDEN_DEFAULTS = {
    "ADMIN_PASSWORD": "SamryethaAdmin@NeatAvocado2026!",
    "DEV_PASSWORD": "NeatAvocadoOnTop2026",
    "STORAGE_SECRET": "dev-storage-secret-change-me",
}


def load_settings() -> Settings:
    settings = Settings()
    if settings.is_production:
        offenders = [
            name for name, default in _PROD_FORBIDDEN_DEFAULTS.items()
            if getattr(settings, name.lower()) == default
        ]
        if offenders:
            raise RuntimeError(
                "Insecure defaults detected in production: "
                + " / ".join(offenders)
                + " must be overridden"
            )
    return settings
