import asyncio
import json
import re
import time

from google.genai import types

from .db import digest, dump, uid
from .ingestion import tokenizer
from .schemas import ChunkArgs, RawAnalysis, SearchArgs
from .tasks import blocking


def answer_blocks(text):
    # Stable blocks retain exact canonical whitespace and absolute Python positions.
    matches = list(re.finditer(r"[^\n]+(?:\n|$)|\n", text))
    return {
        f"b_{number}": {"text": match.group(), "start": match.start()} for number, match in enumerate(matches)
    }


def utf16_length(text):
    return len(text.encode("utf-16-le")) // 2


def resolve_findings(raw, answer, blocks, evidence_seen):
    findings, problems = [], []
    for finding in raw.findings:
        try:
            block = blocks[finding.block_id]
            offsets = [m.start() for m in re.finditer(re.escape(finding.quote), block["text"])]
            start = block["start"] + offsets[finding.occurrence]
            end = start + len(finding.quote)
            if answer[start:end] != finding.quote:
                raise ValueError("quote mismatch")
            evidence = []
            for ref in finding.evidence:
                chunk = evidence_seen.get(ref.chunk_id)
                if not chunk or ref.excerpt not in chunk["text"]:
                    raise ValueError("evidence was not retrieved from pinned index or excerpt mismatch")
                evidence.append(
                    {
                        "chunk_id": ref.chunk_id,
                        "source_id": chunk["source_id"],
                        "title": chunk["title"],
                        "locator": chunk["locator"],
                        "excerpt": ref.excerpt,
                    }
                )
            if finding.verdict == "contradicted" and (
                not evidence or not finding.correction or not finding.correction.strip()
            ):
                raise ValueError("contradiction requires retrieved evidence and correction")
            findings.append(
                {
                    "id": uid("finding"),
                    "quote": finding.quote,
                    "start_utf16": utf16_length(answer[:start]),
                    "end_utf16": utf16_length(answer[:end]),
                    "verdict": finding.verdict,
                    "highlight": "red" if finding.verdict == "contradicted" else "yellow",
                    "reason_code": finding.reason_code,
                    "reason": finding.reason,
                    "correction": finding.correction,
                    "evidence": evidence,
                }
            )
        except (KeyError, IndexError, ValueError) as exc:
            problems.append(f"Withheld finding for {finding.block_id}: {exc}")
    unique = {}
    for finding in findings:
        key = (finding["start_utf16"], finding["end_utf16"], finding["verdict"])
        unique.setdefault(key, finding)
    ordered = sorted(unique.values(), key=lambda f: (f["start_utf16"], f["end_utf16"]))
    conflicts = set()
    for i, first in enumerate(ordered):
        for j, second in enumerate(ordered[i + 1 :], i + 1):
            if second["start_utf16"] >= first["end_utf16"]:
                break
            conflicts.update((i, j))
    if conflicts:
        problems.append("Overlapping findings withheld; exact disjoint ranges required")
    return [f for i, f in enumerate(ordered) if i not in conflicts], problems


class Analysis:
    def __init__(self, db, providers, retrieval, settings):
        self.db, self.providers, self.retrieval, self.settings = db, providers, retrieval, settings

    def history(self, turn):
        rows = self.db.all(
            "SELECT v.* FROM verifier_exchanges v JOIN turns t ON t.id=v.turn_id "
            "WHERE v.session_id=? AND t.sequence<? ORDER BY t.sequence",
            (turn["session_id"], turn["sequence"]),
        )
        budget, pairs = self.settings.history_tokens, []
        for row in reversed(rows):
            final = (
                row["output"]
                if row["valid"]
                else "FAILED/INVALID ANALYSIS. Untrusted raw output: " + row["output"]
            )
            size = len(tokenizer().encode(row["input"] + final))
            if size > budget:
                break
            pairs.insert(0, (row["input"], final))
            budget -= size
        contents = []
        for question, final in pairs:
            contents.extend(
                [
                    types.Content(role="user", parts=[types.Part.from_text(text=question)]),
                    types.Content(role="model", parts=[types.Part.from_text(text=final)]),
                ]
            )
        return contents

    async def run(self, turn_id):
        turn = self.db.one("SELECT * FROM turns WHERE id=?", (turn_id,))
        baseline = self.db.one("SELECT * FROM answers WHERE turn_id=? AND lane='baseline'", (turn_id,))
        user = self.db.one("SELECT * FROM user_messages WHERE id=?", (turn["user_message_id"],))
        blocks = answer_blocks(baseline["text"])
        request = {
            "question": user["text"],
            "baseline_answer": baseline["text"],
            "blocks": blocks,
            "message_id": baseline["id"],
            "answer_text_sha256": baseline["text_hash"],
            "index_version_id": turn["index_version"],
        }
        child = self.db.one(
            "SELECT id FROM children WHERE session_id=? AND role='verifier'", (turn["session_id"],)
        )
        self.db.execute(
            "INSERT INTO verifier_exchanges VALUES(?,?,?,?,?,?) ON CONFLICT(turn_id) DO UPDATE "
            "SET input=excluded.input,output='',valid=0",
            (turn_id, turn["session_id"], child["id"], dump(request), "", 0),
        )
        return await self._verify(turn, baseline, user, child, request, blocks)

    async def _verify(self, turn, baseline, user, child, request, blocks):
        turn_id = turn["id"]
        contents = self.history(turn)
        images = self.db.all("SELECT * FROM attachments WHERE session_id=?", (turn["session_id"],))
        attachment_ids = json.loads(user["attachments"])
        current_contents = await blocking(
            self.providers.contents,
            [
                {
                    "role": "user",
                    "text": dump(request),
                    "images": [a for a in images if a["id"] in attachment_ids],
                }
            ],
        )
        current = current_contents[0]
        contents.append(current)
        calls_used, rounds, reason, raw_text = 0, 0, "answered", ""
        evidence_seen, tool_errors, evidence_tokens = {}, [], 0
        deadline = time.monotonic() + self.settings.analysis_timeout
        try:
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    reason = "timeout"
                    break
                try:
                    async with asyncio.timeout(remaining):
                        response = await self.providers.verify(contents, True)
                except TimeoutError:
                    reason = "timeout"
                    break
                # Preserve full provider content, including function IDs and thought signatures.
                contents.append(response.candidates[0].content)
                calls = response.function_calls or []
                if not calls:
                    raw_text = response.text or ""
                    break
                rounds += 1
                results = []
                for call in calls:
                    if calls_used >= 10:
                        output = {"error": "tool_budget_exhausted"}
                    else:
                        calls_used += 1
                        try:
                            async with asyncio.timeout(max(0.01, deadline - time.monotonic())):
                                if call.name == "search_sources":
                                    args = SearchArgs.model_validate(call.args or {})
                                    chunks = await self.retrieval.search_corpus(
                                        turn["session_id"], turn["index_version"], args.query, args.top_k
                                    )
                                elif call.name == "get_source_chunks":
                                    args = ChunkArgs.model_validate(call.args or {})
                                    chunks = self.retrieval.chunks(
                                        turn["session_id"], turn["index_version"], args.chunk_ids
                                    )
                                    if len(chunks) != len(set(args.chunk_ids)):
                                        raise ValueError("chunk outside pinned index")
                                else:
                                    raise ValueError("unknown tool")
                                accepted, used = [], 0
                                for chunk in chunks:
                                    size = len(tokenizer().encode(dump(chunk)))
                                    if used + size <= 3000 and evidence_tokens + size <= 12000:
                                        accepted.append(chunk)
                                        evidence_seen[chunk["chunk_id"]] = chunk
                                        used += size
                                evidence_tokens += used
                                output = {"chunks": accepted, "truncated": len(accepted) < len(chunks)}
                                if output["truncated"]:
                                    tool_errors.append(
                                        "Evidence response budget reached; coverage may be incomplete"
                                    )
                        except Exception as exc:
                            output = {"error": type(exc).__name__, "message": str(exc)[:200]}
                            tool_errors.append("Vector tool failed: " + type(exc).__name__)
                    results.append(
                        types.Part(
                            function_response=types.FunctionResponse(
                                id=call.id, name=call.name, response=output
                            )
                        )
                    )
                contents.append(types.Content(role="user", parts=results))
                if calls_used >= 10 or rounds >= 10:
                    reason = "tool_limit"
                    break
            if reason in {"tool_limit", "timeout"}:
                contents.append(
                    types.Content(
                        role="user",
                        parts=[
                            types.Part.from_text(
                                text="Return final analysis now using retrieved evidence. Mark unsupported claims unverifiable; "
                                "disclose incomplete coverage. No tools or invented evidence/corrections."
                            )
                        ],
                    )
                )
                response = await self.providers.verify(contents, False)
                contents.append(response.candidates[0].content)
                raw_text = response.text or ""
            findings, validation = [], []
            for attempt in range(2):
                try:
                    raw = RawAnalysis.model_validate_json(raw_text)
                    if any(block not in blocks for block in raw.coverage.unchecked_block_ids):
                        raise ValueError("unknown unchecked block ID")
                    findings, validation = resolve_findings(raw, baseline["text"], blocks, evidence_seen)
                    if validation and attempt == 0:
                        raise ValueError("; ".join(validation))
                    break
                except (ValueError, TypeError) as exc:
                    if attempt:
                        raise
                    contents.append(
                        types.Content(
                            role="user",
                            parts=[
                                types.Part.from_text(
                                    text="Repair JSON/spans once, with no tools. Validation errors: "
                                    + str(exc)[:3000]
                                )
                            ],
                        )
                    )
                    response = await self.providers.verify(contents, False)
                    raw_text = response.text or ""
            coverage = raw.coverage.model_dump()
            partial = bool(
                validation
                or tool_errors
                or coverage["extraction_truncated"]
                or coverage["unchecked_block_ids"]
                or coverage["claims_checked"] < coverage["claims_extracted"]
                or reason == "timeout"
            )
            result = {
                "session_id": turn["session_id"],
                "turn_id": turn_id,
                "child_session_id": baseline["child_id"],
                "message_id": baseline["id"],
                "answer_text_sha256": digest(baseline["text"]),
                "index_version_id": turn["index_version"],
                "status": "partial" if partial else "completed",
                "tool_calls_used": calls_used,
                "termination_reason": reason,
                "coverage": coverage,
                "findings": findings,
                "warnings": raw.warnings + validation + tool_errors,
            }
            self.save(turn_id, raw_text, result, True)
            return result
        except asyncio.CancelledError:
            self.save(
                turn_id,
                raw_text,
                {
                    "status": "failed",
                    "termination_reason": "error",
                    "tool_calls_used": calls_used,
                    "findings": [],
                    "warnings": ["cancelled"],
                },
                False,
            )
            raise
        except Exception as exc:
            result = {
                "status": "failed",
                "termination_reason": "error",
                "tool_calls_used": calls_used,
                "findings": [],
                "warnings": ["Verification failed: " + type(exc).__name__],
            }
            self.save(turn_id, raw_text, result, False)
            return result

    def save(self, turn_id, raw_text, result, valid):
        with self.db.transaction() as conn:
            conn.execute(
                "INSERT INTO analyses VALUES(?,?,?,?) ON CONFLICT(turn_id) DO UPDATE SET "
                "result=excluded.result,raw=excluded.raw,error=excluded.error",
                (turn_id, dump(result), raw_text, None if valid else dump(result["warnings"])),
            )
            conn.execute(
                "UPDATE verifier_exchanges SET output=?,valid=? WHERE turn_id=?",
                (raw_text if not valid else dump(result), int(valid), turn_id),
            )
            conn.execute("UPDATE turns SET analysis_state=? WHERE id=?", (result["status"], turn_id))
