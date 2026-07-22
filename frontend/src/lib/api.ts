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

  const config = {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders,
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
  }) => {
    const params = new URLSearchParams();
    if (filters) {
      Object.entries(filters).forEach(([key, value]) => {
        if (value && value !== 'all') {
          params.append(key, value);
        }
      });
    }
    const query = params.toString() ? `?${params.toString()}` : '';
    return request<{ data: unknown[] }>(`/api/clusters${query}`);
  },

  updateClusterStatus: async (clusterId: string, status: 'pending' | 'in_progress' | 'resolved') => {
    return request<{ message: string; clusterId: string }>(`/api/clusters/${clusterId}/status`, {
      method: 'POST',
      body: JSON.stringify({ status }),
    });
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
};
