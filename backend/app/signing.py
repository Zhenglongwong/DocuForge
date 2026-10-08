import hashlib
import hmac
import json
import os
import secrets
from pathlib import Path

# AI drafts round-trip through the browser before being saved or submitted. Signing the AI output lets the
# server confirm it is unaltered, so the "manually edited" flag is computed rather than trusted from the client.
_KEY_FILE = Path(__file__).resolve().parent.parent / ".docuforge_secret"

def _load_key() -> bytes:
    env_key = os.getenv("DOCUFORGE_SECRET_KEY")
    if env_key:
        return env_key.encode()
    if not _KEY_FILE.exists():
        _KEY_FILE.write_text(secrets.token_hex(32))
        _KEY_FILE.chmod(0o600)
    return _KEY_FILE.read_text().strip().encode()

_KEY = _load_key()

def _payload(document_id: int, original_content: str, ai_proposed_content: str, ai_summary: str, ai_fallback: bool) -> bytes:
    return json.dumps([document_id, original_content, ai_proposed_content, ai_summary, ai_fallback], ensure_ascii=False).encode()

def sign_ai_output(document_id: int, original_content: str, ai_proposed_content: str, ai_summary: str, ai_fallback: bool) -> str:
    return hmac.new(_KEY, _payload(document_id, original_content, ai_proposed_content, ai_summary, ai_fallback), hashlib.sha256).hexdigest()

def verify_ai_output(document_id: int, original_content: str, ai_proposed_content: str, ai_summary: str, ai_fallback: bool, signature: str) -> bool:
    expected = sign_ai_output(document_id, original_content, ai_proposed_content, ai_summary, ai_fallback)
    return hmac.compare_digest(expected, signature or "")
