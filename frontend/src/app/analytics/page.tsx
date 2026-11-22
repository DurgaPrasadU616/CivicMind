'use client';

import React, { useState, useEffect } from 'react';
import { apiClient } from '../../lib/api';
import {
  BarChart3, CheckCircle2, Building2,
  RefreshCw, Layers
} from 'lucide-react';
import { Card } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Badge } from '../../components/ui/badge';
import { cn } from '../../lib/utils';

interface AnalyticsData {
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
}

export default function PerformanceAnalyticsPage() {
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await apiClient.getActionAnalytics();
      setData(res.data);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to load performance analytics';
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
          setData(res.data);
          setLoading(false);
        }
      } catch (err: unknown) {
        if (active) {
          const message = err instanceof Error ? err.message : 'Failed to load performance analytics';
          setError(message);
          setLoading(false);
        }
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  if (loading) {
    return (
      <div className="p-8 text-center text-neutral-400 text-sm">
        <RefreshCw className="w-6 h-6 animate-spin mx-auto mb-2 text-indigo-400" />
        Loading performance analytics...
      </div>
    );
  }

  const deptList = data?.departmentAnalytics || [];
  const catList = data?.categoryAnalytics || [];
  const totalActions = deptList.reduce((acc, d) => acc + d.totalAssigned, 0);
  const totalResolved = deptList.reduce((acc, d) => acc + d.completed, 0);
  const overallRate = totalActions > 0 ? ((totalResolved / totalActions) * 100).toFixed(0) : '0';

  return (
    <div className="p-8 max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white tracking-tight flex items-center gap-3">
            <BarChart3 className="w-7 h-7 text-indigo-400" />
            Civic Resolution Analytics
          </h1>
          <p className="text-sm text-neutral-400 mt-1">
            Data-backed municipal resolution efficiency, category distributions, and SLA compliance metrics.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={refetch} disabled={loading}>
          <RefreshCw className={cn('w-4 h-4 mr-2', loading && 'animate-spin')} />
          Refresh
        </Button>
      </div>

      {error && (
        <div className="p-4 rounded-lg bg-rose-500/10 border border-rose-500/20 text-rose-400 text-sm">
          {error}
        </div>
      )}

      {/* Top High-Level Metrics */}
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
        <Card className="p-5 bg-surface border-white/5">
          <div className="text-xs text-neutral-400 font-medium">Total Action Workload</div>
          <div className="text-2xl font-bold text-white mt-1">{totalActions}</div>
        </Card>
        <Card className="p-5 bg-surface border-white/5">
          <div className="text-xs text-emerald-400 font-medium flex items-center gap-1.5">
            <CheckCircle2 className="w-4 h-4" /> Overall Resolution Rate
          </div>
          <div className="text-2xl font-bold text-emerald-400 mt-1">{overallRate}%</div>
        </Card>
        <Card className="p-5 bg-surface border-white/5">
          <div className="text-xs text-indigo-400 font-medium flex items-center gap-1.5">
            <Building2 className="w-4 h-4" /> Reporting Departments
          </div>
          <div className="text-2xl font-bold text-indigo-400 mt-1">{deptList.length}</div>
        </Card>
        <Card className="p-5 bg-surface border-white/5">
          <div className="text-xs text-purple-400 font-medium flex items-center gap-1.5">
            <Layers className="w-4 h-4" /> Civic Categories
          </div>
          <div className="text-2xl font-bold text-purple-400 mt-1">{catList.length}</div>
        </Card>
      </div>

      {/* Department SLA & Efficiency Table */}
      <Card className="p-6 bg-surface border-white/5 space-y-4">
        <h3 className="text-base font-semibold text-white flex items-center gap-2">
          <Building2 className="w-4 h-4 text-indigo-400" />
          Departmental SLA Compliance & Efficiency
        </h3>

        {deptList.length === 0 ? (
          <p className="text-xs text-neutral-500 italic py-4">No department metrics available yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs text-left">
              <thead>
                <tr className="border-b border-white/10 text-neutral-400">
                  <th className="py-2.5 px-3">Department</th>
                  <th className="py-2.5 px-3 text-center">Assigned</th>
                  <th className="py-2.5 px-3 text-center">Resolved</th>
                  <th className="py-2.5 px-3 text-center">Overdue</th>
                  <th className="py-2.5 px-3 text-center">Avg Days</th>
                  <th className="py-2.5 px-3 text-right">SLA Compliance</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {deptList.map((d, i) => {
                  const compliance = d.slaComplianceRate !== null
                    ? `${(d.slaComplianceRate * 100).toFixed(0)}%`
                    : 'N/A';
                  return (
                    <tr key={i} className="hover:bg-white/[0.02]">
                      <td className="py-2.5 px-3 font-semibold text-white">
                        {d.departmentName || 'Unassigned'}
                      </td>
                      <td className="py-2.5 px-3 text-center text-neutral-300">{d.totalAssigned}</td>
                      <td className="py-2.5 px-3 text-center text-emerald-400">{d.completed}</td>
                      <td className="py-2.5 px-3 text-center text-rose-400">{d.overdue}</td>
                      <td className="py-2.5 px-3 text-center text-neutral-300">
                        {d.avgResolutionDays ? d.avgResolutionDays.toFixed(1) : '—'}
                      </td>
                      <td className="py-2.5 px-3 text-right">
                        <Badge
                          variant="outline"
                          className={cn(
                            'text-[10px]',
                            d.slaComplianceRate !== null && d.slaComplianceRate >= 0.8
                              ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                              : 'bg-amber-500/10 text-amber-400 border-amber-500/20'
                          )}
                        >
                          {compliance}
                        </Badge>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Category-Wise Resolution Distribution */}
      <Card className="p-6 bg-surface border-white/5 space-y-4">
        <h3 className="text-base font-semibold text-white flex items-center gap-2">
          <Layers className="w-4 h-4 text-indigo-400" />
          Category Resolution Performance
        </h3>

        {catList.length === 0 ? (
          <p className="text-xs text-neutral-500 italic py-4">No category data recorded yet.</p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
            {catList.map((cat, i) => {
              const rate = cat.resolutionRate !== null
                ? `${(cat.resolutionRate * 100).toFixed(0)}%`
                : '0%';
              return (
                <div key={i} className="p-4 rounded-lg bg-neutral-900 border border-white/5 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold text-white capitalize">
                      {cat.category || 'General'}
                    </span>
                    <Badge variant="outline" className="text-[10px] bg-indigo-500/10 text-indigo-400">
                      {rate}
                    </Badge>
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-center text-[11px] pt-1">
                    <div>
                      <span className="text-neutral-500">Total</span>
                      <div className="font-semibold text-white mt-0.5">{cat.total}</div>
                    </div>
                    <div>
                      <span className="text-emerald-400">Resolved</span>
                      <div className="font-semibold text-emerald-400 mt-0.5">{cat.resolved}</div>
                    </div>
                    <div>
                      <span className="text-rose-400">Overdue</span>
                      <div className="font-semibold text-rose-400 mt-0.5">{cat.overdue}</div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}
