from typing import Literal

from pydantic import BaseModel, ConfigDict, EmailStr, Field, model_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Credentials(StrictModel):
    email: EmailStr
    password: str = Field(min_length=15, max_length=128)


class SessionCreate(StrictModel):
    title: str = Field(default="New comparison", min_length=1, max_length=200)


class TurnCreate(StrictModel):
    request_id: str = Field(min_length=1, max_length=100)
    text: str = Field(default="", max_length=16000)
    attachment_ids: list[str] = Field(default_factory=list, max_length=4)

    @model_validator(mode="after")
    def content(self):
        if not self.text.strip() and not self.attachment_ids:
            raise ValueError("text or images required")
        if len(set(self.attachment_ids)) != len(self.attachment_ids):
            raise ValueError("duplicate attachments")
        return self


class WebsiteCreate(StrictModel):
    url: str = Field(max_length=2048)
    include_paths: list[str] = Field(default_factory=list, max_length=20)


class SearchArgs(StrictModel):
    query: str = Field(min_length=1, max_length=2000)
    top_k: int = Field(default=6, ge=1, le=6)


class ChunkArgs(StrictModel):
    chunk_ids: list[str] = Field(min_length=1, max_length=3)


class Evidence(StrictModel):
    chunk_id: str
    excerpt: str = Field(min_length=1, max_length=4000)


class RawFinding(StrictModel):
    block_id: str
    quote: str = Field(min_length=1)
    occurrence: int = Field(default=0, ge=0)
    verdict: Literal["contradicted", "unverifiable"]
    reason_code: str
    reason: str = Field(min_length=1)
    correction: str | None = None
    evidence: list[Evidence] = Field(default_factory=list, max_length=6)


class Coverage(StrictModel):
    claims_extracted: int = Field(ge=0)
    claims_checked: int = Field(ge=0)
    extraction_truncated: bool = False
    unchecked_block_ids: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def counts(self):
        if self.claims_checked > self.claims_extracted or self.claims_checked > 20:
            raise ValueError("invalid coverage counts")
        if self.claims_extracted > 20 and not self.extraction_truncated:
            raise ValueError("claim budget exceeded without truncation disclosure")
        return self


class RawAnalysis(StrictModel):
    coverage: Coverage
    findings: list[RawFinding] = Field(default_factory=list, max_length=20)
    warnings: list[str] = Field(default_factory=list)
