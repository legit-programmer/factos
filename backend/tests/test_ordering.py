import asyncio
import json
import time

from conftest import login, settle

from factos.db import uid


def test_verifier_order_and_histories(client, app, provider):
    sid = login(client)
    original = provider.verify
    observed = []

    async def delayed(contents, enabled):
        current = json.loads([c.parts[0].text for c in contents if c.role == "user"][-1])
        observed.append((current["question"], len(contents)))
        await asyncio.sleep(0.3)
        return await original(contents, enabled)

    provider.verify = delayed
    first = client.post(f"/sessions/{sid}/turns", json={"request_id": "one", "text": "first"}).json()[
        "turn_id"
    ]
    for _ in range(100):
        state = client.get(f"/sessions/{sid}/turns/{first}").json()
        if state["baseline_state"] == "completed" and state["analysis_state"] == "running":
            break
        time.sleep(0.01)
    assert state["analysis_state"] == "running"
    second = client.post(f"/sessions/{sid}/turns", json={"request_id": "two", "text": "second"})
    assert second.status_code == 202
    second_id = second.json()["turn_id"]
    assert client.get(f"/sessions/{sid}/turns/{second_id}").json()["analysis_state"] == "pending"
    settle(client, sid, second_id)
    assert observed == [("first", 1), ("second", 3)]


def test_source_addition_during_answer_uses_pinned_index(client, app, provider):
    from test_retrieval import seed

    sid = login(client)
    first, chunks = seed(app.state.db, sid, "Original")
    pinned = client.portal.call(app.state.retrieval.publish, sid, first, chunks)
    provider.delay = 0.2
    created = client.post(f"/sessions/{sid}/turns", json={"request_id": "one", "text": "warranty"}).json()
    second, newer = seed(app.state.db, sid, "Addition")
    active = client.portal.call(app.state.retrieval.publish, sid, second, newer)
    assert active != pinned
    result = settle(client, sid, created["turn_id"])
    assert result["index_version"] == pinned
    assert result["analysis"]["index_version_id"] == pinned
    assert len(app.state.db.all("SELECT * FROM verifier_exchanges WHERE session_id=?", (sid,))) == 1
    next_turn = client.post(f"/sessions/{sid}/turns", json={"request_id": "two", "text": "follow-up"}).json()
    assert next_turn["index_version_id"] == active
    settle(client, sid, next_turn["turn_id"])


def test_restart_marks_interrupted_and_removes_staging(client, app):
    sid = login(client)
    source = uid("source")
    app.state.db.execute(
        "INSERT INTO sources(id,session_id,title,kind,path,input_hash,status) VALUES(?,?,?,?,?,?,?)",
        (source, sid, "Interrupted", "file", "unused", uid("hash"), "processing"),
    )
    staging = app.state.retrieval.root(sid) / "indexes" / ".staging-orphan"
    staging.mkdir(parents=True)
    (staging / "partial.faiss").write_bytes(b"incomplete")
    app.state.db.recover()
    app.state.retrieval.recover()
    assert app.state.db.one("SELECT status,error FROM sources WHERE id=?", (source,)) == {
        "status": "failed",
        "error": "interrupted",
    }
    assert not staging.exists()


def test_wall_timeout_forces_tools_disabled_finalize(client, app, provider):
    sid = login(client)
    app.state.runtime.settings.analysis_timeout = 0.03
    original = provider.verify
    enabled_flags = []

    async def delayed(contents, enabled):
        enabled_flags.append(enabled)
        if enabled:
            await asyncio.sleep(0.1)
        return await original(contents, enabled)

    provider.verify = delayed
    tid = client.post(f"/sessions/{sid}/turns", json={"request_id": "one", "text": "test"}).json()["turn_id"]
    result = settle(client, sid, tid)
    assert result["analysis"]["termination_reason"] == "timeout"
    assert result["analysis"]["status"] == "partial"
    assert enabled_flags == [True, False]
