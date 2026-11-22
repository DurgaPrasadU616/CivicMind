'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { useAuth } from '../../context/AuthContext';
import { apiClient } from '../../lib/api';
import {
  CheckCircle2, Clock, AlertTriangle, AlertCircle, Building2,
  Search, Plus, Eye, Check, RefreshCw
} from 'lucide-react';
import { Card } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Badge } from '../../components/ui/badge';
import { Input } from '../../components/ui/input';
import { cn } from '../../lib/utils';

interface ActionSummary {
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
}

const STATUS_CONFIG: Record<string, { label: string; color: string; border: string }> = {
  pending_approval:      { label: 'Pending Approval', color: 'bg-amber-500/10 text-amber-400', border: 'border-amber-500/20' },
  approved:              { label: 'Approved', color: 'bg-blue-500/10 text-blue-400', border: 'border-blue-500/20' },
  assigned:              { label: 'Assigned', color: 'bg-indigo-500/10 text-indigo-400', border: 'border-indigo-500/20' },
  in_progress:           { label: 'In Progress', color: 'bg-cyan-500/10 text-cyan-400', border: 'border-cyan-500/20' },
  awaiting_verification: { label: 'Awaiting Verification', color: 'bg-purple-500/10 text-purple-400', border: 'border-purple-500/20' },
  resolved:              { label: 'Resolved', color: 'bg-emerald-500/10 text-emerald-400', border: 'border-emerald-500/20' },
  rejected:              { label: 'Rejected', color: 'bg-neutral-500/10 text-neutral-400', border: 'border-neutral-500/20' },
  on_hold:               { label: 'On Hold', color: 'bg-yellow-500/10 text-yellow-400', border: 'border-yellow-500/20' },
  overdue:               { label: 'Overdue', color: 'bg-rose-500/10 text-rose-400', border: 'border-rose-500/20' },
  reopened:              { label: 'Reopened', color: 'bg-orange-500/10 text-orange-400', border: 'border-orange-500/20' },
  cancelled:             { label: 'Cancelled', color: 'bg-neutral-600/10 text-neutral-400', border: 'border-neutral-600/20' },
};

const PRIORITY_BADGES: Record<string, { label: string; color: string }> = {
  critical: { label: 'CRITICAL', color: 'bg-rose-500/20 text-rose-300 border-rose-500/30' },
  high:     { label: 'HIGH',     color: 'bg-amber-500/20 text-amber-300 border-amber-500/30' },
  medium:   { label: 'MEDIUM',   color: 'bg-blue-500/20 text-blue-300 border-blue-500/30' },
  low:      { label: 'LOW',      color: 'bg-neutral-500/20 text-neutral-300 border-neutral-500/30' },
};

export default function ActionsDashboardPage() {
  const { userRole } = useAuth();
  const [actions, setActions] = useState<ActionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [priorityFilter, setPriorityFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [approvingId, setApprovingId] = useState<number | null>(null);

  // New action modal state
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [newDept, setNewDept] = useState('');
  const [newPriority, setNewPriority] = useState('medium');
  const [creating, setCreating] = useState(false);

  const refetch = async () => {
    try {
      setLoading(true);
      setError(null);
      const params: { status?: string; priority?: string } = {};
      if (statusFilter !== 'all') params.status = statusFilter;
      if (priorityFilter !== 'all') params.priority = priorityFilter;
      const res = await apiClient.getActions(params);
      setActions(res.data);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to load civic actions';
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const params: { status?: string; priority?: string } = {};
        if (statusFilter !== 'all') params.status = statusFilter;
        if (priorityFilter !== 'all') params.priority = priorityFilter;
        const res = await apiClient.getActions(params);
        if (active) {
          setActions(res.data);
          setLoading(false);
        }
      } catch (err: unknown) {
        if (active) {
          const message = err instanceof Error ? err.message : 'Failed to load civic actions';
          setError(message);
          setLoading(false);
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [statusFilter, priorityFilter]);

  const handleApprove = async (id: number) => {
    try {
      setApprovingId(id);
      await apiClient.approveAction(id);
      await refetch();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Approval failed');
    } finally {
      setApprovingId(null);
    }
  };

  const handleCreateAction = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTitle.trim() || !newDesc.trim()) return;
    try {
      setCreating(true);
      await apiClient.createAction({
        actionTitle: newTitle.trim(),
        description: newDesc.trim(),
        departmentName: newDept.trim() || undefined,
        priority: newPriority,
      });
      setShowCreateModal(false);
      setNewTitle('');
      setNewDesc('');
      setNewDept('');
      await refetch();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Action creation failed');
    } finally {
      setCreating(false);
    }
  };

  const filtered = actions.filter((a) => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return (
      a.action_title.toLowerCase().includes(q) ||
      (a.department_name && a.department_name.toLowerCase().includes(q))
    );
  });

  const kpis = {
    total: actions.length,
    inProgress: actions.filter((a) => a.status === 'in_progress').length,
    awaiting: actions.filter((a) => a.status === 'awaiting_verification').length,
    overdue: actions.filter((a) => a.status === 'overdue').length,
    resolved: actions.filter((a) => a.status === 'resolved').length,
  };

  const isOfficial = userRole && ['govt', 'admin', 'ngo'].includes(userRole);

  return (
    <div className="p-8 max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white tracking-tight flex items-center gap-3">
            <CheckCircle2 className="w-7 h-7 text-indigo-400" />
            Civic Action & Resolution Intelligence
          </h1>
          <p className="text-sm text-neutral-400 mt-1">
            Track approved investigation recommendations through to verified civic resolution.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Button variant="outline" size="sm" onClick={refetch} disabled={loading}>
            <RefreshCw className={cn('w-4 h-4 mr-2', loading && 'animate-spin')} />
            Refresh
          </Button>
          {isOfficial && (
            <Button size="sm" onClick={() => setShowCreateModal(true)} className="bg-indigo-600 hover:bg-indigo-500">
              <Plus className="w-4 h-4 mr-2" />
              New Action
            </Button>
          )}
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <Card className="p-4 bg-surface border-white/5">
          <div className="text-xs text-neutral-400 font-medium">Total Actions</div>
          <div className="text-2xl font-bold text-white mt-1">{kpis.total}</div>
        </Card>
        <Card className="p-4 bg-surface border-white/5">
          <div className="text-xs text-cyan-400 font-medium flex items-center gap-1.5">
            <Clock className="w-3.5 h-3.5" /> In Progress
          </div>
          <div className="text-2xl font-bold text-cyan-400 mt-1">{kpis.inProgress}</div>
        </Card>
        <Card className="p-4 bg-surface border-white/5">
          <div className="text-xs text-purple-400 font-medium flex items-center gap-1.5">
            <AlertCircle className="w-3.5 h-3.5" /> Awaiting Verification
          </div>
          <div className="text-2xl font-bold text-purple-400 mt-1">{kpis.awaiting}</div>
        </Card>
        <Card className="p-4 bg-surface border-white/5">
          <div className="text-xs text-rose-400 font-medium flex items-center gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5" /> Overdue
          </div>
          <div className="text-2xl font-bold text-rose-400 mt-1">{kpis.overdue}</div>
        </Card>
        <Card className="p-4 bg-surface border-white/5">
          <div className="text-xs text-emerald-400 font-medium flex items-center gap-1.5">
            <CheckCircle2 className="w-3.5 h-3.5" /> Resolved
          </div>
          <div className="text-2xl font-bold text-emerald-400 mt-1">{kpis.resolved}</div>
        </Card>
      </div>

      {/* Filters & Search */}
      <Card className="p-4 bg-surface border-white/5">
        <div className="flex flex-col md:flex-row items-center gap-4">
          <div className="relative flex-1 w-full">
            <Search className="w-4 h-4 text-neutral-500 absolute left-3 top-1/2 -translate-y-1/2" />
            <Input
              placeholder="Search actions or departments..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9 bg-neutral-900 border-white/10 text-sm"
            />
          </div>
          <div className="flex items-center gap-3 w-full md:w-auto">
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="bg-neutral-900 border border-white/10 rounded-md px-3 py-2 text-xs text-neutral-300 focus:outline-none focus:border-indigo-500"
            >
              <option value="all">All Statuses</option>
              <option value="pending_approval">Pending Approval</option>
              <option value="approved">Approved</option>
              <option value="assigned">Assigned</option>
              <option value="in_progress">In Progress</option>
              <option value="awaiting_verification">Awaiting Verification</option>
              <option value="overdue">Overdue</option>
              <option value="resolved">Resolved</option>
              <option value="reopened">Reopened</option>
            </select>
            <select
              value={priorityFilter}
              onChange={(e) => setPriorityFilter(e.target.value)}
              className="bg-neutral-900 border border-white/10 rounded-md px-3 py-2 text-xs text-neutral-300 focus:outline-none focus:border-indigo-500"
            >
              <option value="all">All Priorities</option>
              <option value="critical">Critical</option>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </select>
          </div>
        </div>
      </Card>

      {/* Actions List */}
      {error && (
        <div className="p-4 rounded-lg bg-rose-500/10 border border-rose-500/20 text-rose-400 text-sm">
          {error}
        </div>
      )}

      {loading ? (
        <div className="text-center py-12 text-neutral-400 text-sm">
          <RefreshCw className="w-6 h-6 animate-spin mx-auto mb-2 text-indigo-400" />
          Loading civic actions...
        </div>
      ) : filtered.length === 0 ? (
        <Card className="p-12 text-center bg-surface border-white/5">
          <CheckCircle2 className="w-12 h-12 text-neutral-600 mx-auto mb-3" />
          <h3 className="text-base font-semibold text-white">No Civic Actions Found</h3>
          <p className="text-sm text-neutral-400 mt-1 max-w-sm mx-auto">
            {actions.length === 0
              ? 'Approve investigation recommendations to create tracked civic actions.'
              : 'No actions match your current filter criteria.'}
          </p>
        </Card>
      ) : (
        <div className="space-y-3">
          {filtered.map((action) => {
            const statusCfg = STATUS_CONFIG[action.status] || {
              label: action.status,
              color: 'bg-neutral-500/10 text-neutral-400',
              border: 'border-neutral-500/20',
            };
            const priorityBadge = PRIORITY_BADGES[action.priority] || PRIORITY_BADGES.medium;

            return (
              <Card
                key={action.id}
                className="p-5 bg-surface border-white/5 hover:border-white/10 transition-colors"
              >
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                  <div className="space-y-1.5 flex-1 min-w-0">
                    <div className="flex items-center gap-2.5 flex-wrap">
                      <span className="text-xs font-mono text-neutral-500">#{action.id}</span>
                      <Badge variant="outline" className={cn('text-[10px] px-2 py-0.5', priorityBadge.color)}>
                        {priorityBadge.label}
                      </Badge>
                      <Badge variant="outline" className={cn('text-[10px] px-2 py-0.5', statusCfg.color, statusCfg.border)}>
                        {statusCfg.label}
                      </Badge>
                      {action.department_name && (
                        <span className="text-xs text-neutral-400 flex items-center gap-1">
                          <Building2 className="w-3.5 h-3.5 text-neutral-500" />
                          {action.department_name}
                        </span>
                      )}
                    </div>
                    <h3 className="text-base font-semibold text-white tracking-tight truncate">
                      {action.action_title}
                    </h3>
                    <p className="text-xs text-neutral-400 line-clamp-2">
                      {action.description}
                    </p>
                    <div className="flex items-center gap-4 text-[11px] text-neutral-500 pt-1">
                      <span>Created {new Date(action.created_at).toLocaleDateString()}</span>
                      {action.expected_completion_date && (
                        <span className="flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          Target: {new Date(action.expected_completion_date).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Actions buttons */}
                  <div className="flex items-center gap-2 self-start md:self-center shrink-0">
                    {action.status === 'pending_approval' && isOfficial && (
                      <Button
                        size="sm"
                        onClick={() => handleApprove(action.id)}
                        disabled={approvingId === action.id}
                        className="bg-emerald-600 hover:bg-emerald-500 text-xs"
                      >
                        <Check className="w-3.5 h-3.5 mr-1.5" />
                        Approve
                      </Button>
                    )}
                    <Link href={`/actions/${action.id}`}>
                      <Button variant="outline" size="sm" className="text-xs">
                        <Eye className="w-3.5 h-3.5 mr-1.5" />
                        Details
                      </Button>
                    </Link>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {/* Create Action Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <Card className="w-full max-w-lg bg-neutral-900 border-white/10 p-6 space-y-4">
            <h2 className="text-lg font-bold text-white">Create Civic Action</h2>
            <form onSubmit={handleCreateAction} className="space-y-4">
              <div>
                <label className="text-xs font-medium text-neutral-300 block mb-1">
                  Action Title *
                </label>
                <Input
                  required
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  placeholder="e.g. Resurface damaged road segment"
                  className="bg-neutral-800 border-white/10 text-sm"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-neutral-300 block mb-1">
                  Description *
                </label>
                <textarea
                  required
                  rows={3}
                  value={newDesc}
                  onChange={(e) => setNewDesc(e.target.value)}
                  placeholder="Detailed instructions for the department..."
                  className="w-full bg-neutral-800 border border-white/10 rounded-md p-2.5 text-sm text-white focus:outline-none focus:border-indigo-500"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-neutral-300 block mb-1">
                    Department
                  </label>
                  <Input
                    value={newDept}
                    onChange={(e) => setNewDept(e.target.value)}
                    placeholder="e.g. BBMP Roads"
                    className="bg-neutral-800 border-white/10 text-sm"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-neutral-300 block mb-1">
                    Priority
                  </label>
                  <select
                    value={newPriority}
                    onChange={(e) => setNewPriority(e.target.value)}
                    className="w-full bg-neutral-800 border border-white/10 rounded-md px-3 py-2 text-sm text-neutral-300 focus:outline-none"
                  >
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                    <option value="critical">Critical</option>
                  </select>
                </div>
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowCreateModal(false)}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  size="sm"
                  disabled={creating}
                  className="bg-indigo-600 hover:bg-indigo-500"
                >
                  {creating ? 'Creating...' : 'Create Action'}
                </Button>
              </div>
            </form>
          </Card>
        </div>
      )}
    </div>
  );
}
