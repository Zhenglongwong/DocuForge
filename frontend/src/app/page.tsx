'use client';

import React, { useState, useEffect } from 'react';
import { 
  FileText, CheckCircle, XCircle, Clock, 
  GitPullRequest, Shield, Sparkles, RefreshCw, Send, History,
  Folder, Layers, ChevronDown, ChevronRight, Check, AlertCircle, ArrowRight,
  BookOpen, Cpu, Users, Wrench, Eye, Lock, ThumbsUp, FileCheck, Edit3, Save,
  ClipboardList, Hash, MessageSquare, FolderOpen, FolderPlus, X, Bookmark, FilePen, Megaphone, Link2, CornerDownRight,
  BadgeCheck, Rocket, ListChecks, Hand
} from 'lucide-react';

interface Project {
  id: number;
  name: string;
  created_by?: string | null;
  created_at?: string | null;
  document_count: number;
}

interface Document {
  id: number;
  project_id: number;
  service: string;
  category: string;
  doc_type: string;
  title: string;
  current_content: string;
  version: number;
}

interface DiffLine {
  type: 'added' | 'removed' | 'unchanged';
  text: string;
}

interface DraftPatchItem {
  document_id: number;
  service: string;
  category: string;
  doc_type: string;
  doc_title: string;
  relevance_rationale: string;
  target_section?: string | null;
  original_content: string;
  proposed_content: string;
  ai_summary: string;
  diff_lines: DiffLine[];
  submitted?: boolean;
  request_id?: string;
  manually_edited?: boolean;
  ai_proposed_content?: string;
  ai_signature?: string;
  base_version?: number;
  ai_fallback?: boolean;  // AI was unavailable: placeholder patch that only records the request
  // Set once the draft is saved to the Drafts folder; edits and submission then go through the drafts API
  saved_draft_id?: number;
  last_request_id?: string | null;
  last_rejection_reason?: string | null;
  last_reviewed_by?: string | null;
  // Reference document the AI based this draft on (id/mode are re-read on save and regenerate)
  reference_document_id?: number | null;
  reference_mode?: 'full' | 'latest_release' | null;
  reference_label?: string | null;
  refinements?: string[];  // Follow-up instructions applied after the initial prompt
  selected_by?: 'ai' | 'manual' | 'both' | 'single' | null;  // How this document was chosen for the change
}

interface SavedDraft {
  id: number;
  document_id: number;
  project_id: number;
  service: string;
  category: string;
  doc_type: string;
  doc_title: string;
  owner: string;
  prompt: string;
  relevance_rationale?: string | null;
  target_section?: string | null;
  ai_summary?: string | null;
  original_content: string;
  proposed_content: string;
  diff_lines: DiffLine[];
  manually_edited: boolean;
  ai_fallback: boolean;
  reference_label?: string | null;
  refinements: string[];
  base_version: number;
  current_version: number;
  is_stale: boolean;
  last_request_id?: string | null;
  last_rejection_reason?: string | null;
  last_reviewed_by?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

const savedDraftToItem = (d: SavedDraft): DraftPatchItem => ({
  document_id: d.document_id,
  service: d.service,
  category: d.category,
  doc_type: d.doc_type,
  doc_title: d.doc_title,
  relevance_rationale: d.relevance_rationale || '',
  target_section: d.target_section,
  original_content: d.original_content,
  proposed_content: d.proposed_content,
  ai_summary: d.ai_summary || '',
  diff_lines: d.diff_lines,
  manually_edited: d.manually_edited,
  ai_fallback: d.ai_fallback,
  reference_label: d.reference_label,
  refinements: d.refinements,
  base_version: d.base_version,
  saved_draft_id: d.id,
  last_request_id: d.last_request_id,
  last_rejection_reason: d.last_rejection_reason,
  last_reviewed_by: d.last_reviewed_by,
});

interface DraftSession {
  draft_session_id: string;
  prompt: string;
  requested_by: string;
  ai_discovery_analysis: string;
  drafts: DraftPatchItem[];
  from_saved_draft_id?: number;  // Session opened from the Drafts folder rather than freshly generated
  scanned_documents?: { document_id: number; doc_title: string; category: string; doc_type: string }[];
  manual_documents?: { document_id: number; doc_title: string; category: string; doc_type: string }[];
  scope_categories?: string[] | null;  // null = all categories in the project
  discovery_source?: 'ai' | 'heuristic' | 'single';
  reference_label?: string | null;
}

// Change lifecycle: pending ("Requested Approval") -> approved -> published; rejected/withdrawn go back to a draft
type RequestStatus = 'pending' | 'approved' | 'published' | 'rejected' | 'withdrawn';

interface ChangeRequest {
  id: number;
  request_id: string;
  batch_id?: string;
  document_id: number;
  project_id?: number | null;
  project_name?: string | null;
  service?: string;
  category?: string;
  doc_type?: string;
  doc_title?: string;
  requested_by: string;
  prompt: string;
  relevance_rationale?: string;
  target_section?: string | null;
  original_content: string;
  proposed_content: string;
  ai_summary?: string | null;
  manually_edited?: boolean;
  ai_fallback?: boolean;
  reference_label?: string | null;
  refinements?: string[];
  draft_id?: number | null;  // Draft reopened for the requester after a rejection
  stage?: string;  // "Requested Approval" | "Approved" | "Published" | "Rejected" | "Withdrawn"
  reviewed_at?: string | null;
  published_by?: string | null;
  published_at?: string | null;
  published_version?: number | null;
  is_stale?: boolean;
  status: RequestStatus;
  reviewed_by?: string | null;
  rejection_reason?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

const STATUS_BADGE_CLASSES: Record<RequestStatus, string> = {
  pending: 'bg-amber-950 text-amber-400 border border-amber-800',
  approved: 'bg-sky-950 text-sky-300 border border-sky-800',
  published: 'bg-emerald-950 text-emerald-400 border border-emerald-800',
  rejected: 'bg-rose-950 text-rose-400 border border-rose-800',
  withdrawn: 'bg-slate-800 text-slate-400 border border-slate-700',
};

const SELECTED_BY_LABELS: Record<string, string> = {
  ai: 'Found by AI',
  manual: 'Added manually',
  both: 'Added manually · AI agreed',
};

const formatTimestamp = (value?: string | null) =>
  value ? new Date(value).toLocaleString() : '—';

const AiFallbackBadge = () => (
  <span
    title="The AI model was unavailable, so this started as a placeholder that only records the request"
    className="text-[9px] font-semibold px-1.5 py-0.5 rounded bg-rose-950 text-rose-300 border border-rose-800 flex items-center gap-1 flex-shrink-0"
  >
    <AlertCircle className="w-2.5 h-2.5" /> AI unavailable
  </span>
);

const ManuallyEditedBadge = () => (
  <span
    title="The requester hand-edited the AI-generated draft before submitting"
    className="text-[9px] font-semibold px-1.5 py-0.5 rounded bg-violet-950 text-violet-300 border border-violet-800 flex items-center gap-1 flex-shrink-0"
  >
    <Edit3 className="w-2.5 h-2.5" /> Manually edited
  </span>
);

interface LatestRelease {
  document_id: number;
  version: number;
  request_id: string;
  published_at?: string | null;
}

interface Release {
  change_request_id: number;
  request_id: string;
  document_id: number;
  project_id?: number | null;
  project_name?: string | null;
  category: string;
  doc_type: string;
  doc_title: string;
  version: number;
  current_version: number;
  requested_by: string;
  approved_by?: string | null;
  approved_at?: string | null;
  published_by?: string | null;
  published_at?: string | null;
  prompt: string;
  ai_summary?: string | null;
  manually_edited: boolean;
}

const releaseTime = (r: Release) => (r.published_at ? Date.parse(r.published_at) : 0);

// Request Overview: the lifecycle stages of an ongoing change, in order
const OVERVIEW_STAGES = ['Draft', 'Pending Approval', 'Approved', 'Published'] as const;
type OverviewStage = typeof OVERVIEW_STAGES[number];
const OVERVIEW_STAGE_STYLES: Record<OverviewStage, string> = {
  'Draft': 'bg-amber-500/20 text-amber-200 border-amber-400 ring-amber-400/40',
  'Pending Approval': 'bg-orange-500/20 text-orange-200 border-orange-400 ring-orange-400/40',
  'Approved': 'bg-sky-500/20 text-sky-200 border-sky-400 ring-sky-400/40',
  'Published': 'bg-emerald-500/20 text-emerald-200 border-emerald-400 ring-emerald-400/40',
};

interface OverviewItem {
  key: string;
  stage: OverviewStage;
  documentId: number;
  docTitle: string;
  projectName: string;
  category: string;
  docType: string;
  label: string;              // Request ID, or "Draft" for a change not yet submitted
  prompt: string;
  stageDates: Partial<Record<OverviewStage, string | null>>;
  lastActivity: number;
  isStale?: boolean;
  note?: string;              // e.g. why a draft came back
  open: () => void;
}

// Per-viewer "last seen" marker (publication time, ms) for the New Releases badge; storage can be unavailable
const releasesSeenKey = (user: string) => `docuforge:releases-seen-at:${user}`;
const readReleasesSeen = (user: string): number => {
  try {
    return Number(window.localStorage.getItem(releasesSeenKey(user))) || 0;
  } catch {
    return 0;
  }
};
const writeReleasesSeen = (user: string, seenAt: number) => {
  try {
    window.localStorage.setItem(releasesSeenKey(user), String(seenAt));
  } catch {
    // Badge simply won't persist
  }
};

interface AuditLog {
  id: number;
  change_request_id?: number | null;
  request_id?: string | null;
  actor: string;
  action: string;
  version_after: number;
  summary: string;
  created_at: string;
}

const API_BASE = 'http://127.0.0.1:8000';

// Simulated users, one per role
// Simulated users; permissions follow the role, so several users can share one
type Role = 'admin' | 'editor' | 'viewer';
const USER_ACCOUNTS = [
  { username: 'System Manager', role: 'admin' },
  { username: 'Business Analyst', role: 'editor' },
  { username: 'PET Team', role: 'editor' },
  { username: 'Viewer', role: 'viewer' },
] as const satisfies readonly { username: string; role: Role }[];
type Username = typeof USER_ACCOUNTS[number]['username'];
const ROLE_DESCRIPTIONS: Record<Role, string> = {
  admin: 'Admin - Can Review & Approve',
  editor: 'Editor - Can Propose Changes',
  viewer: 'Viewer - Read Only',
};
const roleOf = (username: string): Role => USER_ACCOUNTS.find(u => u.username === username)?.role ?? 'viewer';
const ADMIN_USERNAMES = USER_ACCOUNTS.filter(u => u.role === 'admin').map(u => u.username);

const CATEGORY_ICONS: Record<string, React.ReactNode> = {
  'Business': <BookOpen className="w-3.5 h-3.5 text-emerald-400" />,
  'Architecture': <Cpu className="w-3.5 h-3.5 text-blue-400" />,
  'User Guides': <Users className="w-3.5 h-3.5 text-amber-400" />,
  'Operations': <Wrench className="w-3.5 h-3.5 text-purple-400" />
};

export default function Home() {
  const [documents, setDocuments] = useState<Document[]>([]);
  const [selectedDoc, setSelectedDoc] = useState<Document | null>(null);
  const [changeRequests, setChangeRequests] = useState<ChangeRequest[]>([]);
  const [selectedRequest, setSelectedRequest] = useState<ChangeRequest | null>(null);
  const [diffLines, setDiffLines] = useState<DiffLine[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  
  // User simulation (RBAC)
  const [currentUser, setCurrentUser] = useState<Username>('Business Analyst');
  const [changePrompt, setChangePrompt] = useState('');
  // Categories the AI may suggest changes in; empty means every category in the project
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  // 'multi': AI discovers affected documents across the scope; 'single': only the open document is changed
  const [discoveryMode, setDiscoveryMode] = useState<'multi' | 'single'>('multi');
  // Multi-document mode: documents picked by hand are always updated, on top of what AI discovery finds
  const [manualDocIds, setManualDocIds] = useState<number[]>([]);
  const [aiDiscovery, setAiDiscovery] = useState(true);
  // Optional read-only reference document the AI should base its recommendations on
  const [referenceDocId, setReferenceDocId] = useState<number | null>(null);
  const [referenceMode, setReferenceMode] = useState<'full' | 'latest_release'>('full');
  const [referenceLatest, setReferenceLatest] = useState<LatestRelease | null | undefined>(undefined);  // undefined = loading
  const [isGeneratingDrafts, setIsGeneratingDrafts] = useState(false);
  const [submittingDocId, setSubmittingDocId] = useState<number | null>(null);
  const [isSubmittingAll, setIsSubmittingAll] = useState(false);
  const [activeTab, setActiveTab] = useState<'content' | 'requests' | 'my-requests' | 'overview' | 'releases' | 'audit'>('content');

  // New Releases feed (all roles) and the release currently shown on its document
  const [releases, setReleases] = useState<Release[]>([]);
  const [releasesSeenId, setReleasesSeenId] = useState(0);
  const [openRelease, setOpenRelease] = useState<Release | null>(null);

  // Requester's approved-but-unpublished changes (Approved folder) and the one currently open
  const [approvedRequests, setApprovedRequests] = useState<ChangeRequest[]>([]);
  const [collapsedApprovedFolders, setCollapsedApprovedFolders] = useState<Record<number, boolean>>({});
  const [openApproved, setOpenApproved] = useState<ChangeRequest | null>(null);
  const [approvedDiff, setApprovedDiff] = useState<DiffLine[]>([]);
  const [approvedAction, setApprovedAction] = useState<'publish' | 'redraft' | null>(null);
  const [releaseDiff, setReleaseDiff] = useState<DiffLine[]>([]);
  // Keyed by `${projectId}:${category}` so each project's categories collapse independently
  const [collapsedCategories, setCollapsedCategories] = useState<Record<string, boolean>>({});
  const [projects, setProjects] = useState<Project[]>([]);
  const [collapsedProjects, setCollapsedProjects] = useState<Record<number, boolean>>({});
  const [isCreatingProject, setIsCreatingProject] = useState(false);

  // Saved drafts (owner-only) shown in each project's Drafts folder
  const [savedDrafts, setSavedDrafts] = useState<SavedDraft[]>([]);
  const [collapsedDraftFolders, setCollapsedDraftFolders] = useState<Record<number, boolean>>({});
  const [savingDraftIndex, setSavingDraftIndex] = useState<number | null>(null);
  const [isSavingAll, setIsSavingAll] = useState(false);
  const [regeneratingDraftId, setRegeneratingDraftId] = useState<number | null>(null);
  // Follow-up instruction for the selected draft
  const [followUpText, setFollowUpText] = useState('');
  const [isRefining, setIsRefining] = useState(false);

  // Two-stage proposal state: Generated Draft Preview & Editable Drafts
  const [activeDraftSession, setActiveDraftSession] = useState<DraftSession | null>(null);
  const [selectedDraftIndex, setSelectedDraftIndex] = useState<number>(0);
  const [isEditingDraft, setIsEditingDraft] = useState(false);
  const [editedProposedText, setEditedProposedText] = useState('');

  // Request IDs returned by the most recent submission, shown until dismissed
  const [lastSubmittedRequestIds, setLastSubmittedRequestIds] = useState<string[]>([]);

  // Reviewer rejection form
  const [isRejecting, setIsRejecting] = useState(false);
  const [rejectionReason, setRejectionReason] = useState('');
  const [isReviewing, setIsReviewing] = useState(false);
  const [reviewQueueFilter, setReviewQueueFilter] = useState<'all' | RequestStatus>('pending');

  // Requester's own requests ("My Requests" tab)
  const [myRequests, setMyRequests] = useState<ChangeRequest[]>([]);
  const [myRequestsFilter, setMyRequestsFilter] = useState<'all' | RequestStatus>('all');
  const [overviewShowPublished, setOverviewShowPublished] = useState(true);

  const isViewer = roleOf(currentUser) === 'viewer';
  const isAdmin = roleOf(currentUser) === 'admin';
  // Anyone who can submit change requests can track them (editors, and admins who also propose)
  const canSubmitRequests = !isViewer;

  useEffect(() => {
    fetchProjects();
    fetchDocuments();
  }, []);

  useEffect(() => {
    if (selectedDoc && !isViewer) {
      fetchAuditLogs(selectedDoc.id);
    } else {
      setAuditLogs([]);
    }
  }, [selectedDoc, currentUser]);

  useEffect(() => {
    fetchSavedDrafts();
    fetchApprovedRequests();
    setOpenApproved(null);
    fetchReleases();
    setReleasesSeenId(readReleasesSeen(currentUser));
  }, [currentUser]);

  // The reference is read-only, so it can't also be picked for changes
  useEffect(() => {
    if (referenceDocId !== null) setManualDocIds(ids => ids.filter(id => id !== referenceDocId));
  }, [referenceDocId]);

  // Look up the reference document's latest release (re-checked when new releases arrive)
  useEffect(() => {
    if (referenceDocId === null) {
      setReferenceLatest(undefined);
      return;
    }
    let cancelled = false;
    setReferenceLatest(undefined);
    fetch(`${API_BASE}/api/documents/${referenceDocId}/latest-release`)
      .then(res => res.json())
      .then((latest: LatestRelease | null) => {
        if (cancelled) return;
        setReferenceLatest(latest);
        if (!latest) setReferenceMode('full');
      })
      .catch(err => console.error('Failed to load latest release:', err));
    return () => { cancelled = true; };
  }, [referenceDocId, releases.length]);

  useEffect(() => {
    if (activeTab === 'releases') {
      fetchReleases(true);
      fetchDocuments();
    }
  }, [activeTab]);

  useEffect(() => {
    if (activeTab === 'requests' && isAdmin) {
      fetchChangeRequests();
    }
  }, [activeTab, currentUser]);

  useEffect(() => {
    if (activeTab === 'overview' && canSubmitRequests) {
      fetchMyRequests();
      fetchSavedDrafts();
      fetchReleases();
    }
    if (activeTab === 'my-requests' && canSubmitRequests) {
      fetchMyRequests();
      fetchSavedDrafts();  // Rejected requests may have been reopened as drafts
      fetchApprovedRequests();
    }
  }, [activeTab, currentUser]);

  // When switching selected draft in draft session, sync edited text
  useEffect(() => {
    setFollowUpText('');
  }, [selectedDraftIndex, activeDraftSession?.draft_session_id]);

  useEffect(() => {
    if (activeDraftSession && activeDraftSession.drafts[selectedDraftIndex]) {
      setEditedProposedText(activeDraftSession.drafts[selectedDraftIndex].proposed_content);
      setIsEditingDraft(false);
    }
  }, [selectedDraftIndex, activeDraftSession]);

  const fetchProjects = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/projects`);
      setProjects(await res.json());
    } catch (err) {
      console.error('Failed to load projects:', err);
    }
  };

  const handleCreateProject = async () => {
    if (!isAdmin) return;
    setIsCreatingProject(true);
    try {
      const res = await fetch(`${API_BASE}/api/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: currentUser }),
      });
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        alert(`Failed to create project: ${errorData.detail || res.statusText}`);
        return;
      }
      const project: Project = await res.json();
      await fetchProjects();
      await fetchDocuments();
      alert(`✅ Created "${project.name}" with ${project.document_count} documents.`);
    } catch (err: any) {
      console.error('Error creating project:', err);
      alert(`Network error creating project: ${err.message}`);
    } finally {
      setIsCreatingProject(false);
    }
  };

  const handleDeleteProject = async (project: Project) => {
    if (!isAdmin) return;
    if (!window.confirm(
      `Delete "${project.name}"?\n\nThis permanently removes its ${project.document_count} documents, their change requests and audit history.`
    )) return;

    try {
      const res = await fetch(
        `${API_BASE}/api/projects/${project.id}?username=${encodeURIComponent(currentUser)}`,
        { method: 'DELETE' }
      );
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        alert(`Failed to delete project: ${errorData.detail || res.statusText}`);
        return;
      }

      // If the open document was in the deleted project, move to a document in a remaining project
      const docsRes = await fetch(`${API_BASE}/api/documents`);
      const remainingDocs: Document[] = await docsRes.json();
      setDocuments(remainingDocs);
      if (!selectedDoc || selectedDoc.project_id === project.id) {
        setSelectedDoc(remainingDocs[0] || null);
        setActiveDraftSession(null);
        setSelectedCategories([]);
      }
      if (selectedRequest?.project_id === project.id) {
        setSelectedRequest(null);
        setDiffLines([]);
      }
      setLastSubmittedRequestIds([]);
      await fetchProjects();
      fetchChangeRequests();
      fetchSavedDrafts();
    } catch (err: any) {
      console.error('Error deleting project:', err);
      alert(`Network error deleting project: ${err.message}`);
    }
  };

  // markSeen: the viewer is looking at the feed, so everything in it is no longer "new"
  const fetchReleases = async (markSeen = false) => {
    try {
      const res = await fetch(`${API_BASE}/api/releases`);
      const data: Release[] = await res.json();
      setReleases(data);
      if (markSeen && data.length > 0) {
        const newest = Math.max(...data.map(releaseTime));
        writeReleasesSeen(currentUser, newest);
        setReleasesSeenId(newest);
      }
    } catch (err) {
      console.error('Failed to load releases:', err);
    }
  };

  const handleOpenRelease = async (release: Release) => {
    const doc = documents.find(d => d.id === release.document_id);
    if (!doc || !handleSelectDocument(doc)) return;
    setActiveTab('content');
    setOpenRelease(release);
    setReleaseDiff([]);
    try {
      const res = await fetch(`${API_BASE}/api/change-requests/${release.change_request_id}/diff`);
      const data = await res.json();
      setReleaseDiff(data.diff_lines);
    } catch (err) {
      console.error('Failed to load release changes:', err);
    }
  };

  const fetchApprovedRequests = async () => {
    if (roleOf(currentUser) === 'viewer') {
      setApprovedRequests([]);
      return;
    }
    try {
      const res = await fetch(`${API_BASE}/api/change-requests?requested_by=${encodeURIComponent(currentUser)}&status=approved`);
      setApprovedRequests(await res.json());
    } catch (err) {
      console.error('Failed to load approved changes:', err);
    }
  };

  const handleOpenApproved = async (req: ChangeRequest) => {
    const doc = documents.find(d => d.id === req.document_id);
    if (!doc || !handleSelectDocument(doc)) return;
    setActiveTab('content');
    setOpenApproved(req);
    setApprovedDiff([]);
    try {
      const res = await fetch(`${API_BASE}/api/change-requests/${req.id}/diff`);
      setApprovedDiff((await res.json()).diff_lines);
    } catch (err) {
      console.error('Failed to load approved changes:', err);
    }
  };

  // Publish an approved change (updates the document and its version) or turn it back into a draft
  const handleApprovedAction = async (action: 'publish' | 'redraft') => {
    const req = openApproved;
    if (!req) return;
    if (action === 'redraft' && !window.confirm(`Withdraw ${req.request_id} without publishing and reopen it as a draft?`)) return;
    setApprovedAction(action);
    try {
      const res = await fetch(`${API_BASE}/api/change-requests/${req.id}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: currentUser }),
      });
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        alert(`Failed to ${action === 'publish' ? 'publish' : 'create a draft from'} ${req.request_id}: ${errorData.detail || res.statusText}`);
        return;
      }
      const data = await res.json();
      setOpenApproved(null);
      fetchApprovedRequests();
      if (action === 'publish') {
        const docRes = await fetch(`${API_BASE}/api/documents/${req.document_id}`);
        setSelectedDoc(await docRes.json());
        fetchDocuments();
        fetchReleases();
        fetchAuditLogs(req.document_id);
        alert(`✅ Published ${req.request_id}: "${req.doc_title}" is now v${data.published_version}.`);
      } else {
        await fetchSavedDrafts();
        handleOpenSavedDraft(data);
      }
    } catch (err: any) {
      console.error(`Error during ${action}:`, err);
      alert(`Network error: ${err.message}`);
    } finally {
      setApprovedAction(null);
    }
  };

  const fetchSavedDrafts = async () => {
    if (roleOf(currentUser) === 'viewer') {
      setSavedDrafts([]);
      return;
    }
    try {
      const res = await fetch(`${API_BASE}/api/drafts?username=${encodeURIComponent(currentUser)}`);
      setSavedDrafts(await res.json());
    } catch (err) {
      console.error('Failed to load saved drafts:', err);
    }
  };

  const hasUnsavedDrafts = !!activeDraftSession?.drafts.some(d => !d.submitted && !d.saved_draft_id);
  const confirmDiscardUnsaved = () =>
    !hasUnsavedDrafts || window.confirm('You have generated drafts that are not saved or submitted. Discard them?');

  const replaceSessionDraft = (index: number, item: DraftPatchItem) => {
    setActiveDraftSession(prev => {
      if (!prev) return prev;
      const drafts = [...prev.drafts];
      drafts[index] = item;
      return { ...prev, drafts };
    });
  };

  // Drafts and category scope belong to a single project, so reset them when moving between projects.
  // Returns false if the user chose to keep unsaved drafts instead of switching.
  const handleSelectDocument = (doc: Document): boolean => {
    const leavingProject = !!selectedDoc && selectedDoc.project_id !== doc.project_id;
    if (leavingProject && !confirmDiscardUnsaved()) return false;
    setOpenRelease(null);
    setOpenApproved(null);
    if (leavingProject || activeDraftSession?.from_saved_draft_id) {
      // A saved draft lives on in the Drafts folder, so closing it loses nothing
      setActiveDraftSession(null);
    }
    if (leavingProject) {
      setSelectedCategories([]);
      setManualDocIds([]);
    }
    setSelectedDoc(doc);
    setSelectedRequest(null);
    return true;
  };

  const handleOpenSavedDraft = (draft: SavedDraft) => {
    if (activeDraftSession?.from_saved_draft_id !== draft.id && !confirmDiscardUnsaved()) return;
    const doc = documents.find(d => d.id === draft.document_id);
    if (!doc) return;
    if (selectedDoc?.project_id !== doc.project_id) setSelectedCategories([]);
    setSelectedDoc(doc);
    setSelectedRequest(null);
    setActiveTab('content');
    setActiveDraftSession({
      draft_session_id: `saved-${draft.id}`,
      prompt: draft.prompt,
      requested_by: draft.owner,
      ai_discovery_analysis: `Saved draft · Request: "${draft.prompt}"`,
      reference_label: draft.reference_label,
      drafts: [savedDraftToItem(draft)],
      from_saved_draft_id: draft.id,
    });
    setSelectedDraftIndex(0);
  };

  // Save generated drafts to the project's Drafts folder
  const handleSaveDrafts = async (indices: number[]) => {
    if (!activeDraftSession || isViewer) return;
    const targets = indices.filter(i => {
      const d = activeDraftSession.drafts[i];
      return d && !d.submitted && !d.saved_draft_id;
    });
    if (targets.length === 0) return;

    try {
      const res = await fetch(`${API_BASE}/api/drafts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: currentUser,
          prompt: activeDraftSession.prompt,
          drafts: targets.map(i => activeDraftSession.drafts[i]),
        }),
      });
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        alert(`Failed to save draft: ${errorData.detail || res.statusText}`);
        return;
      }
      const saved: SavedDraft[] = await res.json();
      targets.forEach((i, k) => replaceSessionDraft(i, savedDraftToItem(saved[k])));
      fetchSavedDrafts();
    } catch (err: any) {
      console.error('Error saving draft:', err);
      alert(`Network error saving draft: ${err.message}`);
    }
  };

  const handleSaveSingleDraft = async (index: number) => {
    setSavingDraftIndex(index);
    await handleSaveDrafts([index]);
    setSavingDraftIndex(null);
  };

  const handleSaveAllDrafts = async () => {
    if (!activeDraftSession) return;
    setIsSavingAll(true);
    await handleSaveDrafts(activeDraftSession.drafts.map((_, i) => i));
    setIsSavingAll(false);
  };

  const handleRegenerateDraft = async (index: number) => {
    const item = activeDraftSession?.drafts[index];
    if (!item?.saved_draft_id) return;
    if (item.manually_edited && !window.confirm('Regenerating replaces this draft, including your manual edits. Continue?')) return;
    setRegeneratingDraftId(item.saved_draft_id);
    try {
      const res = await fetch(`${API_BASE}/api/drafts/${item.saved_draft_id}/regenerate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: currentUser }),
      });
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        alert(`Failed to regenerate draft: ${errorData.detail || res.statusText}`);
        return;
      }
      replaceSessionDraft(index, savedDraftToItem(await res.json()));
      fetchSavedDrafts();
    } catch (err: any) {
      console.error('Error regenerating draft:', err);
      alert(`Network error regenerating draft: ${err.message}`);
    } finally {
      setRegeneratingDraftId(null);
    }
  };

  // Apply a follow-up instruction to the current proposal (keeps earlier changes and manual edits)
  const handleRefineDraft = async (index: number) => {
    const session = activeDraftSession;
    const item = session?.drafts[index];
    const instruction = followUpText.trim();
    if (!session || !item || !instruction || isViewer) return;
    setIsRefining(true);
    try {
      const res = item.saved_draft_id
        ? await fetch(`${API_BASE}/api/drafts/${item.saved_draft_id}/refine`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: currentUser, instruction }),
          })
        : await fetch(`${API_BASE}/api/refine-draft`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: currentUser, prompt: session.prompt, item, instruction }),
          });
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        alert(`Follow-up not applied: ${errorData.detail || res.statusText}`);
        return;
      }
      const data = await res.json();
      replaceSessionDraft(index, item.saved_draft_id ? savedDraftToItem(data) : { ...item, ...data });
      setFollowUpText('');
      if (item.saved_draft_id) fetchSavedDrafts();
    } catch (err: any) {
      console.error('Error applying follow-up:', err);
      alert(`Network error applying follow-up: ${err.message}`);
    } finally {
      setIsRefining(false);
    }
  };

  const handleDeleteSavedDraft = async (draft: SavedDraft) => {
    if (!window.confirm(`Delete the saved draft for "${draft.doc_title}"?`)) return;
    try {
      const res = await fetch(
        `${API_BASE}/api/drafts/${draft.id}?username=${encodeURIComponent(currentUser)}`,
        { method: 'DELETE' }
      );
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        alert(`Failed to delete draft: ${errorData.detail || res.statusText}`);
        return;
      }
      if (activeDraftSession?.from_saved_draft_id === draft.id) {
        setActiveDraftSession(null);
      } else if (activeDraftSession?.drafts.some(d => d.saved_draft_id === draft.id)) {
        // Deleted from the sidebar while open in a generated session: it is no longer saved
        setActiveDraftSession(prev => prev && ({
          ...prev,
          drafts: prev.drafts.map(d => d.saved_draft_id === draft.id ? { ...d, saved_draft_id: undefined } : d),
        }));
      }
      fetchSavedDrafts();
    } catch (err: any) {
      console.error('Error deleting draft:', err);
      alert(`Network error deleting draft: ${err.message}`);
    }
  };

  const fetchDocuments = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/documents`);
      const data = await res.json();
      setDocuments(data);
      if (data.length > 0 && !selectedDoc) {
        setSelectedDoc(data[0]);
      }
    } catch (err) {
      console.error('Failed to load documents:', err);
    }
  };

  // Reviewer queue: all change requests across every document
  const fetchChangeRequests = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/change-requests`);
      const data = await res.json();
      setChangeRequests(data);
    } catch (err) {
      console.error(err);
    }
  };

  const fetchMyRequests = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/change-requests?requested_by=${encodeURIComponent(currentUser)}`);
      const data = await res.json();
      setMyRequests(data);
    } catch (err) {
      console.error('Failed to load my requests:', err);
    }
  };

  const fetchAuditLogs = async (docId: number) => {
    try {
      const res = await fetch(`${API_BASE}/api/documents/${docId}/audit-logs?username=${encodeURIComponent(currentUser)}`);
      if (!res.ok) {
        setAuditLogs([]);  // Viewers are not allowed to see the audit trail
        return;
      }
      setAuditLogs(await res.json());
    } catch (err) {
      console.error(err);
    }
  };

  const handleSelectRequest = async (req: ChangeRequest) => {
    setSelectedRequest(req);
    setIsRejecting(false);
    setRejectionReason('');
    try {
      const res = await fetch(`${API_BASE}/api/change-requests/${req.id}/diff`);
      const data = await res.json();
      setDiffLines(data.diff_lines);
    } catch (err) {
      console.error(err);
    }
  };

  // Step 1: Generate AI Draft Patches (Does not submit to reviewer yet)
  const handleGenerateDrafts = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isViewer) {
      alert("Permission Denied: Viewer role is read-only and cannot request changes.");
      return;
    }
    if (!changePrompt.trim() || !selectedDoc) return;

    if (!confirmDiscardUnsaved()) return;
    setIsGeneratingDrafts(true);
    setActiveDraftSession(null);

    try {
      const payload = {
        prompt: changePrompt,
        username: currentUser,
        project_id: selectedDoc?.project_id,
        target_categories: discoveryMode === 'multi' && selectedCategories.length > 0 ? selectedCategories : null,
        include_document_ids: discoveryMode === 'multi' ? manualDocIds : [],
        ai_discovery: discoveryMode === 'multi' ? aiDiscovery : true,
        target_document_id: discoveryMode === 'single' ? selectedDoc.id : null,
        reference_document_id: referenceDocId,
        reference_mode: referenceMode
      };

      const res = await fetch(`${API_BASE}/api/generate-drafts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        alert(`Failed to generate drafts: ${errorData.detail || res.statusText}`);
        return;
      }

      const draftSession: DraftSession = await res.json();
      setActiveDraftSession(draftSession);
      setLastSubmittedRequestIds([]);
      setSelectedDraftIndex(0);
      if (draftSession.drafts.length > 0) {
        setEditedProposedText(draftSession.drafts[0].proposed_content);
      }
    } catch (err: any) {
      console.error('Error generating drafts:', err);
      alert(`Network error generating drafts: ${err.message}`);
    } finally {
      setIsGeneratingDrafts(false);
    }
  };

  // Save manual edit to draft and recompute live diff
  const handleSaveDraftEdit = async () => {
    if (!activeDraftSession) return;
    const currentDraft = activeDraftSession.drafts[selectedDraftIndex];
    if (!currentDraft) return;

    if (currentDraft.saved_draft_id) {
      try {
        const res = await fetch(`${API_BASE}/api/drafts/${currentDraft.saved_draft_id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: currentUser, proposed_content: editedProposedText }),
        });
        if (!res.ok) {
          const errorData = await res.json().catch(() => ({}));
          alert(`Failed to save draft changes: ${errorData.detail || res.statusText}`);
          return;
        }
        replaceSessionDraft(selectedDraftIndex, savedDraftToItem(await res.json()));
        setIsEditingDraft(false);
        fetchSavedDrafts();
      } catch (err: any) {
        console.error('Failed to save draft changes:', err);
        alert(`Network error saving draft changes: ${err.message}`);
      }
      return;
    }

    try {
      // Recompute diff with backend
      const res = await fetch(`${API_BASE}/api/compute-diff`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          original: currentDraft.original_content,
          proposed: editedProposedText
        }),
      });
      const diffData = await res.json();

      const updatedDrafts = [...activeDraftSession.drafts];
      updatedDrafts[selectedDraftIndex] = {
        ...currentDraft,
        proposed_content: editedProposedText,
        diff_lines: diffData.diff_lines,
        manually_edited: editedProposedText !== (currentDraft.ai_proposed_content ?? currentDraft.proposed_content)
      };

      setActiveDraftSession({
        ...activeDraftSession,
        drafts: updatedDrafts
      });
      setIsEditingDraft(false);
    } catch (err) {
      console.error('Failed to recompute diff:', err);
    }
  };

  // Submits the drafts at the given session indices: saved drafts through the drafts API (so they leave the
  // Drafts folder), the rest as one batch. Returns request IDs by index, plus the first error if any.
  const submitDraftItems = async (indices: number[]): Promise<{ ids: Record<number, string>; error?: string }> => {
    const session = activeDraftSession!;
    const ids: Record<number, string> = {};
    const post = async (url: string, body: object) => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.detail || res.statusText);
      }
      return res.json();
    };

    let error: string | undefined;
    try {
      for (const i of indices.filter(i => session.drafts[i].saved_draft_id)) {
        const result = await post(`${API_BASE}/api/drafts/${session.drafts[i].saved_draft_id}/submit`, { username: currentUser });
        ids[i] = result.change_requests[0].request_id;
      }
      const unsaved = indices.filter(i => !session.drafts[i].saved_draft_id);
      if (unsaved.length > 0) {
        const result = await post(`${API_BASE}/api/submit-approval-request`, {
          draft_session_id: session.draft_session_id,
          username: currentUser,
          prompt: session.prompt,
          drafts: unsaved.map(i => session.drafts[i]),
        });
        for (const cr of result.change_requests as ChangeRequest[]) {
          const i = unsaved.find(idx => session.drafts[idx].document_id === cr.document_id);
          if (i !== undefined) ids[i] = cr.request_id;
        }
      }
    } catch (err: any) {
      error = err.message;
    }

    // Mark what was submitted; close the session once nothing is left to submit
    const drafts = session.drafts.map((d, i) => ids[i] ? { ...d, submitted: true, request_id: ids[i] } : d);
    if (drafts.every(d => d.submitted)) {
      setActiveDraftSession(null);
      if (!session.from_saved_draft_id) setChangePrompt('');
    } else {
      setActiveDraftSession({ ...session, drafts });
    }
    if (Object.keys(ids).length > 0) {
      setLastSubmittedRequestIds(Object.values(ids));
      fetchSavedDrafts();
      fetchDocuments();
    }
    return { ids, error };
  };

  // Submit a Single Draft Document for Reviewer Approval
  const handleSubmitSingleDraftApproval = async (index: number) => {
    if (!activeDraftSession) return;
    if (isViewer) {
      alert("Permission Denied: Viewer role is read-only.");
      return;
    }

    const draft = activeDraftSession.drafts[index];
    if (!draft) return;

    setSubmittingDocId(draft.document_id);
    try {
      const { ids, error } = await submitDraftItems([index]);
      if (error) {
        alert(`Failed to submit for approval: ${error}`);
      } else {
        alert(`✅ Approval request ${ids[index]} created for "${draft.doc_title}"! Reviewer can now approve it.`);
      }
    } finally {
      setSubmittingDocId(null);
    }
  };

  // Submit All Unsubmitted Drafts
  const handleSubmitAllForApproval = async () => {
    if (!activeDraftSession) return;
    if (isViewer) {
      alert("Permission Denied: Viewer role is read-only.");
      return;
    }

    const pending = activeDraftSession.drafts.map((d, i) => (d.submitted ? -1 : i)).filter(i => i >= 0);
    if (pending.length === 0) return;

    setIsSubmittingAll(true);
    try {
      const { ids, error } = await submitDraftItems(pending);
      const requestIds = Object.values(ids);
      if (error) {
        alert(`Failed to submit for approval: ${error}${requestIds.length ? `\n\nSubmitted before the error: ${requestIds.join(', ')}` : ''}`);
        return;
      }
      setActiveTab('my-requests');
      alert(`✅ Submitted all ${requestIds.length} document change requests for Reviewer Approval!\n\nRequest IDs: ${requestIds.join(', ')}`);
    } finally {
      setIsSubmittingAll(false);
    }
  };

  const handleReview = async (decision: 'approve' | 'reject') => {
    if (!selectedRequest) return;
    const reason = rejectionReason.trim();
    if (decision === 'reject' && !reason) {
      alert('Please explain why the request is being rejected.');
      return;
    }
    setIsReviewing(true);
    try {
      const res = await fetch(`${API_BASE}/api/change-requests/${selectedRequest.id}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: currentUser,
          decision: decision,
          rejection_reason: decision === 'reject' ? reason : undefined,
        }),
      });

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        alert(`Failed to ${decision} ${selectedRequest.request_id}: ${errorData.detail || res.statusText}`);
        return;
      }
      setIsRejecting(false);
      setRejectionReason('');

      const docRes = await fetch(`${API_BASE}/api/documents/${selectedRequest.document_id}`);
      const updatedDoc = await docRes.json();
      if (selectedDoc?.id === selectedRequest.document_id) {
        setSelectedDoc(updatedDoc);
      }
      fetchChangeRequests();
      fetchAuditLogs(selectedRequest.document_id);
      fetchSavedDrafts();
      fetchReleases();
      fetchApprovedRequests();
      setSelectedRequest(null);
      setDiffLines([]);
      fetchDocuments();
    } catch (err) {
      console.error(err);
    } finally {
      setIsReviewing(false);
    }
  };

  const filteredQueue = changeRequests.filter(
    r => reviewQueueFilter === 'all' || r.status === reviewQueueFilter
  );

  const CATEGORY_ORDER = ['Business', 'Architecture', 'User Guides', 'Operations'];

  const groupByCategory = <T extends { category: string }>(items: T[]) => {
    const groups = items.reduce((acc, item) => {
      const cat = item.category || 'Operations';
      if (!acc[cat]) acc[cat] = [];
      acc[cat].push(item);
      return acc;
    }, {} as Record<string, T[]>);
    const categories = Object.keys(groups).sort(
      (a, b) => CATEGORY_ORDER.indexOf(a) - CATEGORY_ORDER.indexOf(b)
    );
    return { groups, categories };
  };

  const selectedProject = projects.find(p => p.id === selectedDoc?.project_id) || null;

  // A draft is stale when the document changed after the draft was generated against it
  const isDraftStale = (item?: DraftPatchItem) => {
    const liveDoc = item && documents.find(d => d.id === item.document_id);
    return !!liveDoc && liveDoc.current_content !== item!.original_content;
  };
  const currentDraftItem = activeDraftSession?.drafts[selectedDraftIndex];
  const currentDraftIsStale = isDraftStale(currentDraftItem);
  const isSavedDraftOpen = !!activeDraftSession?.from_saved_draft_id;

  // Request Overview: every change of the current user, at its current lifecycle stage.
  // Rejected/withdrawn requests are not listed themselves: they continue as the draft they were reopened as.
  const projectNameOf = (projectId?: number | null) => projects.find(p => p.id === projectId)?.name || 'Unknown project';
  const toTime = (value?: string | null) => (value ? Date.parse(value) : 0);
  const overviewItems: OverviewItem[] = [
    ...savedDrafts.map((d): OverviewItem => ({
      key: `draft-${d.id}`,
      stage: 'Draft',
      documentId: d.document_id,
      docTitle: d.doc_title,
      projectName: projectNameOf(d.project_id),
      category: d.category,
      docType: d.doc_type,
      label: d.last_request_id ? `Draft (from ${d.last_request_id})` : 'Draft',
      prompt: d.prompt,
      stageDates: { 'Draft': d.updated_at },
      lastActivity: toTime(d.updated_at),
      isStale: d.is_stale,
      note: d.last_rejection_reason ? `Rejected by @${d.last_reviewed_by}: ${d.last_rejection_reason}` : undefined,
      open: () => handleOpenSavedDraft(d),
    })),
    ...myRequests
      .filter(r => r.status === 'pending' || r.status === 'approved' || r.status === 'published')
      .map((r): OverviewItem => {
        const stage: OverviewStage = r.status === 'pending' ? 'Pending Approval' : r.status === 'approved' ? 'Approved' : 'Published';
        const release = releases.find(rel => rel.change_request_id === r.id);
        return {
          key: `request-${r.id}`,
          stage,
          documentId: r.document_id,
          docTitle: r.doc_title || 'Document',
          projectName: r.project_name || 'Unknown project',
          category: r.category || '',
          docType: r.doc_type || '',
          label: r.request_id,
          prompt: r.prompt,
          stageDates: { 'Pending Approval': r.created_at, 'Approved': r.reviewed_at, 'Published': r.published_at },
          lastActivity: Math.max(toTime(r.created_at), toTime(r.reviewed_at), toTime(r.published_at)),
          isStale: r.is_stale,
          note: stage === 'Published' ? `Published as v${r.published_version}` : undefined,
          open: () => {
            if (stage === 'Approved') handleOpenApproved(r);
            else if (stage === 'Published' && release) handleOpenRelease(release);
            else { setMyRequestsFilter('pending'); setActiveTab('my-requests'); }
          },
        };
      }),
  ];
  const visibleOverviewItems = overviewItems.filter(i => overviewShowPublished || i.stage !== 'Published');
  // Group by project > document, most recently active first
  const overviewGroups = Object.values(
    visibleOverviewItems.reduce((acc, item) => {
      const key = `${item.projectName}|${item.documentId}`;
      (acc[key] ||= { projectName: item.projectName, documentId: item.documentId, docTitle: item.docTitle,
                      category: item.category, docType: item.docType, items: [] as OverviewItem[] }).items.push(item);
      return acc;
    }, {} as Record<string, { projectName: string; documentId: number; docTitle: string; category: string; docType: string; items: OverviewItem[] }>)
  )
    .map(g => ({ ...g, items: g.items.sort((a, b) => b.lastActivity - a.lastActivity) }))
    .sort((a, b) => a.projectName.localeCompare(b.projectName) || b.items[0].lastActivity - a.items[0].lastActivity);
  // While an approved change is open, its only actions are Publish and Create New Draft: hide request generation
  const isApprovedViewOpen = !!openApproved && openApproved.document_id === selectedDoc?.id;
  const unseenReleaseCount = releases.filter(r => releaseTime(r) > releasesSeenId).length;

  // Category filter for AI drafting only offers categories of the selected document's project
  const selectedProjectDocs = documents.filter(d => d.project_id === selectedDoc?.project_id);
  const availableCategories = groupByCategory(selectedProjectDocs).categories;
  // The reference document is read-only context, so the backend never proposes changes to it
  const docsInScope = (selectedCategories.length > 0
    ? selectedProjectDocs.filter(d => selectedCategories.includes(d.category))
    : selectedProjectDocs
  ).filter(d => d.id !== referenceDocId);
  const referenceDoc = documents.find(d => d.id === referenceDocId) || null;
  const manualDocs = selectedProjectDocs.filter(d => manualDocIds.includes(d.id));
  const nothingToUpdate = discoveryMode === 'multi' && manualDocIds.length === 0 && (!aiDiscovery || docsInScope.length === 0);
  const toggleManualDoc = (id: number) =>
    setManualDocIds(ids => (ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id]));
  const referenceConflict = discoveryMode === 'single' && referenceDocId !== null && referenceDocId === selectedDoc?.id;

  const toggleCategory = (category: string) => {
    setSelectedCategories(prev => {
      const next = prev.includes(category) ? prev.filter(c => c !== category) : [...prev, category];
      // Selecting every category is the same as "All"
      return next.length === availableCategories.length ? [] : next;
    });
  };

  return (
    <div className="flex h-screen bg-slate-900 text-slate-100 font-sans">
      {/* Sidebar: Brand 'DocuForge' without 'AI' */}
      <aside className="w-84 border-r border-slate-800 bg-slate-950 flex flex-col w-80">
        <div className="p-4 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg bg-blue-600 flex items-center justify-center shadow-md shadow-blue-500/20">
              <Layers className="w-4 h-4 text-white" />
            </div>
            <div>
              <h1 className="font-bold text-base text-white tracking-tight">DocuForge</h1>
              <div className="text-[10px] text-slate-400">Enterprise Documentation & Governance</div>
            </div>
          </div>
          <span className="text-[10px] bg-slate-800 text-slate-300 border border-slate-700 px-2 py-0.5 rounded-full font-mono">
            v3.0
          </span>
        </div>

        {/* User Role Switcher */}
        <div className="p-3 bg-slate-900/60 border-b border-slate-800">
          <label className="text-[11px] text-slate-400 block mb-1 font-semibold flex items-center gap-1">
            <Shield className="w-3.5 h-3.5 text-amber-400" /> Active Role (RBAC):
          </label>
          <select 
            value={currentUser} 
            onChange={(e) => {
              setCurrentUser(e.target.value as Username);
              setActiveDraftSession(null);
              setLastSubmittedRequestIds([]);
              setIsRejecting(false);
              setRejectionReason('');
              const newRole = roleOf(e.target.value);
              if (newRole === 'viewer' && (activeTab === 'my-requests' || activeTab === 'overview')) {
                setActiveTab('content');
              }
              if (newRole === 'viewer' && activeTab === 'audit') {
                setActiveTab('content');
              }
              if (newRole !== 'admin') {
                if (activeTab === 'requests') setActiveTab('content');
                setSelectedRequest(null);
                setDiffLines([]);
              }
            }}
            className="w-full bg-slate-800 text-xs rounded px-2.5 py-1.5 border border-slate-700 text-slate-200 outline-none focus:border-blue-500"
          >
            {USER_ACCOUNTS.map(u => (
              <option key={u.username} value={u.username}>{u.username} (Role: {ROLE_DESCRIPTIONS[u.role]})</option>
            ))}
          </select>
          {isViewer && (
            <div className="mt-2 text-[10px] bg-slate-800/80 text-amber-400 p-1.5 rounded flex items-center gap-1 border border-amber-900/40">
              <Eye className="w-3 h-3 flex-shrink-0" />
              <span>Viewer Role: Read-only access enabled. Change request features are disabled.</span>
            </div>
          )}
        </div>

        {/* Projects > Categories > Documents */}
        <div className="flex-1 overflow-y-auto p-3 space-y-3">
          <div className="flex items-center justify-between px-1">
            <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Projects</span>
            {isAdmin ? (
              <button
                onClick={handleCreateProject}
                disabled={isCreatingProject}
                className="text-[11px] text-blue-400 hover:text-blue-300 disabled:opacity-50 flex items-center gap-1"
              >
                {isCreatingProject
                  ? <RefreshCw className="w-3 h-3 animate-spin" />
                  : <FolderPlus className="w-3.5 h-3.5" />}
                New Project
              </button>
            ) : (
              <span className="text-[10px] text-slate-500 font-mono">{documents.length} docs</span>
            )}
          </div>

          {projects.map((project) => {
            const { groups, categories } = groupByCategory(documents.filter(d => d.project_id === project.id));
            const isProjectCollapsed = collapsedProjects[project.id];
            const isActiveProject = selectedDoc?.project_id === project.id;
            return (
              <div key={project.id} className="space-y-1.5">
                <div className="flex items-center gap-1">
                <button
                  onClick={() => setCollapsedProjects(prev => ({ ...prev, [project.id]: !prev[project.id] }))}
                  className={`flex-1 min-w-0 flex items-center justify-between px-2.5 py-2 text-xs font-bold rounded-md border transition ${
                    isActiveProject
                      ? 'text-white bg-slate-800/80 border-slate-700'
                      : 'text-slate-300 hover:text-white bg-slate-900 border-slate-800'
                  }`}
                >
                  <span className="flex items-center gap-1.5 truncate">
                    {isProjectCollapsed
                      ? <Folder className="w-4 h-4 text-blue-400 flex-shrink-0" />
                      : <FolderOpen className="w-4 h-4 text-blue-400 flex-shrink-0" />}
                    <span className="truncate">{project.name}</span>
                  </span>
                  <div className="flex items-center gap-1.5 text-[10px] text-slate-500 font-mono font-normal">
                    <span>{project.document_count}</span>
                    {isProjectCollapsed ? <ChevronRight className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                  </div>
                </button>
                {isAdmin && projects.length > 1 && (
                  <button
                    onClick={() => handleDeleteProject(project)}
                    title={`Delete ${project.name}`}
                    aria-label={`Delete ${project.name}`}
                    className="p-1.5 rounded-md text-slate-500 hover:text-rose-400 hover:bg-rose-950/60 transition flex-shrink-0"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
                </div>

                {!isProjectCollapsed && (
                  <div className="space-y-2 pl-3 border-l border-slate-800 ml-2">
                    {categories.map((categoryName) => {
                      const docs = groups[categoryName] || [];
                      const categoryKey = `${project.id}:${categoryName}`;
                      const isCollapsed = collapsedCategories[categoryKey];
                      return (
                        <div key={categoryKey} className="space-y-1">
                          <button
                            onClick={() => setCollapsedCategories(prev => ({ ...prev, [categoryKey]: !prev[categoryKey] }))}
                            className="w-full flex items-center justify-between px-2.5 py-1.5 text-xs font-semibold text-slate-300 hover:text-white bg-slate-900/50 rounded-md border border-slate-800/80 transition"
                          >
                            <span className="flex items-center gap-1.5 truncate">
                              {CATEGORY_ICONS[categoryName] || <Folder className="w-3.5 h-3.5 text-blue-400" />}
                              <span className="truncate">{categoryName}</span>
                            </span>
                            <div className="flex items-center gap-1.5 text-[10px] text-slate-500 font-mono">
                              <span>{docs.length}</span>
                              {isCollapsed ? <ChevronRight className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                            </div>
                          </button>

                          {!isCollapsed && (
                            <div className="space-y-1 pl-2 pt-0.5">
                              {docs.map((doc) => {
                                const isSelected = selectedDoc?.id === doc.id;
                                return (
                                  <button
                                    key={doc.id}
                                    onClick={() => handleSelectDocument(doc)}
                                    className={`w-full text-left p-2 rounded-lg text-xs flex flex-col gap-0.5 transition ${
                                      isSelected
                                        ? 'bg-blue-600/20 text-blue-300 border border-blue-500/40 font-medium'
                                        : 'hover:bg-slate-900 text-slate-300 border border-transparent'
                                    }`}
                                  >
                                    <div className="flex items-center justify-between w-full">
                                      <span className="text-[9px] font-mono px-1.5 py-0.2 bg-slate-800 text-slate-400 rounded">
                                        {doc.doc_type}
                                      </span>
                                      <span className="text-[9px] text-slate-500 font-mono">v{doc.version}</span>
                                    </div>
                                    <div className="font-medium truncate text-slate-200 mt-0.5">{doc.title}</div>
                                  </button>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      );
                    })}

                    {/* Drafts folder: the owner's saved drafts, organised by the same categories */}
                    {canSubmitRequests && (() => {
                      const projectDrafts = savedDrafts.filter(d => d.project_id === project.id);
                      const draftGroups = groupByCategory(projectDrafts);
                      const isDraftsCollapsed = collapsedDraftFolders[project.id];
                      return (
                        <div className="space-y-1 pt-1 border-t border-dashed border-slate-800">
                          <button
                            onClick={() => setCollapsedDraftFolders(prev => ({ ...prev, [project.id]: !prev[project.id] }))}
                            className="w-full flex items-center justify-between px-2.5 py-1.5 text-xs font-semibold text-amber-200/90 hover:text-amber-100 bg-amber-950/20 rounded-md border border-amber-900/40 transition"
                          >
                            <span className="flex items-center gap-1.5 truncate">
                              <FilePen className="w-3.5 h-3.5 text-amber-400" />
                              <span className="truncate">Drafts</span>
                            </span>
                            <div className="flex items-center gap-1.5 text-[10px] text-amber-200/60 font-mono">
                              <span>{projectDrafts.length}</span>
                              {isDraftsCollapsed ? <ChevronRight className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                            </div>
                          </button>

                          {!isDraftsCollapsed && (
                            <div className="space-y-1.5 pl-2 pt-0.5">
                              {projectDrafts.length === 0 && (
                                <div className="text-[10px] text-slate-600 px-2 py-1">No saved drafts. Generate a draft and click "Save Draft".</div>
                              )}
                              {draftGroups.categories.map((categoryName) => {
                                const categoryKey = `${project.id}:drafts:${categoryName}`;
                                const isCollapsed = collapsedCategories[categoryKey];
                                const drafts = draftGroups.groups[categoryName] || [];
                                return (
                                  <div key={categoryKey} className="space-y-1">
                                    <button
                                      onClick={() => setCollapsedCategories(prev => ({ ...prev, [categoryKey]: !prev[categoryKey] }))}
                                      className="w-full flex items-center justify-between px-2.5 py-1 text-[11px] font-semibold text-slate-400 hover:text-white rounded-md transition"
                                    >
                                      <span className="flex items-center gap-1.5 truncate">
                                        {CATEGORY_ICONS[categoryName] || <Folder className="w-3.5 h-3.5 text-blue-400" />}
                                        <span className="truncate">{categoryName}</span>
                                      </span>
                                      <div className="flex items-center gap-1.5 text-[10px] text-slate-500 font-mono">
                                        <span>{drafts.length}</span>
                                        {isCollapsed ? <ChevronRight className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                                      </div>
                                    </button>
                                    {!isCollapsed && (
                                      <div className="space-y-1 pl-2">
                                        {drafts.map((draft) => {
                                          const isOpen = activeDraftSession?.from_saved_draft_id === draft.id;
                                          return (
                                            <div key={draft.id} className="flex items-start gap-1">
                                              <button
                                                onClick={() => handleOpenSavedDraft(draft)}
                                                className={`flex-1 min-w-0 text-left p-2 rounded-lg text-xs flex flex-col gap-0.5 transition ${
                                                  isOpen
                                                    ? 'bg-amber-600/15 text-amber-200 border border-amber-500/40 font-medium'
                                                    : 'hover:bg-slate-900 text-slate-300 border border-transparent'
                                                }`}
                                              >
                                                <div className="flex items-center justify-between w-full gap-1">
                                                  <span className="text-[9px] font-mono px-1.5 py-0.2 bg-slate-800 text-slate-400 rounded truncate">
                                                    {draft.doc_type}
                                                  </span>
                                                  <span className="text-[9px] text-slate-500 flex-shrink-0">
                                                    {draft.updated_at ? new Date(draft.updated_at).toLocaleDateString() : ''}
                                                  </span>
                                                </div>
                                                <div className="font-medium truncate text-slate-200 mt-0.5">
                                                  <span className="text-amber-400 font-semibold">[Draft]</span> {draft.doc_title}
                                                </div>
                                                {(draft.is_stale || draft.last_rejection_reason || draft.ai_fallback) && (
                                                  <div className="flex gap-1 mt-0.5">
                                                    {draft.ai_fallback && (
                                                      <span className="text-[9px] px-1.5 rounded bg-rose-950 text-rose-300 border border-rose-800">AI unavailable</span>
                                                    )}
                                                    {draft.is_stale && (
                                                      <span className="text-[9px] px-1.5 rounded bg-amber-950 text-amber-300 border border-amber-800">Outdated</span>
                                                    )}
                                                    {draft.last_rejection_reason && (
                                                      <span className="text-[9px] px-1.5 rounded bg-rose-950 text-rose-300 border border-rose-800">Rejected</span>
                                                    )}
                                                  </div>
                                                )}
                                              </button>
                                              <button
                                                onClick={() => handleDeleteSavedDraft(draft)}
                                                title="Delete draft"
                                                aria-label={`Delete draft for ${draft.doc_title}`}
                                                className="p-1.5 mt-1 rounded-md text-slate-600 hover:text-rose-400 hover:bg-rose-950/60 transition flex-shrink-0"
                                              >
                                                <X className="w-3 h-3" />
                                              </button>
                                            </div>
                                          );
                                        })}
                                      </div>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      );
                    })()}

                    {/* Approved folder: the requester's approved changes waiting to be published */}
                    {canSubmitRequests && (() => {
                      const projectApproved = approvedRequests.filter(r => r.project_id === project.id);
                      const isApprovedCollapsed = collapsedApprovedFolders[project.id];
                      const approvedGroups = groupByCategory(projectApproved.map(r => ({ ...r, category: r.category || 'Operations' })));
                      return (
                        <div className="space-y-1 pt-1">
                          <button
                            onClick={() => setCollapsedApprovedFolders(prev => ({ ...prev, [project.id]: !prev[project.id] }))}
                            className="w-full flex items-center justify-between px-2.5 py-1.5 text-xs font-semibold text-sky-200/90 hover:text-sky-100 bg-sky-950/20 rounded-md border border-sky-900/40 transition"
                          >
                            <span className="flex items-center gap-1.5 truncate">
                              <BadgeCheck className="w-3.5 h-3.5 text-sky-400" />
                              <span className="truncate">Approved</span>
                            </span>
                            <div className="flex items-center gap-1.5 text-[10px] text-sky-200/60 font-mono">
                              <span>{projectApproved.length}</span>
                              {isApprovedCollapsed ? <ChevronRight className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                            </div>
                          </button>

                          {!isApprovedCollapsed && (
                            <div className="space-y-1.5 pl-2 pt-0.5">
                              {projectApproved.length === 0 && (
                                <div className="text-[10px] text-slate-600 px-2 py-1">No approved changes waiting to be published.</div>
                              )}
                              {approvedGroups.categories.map((categoryName) => {
                                const categoryKey = `${project.id}:approved:${categoryName}`;
                                const isCollapsed = collapsedCategories[categoryKey];
                                const items = approvedGroups.groups[categoryName] || [];
                                return (
                                  <div key={categoryKey} className="space-y-1">
                                    <button
                                      onClick={() => setCollapsedCategories(prev => ({ ...prev, [categoryKey]: !prev[categoryKey] }))}
                                      className="w-full flex items-center justify-between px-2.5 py-1 text-[11px] font-semibold text-slate-400 hover:text-white rounded-md transition"
                                    >
                                      <span className="flex items-center gap-1.5 truncate">
                                        {CATEGORY_ICONS[categoryName] || <Folder className="w-3.5 h-3.5 text-blue-400" />}
                                        <span className="truncate">{categoryName}</span>
                                      </span>
                                      <div className="flex items-center gap-1.5 text-[10px] text-slate-500 font-mono">
                                        <span>{items.length}</span>
                                        {isCollapsed ? <ChevronRight className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                                      </div>
                                    </button>
                                    {!isCollapsed && (
                                      <div className="space-y-1 pl-2">
                                        {items.map((req) => {
                                          const isOpen = openApproved?.id === req.id;
                                          return (
                                            <button
                                              key={req.id}
                                              onClick={() => handleOpenApproved(req)}
                                              className={`w-full text-left p-2 rounded-lg text-xs flex flex-col gap-0.5 transition ${
                                                isOpen
                                                  ? 'bg-sky-600/15 text-sky-200 border border-sky-500/40 font-medium'
                                                  : 'hover:bg-slate-900 text-slate-300 border border-transparent'
                                              }`}
                                            >
                                              <div className="flex items-center justify-between w-full gap-1">
                                                <span className="text-[9px] font-mono px-1.5 py-0.2 bg-slate-800 text-slate-300 rounded">{req.request_id}</span>
                                                <span className="text-[9px] text-slate-500 flex-shrink-0">
                                                  {req.reviewed_at ? new Date(req.reviewed_at).toLocaleDateString() : ''}
                                                </span>
                                              </div>
                                              <div className="font-medium truncate text-slate-200 mt-0.5">
                                                <span className="text-sky-300 font-semibold">[Approved]</span> {req.doc_title}
                                              </div>
                                              {req.is_stale && (
                                                <span className="text-[9px] px-1.5 rounded bg-amber-950 text-amber-300 border border-amber-800 w-fit mt-0.5">Outdated</span>
                                              )}
                                            </button>
                                          );
                                        })}
                                      </div>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      );
                    })()}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </aside>

      {/* Main Workspace */}
      <main className="flex-1 flex flex-col bg-slate-900 overflow-hidden">
        {selectedDoc ? (
          <>
            {/* Header */}
            <header className="h-16 border-b border-slate-800 px-6 flex items-center justify-between bg-slate-950/40">
              <div className="flex items-center gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    {selectedProject && (
                      <>
                        <span className="text-xs font-semibold text-slate-300 flex items-center gap-1">
                          <FolderOpen className="w-3.5 h-3.5 text-blue-400" />
                          {selectedProject.name}
                        </span>
                        <span className="text-slate-600">/</span>
                      </>
                    )}
                    <span className="text-xs font-semibold text-blue-400 flex items-center gap-1">
                      {CATEGORY_ICONS[selectedDoc.category]}
                      {selectedDoc.category}
                    </span>
                    <span className="text-slate-600">•</span>
                    <span className="text-xs bg-slate-800 text-slate-300 px-2 py-0.5 rounded font-mono">
                      {selectedDoc.doc_type}
                    </span>
                    <span className="text-xs bg-slate-800 text-slate-300 px-2 py-0.5 rounded font-mono">
                      Version {selectedDoc.version}
                    </span>
                  </div>
                  <h2 className="text-base font-bold text-white mt-0.5">
                    {isSavedDraftOpen && activeTab === 'content' && <span className="text-amber-400">[Draft] </span>}
                    {isApprovedViewOpen && activeTab === 'content' && <span className="text-sky-300">[Approved] </span>}
                    {selectedDoc.title}
                  </h2>
                </div>
              </div>

              {/* Navigation Tabs */}
              <div className="flex items-center gap-1 bg-slate-800/80 p-1 rounded-lg border border-slate-700">
                <button
                  onClick={() => setActiveTab('content')}
                  className={`px-3 py-1 text-xs font-medium rounded-md transition ${
                    activeTab === 'content' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-white'
                  }`}
                >
                  Document Content
                </button>
                {isAdmin && (
                  <button
                    onClick={() => setActiveTab('requests')}
                    className={`px-3 py-1 text-xs font-medium rounded-md transition flex items-center gap-1 ${
                      activeTab === 'requests' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    <GitPullRequest className="w-3.5 h-3.5" />
                    Reviewer Queue ({changeRequests.filter(r => r.status === 'pending').length})
                  </button>
                )}
                {canSubmitRequests && (
                  <button
                    onClick={() => setActiveTab('my-requests')}
                    className={`px-3 py-1 text-xs font-medium rounded-md transition flex items-center gap-1 ${
                      activeTab === 'my-requests' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    <ClipboardList className="w-3.5 h-3.5" />
                    My Requests
                  </button>
                )}
                {canSubmitRequests && (
                  <button
                    onClick={() => setActiveTab('overview')}
                    className={`px-3 py-1 text-xs font-medium rounded-md transition flex items-center gap-1 ${
                      activeTab === 'overview' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    <ListChecks className="w-3.5 h-3.5" />
                    Request Overview
                  </button>
                )}
                {!isViewer && (
                  <button
                    onClick={() => setActiveTab('audit')}
                    className={`px-3 py-1 text-xs font-medium rounded-md transition flex items-center gap-1 ${
                      activeTab === 'audit' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    <History className="w-3.5 h-3.5" />
                    Audit Trail
                  </button>
                )}
                {/* New Releases: rightmost; green with the unseen count when there are releases the viewer hasn't seen */}
                <button
                  onClick={() => setActiveTab('releases')}
                  aria-label={unseenReleaseCount > 0 ? `New Releases, ${unseenReleaseCount} unseen` : 'New Releases'}
                  className={`px-3 py-1 text-xs font-medium rounded-md transition flex items-center gap-1 ${
                    activeTab === 'releases'
                      ? 'bg-blue-600 text-white'
                      : unseenReleaseCount > 0
                        ? 'bg-emerald-600 text-white hover:bg-emerald-500 font-semibold'
                        : 'text-slate-400 hover:text-white'
                  }`}
                >
                  <Megaphone className="w-3.5 h-3.5" />
                  New Releases
                  {unseenReleaseCount > 0 && activeTab !== 'releases' && ` (${unseenReleaseCount})`}
                </button>
              </div>
            </header>

            {/* Main Content Area */}
            <div className="flex-1 overflow-y-auto p-6">
              {activeTab === 'content' && (
                <div className="max-w-4xl mx-auto space-y-6">
                  {/* Approved change opened from the Approved folder: publish it or turn it back into a draft */}
                  {isApprovedViewOpen && openApproved && (
                    <div className="bg-slate-950 border-2 border-sky-600/70 rounded-xl p-5 space-y-3">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <h3 className="text-sm font-bold text-white flex items-center gap-2 flex-wrap">
                            <BadgeCheck className="w-4 h-4 text-sky-400" />
                            <span className="text-sky-300">[Approved]</span> Ready to publish as v{selectedDoc.version + 1}
                            <span className="text-[10px] font-mono font-semibold text-slate-200 bg-slate-900 border border-slate-700 px-1.5 py-0.5 rounded">
                              {openApproved.request_id}
                            </span>
                            {openApproved.ai_fallback && <AiFallbackBadge />}
                            {openApproved.manually_edited && <ManuallyEditedBadge />}
                          </h3>
                          <p className="text-[11px] text-slate-400 mt-1">
                            Approved by @{openApproved.reviewed_by} · {formatTimestamp(openApproved.reviewed_at)} · Requested by @{openApproved.requested_by}
                          </p>
                        </div>
                        <button
                          onClick={() => setOpenApproved(null)}
                          className="text-xs text-slate-500 hover:text-slate-300 flex-shrink-0"
                        >
                          ✕ Close
                        </button>
                      </div>

                      {openApproved.is_stale && (
                        <div className="text-[11px] text-amber-200 bg-amber-950/40 border border-amber-800 rounded px-2.5 py-1.5 flex items-start gap-2">
                          <AlertCircle className="w-3.5 h-3.5 text-amber-400 mt-0.5 flex-shrink-0" />
                          <span>
                            <b>Outdated.</b> This document changed (now v{selectedDoc.version}) after the change was approved, so publishing would overwrite the newer changes.
                            Create a new draft from it and regenerate against the current version.
                          </span>
                        </div>
                      )}

                      <div className="text-[11px] text-slate-400 space-y-0.5">
                        <div><b className="text-slate-300">Request:</b> {openApproved.prompt}</div>
                        {(openApproved.refinements || []).map((r, i) => (
                          <div key={i} className="pl-2">↳ <b className="text-slate-300">Follow-up {i + 1}:</b> {r}</div>
                        ))}
                        {openApproved.reference_label && (
                          <div className="text-blue-300/90 flex items-center gap-1"><Link2 className="w-3 h-3" /> Reference: {openApproved.reference_label}</div>
                        )}
                      </div>

                      {openApproved.ai_summary && (
                        <p className="text-xs text-slate-300 bg-slate-900 p-2 rounded border border-slate-800">
                          <b>Summary of Changes:</b> {openApproved.ai_summary}
                        </p>
                      )}

                      <div className="bg-slate-900 border border-slate-800 rounded-lg p-3 font-mono text-xs max-h-72 overflow-y-auto">
                        {approvedDiff.length === 0 && <div className="text-slate-500">Loading changes...</div>}
                        {approvedDiff.map((line, idx) => (
                          <div
                            key={idx}
                            className={`py-0.5 px-2 rounded ${
                              line.type === 'added' ? 'bg-emerald-950/70 text-emerald-300 border-l-2 border-emerald-500' :
                              line.type === 'removed' ? 'bg-rose-950/70 text-rose-300 border-l-2 border-rose-500 line-through' :
                              'text-slate-400'
                            }`}
                          >
                            <span className="inline-block w-4 text-slate-600 select-none">
                              {line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' '}
                            </span>
                            {line.text}
                          </div>
                        ))}
                      </div>

                      <div className="flex items-center justify-end gap-2 pt-1">
                        <button
                          onClick={() => handleApprovedAction('redraft')}
                          disabled={approvedAction !== null}
                          className="bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-amber-200 border border-amber-900/60 text-xs font-semibold px-3 py-1.5 rounded-md flex items-center gap-1.5 transition"
                        >
                          {approvedAction === 'redraft' ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <FilePen className="w-3.5 h-3.5" />}
                          Create New Draft
                        </button>
                        <button
                          onClick={() => handleApprovedAction('publish')}
                          disabled={approvedAction !== null || openApproved.is_stale}
                          title={openApproved.is_stale ? 'The document changed after this was approved' : undefined}
                          className="bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-xs font-bold px-3 py-1.5 rounded-md flex items-center gap-1.5 transition shadow"
                        >
                          {approvedAction === 'publish' ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Rocket className="w-3.5 h-3.5" />}
                          Publish
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Changes introduced by the release opened from the New Releases feed */}
                  {openRelease && openRelease.document_id === selectedDoc.id && (
                    <div className="bg-slate-950 border-2 border-emerald-600/70 rounded-xl p-5 space-y-3">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <h3 className="text-sm font-bold text-white flex items-center gap-2 flex-wrap">
                            <Megaphone className="w-4 h-4 text-emerald-400" />
                            Released as v{openRelease.version}
                            <span className="text-[10px] font-mono font-semibold text-slate-200 bg-slate-900 border border-slate-700 px-1.5 py-0.5 rounded">
                              {openRelease.request_id}
                            </span>
                            {openRelease.manually_edited && <ManuallyEditedBadge />}
                          </h3>
                          <p className="text-[11px] text-slate-400 mt-1">
                            Published by @{openRelease.published_by} · {formatTimestamp(openRelease.published_at)}
                            {openRelease.approved_by && <> · Approved by @{openRelease.approved_by}</>} · Requested by @{openRelease.requested_by}
                          </p>
                        </div>
                        <button
                          onClick={() => setOpenRelease(null)}
                          className="text-xs text-slate-500 hover:text-slate-300 flex-shrink-0"
                        >
                          ✕ Hide changes
                        </button>
                      </div>

                      {openRelease.current_version > openRelease.version && (
                        <div className="text-[11px] text-amber-200 bg-amber-950/40 border border-amber-800 rounded px-2.5 py-1.5">
                          This document has since been updated to v{openRelease.current_version}. The changes below are from v{openRelease.version}; the content further down is the latest version.
                        </div>
                      )}

                      {openRelease.ai_summary && (
                        <p className="text-xs text-slate-300 bg-slate-900 p-2 rounded border border-slate-800">
                          <b>Summary of Changes:</b> {openRelease.ai_summary}
                        </p>
                      )}

                      <div className="bg-slate-900 border border-slate-800 rounded-lg p-3 font-mono text-xs max-h-72 overflow-y-auto">
                        {releaseDiff.length === 0 && <div className="text-slate-500">Loading changes...</div>}
                        {releaseDiff.map((line, idx) => (
                          <div
                            key={idx}
                            className={`py-0.5 px-2 rounded ${
                              line.type === 'added' ? 'bg-emerald-950/70 text-emerald-300 border-l-2 border-emerald-500' :
                              line.type === 'removed' ? 'bg-rose-950/70 text-rose-300 border-l-2 border-rose-500 line-through' :
                              'text-slate-400'
                            }`}
                          >
                            <span className="inline-block w-4 text-slate-600 select-none">
                              {line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' '}
                            </span>
                            {line.text}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Markdown Preview Box */}
                  <div className="bg-slate-950 border border-slate-800 rounded-xl p-6 shadow-sm">
                    <pre className="text-sm font-mono text-slate-300 whitespace-pre-wrap leading-relaxed">
                      {selectedDoc.current_content}
                    </pre>
                  </div>

                  {/* Confirmation of the latest submission with its request IDs */}
                  {lastSubmittedRequestIds.length > 0 && !isApprovedViewOpen && (
                    <div className="bg-emerald-950/60 border border-emerald-800 rounded-xl p-4 flex items-start justify-between gap-3">
                      <div className="flex items-start gap-2">
                        <CheckCircle className="w-4 h-4 text-emerald-400 mt-0.5 flex-shrink-0" />
                        <div>
                          <div className="text-xs font-semibold text-emerald-300">Submitted for approval</div>
                          <div className="text-[11px] text-slate-300 mt-1">
                            Request ID{lastSubmittedRequestIds.length > 1 ? 's' : ''}:{' '}
                            {lastSubmittedRequestIds.map(id => (
                              <span key={id} className="font-mono text-emerald-300 bg-slate-900 border border-emerald-900 px-1.5 py-0.5 rounded mr-1.5">{id}</span>
                            ))}
                          </div>
                          <button
                            onClick={() => setActiveTab('my-requests')}
                            className="text-[11px] text-blue-400 hover:underline mt-1.5"
                          >
                            Track status in My Requests →
                          </button>
                        </div>
                      </div>
                      <button
                        onClick={() => setLastSubmittedRequestIds([])}
                        className="text-xs text-slate-500 hover:text-slate-300"
                      >
                        ✕
                      </button>
                    </div>
                  )}

                  {/* TWO-STAGE PROPOSAL: DRAFT PREVIEW & IN-PLACE DRAFT EDITOR */}
                  {activeDraftSession && !isApprovedViewOpen && (
                    <div className="bg-slate-950 border-2 border-blue-500/80 rounded-xl p-5 shadow-2xl space-y-4">
                      <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                        <div className="flex items-center gap-2">
                          <Sparkles className="w-5 h-5 text-amber-400" />
                          <div>
                            <h3 className="text-sm font-bold text-white flex items-center gap-2">
                              {isSavedDraftOpen ? <><span className="text-amber-400">[Draft]</span> Saved Draft</> : 'Suggested Draft Updates'}
                              <span className="text-[10px] bg-blue-900/60 text-blue-300 px-2 py-0.5 rounded font-normal font-mono">
                                Interactive Editor & Individual Approval
                              </span>
                            </h3>
                            <p className="text-xs text-slate-400">{activeDraftSession.ai_discovery_analysis}</p>
                            {activeDraftSession.scanned_documents && (
                              <p className="text-[11px] text-slate-500 mt-1">
                                {activeDraftSession.discovery_source === 'single'
                                  ? 'Scope: this document only. '
                                  : <>Scope: {activeDraftSession.scope_categories?.length
                                      ? activeDraftSession.scope_categories.join(', ')
                                      : 'all categories'} · Scanned {activeDraftSession.scanned_documents.length} document{activeDraftSession.scanned_documents.length === 1 ? '' : 's'}: </>}
                                {activeDraftSession.discovery_source !== 'single' && (
                                  <span className="text-slate-400">{activeDraftSession.scanned_documents.map(d => d.doc_type).join(', ')}</span>
                                )}
                                {!!activeDraftSession.manual_documents?.length && (
                                  <span className="text-violet-300"> · Added manually: {activeDraftSession.manual_documents.map(d => d.doc_type).join(', ')}</span>
                                )}
                                {activeDraftSession.discovery_source === 'heuristic' && (
                                  <span className="text-rose-300"> · AI unavailable, documents chosen by keyword match</span>
                                )}
                              </p>
                            )}
                            {activeDraftSession.reference_label && (
                              <p className="text-[11px] text-blue-300/90 mt-0.5 flex items-center gap-1">
                                <Link2 className="w-3 h-3 flex-shrink-0" /> Reference: {activeDraftSession.reference_label}
                              </p>
                            )}
                          </div>
                        </div>
                        <button
                          onClick={() => { if (confirmDiscardUnsaved()) setActiveDraftSession(null); }}
                          className="text-xs text-slate-500 hover:text-slate-300"
                        >
                          {isSavedDraftOpen ? '✕ Close Draft' : hasUnsavedDrafts ? '✕ Discard Unsaved Drafts' : '✕ Close Drafts'}
                        </button>
                      </div>

                      {/* Draft Selection Tabs */}
                      <div className="flex items-center justify-between border-b border-slate-800/80 pb-2">
                        <div className="flex gap-2 overflow-x-auto pb-1">
                          {activeDraftSession.drafts.map((draft, idx) => (
                            <button
                              key={idx}
                              onClick={() => {
                                setSelectedDraftIndex(idx);
                                setEditedProposedText(draft.proposed_content);
                                setIsEditingDraft(false);
                              }}
                              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition flex items-center gap-1.5 ${
                                selectedDraftIndex === idx
                                  ? 'bg-blue-600 text-white shadow-md'
                                  : 'bg-slate-900 text-slate-400 hover:bg-slate-800'
                              } ${draft.submitted ? 'opacity-50 line-through' : ''}`}
                            >
                              <span>{draft.category} &gt; {draft.doc_type}</span>
                              {draft.saved_draft_id && !draft.submitted && <Bookmark className="w-3 h-3 text-amber-400" />}
                              {draft.ai_fallback && <AlertCircle className="w-3 h-3 text-rose-400" aria-label="AI unavailable" />}
                              {(draft.selected_by === 'manual' || draft.selected_by === 'both') && (
                                <Hand className="w-3 h-3 text-violet-300" aria-label="Added manually" />
                              )}
                              {draft.submitted && <Check className="w-3 h-3 text-emerald-400" />}
                            </button>
                          ))}
                        </div>

                        {/* Top Global Save-All & Submit-All Buttons */}
                        <div className="flex items-center gap-2 flex-shrink-0">
                        {!isSavedDraftOpen && (
                          <button
                            onClick={handleSaveAllDrafts}
                            disabled={isSavingAll || isEditingDraft || activeDraftSession.drafts.every(d => d.submitted || d.saved_draft_id)}
                            className="bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-amber-200 border border-amber-900/60 text-xs font-semibold px-3 py-1.5 rounded-md flex items-center gap-1.5 transition"
                          >
                            {isSavingAll ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Bookmark className="w-3.5 h-3.5" />}
                            Save All Drafts
                          </button>
                        )}
                        <button
                          onClick={handleSubmitAllForApproval}
                          disabled={isSubmittingAll || activeDraftSession.drafts.every(d => d.submitted)}
                          className="bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white text-xs font-bold px-3 py-1.5 rounded-md flex items-center gap-1.5 transition shadow"
                        >
                          {isSubmittingAll ? (
                            <>
                              <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                              Submitting All...
                            </>
                          ) : (
                            <>
                              <FileCheck className="w-3.5 h-3.5" />
                              Submit All for Approval
                            </>
                          )}
                        </button>
                        </div>
                      </div>

                      {/* Selected Draft Card */}
                      {activeDraftSession.drafts[selectedDraftIndex] && (
                        <div className="space-y-3 bg-slate-900/90 p-4 rounded-lg border border-slate-800">
                          <div className="flex items-center justify-between text-xs">
                            <div>
                              <span className="font-semibold text-slate-200">
                                Document: {activeDraftSession.drafts[selectedDraftIndex].doc_title}
                              </span>
                              <div className="text-blue-400 text-[11px] mt-0.5">
                                💡 {activeDraftSession.drafts[selectedDraftIndex].relevance_rationale}
                              </div>
                            </div>

                            {/* Individual Document "Request for Approval" Button */}
                            <div className="flex items-center gap-2">
                              {!isEditingDraft ? (
                                <button
                                  onClick={() => setIsEditingDraft(true)}
                                  className="bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs px-2.5 py-1.5 rounded flex items-center gap-1 border border-slate-700 transition"
                                >
                                  <Edit3 className="w-3.5 h-3.5 text-blue-400" /> Edit Draft
                                </button>
                              ) : (
                                <button
                                  onClick={handleSaveDraftEdit}
                                  className="bg-blue-600 hover:bg-blue-500 text-white text-xs px-2.5 py-1.5 rounded flex items-center gap-1 font-semibold transition"
                                >
                                  <Save className="w-3.5 h-3.5" /> Save Changes & Re-Diff
                                </button>
                              )}

                              {!activeDraftSession.drafts[selectedDraftIndex].submitted && (
                                activeDraftSession.drafts[selectedDraftIndex].saved_draft_id ? (
                                  <span className="bg-amber-950/60 text-amber-300 border border-amber-800 text-[11px] px-2.5 py-1 rounded flex items-center gap-1">
                                    <Bookmark className="w-3 h-3" /> Saved to Drafts
                                  </span>
                                ) : (
                                  <button
                                    onClick={() => handleSaveSingleDraft(selectedDraftIndex)}
                                    disabled={savingDraftIndex === selectedDraftIndex || isEditingDraft}
                                    title={isEditingDraft ? 'Save your edits first' : 'Save this draft to the project Drafts folder'}
                                    className="bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-amber-200 border border-amber-900/60 text-xs px-2.5 py-1.5 rounded flex items-center gap-1 transition"
                                  >
                                    {savingDraftIndex === selectedDraftIndex
                                      ? <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                                      : <Bookmark className="w-3.5 h-3.5" />}
                                    Save Draft
                                  </button>
                                )
                              )}

                              {!activeDraftSession.drafts[selectedDraftIndex].submitted ? (
                                <button
                                  onClick={() => handleSubmitSingleDraftApproval(selectedDraftIndex)}
                                  disabled={submittingDocId === activeDraftSession.drafts[selectedDraftIndex].document_id || currentDraftIsStale || isEditingDraft}
                                  title={currentDraftIsStale ? 'The document changed since this draft was generated' : undefined}
                                  className="bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-xs font-semibold px-3 py-1.5 rounded flex items-center gap-1.5 transition shadow"
                                >
                                  {submittingDocId === activeDraftSession.drafts[selectedDraftIndex].document_id ? (
                                    <>
                                      <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                                      Submitting...
                                    </>
                                  ) : (
                                    <>
                                      <CheckCircle className="w-3.5 h-3.5" />
                                      Request Approval for This Doc
                                    </>
                                  )}
                                </button>
                              ) : (
                                <span className="bg-emerald-950 text-emerald-400 border border-emerald-800 text-[11px] px-2.5 py-1 rounded flex items-center gap-1">
                                  <Check className="w-3 h-3" /> Submitted to Queue
                                  {activeDraftSession.drafts[selectedDraftIndex].request_id && (
                                    <span className="font-mono">· {activeDraftSession.drafts[selectedDraftIndex].request_id}</span>
                                  )}
                                </span>
                              )}
                            </div>
                          </div>

                          {currentDraftItem?.last_rejection_reason && !currentDraftItem.submitted && (
                            <div className="text-xs text-rose-200 bg-rose-950/40 p-2.5 rounded border border-rose-900 flex items-start gap-2">
                              <MessageSquare className="w-3.5 h-3.5 text-rose-400 mt-0.5 flex-shrink-0" />
                              <div>
                                <b>{currentDraftItem.last_request_id} was rejected by @{currentDraftItem.last_reviewed_by}:</b> {currentDraftItem.last_rejection_reason}
                                <div className="text-[11px] text-rose-300/70 mt-0.5">Revise the draft and submit it again.</div>
                              </div>
                            </div>
                          )}

                          {currentDraftItem?.ai_fallback && !currentDraftItem.submitted && (
                            <div className="text-xs text-rose-200 bg-rose-950/40 p-2.5 rounded border border-rose-800 flex items-center justify-between gap-3">
                              <div className="flex items-start gap-2">
                                <AlertCircle className="w-3.5 h-3.5 text-rose-400 mt-0.5 flex-shrink-0" />
                                <div>
                                  <b>The AI model was unavailable for this document.</b> This is a placeholder that only records your request; it does not apply it.
                                  {' '}{currentDraftItem.saved_draft_id ? 'Regenerate it or edit it manually.' : 'Generate the drafts again or edit it manually.'}
                                </div>
                              </div>
                              {currentDraftItem.saved_draft_id && !currentDraftIsStale && (
                                <button
                                  onClick={() => handleRegenerateDraft(selectedDraftIndex)}
                                  disabled={regeneratingDraftId === currentDraftItem.saved_draft_id}
                                  className="bg-rose-700 hover:bg-rose-600 disabled:opacity-50 text-white text-xs font-semibold px-3 py-1.5 rounded flex items-center gap-1.5 flex-shrink-0 transition"
                                >
                                  <RefreshCw className={`w-3.5 h-3.5 ${regeneratingDraftId === currentDraftItem.saved_draft_id ? 'animate-spin' : ''}`} />
                                  {regeneratingDraftId === currentDraftItem.saved_draft_id ? 'Regenerating...' : 'Regenerate'}
                                </button>
                              )}
                            </div>
                          )}

                          {currentDraftIsStale && !currentDraftItem?.submitted && (
                            <div className="text-xs text-amber-200 bg-amber-950/40 p-2.5 rounded border border-amber-800 flex items-center justify-between gap-3">
                              <div className="flex items-start gap-2">
                                <AlertCircle className="w-3.5 h-3.5 text-amber-400 mt-0.5 flex-shrink-0" />
                                <div>
                                  <b>The original document has changed</b>
                                  {currentDraftItem?.base_version !== undefined && selectedDoc && (
                                    <> (draft based on v{currentDraftItem.base_version}, now v{documents.find(d => d.id === currentDraftItem.document_id)?.version})</>
                                  )}.
                                  {' '}Submitting would overwrite the newer changes, so {currentDraftItem?.saved_draft_id
                                    ? 'regenerate this draft against the current version first.'
                                    : 'generate a new draft for the current version.'}
                                </div>
                              </div>
                              {currentDraftItem?.saved_draft_id && (
                                <button
                                  onClick={() => handleRegenerateDraft(selectedDraftIndex)}
                                  disabled={regeneratingDraftId === currentDraftItem.saved_draft_id}
                                  className="bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white text-xs font-semibold px-3 py-1.5 rounded flex items-center gap-1.5 flex-shrink-0 transition"
                                >
                                  <RefreshCw className={`w-3.5 h-3.5 ${regeneratingDraftId === currentDraftItem.saved_draft_id ? 'animate-spin' : ''}`} />
                                  {regeneratingDraftId === currentDraftItem.saved_draft_id ? 'Regenerating...' : 'Regenerate'}
                                </button>
                              )}
                            </div>
                          )}

                          <div className="text-xs text-slate-300 bg-slate-950 p-2.5 rounded border border-slate-800 flex items-start justify-between gap-2">
                            <div><b>AI Summary:</b> {activeDraftSession.drafts[selectedDraftIndex].ai_summary}</div>
                            <div className="flex items-center gap-1.5 flex-shrink-0">
                              {activeDraftSession.drafts[selectedDraftIndex].ai_fallback && <AiFallbackBadge />}
                              {activeDraftSession.drafts[selectedDraftIndex].manually_edited && <ManuallyEditedBadge />}
                            </div>
                          </div>

                          {/* Either in-place editor OR side-by-side diff */}
                          {isEditingDraft ? (
                            <div className="space-y-2">
                              <label className="text-[11px] font-semibold text-slate-400 flex items-center justify-between">
                                <span>Edit Proposed Document Markdown:</span>
                                <span className="text-[10px] text-slate-500">
                                  {currentDraftItem?.saved_draft_id
                                    ? 'Saving updates the saved draft and the diff preview'
                                    : 'Changes will auto-update diff preview upon saving'}
                                </span>
                              </label>
                              <textarea
                                value={editedProposedText}
                                onChange={(e) => setEditedProposedText(e.target.value)}
                                rows={10}
                                className="w-full bg-slate-950 border border-slate-700 rounded-lg p-3 font-mono text-xs text-slate-200 focus:outline-none focus:border-blue-500 leading-relaxed"
                              />
                            </div>
                          ) : (
                            <div className="bg-slate-950 border border-slate-800 rounded-lg p-3 font-mono text-xs max-h-60 overflow-y-auto">
                              {activeDraftSession.drafts[selectedDraftIndex].diff_lines.map((line, lidx) => (
                                <div
                                  key={lidx}
                                  className={`py-0.5 px-2 rounded ${
                                    line.type === 'added' ? 'bg-emerald-950/70 text-emerald-300 border-l-2 border-emerald-500' :
                                    line.type === 'removed' ? 'bg-rose-950/70 text-rose-300 border-l-2 border-rose-500 line-through' :
                                    'text-slate-400'
                                  }`}
                                >
                                  <span className="inline-block w-4 text-slate-600 select-none">
                                    {line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' '}
                                  </span>
                                  {line.text}
                                </div>
                              ))}
                            </div>
                          )}

                          {/* Instruction history + follow-up prompt */}
                          {currentDraftItem && (
                            <div className="space-y-2 border-t border-slate-800 pt-3">
                              <div className="text-[11px] text-slate-400 space-y-0.5">
                                <div><b className="text-slate-300">Request:</b> {activeDraftSession.prompt}</div>
                                {currentDraftItem.selected_by && SELECTED_BY_LABELS[currentDraftItem.selected_by] && (
                                  <div className="text-violet-300/90">Chosen: {SELECTED_BY_LABELS[currentDraftItem.selected_by]}</div>
                                )}
                                {(currentDraftItem.refinements || []).map((r, i) => (
                                  <div key={i} className="flex items-start gap-1 pl-2">
                                    <CornerDownRight className="w-3 h-3 text-slate-600 mt-0.5 flex-shrink-0" />
                                    <span><b className="text-slate-300">Follow-up {i + 1}:</b> {r}</span>
                                  </div>
                                ))}
                              </div>
                              {!currentDraftItem.submitted && (
                                <div className="flex items-start gap-2">
                                  <textarea
                                    value={followUpText}
                                    onChange={(e) => setFollowUpText(e.target.value)}
                                    onKeyDown={(e) => {
                                      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleRefineDraft(selectedDraftIndex);
                                    }}
                                    rows={2}
                                    disabled={isRefining || isEditingDraft}
                                    aria-label="Follow-up instruction"
                                    placeholder={isEditingDraft
                                      ? 'Save your manual edits before sending a follow-up'
                                      : "Refine this draft, e.g. 'Also mention the escalation contact' or 'Keep the original wording for P2'"}
                                    className="flex-1 bg-slate-950 border border-slate-700 rounded-lg p-2 text-xs text-slate-200 focus:outline-none focus:border-blue-500"
                                  />
                                  <button
                                    onClick={() => handleRefineDraft(selectedDraftIndex)}
                                    disabled={isRefining || isEditingDraft || !followUpText.trim()}
                                    className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-xs font-semibold px-3 py-2 rounded-lg flex items-center gap-1.5 flex-shrink-0 transition"
                                  >
                                    {isRefining ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                                    {isRefining ? 'Applying...' : 'Apply Follow-up'}
                                  </button>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {/* AI Change Proposal Box (HIDDEN for Viewer Role, and while an approved change is open) */}
                  {isApprovedViewOpen ? null : !isViewer ? (
                    <div className="bg-slate-950/90 border border-blue-900/40 rounded-xl p-5 shadow-xl ring-1 ring-blue-500/20">
                      <div className="flex items-center justify-between mb-2">
                        <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                          <Sparkles className="w-4 h-4 text-blue-400" />
                          {discoveryMode === 'multi' ? 'Multi-Document Discovery & Coordinated Update' : 'Single-Document Update'}
                        </h3>
                        <span className="text-[10px] bg-blue-950 text-blue-300 border border-blue-800 px-2 py-0.5 rounded font-mono">
                          Step 1: Generate & Edit Drafts
                        </span>
                      </div>

                      <p className="text-xs text-slate-400 mb-3">
                        {discoveryMode === 'multi' ? (
                          <>Describe the requested change in natural language. DocuForge will scan only the documents in <b className="text-slate-300">{selectedProject?.name || 'this project'}</b> across its categories, generate editable draft patches, and allow you to request approval per document.</>
                        ) : (
                          <>Describe the requested change in natural language. DocuForge will skip document discovery and propose changes to <b className="text-slate-300">{selectedDoc.title}</b> only.</>
                        )}
                      </p>

                      <form onSubmit={handleGenerateDrafts} className="space-y-3">
                        {/* Discovery mode */}
                        <div className="flex items-center gap-1 bg-slate-900 p-1 rounded-lg border border-slate-700 w-fit" role="group" aria-label="Document scope">
                          {([
                            { mode: 'multi', label: 'Discover across documents', icon: <Layers className="w-3.5 h-3.5" /> },
                            { mode: 'single', label: 'This document only', icon: <FileText className="w-3.5 h-3.5" /> },
                          ] as const).map(({ mode, label, icon }) => (
                            <button
                              key={mode}
                              type="button"
                              onClick={() => setDiscoveryMode(mode)}
                              disabled={isGeneratingDrafts}
                              aria-pressed={discoveryMode === mode}
                              className={`px-2.5 py-1 text-[11px] font-medium rounded-md transition flex items-center gap-1.5 ${
                                discoveryMode === mode ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-white'
                              }`}
                            >
                              {icon}
                              {label}
                            </button>
                          ))}
                        </div>

                        {discoveryMode === 'multi' ? (
                        <div className="space-y-3">
                        <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer w-fit">
                          <input
                            type="checkbox"
                            checked={aiDiscovery}
                            onChange={(e) => setAiDiscovery(e.target.checked)}
                            disabled={isGeneratingDrafts}
                            className="accent-blue-500"
                          />
                          <Sparkles className="w-3.5 h-3.5 text-blue-400" />
                          Let AI find relevant documents in the selected categories
                        </label>
                        {aiDiscovery && (
                        <div className="space-y-1.5">
                          <div className="flex items-center justify-between">
                            <span className="text-xs text-slate-400 flex items-center gap-1">
                              <Layers className="w-3.5 h-3.5 text-blue-400" /> Categories in scope:
                            </span>
                            <span className="text-[10px] text-slate-500">
                              {docsInScope.length} document{docsInScope.length === 1 ? '' : 's'} will be scanned
                            </span>
                          </div>
                          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Categories in scope">
                            <button
                              type="button"
                              onClick={() => setSelectedCategories([])}
                              disabled={isGeneratingDrafts}
                              aria-pressed={selectedCategories.length === 0}
                              className={`px-2.5 py-1 text-[11px] rounded-full border transition ${
                                selectedCategories.length === 0
                                  ? 'bg-blue-600 border-blue-500 text-white'
                                  : 'bg-slate-900 border-slate-700 text-slate-400 hover:text-white'
                              }`}
                            >
                              All categories
                            </button>
                            {availableCategories.map(cat => {
                              const isOn = selectedCategories.includes(cat);
                              return (
                                <button
                                  key={cat}
                                  type="button"
                                  onClick={() => toggleCategory(cat)}
                                  disabled={isGeneratingDrafts}
                                  aria-pressed={isOn}
                                  className={`px-2.5 py-1 text-[11px] rounded-full border transition flex items-center gap-1 ${
                                    isOn
                                      ? 'bg-blue-600/20 border-blue-500 text-blue-200'
                                      : 'bg-slate-900 border-slate-700 text-slate-400 hover:text-white'
                                  }`}
                                >
                                  {isOn ? <Check className="w-3 h-3" /> : CATEGORY_ICONS[cat]}
                                  {cat}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                        )}

                        {/* Documents picked by hand: always updated, combined with the AI's picks */}
                        <div className="space-y-1.5">
                          <div className="flex items-center justify-between">
                            <span className="text-xs text-slate-400 flex items-center gap-1">
                              <Hand className="w-3.5 h-3.5 text-blue-400" /> Documents to always update{aiDiscovery ? ' (optional)' : ''}:
                            </span>
                            {manualDocIds.length > 0 && (
                              <button type="button" onClick={() => setManualDocIds([])} className="text-[10px] text-slate-500 hover:text-slate-300">
                                Clear
                              </button>
                            )}
                          </div>
                          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Documents to always update">
                            {selectedProjectDocs.map(d => {
                              const isOn = manualDocIds.includes(d.id);
                              const isReference = d.id === referenceDocId;
                              return (
                                <button
                                  key={d.id}
                                  type="button"
                                  onClick={() => toggleManualDoc(d.id)}
                                  disabled={isGeneratingDrafts || isReference}
                                  aria-pressed={isOn}
                                  title={isReference ? 'This is the reference document, so it is not changed' : d.title}
                                  className={`px-2.5 py-1 text-[11px] rounded-full border transition flex items-center gap-1 disabled:opacity-40 ${
                                    isOn
                                      ? 'bg-violet-600/20 border-violet-500 text-violet-200'
                                      : 'bg-slate-900 border-slate-700 text-slate-400 hover:text-white'
                                  }`}
                                >
                                  {isOn ? <Check className="w-3 h-3" /> : CATEGORY_ICONS[d.category]}
                                  {d.title}
                                </button>
                              );
                            })}
                          </div>
                          <p className="text-[10px] text-slate-500">
                            {aiDiscovery
                              ? manualDocs.length > 0
                                ? `AI will scan ${docsInScope.length} document${docsInScope.length === 1 ? '' : 's'}; ${manualDocs.length} always updated: the result combines both.`
                                : 'Optional: pick documents that must be updated even if the AI does not select them (any category).'
                              : manualDocs.length > 0
                                ? `AI discovery off: only the ${manualDocs.length} selected document${manualDocs.length === 1 ? '' : 's'} will be updated.`
                                : 'AI discovery is off: select at least one document to update.'}
                          </p>
                        </div>
                        </div>
                        ) : (
                          <div className="text-[11px] text-slate-400 bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 flex items-center gap-2">
                            <FileText className="w-3.5 h-3.5 text-blue-400 flex-shrink-0" />
                            <span>
                              Changes restricted to <b className="text-slate-200">{selectedDoc.title}</b>. Select another document in the sidebar to change it instead.
                            </span>
                          </div>
                        )}

                        {/* Optional reference document */}
                        <div className="space-y-1.5">
                          <label htmlFor="reference-doc" className="text-xs text-slate-400 flex items-center gap-1">
                            <Link2 className="w-3.5 h-3.5 text-blue-400" /> Reference document (optional):
                          </label>
                          <select
                            id="reference-doc"
                            value={referenceDocId ?? ''}
                            onChange={(e) => setReferenceDocId(e.target.value ? Number(e.target.value) : null)}
                            disabled={isGeneratingDrafts}
                            className="w-full bg-slate-900 border border-slate-700 text-xs rounded px-2 py-1.5 text-slate-200 outline-none focus:border-blue-500"
                          >
                            <option value="">None</option>
                            {projects.map(project => (
                              <optgroup key={project.id} label={project.name}>
                                {documents
                                  .filter(d => d.project_id === project.id)
                                  .map(d => (
                                    <option key={d.id} value={d.id} disabled={discoveryMode === 'single' && d.id === selectedDoc.id}>
                                      {d.category} › {d.title} (v{d.version})
                                    </option>
                                  ))}
                              </optgroup>
                            ))}
                          </select>

                          {referenceDoc && (
                            <div className="flex flex-wrap items-center gap-2">
                              <div className="flex items-center gap-1 bg-slate-900 p-1 rounded-lg border border-slate-700" role="group" aria-label="Reference content">
                                <button
                                  type="button"
                                  onClick={() => setReferenceMode('full')}
                                  disabled={isGeneratingDrafts}
                                  aria-pressed={referenceMode === 'full'}
                                  className={`px-2.5 py-1 text-[11px] font-medium rounded-md transition ${
                                    referenceMode === 'full' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-white'
                                  }`}
                                >
                                  Full document (v{referenceDoc.version})
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setReferenceMode('latest_release')}
                                  disabled={isGeneratingDrafts || !referenceLatest}
                                  aria-pressed={referenceMode === 'latest_release'}
                                  title={referenceLatest === null ? 'This document has no releases yet' : undefined}
                                  className={`px-2.5 py-1 text-[11px] font-medium rounded-md transition disabled:opacity-40 ${
                                    referenceMode === 'latest_release' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-white'
                                  }`}
                                >
                                  {referenceLatest
                                    ? `Latest release only (v${referenceLatest.version} · ${referenceLatest.request_id})`
                                    : referenceLatest === null ? 'Latest release only (no releases yet)' : 'Latest release only…'}
                                </button>
                              </div>
                              <span className="text-[10px] text-slate-500">
                                {referenceMode === 'latest_release'
                                  ? 'The AI sees only the changes made in that release.'
                                  : 'The AI sees the whole reference document.'}
                                {' '}The reference itself is never changed.
                              </span>
                            </div>
                          )}
                          {referenceConflict && (
                            <div className="text-[11px] text-amber-300">
                              The document being changed can't also be its own reference. Pick another reference or switch to "Discover across documents".
                            </div>
                          )}
                        </div>

                        <textarea
                          value={changePrompt}
                          onChange={(e) => setChangePrompt(e.target.value)}
                          placeholder="e.g. 'Update P1 Incident Resolution SLA from 2 hours to 1 hour, add automated Slack channel creation for Major Incidents, and document the new MID Server instance resize in AWS.'"
                          rows={3}
                          className="w-full bg-slate-900 border border-slate-700 rounded-lg p-3 text-xs text-slate-200 focus:outline-none focus:border-blue-500 font-sans"
                          disabled={isGeneratingDrafts}
                        />

                        <div className="flex items-center justify-between">
                          <span className="text-[11px] text-slate-500">
                            Active User: <span className="text-slate-300 font-semibold">@{currentUser}</span>
                          </span>
                          <button
                            type="submit"
                            disabled={isGeneratingDrafts || !changePrompt.trim() || referenceConflict || nothingToUpdate}
                            className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-xs font-semibold px-4 py-2 rounded-lg flex items-center gap-2 transition shadow-md shadow-blue-900/30"
                          >
                            {isGeneratingDrafts ? (
                              <>
                                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                                Analyzing Documents & Generating Drafts...
                              </>
                            ) : (
                              <>
                                <Send className="w-3.5 h-3.5" />
                                Generate Draft Patches
                              </>
                            )}
                          </button>
                        </div>
                      </form>
                    </div>
                  ) : (
                    /* Read-Only Banner for Viewer Role */
                    <div className="bg-slate-950 border border-slate-800 rounded-xl p-5 text-center space-y-2">
                      <Lock className="w-6 h-6 text-slate-500 mx-auto" />
                      <h4 className="text-xs font-bold text-slate-300">Read-Only Document Access</h4>
                      <p className="text-[11px] text-slate-500 max-w-md mx-auto">
                        You are signed in as <code className="text-amber-400 font-mono">{currentUser}</code> with the Viewer role. Viewers can inspect published documentation and audit logs, but cannot propose changes or request updates. Switch to an Editor or Admin role to suggest changes.
                      </p>
                    </div>
                  )}
                </div>
              )}

              {activeTab === 'requests' && isAdmin && (
                <div className="space-y-4 h-full flex flex-col">
                  <div className="grid grid-cols-12 gap-6 flex-1 min-h-0">
                    {/* List of Requests in Reviewer Queue */}
                    <div className="col-span-5 space-y-2 border-r border-slate-800 pr-4 overflow-y-auto">
                      <div className="flex items-center justify-between mb-2">
                        <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider">Reviewer Queue</h3>
                        <button 
                          onClick={() => fetchChangeRequests()} 
                          className="text-[11px] text-blue-400 hover:underline flex items-center gap-1"
                        >
                          <RefreshCw className="w-3 h-3" /> Refresh
                        </button>
                      </div>

                      {/* Status filter */}
                      <div className="flex items-center gap-1 bg-slate-800/80 p-1 rounded-lg border border-slate-700 w-fit mb-2">
                        {(['pending', 'approved', 'published', 'rejected', 'all'] as const).map((status) => {
                          const count = status === 'all'
                            ? changeRequests.length
                            : changeRequests.filter(r => r.status === status).length;
                          return (
                            <button
                              key={status}
                              onClick={() => setReviewQueueFilter(status)}
                              className={`px-2.5 py-1 text-[11px] font-medium rounded-md transition capitalize ${
                                reviewQueueFilter === status ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-white'
                              }`}
                            >
                              {status} ({count})
                            </button>
                          );
                        })}
                      </div>

                      {filteredQueue.map((req) => (
                        <div
                          key={req.id}
                          onClick={() => handleSelectRequest(req)}
                          className={`p-3 rounded-lg border cursor-pointer transition ${
                            selectedRequest?.id === req.id
                              ? 'bg-blue-950/40 border-blue-500 ring-1 ring-blue-500/30'
                              : 'bg-slate-950 border-slate-800 hover:border-slate-700'
                          }`}
                        >
                          <div className="flex items-center justify-between mb-1.5 gap-2">
                            <div className="flex items-center gap-1.5 min-w-0">
                              <span className="text-[10px] font-mono font-semibold px-1.5 py-0.5 rounded bg-slate-900 border border-slate-700 text-slate-200 flex-shrink-0">
                                {req.request_id}
                              </span>
                              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-800 text-blue-300 truncate">
                                {req.project_name ? `${req.project_name} > ` : ''}{req.category || 'General'} &gt; {req.doc_type || 'Doc'}
                              </span>
                            </div>
                            <span className={`text-[9px] font-bold px-2 py-0.5 rounded-full uppercase flex-shrink-0 ${STATUS_BADGE_CLASSES[req.status]}`}>
                              {req.status}
                            </span>
                          </div>

                          <div className="flex items-center gap-2 mb-1">
                            <div className="text-xs font-semibold text-slate-200 truncate">
                              {req.doc_title || 'Document Update'}
                            </div>
                            {req.ai_fallback && <AiFallbackBadge />}
                            {req.manually_edited && <ManuallyEditedBadge />}
                            {req.is_stale && (
                              <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded bg-amber-950 text-amber-300 border border-amber-800 flex-shrink-0">Outdated</span>
                            )}
                          </div>

                          {req.relevance_rationale && (
                            <p className="text-[11px] text-blue-300/80 bg-blue-950/30 p-1.5 rounded border border-blue-900/30 mb-1.5 line-clamp-2">
                              💡 {req.relevance_rationale}
                            </p>
                          )}

                          <p className="text-[11px] text-slate-400 line-clamp-1">
                            <b>Requested by:</b> @{req.requested_by}
                          </p>
                        </div>
                      ))}

                      {filteredQueue.length === 0 && (
                        <div className="text-xs text-slate-500 py-8 text-center">
                          {reviewQueueFilter === 'all'
                            ? 'No change requests in the reviewer queue.'
                            : `No ${reviewQueueFilter} change requests.`}
                        </div>
                      )}
                    </div>

                    {/* Diff Viewer & Approval Panel */}
                    <div className="col-span-7 flex flex-col overflow-hidden">
                      {selectedRequest ? (
                        <div className="bg-slate-950 border border-slate-800 rounded-xl p-5 flex-1 flex flex-col overflow-hidden">
                          <div className="border-b border-slate-800 pb-3 mb-3">
                            <div className="flex items-center justify-between">
                              <div>
                                <div className="flex items-center gap-2">
                                  <span className="text-[11px] font-mono font-semibold text-slate-200 bg-slate-900 border border-slate-700 px-1.5 py-0.5 rounded flex items-center gap-1">
                                    <Hash className="w-3 h-3 text-slate-500" />{selectedRequest.request_id}
                                  </span>
                                  <span className="text-[10px] font-mono text-blue-400">{selectedRequest.project_name ? `${selectedRequest.project_name} > ` : ''}{selectedRequest.category} &gt; {selectedRequest.doc_type}</span>
                                </div>
                                <div className="flex items-center gap-2 mt-1">
                                  <h4 className="font-semibold text-white text-sm">{selectedRequest.doc_title || 'Document Patch'}</h4>
                                  {selectedRequest.ai_fallback && <AiFallbackBadge />}
                                  {selectedRequest.manually_edited && <ManuallyEditedBadge />}
                                </div>
                                <div className="text-[11px] text-slate-500 mt-0.5">
                                  Requested by @{selectedRequest.requested_by} · {formatTimestamp(selectedRequest.created_at)}
                                </div>
                              </div>

                              {/* Approval Actions (Admin Only) */}
                              {selectedRequest.status === 'pending' && (
                                <div className="flex items-center gap-2">
                                  {isAdmin ? (
                                    <>
                                      <button
                                        onClick={() => setIsRejecting(true)}
                                        disabled={isRejecting || isReviewing}
                                        className="bg-rose-950 hover:bg-rose-900 disabled:opacity-50 border border-rose-800 text-rose-300 text-xs px-3 py-1.5 rounded-md flex items-center gap-1.5 transition"
                                      >
                                        <XCircle className="w-3.5 h-3.5" /> Reject
                                      </button>
                                      <button
                                        onClick={() => handleReview('approve')}
                                        disabled={isRejecting || isReviewing || selectedRequest.is_stale}
                                        title={selectedRequest.is_stale ? 'The document changed after this proposal was generated' : undefined}
                                        className="bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-xs px-3 py-1.5 rounded-md flex items-center gap-1.5 font-semibold transition shadow-md"
                                      >
                                        <CheckCircle className="w-3.5 h-3.5" /> Approve
                                      </button>
                                    </>
                                  ) : (
                                    <div className="text-[11px] text-amber-400 bg-amber-950/60 border border-amber-800/80 px-2.5 py-1 rounded">
                                      Switch to '{ADMIN_USERNAMES.join("' or '")}' to approve
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>

                            {selectedRequest.is_stale && (
                              <div className="mt-3 text-xs text-amber-200 bg-amber-950/40 p-2.5 rounded border border-amber-800 flex items-start gap-2">
                                <AlertCircle className="w-3.5 h-3.5 text-amber-400 mt-0.5 flex-shrink-0" />
                                <div>
                                  <b>Outdated proposal.</b> The document changed after this was generated, so approving would overwrite the newer changes.
                                  Reject it so @{selectedRequest.requested_by} can regenerate against the current version.
                                </div>
                              </div>
                            )}

                            {isAdmin && isRejecting && selectedRequest.status === 'pending' && (
                              <div className="mt-3 bg-rose-950/30 border border-rose-900 rounded-lg p-3 space-y-2">
                                <label className="text-[11px] font-semibold text-rose-300 flex items-center gap-1">
                                  <MessageSquare className="w-3.5 h-3.5" /> Reason for rejecting {selectedRequest.request_id} (shared with @{selectedRequest.requested_by}):
                                </label>
                                <textarea
                                  value={rejectionReason}
                                  onChange={(e) => setRejectionReason(e.target.value)}
                                  rows={3}
                                  autoFocus
                                  placeholder="e.g. 'The SLA change conflicts with the contract signed in Q3. Please keep P1 at 2 hours.'"
                                  className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-xs text-slate-200 focus:outline-none focus:border-rose-500"
                                />
                                <div className="flex justify-end gap-2">
                                  <button
                                    onClick={() => { setIsRejecting(false); setRejectionReason(''); }}
                                    className="text-xs text-slate-400 hover:text-slate-200 px-3 py-1.5"
                                  >
                                    Cancel
                                  </button>
                                  <button
                                    onClick={() => handleReview('reject')}
                                    disabled={!rejectionReason.trim() || isReviewing}
                                    className="bg-rose-700 hover:bg-rose-600 disabled:opacity-40 text-white text-xs font-semibold px-3 py-1.5 rounded-md flex items-center gap-1.5 transition"
                                  >
                                    <XCircle className="w-3.5 h-3.5" /> Confirm Rejection
                                  </button>
                                </div>
                              </div>
                            )}

                            {selectedRequest.status === 'approved' && (
                              <div className="text-xs text-sky-200 bg-sky-950/40 p-2 rounded mt-2 border border-sky-900">
                                Approved by @{selectedRequest.reviewed_by} · awaiting publication by @{selectedRequest.requested_by}.
                              </div>
                            )}
                            {selectedRequest.status === 'published' && (
                              <div className="text-xs text-emerald-200 bg-emerald-950/40 p-2 rounded mt-2 border border-emerald-900">
                                Published as v{selectedRequest.published_version} by @{selectedRequest.published_by} · {formatTimestamp(selectedRequest.published_at)}
                              </div>
                            )}

                            {selectedRequest.status === 'rejected' && selectedRequest.rejection_reason && (
                              <div className="text-xs text-rose-200 bg-rose-950/40 p-2 rounded mt-2 border border-rose-900">
                                <b>Rejected by @{selectedRequest.reviewed_by}:</b> {selectedRequest.rejection_reason}
                              </div>
                            )}

                            <div className="text-[11px] text-slate-400 mt-2 space-y-0.5">
                              <div><b className="text-slate-300">Request:</b> {selectedRequest.prompt}</div>
                              {(selectedRequest.refinements || []).map((r, i) => (
                                <div key={i} className="pl-2">↳ <b className="text-slate-300">Follow-up {i + 1}:</b> {r}</div>
                              ))}
                            </div>

                            {selectedRequest.reference_label && (
                              <p className="text-[11px] text-blue-300/90 mt-2 flex items-center gap-1">
                                <Link2 className="w-3 h-3 flex-shrink-0" /> Reference: {selectedRequest.reference_label}
                              </p>
                            )}

                            {selectedRequest.ai_summary && (
                              <p className="text-xs text-slate-300 bg-slate-900 p-2 rounded mt-2 border border-slate-800">
                                <b>Summary of Changes:</b> {selectedRequest.ai_summary}
                              </p>
                            )}
                          </div>

                          {/* Side by Side Diff Viewer */}
                          <div className="flex-1 bg-slate-900 border border-slate-800 rounded-lg p-3 font-mono text-xs overflow-y-auto">
                            {diffLines.map((line, idx) => (
                              <div
                                key={idx}
                                className={`py-0.5 px-2 rounded ${
                                  line.type === 'added' ? 'bg-emerald-950/70 text-emerald-300 border-l-2 border-emerald-500' :
                                  line.type === 'removed' ? 'bg-rose-950/70 text-rose-300 border-l-2 border-rose-500 line-through' :
                                  'text-slate-400'
                                }`}
                              >
                                <span className="inline-block w-4 text-slate-600 select-none">
                                  {line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' '}
                                </span>
                                {line.text}
                              </div>
                            ))}
                          </div>
                        </div>
                      ) : (
                        <div className="h-full flex items-center justify-center text-slate-600 text-sm">
                          Select a change request from the reviewer queue to inspect the diff.
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {activeTab === 'my-requests' && canSubmitRequests && (
                <div className="max-w-4xl mx-auto space-y-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <h3 className="text-sm font-semibold text-white">My Change Requests</h3>
                      <p className="text-[11px] text-slate-500">All requests submitted by @{currentUser}, across every document.</p>
                    </div>
                    <button
                      onClick={fetchMyRequests}
                      className="text-[11px] text-blue-400 hover:underline flex items-center gap-1"
                    >
                      <RefreshCw className="w-3 h-3" /> Refresh
                    </button>
                  </div>

                  {/* Status filter */}
                  <div className="flex items-center gap-1 bg-slate-800/80 p-1 rounded-lg border border-slate-700 w-fit">
                    {(['all', 'pending', 'approved', 'published', 'rejected', 'withdrawn'] as const).map((status) => {
                      const count = status === 'all'
                        ? myRequests.length
                        : myRequests.filter(r => r.status === status).length;
                      return (
                        <button
                          key={status}
                          onClick={() => setMyRequestsFilter(status)}
                          className={`px-3 py-1 text-xs font-medium rounded-md transition capitalize ${
                            myRequestsFilter === status ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-white'
                          }`}
                        >
                          {status} ({count})
                        </button>
                      );
                    })}
                  </div>

                  {myRequests
                    .filter(r => myRequestsFilter === 'all' || r.status === myRequestsFilter)
                    .map((req) => (
                      <div key={req.id} className="bg-slate-950 border border-slate-800 rounded-lg p-4 space-y-2">
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="text-[11px] font-mono font-semibold text-slate-200 bg-slate-900 border border-slate-700 px-1.5 py-0.5 rounded flex-shrink-0">
                              {req.request_id}
                            </span>
                            <span className="text-xs font-semibold text-slate-200 truncate">{req.doc_title || 'Document Update'}</span>
                            {req.ai_fallback && <AiFallbackBadge />}
                            {req.manually_edited && <ManuallyEditedBadge />}
                          </div>
                          <span className={`text-[9px] font-bold px-2 py-0.5 rounded-full uppercase flex-shrink-0 ${STATUS_BADGE_CLASSES[req.status]}`}>
                            {req.status}
                          </span>
                        </div>

                        <div className="text-[11px] text-slate-500 flex flex-wrap gap-x-4 gap-y-1">
                          <span>{req.project_name ? `${req.project_name} > ` : ''}{req.category} &gt; {req.doc_type}</span>
                          <span>Submitted: {formatTimestamp(req.created_at)}</span>
                          {req.status !== 'pending' && (
                            <span>Reviewed by @{req.reviewed_by} · {formatTimestamp(req.updated_at)}</span>
                          )}
                        </div>

                        <p className="text-xs text-slate-300">
                          <b className="text-slate-400">Request:</b> {req.prompt}
                          {(req.refinements || []).map((r, i) => (
                            <span key={i} className="block text-[11px] text-slate-400 pl-2">↳ Follow-up {i + 1}: {r}</span>
                          ))}
                          {req.reference_label && (
                            <span className="block text-[11px] text-blue-300/90 mt-0.5">Reference: {req.reference_label}</span>
                          )}
                        </p>

                        {req.status === 'approved' && (
                          <div className="text-xs text-sky-200 bg-sky-950/40 p-2.5 rounded border border-sky-900 flex items-center justify-between gap-2">
                            <span>Approved by @{req.reviewed_by}{req.is_stale ? ' · outdated: the document has changed since' : ' · ready to publish'}.</span>
                            <button onClick={() => handleOpenApproved(req)} className="text-blue-400 hover:underline flex-shrink-0">
                              Open →
                            </button>
                          </div>
                        )}
                        {req.status === 'published' && (
                          <div className="text-xs text-emerald-200 bg-emerald-950/40 p-2.5 rounded border border-emerald-900">
                            Published as v{req.published_version} by @{req.published_by} · {formatTimestamp(req.published_at)}
                          </div>
                        )}
                        {req.status === 'withdrawn' && (
                          <div className="text-xs text-slate-300 bg-slate-900 p-2.5 rounded border border-slate-700">
                            Approved, then withdrawn and reopened as a draft without publishing.
                          </div>
                        )}

                        {req.status === 'rejected' && (
                          <div className="text-xs text-rose-200 bg-rose-950/40 p-2.5 rounded border border-rose-900 flex items-start gap-2">
                            <MessageSquare className="w-3.5 h-3.5 text-rose-400 mt-0.5 flex-shrink-0" />
                            <div>
                              <b>Rejection reason:</b> {req.rejection_reason || 'No reason provided.'}
                              {req.draft_id && (
                                <div className="mt-1 text-[11px] text-rose-300/80">
                                  Reopened as a draft in the project's Drafts folder.{' '}
                                  <button
                                    onClick={() => {
                                      const draft = savedDrafts.find(d => d.id === req.draft_id);
                                      if (draft) handleOpenSavedDraft(draft);
                                    }}
                                    className="text-blue-400 hover:underline"
                                  >
                                    Open draft →
                                  </button>
                                </div>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    ))}

                  {myRequests.filter(r => myRequestsFilter === 'all' || r.status === myRequestsFilter).length === 0 && (
                    <div className="text-xs text-slate-500 py-8 text-center">
                      {myRequestsFilter === 'all'
                        ? "You haven't submitted any change requests yet."
                        : `No ${myRequestsFilter} requests.`}
                    </div>
                  )}
                </div>
              )}

              {activeTab === 'overview' && canSubmitRequests && (
                <div className="max-w-5xl mx-auto space-y-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <h3 className="text-sm font-semibold text-white">Request Overview</h3>
                      <p className="text-[11px] text-slate-500">Where each of your changes is, by document. The highlighted step is its current stage.</p>
                    </div>
                    <div className="flex items-center gap-3">
                      <label className="text-[11px] text-slate-400 flex items-center gap-1.5 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={overviewShowPublished}
                          onChange={(e) => setOverviewShowPublished(e.target.checked)}
                          className="accent-blue-500"
                        />
                        Show published
                      </label>
                      <button
                        onClick={() => { fetchMyRequests(); fetchSavedDrafts(); fetchReleases(); }}
                        className="text-[11px] text-blue-400 hover:underline flex items-center gap-1"
                      >
                        <RefreshCw className="w-3 h-3" /> Refresh
                      </button>
                    </div>
                  </div>

                  {/* Totals per stage */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    {OVERVIEW_STAGES.map(stage => (
                      <div key={stage} className={`rounded-lg border px-3 py-2 ${OVERVIEW_STAGE_STYLES[stage]}`}>
                        <div className="text-lg font-bold leading-none">{overviewItems.filter(i => i.stage === stage).length}</div>
                        <div className="text-[11px] mt-1 opacity-90">{stage}</div>
                      </div>
                    ))}
                  </div>

                  {overviewGroups.map(group => (
                    <div key={`${group.projectName}|${group.documentId}`} className="bg-slate-950 border border-slate-800 rounded-xl p-4 space-y-3">
                      <div className="flex items-center gap-2 min-w-0">
                        {CATEGORY_ICONS[group.category] || <FileText className="w-3.5 h-3.5 text-blue-400" />}
                        <span className="text-[11px] text-slate-500 truncate">{group.projectName} › {group.category} ›</span>
                        <span className="text-xs font-semibold text-slate-200 truncate">{group.docTitle}</span>
                        <span className="text-[10px] text-slate-500 flex-shrink-0">
                          · {group.items.length} change{group.items.length === 1 ? '' : 's'}
                        </span>
                      </div>

                      {group.items.map(item => {
                        const current = OVERVIEW_STAGES.indexOf(item.stage);
                        return (
                          <button
                            key={item.key}
                            onClick={item.open}
                            className="w-full text-left bg-slate-900/60 hover:bg-slate-900 border border-slate-800 hover:border-slate-700 rounded-lg p-3 space-y-2.5 transition"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <div className="flex items-center gap-2 min-w-0">
                                <span className="text-[10px] font-mono font-semibold text-slate-200 bg-slate-950 border border-slate-700 px-1.5 py-0.5 rounded flex-shrink-0">
                                  {item.label}
                                </span>
                                <span className="text-xs text-slate-300 truncate">{item.prompt}</span>
                              </div>
                              {item.isStale && (
                                <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded bg-amber-950 text-amber-300 border border-amber-800 flex-shrink-0">Outdated</span>
                              )}
                            </div>

                            {/* Stage tracker: completed steps ticked, current step highlighted */}
                            <ol className="grid grid-cols-4 gap-1.5" aria-label={`Stage: ${item.stage}`}>
                              {OVERVIEW_STAGES.map((stage, i) => {
                                const isCurrent = i === current;
                                const isDone = i < current;
                                const date = item.stageDates[stage];
                                return (
                                  <li
                                    key={stage}
                                    aria-current={isCurrent ? 'step' : undefined}
                                    className={`rounded-md border px-2 py-1.5 text-[11px] flex flex-col gap-0.5 ${
                                      isCurrent
                                        ? `${OVERVIEW_STAGE_STYLES[stage]} ring-2 font-semibold`
                                        : isDone
                                          ? 'border-slate-700 text-slate-400 bg-slate-900'
                                          : 'border-dashed border-slate-800 text-slate-600'
                                    }`}
                                  >
                                    <span className="flex items-center gap-1">
                                      {isDone && <Check className="w-3 h-3 text-emerald-500" />}
                                      {stage}
                                    </span>
                                    <span className="text-[9px] font-normal opacity-80">
                                      {(isCurrent || isDone) && date ? new Date(date).toLocaleDateString() : '\u00a0'}
                                    </span>
                                  </li>
                                );
                              })}
                            </ol>

                            {item.note && <div className="text-[11px] text-slate-400">{item.note}</div>}
                          </button>
                        );
                      })}
                    </div>
                  ))}

                  {overviewGroups.length === 0 && (
                    <div className="text-xs text-slate-500 py-8 text-center">
                      {overviewItems.length === 0
                        ? "You have no changes in progress. Generate a draft from any document to get started."
                        : 'Only published changes. Tick "Show published" to see them.'}
                    </div>
                  )}
                </div>
              )}

              {activeTab === 'releases' && (
                <div className="max-w-4xl mx-auto space-y-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <h3 className="text-sm font-semibold text-white">New Releases</h3>
                      <p className="text-[11px] text-slate-500">Approved changes that produced a new document version, across all projects. Newest first.</p>
                    </div>
                    <button
                      onClick={() => fetchReleases(true)}
                      className="text-[11px] text-blue-400 hover:underline flex items-center gap-1"
                    >
                      <RefreshCw className="w-3 h-3" /> Refresh
                    </button>
                  </div>

                  {releases.map((release) => (
                    <button
                      key={release.change_request_id}
                      onClick={() => handleOpenRelease(release)}
                      className="w-full text-left bg-slate-950 border border-slate-800 hover:border-emerald-700 rounded-lg p-4 space-y-1.5 transition"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="text-[10px] font-bold font-mono px-1.5 py-0.5 rounded bg-emerald-950 text-emerald-300 border border-emerald-800 flex-shrink-0">
                            v{release.version}
                          </span>
                          <span className="text-xs font-semibold text-slate-200 truncate">{release.doc_title}</span>
                        </div>
                        <span className="text-[10px] text-slate-500 flex-shrink-0">{formatTimestamp(release.published_at)}</span>
                      </div>
                      <div className="text-[11px] text-slate-500 flex flex-wrap gap-x-3 gap-y-0.5">
                        <span>{release.project_name ? `${release.project_name} > ` : ''}{release.category} &gt; {release.doc_type}</span>
                        <span className="font-mono">{release.request_id}</span>
                        <span>Requested by @{release.requested_by}</span>
                        {release.approved_by && <span>Approved by @{release.approved_by}</span>}
                        {release.published_by && <span>Published by @{release.published_by}</span>}
                      </div>
                      {release.ai_summary && (
                        <p className="text-xs text-slate-400 line-clamp-2">{release.ai_summary}</p>
                      )}
                    </button>
                  ))}

                  {releases.length === 0 && (
                    <div className="text-xs text-slate-500 py-8 text-center">
                      No releases yet. Approved changes will appear here.
                    </div>
                  )}
                </div>
              )}

              {activeTab === 'audit' && !isViewer && (
                <div className="max-w-4xl mx-auto space-y-3">
                  <h3 className="text-sm font-semibold text-white mb-3">Immutable Change Log & Audit Records</h3>
                  {auditLogs.map((log) => (
                    <div key={log.id} className="bg-slate-950 border border-slate-800 p-4 rounded-lg flex items-start gap-3">
                      <Clock className="w-4 h-4 text-blue-400 mt-0.5" />
                      <div className="flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="text-xs font-semibold text-slate-200">
                              {log.action} by <span className="text-blue-400">@{log.actor}</span>
                            </span>
                            {log.request_id && (
                              <span className="text-[10px] font-mono font-semibold text-slate-200 bg-slate-900 border border-slate-700 px-1.5 py-0.5 rounded flex-shrink-0">
                                {log.request_id}
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-2 text-[10px] text-slate-500 flex-shrink-0">
                            <time dateTime={log.created_at}>{formatTimestamp(log.created_at)}</time>
                            <span className="font-mono">v{log.version_after}</span>
                          </div>
                        </div>
                        <p className="text-xs text-slate-400 mt-1">{log.summary}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-slate-500">
            Select a document from the sidebar to view details.
          </div>
        )}
      </main>
    </div>
  );
}
