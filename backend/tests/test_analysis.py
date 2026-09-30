from factos.analysis import answer_blocks, resolve_findings, utf16_length
from factos.schemas import RawAnalysis


def raw(findings):
    return RawAnalysis.model_validate(
        {"coverage": {"claims_extracted": 2, "claims_checked": 2}, "findings": findings}
    )


def finding(quote, **kwargs):
    return {
        "block_id": "b_0",
        "quote": quote,
        "occurrence": 0,
        "verdict": "unverifiable",
        "reason_code": "no_evidence_found",
        "reason": "Not established",
        **kwargs,
    }


def test_utf16_repeated_quotes():
    answer = "😀 Policy. Policy.\nSecond line"
    findings, errors = resolve_findings(
        raw([finding("Policy.", occurrence=1)]), answer, answer_blocks(answer), {}
    )
    assert not errors
    found = findings[0]
    assert found["start_utf16"] == 11
    assert found["end_utf16"] == 18
    assert answer.encode("utf-16-le")[22:36].decode("utf-16-le") == "Policy."
    assert utf16_length("😀") == 2


def test_red_evidence_and_quote_checks():
    answer = "5 years"
    red = finding(
        "5 years",
        verdict="contradicted",
        correction="2 years",
        evidence=[{"chunk_id": "c_1", "excerpt": "2 years"}],
    )
    chunk = {"source_id": "s_1", "title": "Policy", "locator": {"page": 2}, "text": "Warranty is 2 years."}
    valid, errors = resolve_findings(raw([red]), answer, answer_blocks(answer), {"c_1": chunk})
    assert not errors and valid[0]["highlight"] == "red"
    assert resolve_findings(raw([red]), answer, answer_blocks(answer), {})[1]
    red["correction"] = None
    assert resolve_findings(raw([red]), answer, answer_blocks(answer), {"c_1": chunk})[1]
    assert resolve_findings(raw([finding("absent")]), answer, answer_blocks(answer), {})[1]


def test_duplicates_and_conflicting_overlaps():
    answer = "Warranty lasts 5 years"
    duplicate = finding("5 years")
    assert len(resolve_findings(raw([duplicate, duplicate]), answer, answer_blocks(answer), {})[0]) == 1
    valid, errors = resolve_findings(
        raw([finding("Warranty lasts 5"), finding("5 years")]), answer, answer_blocks(answer), {}
    )
    assert valid == [] and errors


def test_exact_blocks_keep_whitespace():
    answer = "a\n\n😀 b\nend"
    blocks = answer_blocks(answer)
    assert "".join(b["text"] for b in blocks.values()) == answer
    for block in blocks.values():
        assert answer[block["start"] : block["start"] + len(block["text"])] == block["text"]
