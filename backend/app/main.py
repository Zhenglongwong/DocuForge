import json
import logging
from datetime import datetime, timezone
from typing import List, Optional
from fastapi import FastAPI, Depends, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from sqlalchemy.orm import Session

from .database import get_db, init_db, seed_project_documents, DEFAULT_PROJECT_NAME
from .models import Project, Document, ChangeRequest, AuditLog, User, UserRole, RequestStatus, Draft, DraftStatus
import uuid
from .schemas import (
    ProjectCreate, ProjectResponse, ScannedDocument,
    DocumentCreate, DocumentResponse,
    ChangeRequestCreate, GlobalChangeRequestCreate,
    DraftPatchItem, GenerateDraftsResponse, SubmitApprovalRequest,
    ChangeRequestResponse, BatchChangeProposalResponse,
    ApprovalDecision, DiffResponse, AuditLogResponse, compute_diff, format_request_id,
    SaveDraftsRequest, DraftUpdate, DraftAction, SavedDraftResponse, ReleaseResponse, LatestReleaseResponse,
    RefineDraftRequest, RefineSavedDraftRequest
)
from .signing import sign_ai_output, verify_ai_output
from .ai_service import discover_relevant_documents, generate_document_patch

logger = logging.getLogger("docuforge")

app = FastAPI(
    title="Intelligent Documentation Platform API",
    description="Automated AI document updates with RBAC, versioning, and change logging.",
    version="1.0.0"
)

# Enable CORS for local Next.js frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.on_event("startup")
def on_startup():
    init_db()

@app.get("/healthz")
def health_check():
    return {"status": "ok", "service": "intelligent-docs-api"}

def _as_utc(value: Optional[datetime]) -> Optional[datetime]:
    # SQLite drops tzinfo; stored values are UTC, so re-attach it for correct client-side rendering
    if value is not None and value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value

def _load_list(value: Optional[str]) -> List[str]:
    return json.loads(value) if value else []

def _dump_list(values: Optional[List[str]]) -> Optional[str]:
    return json.dumps(values) if values else None

def _all_instructions(prompt: str, refinements: List[str]) -> str:
    """The initial request plus follow-ups, as one instruction for a full regeneration."""
    if not refinements:
        return prompt
    return prompt + "\n\nFollow-up instructions:\n" + "\n".join(f"{i}. {r}" for i, r in enumerate(refinements, 1))

# Display names for request statuses, used as lifecycle stages (with "Draft" for saved drafts)
STAGE_LABELS = {
    RequestStatus.PENDING: "Requested Approval",
    RequestStatus.APPROVED: "Approved",
    RequestStatus.PUBLISHED: "Published",
    RequestStatus.REJECTED: "Rejected",
    RequestStatus.WITHDRAWN: "Withdrawn",
}

def _to_change_request_response(req: ChangeRequest, doc: Document) -> ChangeRequestResponse:
    return ChangeRequestResponse(
        id=req.id,
        request_id=format_request_id(req.id),
        batch_id=req.batch_id,
        document_id=doc.id,
        project_id=doc.project_id,
        project_name=doc.project.name if doc.project else None,
        service=doc.service,
        category=doc.category,
        doc_type=doc.doc_type,
        doc_title=doc.title,
        requested_by=req.requested_by,
        prompt=req.prompt,
        relevance_rationale=req.relevance_rationale,
        target_section=req.target_section,
        original_content=req.original_content,
        proposed_content=req.proposed_content,
        ai_summary=req.ai_summary,
        manually_edited=bool(req.manually_edited),
        ai_fallback=bool(req.ai_fallback),
        reference_label=req.reference_label,
        refinements=_load_list(req.refinements),
        draft_id=next((d.id for d in doc.drafts if d.change_request_id == req.id and d.status == DraftStatus.DRAFT), None),
        stage=STAGE_LABELS[req.status],
        reviewed_at=_as_utc(req.reviewed_at),
        published_by=req.published_by,
        published_at=_as_utc(req.published_at),
        published_version=req.published_version,
        # Not yet applied, but the document changed underneath it: approving/publishing would overwrite newer changes
        is_stale=req.status in (RequestStatus.PENDING, RequestStatus.APPROVED) and req.original_content != doc.current_content,
        status=req.status,
        reviewed_by=req.reviewed_by,
        rejection_reason=req.rejection_reason,
        created_at=_as_utc(req.created_at),
        updated_at=_as_utc(req.updated_at)
    )

# --- USERS & RBAC ---
@app.get("/api/users")
def list_users(db: Session = Depends(get_db)):
    return db.query(User).all()

def _scoped_documents(db: Session, project_id: int, categories: Optional[List[str]] = None) -> List[Document]:
    """Documents the AI may consider: those in the project, optionally limited to a subset of categories."""
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    query = db.query(Document).filter(Document.project_id == project_id)
    if categories:
        query = query.filter(Document.category.in_(categories))
    docs = query.all()
    if not docs:
        scope = f" in categories {', '.join(categories)}" if categories else ""
        raise HTTPException(status_code=400, detail=f"Project '{project.name}' has no documents{scope}.")
    return docs

# --- REFERENCE DOCUMENTS (read-only context for the AI) ---
def _latest_release(db: Session, doc: Document) -> Optional[ChangeRequest]:
    """The most recently published change to `doc`, if any."""
    return (
        db.query(ChangeRequest)
        .filter(ChangeRequest.document_id == doc.id, ChangeRequest.status == RequestStatus.PUBLISHED)
        .order_by(ChangeRequest.published_at.desc(), ChangeRequest.id.desc())
        .first()
    )

def _build_reference(db: Session, document_id: int, mode: str) -> tuple[str, str]:
    """Returns (label, context) for a reference document: the whole document, or only its latest release."""
    doc = db.query(Document).filter(Document.id == document_id).first()
    if not doc:
        raise HTTPException(status_code=404, detail="Reference document not found")
    if mode == "latest_release":
        release = _latest_release(db, doc)
        if not release:
            raise HTTPException(status_code=400, detail=f"'{doc.title}' has no releases yet. Reference the full document instead.")
        req = release
        request_id = format_request_id(req.id)
        label = f"{doc.title} (latest release v{req.published_version}, {request_id})"
        context = (
            f"Latest release of '{doc.title}' ({doc.doc_type}): v{req.published_version - 1} -> v{req.published_version}, {request_id}.\n"
            f"Change that was requested: {req.prompt}\n"
            f"Summary: {req.ai_summary or 'n/a'}\n"
            f"Exact changes in this release (unified diff):\n"
            f"{compute_diff(req.original_content, req.proposed_content).unified_diff}"
        )
        return label, context
    label = f"{doc.title} (full document, v{doc.version})"
    context = f"'{doc.title}' ({doc.doc_type}), version {doc.version}:\n{doc.current_content}"
    return label, context

def _reference_label(db: Session, document_id: Optional[int], mode: Optional[str]) -> Optional[str]:
    """Label for a reference recorded on a draft or request; None if there is none or it no longer exists."""
    if document_id is None:
        return None
    try:
        return _build_reference(db, document_id, mode or "full")[0]
    except HTTPException:
        return None

@app.get("/api/documents/{doc_id}/latest-release", response_model=Optional[LatestReleaseResponse])
def get_latest_release(doc_id: int, db: Session = Depends(get_db)):
    doc = db.query(Document).filter(Document.id == doc_id).first()
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")
    release = _latest_release(db, doc)
    if not release:
        return None
    return LatestReleaseResponse(
        document_id=doc.id, version=release.published_version, request_id=format_request_id(release.id),
        published_at=_as_utc(release.published_at)
    )

async def _discover_targets(db: Session, req_in: GlobalChangeRequestCreate) -> tuple[List[Document], dict]:
    """
    Returns the documents the AI may change and which of them to patch: either AI discovery across the
    project/category scope, or exactly one document when single-document mode is requested.
    """
    reference_label, reference_context = (
        _build_reference(db, req_in.reference_document_id, req_in.reference_mode)
        if req_in.reference_document_id is not None else (None, None)
    )
    reference_info = {"reference_label": reference_label, "reference_context": reference_context}

    if req_in.target_document_id is not None:
        if req_in.target_document_id == req_in.reference_document_id:
            raise HTTPException(status_code=400, detail="A document cannot be used as a reference for changes to itself.")
        doc = next((d for d in _scoped_documents(db, req_in.project_id) if d.id == req_in.target_document_id), None)
        if not doc:
            raise HTTPException(status_code=404, detail="Document not found in this project")
        logger.info(
            f"Generate drafts by {req_in.username}: project={req_in.project_id} single-document={doc.id} ('{doc.title}') "
            f"reference={reference_label or 'none'}"
        )
        return [doc], {
            **reference_info,
            "source": "single",
            "analysis": f"Single-document mode: changes restricted to '{doc.title}' (multi-document discovery skipped).",
            "relevant_documents": [{
                "document_id": doc.id,
                "relevance_rationale": "Change requested directly on this document",
                "suggested_update_focus": req_in.prompt,
                "selected_by": "single"
            }]
        }

    # The reference is read-only context, so it is never a candidate for changes itself
    project_docs = {d.id: d for d in _scoped_documents(db, req_in.project_id)}
    manual_ids = list(dict.fromkeys(req_in.include_document_ids))  # De-duplicated, in the order picked
    unknown = [i for i in manual_ids if i not in project_docs]
    if unknown:
        raise HTTPException(status_code=404, detail=f"Selected documents not found in this project: {unknown}")
    if req_in.reference_document_id in manual_ids:
        raise HTTPException(status_code=400, detail="The reference document cannot also be selected for changes.")
    manual_docs = [project_docs[i] for i in manual_ids]

    # Documents the AI searches: the selected categories, minus the reference and anything already picked by hand
    scope_docs = []
    if req_in.ai_discovery:
        scope_docs = [
            d for d in _scoped_documents(db, req_in.project_id, req_in.target_categories)
            if d.id != req_in.reference_document_id
        ]
    if not scope_docs and not manual_docs:
        raise HTTPException(
            status_code=400,
            detail="No documents to update: select documents manually or turn on AI discovery with categories that contain documents."
        )

    discovery: dict = {"analysis": "", "relevant_documents": [], "source": "manual"}
    if scope_docs:
        doc_dicts = [
            {
                "id": d.id,
                "service": d.service,
                "category": d.category,
                "doc_type": d.doc_type,
                "title": d.title,
                "current_content": d.current_content
            }
            for d in scope_docs
        ]
        # AI discovery
        discovery = await discover_relevant_documents(
            documents=doc_dicts,
            change_prompt=req_in.prompt,
            target_service=req_in.target_service,
            target_categories=req_in.target_categories,
            reference_context=reference_context
        )
        if not discovery.get("relevant_documents") and not manual_docs:
            discovery["relevant_documents"] = [{"document_id": scope_docs[0].id, "relevance_rationale": "Direct match", "suggested_update_focus": req_in.prompt}]
    discovery.update(reference_info)

    # Union: AI-discovered documents plus manual picks (a pick the AI also found keeps the AI's rationale)
    entries = {e["document_id"]: {**e, "selected_by": "ai"} for e in discovery.get("relevant_documents", [])}
    for d in manual_docs:
        if d.id in entries:
            entries[d.id]["selected_by"] = "both"
        else:
            entries[d.id] = {
                "document_id": d.id,
                "relevance_rationale": "Selected manually for this change",
                "suggested_update_focus": req_in.prompt,
                "selected_by": "manual"
            }
    discovery["relevant_documents"] = list(entries.values())
    discovery["scanned_ids"] = [d.id for d in scope_docs]
    discovery["manual_ids"] = manual_ids
    ai_count = sum(e["selected_by"] in ("ai", "both") for e in entries.values())
    if not scope_docs:
        discovery["analysis"] = f"AI discovery off: updating the {len(manual_docs)} manually selected document(s)."
    elif manual_docs:
        discovery["analysis"] = (
            f"{discovery.get('analysis') or 'AI discovery complete.'} "
            f"AI selected {ai_count} document(s); {len(manual_docs)} added manually."
        )

    all_docs = list({d.id: d for d in [*scope_docs, *manual_docs]}.values())
    logger.info(
        f"Generate drafts by {req_in.username}: project={req_in.project_id} "
        f"categories={(req_in.target_categories or 'all') if req_in.ai_discovery else 'ai-off'} scanned={[d.id for d in scope_docs]} "
        f"manual={manual_ids} chosen={list(entries)} source={discovery.get('source', 'ai')} "
        f"reference={reference_label or 'none'}"
    )
    return all_docs, discovery

# --- PROJECTS ---
def _to_project_response(project: Project, db: Session) -> ProjectResponse:
    return ProjectResponse(
        id=project.id,
        name=project.name,
        created_by=project.created_by,
        created_at=_as_utc(project.created_at),
        document_count=db.query(Document).filter(Document.project_id == project.id).count()
    )

@app.get("/api/projects", response_model=List[ProjectResponse])
def list_projects(db: Session = Depends(get_db)):
    return [_to_project_response(p, db) for p in db.query(Project).order_by(Project.id).all()]

@app.post("/api/projects", response_model=ProjectResponse)
def create_project(body: ProjectCreate, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.username == body.username).first()
    if not user or user.role != UserRole.ADMIN:
        raise HTTPException(status_code=403, detail="Forbidden: Only administrators can create projects.")

    # New projects are numbered after the original: "ServiceNow Project v2", "v3", ...
    existing_names = {name for (name,) in db.query(Project.name).all()}
    n = len(existing_names) + 1
    while f"{DEFAULT_PROJECT_NAME} v{n}" in existing_names:
        n += 1

    project = Project(name=f"{DEFAULT_PROJECT_NAME} v{n}", created_by=body.username)
    db.add(project)
    db.commit()
    db.refresh(project)

    seed_project_documents(db, project, actor=body.username, suffix=f" v{n}")
    return _to_project_response(project, db)

@app.delete("/api/projects/{project_id}")
def delete_project(project_id: int, username: str, db: Session = Depends(get_db)):
    """Deletes a project with its documents, their change requests and audit logs (ORM cascade)."""
    user = db.query(User).filter(User.username == username).first()
    if not user or user.role != UserRole.ADMIN:
        raise HTTPException(status_code=403, detail="Forbidden: Only administrators can delete projects.")

    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    if db.query(Project).count() <= 1:
        raise HTTPException(status_code=400, detail="Cannot delete the last remaining project.")

    name = project.name
    db.delete(project)
    db.commit()
    return {"deleted_project_id": project_id, "name": name}

# --- DOCUMENTS ---
@app.get("/api/documents", response_model=List[DocumentResponse])
def get_documents(db: Session = Depends(get_db)):
    return db.query(Document).order_by(Document.updated_at.desc()).all()

@app.post("/api/documents", response_model=DocumentResponse)
def create_document(doc_in: DocumentCreate, username: str = "System Manager", db: Session = Depends(get_db)):
    if doc_in.project_id is not None:
        project = db.query(Project).filter(Project.id == doc_in.project_id).first()
        if not project:
            raise HTTPException(status_code=404, detail="Project not found")
    else:
        project = db.query(Project).order_by(Project.id).first()

    doc = Document(
        project_id=project.id,
        service=doc_in.service,
        category=doc_in.category,
        doc_type=doc_in.doc_type,
        title=doc_in.title,
        current_content=doc_in.content,
        version=1
    )
    db.add(doc)
    db.commit()
    db.refresh(doc)

    audit = AuditLog(
        document_id=doc.id,
        actor=username,
        action="DOCUMENT_CREATED",
        version_after=1,
        summary=f"Created document '{doc.title}' under service '{doc.service}'"
    )
    db.add(audit)
    db.commit()

    return doc

@app.get("/api/documents/{doc_id}", response_model=DocumentResponse)
def get_document(doc_id: int, db: Session = Depends(get_db)):
    doc = db.query(Document).filter(Document.id == doc_id).first()
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")
    return doc

# --- AI DISCOVERY & MULTI-DOCUMENT BATCH CHANGE PROPOSALS ---
@app.post("/api/generate-drafts", response_model=GenerateDraftsResponse)
async def generate_draft_patches(
    req_in: GlobalChangeRequestCreate,
    db: Session = Depends(get_db)
):
    """
    Step 1: Scans documents, uses AI to identify affected documents and generate draft patches.
    Does NOT create a reviewer request in database yet until user clicks 'Request for Approval'.
    Strictly verifies user has Editor or Admin permissions (Viewers are rejected).
    """
    # Enforce RBAC: Viewer cannot propose changes
    user = db.query(User).filter(User.username == req_in.username).first()
    if user and user.role == UserRole.VIEWER:
        raise HTTPException(
            status_code=403,
            detail="Permission Denied: User role 'viewer' has read-only access and cannot propose changes."
        )

    # Scope AI discovery and patching to the requested project (and categories, or a single document) only
    all_docs, discovery = await _discover_targets(db, req_in)
    allowed_doc_ids = {d.id for d in all_docs}
    relevant_entries = discovery["relevant_documents"]

    draft_session_id = str(uuid.uuid4())[:8]
    draft_items = []

    for item in relevant_entries:
        doc_id = item["document_id"]
        if doc_id not in allowed_doc_ids:
            continue
        doc = db.query(Document).filter(Document.id == doc_id).first()
        if not doc:
            continue

        patch_result = await generate_document_patch(
            current_content=doc.current_content,
            change_prompt=req_in.prompt,
            doc_title=f"{doc.category} - {doc.title}",
            update_focus=item.get("suggested_update_focus"),
            reference_context=discovery.get("reference_context")
        )

        proposed = patch_result.get("proposed_content", doc.current_content)
        summary = patch_result.get("ai_summary", "Updated content")
        ai_fallback = bool(patch_result.get("ai_fallback", False))
        diff_res = compute_diff(doc.current_content, proposed)

        draft_items.append(
            DraftPatchItem(
                document_id=doc.id,
                service=doc.service,
                category=doc.category,
                doc_type=doc.doc_type,
                doc_title=doc.title,
                relevance_rationale=item.get("relevance_rationale", "Affected by requested change"),
                target_section=patch_result.get("target_section"),
                original_content=doc.current_content,
                proposed_content=proposed,
                ai_summary=summary,
                diff_lines=diff_res.diff_lines,
                ai_proposed_content=proposed,
                ai_signature=sign_ai_output(doc.id, doc.current_content, proposed, summary, ai_fallback),
                base_version=doc.version,
                ai_fallback=ai_fallback,
                reference_document_id=req_in.reference_document_id,
                reference_mode=req_in.reference_mode if req_in.reference_document_id is not None else None,
                reference_label=discovery.get("reference_label"),
                selected_by=item.get("selected_by")
            )
        )

    return GenerateDraftsResponse(
        draft_session_id=draft_session_id,
        prompt=req_in.prompt,
        requested_by=req_in.username,
        ai_discovery_analysis=discovery.get("analysis", "AI identified documents needing updates."),
        drafts=draft_items,
        scanned_documents=[
            ScannedDocument(document_id=d.id, doc_title=d.title, category=d.category, doc_type=d.doc_type)
            for d in all_docs if d.id in discovery.get("scanned_ids", [d.id for d in all_docs])
        ],
        manual_documents=[
            ScannedDocument(document_id=d.id, doc_title=d.title, category=d.category, doc_type=d.doc_type)
            for d in all_docs if d.id in discovery.get("manual_ids", [])
        ],
        scope_categories=None if req_in.target_document_id is not None else (req_in.target_categories or None),
        discovery_source=discovery.get("source", "ai"),
        reference_label=discovery.get("reference_label")
    )

def _require_proposer(db: Session, username: str) -> User:
    """Editors and admins may save drafts and submit change requests; viewers may not."""
    user = db.query(User).filter(User.username == username).first()
    if not user or user.role == UserRole.VIEWER:
        raise HTTPException(status_code=403, detail="Permission Denied: Only editors and admins can save or submit drafts.")
    return user

def _verified_ai_draft(draft: DraftPatchItem) -> DraftPatchItem:
    """Rejects drafts whose AI output was not produced by this server or was altered in transit."""
    if not draft.ai_proposed_content or not verify_ai_output(
        draft.document_id, draft.original_content, draft.ai_proposed_content, draft.ai_summary, draft.ai_fallback, draft.ai_signature
    ):
        raise HTTPException(
            status_code=400,
            detail=f"Draft for '{draft.doc_title}' could not be verified as AI output from this server. Please regenerate it."
        )
    return draft

def _ensure_current(doc: Document, original_content: str) -> None:
    """A proposal replaces the whole document, so it must be based on the document's current text."""
    if original_content != doc.current_content:
        raise HTTPException(
            status_code=409,
            detail=f"'{doc.title}' has changed (now v{doc.version}) since this draft was generated. Regenerate the draft against the current version."
        )

def _create_change_request(
    db: Session, doc: Document, username: str, prompt: str, batch_id: str,
    relevance_rationale: Optional[str], target_section: Optional[str], original_content: str,
    proposed_content: str, ai_summary: Optional[str], manually_edited: bool, ai_fallback: bool = False,
    reference_label: Optional[str] = None, ai_proposed_content: Optional[str] = None, base_version: Optional[int] = None,
    reference_document_id: Optional[int] = None, reference_mode: Optional[str] = None, refinements: Optional[List[str]] = None
) -> ChangeRequest:
    change_req = ChangeRequest(
        batch_id=batch_id,
        document_id=doc.id,
        requested_by=username,
        prompt=prompt,
        category=doc.category,
        relevance_rationale=relevance_rationale,
        target_section=target_section,
        original_content=original_content,
        proposed_content=proposed_content,
        ai_summary=ai_summary,
        manually_edited=manually_edited,
        ai_fallback=ai_fallback,
        reference_label=reference_label,
        ai_proposed_content=ai_proposed_content,
        base_version=base_version,
        reference_document_id=reference_document_id,
        reference_mode=reference_mode,
        refinements=_dump_list(refinements),
        status=RequestStatus.PENDING
    )
    db.add(change_req)
    db.commit()
    db.refresh(change_req)

    # Audit log entry
    edit_note = f" [Draft manually edited by @{username} before submission]" if manually_edited else ""
    if ai_fallback:
        edit_note += " [Started from a placeholder patch: AI was unavailable]"
    audit = AuditLog(
        document_id=doc.id,
        change_request_id=change_req.id,
        actor=username,
        action="CHANGE_PROPOSED_FOR_APPROVAL",
        version_after=doc.version,
        summary=f"[{format_request_id(change_req.id)} | Batch {batch_id}] Submitted for Reviewer Approval: {relevance_rationale}{edit_note}"
    )
    db.add(audit)
    db.commit()
    return change_req

@app.post("/api/submit-approval-request", response_model=BatchChangeProposalResponse)
async def submit_approval_request(
    req_in: SubmitApprovalRequest,
    db: Session = Depends(get_db)
):
    """
    Step 2: Explicit user action clicking 'Request for Approval'.
    Persists change requests into the database for reviewer approval.
    """
    _require_proposer(db, req_in.username)

    # Validate every draft before creating any request, so a batch is all-or-nothing
    validated = []
    for draft in req_in.drafts:
        doc = db.query(Document).filter(Document.id == draft.document_id).first()
        if not doc:
            continue
        _verified_ai_draft(draft)
        _ensure_current(doc, draft.original_content)
        validated.append((draft, doc))

    batch_id = req_in.draft_session_id or str(uuid.uuid4())[:8]
    created_requests = []
    affected_services = set()

    for draft, doc in validated:
        affected_services.add(doc.service)
        change_req = _create_change_request(
            db, doc, req_in.username, req_in.prompt, batch_id,
            relevance_rationale=draft.relevance_rationale,
            target_section=draft.target_section,
            original_content=draft.original_content,
            proposed_content=draft.proposed_content,
            ai_summary=draft.ai_summary,
            manually_edited=draft.proposed_content != draft.ai_proposed_content,
            ai_fallback=draft.ai_fallback,
            # Recomputed server-side from the reference id/mode rather than trusting a client-supplied label
            reference_label=_reference_label(db, draft.reference_document_id, draft.reference_mode),
            ai_proposed_content=draft.ai_proposed_content,
            base_version=draft.base_version if draft.base_version is not None else doc.version,
            reference_document_id=draft.reference_document_id,
            reference_mode=draft.reference_mode,
            refinements=draft.refinements
        )
        created_requests.append(_to_change_request_response(change_req, doc))

    return BatchChangeProposalResponse(
        batch_id=batch_id,
        prompt=req_in.prompt,
        requested_by=req_in.username,
        ai_discovery_analysis="User submitted reviewed AI patches for reviewer approval.",
        affected_services=list(affected_services),
        total_documents_affected=len(created_requests),
        change_requests=created_requests
    )

# --- SAVED DRAFTS (owner-only; draft actions are intentionally not audited) ---
def _to_draft_response(draft: Draft) -> SavedDraftResponse:
    doc = draft.document
    last_req = draft.change_request
    return SavedDraftResponse(
        id=draft.id,
        document_id=doc.id,
        project_id=doc.project_id,
        service=doc.service,
        category=doc.category,
        doc_type=doc.doc_type,
        doc_title=doc.title,
        owner=draft.owner,
        prompt=draft.prompt,
        relevance_rationale=draft.relevance_rationale,
        target_section=draft.target_section,
        ai_summary=draft.ai_summary,
        original_content=draft.original_content,
        proposed_content=draft.proposed_content,
        diff_lines=compute_diff(draft.original_content, draft.proposed_content).diff_lines,
        manually_edited=draft.proposed_content != draft.ai_proposed_content,
        ai_fallback=bool(draft.ai_fallback),
        reference_label=draft.reference_label,
        refinements=_load_list(draft.refinements),
        base_version=draft.base_version,
        current_version=doc.version,
        is_stale=draft.original_content != doc.current_content,
        status=draft.status,
        last_request_id=format_request_id(last_req.id) if last_req else None,
        last_rejection_reason=last_req.rejection_reason if last_req and last_req.status == RequestStatus.REJECTED else None,
        last_reviewed_by=last_req.reviewed_by if last_req and last_req.status == RequestStatus.REJECTED else None,
        created_at=_as_utc(draft.created_at),
        updated_at=_as_utc(draft.updated_at)
    )

def _owned_draft(db: Session, draft_id: int, username: str, editable: bool = True) -> Draft:
    draft = db.query(Draft).filter(Draft.id == draft_id).first()
    if not draft:
        raise HTTPException(status_code=404, detail="Draft not found")
    if draft.owner != username:
        raise HTTPException(status_code=403, detail="Forbidden: Drafts can only be accessed by their owner.")
    if editable and draft.status != DraftStatus.DRAFT:
        raise HTTPException(status_code=400, detail="This draft is under review and cannot be changed.")
    return draft

@app.get("/api/drafts", response_model=List[SavedDraftResponse])
def list_drafts(username: str, project_id: Optional[int] = None, db: Session = Depends(get_db)):
    query = db.query(Draft).join(Document, Draft.document_id == Document.id).filter(
        Draft.owner == username, Draft.status == DraftStatus.DRAFT
    )
    if project_id is not None:
        query = query.filter(Document.project_id == project_id)
    return [_to_draft_response(d) for d in query.order_by(Draft.updated_at.desc()).all()]

@app.post("/api/drafts", response_model=List[SavedDraftResponse])
def save_drafts(body: SaveDraftsRequest, db: Session = Depends(get_db)):
    _require_proposer(db, body.username)

    to_save = []
    for item in body.drafts:
        doc = db.query(Document).filter(Document.id == item.document_id).first()
        if not doc:
            raise HTTPException(status_code=404, detail=f"Document {item.document_id} not found")
        _verified_ai_draft(item)
        to_save.append((item, doc))

    saved = []
    for item, doc in to_save:
        draft = Draft(
            document_id=doc.id,
            owner=body.username,
            prompt=body.prompt,
            relevance_rationale=item.relevance_rationale,
            target_section=item.target_section,
            ai_summary=item.ai_summary,
            original_content=item.original_content,
            base_version=item.base_version if item.base_version is not None else doc.version,
            ai_proposed_content=item.ai_proposed_content,
            ai_fallback=item.ai_fallback,
            reference_document_id=item.reference_document_id,
            reference_mode=item.reference_mode if item.reference_document_id is not None else None,
            reference_label=_reference_label(db, item.reference_document_id, item.reference_mode),
            refinements=_dump_list(item.refinements),
            proposed_content=item.proposed_content,
            status=DraftStatus.DRAFT
        )
        db.add(draft)
        saved.append(draft)
    db.commit()
    for draft in saved:
        db.refresh(draft)
    return [_to_draft_response(d) for d in saved]

@app.put("/api/drafts/{draft_id}", response_model=SavedDraftResponse)
def update_draft(draft_id: int, body: DraftUpdate, db: Session = Depends(get_db)):
    draft = _owned_draft(db, draft_id, body.username)
    draft.proposed_content = body.proposed_content
    db.commit()
    db.refresh(draft)
    return _to_draft_response(draft)

@app.post("/api/drafts/{draft_id}/regenerate", response_model=SavedDraftResponse)
async def regenerate_draft(draft_id: int, body: DraftAction, db: Session = Depends(get_db)):
    """Re-runs the AI patch against the document's current text, replacing the proposal (and any manual edits)."""
    draft = _owned_draft(db, draft_id, body.username)
    doc = draft.document
    # Re-read the reference so regeneration uses its current state (e.g. a newer latest release)
    reference_context = None
    if draft.reference_document_id is not None:
        try:
            draft.reference_label, reference_context = _build_reference(db, draft.reference_document_id, draft.reference_mode or "full")
        except HTTPException:
            draft.reference_label = "Reference no longer available"
    patch_result = await generate_document_patch(
        current_content=doc.current_content,
        change_prompt=_all_instructions(draft.prompt, _load_list(draft.refinements)),
        doc_title=f"{doc.category} - {doc.title}",
        update_focus=draft.relevance_rationale,
        reference_context=reference_context
    )
    proposed = patch_result.get("proposed_content", doc.current_content)
    draft.original_content = doc.current_content
    draft.base_version = doc.version
    draft.ai_proposed_content = proposed
    draft.proposed_content = proposed
    draft.ai_summary = patch_result.get("ai_summary", draft.ai_summary)
    draft.target_section = patch_result.get("target_section", draft.target_section)
    draft.ai_fallback = bool(patch_result.get("ai_fallback", False))
    db.commit()
    db.refresh(draft)
    return _to_draft_response(draft)

@app.post("/api/drafts/{draft_id}/submit", response_model=BatchChangeProposalResponse)
def submit_draft(draft_id: int, body: DraftAction, db: Session = Depends(get_db)):
    """Creates the same review request as a direct submission; the draft leaves the Drafts folder while under review."""
    _require_proposer(db, body.username)
    draft = _owned_draft(db, draft_id, body.username)
    doc = draft.document
    _ensure_current(doc, draft.original_content)

    batch_id = str(uuid.uuid4())[:8]
    change_req = _create_change_request(
        db, doc, body.username, draft.prompt, batch_id,
        relevance_rationale=draft.relevance_rationale,
        target_section=draft.target_section,
        original_content=draft.original_content,
        proposed_content=draft.proposed_content,
        ai_summary=draft.ai_summary,
        manually_edited=draft.proposed_content != draft.ai_proposed_content,
        ai_fallback=bool(draft.ai_fallback),
        reference_label=draft.reference_label,
        ai_proposed_content=draft.ai_proposed_content,
        base_version=draft.base_version,
        reference_document_id=draft.reference_document_id,
        reference_mode=draft.reference_mode,
        refinements=_load_list(draft.refinements)
    )
    draft.status = DraftStatus.SUBMITTED
    draft.change_request_id = change_req.id
    db.commit()

    return BatchChangeProposalResponse(
        batch_id=batch_id,
        prompt=draft.prompt,
        requested_by=body.username,
        ai_discovery_analysis="User submitted a saved draft for reviewer approval.",
        affected_services=[doc.service],
        total_documents_affected=1,
        change_requests=[_to_change_request_response(change_req, doc)]
    )

async def _refine_patch(
    db: Session, doc: Document, prompt: str, refinements: List[str], current_proposal: str,
    reference_document_id: Optional[int], reference_mode: Optional[str], instruction: str
) -> dict:
    """Applies a follow-up instruction to the current proposal. Raises instead of returning a placeholder, so a
    failed follow-up never overwrites the user's draft."""
    instruction = instruction.strip()
    if not instruction:
        raise HTTPException(status_code=400, detail="Enter a follow-up instruction.")
    reference_context = None
    if reference_document_id is not None:
        try:
            reference_context = _build_reference(db, reference_document_id, reference_mode or "full")[1]
        except HTTPException:
            pass  # Reference was deleted; refine without it
    result = await generate_document_patch(
        current_content=current_proposal,
        change_prompt=instruction,
        doc_title=f"{doc.category} - {doc.title}",
        reference_context=reference_context,
        prior_instructions=[prompt, *refinements]
    )
    if result.get("ai_fallback"):
        raise HTTPException(status_code=502, detail="The AI model was unavailable, so the follow-up was not applied. Your draft is unchanged; try again.")
    logger.info(f"Follow-up applied to '{doc.title}': {instruction[:120]}")
    return result

def _combined_summary(previous: Optional[str], instruction: str, new_summary: str) -> str:
    return f"{previous or ''}\nFollow-up: {instruction.strip()}\n{new_summary}".strip()

@app.post("/api/refine-draft", response_model=DraftPatchItem)
async def refine_unsaved_draft(body: RefineDraftRequest, db: Session = Depends(get_db)):
    """Follow-up prompt on a freshly generated (unsaved) draft; returns the updated, re-signed draft."""
    _require_proposer(db, body.username)
    item = _verified_ai_draft(body.item)
    doc = db.query(Document).filter(Document.id == item.document_id).first()
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")
    result = await _refine_patch(db, doc, body.prompt, item.refinements, item.proposed_content,
                                 item.reference_document_id, item.reference_mode, body.instruction)
    proposed = result["proposed_content"]
    summary = _combined_summary(item.ai_summary, body.instruction, result["ai_summary"])
    return item.model_copy(update={
        "proposed_content": proposed,
        "ai_proposed_content": proposed,
        "ai_summary": summary,
        "target_section": result.get("target_section", item.target_section),
        "diff_lines": compute_diff(item.original_content, proposed).diff_lines,
        "manually_edited": False,
        "refinements": [*item.refinements, body.instruction.strip()],
        "ai_signature": sign_ai_output(item.document_id, item.original_content, proposed, summary, item.ai_fallback),
    })

@app.post("/api/drafts/{draft_id}/refine", response_model=SavedDraftResponse)
async def refine_saved_draft(draft_id: int, body: RefineSavedDraftRequest, db: Session = Depends(get_db)):
    """Follow-up prompt on a saved draft, applied to its current proposal (including manual edits)."""
    draft = _owned_draft(db, draft_id, body.username)
    refinements = _load_list(draft.refinements)
    result = await _refine_patch(db, draft.document, draft.prompt, refinements, draft.proposed_content,
                                 draft.reference_document_id, draft.reference_mode, body.instruction)
    draft.proposed_content = result["proposed_content"]
    draft.ai_proposed_content = result["proposed_content"]
    draft.ai_summary = _combined_summary(draft.ai_summary, body.instruction, result["ai_summary"])
    draft.target_section = result.get("target_section", draft.target_section)
    draft.refinements = _dump_list([*refinements, body.instruction.strip()])
    db.commit()
    db.refresh(draft)
    return _to_draft_response(draft)

@app.delete("/api/drafts/{draft_id}")
def delete_draft(draft_id: int, username: str, db: Session = Depends(get_db)):
    draft = _owned_draft(db, draft_id, username)
    db.delete(draft)
    db.commit()
    return {"deleted_draft_id": draft_id}

# Retain backward-compatible direct propose endpoint
@app.post("/api/propose-change", response_model=BatchChangeProposalResponse)
async def propose_multi_document_change(
    req_in: GlobalChangeRequestCreate,
    db: Session = Depends(get_db)
):
    user = db.query(User).filter(User.username == req_in.username).first()
    if user and user.role == UserRole.VIEWER:
        raise HTTPException(status_code=403, detail="Permission Denied: Viewers cannot propose changes.")

    # Scope AI discovery and patching to the requested project (and categories, or a single document) only
    all_docs, discovery = await _discover_targets(db, req_in)
    allowed_doc_ids = {d.id for d in all_docs}
    relevant_entries = discovery["relevant_documents"]

    batch_id = str(uuid.uuid4())[:8]
    created_requests = []
    affected_services = set()

    for item in relevant_entries:
        doc_id = item["document_id"]
        if doc_id not in allowed_doc_ids:
            continue
        doc = db.query(Document).filter(Document.id == doc_id).first()
        if not doc:
            continue

        affected_services.add(doc.service)

        # Step 2: Generate document-specific patch
        patch_result = await generate_document_patch(
            current_content=doc.current_content,
            change_prompt=req_in.prompt,
            doc_title=f"{doc.service} - {doc.title}",
            update_focus=item.get("suggested_update_focus"),
            reference_context=discovery.get("reference_context")
        )

        change_req = ChangeRequest(
            batch_id=batch_id,
            document_id=doc.id,
            requested_by=req_in.username,
            prompt=req_in.prompt,
            category=doc.category,
            relevance_rationale=item.get("relevance_rationale"),
            target_section=patch_result.get("target_section"),
            original_content=doc.current_content,
            proposed_content=patch_result.get("proposed_content"),
            ai_summary=patch_result.get("ai_summary"),
            ai_fallback=bool(patch_result.get("ai_fallback", False)),
            reference_label=discovery.get("reference_label"),
            status=RequestStatus.PENDING
        )
        db.add(change_req)
        db.commit()
        db.refresh(change_req)

        # Audit log for proposal
        audit = AuditLog(
            document_id=doc.id,
            change_request_id=change_req.id,
            actor=req_in.username,
            action="BATCH_CHANGE_PROPOSED",
            version_after=doc.version,
            summary=f"[Batch {batch_id}] Identified via AI: {item.get('relevance_rationale')}"
        )
        db.add(audit)
        db.commit()

        created_requests.append(
            _to_change_request_response(change_req, doc)
        )

    return BatchChangeProposalResponse(
        batch_id=batch_id,
        prompt=req_in.prompt,
        requested_by=req_in.username,
        ai_discovery_analysis=discovery.get("analysis", "AI evaluated documentation across services."),
        affected_services=list(affected_services),
        total_documents_affected=len(created_requests),
        change_requests=created_requests
    )

@app.get("/api/change-requests", response_model=List[ChangeRequestResponse])
def get_all_change_requests(
    status: Optional[RequestStatus] = None,
    requested_by: Optional[str] = None,
    db: Session = Depends(get_db)
):
    query = db.query(ChangeRequest, Document).join(Document, ChangeRequest.document_id == Document.id)
    if status:
        query = query.filter(ChangeRequest.status == status)
    if requested_by:
        query = query.filter(ChangeRequest.requested_by == requested_by)
    results = query.order_by(ChangeRequest.created_at.desc()).all()

    return [_to_change_request_response(req, doc) for req, doc in results]

@app.get("/api/documents/{doc_id}/change-requests", response_model=List[ChangeRequestResponse])
def get_document_change_requests(doc_id: int, db: Session = Depends(get_db)):
    doc = db.query(Document).filter(Document.id == doc_id).first()
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")
    
    reqs = db.query(ChangeRequest).filter(ChangeRequest.document_id == doc_id).order_by(ChangeRequest.created_at.desc()).all()
    return [
        _to_change_request_response(req, doc)
        for req in reqs
    ]

class ComputeDiffRequest(BaseModel):
    original: str
    proposed: str

@app.post("/api/compute-diff", response_model=DiffResponse)
def compute_arbitrary_diff(body: ComputeDiffRequest):
    return compute_diff(body.original, body.proposed)

@app.get("/api/change-requests/{req_id}/diff", response_model=DiffResponse)
def get_change_request_diff(req_id: int, db: Session = Depends(get_db)):
    req = db.query(ChangeRequest).filter(ChangeRequest.id == req_id).first()
    if not req:
        raise HTTPException(status_code=404, detail="Change request not found")
    return compute_diff(req.original_content, req.proposed_content)

# --- APPROVAL WORKFLOW & RBAC ---
@app.post("/api/change-requests/{req_id}/review", response_model=ChangeRequestResponse)
def review_change_request(
    req_id: int,
    decision: ApprovalDecision,
    db: Session = Depends(get_db)
):
    change_req = db.query(ChangeRequest).filter(ChangeRequest.id == req_id).first()
    if not change_req:
        raise HTTPException(status_code=404, detail="Change request not found")

    user = db.query(User).filter(User.username == decision.username).first()
    if not user or user.role != UserRole.ADMIN:
        raise HTTPException(status_code=403, detail="Forbidden: Only administrators can approve or reject updates.")

    if change_req.status != RequestStatus.PENDING:
        raise HTTPException(status_code=400, detail="Change request is already reviewed.")

    if decision.decision not in ("approve", "reject"):
        raise HTTPException(status_code=400, detail="Decision must be 'approve' or 'reject'.")

    rejection_reason = (decision.rejection_reason or "").strip()
    if decision.decision == "reject" and not rejection_reason:
        raise HTTPException(status_code=400, detail="A rejection reason is required when rejecting a request.")

    request_id = format_request_id(change_req.id)

    doc = db.query(Document).filter(Document.id == change_req.document_id).first()

    linked_draft = db.query(Draft).filter(Draft.change_request_id == change_req.id).first()
    change_req.reviewed_by = decision.username
    change_req.reviewed_at = datetime.now(timezone.utc)

    if decision.decision == "approve":
        # Publishing replaces the whole document, so refuse if another change landed after this one was generated
        if change_req.original_content != doc.current_content:
            raise HTTPException(
                status_code=409,
                detail=f"Cannot approve {request_id}: '{doc.title}' has changed (now v{doc.version}) since this proposal was generated. "
                       f"Reject it so the requester can regenerate against the current version."
            )
        # Approval does not change the document: the requester publishes it from their Approved folder
        change_req.status = RequestStatus.APPROVED
        audit = AuditLog(
            document_id=doc.id,
            change_request_id=change_req.id,
            actor=decision.username,
            action="CHANGE_APPROVED",
            version_after=doc.version,
            summary=f"Approved {request_id} [Batch {change_req.batch_id or 'single'}]. Awaiting publication by @{change_req.requested_by}."
        )
        db.add(audit)
    else:
        change_req.status = RequestStatus.REJECTED
        change_req.rejection_reason = rejection_reason
        _reopen_as_draft(db, change_req, doc, linked_draft)

        audit = AuditLog(
            document_id=doc.id,
            change_request_id=change_req.id,
            actor=decision.username,
            action="CHANGE_REJECTED",
            version_after=doc.version,
            summary=f"Rejected {request_id}: {rejection_reason}"
        )
        db.add(audit)

    db.commit()
    db.refresh(change_req)

    return _to_change_request_response(change_req, doc)

def _reopen_as_draft(db: Session, change_req: ChangeRequest, doc: Document, linked_draft: Optional[Draft]) -> Draft:
    """Puts a request's proposal back in the requester's Drafts folder: the saved draft it came from, if any,
    otherwise a new draft with the same content, follow-ups and reference."""
    if linked_draft:
        linked_draft.status = DraftStatus.DRAFT
        return linked_draft
    draft = Draft(
        document_id=doc.id,
        owner=change_req.requested_by,
        prompt=change_req.prompt,
        relevance_rationale=change_req.relevance_rationale,
        target_section=change_req.target_section,
        ai_summary=change_req.ai_summary,
        original_content=change_req.original_content,
        base_version=change_req.base_version if change_req.base_version is not None else doc.version,
        ai_proposed_content=change_req.ai_proposed_content or change_req.proposed_content,
        proposed_content=change_req.proposed_content,
        ai_fallback=bool(change_req.ai_fallback),
        reference_document_id=change_req.reference_document_id,
        reference_mode=change_req.reference_mode,
        reference_label=change_req.reference_label,
        refinements=change_req.refinements,
        status=DraftStatus.DRAFT,
        change_request_id=change_req.id
    )
    db.add(draft)
    return draft

def _owned_approved_request(db: Session, req_id: int, username: str) -> tuple[ChangeRequest, Document]:
    change_req = db.query(ChangeRequest).filter(ChangeRequest.id == req_id).first()
    if not change_req:
        raise HTTPException(status_code=404, detail="Change request not found")
    if change_req.requested_by != username:
        raise HTTPException(status_code=403, detail="Forbidden: Only the requester can publish or redraft an approved change.")
    if change_req.status != RequestStatus.APPROVED:
        raise HTTPException(status_code=400, detail=f"{format_request_id(change_req.id)} is not awaiting publication (status: {change_req.status.value}).")
    return change_req, change_req.document

@app.post("/api/change-requests/{req_id}/publish", response_model=ChangeRequestResponse)
def publish_change_request(req_id: int, body: DraftAction, db: Session = Depends(get_db)):
    """Applies an approved change to its document and increments the version."""
    change_req, doc = _owned_approved_request(db, req_id, body.username)
    request_id = format_request_id(change_req.id)
    if change_req.original_content != doc.current_content:
        raise HTTPException(
            status_code=409,
            detail=f"Cannot publish {request_id}: '{doc.title}' has changed (now v{doc.version}) since it was approved. "
                   f"Create a new draft from it and regenerate against the current version."
        )
    doc.current_content = change_req.proposed_content
    doc.version += 1
    change_req.status = RequestStatus.PUBLISHED
    change_req.published_by = body.username
    change_req.published_at = datetime.now(timezone.utc)
    change_req.published_version = doc.version
    # The saved draft this came from (if any) is done
    db.query(Draft).filter(Draft.change_request_id == change_req.id).delete()
    db.add(AuditLog(
        document_id=doc.id,
        change_request_id=change_req.id,
        actor=body.username,
        action="CHANGE_PUBLISHED",
        version_after=doc.version,
        summary=f"Published {request_id} (approved by @{change_req.reviewed_by}). Version bumped to {doc.version}."
    ))
    db.commit()
    db.refresh(change_req)
    return _to_change_request_response(change_req, doc)

@app.post("/api/change-requests/{req_id}/redraft", response_model=SavedDraftResponse)
def redraft_change_request(req_id: int, body: DraftAction, db: Session = Depends(get_db)):
    """Withdraws an approved change without publishing it and returns it to the requester's Drafts folder."""
    change_req, doc = _owned_approved_request(db, req_id, body.username)
    linked_draft = db.query(Draft).filter(Draft.change_request_id == change_req.id).first()
    change_req.status = RequestStatus.WITHDRAWN
    draft = _reopen_as_draft(db, change_req, doc, linked_draft)
    db.add(AuditLog(
        document_id=doc.id,
        change_request_id=change_req.id,
        actor=body.username,
        action="CHANGE_WITHDRAWN",
        version_after=doc.version,
        summary=f"Withdrew approved {format_request_id(change_req.id)} without publishing; reopened as a draft by @{body.username}."
    ))
    db.commit()
    db.refresh(draft)
    return _to_draft_response(draft)

# --- NEW RELEASES FEED (visible to every role) ---
@app.get("/api/releases", response_model=List[ReleaseResponse])
def list_releases(limit: int = Query(50, ge=1, le=200), db: Session = Depends(get_db)):
    """Published changes (each produced a new document version), newest first."""
    rows = (
        db.query(ChangeRequest, Document)
        .join(Document, ChangeRequest.document_id == Document.id)
        .filter(ChangeRequest.status == RequestStatus.PUBLISHED)
        .order_by(ChangeRequest.published_at.desc(), ChangeRequest.id.desc())
        .limit(limit)
        .all()
    )
    return [
        ReleaseResponse(
            change_request_id=req.id,
            request_id=format_request_id(req.id),
            document_id=doc.id,
            project_id=doc.project_id,
            project_name=doc.project.name if doc.project else None,
            category=doc.category,
            doc_type=doc.doc_type,
            doc_title=doc.title,
            version=req.published_version,
            current_version=doc.version,
            requested_by=req.requested_by,
            approved_by=req.reviewed_by,
            approved_at=_as_utc(req.reviewed_at),
            published_by=req.published_by,
            published_at=_as_utc(req.published_at),
            prompt=req.prompt,
            ai_summary=req.ai_summary,
            manually_edited=bool(req.manually_edited)
        )
        for req, doc in rows
    ]

# --- AUDIT TRAIL / CHANGE LOG ---
@app.get("/api/documents/{doc_id}/audit-logs", response_model=List[AuditLogResponse])
def get_document_audit_logs(doc_id: int, username: str, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.username == username).first()
    if not user or user.role == UserRole.VIEWER:
        raise HTTPException(status_code=403, detail="Forbidden: Viewers cannot see the audit trail.")
    logs = db.query(AuditLog).filter(AuditLog.document_id == doc_id).order_by(AuditLog.created_at.desc()).all()
    return [
        AuditLogResponse(
            id=log.id,
            document_id=log.document_id,
            change_request_id=log.change_request_id,
            request_id=format_request_id(log.change_request_id) if log.change_request_id else None,
            actor=log.actor,
            action=log.action,
            version_after=log.version_after,
            summary=log.summary,
            created_at=_as_utc(log.created_at)
        )
        for log in logs
    ]
