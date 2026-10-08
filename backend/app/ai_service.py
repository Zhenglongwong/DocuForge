import json
import re
import logging
import os
import httpx
from typing import Dict, Any, List, Optional

logger = logging.getLogger("ai_service")
logging.basicConfig(level=logging.INFO)

OLLAMA_BASE_URL = os.getenv("OLLAMA_BASE_URL", "http://127.0.0.1:11434")
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "llama3.2")
# Ollama's default 4096-token window is tight once a reference document is added; llama3.2 supports far more
OLLAMA_NUM_CTX = int(os.getenv("OLLAMA_NUM_CTX", "8192"))  # Can be granite3-dense, qwen2.5, mistral, llama3.2

DISCOVERY_SYSTEM_PROMPT = """You are an expert Enterprise Technical Documentation Architect.
Your task is to analyze a requested change from an engineer or SME and determine ALL relevant documents across services that must be updated to maintain accuracy, consistency, and completeness.

You will be given a list of all documents in the catalog (ID, Service, Document Type, Title, and an excerpt/outline of their content).

Carefully determine which documents are affected by the change. For example:
- An API endpoint change or timeout tweak might affect both the "API Reference Spec", the "Troubleshooting Guide", and the "Incident Response Runbook".
- An infrastructure or secret rotation change might affect both "Security Policies" and "Deployment/Architecture Specs".

Return a STRICT JSON object in this format:
{
  "analysis": "Brief 1-2 sentence overview of why these documents were chosen",
  "relevant_documents": [
    {
      "document_id": 1,
      "relevance_rationale": "Clear reason why this specific doc needs updating based on the prompt",
      "suggested_update_focus": "What specifically should be updated in this doc"
    }
  ]
}

If REFERENCE MATERIAL is provided, use it together with the requested change to decide which documents must be brought in line with it.
If only 1 document is relevant, return only that 1. If multiple are relevant, return all of them. Output STRICT JSON only.
"""

PATCH_SYSTEM_PROMPT = """You are an expert technical documentation maintenance AI.
Your role is to update a technical document (runbook, architecture spec, troubleshooting guide, API spec) based on requested user changes and the specific focus for this document.

Guidelines:
1. Preserve existing structure, markdown formatting, headings, quotes and code blocks unless specifically asked to alter them.
2. Only make changes relevant to the user's prompt and document focus.
   If REFERENCE MATERIAL is provided, treat it as the source of truth: align this document with it where relevant,
   but never copy unrelated content from it.
3. Be precise, concise, and technically accurate.

Respond in EXACTLY this format and nothing else:
SUMMARY:
- <one bullet per change applied and why>
SECTION: <main section heading affected>
<<<DOCUMENT>>>
<the complete updated markdown document: every line, including unchanged ones; no code fence around it>
<<<END_DOCUMENT>>>
"""

def _reference_block(reference_context: Optional[str]) -> str:
    """Read-only material the user asked the AI to base its recommendations on."""
    if not reference_context:
        return ""
    return f"""REFERENCE MATERIAL (read-only source of truth; do not modify it, use it to inform the change):
{reference_context}

"""

async def discover_relevant_documents(
    documents: List[Dict[str, Any]],
    change_prompt: str,
    target_service: Optional[str] = None,
    target_categories: Optional[List[str]] = None,
    reference_context: Optional[str] = None
) -> Dict[str, Any]:
    """
    Scans across all documents in the catalog to identify which ones need updates based on the user's change request.
    """
    catalog_summary = []
    for doc in documents:
        excerpt = doc["current_content"][:350].replace("\n", " ")
        catalog_summary.append(
            f"- [Doc ID {doc['id']}] Category: '{doc.get('category')}' | Doc Type: '{doc['doc_type']}' | Title: '{doc['title']}' | Excerpt: {excerpt}..."
        )
    catalog_str = "\n".join(catalog_summary)

    scope_note = ""
    if target_categories:
        scope_note += f" (Scope limited to categories: {', '.join(target_categories)})"
    if target_service and target_service != "all":
        scope_note += f" (Focus requested on service: {target_service})"

    user_prompt = f"""DOCUMENT CATALOG:
{catalog_str}

{_reference_block(reference_context)}USER REQUESTED CHANGE{scope_note}:
"{change_prompt}"

Determine all documents from the catalog that are relevant and should be updated. Return strictly formatted JSON.
"""

    payload = {
        "model": OLLAMA_MODEL,
        "messages": [
            {"role": "system", "content": DISCOVERY_SYSTEM_PROMPT},
            {"role": "user", "content": user_prompt}
        ],
        "format": "json",
        "stream": False,
        "options": {"temperature": 0.1, "num_ctx": OLLAMA_NUM_CTX}
    }

    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(f"{OLLAMA_BASE_URL}/api/chat", json=payload)
            if resp.status_code != 200:
                logger.warning(f"Ollama discovery returned HTTP {resp.status_code}: {resp.text[:200]}. Using keyword heuristic.")
            else:
                data = resp.json()
                raw_response = data.get("message", {}).get("content", "{}")
                parsed = json.loads(raw_response)
                
                rel_docs = parsed.get("relevant_documents", [])
                # Ensure valid doc IDs
                valid_doc_ids = {d["id"] for d in documents}
                cleaned_rel_docs = []
                for item in rel_docs:
                    doc_id = item.get("document_id")
                    if isinstance(doc_id, int) and doc_id in valid_doc_ids:
                        cleaned_rel_docs.append({
                            "document_id": doc_id,
                            "relevance_rationale": str(item.get("relevance_rationale", "Identified by AI as relevant to the requested change.")),
                            "suggested_update_focus": str(item.get("suggested_update_focus", change_prompt))
                        })

                if cleaned_rel_docs:
                    return {
                        "analysis": parsed.get("analysis", "AI identified relevant documents needing synchronized updates."),
                        "relevant_documents": cleaned_rel_docs,
                        "source": "ai"
                    }
                logger.warning(f"Ollama discovery returned no valid documents ({raw_response[:200]}). Using keyword heuristic.")
    except Exception as e:
        logger.warning(f"Ollama discovery inference failed ({e}). Using smart heuristic matcher.")

    # Graceful fallback: Smart keyword heuristic
    return _smart_fallback_discovery(documents, change_prompt, target_service, target_categories)

def _smart_fallback_discovery(
    documents: List[Dict[str, Any]],
    change_prompt: str,
    target_service: Optional[str] = None,
    target_categories: Optional[List[str]] = None
) -> Dict[str, Any]:
    """Smart heuristic scanner to discover relevant documents when Ollama is offline/busy."""
    tokens = set(change_prompt.lower().replace(",", "").replace(".", "").split())
    matches = []
    allowed_categories = {c.lower() for c in target_categories} if target_categories else None

    for doc in documents:
        if allowed_categories and doc.get("category", "").lower() not in allowed_categories:
            continue
        if target_service and target_service != "all" and doc["service"].lower() != target_service.lower():
            continue

        doc_text = f"{doc['service']} {doc.get('category', '')} {doc['doc_type']} {doc['title']} {doc['current_content'][:500]}".lower()
        score = sum(1 for t in tokens if len(t) > 3 and t in doc_text)
        
        if score > 0 or len(documents) <= 2:
            matches.append({
                "document_id": doc["id"],
                "relevance_rationale": f"Matched operational concepts related to '{change_prompt[:60]}...'",
                "suggested_update_focus": change_prompt
            })

    if not matches and documents:
        # Default to first document if no specific keyword match
        matches.append({
            "document_id": documents[0]["id"],
            "relevance_rationale": "Primary service document for requested update.",
            "suggested_update_focus": change_prompt
        })

    return {
        "analysis": f"AI unavailable: keyword matching identified {len(matches)} relevant document(s).",
        "relevant_documents": matches,
        "source": "heuristic"
    }

# The document is returned between markers rather than inside JSON: small models do not reliably escape quotes in
# long JSON strings, which silently truncated documents at the first double quote.
# End marker matched leniently: the model sometimes writes it with a missing bracket or slash, e.g. "<<<END_DOCUMENT>>"
_DOCUMENT_RE = re.compile(r"<<<\s*DOCUMENT\s*>>>[ \t]*\n(.*?)(?:\n[ \t]*<+\s*/?\s*END_DOCUMENT\s*>*|\Z)", re.S)
_FENCE_RE = re.compile(r"```(?:markdown|md)?\s*")
# A proposal much shorter than the original is almost certainly truncated output, not an intended rewrite
_MIN_LENGTH_RATIO = 0.5

def _restore_dropped_tail(original: str, proposed: str) -> tuple[str, int]:
    """
    Small models sometimes stop right after their edit and omit the document's last sections. If trailing sections
    are missing entirely (heading and body), append them from the original. Returns (content, restored line count).
    A renamed heading does not trigger this, because its body lines are still present.
    """
    orig_lines = original.rstrip("\n").split("\n")
    prop_lines = {line.strip() for line in proposed.split("\n") if line.strip()}
    headings = [i for i, line in enumerate(orig_lines) if line.startswith("#")]
    present = [i for i in headings if orig_lines[i].strip() in prop_lines]
    if not present:
        return proposed, 0
    missing_tail = [i for i in headings if i > present[-1]]
    if not missing_tail:
        return proposed, 0
    first_missing = missing_tail[0]
    tail_body = [line.strip() for line in orig_lines[first_missing + 1:] if line.strip() and not line.startswith("#")]
    if any(line in prop_lines for line in tail_body) or any(orig_lines[i].strip() in prop_lines for i in missing_tail):
        return proposed, 0  # Some of the tail survived, so this is a deliberate edit rather than an early stop
    tail = orig_lines[first_missing:]
    return proposed.rstrip("\n") + "\n\n" + "\n".join(tail) + "\n", len(tail)

def _parse_patch_response(raw: str) -> Optional[Dict[str, str]]:
    match = _DOCUMENT_RE.search(raw)
    if not match:
        return None
    document = match.group(1).rstrip()
    lines = document.split("\n")
    if len(lines) > 2 and _FENCE_RE.fullmatch(lines[0]) and lines[-1].strip() == "```":
        document = "\n".join(lines[1:-1])  # Model wrapped the whole document in a code fence
    header = raw[:match.start()]
    summary_match = re.search(r"SUMMARY:\s*\n(.*?)(?:\nSECTION:|\Z)", header, re.S)
    section_match = re.search(r"SECTION:\s*(.+)", header)
    bullets = [line.strip().lstrip("-*• ").strip() for line in (summary_match.group(1).splitlines() if summary_match else [])]
    bullets = [b for b in bullets if b]
    return {
        "proposed_content": document.strip() + "\n",
        "ai_summary": "\n".join(f"• {b}" for b in bullets) or "Applied requested changes via local Ollama LLM.",
        "target_section": section_match.group(1).strip() if section_match else "General",
    }

async def generate_document_patch(
    current_content: str,
    change_prompt: str,
    doc_title: str = "",
    update_focus: Optional[str] = None,
    reference_context: Optional[str] = None,
    prior_instructions: Optional[List[str]] = None
) -> Dict[str, Any]:
    """
    Generates a targeted, formatted patch for an individual document. For follow-up prompts, `current_content` is
    the draft so far and `prior_instructions` lists the requests it already reflects.
    """
    focus_str = f"SPECIFIC UPDATE FOCUS FOR THIS DOCUMENT ({doc_title}):\n{update_focus}\n\n" if update_focus else ""
    prior_str = (
        "EARLIER INSTRUCTIONS (already applied to the document above; keep those changes):\n"
        + "\n".join(f"- {p}" for p in prior_instructions) + "\n\n"
    ) if prior_instructions else ""

    user_prompt = f"""CURRENT DOCUMENT:
<<<DOCUMENT>>>
{current_content}
<<<END_DOCUMENT>>>

{_reference_block(reference_context)}{prior_str}REQUESTED CHANGES:
{change_prompt}

{focus_str}Produce the summary, section and complete updated document in the required format.
"""

    payload = {
        "model": OLLAMA_MODEL,
        "messages": [
            {"role": "system", "content": PATCH_SYSTEM_PROMPT},
            {"role": "user", "content": user_prompt}
        ],
        "stream": False,
        "options": {"temperature": 0.2, "num_ctx": OLLAMA_NUM_CTX}
    }

    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            resp = await client.post(f"{OLLAMA_BASE_URL}/api/chat", json=payload)
            if resp.status_code != 200:
                logger.warning(f"Ollama patch for '{doc_title}' returned HTTP {resp.status_code}: {resp.text[:200]}. Using placeholder patch.")
            else:
                raw_response = resp.json().get("message", {}).get("content", "")
                parsed = _parse_patch_response(raw_response)
                if not parsed:
                    logger.warning(f"Ollama patch for '{doc_title}' was not in the expected format ({raw_response[:200]!r}). Using placeholder patch.")
                elif len(parsed["proposed_content"]) < _MIN_LENGTH_RATIO * len(current_content):
                    logger.warning(
                        f"Ollama patch for '{doc_title}' looks truncated ({len(parsed['proposed_content'])} of "
                        f"{len(current_content)} chars). Using placeholder patch."
                    )
                else:
                    content, restored = _restore_dropped_tail(current_content, parsed["proposed_content"])
                    if restored:
                        logger.warning(f"Ollama patch for '{doc_title}' omitted the final section(s); restored {restored} unchanged lines.")
                        parsed["proposed_content"] = content
                        parsed["ai_summary"] += f"\n• Restored {restored} unchanged trailing line(s) the AI omitted from the end of the document"
                    return {**parsed, "ai_fallback": False}
    except Exception as e:
        logger.warning(f"Ollama patch for '{doc_title}' failed ({e!r}). Using placeholder patch.")

    return _smart_fallback_patch(current_content, change_prompt)

def _smart_fallback_patch(current_content: str, change_prompt: str) -> Dict[str, Any]:
    """Placeholder patch used when the AI is unavailable: records the request; it does not apply it."""
    appended_section = f"\n\n## Pending Update (placeholder: AI unavailable)\n- **Change Request:** {change_prompt}\n- **Status:** Not yet applied to the sections above. Edit this draft manually or regenerate it.\n"
    
    lines = current_content.splitlines()
    updated_lines = []
    applied = False
    
    for line in lines:
        updated_lines.append(line)
        if any(h in line for h in ["Incident Response Steps", "Action Plan", "Execution Steps", "Configuration"]) and not applied:
            updated_lines.append(f"<!-- Pending update (placeholder: AI unavailable): {change_prompt} -->")
            applied = True

    new_content = "\n".join(updated_lines) if applied else current_content + appended_section

    return {
        "proposed_content": new_content,
        "ai_summary": f"Placeholder only: the AI model was unavailable, so the request '{change_prompt}' was recorded but not applied. Edit this draft manually or regenerate it.",
        "target_section": "Operational Notes & Synchronized Updates",
        "ai_fallback": True
    }
