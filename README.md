# Intelligent Documentation Platform — Local Setup Guide

A complete local solution for maintaining application documentation (runbooks, playbooks) with local Ollama AI patching, RBAC approval workflows, visual diffs, and an immutable audit log.

---

## 🏗️ Architecture

- **Backend:** FastAPI (Python 3.11+), SQLAlchemy, SQLite / PostgreSQL.
- **Frontend:** Next.js 14 (App Router), Tailwind CSS, Lucide icons.
- **Local AI:** [Ollama](https://ollama.ai) (`llama3.2`, `granite3-dense`, or `qwen2.5`).

---

## ⚡ Quick Start (3 Simple Steps)

### Step 1: Start Ollama (Local AI on Localhost)
1. Install Ollama from [ollama.ai](https://ollama.com).
2. Pull and run a local model:
   ```bash
   ollama run llama3.2
   ```
   *(Ollama will now be serving AI inferences at `http://127.0.0.1:11434`)*

---

### Step 2: Start the FastAPI Backend
```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
```
* **API Documentation (Swagger UI):** `http://127.0.0.1:8000/docs`

---

### Step 3: Start the Next.js Frontend
In a new terminal window:
```bash
cd frontend
npm install
npm run dev
```
* **Web UI:** `http://localhost:3000`

---

## 🧪 Testing the Workflow Locally

1. Open `http://localhost:3000` and pick a document under **ServiceNow Project** (e.g. the Business Requirement Document).
2. Under **Active Role**, select `Business Analyst` (Editor).
3. Describe a change in the proposal box, e.g.
   > *"The new SLA for Initial Response is < 30 minutes with a resolution time of < 2 hours."*
   Optionally narrow the categories, choose **This document only**, or pick a **Reference document**.
4. Click **Generate Draft Patches** and review the green/red diff. Edit it, send **follow-ups**, or **Save Draft** to finish later.
5. Click **Request Approval for This Doc** (or **Submit All for Approval**). The change is now *Requested Approval*.
6. Switch to `Ops Team` (Admin), open **Reviewer Queue**, and **Approve** (or **Reject** with a reason, which reopens it as a draft).
7. Switch back to `Business Analyst`. The change is in the project's **Approved** folder: open it and click **Publish**
   (or **Create New Draft** to rework it).
8. The document moves to `v2`, the change appears in **New Releases**, and the **Audit Trail** records approval and publication.

Change lifecycle: **Draft → Requested Approval → Approved → Published** (Rejected / Withdrawn return to Draft).

# docuforge
