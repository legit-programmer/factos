import asyncio
import hashlib
import json
import os
import shutil
from collections import defaultdict

import faiss
import numpy as np

from .db import dump, uid
from .tasks import blocking


def normalize(vectors, dimension):
    array = np.asarray(vectors, dtype=np.float32)
    if array.ndim != 2 or array.shape[1] != dimension or not np.isfinite(array).all():
        raise ValueError("invalid vector shape/dimension or non-finite vector")
    norms = np.linalg.norm(array, axis=1, keepdims=True)
    if np.any(norms == 0) or not np.isfinite(norms).all():
        raise ValueError("zero or non-finite vector norm")
    return np.ascontiguousarray(array / norms, dtype=np.float32)


class Retrieval:
    def __init__(self, db, settings, providers):
        self.db, self.settings, self.providers = db, settings, providers
        self.locks = defaultdict(asyncio.Lock)
        self.handles = {}

    def root(self, session_id):
        # All IDs are server-created and checked against SQLite by callers.
        return self.settings.data_dir / "sessions" / session_id

    async def publish(self, session_id, source_id=None, prepared=None, delete_source=None):
        async with self.locks[session_id]:
            return await blocking(self._publish, session_id, source_id, prepared, delete_source)

    def _publish(self, session_id, source_id, prepared, delete_source):
        if not self.db.one("SELECT id FROM sessions WHERE id=?", (session_id,)):
            raise ValueError("session deleted")
        if source_id:
            source = self.db.one(
                "SELECT * FROM sources WHERE id=? AND session_id=? AND deleted=0", (source_id, session_id)
            )
            if not source:
                raise ValueError("source deleted")
        rows = self.db.all(
            "SELECT c.* FROM chunks c JOIN sources s ON s.id=c.source_id "
            "WHERE c.session_id=? AND s.status='ready' AND s.deleted=0",
            (session_id,),
        )
        if delete_source:
            rows = [row for row in rows if row["source_id"] != delete_source]
        prepared = prepared or []
        if len(rows) + len(prepared) > 50000:
            raise ValueError("chunk limit (50000) exceeded")
        version = uid("index")
        parent = self.root(session_id) / "indexes"
        parent.mkdir(parents=True, exist_ok=True)
        stage = parent / f".staging-{version}"
        final = parent / version
        stage.mkdir()
        try:
            with self.db.transaction() as conn:
                # Serial publication merges all sources ready at this point, rather than a captured list.
                for item in prepared:
                    cursor = conn.execute(
                        "INSERT INTO chunks(id,session_id,source_id,text,locator,vector) VALUES(?,?,?,?,?,?)",
                        (
                            item["id"],
                            session_id,
                            source_id,
                            item["text"],
                            dump(item["locator"]),
                            item["vector"],
                        ),
                    )
                    rows.append({**item, "vector_id": cursor.lastrowid, "source_id": source_id})
                dimension = self.settings.embedding_dimension
                index = faiss.IndexIDMap2(faiss.IndexFlatIP(dimension))
                if rows:
                    vectors = normalize(
                        [np.frombuffer(row["vector"], dtype=np.float32) for row in rows], dimension
                    )
                    index.add_with_ids(vectors, np.array([row["vector_id"] for row in rows], dtype=np.int64))
                faiss.write_index(index, str(stage / "index.faiss"))
                manifest = {
                    **self.settings.manifest(),
                    "version": version,
                    "count": len(rows),
                    "vector_ids": [row["vector_id"] for row in rows],
                    "chunk_ids": [row["id"] for row in rows],
                    "sha256": hashlib.sha256((stage / "index.faiss").read_bytes()).hexdigest(),
                }
                (stage / "manifest.json").write_text(dump(manifest))
                for file in stage.iterdir():
                    with file.open("rb") as handle:
                        os.fsync(handle.fileno())
                check = faiss.read_index(str(stage / "index.faiss"))
                if check.ntotal != len(rows) or check.d != dimension:
                    raise ValueError("snapshot integrity failed")
                os.rename(stage, final)
                fd = os.open(parent, os.O_RDONLY)
                try:
                    os.fsync(fd)
                finally:
                    os.close(fd)
                conn.execute(
                    "INSERT INTO snapshots VALUES(?,?,?,?)", (version, session_id, dump(manifest), str(final))
                )
                conn.executemany(
                    "INSERT INTO snapshot_chunks VALUES(?,?)", [(version, row["id"]) for row in rows]
                )
                if source_id:
                    conn.execute("UPDATE sources SET status='ready',error=NULL WHERE id=?", (source_id,))
                if delete_source:
                    conn.execute("UPDATE sources SET deleted=1 WHERE id=?", (delete_source,))
                conn.execute("UPDATE sessions SET active_index=? WHERE id=?", (version, session_id))
            return version
        finally:
            shutil.rmtree(stage, ignore_errors=True)

    def load(self, session_id, version):
        row = self.db.one("SELECT * FROM snapshots WHERE id=? AND session_id=?", (version, session_id))
        if not row:
            raise ValueError("index is outside session")
        manifest = json.loads(row["manifest"])
        if any(manifest.get(k) != v for k, v in self.settings.manifest().items()):
            raise ValueError("embedding/parser configuration changed: rebuild the session index")
        if version not in self.handles:
            path = self.root(session_id) / "indexes" / version
            if json.loads((path / "manifest.json").read_text()) != manifest:
                raise ValueError("manifest checksum/mapping mismatch")
            content = (path / "index.faiss").read_bytes()
            if hashlib.sha256(content).hexdigest() != manifest["sha256"]:
                raise ValueError("index checksum mismatch")
            index = faiss.read_index(str(path / "index.faiss"))
            ids = faiss.vector_to_array(index.id_map).tolist()
            mapped = self.db.all(
                "SELECT c.vector_id,c.id FROM snapshot_chunks sc JOIN chunks c ON c.id=sc.chunk_id "
                "WHERE sc.snapshot_id=? ORDER BY c.vector_id",
                (version,),
            )
            if (
                index.ntotal != manifest["count"]
                or index.d != self.settings.embedding_dimension
                or ids != manifest["vector_ids"]
                or sorted(zip(ids, manifest["chunk_ids"])) != [(r["vector_id"], r["id"]) for r in mapped]
            ):
                raise ValueError("index count or vector mapping mismatch")
            # Cache is bounded; old turn snapshots remain reloadable from disk.
            if len(self.handles) >= 8:
                self.handles.pop(next(iter(self.handles)))
            self.handles[version] = index
        return self.handles[version]

    def chunks(self, session_id, version, ids):
        if not version or not ids:
            return []
        marks = ",".join("?" for _ in ids)
        rows = self.db.all(
            "SELECT c.id AS chunk_id,c.source_id,c.text,c.locator,s.title FROM chunks c "
            "JOIN snapshot_chunks sc ON sc.chunk_id=c.id JOIN sources s ON s.id=c.source_id "
            f"WHERE sc.snapshot_id=? AND c.session_id=? AND c.id IN ({marks})",
            (version, session_id, *ids),
        )
        for row in rows:
            row["locator"] = json.loads(row["locator"])
        return rows

    async def search_corpus(self, session_id, index_version_id, query, top_k=8):
        if not index_version_id:
            return []
        query_vector = normalize([await self.providers.embed_query(query)], self.settings.embedding_dimension)

        def search():
            index = self.load(session_id, index_version_id)
            scores, ids = index.search(query_vector, min(top_k, index.ntotal)) if index.ntotal else ([], [])
            if not index.ntotal:
                return []
            return list(zip(ids[0].tolist(), scores[0].tolist()))

        matches = await asyncio.to_thread(search)
        if not matches:
            return []
        vector_ids = [m[0] for m in matches if m[0] >= 0]
        marks = ",".join("?" for _ in vector_ids)
        rows = self.db.all(
            f"SELECT id,vector_id FROM chunks WHERE session_id=? AND vector_id IN ({marks})",
            (session_id, *vector_ids),
        )
        lookup = {row["vector_id"]: row["id"] for row in rows}
        chunks = {
            row["chunk_id"]: row for row in self.chunks(session_id, index_version_id, list(lookup.values()))
        }
        result, seen = [], set()
        for vid, score in matches:
            row = chunks.get(lookup.get(vid))
            if row and row["text"] not in seen:
                result.append({**row, "similarity": score})
                seen.add(row["text"])
        return result

    def recover(self):
        snapshots = {row["id"] for row in self.db.all("SELECT id FROM snapshots")}
        root = self.settings.data_dir / "sessions"
        if root.exists():
            sessions = {row["id"] for row in self.db.all("SELECT id FROM sessions")}
            for directory in root.iterdir():
                if directory.name not in sessions:
                    shutil.rmtree(directory)
                    continue
                indexes = directory / "indexes"
                if indexes.exists():
                    for path in indexes.iterdir():
                        if path.name not in snapshots:
                            shutil.rmtree(path)
        for row in self.db.all("SELECT id,active_index FROM sessions WHERE active_index IS NOT NULL"):
            self.load(row["id"], row["active_index"])
