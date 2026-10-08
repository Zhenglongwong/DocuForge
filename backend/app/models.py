from datetime import datetime, timezone
import enum
from sqlalchemy import Boolean, Column, Integer, String, Text, DateTime, ForeignKey, Enum as SQLEnum
from sqlalchemy.orm import declarative_base, relationship

Base = declarative_base()

class UserRole(str, enum.Enum):
    ADMIN = "admin"
    EDITOR = "editor"
    VIEWER = "viewer"

class RequestStatus(str, enum.Enum):
    # Lifecycle: PENDING ("Requested Approval") -> APPROVED -> PUBLISHED, or REJECTED / WITHDRAWN back to a draft
    PENDING = "pending"
    APPROVED = "approved"    # Reviewer approved; the document is unchanged until the requester publishes
    REJECTED = "rejected"
    PUBLISHED = "published"  # Applied to the document; version incremented
    WITHDRAWN = "withdrawn"  # Approved but turned back into a draft instead of being published

class DraftStatus(str, enum.Enum):
    DRAFT = "draft"          # Visible in the owner's Drafts folder
    SUBMITTED = "submitted"  # Under review; returns to DRAFT if rejected, deleted once approved

class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    username = Column(String(50), unique=True, index=True, nullable=False)
    role = Column(SQLEnum(UserRole), default=UserRole.EDITOR, nullable=False)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

class Project(Base):
    __tablename__ = "projects"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(200), unique=True, nullable=False)
    created_by = Column(String(50), nullable=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    documents = relationship("Document", back_populates="project", cascade="all, delete-orphan")

class Document(Base):
    __tablename__ = "documents"

    id = Column(Integer, primary_key=True, index=True)
    project_id = Column(Integer, ForeignKey("projects.id"), nullable=True, index=True)  # Nullable only for rows migrated from pre-project databases
    service = Column(String(100), default="ServiceNow Enterprise", nullable=False, index=True)  # Application / Service name
    category = Column(String(100), nullable=False, index=True) # Business, Architecture, User Guides, Operations
    doc_type = Column(String(100), nullable=False, index=True) # e.g., "Business Requirement Document", "System Design Document", etc.
    title = Column(String(200), nullable=False)
    current_content = Column(Text, nullable=False)
    version = Column(Integer, default=1, nullable=False)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))

    project = relationship("Project", back_populates="documents")
    change_requests = relationship("ChangeRequest", back_populates="document", cascade="all, delete-orphan")
    drafts = relationship("Draft", back_populates="document", cascade="all, delete-orphan")
    audit_logs = relationship("AuditLog", back_populates="document", cascade="all, delete-orphan")

class ChangeRequest(Base):
    __tablename__ = "change_requests"

    id = Column(Integer, primary_key=True, index=True)
    batch_id = Column(String(64), nullable=True, index=True)  # Groups related changes from a single multi-doc proposal
    document_id = Column(Integer, ForeignKey("documents.id"), nullable=False)
    requested_by = Column(String(50), nullable=False)
    prompt = Column(Text, nullable=False)
    category = Column(String(100), nullable=True)
    relevance_rationale = Column(Text, nullable=True) # AI rationale why this document was identified as needing change
    target_section = Column(String(200), nullable=True)
    original_content = Column(Text, nullable=False)
    proposed_content = Column(Text, nullable=False)
    ai_summary = Column(Text, nullable=True)
    manually_edited = Column(Boolean, default=False, nullable=False)  # Requester hand-edited the AI draft before submitting
    ai_fallback = Column(Boolean, default=False, nullable=False)  # AI was unavailable; proposal started from a placeholder
    reference_label = Column(String(300), nullable=True)  # Reference material the AI used, e.g. "BRD (latest release v3)"
    # Kept so a rejected request can be reopened as an equivalent draft for the requester
    ai_proposed_content = Column(Text, nullable=True)
    base_version = Column(Integer, nullable=True)
    reference_document_id = Column(Integer, nullable=True)
    reference_mode = Column(String(20), nullable=True)
    refinements = Column(Text, nullable=True)  # JSON list of follow-up instructions applied after the initial prompt
    status = Column(SQLEnum(RequestStatus), default=RequestStatus.PENDING, nullable=False)
    reviewed_by = Column(String(50), nullable=True)
    reviewed_at = Column(DateTime, nullable=True)       # When approved or rejected
    rejection_reason = Column(Text, nullable=True)
    published_by = Column(String(50), nullable=True)
    published_at = Column(DateTime, nullable=True)
    published_version = Column(Integer, nullable=True)  # Document version this change produced
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))

    document = relationship("Document", back_populates="change_requests")

class Draft(Base):
    """An AI-generated proposal for one document, saved by its owner to finish later. Never audited itself."""
    __tablename__ = "drafts"

    id = Column(Integer, primary_key=True, index=True)
    document_id = Column(Integer, ForeignKey("documents.id"), nullable=False, index=True)
    owner = Column(String(50), nullable=False, index=True)
    prompt = Column(Text, nullable=False)
    relevance_rationale = Column(Text, nullable=True)
    target_section = Column(String(200), nullable=True)
    ai_summary = Column(Text, nullable=True)
    original_content = Column(Text, nullable=False)     # Document text the AI proposal was generated against
    base_version = Column(Integer, nullable=False)      # Document version at generation time
    ai_proposed_content = Column(Text, nullable=False)  # Unmodified AI output, to detect manual edits server-side
    proposed_content = Column(Text, nullable=False)     # Current proposal, including any manual edits
    ai_fallback = Column(Boolean, default=False, nullable=False)  # AI was unavailable; proposal started from a placeholder
    reference_document_id = Column(Integer, nullable=True)  # Reference re-read on regenerate; no FK so drafts survive its deletion
    reference_mode = Column(String(20), nullable=True)      # "full" or "latest_release"
    reference_label = Column(String(300), nullable=True)
    refinements = Column(Text, nullable=True)  # JSON list of follow-up instructions applied after the initial prompt
    status = Column(SQLEnum(DraftStatus), default=DraftStatus.DRAFT, nullable=False)
    change_request_id = Column(Integer, ForeignKey("change_requests.id"), nullable=True)  # Latest submission
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))

    document = relationship("Document", back_populates="drafts")
    change_request = relationship("ChangeRequest")

class AuditLog(Base):
    __tablename__ = "audit_logs"

    id = Column(Integer, primary_key=True, index=True)
    document_id = Column(Integer, ForeignKey("documents.id"), nullable=False)
    change_request_id = Column(Integer, nullable=True)
    actor = Column(String(50), nullable=False)
    action = Column(String(50), nullable=False)  # CREATED, PROPOSED_UPDATE, APPROVED, REJECTED, ROLLED_BACK
    version_after = Column(Integer, nullable=False)
    summary = Column(Text, nullable=False)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    document = relationship("Document", back_populates="audit_logs")
