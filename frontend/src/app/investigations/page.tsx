'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../../context/AuthContext';
import { apiClient } from '../../lib/api';
import {
  FileSearch, CheckCircle2, Clock, XCircle, RefreshCw,
  Play, RotateCw, ExternalLink, ShieldCheck,
  Search, Building2, Check, X
} from 'lucide-react';
import { Card } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Badge } from '../../components/ui/badge';
import { Input } from '../../components/ui/input';
import { Textarea } from '../../components/ui/textarea';
import { cn } from '../../lib/utils';

interface InvestigationItem {
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
}

interface EvidenceRecord {
  id: number;
  evidenceType: string;
  evidenceDescription: string;
  sourceUrl?: string;
  sourceTitle?: string;
  verificationStatus: string;
  retrievedAt?: string;
}

interface RecommendationRecord {
  id: number;
  actionTitle: string;
  description: string;
  departmentId?: string;
  priority: string;
  confidenceScore?: number;
  approvalStatus: string;
}

interface ActivityRecord {
  id: number;
  activityType: string;
  description: string;
  actorName?: string;
  actorRole?: string;
  createdAt: string;
}

interface InvestigationDossier {
  investigation: InvestigationItem;
  evidence: EvidenceRecord[];
  latestReport: {
    reportVersion: number;
    generatedAt: string;
    reviewStatus: string;
    reviewNotes?: string;
    reportJson: {
      findings: {
        investigationSummary: string;
        problemDescription: string;
        geographicImpact: string;
        affectedPopulationEstimate: string;
        potentialCauses: string[];
        missingInformation: string[];
        humanVerificationRequirements: string[];
      };
      departmentMatch: {
        suggestedDepartment: string;
        reasoning: string;
        confidenceScore: number;
        supportingEvidence: string[];
      };
    };
  } | null;
  recommendations: RecommendationRecord[];
  activity: ActivityRecord[];
}

export default function InvestigationsPage() {
  const { userRole } = useAuth();
  const [investigations, setInvestigations] = useState<InvestigationItem[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('all');
  const [priorityFilter, setPriorityFilter] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');

  // Selected investigation dossier
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [dossier, setDossier] = useState<InvestigationDossier | null>(null);
  const [isDossierLoading, setIsDossierLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<'overview' | 'evidence' | 'report' | 'recommendations' | 'activity'>('overview');

  // Review state
  const [reviewNotes, setReviewNotes] = useState('');
  const [isSubmittingReview, setIsSubmittingReview] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const isOfficial = userRole && ['admin', 'govt', 'ngo'].includes(userRole);

  const fetchInvestigations = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await apiClient.getInvestigations({
        status: statusFilter !== 'all' ? statusFilter : undefined,
        priority: priorityFilter !== 'all' ? priorityFilter : undefined,
      });
      setInvestigations(res.data);
      setTotalCount(res.meta.total);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Error fetching investigations';
      console.error('[INVESTIGATIONS_PAGE] Error fetching investigations:', msg);
    } finally {
      setIsLoading(false);
    }
  }, [statusFilter, priorityFilter]);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const res = await apiClient.getInvestigations({
          status: statusFilter !== 'all' ? statusFilter : undefined,
          priority: priorityFilter !== 'all' ? priorityFilter : undefined,
        });
        if (active) {
          setInvestigations(res.data);
          setTotalCount(res.meta.total);
          setIsLoading(false);
        }
      } catch (err: unknown) {
        if (active) {
          const msg = err instanceof Error ? err.message : 'Error fetching investigations';
          console.error('[INVESTIGATIONS_PAGE] Error fetching investigations:', msg);
          setIsLoading(false);
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [statusFilter, priorityFilter]);

  const loadDossier = async (id: number) => {
    setSelectedId(id);
    setIsDossierLoading(true);
    setActionMessage(null);
    setActionError(null);
    try {
      const res = await apiClient.getInvestigation(id);
      setDossier(res.data as InvestigationDossier);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to load investigation dossier.';
      setActionError(msg);
    } finally {
      setIsDossierLoading(false);
    }
  };

  const handleRunInvestigation = async (id: number) => {
    setActionMessage(null);
    setActionError(null);
    try {
      await apiClient.runInvestigation(id);
      setActionMessage(`Investigation #${id} completed analysis.`);
      await loadDossier(id);
      await fetchInvestigations();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Pipeline execution failed.';
      setActionError(msg);
    }
  };

  const handleRetryInvestigation = async (id: number) => {
    setActionMessage(null);
    setActionError(null);
    try {
      await apiClient.retryInvestigation(id);
      setActionMessage(`Investigation #${id} re-run completed.`);
      await loadDossier(id);
      await fetchInvestigations();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Retry failed.';
      setActionError(msg);
    }
  };

  const handleReviewSubmit = async (status: 'approved' | 'rejected' | 'revision_requested') => {
    if (!selectedId) return;
    setIsSubmittingReview(true);
    setActionMessage(null);
    setActionError(null);
    try {
      await apiClient.reviewInvestigation(selectedId, {
        reviewStatus: status,
        reviewNotes: reviewNotes.trim() || undefined,
      });
      setActionMessage(`Investigation #${selectedId} findings updated to "${status}".`);
      setReviewNotes('');
      await loadDossier(selectedId);
      await fetchInvestigations();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Review submission failed.';
      setActionError(msg);
    } finally {
      setIsSubmittingReview(false);
    }
  };

  const handleRecommendationAction = async (recId: number, approve: boolean) => {
    if (!selectedId) return;
    try {
      if (approve) {
        await apiClient.approveRecommendation(selectedId, recId);
      } else {
        await apiClient.rejectRecommendation(selectedId, recId);
      }
      await loadDossier(selectedId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to update recommendation.';
      setActionError(msg);
    }
  };

  // Metrics
  const runningCount = investigations.filter((i) => i.status === 'running').length;
  const reviewPendingCount = investigations.filter((i) => i.status === 'review_pending').length;
  const approvedCount = investigations.filter((i) => i.status === 'approved').length;
  const failedCount = investigations.filter((i) => i.status === 'failed').length;

  const filteredList = investigations.filter((inv) => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    return (
      inv.clusterTitle?.toLowerCase().includes(q) ||
      inv.clusterRegion?.toLowerCase().includes(q) ||
      inv.departmentSuggestion?.toLowerCase().includes(q) ||
      inv.clusterCategory?.toLowerCase().includes(q) ||
      String(inv.id).includes(q)
    );
  });

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400">
              <FileSearch className="w-4 h-4" />
            </div>
            <h1 className="text-xl sm:text-2xl font-bold text-white tracking-tight">
              Autonomous Civic Investigations
            </h1>
          </div>
          <p className="text-sm text-neutral-400 mt-1">
            AI-driven evidence synthesis, municipal policy research, and official response planning.
          </p>
        </div>

        <Button variant="outline" size="sm" onClick={fetchInvestigations} disabled={isLoading}>
          <RefreshCw className={cn('w-4 h-4', isLoading && 'animate-spin')} />
          Refresh
        </Button>
      </div>

      {/* Metrics Row */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        <Card className="p-4 bg-white/[0.02]">
          <span className="text-xs text-neutral-500 block">Total</span>
          <span className="text-2xl font-bold text-white">{totalCount}</span>
        </Card>
        <Card className="p-4 bg-indigo-500/5 border-indigo-500/20">
          <span className="text-xs text-indigo-400 block">Running</span>
          <span className="text-2xl font-bold text-indigo-300">{runningCount}</span>
        </Card>
        <Card className="p-4 bg-amber-500/5 border-amber-500/20">
          <span className="text-xs text-amber-400 block">Awaiting Review</span>
          <span className="text-2xl font-bold text-amber-300">{reviewPendingCount}</span>
        </Card>
        <Card className="p-4 bg-emerald-500/5 border-emerald-500/20">
          <span className="text-xs text-emerald-400 block">Approved</span>
          <span className="text-2xl font-bold text-emerald-300">{approvedCount}</span>
        </Card>
        <Card className="p-4 bg-red-500/5 border-red-500/20">
          <span className="text-xs text-red-400 block">Failed</span>
          <span className="text-2xl font-bold text-red-300">{failedCount}</span>
        </Card>
      </div>

      {/* Main Grid: List + Detail Dossier */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left column: Investigation list (5 cols) */}
        <div className="lg:col-span-5 space-y-4">
          <Card className="p-4 space-y-3">
            <div className="relative">
              <Search className="w-4 h-4 absolute left-3 top-2.5 text-neutral-500" />
              <Input
                placeholder="Search by title, department, region..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9 text-xs"
              />
            </div>

            <div className="flex gap-2">
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="flex-1 bg-neutral-900 border border-white/10 rounded-md px-2.5 py-1.5 text-xs text-neutral-300 focus:outline-none"
              >
                <option value="all">All Statuses</option>
                <option value="pending">Pending</option>
                <option value="running">Running</option>
                <option value="review_pending">Review Pending</option>
                <option value="approved">Approved</option>
                <option value="rejected">Rejected</option>
                <option value="failed">Failed</option>
              </select>

              <select
                value={priorityFilter}
                onChange={(e) => setPriorityFilter(e.target.value)}
                className="flex-1 bg-neutral-900 border border-white/10 rounded-md px-2.5 py-1.5 text-xs text-neutral-300 focus:outline-none"
              >
                <option value="all">All Priorities</option>
                <option value="critical">Critical</option>
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </select>
            </div>
          </Card>

          {/* List items */}
          <div className="space-y-2.5 max-h-[700px] overflow-y-auto pr-1">
            {isLoading && (
              <div className="p-8 text-center text-xs text-neutral-500">
                <RefreshCw className="w-5 h-5 animate-spin mx-auto mb-2 text-indigo-400" />
                Loading investigations...
              </div>
            )}

            {!isLoading && filteredList.length === 0 && (
              <Card className="p-8 text-center text-xs text-neutral-500">
                No investigations found matching criteria.
              </Card>
            )}

            {!isLoading &&
              filteredList.map((inv) => {
                const isSelected = selectedId === inv.id;
                return (
                  <button
                    key={inv.id}
                    onClick={() => loadDossier(inv.id)}
                    className={cn(
                      'w-full text-left p-3.5 rounded-lg border transition-all cursor-pointer block',
                      isSelected
                        ? 'bg-indigo-600/10 border-indigo-500/40'
                        : 'bg-white/[0.02] border-white/[0.06] hover:bg-white/[0.04]'
                    )}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="space-y-1">
                        <div className="flex items-center gap-1.5">
                          <span className="font-mono text-xs text-indigo-400 font-bold">INV-{inv.id}</span>
                          <span className="text-[10px] text-neutral-500">&bull; CL-{inv.clusterId}</span>
                        </div>
                        <h4 className="text-xs font-semibold text-neutral-200 line-clamp-1">
                          {inv.clusterTitle || `Cluster #${inv.clusterId}`}
                        </h4>
                      </div>

                      <Badge
                        variant={
                          inv.priority === 'critical'
                            ? 'destructive'
                            : inv.priority === 'high'
                            ? 'default'
                            : 'secondary'
                        }
                        className="text-[10px] uppercase font-mono shrink-0"
                      >
                        {inv.priority}
                      </Badge>
                    </div>

                    <div className="mt-2 flex items-center justify-between text-[11px] text-neutral-400">
                      <div className="flex items-center gap-1 truncate max-w-[200px]">
                        <Building2 className="w-3 h-3 text-neutral-500 shrink-0" />
                        <span className="truncate">{inv.departmentSuggestion || 'Unassigned'}</span>
                      </div>

                      <span
                        className={cn(
                          'text-[10px] font-medium uppercase px-2 py-0.5 rounded-full',
                          inv.status === 'review_pending' && 'bg-amber-500/10 text-amber-400 border border-amber-500/20',
                          inv.status === 'approved' && 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20',
                          inv.status === 'running' && 'bg-indigo-500/10 text-indigo-400 animate-pulse',
                          inv.status === 'failed' && 'bg-red-500/10 text-red-400 border border-red-500/20',
                          inv.status === 'pending' && 'bg-neutral-800 text-neutral-400'
                        )}
                      >
                        {inv.status.replace('_', ' ')}
                      </span>
                    </div>
                  </button>
                );
              })}
          </div>
        </div>

        {/* Right column: Dossier View (7 cols) */}
        <div className="lg:col-span-7">
          {!selectedId && (
            <Card className="p-12 text-center text-neutral-500 flex flex-col items-center justify-center min-h-[500px]">
              <FileSearch className="w-12 h-12 text-neutral-600 mb-3" />
              <h3 className="text-sm font-semibold text-neutral-300">Select an Investigation</h3>
              <p className="text-xs text-neutral-500 mt-1 max-w-sm">
                Choose an item on the left to examine collected evidence, review AI findings, and approve recommendations.
              </p>
            </Card>
          )}

          {selectedId && isDossierLoading && (
            <Card className="p-12 text-center text-xs text-neutral-500 min-h-[500px] flex items-center justify-center">
              <RefreshCw className="w-6 h-6 animate-spin text-indigo-400 mr-2" />
              Loading investigation dossier...
            </Card>
          )}

          {selectedId && !isDossierLoading && dossier && (
            <div className="space-y-4">
              {/* Alert Feedback Messages */}
              {actionMessage && (
                <div className="p-3 bg-emerald-500/10 border border-emerald-500/20 rounded-lg text-xs text-emerald-400 flex items-center justify-between">
                  <span>{actionMessage}</span>
                  <X className="w-3.5 h-3.5 cursor-pointer" onClick={() => setActionMessage(null)} />
                </div>
              )}

              {actionError && (
                <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-xs text-red-400 flex items-center justify-between">
                  <span>{actionError}</span>
                  <X className="w-3.5 h-3.5 cursor-pointer" onClick={() => setActionError(null)} />
                </div>
              )}

              {/* Dossier Header Card */}
              <Card className="p-5 space-y-4">
                <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-sm font-bold text-indigo-400">
                        INV-{dossier.investigation.id}
                      </span>
                      <Badge variant="default" className="text-[10px] uppercase font-mono">
                        {dossier.investigation.priority}
                      </Badge>
                      <span className="text-xs text-neutral-400 capitalize">
                        &bull; {dossier.investigation.clusterCategory}
                      </span>
                    </div>
                    <h2 className="text-base font-bold text-white mt-1">
                      {dossier.investigation.clusterTitle}
                    </h2>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-2">
                    {dossier.investigation.status === 'pending' && (
                      <Button
                        size="sm"
                        onClick={() => handleRunInvestigation(dossier.investigation.id)}
                        className="text-xs"
                      >
                        <Play className="w-3.5 h-3.5" />
                        Run Agent
                      </Button>
                    )}

                    {['failed', 'review_pending'].includes(dossier.investigation.status) && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleRetryInvestigation(dossier.investigation.id)}
                        className="text-xs"
                      >
                        <RotateCw className="w-3.5 h-3.5" />
                        Re-run
                      </Button>
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs pt-1">
                  <div className="p-2.5 bg-neutral-900/60 rounded-md border border-white/5">
                    <span className="text-[10px] text-neutral-500 block">Department</span>
                    <span className="font-semibold text-neutral-200 truncate block">
                      {dossier.investigation.departmentSuggestion || 'Pending analysis'}
                    </span>
                  </div>

                  <div className="p-2.5 bg-neutral-900/60 rounded-md border border-white/5">
                    <span className="text-[10px] text-neutral-500 block">AI Confidence</span>
                    <span className="font-semibold text-indigo-300">
                      {dossier.investigation.confidenceScore
                        ? `${(dossier.investigation.confidenceScore * 100).toFixed(0)}%`
                        : 'N/A'}
                    </span>
                  </div>

                  <div className="p-2.5 bg-neutral-900/60 rounded-md border border-white/5">
                    <span className="text-[10px] text-neutral-500 block">Region</span>
                    <span className="font-semibold text-neutral-200">
                      {dossier.investigation.clusterRegion || 'General'}
                    </span>
                  </div>

                  <div className="p-2.5 bg-neutral-900/60 rounded-md border border-white/5">
                    <span className="text-[10px] text-neutral-500 block">Review Status</span>
                    <span className="font-semibold text-amber-300 uppercase text-[11px]">
                      {dossier.investigation.status.replace('_', ' ')}
                    </span>
                  </div>
                </div>

                {/* Tabs Header */}
                <div className="flex border-b border-white/10 gap-4 text-xs font-medium pt-2">
                  {[
                    { id: 'overview' as const, label: 'Overview' },
                    { id: 'evidence' as const, label: `Evidence (${dossier.evidence.length})` },
                    { id: 'report' as const, label: 'AI Report' },
                    { id: 'recommendations' as const, label: `Actions (${dossier.recommendations.length})` },
                    { id: 'activity' as const, label: 'Timeline' },
                  ].map((tab) => (
                    <button
                      key={tab.id}
                      onClick={() => setActiveTab(tab.id)}
                      className={cn(
                        'pb-2 transition-colors cursor-pointer border-b-2',
                        activeTab === tab.id
                          ? 'border-indigo-500 text-indigo-400 font-semibold'
                          : 'border-transparent text-neutral-400 hover:text-neutral-200'
                      )}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>

                {/* TAB 1: OVERVIEW */}
                {activeTab === 'overview' && (
                  <div className="space-y-4 pt-2 text-xs">
                    <div>
                      <h4 className="font-semibold text-neutral-300 mb-1">Executive Summary</h4>
                      <p className="text-neutral-400 leading-relaxed">
                        {dossier.investigation.investigationSummary ||
                          'Investigation pipeline has not yet generated an executive summary.'}
                      </p>
                    </div>

                    {dossier.latestReport?.reportJson?.findings && (
                      <div className="space-y-3 pt-2">
                        <div className="p-3 bg-neutral-900/60 rounded-md border border-white/5 space-y-1.5">
                          <span className="text-[11px] font-semibold text-neutral-300 block">
                            Geographic Impact & Population
                          </span>
                          <p className="text-neutral-400">
                            {dossier.latestReport.reportJson.findings.geographicImpact}
                          </p>
                          <p className="text-indigo-300 text-[11px]">
                            {dossier.latestReport.reportJson.findings.affectedPopulationEstimate}
                          </p>
                        </div>

                        <div className="p-3 bg-neutral-900/60 rounded-md border border-white/5 space-y-1.5">
                          <span className="text-[11px] font-semibold text-neutral-300 block">
                            Potential Causes Identified
                          </span>
                          <ul className="list-disc list-inside text-neutral-400 space-y-1">
                            {dossier.latestReport.reportJson.findings.potentialCauses.map(
                              (cause: string, i: number) => (
                                <li key={i}>{cause}</li>
                              )
                            )}
                          </ul>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* TAB 2: EVIDENCE TIMELINE */}
                {activeTab === 'evidence' && (
                  <div className="space-y-3 pt-2 text-xs">
                    {dossier.evidence.length === 0 && (
                      <p className="text-neutral-500 text-center py-6">No evidence items collected yet.</p>
                    )}

                    {dossier.evidence.map((ev: EvidenceRecord) => (
                      <div
                        key={ev.id}
                        className="p-3 rounded-lg bg-neutral-900/60 border border-white/5 space-y-1.5"
                      >
                        <div className="flex items-center justify-between">
                          <Badge variant="secondary" className="text-[10px] uppercase font-mono">
                            {ev.evidenceType.replace('_', ' ')}
                          </Badge>
                          <span className="text-[10px] text-neutral-500 font-mono">
                            {ev.retrievedAt ? new Date(ev.retrievedAt).toLocaleDateString() : ''}
                          </span>
                        </div>
                        <p className="text-neutral-300 leading-relaxed">{ev.evidenceDescription}</p>
                        {ev.sourceUrl && (
                          <a
                            href={ev.sourceUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-[11px] text-indigo-400 hover:underline pt-1"
                          >
                            <ExternalLink className="w-3 h-3" />
                            {ev.sourceTitle || ev.sourceUrl}
                          </a>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {/* TAB 3: REPORT DETAILS */}
                {activeTab === 'report' && (
                  <div className="space-y-4 pt-2 text-xs">
                    {!dossier.latestReport && (
                      <p className="text-neutral-500 text-center py-6">No report generated yet.</p>
                    )}

                    {dossier.latestReport && (
                      <div className="space-y-4">
                        <div className="p-3.5 bg-indigo-500/5 border border-indigo-500/20 rounded-lg space-y-2">
                          <div className="flex items-center justify-between">
                            <span className="font-semibold text-indigo-300">
                              Report Version {dossier.latestReport.reportVersion}
                            </span>
                            <span className="text-[10px] text-neutral-500">
                              Generated {new Date(dossier.latestReport.generatedAt).toLocaleString()}
                            </span>
                          </div>
                          <p className="text-neutral-300">
                            {dossier.latestReport.reportJson.findings.problemDescription}
                          </p>
                        </div>

                        {/* Verification & Missing info */}
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          <div className="p-3 bg-neutral-900/60 rounded-md border border-white/5 space-y-1.5">
                            <span className="text-[11px] font-semibold text-amber-400 block">
                              Human Verification Needed
                            </span>
                            <ul className="list-disc list-inside text-neutral-400 space-y-1 text-[11px]">
                              {dossier.latestReport.reportJson.findings.humanVerificationRequirements.map(
                                (req: string, idx: number) => (
                                  <li key={idx}>{req}</li>
                                )
                              )}
                            </ul>
                          </div>

                          <div className="p-3 bg-neutral-900/60 rounded-md border border-white/5 space-y-1.5">
                            <span className="text-[11px] font-semibold text-neutral-400 block">
                              Missing / Unconfirmed Info
                            </span>
                            <ul className="list-disc list-inside text-neutral-400 space-y-1 text-[11px]">
                              {dossier.latestReport.reportJson.findings.missingInformation.map(
                                (info: string, idx: number) => (
                                  <li key={idx}>{info}</li>
                                )
                              )}
                            </ul>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* TAB 4: RECOMMENDATIONS */}
                {activeTab === 'recommendations' && (
                  <div className="space-y-3 pt-2 text-xs">
                    {dossier.recommendations.length === 0 && (
                      <p className="text-neutral-500 text-center py-6">No recommendations stored yet.</p>
                    )}

                    {dossier.recommendations.map((rec: RecommendationRecord) => (
                      <div
                        key={rec.id}
                        className="p-3.5 rounded-lg bg-neutral-900/60 border border-white/5 space-y-2"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <h4 className="font-semibold text-neutral-200">{rec.actionTitle}</h4>
                            <span className="text-[11px] text-indigo-400 block mt-0.5">
                              Target Dept: {rec.departmentId || 'Unassigned'}
                            </span>
                          </div>

                          <Badge
                            variant={rec.approvalStatus === 'approved' ? 'default' : 'secondary'}
                            className="text-[10px] uppercase font-mono"
                          >
                            {rec.approvalStatus}
                          </Badge>
                        </div>

                        <p className="text-neutral-400 leading-relaxed">{rec.description}</p>

                        {/* Official approval toggle buttons */}
                        {isOfficial && (
                          <div className="flex items-center gap-2 pt-1">
                            <Button
                              size="sm"
                              variant={rec.approvalStatus === 'approved' ? 'default' : 'outline'}
                              onClick={() => handleRecommendationAction(rec.id, true)}
                              className="h-7 text-[11px]"
                            >
                              <Check className="w-3 h-3 mr-1" />
                              Approve Action
                            </Button>

                            <Button
                              size="sm"
                              variant={rec.approvalStatus === 'rejected' ? 'destructive' : 'ghost'}
                              onClick={() => handleRecommendationAction(rec.id, false)}
                              className="h-7 text-[11px] text-neutral-400 hover:text-red-400"
                            >
                              <X className="w-3 h-3 mr-1" />
                              Reject
                            </Button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {/* TAB 5: TIMELINE ACTIVITY */}
                {activeTab === 'activity' && (
                  <div className="space-y-3 pt-2 text-xs">
                    {dossier.activity.map((act: ActivityRecord) => (
                      <div
                        key={act.id}
                        className="flex items-start gap-3 p-2.5 rounded-md bg-neutral-900/40 border border-white/5"
                      >
                        <Clock className="w-3.5 h-3.5 text-neutral-500 mt-0.5 shrink-0" />
                        <div>
                          <p className="text-neutral-300">{act.description}</p>
                          <span className="text-[10px] text-neutral-500">
                            {new Date(act.createdAt).toLocaleString()} &bull;{' '}
                            {act.actorName ? `${act.actorName} (${act.actorRole})` : 'System Agent'}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Official Review Action Panel */}
                {isOfficial && (
                  <div className="mt-6 p-4 rounded-lg bg-neutral-900/80 border border-indigo-500/20 space-y-3">
                    <div className="flex items-center gap-2">
                      <ShieldCheck className="w-4 h-4 text-indigo-400" />
                      <h4 className="text-xs font-semibold text-white">Official Investigation Review</h4>
                    </div>

                    <Textarea
                      placeholder="Add review feedback, instructions for field engineers, or reasons for decision..."
                      value={reviewNotes}
                      onChange={(e) => setReviewNotes(e.target.value)}
                      rows={2}
                      className="text-xs"
                    />

                    <div className="flex flex-wrap gap-2 pt-1">
                      <Button
                        size="sm"
                        disabled={isSubmittingReview}
                        onClick={() => handleReviewSubmit('approved')}
                        className="bg-emerald-600 hover:bg-emerald-700 text-white text-xs h-8"
                      >
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        Approve Findings
                      </Button>

                      <Button
                        size="sm"
                        variant="outline"
                        disabled={isSubmittingReview}
                        onClick={() => handleReviewSubmit('revision_requested')}
                        className="text-amber-400 border-amber-500/30 hover:bg-amber-500/10 text-xs h-8"
                      >
                        <RotateCw className="w-3.5 h-3.5" />
                        Request Re-investigation
                      </Button>

                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={isSubmittingReview}
                        onClick={() => handleReviewSubmit('rejected')}
                        className="text-xs h-8"
                      >
                        <XCircle className="w-3.5 h-3.5" />
                        Reject Report
                      </Button>
                    </div>
                  </div>
                )}
              </Card>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
