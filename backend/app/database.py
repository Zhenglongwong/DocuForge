import os
from typing import List
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import Session, sessionmaker
from .models import Base, User, Project, Document, ChangeRequest, AuditLog, UserRole

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./docs_platform.db")

# For SQLite, check_same_thread needs to be False for FastAPI async handling
connect_args = {"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {}

engine = create_engine(DATABASE_URL, connect_args=connect_args)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

DEFAULT_PROJECT_NAME = "ServiceNow Project"

SEED_USERS = [
    ("System Manager", UserRole.ADMIN),
    ("Business Analyst", UserRole.EDITOR),
    ("PET Team", UserRole.EDITOR),
    ("Viewer", UserRole.VIEWER),
]

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

# Columns added after the first release: (table, column, DDL type)
_ADDED_COLUMNS = [
    ("documents", "project_id", "INTEGER REFERENCES projects(id)"),
    ("change_requests", "manually_edited", "BOOLEAN NOT NULL DEFAULT 0"),
    ("change_requests", "ai_fallback", "BOOLEAN NOT NULL DEFAULT 0"),
    ("drafts", "ai_fallback", "BOOLEAN NOT NULL DEFAULT 0"),
    ("change_requests", "reference_label", "VARCHAR(300)"),
    ("drafts", "reference_document_id", "INTEGER"),
    ("drafts", "reference_mode", "VARCHAR(20)"),
    ("drafts", "reference_label", "VARCHAR(300)"),
    ("drafts", "refinements", "TEXT"),
    ("change_requests", "ai_proposed_content", "TEXT"),
    ("change_requests", "base_version", "INTEGER"),
    ("change_requests", "reference_document_id", "INTEGER"),
    ("change_requests", "reference_mode", "VARCHAR(20)"),
    ("change_requests", "refinements", "TEXT"),
    ("change_requests", "reviewed_at", "DATETIME"),
    ("change_requests", "published_by", "VARCHAR(50)"),
    ("change_requests", "published_at", "DATETIME"),
    ("change_requests", "published_version", "INTEGER"),
]

def _migrate_added_columns() -> set:
    """create_all() does not alter existing tables, so add newer columns to databases created earlier.
    Returns the (table, column) pairs that were added."""
    inspector = inspect(engine)
    added = set()
    with engine.begin() as conn:
        for table, column, ddl in _ADDED_COLUMNS:
            if column not in {c["name"] for c in inspector.get_columns(table)}:
                conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}"))
                added.add((table, column))
    return added

def _migrate_legacy_approvals():
    """Before the Approved/Published split, approving a change also applied it. Mark those changes as published,
    using the version recorded by their approval audit entry, so release history is preserved."""
    with engine.begin() as conn:
        conn.execute(text("""
            UPDATE change_requests SET
                status = 'PUBLISHED',
                published_by = reviewed_by,
                published_at = updated_at,
                reviewed_at = updated_at,
                published_version = (
                    SELECT version_after FROM audit_logs
                    WHERE audit_logs.change_request_id = change_requests.id AND audit_logs.action = 'CHANGE_APPROVED'
                    ORDER BY audit_logs.id DESC LIMIT 1
                )
            WHERE status = 'APPROVED'
        """))

# Document types renamed after the first release: old -> new
_RENAMED_DOC_TYPES = [
    ("System Diagram Description", "System Design Document"),
    ("System Diagram Document", "System Design Document"),
]

def _migrate_renamed_doc_types():
    """Renames document types in existing databases. Titles are handled by _migrate_renamed_titles, and document
    text is left untouched, since changing it would make drafts and pending requests based on it outdated."""
    with engine.begin() as conn:
        for old, new in _RENAMED_DOC_TYPES:
            conn.execute(text("UPDATE documents SET doc_type = :new WHERE doc_type = :old"), {"old": old, "new": new})

# Document titles renamed after the first release: old -> new. Matched as a prefix, so per-project
# suffixes such as " v2" are kept.
_RENAMED_TITLES = [
    ("ServiceNow Enterprise BRD: Core IT Service Management", "ServiceNow Business Requirement Document"),
    ("ServiceNow on AWS Architecture & System Diagram Document", "ServiceNow System Design Document"),
    ("ServiceNow on AWS Architecture & System Diagram Description", "ServiceNow System Design Document"),
    ("ServiceNow Operational Ticketing & Incident Resolution Playbook", "ServiceNow Playbook"),
    ("ServiceNow User Account Onboarding & Initial Setup Guide", "[PET] Service Onboarding Brief"),
    ("ServiceNow Administrator Maintenance, Upgrades & Disaster Recovery Runbook", "ServiceNow Runbook"),
]

def _migrate_renamed_titles():
    """Renames sample document titles in existing databases (document text is left untouched)."""
    with engine.begin() as conn:
        for old, new in _RENAMED_TITLES:
            conn.execute(
                text("UPDATE documents SET title = :new || SUBSTR(title, LENGTH(:old) + 1) WHERE SUBSTR(title, 1, LENGTH(:old)) = :old"),
                {"old": old, "new": new}
            )

# Usernames renamed after the first release: old -> new
_RENAMED_USERS = {
    "alice_admin": "System Manager",
    "OpsTeam": "System Manager",
    "Ops Team": "System Manager",
    "bob_sme": "Business Analyst",
    "charlie_viewer": "PET Team",
}

# Columns that hold a username
_USERNAME_COLUMNS = [
    ("users", "username"),
    ("change_requests", "requested_by"),
    ("change_requests", "reviewed_by"),
    ("change_requests", "published_by"),
    ("drafts", "owner"),
    ("audit_logs", "actor"),
    ("projects", "created_by"),
]

def _migrate_renamed_users():
    """Renames users in existing databases, including every column that refers to them, so requests,
    drafts and audit entries stay attributed to the same person. Free-text summaries are left as written."""
    with engine.begin() as conn:
        for old, new in _RENAMED_USERS.items():
            for table, column in _USERNAME_COLUMNS:
                conn.execute(text(f"UPDATE {table} SET {column} = :new WHERE {column} = :old"), {"old": old, "new": new})

def init_db():
    Base.metadata.create_all(bind=engine)
    added_columns = _migrate_added_columns()
    if ("change_requests", "published_version") in added_columns:
        _migrate_legacy_approvals()
    _migrate_renamed_doc_types()
    _migrate_renamed_titles()
    _migrate_renamed_users()
    db = SessionLocal()
    try:
        # Simulated users: create any that are missing and keep their roles in line with SEED_USERS
        for username, role in SEED_USERS:
            user = db.query(User).filter(User.username == username).first()
            if not user:
                db.add(User(username=username, role=role))
            elif user.role != role:
                user.role = role
        db.commit()

        default_project = db.query(Project).order_by(Project.id).first()
        if not default_project:
            default_project = Project(name=DEFAULT_PROJECT_NAME, created_by="system_seeder")
            db.add(default_project)
            db.commit()
            db.refresh(default_project)

        # Documents created before projects existed belong to the default project
        db.query(Document).filter(Document.project_id.is_(None)).update(
            {Document.project_id: default_project.id}, synchronize_session=False
        )
        db.commit()

        # Seed sample documents if none exist
        if db.query(Document).count() == 0:
            seed_project_documents(db, default_project, actor="system_seeder")
    finally:
        db.close()

def seed_project_documents(db: Session, project: Project, actor: str, suffix: str = "") -> List[Document]:
    """Creates the sample ServiceNow documents inside `project`, appending `suffix` to each title."""
    sample_docs = _build_sample_documents(project.id, suffix)
    db.add_all(sample_docs)
    db.commit()

    for doc in sample_docs:
        audit = AuditLog(
            document_id=doc.id,
            actor=actor,
            action="DOCUMENT_CREATED",
            version_after=1,
            summary=f"Initialized seed document '{doc.title}' ({doc.doc_type}) under category '{doc.category}' in project '{project.name}'"
        )
        db.add(audit)
    db.commit()
    return sample_docs

def _build_sample_documents(project_id: int, suffix: str) -> List[Document]:
    return [
                # -------------------------------------------------------------
                # 1. Category: Business -> Business Requirement Document
                # -------------------------------------------------------------
                Document(
                    project_id=project_id,
                    service="ServiceNow Enterprise ITSM",
                    category="Business",
                    doc_type="Business Requirement Document",
                    title="ServiceNow Business Requirement Document" + suffix,
                    version=1,
                    current_content="""# Business Requirement Document (BRD) - ServiceNow ITSM

## 1. Executive Summary & Objective
This document defines the functional business requirements for the Enterprise ServiceNow ITSM platform. The primary goal is to standardize IT service delivery, reduce Mean Time to Resolution (MTTR), enforce SLA compliance, and provide a single pane of glass for enterprise incident, problem, and change requests.

## 2. Business User Stories & Functional Epics

### Epic 1: Incident Lifecycle Management
* **US-101 (Incident Logging):** As an IT end-user, I want to submit an incident via the ServiceNow Service Portal with automated categorization (Urgency, Impact) so that it routes to the correct resolver group.
* **US-102 (SLA Breaches):** As an IT Operations Manager, I want real-time notifications when a P1/P2 incident reaches 75% of its SLA resolution window so that on-call engineers can intervene.
* **US-103 (Major Incident War Room):** As an Incident Commander, I want the ability to promote a standard incident to a Major Incident (MIM) and auto-spin up a communication bridge with stakeholders.

### Epic 2: Change Enablement & Approval Gates
* **US-201 (Standard Change Templates):** As a DevOps Engineer, I want pre-approved standard change templates with automated risk scoring so that routine production deployments are not blocked by manual CAB review.
* **US-202 (Emergency CAB Workflow):** As a Lead Architect, I want multi-factor mobile approval for Emergency Changes affecting critical tier-1 banking services.

### Epic 3: Self-Service Catalog & Request Fulfillment
* **US-301 (Hardware/Software Access):** As an employee, I want to request role-based software licenses with automatic Manager approval chaining and Okta provisioning.
* **US-302 (Fulfillment Tracking):** As an employee, I want end-to-end milestone tracking for all submitted requests.

## 3. SLA & Performance Metrics
* **P1 (Critical):** Initial Response < 15 mins; Resolution < 2 hours; 99.9% uptime target.
* **P2 (High):** Initial Response < 30 mins; Resolution < 8 hours.
* **P3 (Moderate):** Initial Response < 2 hours; Resolution < 3 business days.
* **P4 (Low):** Initial Response < 8 hours; Resolution < 5 business days.

## 4. Compliance & Audit Criteria
All change tickets and incident root-cause analysis (RCA) records must be immutable and retained for 7 years to meet SOC2 and ISO 27001 audit standards.
"""
                ),

                # -------------------------------------------------------------
                # 2. Category: Architecture -> System Design Document
                # -------------------------------------------------------------
                Document(
                    project_id=project_id,
                    service="ServiceNow Enterprise ITSM",
                    category="Architecture",
                    doc_type="System Design Document",
                    title="ServiceNow System Design Document" + suffix,
                    version=1,
                    current_content="""# System Design Document: ServiceNow Hybrid Deployment on AWS

## 1. Architectural Overview
This document describes the high-level infrastructure and network topology for integrating the enterprise ServiceNow cloud instance with corporate backend infrastructure hosted in Amazon Web Services (AWS us-east-1).

```
   [ Enterprise End Users / SSO Browser ]
                     │ (HTTPS / TLS 1.3 via Okta SAML 2.0)
                     ▼
       ┌──────────────────────────────┐
       │   ServiceNow Cloud Platform  │
       │   (SaaS Dedicated Instance)  │
       └──────────────┬───────────────┘
                      │ (Encrypted mTLS Integration Bridge)
                      ▼
     ╔══════════════════════════════════════════════════╗
     ║                 AWS VPC (10.100.0.0/16)          ║
     ║  ┌────────────────────────────────────────────┐  ║
     ║  │ Public Subnet: AWS Application Load Balancer│  ║
     ║  └─────────────────────┬──────────────────────┘  ║
     ║                        │ (Private Ingress)       ║
     ║  ┌─────────────────────▼──────────────────────┐  ║
     ║  │ Private Subnet: ServiceNow MID Server EC2  │  ║
     ║  │ (Management, Instrumentation & Discovery)  │  ║
     ║  └──────────────┬──────────────┬──────────────┘  ║
     ║                 │              │                 ║
     ║        (VPC Peering/TGW)  (PrivateLink)          ║
     ║                 ▼              ▼                 ║
     ║       ┌────────────────┐ ┌────────────────┐      ║
     ║       │ AWS Aurora RDS │ │ AWS EventBridge│      ║
     ║       │ (CMDB Sync)    │ │ & CloudWatch   │      ║
     ║       └────────────────┘ └────────────────┘      ║
     ╚══════════════════════════════════════════════════╝
```

## 2. Key Architecture Components

### A. ServiceNow Cloud SaaS Layer
* Dedicated customer instance cluster provisioned with active-active application nodes and automatic geo-redundancy.
* Ingress secured via Cloudflare DDoS mitigation and Web Application Firewall (WAF).

### B. AWS MID Server Cluster (Management, Instrumentation & Discovery)
* **Compute:** Auto-scaling group of 3x `m6i.xlarge` EC2 instances deployed across 3 Availability Zones (AZ-a, AZ-b, AZ-c) in private subnets.
* **Function:** Polls the ServiceNow cloud instance over secure outbound HTTPS (port 443) and performs scheduled discovery scans across internal VPC assets (EC2, EKS, RDS, S3).
* **Security:** Operates strictly with outbound-only traffic — no public inbound ports exposed.

### C. AWS EventBridge & Webhook Integration Tier
* AWS CloudWatch alarms trigger Lambda functions which forward formatted incident payloads to ServiceNow REST API table endpoints (`/api/now/table/incident`).

### D. Identity & Access Gateway
* Enterprise identity federation via Okta / AWS IAM Identity Center using SAML 2.0 and SCIM user provisioning.
"""
                ),

                # -------------------------------------------------------------
                # 3. Category: User Guides -> Playbook
                # -------------------------------------------------------------
                Document(
                    project_id=project_id,
                    service="ServiceNow Enterprise ITSM",
                    category="User Guides",
                    doc_type="Playbook",
                    title="ServiceNow Playbook" + suffix,
                    version=1,
                    current_content="""# ServiceNow User Playbook: Operational Ticketing

## 1. Purpose & Scope
This operational playbook guides service desk agents, incident handlers, and IT engineers on how to manage, triage, and resolve customer tickets using the ServiceNow Workspace.

## 2. Step-by-Step Incident Lifecycle

### Step 1: Navigating the Agent Workspace
1. Log in to ServiceNow via SSO at `https://company.service-now.com`.
2. Open **Service Operations Workspace** from the top application navigator.
3. Review the **My Groups Work** queue for newly assigned or unassigned tickets.

### Step 2: Triaging & Categorizing a Ticket
1. Open the incident and inspect the **Short Description**, **Caller Information**, and **Impacted CI (Configuration Item)**.
2. Verify urgency and impact matrix:
   * **Urgency:** High (Mission critical workload down) vs Low (Individual minor issue).
   * **Impact:** Enterprise-wide vs Single user.
3. Set state to `In Progress` — this halts the "First Response" SLA countdown timer.

### Step 3: Communicating with the Caller
* Use **Work Notes** (yellow background) for internal technical logs, diagnostic commands, and SME findings.
* Use **Additional Comments** (purple background) for customer-facing messages. Adding a comment here sends an email and push notification to the caller.

### Step 4: Resolving & Closing the Incident
1. Once the issue is fixed, update State to `Resolved`.
2. Select the mandatory **Resolution Code** (e.g., `Solved (Permanently)`, `Solved (Workaround)`).
3. Fill in the **Resolution Notes** detailing the root cause and corrective action taken.
4. The system will automatically transition the ticket to `Closed` after 48 hours of caller inactivity.
"""
                ),

                # -------------------------------------------------------------
                # 4. Category: User Guides -> Onboarding Guide
                # -------------------------------------------------------------
                Document(
                    project_id=project_id,
                    service="ServiceNow Enterprise ITSM",
                    category="User Guides",
                    doc_type="Onboarding Guide",
                    title="[PET] Service Onboarding Brief" + suffix,
                    version=1,
                    current_content="""# ServiceNow User Onboarding & Quick Start Guide

## 1. Welcome to ServiceNow
Welcome! ServiceNow is your enterprise portal for requesting hardware, software, reporting IT issues, and submitting workplace approvals.

## 2. First-Time Login & Account Activation

```
[ Step 1: SSO Login ] ──► [ Step 2: MFA Setup ] ──► [ Step 3: Profile Config ] ──► [ Step 4: Notification Rules ]
```

### Step 1: Single Sign-On (SSO) Authentication
1. Navigate to your company ServiceNow portal: `https://company.service-now.com`.
2. Click **Log In with Company SSO**.
3. Authenticate using your enterprise email and password via Okta/Entra ID.
4. Complete the Multi-Factor Authentication (MFA) push on your mobile device.

### Step 2: Configuring Your User Profile
1. Click your avatar in the top-right corner and select **Profile**.
2. Confirm your **Department**, **Cost Center**, **Manager Name**, and **Desk Location**.
3. If any details are incorrect, click *Request Profile Correction* to sync with Workday HR.

### Step 3: Setting Up Notification Preferences
1. Click the Gear Icon (Settings) -> **Notifications**.
2. Enable email alerts for:
   * *Incident status changes on tickets I submitted.*
   * *Approvals waiting for my action.*
3. (Optional) Connect your Slack account to receive direct notifications in `#servicenow-alerts`.

## 3. Essential Self-Service Actions
* **Need Software or Equipment?** Go to *Service Catalog* -> *Hardware & Software Requests*.
* **Something Broken?** Click *Report an Outage / Incident* and attach screenshots.
* **Knowledge Base:** Search over 500+ how-to articles before opening a ticket.
"""
                ),

                # -------------------------------------------------------------
                # 5. Category: Operations -> Runbook
                # -------------------------------------------------------------
                Document(
                    project_id=project_id,
                    service="ServiceNow Enterprise ITSM",
                    category="Operations",
                    doc_type="Runbook",
                    title="ServiceNow Runbook" + suffix,
                    version=1,
                    current_content="""# ServiceNow Administrator Maintenance & Recovery Runbook

## 1. System Administration Scope
This runbook provides certified ServiceNow System Administrators with standard operating procedures for scheduled patching, MID server maintenance, plugin updates, and emergency disaster recovery.

## 2. Scheduled Maintenance & Family Release Upgrades

### Pre-Upgrade Checklist (T-14 Days)
1. Request Early Availability (EA) release clone from Production (`PROD`) to Sandbox/Sub-production (`SUB-PROD`).
2. Run automated regression test suites via the **Automated Test Framework (ATF)**.
3. Review skipped update list in **Upgrade Center** and reconcile customization conflicts.
4. Communicate scheduled maintenance window to business stakeholders (CAB approval required).

### Production Upgrade Execution Steps (Window: Saturday 02:00 - 06:00 UTC)
1. Verify database backups and snapshot state in ServiceNow Customer Support Portal (HI/Now Support).
2. Drain active user sessions and display maintenance banner on Service Portal.
3. Trigger target family release upgrade via the ServiceNow HI Upgrade Wizard.
4. Monitor node upgrade progress logs in real time.
5. Post-upgrade validation:
   * Validate SSO login and SCIM sync.
   * Run ATF smoke tests for Incident, Change, and Catalog Workflows.
   * Verify all AWS MID Servers report state `UP` with green connectivity indicators.
6. Remove maintenance banner and notify on-call escalation leads.

## 3. Emergency Disaster Recovery (DR) & Failover

### Scenario A: MID Server Cluster Outage in AWS
1. Check AWS CloudWatch logs for EC2 instance termination or memory exhaustion (`heap space` alerts).
2. If EC2 instance fails health checks:
   `aws autoscaling start-instance-refresh --auto-scaling-group-name servicenow-mid-asg`
3. Restart MID Server systemd service: `sudo systemctl restart servicenow_mid`.
4. Verify queue processing in ServiceNow table: `ecc_queue.list`.

### Scenario B: Data Center Failover
1. ServiceNow manages automated RPO (< 1 hr) and RTO (< 2 hrs) failover to secondary paired data center.
2. Post-failover, re-point DNS CNAME if custom URL vanity domain is in use.
"""
                )
    ]
