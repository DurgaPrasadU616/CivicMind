'use client';

import React, { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { apiClient } from '../../../../lib/api';
import {
  CheckCircle2, Clock, Building2,
  ChevronLeft, RotateCcw, ShieldCheck, RefreshCw
} from 'lucide-react';
import { Card } from '../../../../components/ui/card';
import { Button } from '../../../../components/ui/button';
import { Badge } from '../../../../components/ui/badge';
import { cn } from '../../../../lib/utils';

interface CitizenProgressData {
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
}

const LIFECYCLE_STEPS = [
  { key: 'received',              label: 'Complaint Submitted',     desc: 'Complaint received and clustered' },
  { key: 'pending_approval',      label: 'Investigation & Review',  desc: 'AI investigation and official review' },
  { key: 'approved',              label: 'Action Approved',         desc: 'Approved for civic resolution' },
  { key: 'assigned',              label: 'Department Assigned',     desc: 'Dispatched to municipal department' },
  { key: 'in_progress',           label: 'Work in Progress',        desc: 'On-site field work active' },
  { key: 'awaiting_verification', label: 'Quality Verification',    desc: 'Before/after evidence verification' },
  { key: 'resolved',              label: 'Resolution Verified',     desc: 'Confirmed resolved by civic authority' },
];

export default function CitizenProgressPage() {
  const params = useParams();
  const router = useRouter();
  const complaintId = params?.id as string;

  const [data, setData] = useState<CitizenProgressData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reopenReason, setReopenReason] = useState('');
  const [showReopenModal, setShowReopenModal] = useState(false);
  const [reopening, setReopening] = useState(false);

  const refetch = async () => {
    if (!complaintId) return;
    try {
      setLoading(true);
      setError(null);
      const res = await apiClient.getCitizenProgress(complaintId);
      setData(res.data);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to load complaint progress';
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let active = true;
    if (!complaintId) return;
    void (async () => {
      try {
        const res = await apiClient.getCitizenProgress(complaintId);
        if (active) {
          setData(res.data);
          setLoading(false);
        }
      } catch (err: unknown) {
        if (active) {
          const message = err instanceof Error ? err.message : 'Failed to load complaint progress';
          setError(message);
          setLoading(false);
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [complaintId]);

  const handleReopen = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!data?.actionId || !reopenReason.trim()) return;
    try {
      setReopening(true);
      await apiClient.reopenAction(data.actionId, { reason: reopenReason.trim() });
      setShowReopenModal(false);
      await refetch();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Reopen request failed');
    } finally {
      setReopening(false);
    }
  };

  if (loading) {
    return (
      <div className="p-8 text-center text-neutral-400 text-sm">
        <RefreshCw className="w-6 h-6 animate-spin mx-auto mb-2 text-indigo-400" />
        Tracking complaint #{complaintId}...
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="p-8 max-w-3xl mx-auto space-y-4">
        <div className="p-4 rounded-lg bg-rose-500/10 border border-rose-500/20 text-rose-400 text-sm">
          {error || 'Complaint progress unavailable'}
        </div>
        <Button variant="outline" size="sm" onClick={() => router.push('/track')}>
          <ChevronLeft className="w-4 h-4 mr-1" /> Back to Tracker
        </Button>
      </div>
    );
  }

  // Determine current step index
  const statusOrder: Record<string, number> = {
    no_action:             0,
    pending_approval:      1,
    approved:              2,
    assigned:              3,
    in_progress:           4,
    awaiting_verification: 5,
    resolved:              6,
    overdue:               4,
    reopened:              4,
  };
  const activeStepIdx = statusOrder[data.currentStatus] ?? 0;

  return (
    <div className="p-8 max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <Link href="/track">
          <Button variant="ghost" size="sm" className="text-neutral-400 hover:text-white">
            <ChevronLeft className="w-4 h-4 mr-1" />
            Back to Tracker
          </Button>
        </Link>
        <span className="text-xs font-mono text-neutral-500">
          Complaint #{complaintId}
        </span>
      </div>

      <Card className="p-6 bg-surface border-white/5 space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div>
            <h1 className="text-xl font-bold text-white tracking-tight flex items-center gap-2">
              <ShieldCheck className="w-6 h-6 text-indigo-400" />
              Public Grievance Resolution Tracker
            </h1>
            <p className="text-xs text-neutral-400 mt-1">
              Real-time verified status updates from the responsible municipal authorities.
            </p>
          </div>
          <Badge
            variant="outline"
            className={cn(
              'text-xs font-semibold uppercase self-start sm:self-center',
              data.currentStatus === 'resolved'
                ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                : 'bg-indigo-500/10 text-indigo-400 border-indigo-500/20'
            )}
          >
            {data.currentStatus.replace('_', ' ')}
          </Badge>
        </div>

        {data.departmentName && (
          <div className="flex items-center gap-2 text-xs text-neutral-300 pt-1">
            <Building2 className="w-4 h-4 text-neutral-400" />
            Responsible Authority: <strong>{data.departmentName}</strong>
          </div>
        )}

        {data.expectedCompletion && (
          <div className="flex items-center gap-2 text-xs text-neutral-300">
            <Clock className="w-4 h-4 text-neutral-400" />
            Target Resolution Date:{' '}
            <strong>
              {new Date(data.expectedCompletion).toLocaleDateString([], {
                month: 'short',
                day: 'numeric',
                year: 'numeric',
              })}
            </strong>
          </div>
        )}
      </Card>

      {/* Progress Timeline */}
      <Card className="p-6 bg-surface border-white/5 space-y-6">
        <h2 className="text-sm font-semibold text-white">Resolution Milestone Progress</h2>
        <div className="space-y-6 relative before:absolute before:inset-0 before:left-3.5 before:w-0.5 before:bg-white/5">
          {LIFECYCLE_STEPS.map((step, idx) => {
            const isCompleted = idx <= activeStepIdx;
            const isCurrent = idx === activeStepIdx;

            return (
              <div key={step.key} className="flex items-start gap-4 relative">
                <div
                  className={cn(
                    'w-7 h-7 rounded-full flex items-center justify-center shrink-0 border z-10 transition-colors',
                    isCompleted
                      ? 'bg-emerald-500/20 border-emerald-500/40 text-emerald-400'
                      : 'bg-neutral-900 border-white/10 text-neutral-600'
                  )}
                >
                  {isCompleted ? (
                    <CheckCircle2 className="w-4 h-4" />
                  ) : (
                    <span className="text-[10px] font-mono">{idx + 1}</span>
                  )}
                </div>

                <div className="flex-1 min-w-0 pt-0.5">
                  <div className="flex items-center gap-2">
                    <h3
                      className={cn(
                        'text-sm font-medium',
                        isCurrent ? 'text-white font-semibold' : isCompleted ? 'text-neutral-300' : 'text-neutral-500'
                      )}
                    >
                      {step.label}
                    </h3>
                    {isCurrent && (
                      <Badge variant="outline" className="text-[10px] bg-cyan-500/10 text-cyan-400 border-cyan-500/20">
                        Current Stage
                      </Badge>
                    )}
                  </div>
                  <p className="text-xs text-neutral-500 mt-0.5">{step.desc}</p>
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      {/* Verified Status History (Public Safe) */}
      {data.statusHistory.length > 0 && (
        <Card className="p-6 bg-surface border-white/5 space-y-4">
          <h2 className="text-sm font-semibold text-white">Verified Progress Log</h2>
          <div className="space-y-3">
            {data.statusHistory.map((h, i) => (
              <div key={i} className="flex items-start gap-3 text-xs">
                <div className="w-2 h-2 rounded-full bg-indigo-500 mt-1.5 shrink-0" />
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-white uppercase">{h.status.replace('_', ' ')}</span>
                    <span className="text-neutral-500">{new Date(h.changedAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}</span>
                  </div>
                  {h.note && <p className="text-neutral-400 mt-0.5">{h.note}</p>}
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Citizen Reopen Panel */}
      {data.canReopen && (
        <Card className="p-5 bg-surface border-orange-500/20 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div>
            <h3 className="text-sm font-semibold text-white">Issue Not Resolved Satisfactorily?</h3>
            <p className="text-xs text-neutral-400 mt-0.5">
              If the problem persisted or has re-occurred, you can submit a verified reopen request.
            </p>
          </div>
          <Button
            size="sm"
            onClick={() => setShowReopenModal(true)}
            className="bg-orange-600 hover:bg-orange-500 text-xs shrink-0"
          >
            <RotateCcw className="w-3.5 h-3.5 mr-1.5" />
            Request Reopen
          </Button>
        </Card>
      )}

      {/* Reopen Request Modal */}
      {showReopenModal && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <Card className="w-full max-w-md bg-neutral-900 border-white/10 p-6 space-y-4">
            <h2 className="text-lg font-bold text-white">Request Reopening of Action</h2>
            <p className="text-xs text-neutral-400">
              Please describe why this issue is not resolved or how it recurred.
            </p>
            <form onSubmit={handleReopen} className="space-y-3">
              <textarea
                required
                rows={3}
                value={reopenReason}
                onChange={(e) => setReopenReason(e.target.value)}
                placeholder="e.g. Standing water returned after light rain..."
                className="w-full bg-neutral-800 border border-white/10 rounded-md p-2 text-xs text-white"
              />
              <div className="flex justify-end gap-2 pt-2">
                <Button type="button" variant="ghost" size="sm" onClick={() => setShowReopenModal(false)}>
                  Cancel
                </Button>
                <Button type="submit" size="sm" disabled={reopening} className="bg-orange-600 hover:bg-orange-500">
                  {reopening ? 'Submitting...' : 'Submit Reopen Request'}
                </Button>
              </div>
            </form>
          </Card>
        </div>
      )}
    </div>
  );
}
