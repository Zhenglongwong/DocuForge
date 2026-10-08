import difflib
from datetime import datetime
from typing import List, Dict, Any, Literal, Optional
from pydantic import BaseModel
from .models import UserRole, RequestStatus, DraftStatus

class ProjectCreate(BaseModel):
    username: str

class ProjectResponse(BaseModel):
    id: int
    name: str
    created_by: Optional[str] = None
    created_at: Optional[datetime] = None
    document_count: int

class DocumentCreate(BaseModel):
    project_id: Optional[int] = None  # Defaults to the original ServiceNow Project
    service: str = "ServiceNow"
    category: str
    doc_type: str
    title: str
    content: str

class DocumentResponse(BaseModel):
    id: int
    project_id: Optional[int] = None
    service: str
    category: str
    doc_type: str
    title: str
    current_content: str
    version: int

    class Config:
        from_attributes = True

class ChangeRequestCreate(BaseModel):
    prompt: str
    username: str

class GlobalChangeRequestCreate(BaseModel):
    prompt: str
    username: str
    project_id: int  # The LLM only considers documents inside this project
    target_service: Optional[str] = None
    target_categories: Optional[List[str]] = None  # None/empty = every category in the project
    target_document_id: Optional[int] = None  # Set = skip multi-document discovery and change only this document
    reference_document_id: Optional[int] = None  # Read-only document the AI should base its recommendations on
    reference_mode: Literal["full", "latest_release"] = "full"  # Whole reference document, or only its latest release
    # Documents the user picked by hand; always updated, in addition to what AI discovery finds in the categories
    include_document_ids: List[int] = []
    ai_discovery: bool = True  # False = update only include_document_ids, without asking the AI to find more

def format_request_id(change_request_id: int) -> str:
    """Human-readable request ID shown to requesters and reviewers, e.g. REQ-00012."""
    return f"REQ-{change_request_id:05d}"

class ChangeRequestResponse(BaseModel):
    id: int
    request_id: str
    batch_id: Optional[str] = None
    document_id: int
    project_id: Optional[int] = None
    project_name: Optional[str] = None
    service: Optional[str] = None
    category: Optional[str] = None
    doc_type: Optional[str] = None
    doc_title: Optional[str] = None
    requested_by: str
    prompt: str
    relevance_rationale: Optional[str] = None
    target_section: Optional[str] = None
    original_content: str
    proposed_content: str
    ai_summary: Optional[str] = None
    manually_edited: bool = False
    ai_fallback: bool = False
    reference_label: Optional[str] = None
    refinements: List[str] = []
    draft_id: Optional[int] = None  # Requester's draft reopened from this request after rejection
    # Lifecycle stage for display/visualisation: "Requested Approval", "Approved", "Published", "Rejected", "Withdrawn"
    stage: str = "Requested Approval"
    reviewed_at: Optional[datetime] = None
    published_by: Optional[str] = None
    published_at: Optional[datetime] = None
    published_version: Optional[int] = None
    is_stale: bool = False  # Pending, but the document changed since the proposal was generated
    status: RequestStatus
    reviewed_by: Optional[str] = None
    rejection_reason: Optional[str] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    class Config:
        from_attributes = True

class AuditLogResponse(BaseModel):
    id: int
    document_id: int
    change_request_id: Optional[int] = None
    request_id: Optional[str] = None
    actor: str
    action: str
    version_after: int
    summary: str
    created_at: Optional[datetime] = None

class LatestReleaseResponse(BaseModel):
    document_id: int
    version: int
    request_id: str
    published_at: Optional[datetime] = None

class ReleaseResponse(BaseModel):
    """A published change that produced a new document version."""
    change_request_id: int
    request_id: str
    document_id: int
    project_id: Optional[int] = None
    project_name: Optional[str] = None
    category: str
    doc_type: str
    doc_title: str
    version: int  # Version produced by this change
    current_version: int
    requested_by: str
    approved_by: Optional[str] = None
    approved_at: Optional[datetime] = None
    published_by: Optional[str] = None
    published_at: Optional[datetime] = None
    prompt: str
    ai_summary: Optional[str] = None
    manually_edited: bool = False

class DiffLine(BaseModel):
    type: str  # "added", "removed", "unchanged"
    text: str

class DiffResponse(BaseModel):
    diff_lines: List[DiffLine]
    unified_diff: str

class DraftPatchItem(BaseModel):
    document_id: int
    service: str
    category: str
    doc_type: str
    doc_title: str
    relevance_rationale: str
    target_section: Optional[str] = None
    original_content: str
    proposed_content: str
    ai_summary: str
    diff_lines: List[DiffLine]
    manually_edited: bool = False  # Display hint only; the server recomputes it from the signed AI output
    ai_proposed_content: Optional[str] = None  # Unmodified AI output
    ai_signature: Optional[str] = None  # Server signature over the AI output (see signing.py)
    base_version: Optional[int] = None  # Document version the draft was generated against
    ai_fallback: bool = False  # AI was unavailable; this is a placeholder patch (covered by ai_signature)
    reference_document_id: Optional[int] = None  # Reference used to generate this draft (kept for regenerate)
    reference_mode: Optional[str] = None
    reference_label: Optional[str] = None
    refinements: List[str] = []  # Follow-up instructions applied after the initial prompt, in order
    selected_by: Optional[Literal["ai", "manual", "both", "single"]] = None  # How this document was chosen

class ScannedDocument(BaseModel):
    document_id: int
    doc_title: str
    category: str
    doc_type: str

class GenerateDraftsResponse(BaseModel):
    draft_session_id: str
    prompt: str
    requested_by: str
    ai_discovery_analysis: str
    drafts: List[DraftPatchItem]
    scanned_documents: List[ScannedDocument] = []  # Documents the AI could choose from (the request's scope)
    manual_documents: List[ScannedDocument] = []  # Documents the user added by hand
    scope_categories: Optional[List[str]] = None  # None = all categories in the project
    discovery_source: str = "ai"  # "ai", "heuristic" (AI unavailable) or "single" (single-document mode)
    reference_label: Optional[str] = None

class SubmitApprovalRequest(BaseModel):
    draft_session_id: str
    username: str
    prompt: str
    drafts: List[DraftPatchItem]

class BatchChangeProposalResponse(BaseModel):
    batch_id: str
    prompt: str
    requested_by: str
    ai_discovery_analysis: str
    affected_services: List[str]
    total_documents_affected: int
    change_requests: List[ChangeRequestResponse]

class SaveDraftsRequest(BaseModel):
    username: str
    prompt: str
    drafts: List[DraftPatchItem]

class DraftUpdate(BaseModel):
    username: str
    proposed_content: str

class DraftAction(BaseModel):
    username: str

class RefineDraftRequest(BaseModel):
    """Follow-up instruction for an unsaved draft; `item` must carry the server's signature."""
    username: str
    prompt: str  # The session's original request
    item: DraftPatchItem
    instruction: str

class RefineSavedDraftRequest(BaseModel):
    username: str
    instruction: str

class SavedDraftResponse(BaseModel):
    id: int
    document_id: int
    project_id: Optional[int] = None
    service: str
    category: str
    doc_type: str
    doc_title: str
    owner: str
    prompt: str
    relevance_rationale: Optional[str] = None
    target_section: Optional[str] = None
    ai_summary: Optional[str] = None
    original_content: str
    proposed_content: str
    diff_lines: List[DiffLine]
    manually_edited: bool
    ai_fallback: bool = False
    reference_label: Optional[str] = None
    refinements: List[str] = []
    base_version: int
    current_version: int
    is_stale: bool  # The document changed since generation; must regenerate before submitting
    status: DraftStatus
    last_request_id: Optional[str] = None
    last_rejection_reason: Optional[str] = None
    last_reviewed_by: Optional[str] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

class ApprovalDecision(BaseModel):
    username: str
    decision: str  # "approve" or "reject"
    rejection_reason: Optional[str] = None

def compute_diff(original: str, proposed: str) -> DiffResponse:
    orig_lines = original.splitlines()
    prop_lines = proposed.splitlines()

    unified = list(difflib.unified_diff(
        orig_lines, prop_lines,
        fromfile="Original (Current Version)",
        tofile="AI Proposed Update",
        lineterm=""
    ))

    diff_lines = []
    matcher = difflib.SequenceMatcher(None, orig_lines, prop_lines)
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == 'equal':
            for line in orig_lines[i1:i2]:
                diff_lines.append(DiffLine(type="unchanged", text=line))
        elif tag == 'delete':
            for line in orig_lines[i1:i2]:
                diff_lines.append(DiffLine(type="removed", text=line))
        elif tag == 'insert':
            for line in prop_lines[j1:j2]:
                diff_lines.append(DiffLine(type="added", text=line))
        elif tag == 'replace':
            for line in orig_lines[i1:i2]:
                diff_lines.append(DiffLine(type="removed", text=line))
            for line in prop_lines[j1:j2]:
                diff_lines.append(DiffLine(type="added", text=line))

    return DiffResponse(diff_lines=diff_lines, unified_diff="\n".join(unified))
