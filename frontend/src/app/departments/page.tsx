'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { apiClient } from '../../lib/api';
import {
  Building2, CheckCircle2, AlertTriangle, ArrowRight,
  RefreshCw
} from 'lucide-react';
import { Card } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Badge } from '../../components/ui/badge';
import { cn } from '../../lib/utils';

interface DepartmentSummary {
  departmentName: string | null;
  departmentId: string | null;
  totalAssigned: number;
  completed: number;
  pending: number;
  overdue: number;
  rejected: number;
  avgResolutionDays: number | null;
  slaComplianceRate: number | null;
}

export default function DepartmentsDashboardPage() {
  const [departments, setDepartments] = useState<DepartmentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await apiClient.getActionAnalytics();
      setDepartments(res.data.departmentAnalytics);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to load department analytics';
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const res = await apiClient.getActionAnalytics();
        if (active) {
          setDepartments(res.data.departmentAnalytics);
          setLoading(false);
        }
      } catch (err: unknown) {
        if (active) {
          const message = err instanceof Error ? err.message : 'Failed to load department analytics';
          setError(message);
          setLoading(false);
        }
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const totalAssigned = departments.reduce((acc, d) => acc + d.totalAssigned, 0);
  const totalCompleted = departments.reduce((acc, d) => acc + d.completed, 0);
  const totalOverdue = departments.reduce((acc, d) => acc + d.overdue, 0);

  return (
    <div className="p-8 max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white tracking-tight flex items-center gap-3">
            <Building2 className="w-7 h-7 text-indigo-400" />
            Municipal Departments & Workload
          </h1>
          <p className="text-sm text-neutral-400 mt-1">
            Departmental civic action dispatch, SLA compliance, and open backlog monitoring.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={refetch} disabled={loading}>
          <RefreshCw className={cn('w-4 h-4 mr-2', loading && 'animate-spin')} />
          Refresh
        </Button>
      </div>

      {/* Summary KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card className="p-5 bg-surface border-white/5">
          <div className="text-xs text-neutral-400 font-medium">Total Actions Dispatched</div>
          <div className="text-2xl font-bold text-white mt-1">{totalAssigned}</div>
        </Card>
        <Card className="p-5 bg-surface border-white/5">
          <div className="text-xs text-emerald-400 font-medium flex items-center gap-1.5">
            <CheckCircle2 className="w-4 h-4" /> Total Resolved
          </div>
          <div className="text-2xl font-bold text-emerald-400 mt-1">{totalCompleted}</div>
        </Card>
        <Card className="p-5 bg-surface border-white/5">
          <div className="text-xs text-rose-400 font-medium flex items-center gap-1.5">
            <AlertTriangle className="w-4 h-4" /> Total Overdue
          </div>
          <div className="text-2xl font-bold text-rose-400 mt-1">{totalOverdue}</div>
        </Card>
      </div>

      {/* Error state */}
      {error && (
        <div className="p-4 rounded-lg bg-rose-500/10 border border-rose-500/20 text-rose-400 text-sm">
          {error}
        </div>
      )}

      {/* Departments Grid */}
      {loading ? (
        <div className="text-center py-12 text-neutral-400 text-sm">
          <RefreshCw className="w-6 h-6 animate-spin mx-auto mb-2 text-indigo-400" />
          Loading departments...
        </div>
      ) : departments.length === 0 ? (
        <Card className="p-12 text-center bg-surface border-white/5">
          <Building2 className="w-12 h-12 text-neutral-600 mx-auto mb-3" />
          <h3 className="text-base font-semibold text-white">No Department Assignments Yet</h3>
          <p className="text-sm text-neutral-400 mt-1 max-w-sm mx-auto">
            Departments will appear here once civic actions are assigned to them.
          </p>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {departments.map((dept, idx) => {
            const compliancePct = dept.slaComplianceRate !== null
              ? (dept.slaComplianceRate * 100).toFixed(0) + '%'
              : 'N/A';

            return (
              <Card
                key={dept.departmentId || idx}
                className="p-5 bg-surface border-white/5 hover:border-white/10 transition-colors space-y-4"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="space-y-1">
                    <h3 className="text-base font-semibold text-white">
                      {dept.departmentName || 'Unassigned Department'}
                    </h3>
                    {dept.departmentId && (
                      <span className="text-[11px] font-mono text-neutral-500">
                        {dept.departmentId}
                      </span>
                    )}
                  </div>
                  <Badge variant="outline" className="text-[10px] bg-indigo-500/10 text-indigo-400">
                    SLA: {compliancePct}
                  </Badge>
                </div>

                <div className="grid grid-cols-3 gap-2 text-center py-2 border-y border-white/5 text-xs">
                  <div>
                    <span className="text-neutral-500">Assigned</span>
                    <div className="font-semibold text-white mt-0.5">{dept.totalAssigned}</div>
                  </div>
                  <div>
                    <span className="text-emerald-400">Resolved</span>
                    <div className="font-semibold text-emerald-400 mt-0.5">{dept.completed}</div>
                  </div>
                  <div>
                    <span className="text-rose-400">Overdue</span>
                    <div className="font-semibold text-rose-400 mt-0.5">{dept.overdue}</div>
                  </div>
                </div>

                <div className="flex items-center justify-between text-xs text-neutral-400 pt-1">
                  <span>
                    Avg. Resolution:{' '}
                    <strong className="text-neutral-200">
                      {dept.avgResolutionDays !== null
                        ? `${dept.avgResolutionDays.toFixed(1)} days`
                        : '—'}
                    </strong>
                  </span>
                  <Link href={`/actions?departmentId=${encodeURIComponent(dept.departmentId || '')}`}>
                    <Button variant="ghost" size="sm" className="text-xs text-indigo-400 p-0 h-auto">
                      View Actions <ArrowRight className="w-3 h-3 ml-1" />
                    </Button>
                  </Link>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
