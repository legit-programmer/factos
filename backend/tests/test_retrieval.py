import asyncio

import numpy as np
import pytest
from conftest import login

from factos.db import uid
from factos.retrieval import normalize


def seed(db, sid, title):
    source = uid("source")
    db.execute(
        "INSERT INTO sources(id,session_id,title,kind,path,input_hash,status) VALUES(?,?,?,?,?,?,?)",
        (source, sid, title, "file", "unused", uid("hash"), "processing"),
    )
    return source, [
        {
            "id": uid("c"),
            "text": title + " warranty 2 years",
            "locator": {"page": 1},
            "vector": np.array([1, 1, 0.5, 0.25], dtype=np.float32).tobytes(),
        }
    ]


@pytest.mark.parametrize("vectors", [[[0, 0]], [[float("nan"), 1]], [[1, 2, 3]], [[float("inf"), 1]]])
def test_invalid_vectors(vectors):
    with pytest.raises(ValueError):
        normalize(vectors, 2)


def test_concurrent_publish_pinning_and_deletion(client, app):
    sid = login(client)
    db, retrieval = app.state.db, app.state.retrieval
    first, first_chunks = seed(db, sid, "First")
    second, second_chunks = seed(db, sid, "Second")

    async def publications():
        return await asyncio.gather(
            retrieval.publish(sid, first, first_chunks), retrieval.publish(sid, second, second_chunks)
        )

    versions = client.portal.call(publications)
    active = db.one("SELECT active_index FROM sessions WHERE id=?", (sid,))["active_index"]
    assert retrieval.load(sid, active).ntotal == 2
    assert retrieval.load(sid, versions[0]).ntotal == 1
    assert client.delete(f"/sessions/{sid}/sources/{first}").status_code == 200
    new = db.one("SELECT active_index FROM sessions WHERE id=?", (sid,))["active_index"]
    assert retrieval.load(sid, new).ntotal == 1
    assert retrieval.chunks(sid, active, [first_chunks[0]["id"]])  # historical evidence retained
    assert not retrieval.chunks(sid, new, [first_chunks[0]["id"]])
    other = client.post("/sessions", json={}).json()["id"]
    assert not retrieval.chunks(other, active, [first_chunks[0]["id"]])
    with pytest.raises(ValueError):
        retrieval.load(other, active)


def test_corruption_and_config_mismatch(client, app):
    sid = login(client)
    source, chunks = seed(app.state.db, sid, "Policy")
    version = client.portal.call(app.state.retrieval.publish, sid, source, chunks)
    app.state.retrieval.settings.embedding_model = "another-model"
    with pytest.raises(ValueError, match="configuration changed"):
        app.state.retrieval.load(sid, version)
    app.state.retrieval.settings.embedding_model = "test-embedding"
    path = app.state.retrieval.root(sid) / "indexes" / version / "index.faiss"
    path.write_bytes(b"corrupt")
    with pytest.raises(ValueError, match="checksum mismatch"):
        app.state.retrieval.load(sid, version)


def test_verification_uses_evidence_and_original_snapshot(client, app, provider):
    from conftest import settle

    provider.mode = "contradiction"
    sid = login(client)
    source, chunks = seed(app.state.db, sid, "Policy")
    pinned = client.portal.call(app.state.retrieval.publish, sid, source, chunks)
    created = client.post(f"/sessions/{sid}/turns", json={"request_id": "one", "text": "Warranty?"}).json()
    result = settle(client, sid, created["turn_id"])
    analysis = result["analysis"]
    assert analysis["index_version_id"] == pinned
    assert analysis["findings"][0]["quote"] == "5 years"
    assert analysis["findings"][0]["highlight"] == "red"
    assert analysis["findings"][0]["evidence"][0]["excerpt"] == "2 years"
    assert sum("BEGIN UNTRUSTED CORPUS" in instruction for instruction, _ in provider.stream_calls) == 1
    assert client.delete(f"/sessions/{sid}/sources/{source}").status_code == 200
    assert client.post(f"/sessions/{sid}/turns/{created['turn_id']}/analysis/retry").status_code == 202
    result = settle(client, sid, created["turn_id"])
    assert result["analysis"]["index_version_id"] == pinned
    assert result["analysis"]["findings"]
