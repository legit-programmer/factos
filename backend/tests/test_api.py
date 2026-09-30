import json

import pytest
from conftest import login, settle


def test_auth_ownership_and_logout(client, app):
    assert client.get("/sessions").status_code == 401
    session = login(client)
    user = app.state.db.one("SELECT * FROM users")
    assert user["password"].startswith("$argon2id$")
    token = client.cookies.get("factos_login")
    assert token != app.state.db.one("SELECT token_hash FROM auth_sessions")["token_hash"]
    assert client.get("/auth/me").json()["email"] == "one@example.com"
    assert client.post("/auth/logout").status_code == 200
    assert client.get("/sessions").status_code == 401
    login(client, "two@example.com")
    assert client.get(f"/sessions/{session}").status_code == 404
    assert client.delete(f"/sessions/{session}").status_code == 404


def test_origin_and_expiry(client, app):
    assert client.post("/auth/register", headers={"origin": "https://evil.test"}, json={}).status_code == 403
    session = login(client)
    app.state.db.execute("UPDATE auth_sessions SET expires=0")
    assert client.get(f"/sessions/{session}").status_code == 401


def test_cookie_and_normalization(client, app):
    login(client, "Alice@EXAMPLE.com")
    assert app.state.db.one("SELECT email FROM users")["email"] == "alice@example.com"
    response = client.post(
        "/auth/login", json={"email": "ALICE@example.com", "password": "a sufficiently long passphrase"}
    )
    assert "HttpOnly" in response.headers["set-cookie"]
    assert "SameSite=lax" in response.headers["set-cookie"]
    assert (
        client.post(
            "/auth/login", json={"email": "unknown@example.com", "password": "a sufficiently long passphrase"}
        ).status_code
        == 401
    )


def test_three_histories_and_empty_corpus(client, app, provider):
    sid = login(client)
    details = client.get(f"/sessions/{sid}").json()
    assert {c["role"] for c in details["children"]} == {"rag", "baseline", "verifier"}
    assert len({c["id"] for c in details["children"]}) == 3
    response = client.post(f"/sessions/{sid}/turns", json={"request_id": "first", "text": "warranty?"})
    assert response.status_code == 202, response.text
    tid = response.json()["turn_id"]
    saved = settle(client, sid, tid)
    assert saved["rag_state"] == "completed"
    rag = next(a for a in saved["answers"] if a["lane"] == "rag")
    assert "sufficient indexed evidence" in rag["text"]
    assert len(provider.stream_calls) == 1
    assert "CORPUS" not in provider.stream_calls[0][0]
    assert saved["analysis"]["status"] == "completed"
    assert len(app.state.db.all("SELECT * FROM verifier_exchanges")) == 1


def test_idempotency_sse_and_followup(client, app, provider):
    sid = login(client)
    payload = {"request_id": "same", "text": "warranty?"}
    first = client.post(f"/sessions/{sid}/turns", json=payload).json()
    second = client.post(f"/sessions/{sid}/turns", json=payload).json()
    assert first["turn_id"] == second["turn_id"]
    assert client.post(f"/sessions/{sid}/turns", json={**payload, "text": "changed"}).status_code == 409
    settle(client, sid, first["turn_id"])
    streamed = client.get(first["events_url"])
    data = [json.loads(line[6:]) for line in streamed.text.splitlines() if line.startswith("data: ")]
    assert {e["channel"] for e in data} == {"rag", "baseline", "analysis", "system"}
    assert [e["event_id"] for e in data] == list(range(1, len(data) + 1))
    after = client.get(first["events_url"], headers={"Last-Event-ID": "3"})
    assert all(
        json.loads(line[6:])["event_id"] > 3 for line in after.text.splitlines() if line.startswith("data: ")
    )
    assert len(provider.stream_calls) == 1
    third = client.post(f"/sessions/{sid}/turns", json={"request_id": "next", "text": "And damage?"}).json()
    settle(client, sid, third["turn_id"])
    baseline_history = provider.stream_calls[-1][1]
    assert [m["role"] for m in baseline_history] == ["user", "assistant", "user"]
    assert "sufficient indexed evidence" not in json.dumps(baseline_history)
    assert len(provider.verify_calls[-1][0]) >= 3
    other = client.post("/sessions", json={"title": "Empty"}).json()["id"]
    assert client.get(f"/sessions/{other}").json()["verifier_history"] == []


@pytest.mark.parametrize("mode", ["tools_forever", "invalid_tools"])
def test_tool_limit_and_forced_history(client, app, provider, mode):
    provider.mode = mode
    sid = login(client)
    tid = client.post(f"/sessions/{sid}/turns", json={"request_id": "one", "text": "test"}).json()["turn_id"]
    saved = settle(client, sid, tid)
    assert saved["analysis"]["tool_calls_used"] == 10
    assert saved["analysis"]["termination_reason"] == "tool_limit"
    assert [call[1] for call in provider.verify_calls] == [True, True, False]
    final_context = provider.verify_calls[-1][0]
    results = [p.function_response.response for c in final_context for p in c.parts if p.function_response]
    assert len(results) == 14
    assert sum(r.get("error") == "tool_budget_exhausted" for r in results) == 4
    exchange = app.state.db.one("SELECT * FROM verifier_exchanges WHERE turn_id=?", (tid,))
    assert exchange["output"]
    if mode == "invalid_tools":
        assert saved["analysis"]["status"] == "partial"


def test_invalid_analysis_and_retry(client, app, provider):
    provider.mode = "bad_json"
    sid = login(client)
    tid = client.post(f"/sessions/{sid}/turns", json={"request_id": "one", "text": "test"}).json()["turn_id"]
    saved = settle(client, sid, tid)
    assert saved["analysis_state"] == "failed"
    assert [c[1] for c in provider.verify_calls] == [True, False]
    assert app.state.db.one("SELECT valid,output FROM verifier_exchanges WHERE turn_id=?", (tid,)) == {
        "valid": 0,
        "output": "not json",
    }
    provider.mode = "normal"
    assert client.post(f"/sessions/{sid}/turns/{tid}/analysis/retry").status_code == 202
    result = settle(client, sid, tid)
    assert result["analysis_state"] == "completed"
    assert len(provider.stream_calls) == 1
    assert len(app.state.db.all("SELECT * FROM verifier_exchanges WHERE turn_id=?", (tid,))) == 1
    assert len(provider.verify_calls[-1][0]) == 1  # target's prior failed attempt excluded


def test_failed_baseline_and_cancel(client, app, provider):
    provider.mode = "baseline_fail"
    sid = login(client)
    tid = client.post(f"/sessions/{sid}/turns", json={"request_id": "one", "text": "test"}).json()["turn_id"]
    result = settle(client, sid, tid)
    assert result["baseline_state"] == "failed"
    assert result["analysis_state"] == "skipped"
    assert not provider.verify_calls
    provider.mode, provider.delay = "normal", 5
    tid = client.post(f"/sessions/{sid}/turns", json={"request_id": "two", "text": "test"}).json()["turn_id"]
    assert (
        client.post(f"/sessions/{sid}/turns", json={"request_id": "three", "text": "test"}).status_code == 409
    )
    assert client.post(f"/sessions/{sid}/turns/{tid}/cancel").status_code == 200
    result = settle(client, sid, tid)
    assert result["baseline_state"] == "cancelled"


def test_cross_session_attachments_and_unsupported_sources(client):
    sid = login(client)
    other = client.post("/sessions", json={}).json()["id"]
    import io

    from PIL import Image

    data = io.BytesIO()
    Image.new("RGB", (8, 8)).save(data, format="PNG")
    uploaded = client.post(
        f"/sessions/{sid}/attachments", files={"file": ("image.png", data.getvalue(), "image/png")}
    )
    assert uploaded.status_code == 201
    attachment = uploaded.json()["attachment_id"]
    assert (
        client.post(
            f"/sessions/{other}/turns", json={"request_id": "image", "attachment_ids": [attachment]}
        ).status_code
        == 404
    )
    for ext in ("doc", "ppt", "txt"):
        assert (
            client.post(f"/sessions/{sid}/sources/files", files={"file": (f"file.{ext}", b"abc")}).status_code
            == 415
        )
    assert (
        client.post(f"/sessions/{sid}/sources/websites", json={"url": "http://127.0.0.1"}).status_code == 503
    )


def test_replay_expiry_and_monotonic_sequence(client, app):
    sid = login(client)
    first = client.post(f"/sessions/{sid}/turns", json={"request_id": "one", "text": "test"}).json()
    settle(client, sid, first["turn_id"])
    db = app.state.db
    last = db.one("SELECT MAX(event_id) AS seq FROM events WHERE turn_id=?", (first["turn_id"],))["seq"]
    db.execute("UPDATE events SET created=0 WHERE turn_id=?", (first["turn_id"],))
    db.execute("UPDATE turns SET created=0 WHERE id=?", (first["turn_id"],))
    assert client.get(first["events_url"]).status_code == 410
    db.event(first["turn_id"], "system", "test", {})
    assert (
        db.one("SELECT MAX(event_id) AS seq FROM events WHERE turn_id=?", (first["turn_id"],))["seq"]
        == last + 1
    )


def test_session_deletion_isolated(client, app):
    sid = login(client)
    other = client.post("/sessions", json={}).json()["id"]
    root = app.state.retrieval.root(sid)
    root.mkdir(parents=True)
    (root / "marker").write_text("data")
    assert client.delete(f"/sessions/{sid}").status_code == 200
    assert not root.exists()
    assert client.get(f"/sessions/{other}").status_code == 200
