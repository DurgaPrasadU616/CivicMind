'use client';

import React, { useState, useEffect, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { apiClient, ApiError } from '../../lib/api';
import { Search, MapPin, Calendar, Clock, AlertTriangle, FileText, CheckCircle2, HelpCircle, RefreshCw } from 'lucide-react';

function TrackContent() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const [searchId, setSearchId] = useState('');
  const [selectedComplaint, setSelectedComplaint] = useState<any>(null);
  const [linkedCluster, setLinkedCluster] = useState<any>(null);
  
  const [recentIds, setRecentIds] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  // 1. Fetch list of all active complaint IDs to populate dropdown
  useEffect(() => {
    const fetchRecentIds = async () => {
      try {
        const res = await apiClient.getClusters();
        const ids: string[] = [];
        res.data.forEach((cluster: any) => {
          cluster.complaints.forEach((comp: any) => {
            if (!ids.includes(comp.id)) {
              ids.push(comp.id);
            }
          });
        });
        setRecentIds(ids.sort());
      } catch (err) {
        console.error('Failed to load recent complaint IDs for dropdown:', err);
      }
    };
    fetchRecentIds();
  }, []);

  // 2. Fetch specific complaint details
  const fetchComplaintDetails = async (id: string) => {
    setIsLoading(true);
    setErrorMsg('');
    try {
      const compRes = await apiClient.getComplaint(id);
      setSelectedComplaint(compRes.data);

      // Fetch linked cluster details if available
      if (compRes.data.clusterId) {
        try {
          const clustersRes = await apiClient.getClusters();
          const match = clustersRes.data.find((c) => c.id === compRes.data.clusterId);
          setLinkedCluster(match || null);
        } catch (e) {
          console.error('Failed to fetch cluster details:', e);
        }
      } else {
        setLinkedCluster(null);
      }
    } catch (err) {
      setSelectedComplaint(null);
      setLinkedCluster(null);
      if (err instanceof ApiError) {
        if (err.status === 404) {
          setErrorMsg(err.message);
        } else {
          setErrorMsg(`Server Error (${err.status}): ${err.message}`);
        }
      } else {
        setErrorMsg('Unable to connect to the backend server.');
      }
    } finally {
      setIsLoading(false);
    }
  };

  // 3. Sync lookup with URL query parameter changes
  useEffect(() => {
    const idParam = searchParams.get('id');
    if (idParam) {
      setSearchId(idParam);
      fetchComplaintDetails(idParam);
    }
  }, [searchParams]);

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchId.trim()) return;
    router.replace(`/track?id=${searchId.trim().toUpperCase()}`);
  };

  const handleDropdownSelect = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const id = e.target.value;
    if (id) {
      router.replace(`/track?id=${id}`);
    }
  };

  // Stepper state calculations
  const steps = (() => {
    if (!selectedComplaint) return [];

    const isSubmitted = true;
    const isClustered = !!selectedComplaint.clusterId;
    const isInReview = selectedComplaint.status === 'in_progress' || selectedComplaint.status === 'resolved';
    const isResolved = selectedComplaint.status === 'resolved';

    return [
      { name: 'Submitted', desc: 'Complaint registered', completed: isSubmitted },
      { name: 'Clustered', desc: 'Grouped with related issues', completed: isClustered },
      { name: 'In Review', desc: 'Assigned to officials', completed: isInReview },
      { name: 'Resolved', desc: 'Action complete', completed: isResolved },
    ];
  })();

  return (
    <div className="max-w-4xl mx-auto px-6 py-12">
      {/* Header */}
      <div className="text-center mb-10">
        <h1 className="text-3xl font-extrabold tracking-tight text-white sm:text-4xl">
          Track Your Complaint
        </h1>
        <p className="mt-3 text-neutral-400 max-w-lg mx-auto text-sm">
          Enter your reference ID below to view the real-time processing status of your report.
        </p>
      </div>

      {/* Search inputs */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
        {/* Dropdown Selection */}
        <div className="md:col-span-1">
          <label className="block text-xs font-bold uppercase text-neutral-500 mb-2">
            Select Live Database Report
          </label>
          <select
            value={selectedComplaint?.id ? `CM-${selectedComplaint.id}` : ''}
            onChange={handleDropdownSelect}
            className="w-full px-4 py-3 bg-neutral-900 border border-neutral-800 rounded-xl text-sm text-neutral-300 focus:outline-none focus:ring-1 focus:ring-emerald-500"
          >
            <option value="">-- Choose Complaint --</option>
            {recentIds.map((cId) => (
              <option key={cId} value={cId}>
                {cId}
              </option>
            ))}
          </select>
        </div>

        {/* Search Field */}
        <div className="md:col-span-2">
          <label className="block text-xs font-bold uppercase text-neutral-500 mb-2">
            Search by Database ID
          </label>
          <form onSubmit={handleSearchSubmit} className="flex gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-4 top-3.5 w-4 h-4 text-neutral-500" />
              <input
                type="text"
                placeholder="e.g. CM-1 or 1"
                value={searchId}
                onChange={(e) => setSearchId(e.target.value)}
                className="w-full pl-11 pr-4 py-3 bg-neutral-900 border border-neutral-800 rounded-xl text-sm text-white placeholder-neutral-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 focus:border-emerald-500"
              />
            </div>
            <button
              type="submit"
              className="bg-neutral-800 hover:bg-neutral-700 text-white px-5 rounded-xl text-sm font-semibold border border-neutral-700/50 transition-all cursor-pointer"
            >
              Search
            </button>
          </form>
        </div>
      </div>

      {errorMsg && (
        <div className="p-4 bg-rose-500/10 border border-rose-500/20 rounded-xl text-sm text-rose-400 flex gap-2 items-center mb-8">
          <AlertTriangle className="w-5 h-5 shrink-0" />
          <span>{errorMsg}</span>
        </div>
      )}

      {isLoading ? (
        <div className="text-center glass-panel p-12 rounded-2xl border-neutral-800">
          <RefreshCw className="w-8 h-8 text-emerald-400 animate-spin mx-auto mb-4" />
          <p className="text-sm text-neutral-400">Querying database rows...</p>
        </div>
      ) : selectedComplaint ? (
        <div className="space-y-6 animate-in fade-in duration-200">
          {/* Stepper Card */}
          <div className="glass-panel p-8 rounded-2xl border-neutral-800">
            <div className="flex justify-between items-center mb-8">
              <div>
                <span className="text-[10px] uppercase font-bold text-neutral-500 tracking-wider">Complaint Reference</span>
                <h2 className="text-xl font-bold font-mono text-emerald-400">CM-{selectedComplaint.id}</h2>
              </div>
              <div className="text-right">
                <span className="text-[10px] uppercase font-bold text-neutral-500 tracking-wider">Current Status</span>
                <div className="flex items-center gap-1.5 justify-end">
                  <span className={`w-2 h-2 rounded-full ${
                    selectedComplaint.status === 'resolved' ? 'bg-emerald-500' :
                    selectedComplaint.status === 'in_progress' ? 'bg-indigo-400 animate-pulse' : 'bg-amber-400'
                  }`} />
                  <span className="text-xs font-semibold capitalize text-neutral-200">{selectedComplaint.status.replace(/_/g, ' ')}</span>
                </div>
              </div>
            </div>

            {/* Stepper component */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-6 relative">
              <div className="hidden md:block absolute top-5 left-12 right-12 h-0.5 bg-neutral-850 -z-10" />

              {steps.map((step, idx) => (
                <div key={idx} className="flex md:flex-col items-center md:text-center gap-4 md:gap-3">
                  <div
                    className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 border transition-all duration-300 ${
                      step.completed
                        ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/50 shadow-md shadow-emerald-500/5'
                        : 'bg-neutral-950 text-neutral-600 border-neutral-850'
                    }`}
                  >
                    {step.completed ? (
                      <CheckCircle2 className="w-5 h-5" />
                    ) : (
                      <div className="w-2 h-2 rounded-full bg-neutral-800" />
                    )}
                  </div>
                  <div>
                    <div className={`text-xs font-bold ${step.completed ? 'text-neutral-200' : 'text-neutral-500'}`}>
                      {step.name}
                    </div>
                    <div className="text-[10px] text-neutral-500 mt-0.5">
                      {step.desc}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Details Row */}
          <div className="grid grid-cols-1 md:grid-cols-5 gap-6">
            {/* Description */}
            <div className="md:col-span-3 glass-panel p-6 rounded-2xl border-neutral-800 space-y-4">
              <h3 className="text-sm font-bold text-white uppercase tracking-wider flex items-center gap-2">
                <FileText className="w-4 h-4 text-emerald-400" />
                <span>Description of Issue</span>
              </h3>
              <p className="text-sm text-neutral-300 leading-relaxed bg-neutral-950/50 p-4 rounded-xl border border-neutral-900/80 italic">
                "{selectedComplaint.text}"
              </p>
              
              <div className="grid grid-cols-2 gap-4 text-xs pt-2">
                <div className="bg-neutral-950/30 p-3 rounded-lg border border-neutral-900">
                  <span className="text-neutral-500 font-medium block mb-1">Category</span>
                  <span className="uppercase text-neutral-300 font-semibold">{selectedComplaint.category}</span>
                </div>
                <div className="bg-neutral-950/30 p-3 rounded-lg border border-neutral-900">
                  <span className="text-neutral-500 font-medium block mb-1">Filed Date</span>
                  <div className="flex items-center gap-1.5 text-neutral-300 font-semibold">
                    <Calendar className="w-3 h-3 text-neutral-400" />
                    <span>{new Date(selectedComplaint.created_at).toLocaleDateString()}</span>
                  </div>
                </div>
              </div>

              {selectedComplaint.latitude && selectedComplaint.longitude && (
                <div className="bg-neutral-950/30 p-3 rounded-lg border border-neutral-900 text-xs flex justify-between items-center">
                  <div>
                    <span className="text-neutral-500 font-medium block mb-0.5">Database Coordinates</span>
                    <span className="font-mono text-neutral-300">{parseFloat(selectedComplaint.latitude).toFixed(6)}, {parseFloat(selectedComplaint.longitude).toFixed(6)}</span>
                  </div>
                  <div className="w-8 h-8 rounded-lg bg-neutral-900 flex items-center justify-center border border-neutral-850">
                    <MapPin className="w-3.5 h-3.5 text-emerald-400" />
                  </div>
                </div>
              )}
            </div>

            {/* Ingestion Info */}
            <div className="md:col-span-2 glass-panel p-6 rounded-2xl border-neutral-800">
              <h3 className="text-sm font-bold text-white uppercase tracking-wider mb-4 flex items-center gap-2">
                <HelpCircle className="w-4 h-4 text-indigo-400" />
                <span>AI Ingestion Summary</span>
              </h3>

              {linkedCluster ? (
                <div className="space-y-4">
                  <div className="bg-indigo-500/10 border border-indigo-500/20 rounded-xl p-4 text-indigo-300">
                    <span className="text-[10px] uppercase font-bold text-indigo-400 block mb-1">Clustered Into Group</span>
                    <div className="font-semibold text-sm leading-snug">{linkedCluster.title}</div>
                    <div className="mt-1 text-[11px] text-neutral-400">
                      Matches <span className="font-bold text-white">{linkedCluster.complaintCount}</span> similar reports in <span className="font-bold text-white">{linkedCluster.region}</span>.
                    </div>
                  </div>

                  <div className="bg-neutral-950/50 p-3 rounded-xl border border-neutral-900 flex items-center justify-between">
                    <div>
                      <span className="text-[10px] text-neutral-500 font-bold block">Cluster Severity</span>
                      <span className="text-sm font-bold text-white">{linkedCluster.severity}/100</span>
                    </div>
                    <div className="w-20 h-2 bg-neutral-900 rounded-full overflow-hidden">
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-yellow-500 to-rose-500"
                        style={{ width: `${linkedCluster.severity}%` }}
                      />
                    </div>
                  </div>

                  <div>
                    <span className="text-[10px] text-neutral-500 font-bold block mb-1">Recommended Action</span>
                    <p className="text-xs text-neutral-400 leading-relaxed bg-neutral-950 p-3 rounded-lg border border-neutral-900">
                      {linkedCluster.recommendedAction}
                    </p>
                  </div>
                </div>
              ) : (
                <div className="text-center py-6">
                  <div className="w-12 h-12 bg-neutral-900 border border-neutral-850 text-neutral-500 rounded-full flex items-center justify-center mx-auto mb-3">
                    <Clock className="w-5 h-5" />
                  </div>
                  <span className="text-xs font-semibold text-neutral-300 block mb-1">Pending Ingestion</span>
                  <p className="text-[10px] text-neutral-500 leading-relaxed max-w-xs mx-auto">
                    This report has not been grouped. Once secondary ingestion parses it, cluster summaries will render.
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="text-center glass-panel p-12 rounded-2xl border-neutral-800">
          <div className="w-12 h-12 bg-neutral-900 border border-neutral-850 text-neutral-600 rounded-full flex items-center justify-center mx-auto mb-4">
            <Clock className="w-5 h-5" />
          </div>
          <h3 className="text-sm font-bold text-neutral-400">No active complaint selected</h3>
          <p className="text-[11px] text-neutral-500 mt-1">
            Choose a database report from the dropdown or enter an ID to query status.
          </p>
        </div>
      )}
    </div>
  );
}

export default function TrackPage() {
  return (
    <Suspense fallback={
      <div className="flex-1 flex items-center justify-center p-12 text-neutral-400">
        Loading E2E tracker...
      </div>
    }>
      <TrackContent />
    </Suspense>
  );
}
