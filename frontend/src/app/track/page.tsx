'use client';

import React, { useState, useEffect, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { apiClient, ApiError } from '../../lib/api';
import { Search, MapPin, Calendar, AlertTriangle, FileText, CheckCircle2, Clock, RefreshCw, HelpCircle, ChevronDown } from 'lucide-react';

interface ComplaintDetail {
  id: string | number;
  clusterId?: string | number | null;
  status: string;
  text: string;
  category: string;
  created_at: string;
  latitude?: string | number | null;
  longitude?: string | number | null;
  [key: string]: unknown;
}

interface ClusterDetail {
  id: string | number;
  title: string;
  complaintCount: number;
  region: string;
  severity: number;
  recommendedAction?: string;
  complaints?: Array<{ id: string | number }>;
  [key: string]: unknown;
}

function TrackContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [searchId, setSearchId] = useState('');
  const [selectedComplaint, setSelectedComplaint] = useState<ComplaintDetail | null>(null);
  const [linkedCluster, setLinkedCluster] = useState<ClusterDetail | null>(null);
  const [recentIds, setRecentIds] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    const fetchRecentIds = async () => {
      try {
        const res = await apiClient.getClusters();
        const ids: string[] = [];
        (res.data as ClusterDetail[]).forEach((cluster) => {
          (cluster.complaints || []).forEach((comp) => {
            if (!ids.includes(String(comp.id))) ids.push(String(comp.id));
          });
        });
        setRecentIds(ids.sort());
      } catch (err) { console.error('Failed to load complaint IDs:', err); }
    };
    fetchRecentIds();
  }, []);

  const fetchComplaintDetails = async (id: string) => {
    setIsLoading(true);
    setErrorMsg('');
    try {
      const compRes = await apiClient.getComplaint(id);
      const compData = compRes.data as ComplaintDetail;
      setSelectedComplaint(compData);
      if (compData.clusterId) {
        try {
          const clustersRes = await apiClient.getClusters();
          const match = (clustersRes.data as ClusterDetail[]).find((c) => String(c.id) === String(compData.clusterId));
          setLinkedCluster(match || null);
        } catch { setLinkedCluster(null); }
      } else { setLinkedCluster(null); }
    } catch (err) {
      setSelectedComplaint(null);
      setLinkedCluster(null);
      if (err instanceof ApiError) setErrorMsg(err.status === 404 ? err.message : `Error: ${err.message}`);
      else setErrorMsg('Unable to connect to backend.');
    } finally { setIsLoading(false); }
  };

  useEffect(() => {
    const idParam = searchParams.get('id');
    if (idParam) {
      queueMicrotask(() => {
        setSearchId(idParam);
        fetchComplaintDetails(idParam);
      });
    }
  }, [searchParams]);

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchId.trim()) return;
    router.replace(`/track?id=${searchId.trim().toUpperCase()}`);
  };

  const steps = (() => {
    if (!selectedComplaint) return [];
    const isSubmitted = true;
    const isClustered = !!selectedComplaint.clusterId;
    const isInReview = selectedComplaint.status === 'in_progress' || selectedComplaint.status === 'resolved';
    const isResolved = selectedComplaint.status === 'resolved';
    return [
      { name: 'Submitted', desc: 'Complaint registered', completed: isSubmitted },
      { name: 'Clustered', desc: 'Grouped with similar issues', completed: isClustered },
      { name: 'In Review', desc: 'Assigned to officials', completed: isInReview },
      { name: 'Resolved', desc: 'Action complete', completed: isResolved },
    ];
  })();

  return (
    <div className="p-6 lg:p-8 max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-xl font-bold text-white flex items-center gap-2">
          <Search className="w-5 h-5 text-indigo-400" />
          Track Your Complaint
        </h1>
        <p className="text-sm text-neutral-500 mt-1">
          Enter your reference ID to view real-time processing status and cluster linkage.
        </p>
      </div>

      {/* Search inputs */}
      <div className="cm-card p-5">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label className="block text-[10px] font-bold uppercase text-neutral-500 mb-1.5 tracking-wider">Select Report</label>
            <div className="relative">
              <select
                value={selectedComplaint?.id ? `CM-${selectedComplaint.id}` : ''}
                onChange={(e) => { if (e.target.value) router.replace(`/track?id=${e.target.value}`); }}
                className="w-full px-4 py-2.5 bg-white/[0.03] border border-white/[0.06] rounded-xl text-xs text-neutral-300 focus:outline-none focus:border-indigo-500/30 appearance-none"
              >
                <option value="">-- Choose --</option>
                {recentIds.map(cId => <option key={cId} value={cId}>{cId}</option>)}
              </select>
              <ChevronDown className="absolute right-3 top-2.5 w-3.5 h-3.5 text-neutral-500 pointer-events-none" />
            </div>
          </div>
          <div className="md:col-span-2">
            <label className="block text-[10px] font-bold uppercase text-neutral-500 mb-1.5 tracking-wider">Search by ID</label>
            <form onSubmit={handleSearchSubmit} className="flex gap-2">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-2.5 w-4 h-4 text-neutral-500" />
                <input type="text" placeholder="e.g. CM-1 or 1" value={searchId} onChange={(e) => setSearchId(e.target.value)} className="w-full pl-9 pr-3 py-2.5 bg-white/[0.03] border border-white/[0.06] rounded-xl text-xs text-white placeholder-neutral-500 focus:outline-none focus:border-indigo-500/30" />
              </div>
              <button type="submit" className="px-5 py-2.5 bg-white/5 hover:bg-white/10 text-white text-xs font-semibold rounded-xl border border-white/5 transition-all cursor-pointer">Search</button>
            </form>
          </div>
        </div>
      </div>

      {errorMsg && (
        <div className="p-3 bg-rose-500/10 border border-rose-500/20 rounded-xl text-xs text-rose-400 flex gap-2 items-center">
          <AlertTriangle className="w-4 h-4 shrink-0" /> <span>{errorMsg}</span>
        </div>
      )}

      {isLoading ? (
        <div className="cm-card p-12 text-center">
          <RefreshCw className="w-6 h-6 text-indigo-400 animate-spin mx-auto mb-3" />
          <p className="text-xs text-neutral-500">Querying database...</p>
        </div>
      ) : selectedComplaint ? (
        <div className="space-y-5 fade-in">
          {/* Stepper */}
          <div className="cm-card p-6">
            <div className="flex justify-between items-center mb-6">
              <div>
                <span className="text-[10px] uppercase font-bold text-neutral-500 tracking-wider">Reference</span>
                <h2 className="text-lg font-bold font-mono text-indigo-400">CM-{selectedComplaint.id}</h2>
              </div>
              <div className="text-right">
                <span className="text-[10px] uppercase font-bold text-neutral-500 tracking-wider">Status</span>
                <div className="flex items-center gap-1.5 justify-end">
                  <span className={`w-2 h-2 rounded-full ${selectedComplaint.status === 'resolved' ? 'bg-emerald-500' : selectedComplaint.status === 'in_progress' ? 'bg-indigo-400 animate-pulse' : 'bg-amber-400'}`} />
                  <span className="text-xs font-semibold capitalize text-neutral-200">{selectedComplaint.status.replace(/_/g, ' ')}</span>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 relative">
              <div className="hidden md:block absolute top-5 left-[60px] right-[60px] h-px bg-white/5 -z-10" />
              {steps.map((step, idx) => (
                <div key={idx} className="flex items-center gap-3 md:flex-col md:text-center md:gap-2">
                  <div className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 border transition-all ${
                    step.completed ? 'bg-indigo-500/15 text-indigo-400 border-indigo-500/30' : 'bg-white/[0.02] text-neutral-600 border-white/5'
                  }`}>
                    {step.completed ? <CheckCircle2 className="w-4 h-4" /> : <div className="w-2 h-2 rounded-full bg-neutral-800" />}
                  </div>
                  <div>
                    <div className={`text-xs font-bold ${step.completed ? 'text-neutral-200' : 'text-neutral-500'}`}>{step.name}</div>
                    <div className="text-[10px] text-neutral-600 mt-0.5">{step.desc}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-5 gap-5">
            {/* Description */}
            <div className="md:col-span-3 cm-card p-5 space-y-3">
              <h3 className="text-xs font-bold text-neutral-300 uppercase tracking-wider flex items-center gap-2">
                <FileText className="w-3.5 h-3.5 text-indigo-400" /> Description
              </h3>
              <p className="text-sm text-neutral-300 leading-relaxed bg-white/[0.02] p-4 rounded-xl border border-white/5 italic">
                &quot;{selectedComplaint.text}&quot;
              </p>
              <div className="grid grid-cols-2 gap-3 text-xs">
                <div className="bg-white/[0.02] p-3 rounded-lg border border-white/5">
                  <span className="text-neutral-500 text-[10px] font-semibold block mb-0.5">Category</span>
                  <span className="uppercase text-neutral-300 font-semibold">{selectedComplaint.category}</span>
                </div>
                <div className="bg-white/[0.02] p-3 rounded-lg border border-white/5">
                  <span className="text-neutral-500 text-[10px] font-semibold block mb-0.5">Filed</span>
                  <div className="flex items-center gap-1.5 text-neutral-300 font-semibold">
                    <Calendar className="w-3 h-3 text-neutral-500" />
                    <span>{new Date(selectedComplaint.created_at).toLocaleDateString()}</span>
                  </div>
                </div>
              </div>
              {selectedComplaint.latitude && selectedComplaint.longitude && (
                <div className="bg-white/[0.02] p-3 rounded-lg border border-white/5 text-xs flex justify-between items-center">
                  <div>
                    <span className="text-neutral-500 text-[10px] font-semibold block">GPS Coordinates</span>
                    <span className="font-mono text-neutral-300">{Number(selectedComplaint.latitude).toFixed(6)}, {Number(selectedComplaint.longitude).toFixed(6)}</span>
                  </div>
                  <MapPin className="w-4 h-4 text-indigo-400" />
                </div>
              )}
            </div>

            {/* Cluster info */}
            <div className="md:col-span-2 cm-card p-5">
              <h3 className="text-xs font-bold text-neutral-300 uppercase tracking-wider mb-4 flex items-center gap-2">
                <HelpCircle className="w-3.5 h-3.5 text-indigo-400" /> AI Cluster Summary
              </h3>
              {linkedCluster ? (
                <div className="space-y-3">
                  <div className="p-3 bg-indigo-500/5 border border-indigo-500/10 rounded-xl">
                    <span className="text-[9px] uppercase font-bold text-indigo-400 block mb-1">Clustered Into</span>
                    <div className="font-semibold text-xs text-white leading-snug">{linkedCluster.title}</div>
                    <div className="mt-1 text-[11px] text-neutral-400">
                      <span className="font-bold text-white">{linkedCluster.complaintCount}</span> similar reports in <span className="font-bold text-white">{linkedCluster.region}</span>
                    </div>
                  </div>
                  <div className="bg-white/[0.02] p-3 rounded-xl border border-white/5 flex items-center justify-between">
                    <div>
                      <span className="text-[9px] text-neutral-500 font-bold block">Severity</span>
                      <span className="text-sm font-bold text-white">{linkedCluster.severity}/100</span>
                    </div>
                    <div className="w-16 h-1.5 bg-white/5 rounded-full overflow-hidden">
                      <div className="h-full rounded-full bg-gradient-to-r from-amber-500 to-rose-500" style={{ width: `${linkedCluster.severity}%` }} />
                    </div>
                  </div>
                  <div>
                    <span className="text-[9px] text-neutral-500 font-bold block mb-1">Action</span>
                    <p className="text-[11px] text-neutral-400 leading-relaxed bg-white/[0.02] p-3 rounded-lg border border-white/5">
                      {linkedCluster.recommendedAction}
                    </p>
                  </div>
                </div>
              ) : (
                <div className="text-center py-6">
                  <Clock className="w-8 h-8 text-neutral-700 mx-auto mb-2" />
                  <span className="text-xs font-semibold text-neutral-400 block mb-1">Pending Ingestion</span>
                  <p className="text-[10px] text-neutral-600">Not yet clustered.</p>
                </div>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="cm-card p-12 text-center">
          <Clock className="w-8 h-8 text-neutral-700 mx-auto mb-3" />
          <h3 className="text-sm font-bold text-neutral-400">No complaint selected</h3>
          <p className="text-[11px] text-neutral-600 mt-1">Choose from dropdown or enter an ID above.</p>
        </div>
      )}
    </div>
  );
}

export default function TrackPage() {
  return (
    <Suspense fallback={<div className="flex-1 flex items-center justify-center p-12 text-neutral-500 text-sm">Loading tracker...</div>}>
      <TrackContent />
    </Suspense>
  );
}
