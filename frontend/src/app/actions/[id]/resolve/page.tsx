'use client';

import React, { useState, useEffect, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAuth } from '../../../../context/AuthContext';
import { apiClient } from '../../../../lib/api';
import {
  ShieldCheck, UploadCloud, ChevronLeft,
  CheckCircle2, XCircle, Sparkles, RefreshCw
} from 'lucide-react';
import { Card } from '../../../../components/ui/card';
import { Button } from '../../../../components/ui/button';
import { Badge } from '../../../../components/ui/badge';

interface ResolutionDossier {
  action: {
    id: number;
    action_title: string;
    description: string;
    status: string;
    department_name: string | null;
  };
  evidence: Array<{
    id: number;
    evidence_type: 'before' | 'after' | 'progress' | 'completion_report';
    storage_key: string;
    original_filename: string | null;
    mime_type: string | null;
    file_size: number | null;
    description: string | null;
    ai_analysis: {
      observedChanges?: string[];
      unresolvedIssues?: string[];
      confidenceScore?: number;
      limitations?: string[];
      requiresHumanVerification?: boolean;
      analysisText?: string;
    } | null;
    ai_confidence_score: number | null;
    needs_human_review: boolean;
    verification_status: string;
    created_at: string;
  }>;
}

export default function ResolutionVerificationPage() {
  const params = useParams();
  const router = useRouter();
  const { userRole } = useAuth();
  const actionId = params?.id as string;

  const [dossier, setDossier] = useState<ResolutionDossier | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);
  const [reviewNotes, setReviewNotes] = useState('');

  // Upload state
  const [uploadType, setUploadType] = useState<'before' | 'after'>('after');
  const [uploadDesc, setUploadDesc] = useState('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const refetch = async () => {
    if (!actionId) return;
    try {
      setLoading(true);
      setError(null);
      const res = await apiClient.getAction(actionId);
      setDossier(res.data);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to load action evidence';
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
          setLoading(false);
        }
      } catch (err: unknown) {
        if (active) {
          const message = err instanceof Error ? err.message : 'Failed to load action evidence';
          setError(message);
          setLoading(false);
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [actionId]);

  const handleUpload = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedFile) return;

    try {
      setUploading(true);
      const formData = new FormData();
      formData.append('file', selectedFile);
      formData.append('evidenceType', uploadType);
      if (uploadDesc.trim()) formData.append('description', uploadDesc.trim());

      await apiClient.uploadActionEvidence(actionId, formData);
      setSelectedFile(null);
      setUploadDesc('');
      if (fileInputRef.current) fileInputRef.current.value = '';
      await refetch();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  const handleVerify = async (approved: boolean) => {
    try {
      setProcessing(true);
      await apiClient.verifyActionResolution(actionId, {
        approved,
        notes: reviewNotes.trim() || undefined,
      });
      router.push(`/actions/${actionId}`);
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Verification failed');
      setProcessing(false);
    }
  };

  const isOfficial = userRole && ['govt', 'admin'].includes(userRole);

  if (loading) {
    return (
      <div className="p-8 text-center text-neutral-400 text-sm">
        <RefreshCw className="w-6 h-6 animate-spin mx-auto mb-2 text-indigo-400" />
        Loading verification workspace...
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
          <ChevronLeft className="w-4 h-4 mr-1" /> Back
        </Button>
      </div>
    );
  }

  const { action, evidence } = dossier;
  const beforeEvidence = evidence.filter((e) => e.evidence_type === 'before');
  const afterEvidence = evidence.filter((e) => e.evidence_type === 'after');
  const latestAiAnalysis = evidence.find((e) => e.ai_analysis)?.ai_analysis;

  return (
    <div className="p-8 max-w-6xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <Link href={`/actions/${action.id}`}>
          <Button variant="ghost" size="sm" className="text-neutral-400 hover:text-white">
            <ChevronLeft className="w-4 h-4 mr-1" />
            Back to Action #{action.id}
          </Button>
        </Link>
        <Badge variant="outline" className="text-xs bg-purple-500/10 text-purple-400 border-purple-500/20">
          Resolution Verification Workspace
        </Badge>
      </div>

      <Card className="p-6 bg-surface border-white/5 space-y-2">
        <h1 className="text-xl font-bold text-white tracking-tight flex items-center gap-2">
          <ShieldCheck className="w-6 h-6 text-purple-400" />
          Verify Civic Resolution: {action.action_title}
        </h1>
        <p className="text-xs text-neutral-400">
          Compare pre-work (before) and post-work (after) photographic evidence. AI provides multimodal observations; human official retains final authority.
        </p>
      </Card>

      {/* Side-by-side Visual Comparison */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* BEFORE PANEL */}
        <Card className="p-5 bg-surface border-white/5 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-white flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full bg-amber-400" />
              Before Resolution Evidence
            </h3>
            <span className="text-xs text-neutral-500 font-mono">
              {beforeEvidence.length} image(s)
            </span>
          </div>

          {beforeEvidence.length === 0 ? (
            <div className="p-8 text-center border border-dashed border-white/10 rounded-lg text-xs text-neutral-500">
              No &ldquo;before&rdquo; image uploaded. Use the upload panel below.
            </div>
          ) : (
            <div className="space-y-3">
              {beforeEvidence.map((ev) => (
                <div key={ev.id} className="rounded-lg bg-neutral-900 border border-white/5 p-3 space-y-2">
                  <div className="aspect-video bg-neutral-950 rounded flex items-center justify-center text-neutral-500 font-mono text-xs overflow-hidden">
                    <span>{ev.original_filename || ev.storage_key}</span>
                  </div>
                  {ev.description && <p className="text-xs text-neutral-400">{ev.description}</p>}
                </div>
              ))}
            </div>
          )}
        </Card>

        {/* AFTER PANEL */}
        <Card className="p-5 bg-surface border-white/5 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-white flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full bg-emerald-400" />
              After Resolution Evidence
            </h3>
            <span className="text-xs text-neutral-500 font-mono">
              {afterEvidence.length} image(s)
            </span>
          </div>

          {afterEvidence.length === 0 ? (
            <div className="p-8 text-center border border-dashed border-white/10 rounded-lg text-xs text-neutral-500">
              No &ldquo;after&rdquo; image uploaded. Department must upload completion evidence.
            </div>
          ) : (
            <div className="space-y-3">
              {afterEvidence.map((ev) => (
                <div key={ev.id} className="rounded-lg bg-neutral-900 border border-white/5 p-3 space-y-2">
                  <div className="aspect-video bg-neutral-950 rounded flex items-center justify-center text-neutral-500 font-mono text-xs overflow-hidden">
                    <span>{ev.original_filename || ev.storage_key}</span>
                  </div>
                  {ev.description && <p className="text-xs text-neutral-400">{ev.description}</p>}
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {/* AI Comparison Analysis Panel */}
      {latestAiAnalysis && (
        <Card className="p-6 bg-surface border-indigo-500/20 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-white flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-indigo-400" />
              AI Multimodal Verification Analysis
            </h3>
            <Badge variant="outline" className="text-xs bg-indigo-500/10 text-indigo-300">
              Confidence: {((latestAiAnalysis.confidenceScore || 0) * 100).toFixed(0)}%
            </Badge>
          </div>

          {latestAiAnalysis.analysisText && (
            <p className="text-xs text-neutral-300 leading-relaxed">
              {latestAiAnalysis.analysisText}
            </p>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
            {latestAiAnalysis.observedChanges && latestAiAnalysis.observedChanges.length > 0 && (
              <div className="p-3 rounded bg-emerald-500/5 border border-emerald-500/10 space-y-1">
                <span className="font-semibold text-emerald-400">Observed Physical Changes:</span>
                <ul className="list-disc list-inside space-y-0.5 text-neutral-300">
                  {latestAiAnalysis.observedChanges.map((change, i) => (
                    <li key={i}>{change}</li>
                  ))}
                </ul>
              </div>
            )}

            {latestAiAnalysis.unresolvedIssues && latestAiAnalysis.unresolvedIssues.length > 0 && (
              <div className="p-3 rounded bg-amber-500/5 border border-amber-500/10 space-y-1">
                <span className="font-semibold text-amber-400">Remaining / Unresolved Items:</span>
                <ul className="list-disc list-inside space-y-0.5 text-neutral-300">
                  {latestAiAnalysis.unresolvedIssues.map((issue, i) => (
                    <li key={i}>{issue}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </Card>
      )}

      {/* Upload Evidence Section */}
      <Card className="p-6 bg-surface border-white/5 space-y-4">
        <h3 className="text-sm font-semibold text-white flex items-center gap-2">
          <UploadCloud className="w-4 h-4 text-indigo-400" />
          Upload Evidence Photograph
        </h3>
        <form onSubmit={handleUpload} className="grid grid-cols-1 sm:grid-cols-4 gap-3 items-end">
          <div>
            <label className="text-xs font-medium text-neutral-400 block mb-1">
              Evidence Stage
            </label>
            <select
              value={uploadType}
              onChange={(e) => setUploadType(e.target.value as 'before' | 'after')}
              className="w-full bg-neutral-900 border border-white/10 rounded-md px-3 py-2 text-xs text-white"
            >
              <option value="after">After (Post-Work)</option>
              <option value="before">Before (Pre-Work)</option>
            </select>
          </div>
          <div>
            <label className="text-xs font-medium text-neutral-400 block mb-1">
              Image File (JPEG, PNG, WebP)
            </label>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              required
              onChange={(e) => setSelectedFile(e.target.files?.[0] || null)}
              className="w-full text-xs text-neutral-400 file:mr-2 file:py-1 file:px-2 file:rounded file:border-0 file:text-xs file:bg-neutral-800 file:text-neutral-200"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-neutral-400 block mb-1">
              Description
            </label>
            <input
              type="text"
              placeholder="e.g. Asphalting completed"
              value={uploadDesc}
              onChange={(e) => setUploadDesc(e.target.value)}
              className="w-full bg-neutral-900 border border-white/10 rounded-md px-3 py-1.5 text-xs text-white"
            />
          </div>
          <Button
            type="submit"
            size="sm"
            disabled={uploading || !selectedFile}
            className="bg-indigo-600 hover:bg-indigo-500 text-xs"
          >
            {uploading ? 'Uploading...' : 'Upload File'}
          </Button>
        </form>
      </Card>

      {/* Human Official Determination Panel */}
      {isOfficial && (
        <Card className="p-6 bg-surface border-white/10 space-y-4">
          <h3 className="text-base font-semibold text-white flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-emerald-400" />
            Official Determination & Verification
          </h3>
          <p className="text-xs text-neutral-400">
            Per system policy, AI analysis is non-binding guidance. An authorized official must confirm whether the work meets resolution standards.
          </p>

          <textarea
            rows={2}
            value={reviewNotes}
            onChange={(e) => setReviewNotes(e.target.value)}
            placeholder="Official review notes (e.g. Site visited; pothole filled to specification)..."
            className="w-full bg-neutral-900 border border-white/10 rounded-md p-2.5 text-xs text-white"
          />

          <div className="flex items-center gap-3 pt-2">
            <Button
              size="sm"
              disabled={processing}
              onClick={() => handleVerify(true)}
              className="bg-emerald-600 hover:bg-emerald-500"
            >
              <CheckCircle2 className="w-4 h-4 mr-1.5" />
              Approve & Resolve Action
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={processing}
              onClick={() => handleVerify(false)}
              className="text-amber-400 border-amber-500/20 hover:bg-amber-500/10"
            >
              <XCircle className="w-4 h-4 mr-1.5" />
              Reject / Return to In Progress
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}
