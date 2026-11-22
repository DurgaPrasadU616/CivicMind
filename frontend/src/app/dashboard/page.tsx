'use client';

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useAuth } from '../../context/AuthContext';
import { apiClient, type ClusterStatus, type ActionLogEntry } from '../../lib/api';
import {
  TrendingUp, CheckCircle2, AlertOctagon, Clock,
  Map, List, Search, ArrowUpDown,
  RefreshCw, AlertTriangle, Loader2, Bot, Zap, ChevronRight,
  X, Activity, ArrowRight, History, MessageSquare, ShieldAlert,
  FileText, BarChart3, Filter
} from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts';

import { IngestionHistoryPanel } from '../../components/IngestionHistoryPanel';
import { IssueCard, type IssueCardCluster } from '../../components/IssueCard';
import {
  getSeverityConfig, getMapDotFill,
  getStatusConfig, getStatusDisplay, getTransitionLabel, getTransitionColor,
  getSourceLabel
} from '../../lib/dashboard-utils';

import { Card, CardContent } from '../../components/ui/card';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../../components/ui/tabs';
import { Skeleton } from '../../components/ui/skeleton';
import { Separator } from '../../components/ui/separator';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '../../components/ui/select';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../../components/ui/collapsible';
import { cn } from '../../lib/utils';

interface ComplaintItem {
  id: string | number;
  status: string;
  text: string;
  created_at: string;
  source_name?: string;
  latitude?: number | null;
  longitude?: number | null;
  [key: string]: unknown;
}

interface ClusterItem {
  id: string | number;
  title: string;
  category: string;
  region: string;
  complaintCount: number;
  severity: number;
  priorityScore?: number;
  hybridScore?: number;
  geoCentroidLat?: number;
  geoCentroidLng?: number;
  temporalWeight?: number;
  status: ClusterStatus;
  needsReview?: boolean;
  recommendedAction?: string;
  actionSource?: string;
  lastUpdated?: string;
  complaints: ComplaintItem[];
  latitude?: number | null;
  longitude?: number | null;
  latestAction?: {
    generatedBy?: string;
    text?: string;
    generatedAt?: string | number | Date;
    retrievedContext?: {
      coldStart?: boolean;
      pastCases?: Array<{ category?: string; title?: string; action_text?: string }>;
      guidelines?: Array<{ source?: string; title?: string; content?: string }>;
    } | null;
    confidenceScore?: number;
  } | null;
  [key: string]: unknown;
}

/** Shape of a JSON-encoded recommended action (falls back to raw text). */
interface RecommendationJson {
  executive_summary?: string;
  root_cause_analysis?: string;
  budget_estimate?: string;
  short_term_actions?: string[];
  long_term_actions?: string[];
}

/**
 * Reads the AI confidence score off a cluster. Kept as a helper so JSX ternary
 * narrowing on `latestAction` cannot collapse the type to `never` here.
 */
const confidenceOf = (
  cluster: { latestAction?: { confidenceScore?: number } | null } | null | undefined
): number | undefined => cluster?.latestAction?.confidenceScore;

const severityVariant = (score: number) => {
  if (score >= 75) return 'destructive' as const;
  if (score >= 40) return 'warning' as const;
  return 'success' as const;
};

const statusVariant = (status: string) => {
  switch (status) {
    case 'open': return 'warning' as const;
    case 'in_progress': return 'info' as const;
    case 'resolved': return 'success' as const;
    case 'escalated': return 'destructive' as const;
    default: return 'secondary' as const;
  }
};

export default function DashboardPage() {
  const { userRole, user } = useAuth();

  const [viewMode, setViewMode] = useState<'table' | 'map'>('table');
  const [searchQuery, setSearchQuery] = useState('');
  const [filterCategory, setFilterCategory] = useState<string>('all');
  const [filterRegion, setFilterRegion] = useState<string>('all');
  const [filterStatus, setFilterStatus] = useState<string>('all');
  const [selectedClusterId, setSelectedClusterId] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<'priority' | 'severity' | 'count'>('priority');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
  const [sidebarSection, setSidebarSection] = useState<'default' | 'detail'>('default');

  const [clusters, setClusters] = useState<ClusterItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(true);

  const [detailTab, setDetailTab] = useState<'overview' | 'history'>('overview');
  const [clusterHistory, setClusterHistory] = useState<ActionLogEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [noteInput, setNoteInput] = useState('');
  const [showNoteInput, setShowNoteInput] = useState<ClusterStatus | null>(null);
  const [filterToolsOpen, setFilterToolsOpen] = useState(false);
  const [showReasoning, setShowReasoning] = useState(false);

  const MAP_BOUNDS = { minLat: 12.9400, maxLat: 12.9900, minLng: 77.5600, maxLng: 77.6400 };
  const getCoordinates = (lat: number, lng: number) => {
    const x = ((lng - MAP_BOUNDS.minLng) / (MAP_BOUNDS.maxLng - MAP_BOUNDS.minLng)) * 500;
    const y = 400 - ((lat - MAP_BOUNDS.minLat) / (MAP_BOUNDS.maxLat - MAP_BOUNDS.minLat)) * 400;
    return { x, y };
  };

  const fetchFilteredClusters = useCallback(async (isLoadMore = false, targetPage = 0) => {
    setIsLoading(true);
    setErrorMsg('');
    try {
      const currentOffset = isLoadMore ? targetPage * 50 : 0;
      const res = await apiClient.getClusters({ 
        category: filterCategory, 
        region: filterRegion, 
        status: filterStatus, 
        search: searchQuery,
        limit: 50,
        offset: currentOffset
      });
      const cls = res.data as ClusterItem[];
      
      if (isLoadMore) {
        setClusters((prev) => {
          // Avoid duplicates if same page was called twice
          const newIds = new Set(cls.map(c => c.id));
          return [...prev.filter(c => !newIds.has(c.id)), ...cls];
        });
      } else {
        setClusters(cls);
        setPage(0); // Reset page on new filter
      }

      if (res.meta) {
        setHasMore(currentOffset + 50 < res.meta.total);
      } else {
        setHasMore(cls.length === 50);
      }

      if (!isLoadMore) {
        if (cls.length > 0) {
          const stillExists = cls.some((c) => String(c.id) === String(selectedClusterId));
          if (!stillExists && sidebarSection === 'detail') {
            setSelectedClusterId(null);
            setSidebarSection('default');
          }
        } else {
          setSelectedClusterId(null);
          setSidebarSection('default');
        }
      }
    } catch (err) {
      console.error(err);
      setErrorMsg('Failed to load issues. Please check your connection and try again.');
    } finally {
      setIsLoading(false);
    }
  }, [filterCategory, filterRegion, filterStatus, searchQuery, selectedClusterId, sidebarSection]); // removed 'page' from dependencies

  // Rest of functions...
  const ALLOWED_TRANSITIONS: Record<ClusterStatus, ClusterStatus[]> = {
    open:        ['in_progress'],
    in_progress: ['resolved', 'escalated'],
    escalated:   ['in_progress'],
    resolved:    ['open'],
  };

  const handlePatchStatus = async (targetStatus: ClusterStatus, note?: string) => {
    if (!selectedClusterId) return;
    try {
      const result = await apiClient.patchClusterStatus(selectedClusterId, targetStatus, note);
      setClusters(prev => prev.map(c =>
        String(c.id) === String(selectedClusterId)
          ? { ...c, status: result.cluster.status, needsReview: result.cluster.needsReview }
          : c
      ));
      setShowNoteInput(null);
      setNoteInput('');
      if (detailTab === 'history') {
        loadHistory(selectedClusterId);
      }
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'status' in err) {
        const e = err as { status?: number; message?: string };
        if (e.status === 400) setErrorMsg(e.message || 'Invalid status transition.');
        else if (e.status === 403) setErrorMsg('Permission denied. Only NGO/Govt/Admin accounts can update issue status.');
        else if (e.status !== 401) setErrorMsg(e.message || 'Error updating issue status.');
      }
    }
  };

  const loadHistory = useCallback(async (clusterId: string) => {
    setHistoryLoading(true);
    try {
      const result = await apiClient.getClusterHistory(clusterId);
      setClusterHistory(result.history);
    } catch (err) {
      console.error('Failed to load issue history:', err);
      setClusterHistory([]);
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  useEffect(() => {
    // Only re-fetch (resetting page to 0) when filters change
    const t = setTimeout(() => { fetchFilteredClusters(false); }, 300);
    return () => clearTimeout(t);
  }, [fetchFilteredClusters]);

  useEffect(() => {
    if (detailTab === 'history' && selectedClusterId) {
      loadHistory(selectedClusterId);
    }
  }, [detailTab, selectedClusterId, loadHistory]);

  const handleSort = (field: 'priority' | 'severity' | 'count') => {
    if (sortBy === field) setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    else { setSortBy(field); setSortOrder('desc'); }
  };

  const sortedClusters = useMemo(() => {
    const copy = [...clusters];
    return copy.sort((a, b) => {
      let valA = 0, valB = 0;
      if (sortBy === 'priority') { valA = a.priorityScore ?? a.severity; valB = b.priorityScore ?? b.severity; }
      else if (sortBy === 'severity') { valA = a.severity; valB = b.severity; }
      else if (sortBy === 'count') { valA = a.complaintCount; valB = b.complaintCount; }
      return sortOrder === 'asc' ? valA - valB : valB - valA;
    });
  }, [clusters, sortBy, sortOrder]);

  const selectedCluster = useMemo(() => clusters.find((c) => String(c.id) === String(selectedClusterId)) || null, [clusters, selectedClusterId]);

  const chartData = useMemo(() => {
    const catCounts: Record<string, number> = {};
    clusters.forEach(c => { catCounts[c.category] = (catCounts[c.category] || 0) + c.complaintCount; });
    return Object.entries(catCounts).map(([name, count]) => ({
      name: name.charAt(0).toUpperCase() + name.slice(1),
      count,
    }));
  }, [clusters]);

  const chartColors = ['#6366f1', '#f59e0b', '#3b82f6', '#ef4444', '#22c55e', '#8b5cf6'];

  const summaryStats = useMemo(() => {
    let openIssues = 0;
    let highSeverityCount = 0;
    let newToday = 0;
    const resolvedClusters: ClusterItem[] = [];

    clusters.forEach((c) => {
      if (c.status !== 'resolved') {
        openIssues += c.complaintCount;
        if (c.severity >= 40) highSeverityCount += c.complaintCount;
      } else {
        resolvedClusters.push(c);
      }
      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      (c.complaints || []).forEach((comp) => {
        if (new Date(comp.created_at) >= todayStart) {
          newToday++;
        }
      });
    });

    let avgResolutionDisplay = '\u2014';
    if (resolvedClusters.length > 0) {
      let totalHours = 0;
      let count = 0;
      resolvedClusters.forEach((c) => {
        const complaints = c.complaints || [];
        if (complaints.length > 0 && c.lastUpdated) {
          const firstDate = complaints.reduce((earliest, comp) => {
            const d = new Date(comp.created_at).getTime();
            return d < earliest ? d : earliest;
          }, Infinity);
          if (firstDate < Infinity) {
            const resolvedDate = new Date(c.lastUpdated).getTime();
            totalHours += (resolvedDate - firstDate) / 3600000;
            count++;
          }
        }
      });
      if (count > 0) {
        const avgHrs = Math.round(totalHours / count);
        if (avgHrs < 24) {
          avgResolutionDisplay = `${avgHrs} hr${avgHrs !== 1 ? 's' : ''}`;
        } else {
          avgResolutionDisplay = `${Math.round(avgHrs / 24)} day${Math.round(avgHrs / 24) !== 1 ? 's' : ''}`;
        }
      }
    }

    return { openIssues, highSeverityCount, newToday, avgResolutionDisplay };
  }, [clusters]);

  const criticalCount = clusters.filter(c => c.severity >= 75 && c.status !== 'resolved').length;

  const getGreeting = () => {
    const h = new Date().getHours();
    if (h < 12) return 'Good morning';
    if (h < 17) return 'Good afternoon';
    return 'Good evening';
  };

  const handleSelectIssue = (id: string) => {
    if (String(selectedClusterId) === String(id)) {
      setSelectedClusterId(null);
      setSidebarSection('default');
    } else {
      setSelectedClusterId(id);
      setSidebarSection('detail');
      setDetailTab('overview');
      setClusterHistory([]);
      setShowNoteInput(null);
      setNoteInput('');
    }
  };

  const handleRetry = () => {
    fetchFilteredClusters();
  };

  const isOfficial = userRole && userRole !== 'citizen';
  const canViewIngestion = userRole === 'admin' || userRole === 'govt';

  const statCards = [
    { label: 'Open Issues', value: summaryStats.openIssues, icon: AlertOctagon, variant: 'destructive' as const },
    { label: 'High Severity', value: summaryStats.highSeverityCount, icon: TrendingUp, variant: 'warning' as const },
    { label: 'New Today', value: summaryStats.newToday, icon: FileText, variant: 'info' as const },
    { label: 'Avg Resolution', value: summaryStats.avgResolutionDisplay, icon: Clock, variant: 'success' as const },
  ];

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-5 max-w-[1440px] mx-auto w-full">
      {isLoading && clusters.length === 0 ? (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <Card key={i}>
              <CardContent className="flex items-center gap-4 p-5">
                <Skeleton className="w-11 h-11 rounded-lg shrink-0" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-3 w-16" />
                  <Skeleton className="h-7 w-20" />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
          {statCards.map((stat) => {
            const Icon = stat.icon;
            const variantColors: Record<string, string> = {
              destructive: 'bg-red-500/10 text-red-400',
              warning: 'bg-amber-500/10 text-amber-400',
              info: 'bg-indigo-500/10 text-indigo-400',
              success: 'bg-green-500/10 text-green-400',
            };
            return (
              <Card key={stat.label}>
                <CardContent className="flex items-center gap-3 sm:gap-4 p-4 sm:p-5">
                  <div className={cn('w-10 h-10 sm:w-11 sm:h-11 rounded-lg flex items-center justify-center shrink-0', variantColors[stat.variant])}>
                    <Icon className="w-5 h-5" />
                  </div>
                  <div>
                    <span className="text-[10px] sm:text-[11px] text-neutral-500 font-semibold uppercase tracking-wider block">{stat.label}</span>
                    <span className="text-xl sm:text-2xl font-extrabold text-white">{stat.value}</span>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <Card>
        <CardContent className="p-4 sm:p-5">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div>
              <h2 className="text-sm sm:text-base font-bold text-white">
                {getGreeting()}, {user?.name?.split(' ')[0] || 'there'}
              </h2>
              <p className="text-xs text-neutral-500 mt-0.5">
                {summaryStats.openIssues > 0
                  ? <>{summaryStats.openIssues} open issue{summaryStats.openIssues !== 1 ? 's' : ''} across {clusters.length} active issue{clusters.length !== 1 ? 's' : ''}.</>
                  : 'No active issues to review right now.'}
                {criticalCount > 0 && <> <span className="text-red-400 font-semibold">{criticalCount} critical</span> need attention.</>}
              </p>
            </div>
            {criticalCount > 0 && (
              <Button
                onClick={() => { setFilterStatus('all'); setFilterCategory('all'); setFilterRegion('all'); setSearchQuery(''); }}
                size="sm"
              >
                <AlertOctagon className="w-3.5 h-3.5" />
                View Critical
                <ChevronRight className="w-3.5 h-3.5" />
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {errorMsg && (
        <div className="p-3 sm:p-4 bg-red-500/10 border border-red-500/20 rounded-lg text-xs sm:text-sm text-red-400 flex gap-2 items-center">
          <AlertTriangle className="w-4 h-5 shrink-0" />
          <span className="flex-1">{errorMsg}</span>
          <Button variant="ghost" size="icon" onClick={() => setErrorMsg('')}>
            <X className="w-4 h-4" />
          </Button>
        </div>
      )}

      <div className="flex flex-col lg:flex-row gap-4 lg:gap-6">
        <div className="flex-1 min-w-0 order-2 lg:order-1">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs text-neutral-500 font-semibold">
              {sortedClusters.length} issue{sortedClusters.length !== 1 ? 's' : ''}
            </span>
            <div className="flex items-center gap-1 bg-white/[0.02] p-0.5 rounded-lg border border-white/5">
              {(['priority', 'severity', 'count'] as const).map((field) => (
                <Button
                  key={field}
                  onClick={() => handleSort(field)}
                  variant={sortBy === field ? 'secondary' : 'ghost'}
                  size="sm"
                  className={cn('text-[11px]', sortBy !== field && 'text-neutral-600')}
                >
                  {field === 'priority' ? 'Priority' : field === 'severity' ? 'Severity' : 'Reports'}
                  {sortBy === field && <ArrowUpDown className="w-3 h-3" />}
                </Button>
              ))}
            </div>
          </div>

          {isLoading && clusters.length === 0 ? (
            <div className="space-y-3">
              {[1, 2, 3, 4].map((i) => (
                <Card key={i}>
                  <CardContent className="p-5">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 space-y-3">
                        <div className="flex gap-2">
                          <Skeleton className="h-5 w-20 rounded-full" />
                          <Skeleton className="h-5 w-24 rounded-full" />
                        </div>
                        <Skeleton className="h-4 w-3/4" />
                        <Skeleton className="h-3 w-1/2" />
                        <div className="flex gap-3">
                          <Skeleton className="h-3 w-16" />
                          <Skeleton className="h-3 w-12" />
                          <Skeleton className="h-3 w-20" />
                        </div>
                      </div>
                      <Skeleton className="w-5 h-5 rounded-full shrink-0" />
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : errorMsg && clusters.length === 0 ? (
            <Card>
              <CardContent className="p-12 text-center">
                <div className="w-14 h-14 rounded-full bg-rose-500/10 border border-rose-500/20 flex items-center justify-center mx-auto mb-4">
                  <AlertTriangle className="w-7 h-7 text-rose-400" />
                </div>
                <h3 className="text-base font-bold text-neutral-300 mb-1">Something went wrong</h3>
                <p className="text-sm text-neutral-500 max-w-sm mx-auto mb-5">{errorMsg}</p>
                <Button onClick={handleRetry}>
                  <RefreshCw className="w-4 h-4" />
                  Try again
                </Button>
              </CardContent>
            </Card>
          ) : sortedClusters.length === 0 ? (
            <Card>
              <CardContent className="p-12 text-center">
                <div className="w-14 h-14 rounded-full bg-white/[0.02] border border-white/5 flex items-center justify-center mx-auto mb-4">
                  <CheckCircle2 className="w-7 h-7 text-neutral-600" />
                </div>
                <h3 className="text-base font-bold text-neutral-400 mb-1">No issues to show</h3>
                <p className="text-sm text-neutral-600 max-w-xs mx-auto">
                  {searchQuery || filterCategory !== 'all' || filterRegion !== 'all' || filterStatus !== 'all'
                    ? 'No issues match the current filters. Try adjusting your search criteria.'
                    : criticalCount === 0 && clusters.length === 0
                      ? 'No high-severity issues right now. Everything looks clear.'
                      : 'No issues match the current filters.'}
                </p>
                {(searchQuery || filterCategory !== 'all' || filterRegion !== 'all' || filterStatus !== 'all') && (
                  <Button
                    variant="secondary"
                    size="sm"
                    className="mt-5"
                    onClick={() => { setSearchQuery(''); setFilterCategory('all'); setFilterRegion('all'); setFilterStatus('all'); }}
                  >
                    Clear all filters
                  </Button>
                )}
              </CardContent>
            </Card>
          ) : viewMode === 'table' ? (
            <div className="space-y-2">
              {sortedClusters.map((cluster) => (
                <IssueCard
                  key={cluster.id}
                  cluster={cluster as IssueCardCluster}
                  isSelected={String(selectedClusterId) === String(cluster.id)}
                  onSelect={handleSelectIssue}
                />
              ))}
              {hasMore && (
                <div className="flex justify-center pt-4 pb-2">
                  <Button 
                    variant="outline" 
                    size="sm" 
                    onClick={() => {
                      const nextPage = page + 1;
                      setPage(nextPage);
                      fetchFilteredClusters(true, nextPage);
                    }}
                    disabled={isLoading}
                  >
                    {isLoading ? 'Loading...' : 'Load More'}
                  </Button>
                </div>
              )}
            </div>
          ) : (
            <Card>
              <CardContent className="p-4 sm:p-6 flex flex-col items-center gap-4">
                <span className="text-[10px] uppercase font-bold text-neutral-500 tracking-wider">Metro City \u2014 GPS Projection</span>
                <div className="relative w-full max-w-[500px] border border-white/5 rounded-lg overflow-hidden bg-[#0a0a0e] p-3">
                  <svg viewBox="0 0 500 400" className="w-full h-auto">
                    <g className="fill-[#111115] stroke-white/5 stroke-2">
                      <polygon points="0,0 500,0 500,100 0,160" />
                      <polygon points="0,160 200,200 150,400 0,400" />
                      <polygon points="500,100 500,320 300,250 200,200" />
                      <polygon points="150,400 300,250 500,320 500,400 150,400" />
                      <polygon points="0,160 200,200 300,250 150,400 0,160" className="fill-indigo-950/20" />
                    </g>
                    <g className="fill-neutral-600 text-[10px] uppercase font-bold tracking-widest pointer-events-none select-none">
                      <text x="220" y="45">North</text>
                      <text x="40" y="270">West</text>
                      <text x="410" y="220">East</text>
                      <text x="320" y="360">South</text>
                      <text x="130" y="220" className="fill-indigo-500/60 text-[11px]">Downtown</text>
                    </g>
                    {sortedClusters.map((cluster) => {
                      const { x, y } = getCoordinates(Number(cluster.latitude || 12.9716), Number(cluster.longitude || 77.5946));
                      const isSelected = String(selectedClusterId) === String(cluster.id);
                      const dotFill = getMapDotFill(cluster.severity);
                      return (
                        <g key={cluster.id} onClick={() => handleSelectIssue(String(cluster.id))} className="cursor-pointer group">
                          {isSelected && <circle cx={x} cy={y} r="14" className="fill-none stroke-white/50 stroke-2 animate-pulse" />}
                          <circle cx={x} cy={y} r="18" className="fill-white/0 group-hover:fill-white/5 transition-all" />
                          <circle cx={x} cy={y} r="8" className={`${dotFill} opacity-30 group-hover:opacity-50`} />
                          <circle cx={x} cy={y} r="4.5" className={`${dotFill} stroke-black stroke-2`} />
                        </g>
                      );
                    })}
                  </svg>
                </div>
                <div className="flex gap-4 sm:gap-6 text-[10px] text-neutral-500 flex-wrap justify-center">
                  <div className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-red-500" /> Critical (75+)</div>
                  <div className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-amber-500" /> Medium (40\u201374)</div>
                  <div className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-green-500" /> Low (&lt;40)</div>
                </div>
              </CardContent>
            </Card>
          )}
        </div>

        <div className="w-full lg:w-80 xl:w-96 shrink-0 order-1 lg:order-2 space-y-4">
          {sidebarSection === 'detail' && selectedCluster ? (
            <div className="slide-in">
              <Card>
                <CardContent className="p-5 lg:sticky lg:top-20 max-h-[calc(100vh-8rem)] overflow-y-auto">
                  <div className="flex items-start justify-between mb-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                        <Badge variant={severityVariant(selectedCluster.severity)}>
                          {getSeverityConfig(selectedCluster.severity).icon} {getSeverityConfig(selectedCluster.severity).label}
                        </Badge>
                        {selectedCluster.needsReview && (
                          <Badge variant="warning" className="animate-pulse">
                            <ShieldAlert className="w-2.5 h-2.5" /> Needs Review
                          </Badge>
                        )}
                      </div>
                      <h2 className="text-sm font-bold text-white leading-tight mt-1.5">{selectedCluster.title}</h2>
                      <div className="flex items-center gap-2 mt-1 text-[11px] text-neutral-500">
                        <span className="capitalize">{selectedCluster.category}</span>
                        <span>\u00B7</span>
                        <span>{selectedCluster.region}</span>
                        <span>\u00B7</span>
                        <span>{selectedCluster.complaintCount} report{selectedCluster.complaintCount !== 1 ? 's' : ''}</span>
                      </div>
                    </div>
                    <Button variant="ghost" size="icon" onClick={() => { setSelectedClusterId(null); setSidebarSection('default'); }} className="ml-2 shrink-0">
                      <X className="w-4 h-4" />
                    </Button>
                  </div>

                  <Tabs value={detailTab} onValueChange={(v) => setDetailTab(v as 'overview' | 'history')}>
                    <TabsList className="w-full mb-4">
                      <TabsTrigger value="overview" className="flex-1"><Activity className="w-3.5 h-3.5" /> Overview</TabsTrigger>
                      <TabsTrigger value="history" className="flex-1"><History className="w-3.5 h-3.5" /> History</TabsTrigger>
                    </TabsList>

                    <TabsContent value="overview">
                      <div className="flex gap-2 mb-4">
                        <div className="flex-1 text-center p-3 bg-white/[0.02] rounded-lg border border-white/5">
                          <div className={cn('text-lg font-extrabold', getSeverityConfig(selectedCluster.severity).textClass)}>
                            {getSeverityConfig(selectedCluster.severity).icon}
                          </div>
                          <div className="text-[9px] text-neutral-500 uppercase tracking-wider mt-0.5">Severity</div>
                        </div>
                        <div className="flex-1 text-center p-3 bg-white/[0.02] rounded-lg border border-white/5">
                          <div className={cn('text-lg font-extrabold', getSeverityConfig(selectedCluster.priorityScore ?? selectedCluster.severity).textClass)}>
                            {getSeverityConfig(selectedCluster.priorityScore ?? selectedCluster.severity).icon}
                          </div>
                          <div className="text-[9px] text-neutral-500 uppercase tracking-wider mt-0.5">Priority</div>
                        </div>
                        <div className="flex-1 text-center p-3 bg-white/[0.02] rounded-lg border border-white/5">
                          <div className="text-lg font-extrabold text-indigo-400">
                            {selectedCluster.hybridScore != null ? Math.round(selectedCluster.hybridScore) : '—'}
                          </div>
                          <div className="text-[9px] text-neutral-500 uppercase tracking-wider mt-0.5">Hybrid</div>
                        </div>
                        <div className="flex-1 text-center p-3 bg-white/[0.02] rounded-lg border border-white/5">
                          <div className={cn('text-[11px] font-bold capitalize mt-1', getStatusConfig(selectedCluster.status).textClass)}>
                            {getStatusConfig(selectedCluster.status).label}
                          </div>
                          <div className="text-[9px] text-neutral-500 uppercase tracking-wider mt-0.5">Status</div>
                        </div>
                      </div>

                      {(selectedCluster.geoCentroidLat != null || selectedCluster.latitude != null) && (
                        <div className="text-[11px] text-neutral-400 flex items-center justify-between p-2.5 bg-white/[0.02] rounded-lg border border-white/5 mb-4">
                          <span className="text-neutral-500 font-semibold uppercase text-[10px]">Centroid</span>
                          <span className="font-mono text-neutral-300">
                            {Number(selectedCluster.geoCentroidLat ?? selectedCluster.latitude).toFixed(4)}, {Number(selectedCluster.geoCentroidLng ?? selectedCluster.longitude).toFixed(4)}
                          </span>
                        </div>
                      )}

                      <Separator className="mb-4" />

                      <div className="mb-4">
                        <span className="text-[11px] uppercase font-bold text-neutral-500 tracking-wider block mb-2.5">
                          Reports ({selectedCluster.complaints.length})
                        </span>
                        <div className="max-h-36 overflow-y-auto space-y-2 pr-1">
                          {selectedCluster.complaints.map((c: ComplaintItem) => (
                            <div key={c.id} className="p-3 bg-white/[0.02] border border-white/5 rounded-lg">
                              <div className="flex items-center justify-between mb-1 text-[10px]">
                                <span className="font-mono font-bold text-indigo-400">{c.id}</span>
                                <span className="text-neutral-600">{new Date(c.created_at).toLocaleDateString()}</span>
                              </div>
                              <p className="text-[11px] text-neutral-300 leading-normal line-clamp-2">&ldquo;{c.text}&rdquo;</p>
                              <div className="flex items-center justify-between mt-1.5 pt-1.5 border-t border-white/5 text-[9px] text-neutral-500">
                                <span className="capitalize">{c.status}</span>
                                {c.source_name && (
                                  <Badge variant="outline" className="text-[9px] px-1.5 py-0.5">
                                    {getSourceLabel(c.source_name)}
                                  </Badge>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>

                      <Separator className="mb-4" />

                      <div className="mb-4">
                        <div className="flex items-center gap-2 mb-2.5">
                          <span className="text-[11px] uppercase font-bold text-neutral-500 tracking-wider">AI Action Plan</span>
                          {!!selectedCluster.latestAction && (
                            <Badge variant={selectedCluster.latestAction.generatedBy === 'gemini' ? 'info' : 'warning'} className="text-[9px]">
                              {selectedCluster.latestAction.generatedBy === 'gemini' ? 'Gemini AI' : 'Rules'}
                            </Badge>
                          )}
                        </div>
                        {selectedCluster.latestAction ? (
                          <div className="p-3.5 bg-indigo-500/5 border border-indigo-500/10 rounded-lg">
                            <div className="flex items-start gap-2">
                              {selectedCluster.latestAction.generatedBy === 'gemini' ? (
                                <Bot className="w-3.5 h-3.5 text-indigo-400 mt-0.5 shrink-0" />
                              ) : (
                                <Zap className="w-3.5 h-3.5 text-amber-400 mt-0.5 shrink-0" />
                              )}
                              <p className="text-[11px] text-indigo-200/80 leading-relaxed italic flex-1">
                                &ldquo;{selectedCluster.latestAction.text}&rdquo;
                              </p>
                            </div>
                            <div className="text-[9px] text-neutral-600 font-mono mt-2 pt-2 border-t border-indigo-500/10 flex justify-between items-center">
                              <span>{selectedCluster.latestAction.generatedAt ? new Date(selectedCluster.latestAction.generatedAt).toLocaleString() : 'Just now'}</span>
                            </div>
                            
                            {selectedCluster.latestAction.retrievedContext && (
                              <div className="mt-3 pt-3 border-t border-indigo-500/10">
                                <Collapsible open={showReasoning} onOpenChange={setShowReasoning}>
                                <CollapsibleTrigger asChild>
                                  <button className="text-[10px] uppercase font-bold text-indigo-400/80 tracking-wider cursor-pointer flex items-center gap-1.5 select-none hover:text-indigo-300 transition-colors">
                                    <ChevronRight className={cn('w-3 h-3 transition-transform', showReasoning && 'rotate-90')} />
                                    Why this recommendation?
                                    {selectedCluster.latestAction.confidenceScore !== undefined && (
                                      <Badge className={cn(
                                        'ml-auto text-[8px] px-1.5 py-0.5',
                                        selectedCluster.latestAction.confidenceScore >= 75 ? 'success' :
                                        selectedCluster.latestAction.confidenceScore >= 50 ? 'warning' : 'destructive'
                                      )}>
                                        {selectedCluster.latestAction.confidenceScore >= 75 ? 'High Confidence' :
                                         selectedCluster.latestAction.confidenceScore >= 50 ? 'Medium Confidence' : 'Low Confidence'}
                                      </Badge>
                                    )}
                                  </button>
                                </CollapsibleTrigger>
                                <CollapsibleContent className="mt-2.5">
                                  <div className="space-y-3 pl-4 border-l border-indigo-500/10">
                                    {selectedCluster.latestAction.retrievedContext.coldStart && (
                                      <p className="text-[10px] text-neutral-400 italic">No similar past cases yet — this is a novel issue type. Relying entirely on internal guidelines.</p>
                                    )}
                                    
                                    {(selectedCluster.latestAction.retrievedContext.pastCases?.length ?? 0) > 0 && (
                                      <div>
                                        <h4 className="text-[9px] text-neutral-500 font-bold uppercase tracking-wider mb-1">Similar Past Cases</h4>
                                        <ul className="space-y-1.5">
                                          {selectedCluster.latestAction.retrievedContext.pastCases?.map((c, i) => (
                                            <li key={i} className="text-[10px] text-neutral-300 leading-snug">
                                              <span className="font-semibold text-indigo-300">[{c.category}] {c.title}</span><br />
                                              <span className="text-neutral-500">Action: {c.action_text}</span>
                                            </li>
                                          ))}
                                        </ul>
                                      </div>
                                    )}
                                    
                                    {(selectedCluster.latestAction.retrievedContext.guidelines?.length ?? 0) > 0 && (
                                      <div>
                                        <h4 className="text-[9px] text-neutral-500 font-bold uppercase tracking-wider mb-1">Relevant Guidelines</h4>
                                        <ul className="space-y-1.5">
                                          {selectedCluster.latestAction.retrievedContext.guidelines?.map((g, i) => (
                                            <li key={i} className="text-[10px] text-neutral-300 leading-snug">
                                              <span className="font-semibold text-amber-400/80">[{g.source}] {g.title}</span><br />
                                              <span className="text-neutral-400 italic">&quot;{g.content}&quot;</span>
                                            </li>
                                          ))}
                                        </ul>
                                      </div>
                                    )}
                                  </div>
                                </CollapsibleContent>
                              </Collapsible>
                              </div>
                            )}
                          </div>
                        ) : selectedCluster.recommendedAction ? (
                          <div className="space-y-3">
                            {(() => {
                              const raw = selectedCluster.recommendedAction || '';
                              const confidenceScore = confidenceOf(selectedCluster);
                              let parsed: RecommendationJson | null = null;
                              try {
                                parsed = JSON.parse(raw);
                              } catch {
                                // Not JSON
                              }

                              if (parsed && typeof parsed === 'object') {
                                return (
                                  <>
                                    <div className="p-3.5 bg-indigo-500/5 border border-indigo-500/10 rounded-lg">
                                      <p className="text-[11px] text-indigo-200/80 leading-relaxed italic mb-2">&ldquo;{parsed.executive_summary}&rdquo;</p>
                                      
                                      <div className="grid grid-cols-2 gap-3 mt-3">
                                        {parsed.root_cause_analysis && (
                                          <div>
                                            <h4 className="text-[9px] text-indigo-400 font-bold uppercase tracking-wider mb-1">Root Cause</h4>
                                            <p className="text-[10px] text-indigo-200/60 leading-tight">{parsed.root_cause_analysis}</p>
                                          </div>
                                        )}
                                        {parsed.budget_estimate && (
                                          <div>
                                            <h4 className="text-[9px] text-indigo-400 font-bold uppercase tracking-wider mb-1">Est. Budget</h4>
                                            <p className="text-[10px] text-indigo-200/60 leading-tight">{parsed.budget_estimate}</p>
                                          </div>
                                        )}
                                        {parsed.short_term_actions && parsed.short_term_actions.length > 0 && (
                                          <div>
                                            <h4 className="text-[9px] text-indigo-400 font-bold uppercase tracking-wider mb-1">Short Term</h4>
                                            <ul className="list-disc pl-3 space-y-1">
                                              {parsed.short_term_actions.map((a: string, i: number) => (
                                                <li key={i} className="text-[10px] text-indigo-200/60 leading-tight">{a}</li>
                                              ))}
                                            </ul>
                                          </div>
                                        )}
                                        {parsed.long_term_actions && parsed.long_term_actions.length > 0 && (
                                          <div>
                                            <h4 className="text-[9px] text-indigo-400 font-bold uppercase tracking-wider mb-1">Long Term</h4>
                                            <ul className="list-disc pl-3 space-y-1">
                                              {parsed.long_term_actions.map((a: string, i: number) => (
                                                <li key={i} className="text-[10px] text-indigo-200/60 leading-tight">{a}</li>
                                              ))}
                                            </ul>
                                          </div>
                                        )}
                                      </div>
                                    </div>
                                    {confidenceScore && (
                                      <div className="flex items-center gap-1.5 justify-end">
                                        <span className="text-[9px] uppercase font-bold text-neutral-500 tracking-wider">AI Confidence</span>
                                        <Badge variant={confidenceScore > 70 ? 'success' : 'warning'} className="text-[9px] px-1 py-0 h-4">
                                          {confidenceScore}%
                                        </Badge>
                                      </div>
                                    )}
                                  </>
                                );
                              }

                              return (
                                <div className="p-3.5 bg-indigo-500/5 border border-indigo-500/10 rounded-lg">
                                  <p className="text-[11px] text-indigo-200/80 leading-relaxed italic">&ldquo;{raw}&rdquo;</p>
                                  {confidenceScore && (
                                    <div className="flex items-center gap-1.5 justify-end mt-2">
                                      <span className="text-[9px] uppercase font-bold text-neutral-500 tracking-wider">AI Confidence</span>
                                      <Badge variant={confidenceScore > 70 ? 'success' : 'warning'} className="text-[9px] px-1 py-0 h-4">
                                        {confidenceScore}%
                                      </Badge>
                                    </div>
                                  )}
                                </div>
                              );
                            })()}
                          </div>
                        ) : (
                          <div className="p-3.5 bg-white/[0.02] border border-white/5 rounded-lg flex items-center gap-3">
                            <Loader2 className="w-4 h-4 text-indigo-400 animate-spin shrink-0" />
                            <p className="text-[11px] text-neutral-400">Generating recommendation...</p>
                          </div>
                        )}
                      </div>

                      {isOfficial ? (
                        <div>
                          <Separator className="mb-4" />
                          <span className="text-[11px] uppercase font-bold text-neutral-500 tracking-wider block mb-3">Actions</span>
                          {(() => {
                            const currentStatus = selectedCluster.status as ClusterStatus;
                            const legalNextStatuses = ALLOWED_TRANSITIONS[currentStatus] || [];
                            if (legalNextStatuses.length === 0) return (
                              <div className="p-3 bg-white/[0.02] border border-white/5 rounded-lg text-center text-neutral-600 text-[11px]">
                                No transitions available from &ldquo;{getStatusDisplay(currentStatus)}&rdquo;.
                              </div>
                            );
                            return (
                              <div className="space-y-2">
                                {legalNextStatuses.map((nextStatus) => (
                                  <div key={nextStatus}>
                                    {showNoteInput === nextStatus ? (
                                      <div className="p-3 bg-white/[0.02] border border-white/5 rounded-lg space-y-2">
                                        <div className="text-[10px] text-neutral-400 font-semibold flex items-center gap-1.5">
                                          <ArrowRight className="w-3 h-3" />
                                          Moving to <span className="text-white">{getTransitionLabel(nextStatus)}</span>
                                        </div>
                                        <textarea
                                          value={noteInput}
                                          onChange={(e) => setNoteInput(e.target.value)}
                                          placeholder="Optional note (e.g. &quot;Dispatched repair crew&quot;)..."
                                          rows={2}
                                          className="w-full bg-white/[0.03] border border-white/5 rounded-lg text-xs text-neutral-200 placeholder-neutral-600 p-2 focus:outline-none focus:border-indigo-500/30 resize-none"
                                        />
                                        <div className="flex gap-2">
                                          <Button
                                            onClick={() => handlePatchStatus(nextStatus, noteInput || undefined)}
                                            size="sm"
                                            className={cn('flex-1', getTransitionColor(nextStatus).replace('bg-', 'bg-').replace('hover:bg-', 'hover:bg-'))}
                                          >
                                            Confirm
                                          </Button>
                                          <Button
                                            variant="secondary"
                                            size="sm"
                                            onClick={() => { setShowNoteInput(null); setNoteInput(''); }}
                                          >
                                            Cancel
                                          </Button>
                                        </div>
                                      </div>
                                    ) : (
                                      <Button
                                        onClick={() => setShowNoteInput(nextStatus)}
                                        size="sm"
                                        className={cn('w-full justify-center text-xs', getTransitionColor(nextStatus))}
                                      >
                                        <MessageSquare className="w-3.5 h-3.5" />
                                        {nextStatus === 'open' ? 'Reopen' : `Mark ${getTransitionLabel(nextStatus)}`}
                                      </Button>
                                    )}
                                  </div>
                                ))}
                                <div className="text-[9px] text-neutral-600 text-center pt-1">Action is logged with your account</div>
                              </div>
                            );
                          })()}
                        </div>
                      ) : (
                        <div>
                          <Separator className="mb-4" />
                          <div className="p-3 bg-white/[0.02] border border-white/5 rounded-lg text-center text-neutral-500 text-[11px]">
                            {userRole === 'citizen' ? 'Citizen accounts are read-only. Use the History tab to view actions.' : 'Sign in with NGO/Govt/Admin to manage.'}
                          </div>
                        </div>
                      )}
                    </TabsContent>

                    <TabsContent value="history">
                      {historyLoading ? (
                        <div className="flex items-center justify-center py-10 text-neutral-500">
                          <Loader2 className="w-5 h-5 animate-spin mr-2 text-indigo-400" />
                          <span className="text-xs">Loading audit trail...</span>
                        </div>
                      ) : clusterHistory.length === 0 ? (
                        <div className="text-center py-10">
                          <Clock className="w-8 h-8 text-neutral-700 mx-auto mb-3" />
                          <p className="text-sm text-neutral-500">No status changes recorded yet.</p>
                          <p className="text-xs text-neutral-600 mt-1">History appears here after the first official action.</p>
                        </div>
                      ) : (
                        <div className="space-y-3">
                          <div className="text-[10px] text-neutral-600 uppercase tracking-wider font-bold mb-4 flex items-center gap-2">
                            <History className="w-3.5 h-3.5" />
                            {clusterHistory.length} event{clusterHistory.length !== 1 ? 's' : ''} \u2014 newest first
                          </div>
                          {clusterHistory.map((entry, idx) => (
                            <div key={entry.id} className={cn('relative pl-6', idx < clusterHistory.length - 1 && 'pb-4')}>
                              {idx < clusterHistory.length - 1 && (
                                <div className="absolute left-2 top-4 bottom-0 w-px bg-white/5" />
                              )}
                              <div className={cn(
                                'absolute left-0 top-1 w-4 h-4 rounded-full border-2 flex items-center justify-center',
                                entry.newStatus === 'resolved' ? 'border-green-500 bg-green-500/20' :
                                entry.newStatus === 'escalated' ? 'border-red-500 bg-red-500/20' :
                                entry.newStatus === 'in_progress' ? 'border-indigo-500 bg-indigo-500/20' :
                                'border-amber-500 bg-amber-500/20'
                              )}>
                                <div className={cn(
                                  'w-1.5 h-1.5 rounded-full',
                                  entry.newStatus === 'resolved' ? 'bg-green-400' :
                                  entry.newStatus === 'escalated' ? 'bg-red-400' :
                                  entry.newStatus === 'in_progress' ? 'bg-indigo-400' :
                                  'bg-amber-400'
                                )} />
                              </div>
                              <div className="bg-white/[0.02] border border-white/5 rounded-lg p-3">
                                <div className="flex items-center gap-1.5 mb-2">
                                  <Badge variant={statusVariant(entry.previousStatus)} className="text-[9px]">
                                    {getStatusDisplay(entry.previousStatus)}
                                  </Badge>
                                  <ArrowRight className="w-3 h-3 text-neutral-600" />
                                  <Badge variant={statusVariant(entry.newStatus)} className="text-[9px]">
                                    {getStatusDisplay(entry.newStatus)}
                                  </Badge>
                                </div>
                                <div className="flex items-center gap-1.5 mb-2">
                                  <div className="w-5 h-5 rounded-full bg-indigo-500/20 border border-indigo-500/30 flex items-center justify-center text-[9px] font-bold text-indigo-400">
                                    {entry.admin.name.charAt(0).toUpperCase()}
                                  </div>
                                  <span className="text-[11px] text-neutral-300 font-semibold">{entry.admin.name}</span>
                                  <Badge variant={entry.admin.role === 'admin' ? 'destructive' : entry.admin.role === 'govt' ? 'warning' : 'info'} className="text-[9px]">
                                    {entry.admin.role}
                                  </Badge>
                                </div>
                                {entry.note && (
                                  <div className="flex items-start gap-1.5 p-2 bg-white/[0.02] rounded-lg mb-2">
                                    <MessageSquare className="w-3 h-3 text-neutral-500 shrink-0 mt-0.5" />
                                    <p className="text-[10px] text-neutral-400 italic leading-relaxed">&ldquo;{entry.note}&rdquo;</p>
                                  </div>
                                )}
                                <div className="text-[9px] text-neutral-600 font-mono flex items-center gap-1">
                                  <Clock className="w-2.5 h-2.5" />
                                  {new Date(entry.loggedAt).toLocaleString()}
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </TabsContent>
                  </Tabs>
                </CardContent>
              </Card>
            </div>
          ) : (
            <>
              <Collapsible open={filterToolsOpen} onOpenChange={setFilterToolsOpen} className="lg:hidden">
              <CollapsibleTrigger asChild>
                <button className="flex w-full items-center gap-2 p-4 rounded-lg bg-white/[0.03] border border-white/5 text-xs font-bold text-neutral-300 cursor-pointer select-none">
                  <Filter className="w-4 h-4 text-indigo-400" />
                  Filters & Tools
                </button>
              </CollapsibleTrigger>
              <CollapsibleContent className="border border-white/5 border-t-0 rounded-b-lg p-4 space-y-3">
                {renderSidebarContent()}
              </CollapsibleContent>
            </Collapsible>

              <div className="hidden lg:block space-y-4 lg:sticky lg:top-20">
                {renderSidebarContent()}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );

  function renderSidebarContent() {
    return (
      <>
        <Card>
          <CardContent className="p-4 space-y-3">
            <div className="relative">
              <Search className="absolute left-3 top-2.5 w-4 h-4 text-neutral-500" />
              <Input
                placeholder="Search issues..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9"
              />
            </div>
            <Select value={filterCategory} onValueChange={setFilterCategory}>
              <SelectTrigger>
                <SelectValue placeholder="All Categories" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Categories</SelectItem>
                <SelectItem value="infrastructure">Infrastructure</SelectItem>
                <SelectItem value="sanitation">Sanitation</SelectItem>
                <SelectItem value="utility">Utility</SelectItem>
                <SelectItem value="noise">Noise</SelectItem>
                <SelectItem value="safety">Safety</SelectItem>
                <SelectItem value="other">Other</SelectItem>
              </SelectContent>
            </Select>
            <Select value={filterRegion} onValueChange={setFilterRegion}>
              <SelectTrigger>
                <SelectValue placeholder="All Regions" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Regions</SelectItem>
                <SelectItem value="Downtown">Downtown</SelectItem>
                <SelectItem value="North">North</SelectItem>
                <SelectItem value="South">South</SelectItem>
                <SelectItem value="East">East</SelectItem>
                <SelectItem value="West">West</SelectItem>
              </SelectContent>
            </Select>
            <Select value={filterStatus} onValueChange={setFilterStatus}>
              <SelectTrigger>
                <SelectValue placeholder="All Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Status</SelectItem>
                <SelectItem value="open">Open</SelectItem>
                <SelectItem value="in_progress">In Progress</SelectItem>
                <SelectItem value="escalated">Needs Attention</SelectItem>
                <SelectItem value="resolved">Resolved</SelectItem>
              </SelectContent>
            </Select>
            <div className="flex bg-white/[0.03] p-0.5 rounded-lg border border-white/5">
              <Button
                variant={viewMode === 'table' ? 'secondary' : 'ghost'}
                size="sm"
                className="flex-1 text-xs"
                onClick={() => setViewMode('table')}
              >
                <List className="w-3.5 h-3.5" /> List
              </Button>
              <Button
                variant={viewMode === 'map' ? 'secondary' : 'ghost'}
                size="sm"
                className="flex-1 text-xs"
                onClick={() => setViewMode('map')}
              >
                <Map className="w-3.5 h-3.5" /> Map
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-3">
              <BarChart3 className="w-4 h-4 text-indigo-400" />
              <span className="text-[11px] font-bold text-neutral-300 uppercase tracking-wider">By Category</span>
            </div>
            {chartData.length > 0 ? (
              <ResponsiveContainer width="100%" height={160}>
                <BarChart data={chartData} margin={{ top: 0, right: 0, bottom: 0, left: -20 }}>
                  <XAxis dataKey="name" tick={{ fontSize: 10, fill: '#737373' }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 10, fill: '#737373' }} axisLine={false} tickLine={false} />
                  <Tooltip
                    contentStyle={{ background: '#18181b', border: '1px solid #27272a', borderRadius: 10, fontSize: 12 }}
                    cursor={{ fill: 'rgba(255,255,255,0.02)' }}
                  />
                  <Bar dataKey="count" radius={[6, 6, 0, 0]} maxBarSize={40}>
                    {chartData.map((_, idx) => (
                      <Cell key={idx} fill={chartColors[idx % chartColors.length]} fillOpacity={0.8} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-[160px] flex items-center justify-center text-neutral-600 text-xs">No data</div>
            )}
          </CardContent>
        </Card>

        {canViewIngestion && (
          <IngestionHistoryPanel />
        )}
      </>
    );
  }
}
