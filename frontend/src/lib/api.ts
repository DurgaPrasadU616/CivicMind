const BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000';

export interface ApiErrorDetail {
  path: string;
  message: string;
}

export class ApiError extends Error {
  status: number;
  details?: ApiErrorDetail[];

  constructor(message: string, status: number, details?: ApiErrorDetail[]) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
  }
}

// ─── Token accessor ──────────────────────────────────────────────────────────
let _getToken: (() => string | null) | null = null;
let _onUnauthorized: (() => void) | null = null;

/** Called once by AuthContextProvider to wire up token access + 401 handler. */
export const registerAuthAccessors = (
  getToken: () => string | null,
  onUnauthorized: () => void
) => {
  _getToken = getToken;
  _onUnauthorized = onUnauthorized;
};

// ─── Global fetch wrapper ────────────────────────────────────────────────────
async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const url = `${BASE_URL}${path}`;

  const token = _getToken?.();
  const authHeaders: Record<string, string> = token
    ? { Authorization: `Bearer ${token}` }
    : {};

  const isFormData = typeof FormData !== 'undefined' && options?.body instanceof FormData;

  const defaultHeaders: Record<string, string> = {
    ...authHeaders,
  };

  if (!isFormData) {
    defaultHeaders['Content-Type'] = 'application/json';
  }

  const config = {
    ...options,
    headers: {
      ...defaultHeaders,
      ...options?.headers,
    },
  };

  try {
    const response = await fetch(url, config);
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      if (response.status === 401 && _onUnauthorized) {
        _onUnauthorized();
      }
      const errorMessage = data.error || response.statusText || 'An error occurred';
      throw new ApiError(errorMessage, response.status, data.details);
    }

    return data as T;
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    throw new ApiError(
      error instanceof Error ? error.message : 'Unable to connect to the backend server.',
      503
    );
  }
}

// ─── Types ───────────────────────────────────────────────────────────────────
export interface IngestionLogItem {
  id: number;
  source_type: string;
  run_at: string;
  processed: number;
  created: number;
  duplicates: number;
  errors: number;
  failed_feeds: string[] | null;
  status: 'success' | 'partial' | 'failed';
}

export type ClusterStatus = 'open' | 'in_progress' | 'resolved' | 'escalated';

export interface ActionLogEntry {
  id: number;
  actionTaken: string;
  previousStatus: ClusterStatus;
  newStatus: ClusterStatus;
  note: string | null;
  loggedAt: string;
  admin: {
    id: number;
    name: string;
    role: string;
  };
}

export interface ClusterHistoryResponse {
  clusterId: string;
  clusterTitle: string;
  currentStatus: ClusterStatus;
  history: ActionLogEntry[];
}

export interface PatchStatusResponse {
  message: string;
  cluster: {
    id: string;
    status: ClusterStatus;
    title: string;
    needsReview: boolean;
    updatedAt: string;
  };
  logEntry: {
    id: number;
    clusterId: string;
    previousStatus: ClusterStatus;
    newStatus: ClusterStatus;
    note: string | null;
    loggedAt: string;
  };
}

// ─── Auth API ─────────────────────────────────────────────────────────────────
export const authApi = {
  login: async (email: string, password: string) =>
    request<{ token: string; user: { id: number; name: string; email: string; role: string } }>(
      '/api/auth/login',
      { method: 'POST', body: JSON.stringify({ email, password }) }
    ),

  register: async (name: string, email: string, password: string, role: string) =>
    request<{ message: string; user: { id: number; name: string; email: string; role: string } }>(
      '/api/auth/register',
      { method: 'POST', body: JSON.stringify({ name, email, password, role }) }
    ),
};

// ─── Main API client ──────────────────────────────────────────────────────────
export const apiClient = {
  submitComplaint: async (payload: {
    text: string;
    category: string;
    latitude: number | null;
    longitude: number | null;
    idempotencyKey: string;
    metaData?: Record<string, unknown>;
  }) => {
    return request<{ message: string; data: unknown }>('/api/complaints', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  getComplaint: async (id: string) => {
    return request<{ data: unknown }>(`/api/complaints/${id}`);
  },

  getClusters: async (filters?: {
    category?: string;
    region?: string;
    status?: string;
    search?: string;
    id?: string;
    limit?: number;
    offset?: number;
  }) => {
    const params = new URLSearchParams();
    if (filters) {
      Object.entries(filters).forEach(([key, value]) => {
        if (value && value !== 'all') {
          params.append(key, String(value));
        }
      });
    }
    const query = params.toString() ? `?${params.toString()}` : '';
    return request<{ data: unknown[]; meta?: { total: number; limit: number; offset: number } }>(`/api/clusters${query}`);
  },

  updateClusterStatus: async (clusterId: string, status: 'open' | 'in_progress' | 'resolved' | 'escalated') => {
    return request<{ message: string; clusterId: string }>(`/api/clusters/${clusterId}/status`, {
      method: 'POST',
      body: JSON.stringify({ status }),
    });
  },

  /**
   * PATCH /api/clusters/:id/status — enforces the state machine and writes an action_log entry.
   * Use this for all new status changes. The old updateClusterStatus (POST) is deprecated.
   */
  patchClusterStatus: async (
    clusterId: string,
    newStatus: ClusterStatus,
    note?: string
  ): Promise<PatchStatusResponse> => {
    return request<PatchStatusResponse>(`/api/clusters/${clusterId}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ newStatus, note }),
    });
  },

  /**
   * GET /api/clusters/:id/history — returns the full action_log for a cluster.
   * Available to all authenticated roles (read-only for citizens).
   */
  getClusterHistory: async (clusterId: string): Promise<ClusterHistoryResponse> => {
    return request<ClusterHistoryResponse>(`/api/clusters/${clusterId}/history`);
  },

  getClusterActions: async (clusterId: string) => {
    return request<{ clusterId: string; data: Array<{
      id: number;
      action_text: string;
      generated_by: 'gemini' | 'rule_based';
      status: 'active' | 'superseded';
      generated_at: string;
    }> }>(`/api/clusters/${clusterId}/actions`);
  },

  getIngestionLogs: async (limit = 10, page = 1) => {
    return request<{ logs: IngestionLogItem[]; total: number; page: number; limit: number; totalPages: number }>(
      `/api/ingestion/log?limit=${limit}&page=${page}`
    );
  },

  /**
   * Phase 3: Pre-submission media analysis (image, audio, video).
   * Analyzes file content and returns AI-generated description and detected category.
   */
  analyzeMedia: async (file: File) => {
    const formData = new FormData();
    formData.append('file', file);
    return request<{
      message: string;
      data: {
        mediaType: 'image' | 'audio' | 'video';
        originalFilename: string;
        fileSize: number;
        mimeType: string;
        analysis: {
          mediaType: 'image' | 'audio' | 'video';
          description: string;
          detectedCategory: string | null;
          severityIndicators: string[];
          confidence: number;
          needsHumanReview: boolean;
          rawTranscript?: string;
        };
      };
    }>('/api/media/analyze', {
      method: 'POST',
      body: formData,
    });
  },

  /**
   * Phase 3: Attach media to an existing complaint.
   */
  attachComplaintMedia: async (complaintId: number | string, file: File) => {
    const formData = new FormData();
    formData.append('file', file);
    const cleanId = String(complaintId).replace(/^CM-/, '');
    return request<{
      message: string;
      data: {
        mediaId: number;
        storageKey: string;
        mediaType: string;
        processingStatus: string;
        serveUrl: string;
        analysis?: unknown;
      };
    }>(`/api/complaints/${cleanId}/media`, {
      method: 'POST',
      body: formData,
    });
  },

  /**
   * Phase 3: Retry AI analysis for a failed media attachment.
   * Reuses the existing complaint_media record (never creates a duplicate).
   */
  retryComplaintMedia: async (complaintId: number | string, mediaId: number) => {
    const cleanId = String(complaintId).replace(/^CM-/, '');
    return request<{
      message: string;
      data: {
        mediaId: number;
        storageKey: string;
        mediaType: string;
        processingStatus: string;
        serveUrl: string;
        analysis?: unknown;
      };
    }>(`/api/complaints/${cleanId}/media/${mediaId}/retry`, {
      method: 'POST',
    });
  },

  /**
   * Phase 3: Get all media attachments for a complaint.
   */
  getComplaintMedia: async (complaintId: number | string) => {
    const cleanId = String(complaintId).replace(/^CM-/, '');
    return request<{
      data: Array<{
        id: number;
        complaintId: number;
        mediaType: 'image' | 'audio' | 'video';
        storageKey: string;
        originalFilename: string;
        mimeType: string;
        fileSize: number;
        processingStatus: string;
        extractedDescription: string | null;
        detectedCategory: string | null;
        confidenceScore: number | null;
        needsHumanReview: boolean;
        createdAt: string;
        serveUrl: string;
      }>;
      meta: { count: number };
    }>(`/api/complaints/${cleanId}/media`);
  },

  // ── Phase 4: Autonomous Civic Investigation Agent ──────────────────────────

  getInvestigations: async (filters?: {
    status?: string;
    clusterId?: number;
    priority?: string;
    limit?: number;
    offset?: number;
  }) => {
    const params = new URLSearchParams();
    if (filters) {
      Object.entries(filters).forEach(([key, value]) => {
        if (value !== undefined && value !== 'all') {
          params.append(key, String(value));
        }
      });
    }
    const query = params.toString() ? `?${params.toString()}` : '';
    return request<{
      data: Array<{
        id: number;
        clusterId: number;
        status: string;
        priority: string;
        investigationSummary: string | null;
        departmentSuggestion: string | null;
        confidenceScore: number | null;
        createdBy: number | null;
        startedAt: string | null;
        completedAt: string | null;
        createdAt: string;
        clusterTitle?: string;
        clusterCategory?: string;
        clusterRegion?: string;
      }>;
      meta: { total: number; limit: number; offset: number };
    }>(`/api/investigations${query}`);
  },

  getInvestigation: async (id: number | string) => {
    return request<{
      data: {
        investigation: {
          id: number;
          clusterId: number;
          status: string;
          priority: string;
          investigationSummary: string | null;
          departmentSuggestion: string | null;
          confidenceScore: number | null;
          createdBy: number | null;
          startedAt: string | null;
          completedAt: string | null;
          createdAt: string;
          clusterTitle?: string;
          clusterCategory?: string;
          clusterRegion?: string;
        };
        evidence: Array<{
          id: number;
          evidenceType: string;
          sourceUrl: string | null;
          sourceTitle: string | null;
          evidenceDescription: string;
          verificationStatus: string;
          retrievedAt: string;
        }>;
        latestReport: {
          id: number;
          reportVersion: number;
          generatedAt: string;
          reviewStatus: string;
          reviewNotes: string | null;
          reviewedBy: number | null;
          reportJson: {
            investigationId: number;
            clusterId: number;
            clusterTitle: string;
            category: string;
            region: string;
            priority: string;
            generatedAt: string;
            findings: {
              investigationSummary: string;
              problemDescription: string;
              geographicImpact: string;
              affectedPopulationEstimate: string;
              complaintTrends: string;
              severityAssessment: string;
              potentialCauses: string[];
              missingInformation: string[];
              humanVerificationRequirements: string[];
              confidenceLevel: number;
            };
            departmentMatch: {
              suggestedDepartment: string;
              reasoning: string;
              confidenceScore: number;
              supportingEvidence: string[];
              alternativeDepartment?: string | null;
            };
            recommendations: Array<{
              actionTitle: string;
              description: string;
              departmentId?: string;
              priority: string;
              expectedOutcome: string;
              requiredResources?: string;
              supportingEvidence: string[];
              confidenceScore: number;
            }>;
            evidenceSummary: {
              totalComplaints: number;
              mediaAttachments: number;
              publicSourcesChecked: number;
            };
          };
        } | null;
        recommendations: Array<{
          id: number;
          actionTitle: string;
          description: string;
          departmentId: string | null;
          priority: string;
          confidenceScore: number | null;
          approvalStatus: string;
          createdAt: string;
        }>;
        activity: Array<{
          id: number;
          activityType: string;
          description: string;
          metadata: Record<string, unknown>;
          createdAt: string;
          actorName: string | null;
          actorRole: string | null;
        }>;
      };
    }>(`/api/investigations/${id}`);
  },

  createInvestigation: async (payload: {
    clusterId: number;
    priority?: string;
    autoRun?: boolean;
  }) => {
    return request<{ message: string; data: unknown }>('/api/investigations', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  runInvestigation: async (id: number | string) => {
    return request<{ message: string; data: unknown }>(`/api/investigations/${id}/run`, {
      method: 'POST',
    });
  },

  retryInvestigation: async (id: number | string) => {
    return request<{ message: string; data: unknown }>(`/api/investigations/${id}/retry`, {
      method: 'POST',
    });
  },

  reviewInvestigation: async (
    id: number | string,
    payload: { reviewStatus: 'approved' | 'rejected' | 'revision_requested'; reviewNotes?: string }
  ) => {
    return request<{ message: string; data: unknown }>(`/api/investigations/${id}/review`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  approveRecommendation: async (investigationId: number | string, recId: number | string) => {
    return request<{ message: string }>(
      `/api/investigations/${investigationId}/recommendations/${recId}/approve`,
      { method: 'POST' }
    );
  },

  rejectRecommendation: async (investigationId: number | string, recId: number | string) => {
    return request<{ message: string }>(
      `/api/investigations/${investigationId}/recommendations/${recId}/reject`,
      { method: 'POST' }
    );
  },

  // ── Phase 5: Civic Action & Resolution Intelligence ──────────────────────────
  getActions: async (params?: {
    status?: string;
    priority?: string;
    departmentId?: string;
    limit?: number;
    offset?: number;
  }) => {
    const q = new URLSearchParams();
    if (params?.status) q.set('status', params.status);
    if (params?.priority) q.set('priority', params.priority);
    if (params?.departmentId) q.set('departmentId', params.departmentId);
    if (params?.limit) q.set('limit', String(params.limit));
    if (params?.offset) q.set('offset', String(params.offset));
    const qs = q.toString() ? `?${q.toString()}` : '';
    return request<{
      data: Array<{
        id: number;
        investigation_id: number | null;
        recommendation_id: number | null;
        cluster_id: number | null;
        action_title: string;
        description: string;
        department_id: string | null;
        department_name: string | null;
        status: string;
        priority: string;
        created_at: string;
        expected_completion_date: string | null;
      }>;
      meta: { total: number };
    }>(`/api/actions${qs}`);
  },

  getAction: async (id: number | string) => {
    return request<{
      data: {
        action: {
          id: number;
          investigation_id: number | null;
          recommendation_id: number | null;
          cluster_id: number | null;
          action_title: string;
          description: string;
          department_id: string | null;
          department_name: string | null;
          status: string;
          priority: string;
          created_at: string;
          updated_at: string;
          approved_at: string | null;
          assigned_at: string | null;
          expected_completion_date: string | null;
          actual_completion_date: string | null;
          overdue_since: string | null;
        };
        assignments: Array<{
          id: number;
          department_name: string | null;
          department_id: string | null;
          officer_name: string | null;
          assigned_at: string;
          expected_completion_date: string | null;
          priority: string | null;
          notes: string | null;
          is_current: boolean;
        }>;
        history: Array<{
          id: number;
          previous_status: string | null;
          new_status: string;
          changed_by: number | null;
          change_reason: string | null;
          created_at: string;
        }>;
        evidence: Array<{
          id: number;
          evidence_type: 'before' | 'after' | 'progress' | 'completion_report';
          storage_key: string;
          original_filename: string | null;
          mime_type: string | null;
          file_size: number | null;
          description: string | null;
          ai_analysis: Record<string, unknown> | null;
          ai_confidence_score: number | null;
          needs_human_review: boolean;
          verification_status: string;
          created_at: string;
        }>;
        slaMetrics: {
          timeElapsedMs: number;
          timeRemainingMs: number | null;
          isOverdue: boolean;
          overdueDurationMs: number | null;
          complianceStatus: 'on_track' | 'at_risk' | 'overdue' | 'completed' | 'unknown';
        };
      };
    }>(`/api/actions/${id}`);
  },

  createAction: async (payload: {
    investigationId?: number;
    recommendationId?: number;
    clusterId?: number;
    actionTitle: string;
    description: string;
    departmentId?: string;
    departmentName?: string;
    priority?: string;
  }) => {
    return request<{ message: string; data: unknown }>('/api/actions', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  approveAction: async (id: number | string) => {
    return request<{ message: string; data: unknown }>(`/api/actions/${id}/approve`, {
      method: 'POST',
    });
  },

  assignAction: async (
    id: number | string,
    payload: {
      departmentName: string;
      departmentId?: string;
      officerId?: number;
      officerName?: string;
      expectedCompletionDate?: string;
      priority?: string;
      notes?: string;
    }
  ) => {
    return request<{ message: string; data: unknown }>(`/api/actions/${id}/assign`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  updateActionStatus: async (
    id: number | string,
    payload: {
      newStatus: string;
      changeReason?: string;
      metadata?: Record<string, unknown>;
    }
  ) => {
    return request<{ message: string; data: unknown }>(`/api/actions/${id}/status`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });
  },

  uploadActionEvidence: async (id: number | string, formData: FormData) => {
    return request<{ message: string; data: unknown }>(`/api/actions/${id}/evidence`, {
      method: 'POST',
      body: formData,
    });
  },

  verifyActionResolution: async (
    id: number | string,
    payload: { approved: boolean; notes?: string }
  ) => {
    return request<{ message: string; data: unknown }>(`/api/actions/${id}/verify-resolution`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  reopenAction: async (id: number | string, payload: { reason: string }) => {
    return request<{ message: string; data: unknown }>(`/api/actions/${id}/reopen`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  getActionAnalytics: async (params?: { startDate?: string; endDate?: string; departmentId?: string }) => {
    const q = new URLSearchParams();
    if (params?.startDate) q.set('startDate', params.startDate);
    if (params?.endDate) q.set('endDate', params.endDate);
    if (params?.departmentId) q.set('departmentId', params.departmentId);
    const qs = q.toString() ? `?${q.toString()}` : '';
    return request<{
      data: {
        departmentAnalytics: Array<{
          departmentName: string | null;
          departmentId: string | null;
          totalAssigned: number;
          completed: number;
          pending: number;
          overdue: number;
          rejected: number;
          reopenedCount: number;
          avgResolutionDays: number | null;
          slaComplianceRate: number | null;
        }>;
        categoryAnalytics: Array<{
          category: string | null;
          total: number;
          resolved: number;
          overdue: number;
          pending: number;
          resolutionRate: number | null;
        }>;
        workload: Array<{
          departmentName: string | null;
          departmentId: string | null;
          openActions: number;
          overdueActions: number;
          avgPriority: string | null;
        }>;
      };
    }>(`/api/actions/analytics${qs}`);
  },

  getCitizenProgress: async (complaintId: number | string) => {
    return request<{
      data: {
        complaintId: number;
        actionId: number | null;
        currentStatus: string;
        priority: string | null;
        departmentName: string | null;
        expectedCompletion: string | null;
        statusHistory: Array<{
          status: string;
          changedAt: string;
          note: string | null;
        }>;
        canReopen: boolean;
      };
    }>(`/api/actions/my-complaints/${complaintId}/progress`);
  },
};
