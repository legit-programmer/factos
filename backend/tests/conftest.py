import asyncio
import json
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from google.genai import types

from factos.api import create_app
from factos.config import Settings
from factos.providers import Providers


class FakeProviders:
    def __init__(self):
        self.stream_calls = []
        self.verify_calls = []
        self.mode = "normal"
        self.delay = 0
        self.started = asyncio.Event()
        self.embed_failure = False
        self.last_query = None

    def ready(self, embeddings=False):
        pass

    def contents(self, exchanges):
        return Providers.contents(self, exchanges)

    async def embed_documents(self, texts):
        if self.embed_failure:
            raise RuntimeError("embedding unavailable")
        return [[1.0, float("year" in text), 0.5, 0.25] for text in texts]

    async def embed_query(self, text):
        self.last_query = text
        return [1, 1, 0.5, 0.25]

    async def stream(self, instruction, exchanges):
        self.stream_calls.append((instruction, exchanges))
        self.started.set()
        if self.delay:
            await asyncio.sleep(self.delay)
        if self.mode == "baseline_fail" and "no retrieval" in instruction:
            yield {"text": "Partial"}
            raise RuntimeError("provider interrupted")
        for text in ["The warranty lasts ", "5 years. 😀"]:
            yield {"text": text}
            await asyncio.sleep(0)

    async def verify(self, contents, tools_enabled):
        self.verify_calls.append((contents[:], tools_enabled))
        if self.mode in {"tools_forever", "invalid_tools"} and tools_enabled:
            calls = [
                types.Part(
                    function_call=types.FunctionCall(
                        id=f"call{i}",
                        name="search_sources",
                        args={"query": "warranty"}
                        if self.mode == "tools_forever"
                        else {"query": "x", "top_k": 100},
                    )
                )
                for i in range(7)
            ]
            return SimpleNamespace(
                candidates=[SimpleNamespace(content=types.Content(role="model", parts=calls))],
                function_calls=[p.function_call for p in calls],
                text=None,
            )
        if self.mode == "bad_json":
            output = "not json"
        elif (
            self.mode == "contradiction"
            and tools_enabled
            and not any(any(p.function_response for p in c.parts) for c in contents)
        ):
            call = types.FunctionCall(name="search_sources", id="search1", args={"query": "warranty"})
            return SimpleNamespace(
                candidates=[
                    SimpleNamespace(
                        content=types.Content(role="model", parts=[types.Part(function_call=call)])
                    )
                ],
                function_calls=[call],
                text=None,
            )
        else:
            output = {
                "coverage": {
                    "claims_extracted": 1,
                    "claims_checked": 1,
                    "extraction_truncated": False,
                    "unchecked_block_ids": [],
                },
                "findings": [],
                "warnings": [],
            }
            if self.mode == "contradiction":
                refs = [
                    p.function_response.response for c in contents for p in c.parts if p.function_response
                ]
                chunk = refs[-1]["chunks"][0]
                output["findings"] = [
                    {
                        "block_id": "b_0",
                        "quote": "5 years",
                        "occurrence": 0,
                        "verdict": "contradicted",
                        "reason_code": "direct_contradiction",
                        "reason": "Policy says two years",
                        "correction": "2 years",
                        "evidence": [{"chunk_id": chunk["chunk_id"], "excerpt": "2 years"}],
                    }
                ]
            output = json.dumps(output)
        return SimpleNamespace(
            candidates=[
                SimpleNamespace(
                    content=types.Content(role="model", parts=[types.Part.from_text(text=output)])
                )
            ],
            function_calls=[],
            text=output,
        )

    async def close(self):
        pass


@pytest.fixture
def provider():
    return FakeProviders()


@pytest.fixture
def settings(tmp_path):
    return Settings(data_dir=tmp_path, embedding_model="test-embedding", embedding_dimension=4)


@pytest.fixture
def app(settings, provider):
    return create_app(settings, provider)


@pytest.fixture
def client(app):
    with TestClient(app) as client:
        client.headers["origin"] = "http://localhost:5173"
        yield client


def login(client, email="one@example.com"):
    password = "a sufficiently long passphrase"
    assert client.post("/auth/register", json={"email": email, "password": password}).status_code == 201
    assert client.post("/auth/login", json={"email": email, "password": password}).status_code == 200
    return client.post("/sessions", json={"title": "Test"}).json()["id"]


def settle(client, session_id, turn_id):
    import time

    for _ in range(100):
        result = client.get(f"/sessions/{session_id}/turns/{turn_id}").json()
        if result["analysis_state"] in {"completed", "partial", "failed", "skipped"}:
            return result
        time.sleep(0.03)
    raise AssertionError("turn did not settle")
