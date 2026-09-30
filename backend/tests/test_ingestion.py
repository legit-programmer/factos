import json

import httpx
import pytest
from conftest import login
from langchain_core.documents import Document
from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject

from factos.ingestion import FirecrawlLoader, LocalLoader, chunk_documents, public_url, tokenizer


def pdf_fixture(path, readable=True):
    writer = PdfWriter()
    page = writer.add_blank_page(400, 400)
    if readable:
        stream = DecodedStreamObject()
        stream.set_data(b"BT /F1 12 Tf 20 200 Td (Warranty lasts 2 years.) Tj ET")
        page[NameObject("/Contents")] = writer._add_object(stream)
        font = DictionaryObject(
            {
                NameObject("/Type"): NameObject("/Font"),
                NameObject("/Subtype"): NameObject("/Type1"),
                NameObject("/BaseFont"): NameObject("/Helvetica"),
            }
        )
        page[NameObject("/Resources")] = DictionaryObject(
            {NameObject("/Font"): DictionaryObject({NameObject("/F1"): writer._add_object(font)})}
        )
    writer.add_blank_page(400, 400)
    writer.write(path)


def test_pdf_readable_and_unreadable_pages(tmp_path):
    path = tmp_path / "mixed.pdf"
    pdf_fixture(path)
    loader = LocalLoader(path)
    docs = loader.load()
    assert len(docs) == 1 and docs[0].metadata["page"] == 1
    assert "2 years" in docs[0].page_content
    assert loader.warnings[0]["page"] == 2
    blank = tmp_path / "blank.pdf"
    pdf_fixture(blank, readable=False)
    with pytest.raises(ValueError, match="no extractable text"):
        chunk_documents(LocalLoader(blank).load())


def test_markdown_locations(tmp_path):
    path = tmp_path / "policy.md"
    path.write_text("# Policy\n\nWarranty lasts 2 years.\n\n## Details\n\nNo accidents.\n")
    docs = LocalLoader(path).load()
    assert docs[1].metadata == {"heading": "Policy", "line_start": 3, "line_end": 3}
    assert any("No accidents" in d.page_content for d in docs)


def test_docx_and_pptx_structural_locations(tmp_path):
    from docx import Document as Docx
    from pptx import Presentation
    from pptx.util import Inches

    doc = Docx()
    doc.add_heading("Policy", 1)
    doc.add_paragraph("Warranty lasts 2 years.")
    table = doc.add_table(rows=2, cols=2)
    table.cell(0, 0).text, table.cell(0, 1).text = "Item", "Term"
    table.cell(1, 0).text, table.cell(1, 1).text = "Warranty", "2 years"
    path = tmp_path / "policy.docx"
    doc.save(path)
    docs = LocalLoader(path).load()
    assert docs[1].metadata["paragraph"] == 2
    assert docs[-1].metadata["row"] == 2
    assert "Item | Term\nWarranty | 2 years" in docs[-1].page_content
    presentation = Presentation()
    slide = presentation.slides.add_slide(presentation.slide_layouts[6])
    textbox = slide.shapes.add_textbox(Inches(1), Inches(1), Inches(4), Inches(1))
    textbox.text = "Warranty lasts 2 years."
    path = tmp_path / "policy.pptx"
    presentation.save(path)
    docs = LocalLoader(path).load()
    assert docs[0].metadata == {"slide": 1, "element": 1}


def test_unicode_chunking_limits():
    source = "😀 warranty term 漢字 " * 1200
    chunks = chunk_documents([Document(page_content=source, metadata={"page": 2})])
    assert len(chunks) > 1
    assert all(len(tokenizer().encode(c["text"])) <= 600 for c in chunks)
    assert all("�" not in c["text"] for c in chunks)
    assert all(c["locator"]["page"] == 2 for c in chunks)


async def test_private_url_rejected():
    for url in ["http://127.0.0.1", "http://[::1]", "file:///etc/passwd", "http://name:pass@example.com"]:
        with pytest.raises(ValueError):
            await public_url(url)


async def test_firecrawl_only_bounded_pagination(settings, monkeypatch):
    settings.firecrawl_api_key = "test"
    settings.firecrawl_public_fetch_enforced = True
    requests = []
    from urllib.parse import urlsplit

    async def public(url):
        return urlsplit(url)

    monkeypatch.setattr("factos.ingestion.public_url", public)

    def respond(request):
        requests.append(request)
        if request.method == "POST":
            body = json.loads(request.content)
            assert body["limit"] == 25 and body["maxDiscoveryDepth"] == 2
            assert body["allowExternalLinks"] is False
            assert body["scrapeOptions"]["parsers"] == []
            return httpx.Response(200, json={"id": "crawl-123"})
        if request.url.query:
            return httpx.Response(
                200,
                json={
                    "data": [
                        {"markdown": "Other page", "metadata": {"sourceURL": "https://example.com/two"}},
                        {"markdown": "Outside", "metadata": {"sourceURL": "https://other.com"}},
                    ]
                },
            )
        return httpx.Response(
            200,
            json={
                "status": "completed",
                "next": "https://api.firecrawl.dev/v2/crawl/crawl-123?skip=1",
                "data": [
                    {"markdown": "Policy", "metadata": {"sourceURL": "https://example.com/one"}},
                    {"markdown": "PDF", "metadata": {"sourceURL": "https://example.com/policy.pdf"}},
                ],
            },
        )

    real_client = httpx.AsyncClient
    monkeypatch.setattr(
        "factos.ingestion.httpx.AsyncClient",
        lambda **kwargs: real_client(transport=httpx.MockTransport(respond), **kwargs),
    )
    loader = FirecrawlLoader(settings, "https://example.com", [])
    docs = [doc async for doc in loader.alazy_load()]
    assert len(docs) == 2
    assert all(request.url.host == "api.firecrawl.dev" for request in requests)
    assert sum(w["code"] == "skipped_url" for w in loader.warnings) == 2


def test_ingestion_failure_visible_and_retry(client, app, provider):
    sid = login(client)
    provider.embed_failure = True
    uploaded = client.post(
        f"/sessions/{sid}/sources/files", files={"file": ("policy.md", b"# Policy\n\n2 years.")}
    )
    assert uploaded.status_code == 202
    source_id = uploaded.json()["source_id"]
    import time

    for _ in range(100):
        source = client.get(f"/sessions/{sid}/sources").json()["sources"][0]
        if source["status"] != "processing":
            break
        time.sleep(0.03)
    assert source["status"] == "failed"
    assert client.get(f"/sessions/{sid}").json()["active_index_version"] is None
    provider.embed_failure = False
    assert client.post(f"/sessions/{sid}/sources/{source_id}/retry").status_code == 202
    for _ in range(100):
        source = client.get(f"/sessions/{sid}/sources").json()["sources"][0]
        if source["status"] != "processing":
            break
        time.sleep(0.03)
    assert source["status"] == "ready", source
    again = client.post(
        f"/sessions/{sid}/sources/files", files={"file": ("policy.md", b"# Policy\n\n2 years.")}
    )
    assert again.json()["source_id"] == source_id
    assert again.json()["deduplicated"] is True
