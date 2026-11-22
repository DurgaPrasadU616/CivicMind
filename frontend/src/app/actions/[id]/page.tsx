'use client';

import React, { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAuth } from '../../../context/AuthContext';
import { apiClient } from '../../../lib/api';
import {
  CheckCircle2, Clock, Building2,
  ChevronLeft, UserCheck, ShieldCheck, UploadCloud,
  FileCheck2, RotateCcw, Sparkles, RefreshCw
} from 'lucide-react';
import { Card } from '../../../components/ui/card';
import { Button } from '../../../components/ui/button';
import { Badge } from '../../../components/ui/badge';
import { Input } from '../../../components/ui/input';
import { cn } from '../../../lib/utils';

interface ActionDossier {
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
}

export default function ActionDetailsPage() {
  const params = useParams();
  const router = useRouter();
  const { userRole } = useAuth();
  const actionId = params?.id as string;

  const [dossier, setDossier] = useState<ActionDossier | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionInProgress, setActionInProgress] = useState(false);

  // Assignment Modal
  const [showAssignModal, setShowAssignModal] = useState(false);
  const [deptName, setDeptName] = useState('');
  const [officerName, setOfficerName] = useState('');
  const [targetDate, setTargetDate] = useState('');
  const [assignNotes, setAssignNotes] = useState('');

  // Status Modal
  const [showStatusModal, setShowStatusModal] = useState(false);
  const [newStatus, setNewStatus] = useState('');
  const [statusReason, setStatusReason] = useState('');

  // Reopen Modal
  const [showReopenModal, setShowReopenModal] = useState(false);
  const [reopenReason, setReopenReason] = useState('');

  const refetch = async () => {
    if (!actionId) return;
    try {
      setLoading(true);
      setError(null);
      const res = await apiClient.getAction(actionId);
      setDossier(res.data);
      if (res.data.action.department_name) {
        setDeptName(res.data.action.department_name);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to load action dossier';
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let active = true;
    if (!actionId) return;
    void (async () => {
      try {
        const res = await apiClient.getAction(actionId);
        if (active) {
          setDossier(res.data);
          if (res.data.action.department_name) {
            setDeptName(res.data.action.department_name);
          }
          setLoading(false);
        }
      } catch (err: unknown) {
        if (active) {
          const message = err instanceof Error ? err.message : 'Failed to load action dossier';
          setError(message);
          setLoading(false);
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [actionId]);

  const handleApprove = async () => {
    try {
      setActionInProgress(true);
      await apiClient.approveAction(actionId);
      await refetch();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Approval failed');
    } finally {
      setActionInProgress(false);
    }
  };

  const handleAssign = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!deptName.trim()) return;
    try {
      setActionInProgress(true);
      await apiClient.assignAction(actionId, {
        departmentName: deptName.trim(),
        officerName: officerName.trim() || undefined,
        expectedCompletionDate: targetDate ? new Date(targetDate).toISOString() : undefined,
        notes: assignNotes.trim() || undefined,
      });
      setShowAssignModal(false);
      await refetch();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Assignment failed');
    } finally {
      setActionInProgress(false);
    }
  };

  const handleUpdateStatus = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newStatus) return;
    try {
      setActionInProgress(true);
      await apiClient.updateActionStatus(actionId, {
        newStatus,
        changeReason: statusReason.trim() || undefined,
      });
      setShowStatusModal(false);
      await refetch();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Status update failed');
    } finally {
      setActionInProgress(false);
    }
  };

  const handleReopen = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reopenReason.trim()) return;
    try {
      setActionInProgress(true);
      await apiClient.reopenAction(actionId, { reason: reopenReason.trim() });
      setShowReopenModal(false);
      await refetch();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Reopen failed');
    } finally {
      setActionInProgress(false);
    }
  };

  const isOfficial = userRole && ['govt', 'admin', 'ngo'].includes(userRole);

  if (loading) {
    return (
      <div className="p-8 text-center text-neutral-400 text-sm">
        <RefreshCw className="w-6 h-6 animate-spin mx-auto mb-2 text-indigo-400" />
        Loading action dossier #{actionId}...
      </div>
    );
  }

  if (error || !dossier) {
    return (
      <div className="p-8 max-w-4xl mx-auto space-y-4">
        <div className="p-4 rounded-lg bg-rose-500/10 border border-rose-500/20 text-rose-400 text-sm">
          {error || 'Action not found'}
        </div>
        <Button variant="outline" size="sm" onClick={() => router.push('/actions')}>
          <ChevronLeft className="w-4 h-4 mr-1" /> Back to Actions
        </Button>
      </div>
    );
  }

  const { action, assignments, history, evidence, slaMetrics } = dossier;

  const currentAssignment = assignments.find((a) => a.is_current) || assignments[0];

  const formatDuration = (ms: number | null) => {
    if (ms === null) return '—';
    const hours = Math.floor(ms / (1000 * 60 * 60));
    const days = Math.floor(hours / 24);
    if (days > 0) return `${days}d ${hours % 24}h`;
    return `${hours}h`;
  };

  return (
    <div className="p-8 max-w-6xl mx-auto space-y-6">
      {/* Back button & Breadcrumb */}
      <div className="flex items-center justify-between">
        <Link href="/actions">
          <Button variant="ghost" size="sm" className="text-neutral-400 hover:text-white">
            <ChevronLeft className="w-4 h-4 mr-1" />
            Back to Actions
          </Button>
        </Link>
        <div className="flex items-center gap-2">
          {action.investigation_id && (
            <Link href={`/investigations`}>
              <Badge variant="outline" className="text-xs bg-indigo-500/10 text-indigo-400 border-indigo-500/20">
                Investigation #{action.investigation_id}
              </Badge>
            </Link>
          )}
          {action.cluster_id && (
            <Badge variant="outline" className="text-xs bg-neutral-800 text-neutral-300">
              Cluster #{action.cluster_id}
            </Badge>
          )}
        </div>
      </div>

      {/* Main Action Header Card */}
      <Card className="p-6 bg-surface border-white/5 space-y-4">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-mono text-neutral-500">Action #{action.id}</span>
              <Badge variant="outline" className="text-xs uppercase bg-indigo-500/20 text-indigo-300 border-indigo-500/30">
                {action.priority}
              </Badge>
              <Badge variant="outline" className="text-xs capitalize bg-cyan-500/10 text-cyan-400 border-cyan-500/20">
                {action.status.replace('_', ' ')}
              </Badge>
            </div>
            <h1 className="text-2xl font-bold text-white tracking-tight">
              {action.action_title}
            </h1>
            <p className="text-sm text-neutral-300 leading-relaxed pt-1">
              {action.description}
            </p>
          </div>

          {/* Quick Action Buttons */}
          <div className="flex items-center gap-2 flex-wrap">
            {action.status === 'pending_approval' && isOfficial && (
              <Button
                size="sm"
                onClick={handleApprove}
                disabled={actionInProgress}
                className="bg-emerald-600 hover:bg-emerald-500"
              >
                <CheckCircle2 className="w-4 h-4 mr-1.5" />
                Approve Action
              </Button>
            )}

            {['approved', 'assigned'].includes(action.status) && isOfficial && (
              <Button
                size="sm"
                onClick={() => setShowAssignModal(true)}
                className="bg-indigo-600 hover:bg-indigo-500"
              >
                <UserCheck className="w-4 h-4 mr-1.5" />
                {action.status === 'assigned' ? 'Reassign' : 'Assign Department'}
              </Button>
            )}

            {['assigned', 'in_progress'].includes(action.status) && isOfficial && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setNewStatus(action.status === 'assigned' ? 'in_progress' : 'awaiting_verification');
                  setShowStatusModal(true);
                }}
              >
                {action.status === 'assigned' ? 'Start Work' : 'Submit for Verification'}
              </Button>
            )}

            {['awaiting_verification', 'in_progress'].includes(action.status) && isOfficial && (
              <Link href={`/actions/${action.id}/resolve`}>
                <Button size="sm" className="bg-purple-600 hover:bg-purple-500">
                  <ShieldCheck className="w-4 h-4 mr-1.5" />
                  Resolution Verification
                </Button>
              </Link>
            )}

            {action.status === 'resolved' && isOfficial && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowReopenModal(true)}
                className="text-orange-400 border-orange-500/20 hover:bg-orange-500/10"
              >
                <RotateCcw className="w-4 h-4 mr-1.5" />
                Reopen Action
              </Button>
            )}
          </div>
        </div>
      </Card>

      {/* Grid: SLA Status & Assignment Context */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* SLA Status Card */}
        <Card className="p-6 bg-surface border-white/5 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-white flex items-center gap-2">
              <Clock className="w-4 h-4 text-indigo-400" />
              SLA Monitoring & Deadline
            </h3>
            <Badge
              variant="outline"
              className={cn(
                'text-xs font-semibold',
                slaMetrics.complianceStatus === 'on_track' && 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
                slaMetrics.complianceStatus === 'at_risk' && 'bg-amber-500/10 text-amber-400 border-amber-500/20',
                slaMetrics.complianceStatus === 'overdue' && 'bg-rose-500/10 text-rose-400 border-rose-500/20',
                slaMetrics.complianceStatus === 'completed' && 'bg-blue-500/10 text-blue-400 border-blue-500/20'
              )}
            >
              {slaMetrics.complianceStatus.replace('_', ' ').toUpperCase()}
            </Badge>
          </div>

          <div className="grid grid-cols-2 gap-4 text-xs">
            <div>
              <span className="text-neutral-400">Time Elapsed:</span>
              <div className="text-sm font-semibold text-white mt-0.5">
                {formatDuration(slaMetrics.timeElapsedMs)}
              </div>
            </div>
            <div>
              <span className="text-neutral-400">Target Deadline:</span>
              <div className="text-sm font-semibold text-white mt-0.5">
                {action.expected_completion_date
                  ? new Date(action.expected_completion_date).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
                  : 'Not scheduled'}
              </div>
            </div>
            <div>
              <span className="text-neutral-400">Remaining / Overdue:</span>
              <div
                className={cn(
                  'text-sm font-semibold mt-0.5',
                  slaMetrics.isOverdue ? 'text-rose-400' : 'text-emerald-400'
                )}
              >
                {slaMetrics.isOverdue
                  ? `Overdue by ${formatDuration(slaMetrics.overdueDurationMs)}`
                  : slaMetrics.timeRemainingMs
                  ? `${formatDuration(slaMetrics.timeRemainingMs)} left`
                  : 'N/A'}
              </div>
            </div>
            <div>
              <span className="text-neutral-400">Actual Completion:</span>
              <div className="text-sm font-semibold text-white mt-0.5">
                {action.actual_completion_date
                  ? new Date(action.actual_completion_date).toLocaleDateString()
                  : 'In progress'}
              </div>
            </div>
          </div>
        </Card>

        {/* Current Assignment Card */}
        <Card className="p-6 bg-surface border-white/5 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-white flex items-center gap-2">
              <Building2 className="w-4 h-4 text-indigo-400" />
              Department Assignment
            </h3>
            {currentAssignment?.is_current && (
              <Badge variant="outline" className="text-xs bg-indigo-500/10 text-indigo-400 border-indigo-500/20">
                Active Assignment
              </Badge>
            )}
          </div>

          {currentAssignment ? (
            <div className="space-y-2 text-xs">
              <div className="flex justify-between py-1 border-b border-white/5">
                <span className="text-neutral-400">Department:</span>
                <span className="font-semibold text-white">{currentAssignment.department_name}</span>
              </div>
              <div className="flex justify-between py-1 border-b border-white/5">
                <span className="text-neutral-400">Assigned Officer:</span>
                <span className="font-semibold text-white">{currentAssignment.officer_name || 'Pending assignment'}</span>
              </div>
              <div className="flex justify-between py-1 border-b border-white/5">
                <span className="text-neutral-400">Assigned Date:</span>
                <span className="text-neutral-300">{new Date(currentAssignment.assigned_at).toLocaleDateString()}</span>
              </div>
              {currentAssignment.notes && (
                <div className="pt-1 text-neutral-400 italic">
                  &ldquo;{currentAssignment.notes}&rdquo;
                </div>
              )}
            </div>
          ) : (
            <div className="text-xs text-neutral-500 italic py-4 text-center">
              No department assigned yet. Officials can assign an authority above.
            </div>
          )}
        </Card>
      </div>

      {/* Evidence Section */}
      <Card className="p-6 bg-surface border-white/5 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-base font-semibold text-white flex items-center gap-2">
              <FileCheck2 className="w-4 h-4 text-indigo-400" />
              Resolution Evidence Gallery
            </h3>
            <p className="text-xs text-neutral-400 mt-0.5">
              Before and after photographs showing verified resolution progress.
            </p>
          </div>
          <Link href={`/actions/${action.id}/resolve`}>
            <Button size="sm" variant="outline" className="text-xs">
              <UploadCloud className="w-3.5 h-3.5 mr-1.5" />
              Upload Evidence
            </Button>
          </Link>
        </div>

        {evidence.length === 0 ? (
          <div className="p-8 text-center border border-dashed border-white/10 rounded-lg">
            <UploadCloud className="w-8 h-8 text-neutral-600 mx-auto mb-2" />
            <p className="text-xs text-neutral-400">No resolution evidence uploaded yet.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
            {evidence.map((ev) => (
              <div
                key={ev.id}
                className="p-3 rounded-lg bg-neutral-900 border border-white/5 space-y-2 text-xs"
              >
                <div className="flex items-center justify-between">
                  <Badge variant="outline" className="text-[10px] uppercase font-mono">
                    {ev.evidence_type}
                  </Badge>
                  <span className="text-[10px] text-neutral-500">
                    {new Date(ev.created_at).toLocaleDateString()}
                  </span>
                </div>
                <div className="aspect-video bg-neutral-950 rounded flex items-center justify-center text-neutral-600 font-mono text-[11px] overflow-hidden">
                  <span className="p-2 text-center truncate">{ev.original_filename || ev.storage_key}</span>
                </div>
                {ev.description && (
                  <p className="text-neutral-400 line-clamp-2">{ev.description}</p>
                )}
                {ev.ai_analysis && (
                  <div className="p-2 rounded bg-indigo-500/5 border border-indigo-500/10 text-[11px] text-indigo-300">
                    <span className="flex items-center gap-1 font-semibold mb-0.5">
                      <Sparkles className="w-3 h-3 text-indigo-400" />
                      AI Analysis (Confidence: {((ev.ai_confidence_score || 0) * 100).toFixed(0)}%)
                    </span>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Status History Timeline */}
      <Card className="p-6 bg-surface border-white/5 space-y-4">
        <h3 className="text-base font-semibold text-white">Action Audit Trail</h3>
        <div className="space-y-3">
          {history.map((h, i) => (
            <div key={h.id || i} className="flex items-start gap-3 text-xs">
              <div className="w-2 h-2 rounded-full bg-indigo-500 mt-1.5 shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-white uppercase">{h.new_status.replace('_', ' ')}</span>
                  <span className="text-neutral-500">
                    {new Date(h.created_at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}
                  </span>
                </div>
                {h.change_reason && (
                  <p className="text-neutral-400 mt-0.5">{h.change_reason}</p>
                )}
              </div>
            </div>
          ))}
        </div>
      </Card>

      {/* Assign Modal */}
      {showAssignModal && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <Card className="w-full max-w-md bg-neutral-900 border-white/10 p-6 space-y-4">
            <h2 className="text-lg font-bold text-white">Assign Department & Officer</h2>
            <form onSubmit={handleAssign} className="space-y-3">
              <div>
                <label className="text-xs font-medium text-neutral-300 block mb-1">
                  Department Name *
                </label>
                <Input
                  required
                  value={deptName}
                  onChange={(e) => setDeptName(e.target.value)}
                  placeholder="e.g. BBMP Roads & Infrastructure"
                  className="bg-neutral-800 border-white/10 text-sm"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-neutral-300 block mb-1">
                  Officer Name
                </label>
                <Input
                  value={officerName}
                  onChange={(e) => setOfficerName(e.target.value)}
                  placeholder="e.g. Ramesh Kumar"
                  className="bg-neutral-800 border-white/10 text-sm"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-neutral-300 block mb-1">
                  Target Completion Date
                </label>
                <Input
                  type="datetime-local"
                  value={targetDate}
                  onChange={(e) => setTargetDate(e.target.value)}
                  className="bg-neutral-800 border-white/10 text-sm"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-neutral-300 block mb-1">
                  Notes
                </label>
                <textarea
                  rows={2}
                  value={assignNotes}
                  onChange={(e) => setAssignNotes(e.target.value)}
                  placeholder="Instructions for the department..."
                  className="w-full bg-neutral-800 border border-white/10 rounded-md p-2 text-xs text-white"
                />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <Button type="button" variant="ghost" size="sm" onClick={() => setShowAssignModal(false)}>
                  Cancel
                </Button>
                <Button type="submit" size="sm" disabled={actionInProgress} className="bg-indigo-600 hover:bg-indigo-500">
                  Save Assignment
                </Button>
              </div>
            </form>
          </Card>
        </div>
      )}

      {/* Status Modal */}
      {showStatusModal && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <Card className="w-full max-w-md bg-neutral-900 border-white/10 p-6 space-y-4">
            <h2 className="text-lg font-bold text-white">Update Action Status</h2>
            <form onSubmit={handleUpdateStatus} className="space-y-3">
              <div>
                <label className="text-xs font-medium text-neutral-300 block mb-1">
                  New Status: <span className="text-indigo-400 font-semibold">{newStatus}</span>
                </label>
                <textarea
                  rows={3}
                  value={statusReason}
                  onChange={(e) => setStatusReason(e.target.value)}
                  placeholder="Reason or notes regarding this status change..."
                  className="w-full bg-neutral-800 border border-white/10 rounded-md p-2 text-xs text-white"
                />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <Button type="button" variant="ghost" size="sm" onClick={() => setShowStatusModal(false)}>
                  Cancel
                </Button>
                <Button type="submit" size="sm" disabled={actionInProgress} className="bg-indigo-600 hover:bg-indigo-500">
                  Confirm Status Change
                </Button>
              </div>
            </form>
          </Card>
        </div>
      )}

      {/* Reopen Modal */}
      {showReopenModal && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <Card className="w-full max-w-md bg-neutral-900 border-white/10 p-6 space-y-4">
            <h2 className="text-lg font-bold text-white">Reopen Civic Action</h2>
            <form onSubmit={handleReopen} className="space-y-3">
              <div>
                <label className="text-xs font-medium text-neutral-300 block mb-1">
                  Reason for Reopening *
                </label>
                <textarea
                  required
                  rows={3}
                  value={reopenReason}
                  onChange={(e) => setReopenReason(e.target.value)}
                  placeholder="e.g. Issue recurred, pothole reappeared after rain..."
                  className="w-full bg-neutral-800 border border-white/10 rounded-md p-2 text-xs text-white"
                />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <Button type="button" variant="ghost" size="sm" onClick={() => setShowReopenModal(false)}>
                  Cancel
                </Button>
                <Button type="submit" size="sm" disabled={actionInProgress} className="bg-orange-600 hover:bg-orange-500">
                  Reopen Action
                </Button>
              </div>
            </form>
          </Card>
        </div>
      )}
    </div>
  );
}
