// backend/src/services/actions/performanceAnalytics.ts
//
// Phase 5 — Department Performance Analytics
//
// Provides raw SQL aggregations. No fabricated data.
//
// Functions:
//   getDepartmentAnalytics  — Per-department summary (assigned/completed/overdue/etc.)
//   getCategoryWiseResolution — Group by complaint category
//   getDepartmentWorkload   — Current open workload per department

import { pool } from '../../config/db';
import logger from '../../utils/logger';

export interface DepartmentAnalytics {
  departmentName:    string | null;
  departmentId:      string | null;
  totalAssigned:     number;
  completed:         number;
  pending:           number;
  overdue:           number;
  rejected:          number;
  avgResolutionDays: number | null;
  slaComplianceRate: number | null; // 0–1
  reopenedCount:     number;
}

export interface CategoryAnalytics {
  category:    string | null;
  total:       number;
  resolved:    number;
  overdue:     number;
  pending:     number;
  resolutionRate: number | null; // 0–1
}

export interface DepartmentWorkload {
  departmentName: string | null;
  departmentId:   string | null;
  openActions:    number;
  overdueActions: number;
  avgPriority:    string | null;
}

export interface AnalyticsFilters {
  startDate?:    string;
  endDate?:      string;
  departmentId?: string;
  state?:        string;
}

// ── getDepartmentAnalytics ────────────────────────────────────────────────────

export async function getDepartmentAnalytics(
  filters: AnalyticsFilters = {}
): Promise<DepartmentAnalytics[]> {
  if (!pool) return [];

  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (filters.startDate)    { conditions.push(`created_at >= $${idx++}`);    params.push(filters.startDate); }
  if (filters.endDate)      { conditions.push(`created_at <= $${idx++}`);    params.push(filters.endDate); }
  if (filters.departmentId) { conditions.push(`department_id = $${idx++}`);  params.push(filters.departmentId); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const res = await pool.query(
      `SELECT
         department_name,
         department_id,
         COUNT(*)                                                      AS total_assigned,
         COUNT(*) FILTER (WHERE status = 'resolved')                   AS completed,
         COUNT(*) FILTER (WHERE status NOT IN ('resolved','cancelled','rejected')) AS pending,
         COUNT(*) FILTER (WHERE status = 'overdue')                    AS overdue,
         COUNT(*) FILTER (WHERE status = 'rejected')                   AS rejected,
         COUNT(*) FILTER (WHERE status = 'reopened')                   AS reopened,
         AVG(
           EXTRACT(EPOCH FROM (actual_completion_date - assigned_at)) / 86400
         ) FILTER (WHERE actual_completion_date IS NOT NULL)           AS avg_resolution_days,
         -- SLA compliance: resolved within expected_completion_date, as a fraction
         ROUND(
           COUNT(*) FILTER (
             WHERE status = 'resolved'
               AND actual_completion_date IS NOT NULL
               AND expected_completion_date IS NOT NULL
               AND actual_completion_date <= expected_completion_date
           )::numeric /
           NULLIF(COUNT(*) FILTER (WHERE status = 'resolved'), 0),
           4
         )                                                             AS sla_compliance_rate
       FROM civic_actions
       ${where}
       GROUP BY department_name, department_id
       ORDER BY total_assigned DESC`,
      params
    );

    return res.rows.map((r) => ({
      departmentName:    r.department_name,
      departmentId:      r.department_id,
      totalAssigned:     parseInt(r.total_assigned, 10),
      completed:         parseInt(r.completed, 10),
      pending:           parseInt(r.pending, 10),
      overdue:           parseInt(r.overdue, 10),
      rejected:          parseInt(r.rejected, 10),
      reopenedCount:     parseInt(r.reopened, 10),
      avgResolutionDays: r.avg_resolution_days ? parseFloat(r.avg_resolution_days) : null,
      slaComplianceRate: r.sla_compliance_rate ? parseFloat(r.sla_compliance_rate) : null,
    }));
  } catch (err: any) {
    logger.error(`[ANALYTICS] getDepartmentAnalytics error: ${err.message}`);
    return [];
  }
}

// ── getCategoryWiseResolution ─────────────────────────────────────────────────

export async function getCategoryWiseResolution(
  filters: AnalyticsFilters = {}
): Promise<CategoryAnalytics[]> {
  if (!pool) return [];

  // Derive category from cluster or complaints; civic_actions doesn't store category directly.
  // We join with cluster table where possible (via cluster_id).
  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (filters.startDate) { conditions.push(`ca.created_at >= $${idx++}`); params.push(filters.startDate); }
  if (filters.endDate)   { conditions.push(`ca.created_at <= $${idx++}`); params.push(filters.endDate); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const res = await pool.query(
      `SELECT
         cl.category,
         COUNT(ca.id)                                            AS total,
         COUNT(ca.id) FILTER (WHERE ca.status = 'resolved')     AS resolved,
         COUNT(ca.id) FILTER (WHERE ca.status = 'overdue')      AS overdue,
         COUNT(ca.id) FILTER (
           WHERE ca.status NOT IN ('resolved','cancelled','rejected')
         )                                                       AS pending,
         ROUND(
           COUNT(ca.id) FILTER (WHERE ca.status = 'resolved')::numeric /
           NULLIF(COUNT(ca.id), 0),
           4
         )                                                       AS resolution_rate
       FROM civic_actions ca
       LEFT JOIN cluster cl ON ca.cluster_id = cl.id
       ${where}
       GROUP BY cl.category
       ORDER BY total DESC`,
      params
    );

    return res.rows.map((r) => ({
      category:       r.category,
      total:          parseInt(r.total, 10),
      resolved:       parseInt(r.resolved, 10),
      overdue:        parseInt(r.overdue, 10),
      pending:        parseInt(r.pending, 10),
      resolutionRate: r.resolution_rate ? parseFloat(r.resolution_rate) : null,
    }));
  } catch (err: any) {
    logger.error(`[ANALYTICS] getCategoryWiseResolution error: ${err.message}`);
    return [];
  }
}

// ── getDepartmentWorkload ─────────────────────────────────────────────────────

export async function getDepartmentWorkload(): Promise<DepartmentWorkload[]> {
  if (!pool) return [];

  try {
    const res = await pool.query(
      `SELECT
         department_name,
         department_id,
         COUNT(*) FILTER (WHERE status NOT IN ('resolved','cancelled','rejected')) AS open_actions,
         COUNT(*) FILTER (WHERE status = 'overdue')                                AS overdue_actions,
         MODE() WITHIN GROUP (ORDER BY priority)                                   AS avg_priority
       FROM civic_actions
       GROUP BY department_name, department_id
       ORDER BY open_actions DESC`
    );

    return res.rows.map((r) => ({
      departmentName: r.department_name,
      departmentId:   r.department_id,
      openActions:    parseInt(r.open_actions, 10),
      overdueActions: parseInt(r.overdue_actions, 10),
      avgPriority:    r.avg_priority,
    }));
  } catch (err: any) {
    logger.error(`[ANALYTICS] getDepartmentWorkload error: ${err.message}`);
    return [];
  }
}
