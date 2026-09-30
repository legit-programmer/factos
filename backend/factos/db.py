import hashlib
import json
import sqlite3
import time
import uuid
from contextlib import contextmanager


def uid(prefix):
    return f"{prefix}_{uuid.uuid4().hex}"


def digest(text):
    return hashlib.sha256(text.encode()).hexdigest()


def dump(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


SCHEMA = """
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,password TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS auth_sessions(token_hash TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id),expires REAL);
CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES users(id),title TEXT,
 active_index TEXT,created REAL,model_config TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS children(id TEXT PRIMARY KEY,session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
 role TEXT CHECK(role IN ('rag','baseline','verifier')),UNIQUE(session_id,role));
CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY,session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
 title TEXT,kind TEXT,path TEXT,input_hash TEXT,status TEXT,deleted INTEGER DEFAULT 0,
 warnings TEXT DEFAULT '[]',error TEXT,options TEXT DEFAULT '{}');
CREATE TABLE IF NOT EXISTS chunks(vector_id INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,
 session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,source_id TEXT REFERENCES sources(id) ON DELETE CASCADE,
 text TEXT,locator TEXT,vector BLOB);
CREATE TABLE IF NOT EXISTS snapshots(id TEXT PRIMARY KEY,session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
 manifest TEXT,path TEXT);
CREATE TABLE IF NOT EXISTS snapshot_chunks(snapshot_id TEXT REFERENCES snapshots(id) ON DELETE CASCADE,
 chunk_id TEXT REFERENCES chunks(id) ON DELETE CASCADE,PRIMARY KEY(snapshot_id,chunk_id));
CREATE TABLE IF NOT EXISTS attachments(id TEXT PRIMARY KEY,session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
 path TEXT,mime TEXT,width INTEGER,height INTEGER);
CREATE TABLE IF NOT EXISTS user_messages(id TEXT PRIMARY KEY,session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
 text TEXT,attachments TEXT);
CREATE TABLE IF NOT EXISTS turns(id TEXT PRIMARY KEY,session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
 sequence INTEGER,request_id TEXT,payload_hash TEXT,index_version TEXT,user_message_id TEXT REFERENCES user_messages(id),
 rag_state TEXT,baseline_state TEXT,analysis_state TEXT,created REAL,cancelled INTEGER DEFAULT 0,event_sequence INTEGER NOT NULL DEFAULT 0,
 UNIQUE(session_id,request_id),UNIQUE(session_id,sequence));
CREATE TABLE IF NOT EXISTS answers(id TEXT PRIMARY KEY,session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
 child_id TEXT REFERENCES children(id) ON DELETE CASCADE,turn_id TEXT REFERENCES turns(id) ON DELETE CASCADE,
 lane TEXT,text TEXT DEFAULT '',status TEXT,citations TEXT DEFAULT '[]',text_hash TEXT,warnings TEXT DEFAULT '[]',
 UNIQUE(turn_id,lane));
CREATE TABLE IF NOT EXISTS verifier_exchanges(turn_id TEXT PRIMARY KEY REFERENCES turns(id) ON DELETE CASCADE,
 session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,child_id TEXT REFERENCES children(id) ON DELETE CASCADE,
 input TEXT,output TEXT,valid INTEGER);
CREATE TABLE IF NOT EXISTS analyses(turn_id TEXT PRIMARY KEY REFERENCES turns(id) ON DELETE CASCADE,
 result TEXT,raw TEXT,error TEXT);
CREATE TABLE IF NOT EXISTS events(turn_id TEXT REFERENCES turns(id) ON DELETE CASCADE,event_id INTEGER,
 session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,channel TEXT,type TEXT,payload TEXT,created REAL,
 PRIMARY KEY(turn_id,event_id));
CREATE INDEX IF NOT EXISTS turn_order ON turns(session_id,sequence);
"""


class Database:
    def __init__(self, root):
        root.mkdir(parents=True, exist_ok=True)
        self.path = root / "factos.sqlite3"
        with self.connect() as conn:
            conn.executescript(SCHEMA)
            conn.execute("PRAGMA journal_mode=WAL")

    def connect(self):
        conn = sqlite3.connect(self.path, timeout=10)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys=ON")
        return conn

    @contextmanager
    def transaction(self):
        conn = self.connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            yield conn
            conn.commit()
        except BaseException:
            conn.rollback()
            raise
        finally:
            conn.close()

    def all(self, sql, args=()):
        with self.connect() as conn:
            return [dict(row) for row in conn.execute(sql, args)]

    def one(self, sql, args=()):
        rows = self.all(sql, args)
        return rows[0] if rows else None

    def execute(self, sql, args=()):
        with self.transaction() as conn:
            conn.execute(sql, args)

    def recover(self):
        with self.transaction() as conn:
            conn.execute("UPDATE sources SET status='failed',error='interrupted' WHERE status='processing'")
            for lane in ("rag", "baseline"):
                conn.execute(
                    f"UPDATE turns SET {lane}_state='failed' WHERE {lane}_state IN ('pending','running')"
                )
            conn.execute(
                "UPDATE answers SET status='failed',warnings='[\"interrupted\"]' WHERE status IN ('pending','running')"
            )
            conn.execute(
                "UPDATE turns SET analysis_state='failed' WHERE analysis_state IN ('pending','running')"
            )

    def event(self, turn_id, channel, kind, payload):
        with self.transaction() as conn:
            turn = conn.execute(
                "SELECT session_id,event_sequence FROM turns WHERE id=?", (turn_id,)
            ).fetchone()
            if not turn:
                return
            seq = turn[1] + 1
            conn.execute("UPDATE turns SET event_sequence=? WHERE id=?", (seq, turn_id))
            conn.execute(
                "INSERT INTO events VALUES(?,?,?,?,?,?,?)",
                (turn_id, seq, turn[0], channel, kind, dump(payload), time.time()),
            )
        return seq
