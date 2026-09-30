from pathlib import Path

from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="FACTOS_", env_file=".env", extra="ignore")
    data_dir: Path = Path("./data")
    allowed_origin: str = "http://localhost:5173"
    localhost_development: bool = True
    gemini_api_key: str = ""
    gemini_model: str = ""
    openai_api_key: str = ""
    embedding_model: str = ""
    embedding_dimension: int = Field(default=1536, ge=1, le=3072)
    embedding_max_tokens: int = Field(default=8191, ge=600)
    firecrawl_api_key: str = ""
    firecrawl_base_url: str = "https://api.firecrawl.dev"
    # Explicit operator attestation: the crawl service must block private destinations,
    # redirects and DNS rebinding at its fetch boundary. Fail closed without it.
    firecrawl_public_fetch_enforced: bool = False
    max_pending_tasks: int = Field(default=32, ge=2)
    max_model_requests: int = Field(default=4, ge=1)
    max_ingestions: int = Field(default=2, ge=1)
    model_timeout: float = 120
    analysis_timeout: float = 180
    max_file_bytes: int = 25 * 1024 * 1024
    history_tokens: int = 16000
    max_output_tokens: int = 4096
    temperature: float = 0.3

    @model_validator(mode="after")
    def validate_origin(self):
        from urllib.parse import urlsplit

        url = urlsplit(self.allowed_origin)
        if url.scheme not in {"http", "https"} or not url.hostname or url.path or url.query or url.fragment:
            raise ValueError("allowed_origin must be an exact HTTP(S) origin")
        if self.localhost_development and url.hostname not in {"localhost", "127.0.0.1", "::1"}:
            raise ValueError("insecure development cookies require a localhost origin")
        return self

    def manifest(self):
        return {
            "provider": "openai",
            "model": self.embedding_model,
            "dimension": self.embedding_dimension,
            "normalized": True,
            "parser_version": "1",
            "chunking_version": "cl100k-600-80-v1",
        }
