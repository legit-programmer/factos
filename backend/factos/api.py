import asyncio
import hashlib
import io
import json
import shutil
import sqlite3
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, File, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from PIL import Image

from .analysis import Analysis
from .auth import COOKIE, Auth
from .chat import ANALYSIS_TERMINAL, ANSWER_TERMINAL, BusyError, ConflictError, Runtime
from .config import Settings
from .db import Database, dump, uid
from .ingestion import SUPPORTED, Ingestion, public_url
from .providers import Providers
from .retrieval import Retrieval
from .schemas import Credentials, SessionCreate, TurnCreate, WebsiteCreate


class ApiError(Exception):
    def __init__(self, status, code, message, retryable=False):
        self.status, self.code, self.message, self.retryable = status, code, message, retryable


def create_app(settings=None, providers=None):
    settings = settings or Settings()
    db = Database(settings.data_dir)
    provider = providers or Providers(settings)
    auth = Auth(db)
    retrieval = Retrieval(db, settings, provider)
    analysis = Analysis(db, provider, retrieval, settings)
    runtime = Runtime(db, settings, provider, retrieval, analysis)
    ingestion = Ingestion(db, settings, provider, retrieval)

    @asynccontextmanager
    async def lifespan(app):
        db.recover()
        await asyncio.to_thread(retrieval.recover)
        db.execute("DELETE FROM events WHERE created<?", (time.time() - 86400,))
        yield
        await runtime.close()
        await provider.close()

    app = FastAPI(title="Factos Backend", version="0.1.0", lifespan=lifespan)
    app.state.db, app.state.runtime = db, runtime
    app.state.retrieval, app.state.ingestion, app.state.providers = retrieval, ingestion, provider
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[settings.allowed_origin],
        allow_credentials=True,
        allow_methods=["GET", "POST", "PATCH", "DELETE"],
        allow_headers=["Content-Type", "Last-Event-ID"],
    )

    @app.exception_handler(ApiError)
    async def api_error(request, exc):
        return JSONResponse(
            status_code=exc.status,
            content={"code": exc.code, "message": exc.message, "retryable": exc.retryable},
        )

    @app.exception_handler(RequestValidationError)
    async def validation_error(request, exc):
        # Do not echo submitted password or raw multipart values.
        return JSONResponse(
            status_code=422,
            content={"code": "invalid_input", "message": "Invalid request fields", "retryable": False},
        )

    @app.middleware("http")
    async def origin_check(request, call_next):
        if (
            request.method in {"POST", "DELETE", "PATCH", "PUT"}
            and request.headers.get("origin") != settings.allowed_origin
        ):
            return JSONResponse(
                status_code=403,
                content={
                    "code": "untrusted_origin",
                    "message": "Allowed browser Origin required",
                    "retryable": False,
                },
            )
        return await call_next(request)

    def current_user(request: Request):
        user = auth.resolve(request.cookies.get(COOKIE))
        if not user:
            raise ApiError(401, "unauthenticated", "Login required")
        return user

    def session_for(session_id, user):
        session = db.one("SELECT * FROM sessions WHERE id=? AND owner_id=?", (session_id, user["user_id"]))
        if not session or session_id in runtime.deleting:
            raise ApiError(404, "not_found", "Session not found")
        return session

    def turn_for(session_id, turn_id, user):
        session_for(session_id, user)
        turn = db.one("SELECT * FROM turns WHERE id=? AND session_id=?", (turn_id, session_id))
        if not turn:
            raise ApiError(404, "not_found", "Turn not found")
        return turn

    def source_for(session_id, source_id, user):
        session_for(session_id, user)
        source = db.one(
            "SELECT * FROM sources WHERE id=? AND session_id=? AND deleted=0", (source_id, session_id)
        )
        if not source:
            raise ApiError(404, "not_found", "Source not found")
        return source

    def admission(session_id):
        try:
            runtime.admit(session_id)
        except BusyError as exc:
            raise ApiError(429, "busy", str(exc), True) from exc
        except ConflictError as exc:
            raise ApiError(409, "deleting", str(exc)) from exc

    def login_response(user_id):
        token = auth.login(user_id)
        result = JSONResponse({"user_id": user_id})
        result.set_cookie(
            COOKIE,
            token,
            max_age=7 * 86400,
            httponly=True,
            secure=not settings.localhost_development,
            samesite="lax",
            path="/",
        )
        return result

    def auth_rate(request, email):
        try:
            auth.rate_limit(request.client.host if request.client else "unknown", email)
        except ValueError as exc:
            raise ApiError(429, "rate_limit", "Too many login attempts; retry later", True) from exc

    @app.get("/health")
    def health():
        return {"status": "ok"}

    @app.post("/auth/register", status_code=201)
    async def register(request: Request, credentials: Credentials):
        auth_rate(request, credentials.email)
        try:
            user_id = await auth.register(credentials.email, credentials.password)
        except sqlite3.IntegrityError as exc:
            raise ApiError(409, "registration_failed", "Registration could not be completed") from exc
        return JSONResponse({"user_id": user_id}, status_code=201)

    @app.post("/auth/login")
    async def login(request: Request, credentials: Credentials):
        auth_rate(request, credentials.email)
        user = await auth.verify(credentials.email, credentials.password)
        if not user:
            raise ApiError(401, "invalid_credentials", "Invalid email or password")
        return login_response(user["id"])

    @app.post("/auth/logout")
    async def logout(user=Depends(current_user)):
        db.execute("DELETE FROM auth_sessions WHERE token_hash=?", (user["token_hash"],))
        response = JSONResponse({"status": "logged_out"})
        response.delete_cookie(
            COOKIE, path="/", secure=not settings.localhost_development, httponly=True, samesite="lax"
        )
        return response

    @app.get("/auth/me")
    def me(user=Depends(current_user)):
        return {"user_id": user["user_id"], "email": user["email"]}

    @app.post("/sessions", status_code=201)
    async def create_session(body: SessionCreate, user=Depends(current_user)):
        session_id = uid("session")
        children = [{"id": uid("child"), "role": role} for role in ("rag", "baseline", "verifier")]
        with db.transaction() as conn:
            conn.execute(
                "INSERT INTO sessions VALUES(?,?,?,?,?,?)",
                (
                    session_id,
                    user["user_id"],
                    body.title,
                    None,
                    time.time(),
                    dump({"gemini_model": settings.gemini_model, **settings.manifest()}),
                ),
            )
            conn.executemany(
                "INSERT INTO children VALUES(?,?,?)", [(c["id"], session_id, c["role"]) for c in children]
            )
        return {"id": session_id, "children": children, "active_index_version": None}

    @app.get("/sessions")
    def list_sessions(user=Depends(current_user)):
        sessions = db.all(
            "SELECT s.id,s.title,s.active_index,s.created,COALESCE(MAX(t.created),s.created) AS updated,"
            "COALESCE(MAX(t.rag_state IN ('pending','running') OR t.baseline_state IN ('pending','running')),0)"
            " AS active FROM sessions s LEFT JOIN turns t ON t.session_id=s.id WHERE s.owner_id=?"
            " GROUP BY s.id ORDER BY s.created DESC",
            (user["user_id"],),
        )
        counts = {s["id"]: {"contradicted": 0, "unverifiable": 0} for s in sessions}
        for row in db.all(
            "SELECT t.session_id,a.result FROM analyses a JOIN turns t ON t.id=a.turn_id "
            "JOIN sessions s ON s.id=t.session_id WHERE s.owner_id=?",
            (user["user_id"],),
        ):
            for finding in json.loads(row["result"]).get("findings", []):
                if finding.get("verdict") in {"contradicted", "unverifiable"}:
                    counts[row["session_id"]][finding["verdict"]] += 1
        return {
            "sessions": [
                {**s, "active": bool(s["active"]), **counts[s["id"]]}
                for s in sessions
                if s["id"] not in runtime.deleting
            ]
        }

    @app.patch("/sessions/{session_id}")
    def rename_session(session_id: str, body: SessionCreate, user=Depends(current_user)):
        session_for(session_id, user)
        db.execute(
            "UPDATE sessions SET title=? WHERE id=? AND owner_id=?", (body.title, session_id, user["user_id"])
        )
        return {"id": session_id, "title": body.title}

    def saved_turn(turn):
        answers = db.all("SELECT * FROM answers WHERE turn_id=?", (turn["id"],))
        for answer in answers:
            answer["citations"] = json.loads(answer["citations"])
            answer["warnings"] = json.loads(answer["warnings"])
        analysis_record = db.one("SELECT result FROM analyses WHERE turn_id=?", (turn["id"],))
        message = db.one("SELECT * FROM user_messages WHERE id=?", (turn["user_message_id"],))
        message["attachments"] = json.loads(message["attachments"])
        return {
            **turn,
            "user_message": message,
            "answers": answers,
            "analysis": json.loads(analysis_record["result"]) if analysis_record else None,
        }

    @app.get("/sessions/{session_id}")
    def get_session(session_id: str, before_sequence: int = 2147483647, user=Depends(current_user)):
        session = session_for(session_id, user)
        turns = db.all(
            "SELECT * FROM turns WHERE session_id=? AND sequence<? ORDER BY sequence DESC LIMIT 50",
            (session_id, before_sequence),
        )
        exchanges = db.all(
            "SELECT v.turn_id,v.input,v.output,v.valid FROM verifier_exchanges v "
            "JOIN turns t ON t.id=v.turn_id WHERE v.session_id=? AND t.sequence<? "
            "ORDER BY t.sequence DESC LIMIT 50",
            (session_id, before_sequence),
        )
        return {
            "id": session_id,
            "title": session["title"],
            "active_index_version": session["active_index"],
            "children": db.all("SELECT id,role FROM children WHERE session_id=?", (session_id,)),
            "turns": [saved_turn(t) for t in reversed(turns)],
            "verifier_history": list(reversed(exchanges)),
            "sources": public_sources(session_id),
            "next_before_sequence": turns[-1]["sequence"] if len(turns) == 50 else None,
        }

    @app.delete("/sessions/{session_id}")
    async def delete_session(session_id: str, user=Depends(current_user)):
        session_for(session_id, user)
        async with runtime.locks[session_id]:
            runtime.deleting.add(session_id)
            tasks = [task for key, task in list(runtime.tasks.items()) if key[0] == session_id]
            tasks += [
                task
                for tid, task in list(runtime.analysis_tasks.items())
                if db.one("SELECT id FROM turns WHERE id=? AND session_id=?", (tid, session_id))
            ]
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            snapshot_ids = [
                row["id"] for row in db.all("SELECT id FROM snapshots WHERE session_id=?", (session_id,))
            ]
            db.execute("DELETE FROM sessions WHERE id=? AND owner_id=?", (session_id, user["user_id"]))
            await asyncio.to_thread(shutil.rmtree, retrieval.root(session_id), True)
            for snapshot_id in snapshot_ids:
                retrieval.handles.pop(snapshot_id, None)
            runtime.deleting.discard(session_id)
        return {"status": "deleted"}

    def public_sources(session_id):
        rows = db.all(
            "SELECT id,title,kind,status,warnings,error FROM sources WHERE session_id=? AND deleted=0",
            (session_id,),
        )
        for row in rows:
            row["warnings"] = json.loads(row["warnings"])
        return rows

    @app.get("/sessions/{session_id}/sources")
    def list_sources(session_id: str, user=Depends(current_user)):
        session_for(session_id, user)
        return {"sources": public_sources(session_id)}

    async def upload_bytes(file, limit):
        content = bytearray()
        while chunk := await file.read(65536):
            content.extend(chunk)
            if len(content) > limit:
                raise ApiError(413, "upload_too_large", "Upload exceeds size limit")
        return bytes(content)

    def source_limit(session_id):
        if (
            db.one("SELECT COUNT(*) AS count FROM sources WHERE session_id=? AND deleted=0", (session_id,))[
                "count"
            ]
            >= 100
        ):
            raise ApiError(429, "source_limit", "Session source limit (100) reached")

    @app.post("/sessions/{session_id}/sources/files", status_code=202)
    async def upload_source(session_id: str, file: UploadFile = File(...), user=Depends(current_user)):
        session_for(session_id, user)
        extension = Path(file.filename or "").suffix.lower()
        if extension not in SUPPORTED:
            raise ApiError(415, "unsupported_type", "Only PDF, DOCX, PPTX and Markdown are supported")
        data = await upload_bytes(file, settings.max_file_bytes)
        if (
            not data
            or (extension == ".pdf" and not data.startswith(b"%PDF-"))
            or (extension in {".docx", ".pptx"} and not data.startswith(b"PK"))
        ):
            raise ApiError(422, "invalid_file", "File content does not match supported format")
        if extension == ".md":
            try:
                data.decode("utf-8")
            except UnicodeDecodeError as exc:
                raise ApiError(422, "invalid_file", "Markdown must be UTF-8") from exc
        async with runtime.locks[session_id]:
            session_for(session_id, user)
            admission(session_id)
            source_limit(session_id)
            key = hashlib.sha256(data).hexdigest()
            duplicate = db.one(
                "SELECT id,status FROM sources WHERE session_id=? AND input_hash=? AND deleted=0 "
                "AND status IN ('ready','processing')",
                (session_id, key),
            )
            if duplicate:
                return {"source_id": duplicate["id"], "status": duplicate["status"], "deduplicated": True}
            source_id = uid("source")
            directory = retrieval.root(session_id) / "originals"
            directory.mkdir(parents=True, exist_ok=True)
            path = directory / (source_id + extension)
            await asyncio.to_thread(path.write_bytes, data)
            db.execute(
                "INSERT INTO sources(id,session_id,title,kind,path,input_hash,status) VALUES(?,?,?,?,?,?,?)",
                (
                    source_id,
                    session_id,
                    (file.filename or "Document")[:200],
                    "file",
                    str(path),
                    key,
                    "processing",
                ),
            )
            runtime.spawn(session_id, "source", source_id, ingestion.run(source_id))
        return {"source_id": source_id, "status": "processing"}

    @app.post("/sessions/{session_id}/sources/websites", status_code=202)
    async def website(session_id: str, body: WebsiteCreate, user=Depends(current_user)):
        session_for(session_id, user)
        if not settings.firecrawl_api_key or not settings.firecrawl_public_fetch_enforced:
            raise ApiError(
                503, "firecrawl_unavailable", "Configure Firecrawl with public fetch restrictions", True
            )
        try:
            await public_url(body.url)
        except (ValueError, OSError) as exc:
            raise ApiError(422, "unsafe_url", "Public HTTP(S) URL required") from exc
        async with runtime.locks[session_id]:
            session_for(session_id, user)
            admission(session_id)
            source_limit(session_id)
            key = hashlib.sha256(dump(body.model_dump()).encode()).hexdigest()
            duplicate = db.one(
                "SELECT id,status FROM sources WHERE session_id=? AND input_hash=? AND deleted=0 "
                "AND status IN ('ready','processing')",
                (session_id, key),
            )
            if duplicate:
                return {"source_id": duplicate["id"], "status": duplicate["status"], "deduplicated": True}
            source_id = uid("source")
            db.execute(
                "INSERT INTO sources(id,session_id,title,kind,path,input_hash,status,options) VALUES(?,?,?,?,?,?,?,?)",
                (
                    source_id,
                    session_id,
                    body.url,
                    "website",
                    body.url,
                    key,
                    "processing",
                    dump(body.model_dump()),
                ),
            )
            runtime.spawn(session_id, "source", source_id, ingestion.run(source_id))
        return {"source_id": source_id, "status": "processing"}

    @app.post("/sessions/{session_id}/sources/{source_id}/retry", status_code=202)
    async def source_retry(session_id: str, source_id: str, user=Depends(current_user)):
        async with runtime.locks[session_id]:
            source = source_for(session_id, source_id, user)
            admission(session_id)
            if source["status"] != "failed":
                raise ApiError(409, "source_not_failed", "Only failed sources can be retried")
            db.execute("UPDATE sources SET status='processing',error=NULL WHERE id=?", (source_id,))
            runtime.spawn(session_id, "source", source_id, ingestion.run(source_id))
        return {"source_id": source_id, "status": "processing"}

    @app.delete("/sessions/{session_id}/sources/{source_id}")
    async def source_delete(session_id: str, source_id: str, user=Depends(current_user)):
        async with runtime.locks[session_id]:
            source_for(session_id, source_id, user)
            task = runtime.tasks.get((session_id, "source", source_id))
            if task:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
            await retrieval.publish(session_id, delete_source=source_id)
        return {"status": "deleted"}

    def inspect_image(data):
        with Image.open(io.BytesIO(data)) as image:
            if (
                image.format not in {"JPEG", "PNG", "WEBP"}
                or image.width * image.height > 20_000_000
                or getattr(image, "n_frames", 1) != 1
            ):
                raise ValueError("unsupported image or excessive pixels")
            mime = Image.MIME[image.format]
            dimensions = image.size
            image.verify()
        return mime, dimensions

    @app.post("/sessions/{session_id}/attachments", status_code=201)
    async def upload_attachment(session_id: str, file: UploadFile = File(...), user=Depends(current_user)):
        session_for(session_id, user)
        data = await upload_bytes(file, 10 * 1024 * 1024)
        try:
            mime, dimensions = await asyncio.to_thread(inspect_image, data)
        except Exception as exc:
            raise ApiError(
                422, "invalid_image", "Valid single-frame JPEG/PNG/WebP within pixel limit required"
            ) from exc
        async with runtime.locks[session_id]:
            session_for(session_id, user)
            attachment_id = uid("attachment")
            directory = retrieval.root(session_id) / "attachments"
            directory.mkdir(parents=True, exist_ok=True)
            path = directory / attachment_id
            await asyncio.to_thread(path.write_bytes, data)
            db.execute(
                "INSERT INTO attachments VALUES(?,?,?,?,?,?)",
                (attachment_id, session_id, str(path), mime, *dimensions),
            )
        return {"attachment_id": attachment_id, "mime": mime, "width": dimensions[0], "height": dimensions[1]}

    @app.post("/sessions/{session_id}/turns", status_code=202)
    async def create_turn(session_id: str, body: TurnCreate, user=Depends(current_user)):
        session_for(session_id, user)
        try:
            turn = await runtime.create_turn(session_id, body)
        except BusyError as exc:
            raise ApiError(429, "busy", str(exc), True) from exc
        except ConflictError as exc:
            raise ApiError(409, "turn_conflict", str(exc)) from exc
        except RuntimeError as exc:
            raise ApiError(503, "provider_unavailable", "Configure the Gemini provider", True) from exc
        except ValueError as exc:
            raise ApiError(404, "not_found", "Attachment not found in session") from exc
        return {
            "session_id": session_id,
            "turn_id": turn["id"],
            "index_version_id": turn["index_version"],
            "processing_source_ids": [
                s["id"]
                for s in db.all(
                    "SELECT id FROM sources WHERE session_id=? AND status='processing' AND deleted=0",
                    (session_id,),
                )
            ],
            "events_url": f"/sessions/{session_id}/turns/{turn['id']}/events",
        }

    @app.get("/sessions/{session_id}/turns/{turn_id}")
    def get_turn(session_id: str, turn_id: str, user=Depends(current_user)):
        return saved_turn(turn_for(session_id, turn_id, user))

    @app.post("/sessions/{session_id}/turns/{turn_id}/cancel")
    async def cancel(session_id: str, turn_id: str, user=Depends(current_user)):
        turn_for(session_id, turn_id, user)
        await runtime.cancel(session_id, turn_id)
        return {"status": "cancelled"}

    @app.post("/sessions/{session_id}/turns/{turn_id}/analysis/retry", status_code=202)
    async def analysis_retry(session_id: str, turn_id: str, user=Depends(current_user)):
        async with runtime.locks[session_id]:
            turn = turn_for(session_id, turn_id, user)
            admission(session_id)
            if (
                turn["baseline_state"] != "completed"
                or turn["cancelled"]
                or turn["analysis_state"] in {"pending", "running"}
            ):
                raise ApiError(409, "analysis_conflict", "Completed baseline and terminal analysis required")
            if db.one(
                "SELECT id FROM turns WHERE session_id=? AND analysis_state IN ('pending','running')",
                (session_id,),
            ):
                raise ApiError(409, "analysis_conflict", "Wait for queued verification before retrying")
            db.execute("UPDATE turns SET analysis_state='pending' WHERE id=?", (turn_id,))
            db.event(turn_id, "analysis", "analysis.queued", {"retry": True})
            runtime.ensure_verifier(session_id)
        return {"status": "pending", "turn_id": turn_id}

    @app.get("/sessions/{session_id}/turns/{turn_id}/events")
    async def events(request: Request, session_id: str, turn_id: str, user=Depends(current_user)):
        turn = turn_for(session_id, turn_id, user)
        try:
            last = int(request.headers.get("last-event-id", "0"))
            if last < 0:
                raise ValueError()
        except ValueError as exc:
            raise ApiError(422, "invalid_event_id", "Nonnegative Last-Event-ID required") from exc
        db.execute("DELETE FROM events WHERE created<?", (time.time() - 86400,))
        bounds = db.one(
            "SELECT MIN(event_id) AS first,MAX(event_id) AS last FROM events WHERE turn_id=?", (turn_id,)
        )
        if (turn["created"] < time.time() - 86400 and last == 0) or (
            bounds["first"] and last < bounds["first"] - 1
        ):
            raise ApiError(410, "replay_expired", "Fetch saved turn state; event replay expired")
        if last > turn["event_sequence"]:
            raise ApiError(422, "invalid_event_id", "Last-Event-ID is beyond this turn")

        async def stream():
            cursor, heartbeat = last, time.monotonic()
            while True:
                if await request.is_disconnected() or not auth.resolve(request.cookies.get(COOKIE)):
                    return
                current = db.one("SELECT * FROM turns WHERE id=? AND session_id=?", (turn_id, session_id))
                if not current or session_id in runtime.deleting:
                    return
                batch = db.all(
                    "SELECT * FROM events WHERE turn_id=? AND event_id>? ORDER BY event_id LIMIT 50",
                    (turn_id, cursor),
                )
                for row in batch:
                    if not auth.resolve(request.cookies.get(COOKIE)) or session_id in runtime.deleting:
                        return
                    cursor = row["event_id"]
                    value = {
                        "event_id": cursor,
                        "session_id": session_id,
                        "turn_id": turn_id,
                        "channel": row["channel"],
                        "type": row["type"],
                        "payload": json.loads(row["payload"]),
                    }
                    yield f"id: {cursor}\nevent: {row['type']}\ndata: {dump(value)}\n\n"
                if batch:
                    continue
                if (
                    current["rag_state"] in ANSWER_TERMINAL
                    and current["baseline_state"] in ANSWER_TERMINAL
                    and current["analysis_state"] in ANALYSIS_TERMINAL
                ):
                    return
                if time.monotonic() - heartbeat >= 15:
                    yield ": heartbeat\n\n"
                    heartbeat = time.monotonic()
                await asyncio.sleep(0.2)

        return StreamingResponse(
            stream(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    return app
