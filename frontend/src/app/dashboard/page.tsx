'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { useAuth } from '../../context/AuthContext';
import { apiClient } from '../../lib/api';
import { 
  TrendingUp, CheckCircle2, AlertOctagon, Landmark, 
  Map, List, Search, ArrowUpDown, FileText, Calendar, 
  User, RefreshCw, AlertTriangle, Loader2, Bot, Zap
} from 'lucide-react';

export default function DashboardPage() {
  const { userRole } = useAuth();

  // Filters & Layout states
  const [viewMode, setViewMode] = useState<'table' | 'map'>('table');
  const [searchQuery, setSearchQuery] = useState('');
  const [filterCategory, setFilterCategory] = useState<string>('all');
  const [filterRegion, setFilterRegion] = useState<string>('all');
  const [filterStatus, setFilterStatus] = useState<string>('all');
  const [selectedClusterId, setSelectedClusterId] = useState<string | null>(null);
  
  // Sort states — default is priority (staleness-aware ranking from backend)
  const [sortBy, setSortBy] = useState<'priority' | 'severity' | 'count'>('priority');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');

  // API Data states
  const [clusters, setClusters] = useState<any[]>([]);
  const [globalStats, setGlobalStats] = useState({ totalOpen: 0, totalResolved: 0, avgSeverity: 0, topRegion: 'N/A' });
  const [isLoading, setIsLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  // Coordinates projection bounding box (Bangalore limits mapped to 500x400 SVG box)
  const MAP_BOUNDS = {
    minLat: 12.9400,
    maxLat: 12.9900,
    minLng: 77.5600,
    maxLng: 77.6400
  };

  // Convert GPS Coordinates to SVG X/Y
  const getCoordinates = (lat: number, lng: number) => {
    const x = ((lng - MAP_BOUNDS.minLng) / (MAP_BOUNDS.maxLng - MAP_BOUNDS.minLng)) * 500;
    const y = 400 - ((lat - MAP_BOUNDS.minLat) / (MAP_BOUNDS.maxLat - MAP_BOUNDS.minLat)) * 400;
    return { x, y };
  };

  // Fetch Global Database-wide Stats
  const loadGlobalStats = async () => {
    try {
      const res = await apiClient.getClusters();
      const allCls = res.data;
      
      let openCount = 0;
      let resolvedCount = 0;
      let severitySum = 0;
      let activeClCount = 0;
      const regionCounts: { [key: string]: number } = {};

      allCls.forEach((c) => {
        if (c.status !== 'resolved') {
          openCount += c.complaintCount;
          severitySum += c.severity;
          activeClCount++;
        }
        resolvedCount += c.complaints.filter((comp: any) => comp.status === 'resolved').length;
        regionCounts[c.region] = (regionCounts[c.region] || 0) + c.complaintCount;
      });

      const avgSeverity = activeClCount > 0 ? Math.round(severitySum / activeClCount) : 0;
      
      let topRegion = 'N/A';
      let maxCount = 0;
      Object.entries(regionCounts).forEach(([region, count]) => {
        if (count > maxCount) {
          maxCount = count;
          topRegion = region;
        }
      });

      setGlobalStats({
        totalOpen: openCount,
        totalResolved: resolvedCount,
        avgSeverity,
        topRegion,
      });
    } catch (err) {
      console.error('Failed to load global stats:', err);
    }
  };

  // Fetch Filtered Clusters List
  const fetchFilteredClusters = async () => {
    setIsLoading(true);
    setErrorMsg('');
    try {
      const res = await apiClient.getClusters({
        category: filterCategory,
        region: filterRegion,
        status: filterStatus,
        search: searchQuery,
      });
      setClusters(res.data);
      
      // Auto-select first cluster if none selected or if previously selected is missing
      if (res.data.length > 0) {
        const stillExists = res.data.some((c) => c.id === selectedClusterId);
        if (!stillExists) {
          setSelectedClusterId(res.data[0].id);
        }
      } else {
        setSelectedClusterId(null);
      }
    } catch (err) {
      console.error(err);
      setErrorMsg('Failed to sync clusters. Please verify connection to the Express backend.');
    } finally {
      setIsLoading(false);
    }
  };

  // Trigger search query and filters reload
  useEffect(() => {
    const delayDebounceFn = setTimeout(() => {
      fetchFilteredClusters();
      loadGlobalStats();
    }, 300);

    return () => clearTimeout(delayDebounceFn);
  }, [filterCategory, filterRegion, filterStatus, searchQuery]);

  // Update Status Action
  const handleUpdateStatus = async (newStatus: 'pending' | 'in_progress' | 'resolved') => {
    if (!selectedClusterId) return;
    try {
      await apiClient.updateClusterStatus(selectedClusterId, newStatus);
      
      // Instantly reflect update in local state for snappy UX
      setClusters(prev => prev.map(c => {
        if (c.id === selectedClusterId) {
          return { ...c, status: newStatus };
        }
        return c;
      }));

      // Reload global stats
      loadGlobalStats();
    } catch (err: any) {
      const msg = err?.message || 'Error updating cluster status.';
      // 401 is handled globally by api.ts (redirects to login)
      // 403 = show inline message, not alert
      if (err?.status === 403) {
        setErrorMsg('Permission denied. Only NGO/Govt/Admin accounts can update cluster status.');
      } else if (err?.status !== 401) {
        setErrorMsg(msg);
      }
    }
  };

  // Toggle sort fields
  const handleSort = (field: 'priority' | 'severity' | 'count') => {
    if (sortBy === field) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      setSortBy(field);
      setSortOrder('desc');
    }
  };

  // Sort and filter clusters list
  const sortedClusters = useMemo(() => {
    return [...clusters].sort((a, b) => {
      const valA = sortBy === 'priority'
        ? (a.priorityScore ?? a.severity)
        : sortBy === 'severity'
        ? a.severity
        : a.complaintCount;
      const valB = sortBy === 'priority'
        ? (b.priorityScore ?? b.severity)
        : sortBy === 'severity'
        ? b.severity
        : b.complaintCount;
      return sortOrder === 'asc' ? valA - valB : valB - valA;
    });
  }, [clusters, sortBy, sortOrder]);

  // Selected cluster references
  const selectedCluster = useMemo(() => {
    return clusters.find((c) => c.id === selectedClusterId) || null;
  }, [clusters, selectedClusterId]);

  // Color badges for severity
  const getSeverityBadgeClass = (score: number) => {
    if (score >= 75) return 'bg-rose-500/10 text-rose-400 border-rose-500/20';
    if (score >= 40) return 'bg-amber-500/10 text-amber-400 border-amber-500/20';
    return 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20';
  };

  // Color badges for priority — uses a violet/orange palette to distinguish from severity
  const getPriorityBadgeClass = (score: number) => {
    if (score >= 70) return 'bg-violet-500/15 text-violet-300 border-violet-500/25';
    if (score >= 35) return 'bg-orange-500/15 text-orange-300 border-orange-500/25';
    return 'bg-sky-500/10 text-sky-400 border-sky-500/20';
  };

  return (
    <div className="flex-1 flex flex-col px-6 py-8 gap-8 max-w-7xl mx-auto w-full">
      {/* Stats Strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="glass-panel p-5 rounded-2xl border-neutral-800 flex items-center gap-4">
          <div className="w-12 h-12 bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 rounded-xl flex items-center justify-center">
            <TrendingUp className="w-5 h-5" />
          </div>
          <div>
            <span className="text-[10px] text-neutral-500 font-bold uppercase tracking-wider block">Open Issues</span>
            <span className="text-2xl font-extrabold text-white">{globalStats.totalOpen}</span>
          </div>
        </div>

        <div className="glass-panel p-5 rounded-2xl border-neutral-800 flex items-center gap-4">
          <div className="w-12 h-12 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 rounded-xl flex items-center justify-center">
            <CheckCircle2 className="w-5 h-5" />
          </div>
          <div>
            <span className="text-[10px] text-neutral-500 font-bold uppercase tracking-wider block">Resolved Reports</span>
            <span className="text-2xl font-extrabold text-white">{globalStats.totalResolved}</span>
          </div>
        </div>

        <div className="glass-panel p-5 rounded-2xl border-neutral-800 flex items-center gap-4">
          <div className="w-12 h-12 bg-rose-500/10 border border-rose-500/20 text-rose-400 rounded-xl flex items-center justify-center">
            <AlertOctagon className="w-5 h-5" />
          </div>
          <div>
            <span className="text-[10px] text-neutral-500 font-bold uppercase tracking-wider block">Avg Severity</span>
            <span className="text-2xl font-extrabold text-white">{globalStats.avgSeverity}<span className="text-xs font-normal text-neutral-500">/100</span></span>
          </div>
        </div>

        <div className="glass-panel p-5 rounded-2xl border-neutral-800 flex items-center gap-4">
          <div className="w-12 h-12 bg-amber-500/10 border border-amber-500/20 text-amber-400 rounded-xl flex items-center justify-center">
            <Landmark className="w-5 h-5" />
          </div>
          <div>
            <span className="text-[10px] text-neutral-500 font-bold uppercase tracking-wider block">Top Region</span>
            <span className="text-2xl font-extrabold text-white">{globalStats.topRegion}</span>
          </div>
        </div>
      </div>

      {/* Filter and Control Bar */}
      <div className="glass-panel p-5 rounded-2xl border-neutral-800 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-3 flex-1">
          {/* Search box */}
          <div className="relative w-full md:w-64">
            <Search className="absolute left-3 top-2.5 w-4 h-4 text-neutral-500" />
            <input
              type="text"
              placeholder="Search clusters..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-9 pr-3 py-2 bg-neutral-950 border border-neutral-800 rounded-xl text-xs text-white placeholder-neutral-500 focus:outline-none"
            />
          </div>

          {/* Category Filter */}
          <select
            value={filterCategory}
            onChange={(e) => setFilterCategory(e.target.value)}
            className="px-3 py-2 bg-neutral-950 border border-neutral-800 rounded-xl text-xs text-neutral-300 focus:outline-none"
          >
            <option value="all">All Categories</option>
            <option value="infrastructure">Infrastructure</option>
            <option value="sanitation">Sanitation</option>
            <option value="utility">Utility</option>
            <option value="noise">Noise</option>
            <option value="safety">Safety</option>
            <option value="other">Other</option>
          </select>

          {/* Region Filter */}
          <select
            value={filterRegion}
            onChange={(e) => setFilterRegion(e.target.value)}
            className="px-3 py-2 bg-neutral-950 border border-neutral-800 rounded-xl text-xs text-neutral-300 focus:outline-none"
          >
            <option value="all">All Regions</option>
            <option value="Downtown">Downtown</option>
            <option value="North">North</option>
            <option value="South">South</option>
            <option value="East">East</option>
            <option value="West">West</option>
          </select>

          {/* Status Filter */}
          <select
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value)}
            className="px-3 py-2 bg-neutral-950 border border-neutral-800 rounded-xl text-xs text-neutral-300 focus:outline-none"
          >
            <option value="all">All Statuses</option>
            <option value="pending">Pending</option>
            <option value="in_progress">In Progress</option>
            <option value="resolved">Resolved</option>
          </select>
        </div>

        {/* View Mode Toggle */}
        <div className="flex bg-neutral-950 p-1 rounded-xl border border-neutral-800 select-none">
          <button
            onClick={() => setViewMode('table')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer transition-all ${
              viewMode === 'table' ? 'bg-neutral-850 text-white' : 'text-neutral-400'
            }`}
          >
            <List className="w-3.5 h-3.5" />
            <span>Table View</span>
          </button>
          <button
            onClick={() => setViewMode('map')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer transition-all ${
              viewMode === 'map' ? 'bg-neutral-850 text-white' : 'text-neutral-400'
            }`}
          >
            <Map className="w-3.5 h-3.5" />
            <span>Interactive Map</span>
          </button>
        </div>
      </div>

      {errorMsg && (
        <div className="p-4 bg-rose-500/10 border border-rose-500/20 rounded-xl text-sm text-rose-400 flex gap-2 items-center">
          <AlertTriangle className="w-5 h-5 shrink-0" />
          <span>{errorMsg}</span>
        </div>
      )}

      {/* Main Grid: Data View vs Detail Sidepanel */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
        {/* Left Side: Table or Map */}
        <div className="lg:col-span-2 glass-panel rounded-2xl border-neutral-800 overflow-hidden min-h-[460px] flex flex-col justify-between">
          {isLoading ? (
            <div className="flex-1 flex items-center justify-center p-12 text-neutral-400">
              <RefreshCw className="w-8 h-8 animate-spin text-emerald-400 mr-2" />
              <span>Querying database clusters...</span>
            </div>
          ) : viewMode === 'table' ? (
            /* TABLE VIEW */
            <div className="overflow-x-auto w-full">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="border-b border-neutral-800/80 bg-neutral-900/30 text-neutral-400 font-semibold select-none">
                    <th className="p-4">Cluster Topic</th>
                    <th className="p-4">Category</th>
                    <th className="p-4">Region</th>
                    <th className="p-4 cursor-pointer hover:text-white" onClick={() => handleSort('priority')}>
                      <div className="flex items-center gap-1">
                        <span className={sortBy === 'priority' ? 'text-violet-400' : ''}>Priority</span>
                        <ArrowUpDown className="w-3 h-3" />
                      </div>
                    </th>
                    <th className="p-4 cursor-pointer hover:text-white" onClick={() => handleSort('severity')}>
                      <div className="flex items-center gap-1">
                        <span className={sortBy === 'severity' ? 'text-rose-400' : ''}>Severity</span>
                        <ArrowUpDown className="w-3 h-3" />
                      </div>
                    </th>
                    <th className="p-4 cursor-pointer hover:text-white" onClick={() => handleSort('count')}>
                      <div className="flex items-center gap-1">
                        <span>Reports</span>
                        <ArrowUpDown className="w-3 h-3" />
                      </div>
                    </th>
                    <th className="p-4">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedClusters.length > 0 ? (
                    sortedClusters.map((cluster) => (
                      <tr
                        key={cluster.id}
                        onClick={() => setSelectedClusterId(cluster.id)}
                        className={`border-b border-neutral-850 hover:bg-neutral-900/40 cursor-pointer transition-colors ${
                          selectedClusterId === cluster.id ? 'bg-neutral-900/60' : ''
                        }`}
                      >
                        <td className="p-4">
                          <div className="font-semibold text-white">{cluster.title}</div>
                          <div className="text-[10px] text-neutral-500 mt-0.5 font-mono">{cluster.id}</div>
                        </td>
                        <td className="p-4">
                          <span className="capitalize text-neutral-300">{cluster.category}</span>
                        </td>
                        <td className="p-4 text-neutral-400">{cluster.region}</td>
                        <td className="p-4">
                          <span className={`px-2 py-0.5 rounded border font-semibold text-[10px] ${getPriorityBadgeClass(cluster.priorityScore ?? cluster.severity)}`}>
                            {cluster.priorityScore ?? cluster.severity}
                          </span>
                        </td>
                        <td className="p-4">
                          <span className={`px-2 py-0.5 rounded border font-semibold text-[10px] ${getSeverityBadgeClass(cluster.severity)}`}>
                            {cluster.severity}
                          </span>
                        </td>
                        <td className="p-4 text-neutral-300 font-bold">{cluster.complaintCount}</td>
                        <td className="p-4">
                          <div className="flex items-center gap-1.5">
                            <span className={`w-1.5 h-1.5 rounded-full ${
                              cluster.status === 'resolved' ? 'bg-emerald-500' :
                              cluster.status === 'in_progress' ? 'bg-indigo-400' : 'bg-amber-400'
                            }`} />
                            <span className="capitalize text-neutral-400 text-[11px]">{cluster.status.replace(/_/g, ' ')}</span>
                          </div>
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={7} className="text-center p-8 text-neutral-500">
                        No active database clusters found matching filters.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          ) : (
            /* MAP VIEW */
            <div className="p-6 flex flex-col items-center gap-4 bg-neutral-950/40">
              <span className="text-[10px] uppercase font-bold text-neutral-500 tracking-wider">
                Metro City Area Map Projection (GPS coordinate points mapped dynamically)
              </span>
              
              <div className="relative w-full max-w-[500px] border border-neutral-800/80 rounded-2xl overflow-hidden bg-neutral-950 p-2">
                <svg viewBox="0 0 500 400" className="w-full h-auto">
                  {/* City Zones Polygons */}
                  <g className="fill-neutral-900 stroke-neutral-800/50 stroke-2">
                    <polygon points="0,0 500,0 500,100 0,160" className="hover:fill-neutral-925/40 transition-colors" />
                    <polygon points="0,160 200,200 150,400 0,400" className="hover:fill-neutral-925/40 transition-colors" />
                    <polygon points="500,100 500,320 300,250 200,200" className="hover:fill-neutral-925/40 transition-colors" />
                    <polygon points="150,400 300,250 500,320 500,400 150,400" className="hover:fill-neutral-925/40 transition-colors" />
                    <polygon points="0,160 200,200 300,250 150,400 0,160" className="fill-indigo-950/20 hover:fill-indigo-950/30 transition-colors" />
                  </g>

                  {/* Zone Labels */}
                  <g className="fill-neutral-600 text-[10px] uppercase font-bold tracking-widest pointer-events-none select-none">
                    <text x="220" y="45">North Area</text>
                    <text x="40" y="270">West</text>
                    <text x="410" y="220">East</text>
                    <text x="320" y="360">South Area</text>
                    <text x="130" y="220" className="fill-indigo-500/80 text-[11px]">Downtown</text>
                  </g>

                  {/* Dynamic Cluster Markers */}
                  {sortedClusters.map((cluster) => {
                    const { x, y } = getCoordinates(cluster.latitude, cluster.longitude);
                    const isSelected = selectedClusterId === cluster.id;
                    
                    let markerColor = 'fill-emerald-500';
                    if (cluster.severity >= 75) {
                      markerColor = 'fill-rose-500';
                    } else if (cluster.severity >= 40) {
                      markerColor = 'fill-amber-500';
                    }

                    return (
                      <g 
                        key={cluster.id} 
                        onClick={() => setSelectedClusterId(cluster.id)} 
                        className="cursor-pointer group"
                      >
                        {isSelected && (
                          <circle cx={x} cy={y} r="14" className="fill-none stroke-white/50 stroke-2 animate-pulse" />
                        )}
                        <circle cx={x} cy={y} r="18" className="fill-white/0 group-hover:fill-white/5 transition-all" />
                        <circle cx={x} cy={y} r="8" className={`${markerColor} opacity-30 group-hover:opacity-50`} />
                        <circle cx={x} cy={y} r="4.5" className={`${markerColor} stroke-black stroke-2`} />
                      </g>
                    );
                  })}
                </svg>
              </div>

              {/* Map Legend */}
              <div className="flex gap-6 text-[10px] text-neutral-400">
                <div className="flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-full bg-rose-500 border border-black" />
                  <span>High Severity (75-100)</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-full bg-amber-500 border border-black" />
                  <span>Medium Severity (40-74)</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 border border-black" />
                  <span>Low Severity (0-39)</span>
                </div>
              </div>
            </div>
          )}

          <div className="p-4 bg-neutral-900/10 border-t border-neutral-900/60 text-[10px] text-neutral-500 flex justify-between">
            <span>Showing {sortedClusters.length} database clusters</span>
            <span>Local SQL connection active</span>
          </div>
        </div>

        {/* Right Side: Cluster Detail Panel */}
        <div className="glass-panel p-6 rounded-2xl border-neutral-800 min-h-[460px]">
          {selectedCluster ? (
            <div className="space-y-6">
              {/* Heading */}
              <div>
                <div className="flex justify-between items-start mb-2">
                  <span className="text-[10px] font-bold text-neutral-500 uppercase tracking-widest">{selectedCluster.region} Area</span>
                  <div className="flex items-center gap-1.5">
                    <span className={`px-2 py-0.5 rounded text-[10px] font-mono border ${getPriorityBadgeClass(selectedCluster.priorityScore ?? selectedCluster.severity)}`}>
                      PRI: {selectedCluster.priorityScore ?? selectedCluster.severity}
                    </span>
                    <span className={`px-2 py-0.5 rounded text-[10px] font-mono border ${getSeverityBadgeClass(selectedCluster.severity)}`}>
                      SEV: {selectedCluster.severity}
                    </span>
                  </div>
                </div>
                <h2 className="text-lg font-bold text-white leading-tight">{selectedCluster.title}</h2>
                <div className="flex items-center gap-2 mt-2">
                  <span className="text-[10px] uppercase font-bold text-neutral-500 tracking-wider font-mono">{selectedCluster.id}</span>
                  <span className="text-neutral-600">•</span>
                  <span className="text-xs capitalize text-neutral-400">{selectedCluster.category}</span>
                </div>
                {/* Score explainer strip */}
                <div className="flex items-center gap-3 mt-3 p-2.5 bg-neutral-950/60 border border-neutral-800/60 rounded-xl">
                  <div className="flex-1 text-center">
                    <div className={`text-xl font-extrabold ${getPriorityBadgeClass(selectedCluster.priorityScore ?? selectedCluster.severity).includes('violet') ? 'text-violet-300' : getPriorityBadgeClass(selectedCluster.priorityScore ?? selectedCluster.severity).includes('orange') ? 'text-orange-300' : 'text-sky-400'}`}>
                      {selectedCluster.priorityScore ?? selectedCluster.severity}
                    </div>
                    <div className="text-[9px] text-neutral-500 uppercase tracking-wider mt-0.5">Priority</div>
                    <div className="text-[8px] text-neutral-600 mt-0.5">severity × urgency × cost</div>
                  </div>
                  <div className="w-px h-8 bg-neutral-800" />
                  <div className="flex-1 text-center">
                    <div className={`text-xl font-extrabold ${selectedCluster.severity >= 75 ? 'text-rose-400' : selectedCluster.severity >= 40 ? 'text-amber-400' : 'text-emerald-400'}`}>
                      {selectedCluster.severity}
                    </div>
                    <div className="text-[9px] text-neutral-500 uppercase tracking-wider mt-0.5">Severity</div>
                    <div className="text-[8px] text-neutral-600 mt-0.5">volume + growth + impact</div>
                  </div>
                </div>
              </div>

              <div className="h-px bg-neutral-850" />

              {/* Ingestion & complaints linked lists */}
              <div>
                <span className="text-[10px] uppercase font-bold text-neutral-500 tracking-wider block mb-2">
                  Linked Database Reports ({selectedCluster.complaints.length})
                </span>
                
                <div className="max-h-48 overflow-y-auto space-y-2.5 pr-1">
                  {selectedCluster.complaints.map((c: any) => (
                    <div key={c.id} className="p-3 bg-neutral-950 border border-neutral-900 rounded-xl">
                      <div className="flex items-center justify-between mb-1.5 text-[10px]">
                        <span className="font-mono font-bold text-indigo-400">{c.id}</span>
                        <div className="flex items-center gap-1">
                          <Calendar className="w-2.5 h-2.5 text-neutral-500" />
                          <span className="text-neutral-500">{new Date(c.created_at).toLocaleDateString()}</span>
                        </div>
                      </div>
                      <p className="text-xs text-neutral-300 leading-normal">"{c.text}"</p>
                      <div className="flex items-center justify-between mt-2 pt-2 border-t border-neutral-900/60 text-[9px] text-neutral-500">
                        <span className="capitalize">Status: {c.status}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="h-px bg-neutral-850" />

              {/* Recommended action panel */}
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-[10px] uppercase font-bold text-neutral-500 tracking-wider">
                    AI Action Plan Recommendation
                  </span>
                  {selectedCluster.latestAction && (
                    <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider border ${
                      selectedCluster.latestAction.generatedBy === 'gemini'
                        ? 'bg-indigo-500/10 text-indigo-400 border-indigo-500/20'
                        : 'bg-amber-500/10 text-amber-400 border-amber-500/20'
                    }`}>
                      {selectedCluster.latestAction.generatedBy === 'gemini' ? 'Gemini AI' : 'Rule-based'}
                    </span>
                  )}
                </div>

                {selectedCluster.latestAction ? (
                  <div className="p-3.5 bg-indigo-500/5 border border-indigo-500/10 rounded-xl space-y-2">
                    <div className="flex items-start gap-2">
                      {selectedCluster.latestAction.generatedBy === 'gemini' ? (
                        <Bot className="w-3.5 h-3.5 text-indigo-400 mt-0.5 shrink-0" />
                      ) : (
                        <Zap className="w-3.5 h-3.5 text-amber-400 mt-0.5 shrink-0" />
                      )}
                      <p className="text-xs text-indigo-200/90 leading-relaxed italic flex-1">
                        &quot;{selectedCluster.latestAction.text}&quot;
                      </p>
                    </div>
                    <div className="text-[9px] text-neutral-600 font-mono pt-1 border-t border-indigo-500/10">
                      Generated {new Date(selectedCluster.latestAction.generatedAt).toLocaleString()}
                    </div>
                  </div>
                ) : selectedCluster.recommendedAction ? (
                  // Backward compat: old static recommended_action column value
                  <div className="p-3.5 bg-indigo-500/5 border border-indigo-500/10 rounded-xl">
                    <p className="text-xs text-indigo-200/90 leading-relaxed italic">
                      &quot;{selectedCluster.recommendedAction}&quot;
                    </p>
                  </div>
                ) : (
                  // Pending state — generation in flight
                  <div className="p-3.5 bg-neutral-900/60 border border-neutral-800 rounded-xl flex items-center gap-3">
                    <Loader2 className="w-4 h-4 text-indigo-400 animate-spin shrink-0" />
                    <div>
                      <p className="text-xs text-neutral-400 font-medium">Generating AI recommendation…</p>
                      <p className="text-[10px] text-neutral-600 mt-0.5">This runs in the background and will appear shortly.</p>
                    </div>
                  </div>
                )}
              </div>

              {/* Operations Panel */}
              <div className="pt-2">
                <span className="text-[10px] uppercase font-bold text-neutral-500 tracking-wider block mb-2">
                  Platform Operations
                </span>
                
                {!userRole || userRole === 'citizen' ? (
                  <div className="p-3 bg-neutral-950 border border-neutral-900 text-center rounded-xl text-neutral-500 text-[10px]">
                    {userRole === 'citizen'
                      ? 'Citizen accounts are read-only. Contact your NGO or Government liaison to update status.'
                      : 'Sign in with an NGO, Government, or Admin account to update cluster status.'}
                  </div>
                ) : (
                  <div className="flex flex-col gap-2">
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        onClick={() => handleUpdateStatus('in_progress')}
                        disabled={selectedCluster.status === 'in_progress'}
                        className="px-4 py-2.5 bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-600/30 text-white font-semibold text-xs rounded-xl transition-all cursor-pointer disabled:cursor-not-allowed"
                      >
                        In Progress
                      </button>
                      <button
                        onClick={() => handleUpdateStatus('resolved')}
                        disabled={selectedCluster.status === 'resolved'}
                        className="px-4 py-2.5 bg-emerald-600 hover:bg-emerald-700 disabled:bg-emerald-600/30 text-white font-semibold text-xs rounded-xl transition-all cursor-pointer disabled:cursor-not-allowed"
                      >
                        Resolve Issue
                      </button>
                    </div>
                    <div className="text-[9px] text-neutral-500 text-center font-semibold pt-1 uppercase">
                      Actions will cascade to update matching database rows
                    </div>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="text-center py-20">
              <div className="w-12 h-12 bg-neutral-900 border border-neutral-850 text-neutral-600 rounded-full flex items-center justify-center mx-auto mb-4">
                <FileText className="w-5 h-5" />
              </div>
              <h3 className="text-sm font-bold text-neutral-400">No cluster selected</h3>
              <p className="text-[11px] text-neutral-500 mt-1 max-w-xs mx-auto">
                Select a cluster row or SVG node point on the map to review reports and trigger resolution cascades.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
