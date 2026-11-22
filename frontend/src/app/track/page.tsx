'use client';

import React, { useState, useEffect, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { apiClient, ApiError } from '../../lib/api';
import { Search, MapPin, Calendar, AlertTriangle, FileText, CheckCircle2, Clock, HelpCircle } from 'lucide-react';
import { Card, CardContent } from '../../components/ui/card';
import { Input } from '../../components/ui/input';
import { Button } from '../../components/ui/button';
import { Badge } from '../../components/ui/badge';
import { Skeleton } from '../../components/ui/skeleton';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '../../components/ui/select';
import { cn } from '../../lib/utils';

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

const statusVariant = (status: string) => {
  switch (status) {
    case 'resolved': return 'success' as const;
    case 'in_progress': return 'info' as const;
    case 'escalated': return 'destructive' as const;
    default: return 'warning' as const;
  }
};

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
          const clustersRes = await apiClient.getClusters({ id: String(compData.clusterId) });
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
      { name: 'Grouped', desc: 'Grouped with similar reports', completed: isClustered },
      { name: 'In Progress', desc: 'Assigned to officials', completed: isInReview },
      { name: 'Resolved', desc: 'Action complete', completed: isResolved },
    ];
  })();

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-4xl mx-auto space-y-5">
      <div>
        <h1 className="text-xl font-bold text-white flex items-center gap-2">
          <Search className="w-5 h-5 text-indigo-400" />
          Track Your Complaint
        </h1>
        <p className="text-sm text-neutral-500 mt-1">
          Enter your reference ID to view real-time processing status and issue grouping.
        </p>
      </div>

      <Card>
        <CardContent className="p-5">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-[10px] font-bold uppercase text-neutral-500 mb-1.5 tracking-wider">Select Report</label>
              <Select
                value={selectedComplaint?.id ? `CM-${selectedComplaint.id}` : ''}
                onValueChange={(v) => { if (v) router.replace(`/track?id=${v}`); }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="-- Choose --" />
                </SelectTrigger>
                <SelectContent>
                  {recentIds.map(cId => (
                    <SelectItem key={cId} value={cId}>{cId}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="md:col-span-2">
              <label className="block text-[10px] font-bold uppercase text-neutral-500 mb-1.5 tracking-wider">Search by ID</label>
              <form onSubmit={handleSearchSubmit} className="flex gap-2">
                <div className="relative flex-1">
                  <Search className="absolute left-3 top-2.5 w-4 h-4 text-neutral-500" />
                  <Input type="text" placeholder="e.g. CM-1 or 1" value={searchId} onChange={(e) => setSearchId(e.target.value)} className="pl-9" />
                </div>
                <Button type="submit" variant="secondary">Search</Button>
              </form>
            </div>
          </div>
        </CardContent>
      </Card>

      {errorMsg && (
        <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-xs text-red-400 flex gap-2 items-center">
          <AlertTriangle className="w-4 h-4 shrink-0" /> <span>{errorMsg}</span>
        </div>
      )}

      {isLoading ? (
        <Card>
          <CardContent className="p-5 space-y-4">
            <div className="flex items-center gap-4">
              <Skeleton className="w-12 h-12 rounded-lg shrink-0" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-3 w-48" />
              </div>
            </div>
            <Skeleton className="h-20 w-full rounded-lg" />
            <div className="grid grid-cols-2 gap-3">
              <Skeleton className="h-16 w-full rounded-lg" />
              <Skeleton className="h-16 w-full rounded-lg" />
            </div>
          </CardContent>
        </Card>
      ) : selectedComplaint ? (
        <div className="space-y-5 fade-in">
          <Card>
            <CardContent className="p-6">
              <div className="flex justify-between items-center mb-6">
                <div>
                  <span className="text-[10px] uppercase font-bold text-neutral-500 tracking-wider">Reference</span>
                  <h2 className="text-lg font-bold font-mono text-indigo-400">CM-{selectedComplaint.id}</h2>
                </div>
                <div className="text-right">
                  <span className="text-[10px] uppercase font-bold text-neutral-500 tracking-wider">Status</span>
                  <Badge variant={statusVariant(selectedComplaint.status)} className="mt-1 capitalize">
                    {selectedComplaint.status.replace(/_/g, ' ')}
                  </Badge>
                </div>
              </div>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 relative">
                <div className="hidden md:block absolute top-5 left-[60px] right-[60px] h-px bg-white/5 -z-10" />
                {steps.map((step, idx) => (
                  <div key={idx} className="flex items-center gap-3 md:flex-col md:text-center md:gap-2">
                    <div className={cn(
                      'w-9 h-9 rounded-full flex items-center justify-center shrink-0 border transition-colors',
                      step.completed ? 'bg-indigo-500/15 text-indigo-400 border-indigo-500/30' : 'bg-white/[0.02] text-neutral-600 border-white/5'
                    )}>
                      {step.completed ? <CheckCircle2 className="w-4 h-4" /> : <div className="w-2 h-2 rounded-full bg-neutral-800" />}
                    </div>
                    <div>
                      <div className={cn('text-xs font-bold', step.completed ? 'text-neutral-200' : 'text-neutral-500')}>{step.name}</div>
                      <div className="text-[10px] text-neutral-600 mt-0.5">{step.desc}</div>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          <div className="grid grid-cols-1 md:grid-cols-5 gap-5">
            <div className="md:col-span-3">
              <Card>
                <CardContent className="p-5 space-y-3">
                  <h3 className="text-[11px] font-bold text-neutral-300 uppercase tracking-wider flex items-center gap-2">
                    <FileText className="w-3.5 h-3.5 text-indigo-400" /> Description
                  </h3>
                  <Card className="p-4">
                    <p className="text-sm text-neutral-300 leading-relaxed italic">
                      &quot;{selectedComplaint.text}&quot;
                    </p>
                  </Card>
                  <div className="grid grid-cols-2 gap-3 text-xs">
                    <Card className="p-3">
                      <span className="text-neutral-500 text-[10px] font-semibold block mb-0.5">Category</span>
                      <span className="uppercase text-neutral-300 font-semibold">{selectedComplaint.category}</span>
                    </Card>
                    <Card className="p-3">
                      <span className="text-neutral-500 text-[10px] font-semibold block mb-0.5">Filed</span>
                      <div className="flex items-center gap-1.5 text-neutral-300 font-semibold">
                        <Calendar className="w-3 h-3 text-neutral-500" />
                        <span>{new Date(selectedComplaint.created_at).toLocaleDateString()}</span>
                      </div>
                    </Card>
                  </div>
                  {selectedComplaint.latitude && selectedComplaint.longitude && (
                    <Card className="p-3 text-xs flex justify-between items-center">
                      <div>
                        <span className="text-neutral-500 text-[10px] font-semibold block">GPS Coordinates</span>
                        <span className="font-mono text-neutral-300">{Number(selectedComplaint.latitude).toFixed(6)}, {Number(selectedComplaint.longitude).toFixed(6)}</span>
                      </div>
                      <MapPin className="w-4 h-4 text-indigo-400" />
                    </Card>
                  )}
                </CardContent>
              </Card>
            </div>

            <div className="md:col-span-2">
              <Card>
                <CardContent className="p-5">
                  <h3 className="text-[11px] font-bold text-neutral-300 uppercase tracking-wider mb-4 flex items-center gap-2">
                    <HelpCircle className="w-3.5 h-3.5 text-indigo-400" /> AI Issue Summary
                  </h3>
                  {linkedCluster ? (
                    <div className="space-y-3">
                      <Card className="p-3">
                        <span className="text-[9px] uppercase font-bold text-indigo-400 block mb-1">Related Issue</span>
                        <div className="font-semibold text-xs text-white leading-snug">{linkedCluster.title}</div>
                        <div className="mt-1 text-[11px] text-neutral-400">
                          <span className="font-bold text-white">{linkedCluster.complaintCount}</span> similar reports in <span className="font-bold text-white">{linkedCluster.region}</span>
                        </div>
                      </Card>
                      <Card className="p-3 flex items-center justify-between">
                        <div>
                          <span className="text-[9px] text-neutral-500 font-bold block">Severity</span>
                          <span className="text-sm font-bold text-white">
                            {linkedCluster.severity}/100
                          </span>
                        </div>
                        <div className="w-16 h-1.5 bg-white/5 rounded-full overflow-hidden">
                          <div className={cn(
                            'h-full rounded-full',
                            linkedCluster.severity >= 75 ? 'bg-red-500' : linkedCluster.severity >= 40 ? 'bg-amber-500' : 'bg-green-500'
                          )} style={{ width: `${linkedCluster.severity}%` }} />
                        </div>
                      </Card>
                      <div>
                        <span className="text-[9px] text-neutral-500 font-bold block mb-1">Action</span>
                        <Card className="p-3">
                          <p className="text-[11px] text-neutral-400 leading-relaxed">
                            {linkedCluster.recommendedAction}
                          </p>
                        </Card>
                      </div>
                    </div>
                  ) : (
                    <div className="text-center py-6">
                      <Clock className="w-8 h-8 text-neutral-700 mx-auto mb-2" />
                      <span className="text-xs font-semibold text-neutral-400 block mb-1">Pending Ingestion</span>
                      <p className="text-[10px] text-neutral-600">Not yet grouped with other issues.</p>
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          </div>
        </div>
      ) : (
        <Card>
          <CardContent className="p-12 text-center">
            <Clock className="w-8 h-8 text-neutral-700 mx-auto mb-3" />
            <h3 className="text-base font-bold text-neutral-400">No complaint selected</h3>
            <p className="text-sm text-neutral-600 mt-1">Choose from dropdown or enter an ID above.</p>
          </CardContent>
        </Card>
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
