import asyncio
import ipaddress
import json
import socket
import time
import zipfile
from pathlib import Path
from urllib.parse import urlsplit

import httpx
import tiktoken
from langchain_community.document_loaders import (
    PyPDFLoader,
    UnstructuredMarkdownLoader,
    UnstructuredPowerPointLoader,
    UnstructuredWordDocumentLoader,
)
from langchain_core.document_loaders import BaseLoader
from langchain_core.documents import Document

from .db import dump, uid
from .retrieval import normalize
from .tasks import blocking

SUPPORTED = {".pdf", ".docx", ".pptx", ".md"}
TOKENS = None


def tokenizer():
    global TOKENS
    if TOKENS is None:
        TOKENS = tiktoken.get_encoding("cl100k_base")
    return TOKENS


def validate_archive(path):
    if path.suffix not in {".docx", ".pptx"}:
        return
    with zipfile.ZipFile(path) as archive:
        members = archive.infolist()
        if len(members) > 10000 or sum(m.file_size for m in members) > 100 * 1024 * 1024:
            raise ValueError("Office archive exceeds decompression limits")
        for member in members:
            if member.file_size > 25 * 1024 * 1024 or member.flag_bits & 1:
                raise ValueError("Office archive contains oversized/encrypted entry")


class LocalLoader(BaseLoader):
    """LangChain extraction, supplemented by exact structural locations from local parsers."""

    def __init__(self, path):
        self.path = Path(path)
        self.warnings = []

    def lazy_load(self):
        path = self.path
        validate_archive(path)
        if path.suffix == ".pdf":
            from pypdf import PdfReader

            reader = PdfReader(path)
            if reader.is_encrypted:
                raise ValueError("password-protected PDF is unsupported")
            if len(reader.pages) > 200:
                raise ValueError("PDF page limit (200) exceeded")
            docs = PyPDFLoader(str(path), mode="page").load()
            for doc in docs:
                page = doc.metadata["page"] + 1
                if doc.page_content.strip():
                    yield Document(page_content=doc.page_content, metadata={"page": page})
                else:
                    self.warnings.append(
                        {"page": page, "code": "no_extractable_text", "message": "Page not indexed"}
                    )
        elif path.suffix == ".docx":
            extracted = UnstructuredWordDocumentLoader(str(path), mode="elements").load()
            if not extracted:
                raise ValueError("no extractable Office text")
            from docx import Document as Docx
            from docx.table import Table
            from docx.text.paragraph import Paragraph

            document = Docx(path)
            heading, paragraph, table = "", 0, 0
            for element in document.element.body:
                if element.tag.endswith("}p"):
                    p = Paragraph(element, document)
                    paragraph += 1
                    if p.style and p.style.name.startswith("Heading"):
                        heading = p.text
                    if p.text.strip():
                        yield Document(
                            page_content=p.text, metadata={"heading": heading, "paragraph": paragraph}
                        )
                elif element.tag.endswith("}tbl"):
                    table += 1
                    rows = Table(element, document).rows
                    header = " | ".join(c.text for c in rows[0].cells) if rows else ""
                    for number, row in enumerate(rows, 1):
                        text = " | ".join(c.text for c in row.cells)
                        yield Document(
                            page_content=text if number == 1 else header + "\n" + text,
                            metadata={"heading": heading, "table": table, "row": number},
                        )
            self.warnings.append(
                {
                    "code": "office_extraction_scope",
                    "message": "Body text/tables indexed; images, headers and embedded objects not interpreted",
                }
            )
        elif path.suffix == ".pptx":
            from pptx import Presentation

            presentation = Presentation(path)
            if len(presentation.slides) > 200:
                raise ValueError("slide limit (200) exceeded")
            UnstructuredPowerPointLoader(str(path), mode="elements").load()
            for number, slide in enumerate(presentation.slides, 1):
                readable = False
                for element, shape in enumerate(slide.shapes, 1):
                    if shape.has_text_frame and shape.text.strip():
                        readable = True
                        yield Document(
                            page_content=shape.text, metadata={"slide": number, "element": element}
                        )
                    if shape.has_table:
                        header = " | ".join(c.text for c in shape.table.rows[0].cells)
                        for row_no, row in enumerate(shape.table.rows, 1):
                            readable = True
                            text = " | ".join(c.text for c in row.cells)
                            yield Document(
                                page_content=text if row_no == 1 else header + "\n" + text,
                                metadata={"slide": number, "element": element, "row": row_no},
                            )
                if not readable:
                    self.warnings.append({"slide": number, "code": "no_extractable_text"})
            self.warnings.append(
                {
                    "code": "office_extraction_scope",
                    "message": "Text/tables indexed; images, charts, notes and grouped objects not interpreted",
                }
            )
        elif path.suffix == ".md":
            from markdown_it import MarkdownIt

            text = path.read_text(encoding="utf-8")
            UnstructuredMarkdownLoader(str(path), mode="elements").load()
            lines = text.splitlines(keepends=True)
            heading = ""
            for token in MarkdownIt().parse(text):
                if token.map and token.type in {
                    "heading_open",
                    "paragraph_open",
                    "fence",
                    "code_block",
                    "html_block",
                }:
                    start, end = token.map
                    content = "".join(lines[start:end])
                    if token.type == "heading_open":
                        heading = content.lstrip("# ").strip()
                    yield Document(
                        page_content=content,
                        metadata={"heading": heading, "line_start": start + 1, "line_end": end},
                    )
        else:
            raise ValueError("unsupported type")


def chunk_documents(documents):
    chunks = []
    for doc in documents:
        text = doc.page_content.strip()
        if not text:
            continue
        # Split on Unicode characters using exact token counts; never decode a partial UTF-8 token.
        start = 0
        while start < len(text):
            low, high = start + 1, len(text)
            end = low
            while low <= high:
                mid = (low + high) // 2
                if len(tokenizer().encode(text[start:mid])) <= 600:
                    end, low = mid, mid + 1
                else:
                    high = mid - 1
            if end < len(text):
                boundary = max(
                    text.rfind("\n", start + (end - start) // 2, end),
                    text.rfind(" ", start + (end - start) // 2, end),
                )
                if boundary > start:
                    end = boundary
            chunks.append({"id": uid("c"), "text": text[start:end], "locator": doc.metadata})
            if end == len(text):
                break
            overlap_start = end
            while overlap_start > start and len(tokenizer().encode(text[overlap_start - 1 : end])) <= 80:
                overlap_start -= 1
            start = max(start + 1, overlap_start)
    if not chunks:
        raise ValueError("no extractable text; source not indexed")
    return chunks


async def public_url(url):
    parsed = urlsplit(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError("only public HTTP(S) URLs without credentials are accepted")
    if parsed.port not in {None, 80, 443}:
        raise ValueError("only standard web ports supported")
    addresses = await asyncio.to_thread(socket.getaddrinfo, parsed.hostname, None)
    if not addresses or any(not ipaddress.ip_address(item[4][0]).is_global for item in addresses):
        raise ValueError("private/local URL blocked")
    return parsed


class FirecrawlLoader(BaseLoader):
    """Thin LangChain loader around Firecrawl v2; the only website fetch service."""

    def __init__(self, settings, url, include_paths):
        self.settings, self.url, self.include_paths = settings, url, include_paths
        self.warnings = []

    def lazy_load(self):
        raise RuntimeError("use alazy_load for Firecrawl")

    async def alazy_load(self):
        settings = self.settings
        if not settings.firecrawl_api_key or not settings.firecrawl_public_fetch_enforced:
            raise RuntimeError("Firecrawl key and public-fetch boundary enforcement are required")
        requested = await public_url(self.url)
        base = settings.firecrawl_base_url.rstrip("/")
        headers = {"Authorization": "Bearer " + settings.firecrawl_api_key}
        async with httpx.AsyncClient(headers=headers, timeout=30, follow_redirects=False) as client:
            response = await client.post(
                base + "/v2/crawl",
                json={
                    "url": self.url,
                    "limit": 25,
                    "maxDiscoveryDepth": 2,
                    "sitemap": "skip",
                    "allowExternalLinks": False,
                    "allowSubdomains": False,
                    "includePaths": self.include_paths,
                    "scrapeOptions": {"formats": ["markdown"], "parsers": [], "onlyMainContent": True},
                    "excludePaths": [r".*\.(pdf|docx?|pptx?|xlsx?|zip)(\?.*)?$"],
                },
            )
            response.raise_for_status()
            job_id = response.json().get("id")
            if not job_id or not str(job_id).replace("-", "").isalnum():
                raise ValueError("invalid Firecrawl job ID")
            status_url = base + "/v2/crawl/" + job_id
            started, seen = time.monotonic(), set()
            while True:
                if time.monotonic() - started > 180:
                    raise TimeoutError("Firecrawl crawl timed out")
                response = await client.get(status_url)
                response.raise_for_status()
                data = response.json()
                if data.get("status") in {"failed", "cancelled"} or data.get("success") is False:
                    raise RuntimeError("Firecrawl crawl failed")
                if data.get("status") != "completed":
                    await asyncio.sleep(2)
                    continue
                page = data
                pagination_seen = set()
                while True:
                    for item in page.get("data", []):
                        meta = item.get("metadata", {})
                        url = meta.get("sourceURL") or meta.get("url")
                        if not url or url in seen:
                            continue
                        parsed = await public_url(url)
                        if int(meta.get("statusCode", 200)) >= 400:
                            self.warnings.append({"code": "http_error", "url": url})
                            continue
                        if parsed.hostname != requested.hostname or parsed.path.lower().endswith(
                            (".pdf", ".doc", ".docx", ".ppt", ".pptx")
                        ):
                            self.warnings.append({"code": "skipped_url", "url": url})
                            continue
                        if len(seen) >= 25:
                            self.warnings.append({"code": "page_limit"})
                            break
                        seen.add(url)
                        content = item.get("markdown", "")
                        if content.strip():
                            yield Document(
                                page_content=content,
                                metadata={
                                    "url": url,
                                    "title": meta.get("title", ""),
                                    "fetched_at": time.time(),
                                },
                            )
                        else:
                            self.warnings.append({"code": "no_extractable_text", "url": url})
                    next_url = page.get("next")
                    if not next_url or len(seen) >= 25 or not page.get("data"):
                        break
                    # Pagination URLs are API URLs, never arbitrary web fetch targets.
                    if (
                        next_url in pagination_seen
                        or len(pagination_seen) >= 25
                        or time.monotonic() - started > 180
                    ):
                        raise ValueError("Firecrawl pagination limit or timeout")
                    pagination_seen.add(next_url)
                    if not next_url.startswith(status_url + "?"):
                        raise ValueError("unsafe Firecrawl pagination URL")
                    response = await client.get(next_url)
                    response.raise_for_status()
                    page = response.json()
                errors_response = await client.get(status_url + "/errors")
                if errors_response.is_success:
                    errors = errors_response.json()
                    for item in errors.get("errors", [])[:25]:
                        self.warnings.append(
                            {
                                "code": "crawl_page_failed",
                                "url": item.get("url"),
                                "message": str(item.get("error", ""))[:300],
                            }
                        )
                    for url in errors.get("robotsBlocked", [])[:25]:
                        self.warnings.append({"code": "robots_blocked", "url": url})
                else:
                    self.warnings.append({"code": "crawl_errors_unavailable"})
                self.warnings.append(
                    {
                        "code": "crawl_scope",
                        "message": "Bounded crawl: at most 25 pages, depth 2; linked files excluded",
                    }
                )
                return


class Ingestion:
    def __init__(self, db, settings, providers, retrieval):
        self.db, self.settings, self.providers, self.retrieval = db, settings, providers, retrieval
        self.slots = asyncio.Semaphore(settings.max_ingestions)

    async def run(self, source_id):
        source = self.db.one("SELECT * FROM sources WHERE id=? AND deleted=0", (source_id,))
        if not source:
            return
        try:
            async with self.slots:
                if source["kind"] == "website":
                    options = json.loads(source["options"])
                    loader = FirecrawlLoader(self.settings, source["path"], options.get("include_paths", []))
                    documents = [doc async for doc in loader.alazy_load()]
                    directory = self.retrieval.root(source["session_id"]) / "originals"
                    directory.mkdir(parents=True, exist_ok=True)
                    await blocking(
                        (directory / (source_id + ".json")).write_text,
                        dump([{"text": d.page_content, "locator": d.metadata} for d in documents]),
                    )
                else:
                    loader = LocalLoader(source["path"])
                    documents = await blocking(loader.load)
                chunks = await blocking(chunk_documents, documents)
                vectors = normalize(
                    await self.providers.embed_documents([c["text"] for c in chunks]),
                    self.settings.embedding_dimension,
                )
                for chunk, vector in zip(chunks, vectors, strict=True):
                    chunk["vector"] = vector.tobytes()
                self.db.execute(
                    "UPDATE sources SET warnings=? WHERE id=?", (dump(loader.warnings), source_id)
                )
                await self.retrieval.publish(source["session_id"], source_id, chunks)
        except asyncio.CancelledError:
            self.db.execute("UPDATE sources SET status='failed',error='interrupted' WHERE id=?", (source_id,))
            raise
        except Exception as exc:
            self.db.execute(
                "UPDATE sources SET status='failed',error=? WHERE id=?",
                (type(exc).__name__ + ": " + str(exc)[:300], source_id),
            )
