'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { useAuth } from '../../context/AuthContext';
import { apiClient } from '../../lib/api';
import {
  TrendingUp, CheckCircle2, AlertOctagon, Landmark,
  Map, List, Search, ArrowUpDown, FileText, Calendar,
  RefreshCw, AlertTriangle, Loader2, Bot, Zap, ChevronRight,
  X, Activity
} from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts';

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

  const [clusters, setClusters] = useState<any[]>([]);
  const [globalStats, setGlobalStats] = useState({ totalOpen: 0, totalResolved: 0, avgSeverity: 0, topRegion: 'N/A' });
  const [isLoading, setIsLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  const MAP_BOUNDS = { minLat: 12.9400, maxLat: 12.9900, minLng: 77.5600, maxLng: 77.6400 };
  const getCoordinates = (lat: number, lng: number) => {
    const x = ((lng - MAP_BOUNDS.minLng) / (MAP_BOUNDS.maxLng - MAP_BOUNDS.minLng)) * 500;
    const y = 400 - ((lat - MAP_BOUNDS.minLat) / (MAP_BOUNDS.maxLat - MAP_BOUNDS.minLat)) * 400;
    return { x, y };
  };

  const loadGlobalStats = async () => {
    try {
      const res = await apiClient.getClusters();
      const allCls = res.data;
      let openCount = 0, resolvedCount = 0, severitySum = 0, activeClCount = 0;
      const regionCounts: Record<string, number> = {};
      allCls.forEach((c: any) => {
        if (c.status !== 'resolved') { openCount += c.complaintCount; severitySum += c.severity; activeClCount++; }
        resolvedCount += c.complaints.filter((comp: any) => comp.status === 'resolved').length;
        regionCounts[c.region] = (regionCounts[c.region] || 0) + c.complaintCount;
      });
      const avgSeverity = activeClCount > 0 ? Math.round(severitySum / activeClCount) : 0;
      let topRegion = 'N/A', maxCount = 0;
      Object.entries(regionCounts).forEach(([region, count]) => { if (count > maxCount) { maxCount = count; topRegion = region; } });
      setGlobalStats({ totalOpen: openCount, totalResolved: resolvedCount, avgSeverity, topRegion });
    } catch (err) { console.error('Failed to load global stats:', err); }
  };

  const fetchFilteredClusters = async () => {
    setIsLoading(true);
    setErrorMsg('');
    try {
      const res = await apiClient.getClusters({ category: filterCategory, region: filterRegion, status: filterStatus, search: searchQuery });
      setClusters(res.data);
      if (res.data.length > 0) {
        const stillExists = res.data.some((c: any) => c.id === selectedClusterId);
        if (!stillExists) setSelectedClusterId(res.data[0].id);
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

  useEffect(() => {
    const t = setTimeout(() => { fetchFilteredClusters(); loadGlobalStats(); }, 300);
    return () => clearTimeout(t);
  }, [filterCategory, filterRegion, filterStatus, searchQuery]);

  const handleUpdateStatus = async (newStatus: 'pending' | 'in_progress' | 'resolved') => {
    if (!selectedClusterId) return;
    try {
      await apiClient.updateClusterStatus(selectedClusterId, newStatus);
      setClusters(prev => prev.map(c => c.id === selectedClusterId ? { ...c, status: newStatus } : c));
      loadGlobalStats();
    } catch (err: any) {
      if (err?.status === 403) setErrorMsg('Permission denied. Only NGO/Govt/Admin accounts can update cluster status.');
      else if (err?.status !== 401) setErrorMsg(err?.message || 'Error updating cluster status.');
    }
  };

  const handleSort = (field: 'priority' | 'severity' | 'count') => {
    if (sortBy === field) setSortOrder(sortOrder === 'asc' ? 'desc' : 'desc');
    else { setSortBy(field); setSortOrder('desc'); }
  };

  const sortedClusters = useMemo(() => {
    return [...clusters].sort((a, b) => {
      const valA = sortBy === 'priority' ? (a.priorityScore ?? a.severity) : sortBy === 'severity' ? a.severity : a.complaintCount;
      const valB = sortBy === 'priority' ? (b.priorityScore ?? b.severity) : sortBy === 'severity' ? b.severity : b.complaintCount;
      return sortOrder === 'asc' ? valA - valB : valB - valA;
    });
  }, [clusters, sortBy, sortOrder]);

  const selectedCluster = useMemo(() => clusters.find((c) => c.id === selectedClusterId) || null, [clusters, selectedClusterId]);

  // Chart data — group complaints by category
  const chartData = useMemo(() => {
    const catCounts: Record<string, number> = {};
    clusters.forEach(c => { catCounts[c.category] = (catCounts[c.category] || 0) + c.complaintCount; });
    return Object.entries(catCounts).map(([name, count]) => ({
      name: name.charAt(0).toUpperCase() + name.slice(1),
      count,
    }));
  }, [clusters]);

  const chartColors = ['#6366f1', '#f59e0b', '#3b82f6', '#ef4444', '#10b981', '#8b5cf6'];

  const getSeverityBadge = (score: number) => {
    if (score >= 75) return 'bg-rose-500/10 text-rose-400 border-rose-500/20';
    if (score >= 40) return 'bg-amber-500/10 text-amber-400 border-amber-500/20';
    return 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20';
  };
  const getPriorityBadge = (score: number) => {
    if (score >= 70) return 'bg-violet-500/10 text-violet-300 border-violet-500/20';
    if (score >= 35) return 'bg-orange-500/10 text-orange-300 border-orange-500/20';
    return 'bg-sky-500/10 text-sky-400 border-sky-500/20';
  };
  const getSourceBadge = (source: string) => {
    switch (source) {
      case 'citizen_portal': return 'bg-indigo-500/10 text-indigo-400 border-indigo-500/20';
      case 'news_rss': return 'bg-cyan-500/10 text-cyan-400 border-cyan-500/20';
      case 'social_media': return 'bg-pink-500/10 text-pink-400 border-pink-500/20';
      default: return 'bg-neutral-500/10 text-neutral-400 border-neutral-500/20';
    }
  };
  const getSourceLabel = (source: string) => {
    switch (source) {
      case 'citizen_portal': return 'Portal';
      case 'news_rss': return 'News';
      case 'social_media': return 'Social';
      default: return source || 'Unknown';
    }
  };

  // Greeting based on time of day
  const getGreeting = () => {
    const h = new Date().getHours();
    if (h < 12) return 'Good morning';
    if (h < 17) return 'Good afternoon';
    return 'Good evening';
  };

  const criticalCount = clusters.filter(c => c.severity >= 75 && c.status !== 'resolved').length;

  return (
    <div className="p-6 lg:p-8 space-y-6 max-w-[1400px] mx-auto w-full">

      {/* Hero Banner */}
      <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-indigo-600/20 via-blue-600/10 to-transparent border border-indigo-500/10 p-6 lg:p-8">
        <div className="absolute top-0 right-0 w-64 h-64 bg-indigo-500/5 rounded-full blur-3xl -translate-y-1/2 translate-x-1/4" />
        <div className="relative">
          <h1 className="text-xl lg:text-2xl font-bold text-white">
            {getGreeting()}, {user?.name?.split(' ')[0] || 'there'} 👋
          </h1>
          <p className="text-sm text-neutral-400 mt-1.5">
            {globalStats.totalOpen > 0
              ? <>You have <span className="text-white font-semibold">{globalStats.totalOpen} open issues</span> across {clusters.length} active clusters.</>
              : 'No active clusters to review right now.'}
            {criticalCount > 0 && (
              <> <span className="text-rose-400 font-semibold">{criticalCount} critical</span> need attention.</>
            )}
          </p>
          {criticalCount > 0 && (
            <button
              onClick={() => { setFilterStatus('all'); setFilterCategory('all'); setFilterRegion('all'); setSearchQuery(''); }}
              className="mt-4 inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold rounded-xl transition-all cursor-pointer"
            >
              <AlertOctagon className="w-3.5 h-3.5" />
              View Critical Issues
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Stat Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { label: 'Open Issues', value: globalStats.totalOpen, icon: TrendingUp, color: 'indigo' },
          { label: 'Resolved', value: globalStats.totalResolved, icon: CheckCircle2, color: 'emerald' },
          { label: 'Avg Severity', value: `${globalStats.avgSeverity}`, icon: AlertOctagon, color: 'rose', suffix: '/100' },
          { label: 'Top Region', value: globalStats.topRegion, icon: Landmark, color: 'amber' },
        ].map((stat, i) => {
          const Icon = stat.icon;
          return (
            <div key={i} className="cm-card stat-card p-5 flex items-center gap-4">
              <div className={`w-11 h-11 rounded-xl flex items-center justify-center shrink-0 ${
                stat.color === 'indigo' ? 'bg-indigo-500/10 text-indigo-400' :
                stat.color === 'emerald' ? 'bg-emerald-500/10 text-emerald-400' :
                stat.color === 'rose' ? 'bg-rose-500/10 text-rose-400' :
                'bg-amber-500/10 text-amber-400'
              }`}>
                <Icon className="w-5 h-5" />
              </div>
              <div>
                <span className="text-[11px] text-neutral-500 font-semibold uppercase tracking-wider block">{stat.label}</span>
                <span className="text-2xl font-extrabold text-white">
                  {stat.value}
                  {stat.suffix && <span className="text-xs font-normal text-neutral-500">{stat.suffix}</span>}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {/* Chart + Filters Row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Bar Chart */}
        <div className="cm-card p-5">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Activity className="w-4 h-4 text-indigo-400" />
              <span className="text-xs font-bold text-neutral-300 uppercase tracking-wider">Complaints by Category</span>
            </div>
          </div>
          {chartData.length > 0 ? (
            <ResponsiveContainer width="100%" height={180}>
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
            <div className="h-[180px] flex items-center justify-center text-neutral-600 text-xs">No data</div>
          )}
        </div>

        {/* Filter Controls */}
        <div className="lg:col-span-2 cm-card p-5">
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative flex-1 min-w-[200px]">
              <Search className="absolute left-3 top-2.5 w-4 h-4 text-neutral-500" />
              <input
                type="text"
                placeholder="Search clusters..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-9 pr-3 py-2.5 bg-white/[0.03] border border-white/5 rounded-xl text-xs text-white placeholder-neutral-500 focus:outline-none focus:border-indigo-500/30 focus:ring-1 focus:ring-indigo-500/10 transition-all"
              />
            </div>
            <select value={filterCategory} onChange={(e) => setFilterCategory(e.target.value)} className="px-3 py-2.5 bg-white/[0.03] border border-white/5 rounded-xl text-xs text-neutral-300 focus:outline-none focus:border-indigo-500/30">
              <option value="all">All Categories</option>
              <option value="infrastructure">Infrastructure</option>
              <option value="sanitation">Sanitation</option>
              <option value="utility">Utility</option>
              <option value="noise">Noise</option>
              <option value="safety">Safety</option>
              <option value="other">Other</option>
            </select>
            <select value={filterRegion} onChange={(e) => setFilterRegion(e.target.value)} className="px-3 py-2.5 bg-white/[0.03] border border-white/5 rounded-xl text-xs text-neutral-300 focus:outline-none focus:border-indigo-500/30">
              <option value="all">All Regions</option>
              <option value="Downtown">Downtown</option>
              <option value="North">North</option>
              <option value="South">South</option>
              <option value="East">East</option>
              <option value="West">West</option>
            </select>
            <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)} className="px-3 py-2.5 bg-white/[0.03] border border-white/5 rounded-xl text-xs text-neutral-300 focus:outline-none focus:border-indigo-500/30">
              <option value="all">All Status</option>
              <option value="pending">Pending</option>
              <option value="in_progress">In Progress</option>
              <option value="resolved">Resolved</option>
            </select>

            <div className="flex bg-white/[0.03] p-1 rounded-xl border border-white/5 select-none">
              <button onClick={() => setViewMode('table')} className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer transition-all ${viewMode === 'table' ? 'bg-white/5 text-white' : 'text-neutral-500'}`}>
                <List className="w-3.5 h-3.5" /> Table
              </button>
              <button onClick={() => setViewMode('map')} className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer transition-all ${viewMode === 'map' ? 'bg-white/5 text-white' : 'text-neutral-500'}`}>
                <Map className="w-3.5 h-3.5" /> Map
              </button>
            </div>
          </div>
        </div>
      </div>

      {errorMsg && (
        <div className="p-4 bg-rose-500/10 border border-rose-500/20 rounded-xl text-sm text-rose-400 flex gap-2 items-center">
          <AlertTriangle className="w-5 h-5 shrink-0" />
          <span>{errorMsg}</span>
          <button onClick={() => setErrorMsg('')} className="ml-auto"><X className="w-4 h-4" /></button>
        </div>
      )}

      {/* Main Content: Table/Map + Slide-in Panel */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6 items-start">
        {/* Table / Map */}
        <div className={`${selectedCluster ? 'xl:col-span-2' : 'xl:col-span-3'} cm-card overflow-hidden transition-all duration-200`}>
          {isLoading ? (
            <div className="flex items-center justify-center p-16 text-neutral-400">
              <RefreshCw className="w-6 h-6 animate-spin text-indigo-400 mr-3" />
              <span className="text-sm">Loading clusters...</span>
            </div>
          ) : viewMode === 'table' ? (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-white/5 text-neutral-500 font-semibold select-none">
                    <th className="px-5 py-3.5">Cluster Topic</th>
                    <th className="px-5 py-3.5">Category</th>
                    <th className="px-5 py-3.5">Region</th>
                    <th className="px-5 py-3.5 cursor-pointer hover:text-white transition-colors" onClick={() => handleSort('priority')}>
                      <div className="flex items-center gap-1"><span className={sortBy === 'priority' ? 'text-indigo-400' : ''}>Priority</span><ArrowUpDown className="w-3 h-3" /></div>
                    </th>
                    <th className="px-5 py-3.5 cursor-pointer hover:text-white transition-colors" onClick={() => handleSort('severity')}>
                      <div className="flex items-center gap-1"><span className={sortBy === 'severity' ? 'text-rose-400' : ''}>Severity</span><ArrowUpDown className="w-3 h-3" /></div>
                    </th>
                    <th className="px-5 py-3.5 cursor-pointer hover:text-white transition-colors" onClick={() => handleSort('count')}>
                      <div className="flex items-center gap-1"><span>Reports</span><ArrowUpDown className="w-3 h-3" /></div>
                    </th>
                    <th className="px-5 py-3.5">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedClusters.length > 0 ? sortedClusters.map((cluster) => (
                    <tr
                      key={cluster.id}
                      onClick={() => setSelectedClusterId(cluster.id === selectedClusterId ? null : cluster.id)}
                      className={`table-row border-b border-white/[0.03] cursor-pointer ${selectedClusterId === cluster.id ? 'bg-indigo-500/5' : ''}`}
                    >
                      <td className="px-5 py-4">
                        <div className="font-semibold text-white text-[13px]">{cluster.title}</div>
                        <div className="text-[10px] text-neutral-600 mt-0.5 font-mono">{cluster.id}</div>
                      </td>
                      <td className="px-5 py-4"><span className="capitalize text-neutral-300">{cluster.category}</span></td>
                      <td className="px-5 py-4 text-neutral-400">{cluster.region}</td>
                      <td className="px-5 py-4">
                        <span className={`px-2.5 py-1 rounded-full border font-semibold text-[10px] ${getPriorityBadge(cluster.priorityScore ?? cluster.severity)}`}>
                          {cluster.priorityScore ?? cluster.severity}
                        </span>
                      </td>
                      <td className="px-5 py-4">
                        <span className={`px-2.5 py-1 rounded-full border font-semibold text-[10px] ${getSeverityBadge(cluster.severity)}`}>
                          {cluster.severity}
                        </span>
                      </td>
                      <td className="px-5 py-4 text-neutral-300 font-bold">{cluster.complaintCount}</td>
                      <td className="px-5 py-4">
                        <div className="flex items-center gap-1.5">
                          <span className={`w-1.5 h-1.5 rounded-full ${cluster.status === 'resolved' ? 'bg-emerald-500' : cluster.status === 'in_progress' ? 'bg-indigo-400' : 'bg-amber-400'}`} />
                          <span className="capitalize text-neutral-400 text-[11px]">{cluster.status.replace(/_/g, ' ')}</span>
                        </div>
                      </td>
                    </tr>
                  )) : (
                    <tr><td colSpan={7} className="text-center p-12 text-neutral-500 text-sm">No clusters found matching filters.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          ) : (
            /* MAP VIEW */
            <div className="p-6 flex flex-col items-center gap-4">
              <span className="text-[10px] uppercase font-bold text-neutral-500 tracking-wider">Metro City — GPS Projection</span>
              <div className="relative w-full max-w-[500px] border border-white/5 rounded-2xl overflow-hidden bg-[#0a0a0e] p-3">
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
                    const { x, y } = getCoordinates(cluster.latitude, cluster.longitude);
                    const isSelected = selectedClusterId === cluster.id;
                    let color = 'fill-emerald-500';
                    if (cluster.severity >= 75) color = 'fill-rose-500';
                    else if (cluster.severity >= 40) color = 'fill-amber-500';
                    return (
                      <g key={cluster.id} onClick={() => setSelectedClusterId(cluster.id)} className="cursor-pointer group">
                        {isSelected && <circle cx={x} cy={y} r="14" className="fill-none stroke-white/50 stroke-2 animate-pulse" />}
                        <circle cx={x} cy={y} r="18" className="fill-white/0 group-hover:fill-white/5 transition-all" />
                        <circle cx={x} cy={y} r="8" className={`${color} opacity-30 group-hover:opacity-50`} />
                        <circle cx={x} cy={y} r="4.5" className={`${color} stroke-black stroke-2`} />
                      </g>
                    );
                  })}
                </svg>
              </div>
              <div className="flex gap-6 text-[10px] text-neutral-500">
                <div className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-rose-500" /> High (75+)</div>
                <div className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-amber-500" /> Medium (40-74)</div>
                <div className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-emerald-500" /> Low (&lt;40)</div>
              </div>
            </div>
          )}
          <div className="px-5 py-3 bg-white/[0.01] border-t border-white/5 text-[10px] text-neutral-600 flex justify-between">
            <span>{sortedClusters.length} clusters shown</span>
            <span>PostgreSQL + pgvector</span>
          </div>
        </div>

        {/* Slide-in Detail Panel */}
        {selectedCluster && (
          <div className="slide-panel xl:col-span-1 cm-card p-6 xl:sticky xl:top-20 max-h-[calc(100vh-6rem)] overflow-y-auto">
            {/* Close button + heading */}
            <div className="flex items-start justify-between mb-5">
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <span className={`px-2 py-0.5 rounded-full text-[10px] font-mono border ${getPriorityBadge(selectedCluster.priorityScore ?? selectedCluster.severity)}`}>
                    PRI {selectedCluster.priorityScore ?? selectedCluster.severity}
                  </span>
                  <span className={`px-2 py-0.5 rounded-full text-[10px] font-mono border ${getSeverityBadge(selectedCluster.severity)}`}>
                    SEV {selectedCluster.severity}
                  </span>
                </div>
                <h2 className="text-base font-bold text-white leading-tight mt-2">{selectedCluster.title}</h2>
                <div className="flex items-center gap-2 mt-1.5 text-[11px] text-neutral-500">
                  <span className="font-mono">{selectedCluster.id}</span>
                  <span>·</span>
                  <span className="capitalize">{selectedCluster.category}</span>
                  <span>·</span>
                  <span>{selectedCluster.region}</span>
                </div>
              </div>
              <button onClick={() => setSelectedClusterId(null)} className="p-1.5 rounded-lg text-neutral-500 hover:text-white hover:bg-white/5 transition-all">
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Score breakdown */}
            <div className="flex gap-3 mb-5">
              <div className="flex-1 text-center p-3 bg-white/[0.02] rounded-xl border border-white/5">
                <div className={`text-lg font-extrabold ${(selectedCluster.priorityScore ?? selectedCluster.severity) >= 70 ? 'text-violet-300' : (selectedCluster.priorityScore ?? selectedCluster.severity) >= 35 ? 'text-orange-300' : 'text-sky-400'}`}>
                  {selectedCluster.priorityScore ?? selectedCluster.severity}
                </div>
                <div className="text-[9px] text-neutral-500 uppercase tracking-wider mt-0.5">Priority</div>
              </div>
              <div className="flex-1 text-center p-3 bg-white/[0.02] rounded-xl border border-white/5">
                <div className={`text-lg font-extrabold ${selectedCluster.severity >= 75 ? 'text-rose-400' : selectedCluster.severity >= 40 ? 'text-amber-400' : 'text-emerald-400'}`}>
                  {selectedCluster.severity}
                </div>
                <div className="text-[9px] text-neutral-500 uppercase tracking-wider mt-0.5">Severity</div>
              </div>
            </div>

            <div className="h-px bg-white/5 mb-5" />

            {/* Linked Reports */}
            <div className="mb-5">
              <span className="text-[11px] uppercase font-bold text-neutral-500 tracking-wider block mb-3">
                Reports ({selectedCluster.complaints.length})
              </span>
              <div className="max-h-40 overflow-y-auto space-y-2 pr-1">
                {selectedCluster.complaints.map((c: any) => (
                  <div key={c.id} className="p-3 bg-white/[0.02] border border-white/5 rounded-xl">
                    <div className="flex items-center justify-between mb-1 text-[10px]">
                      <span className="font-mono font-bold text-indigo-400">{c.id}</span>
                      <span className="text-neutral-600">{new Date(c.created_at).toLocaleDateString()}</span>
                    </div>
                    <p className="text-[11px] text-neutral-300 leading-normal line-clamp-2">"{c.text}"</p>
                    <div className="flex items-center justify-between mt-1.5 pt-1.5 border-t border-white/5 text-[9px] text-neutral-500">
                      <span className="capitalize">{c.status}</span>
                      {c.source_name && (
                        <span className={`px-1.5 py-0.5 rounded-full border font-semibold ${getSourceBadge(c.source_name)}`}>
                          {getSourceLabel(c.source_name)}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="h-px bg-white/5 mb-5" />

            {/* AI Recommendation */}
            <div className="mb-5">
              <div className="flex items-center gap-2 mb-3">
                <span className="text-[11px] uppercase font-bold text-neutral-500 tracking-wider">AI Action Plan</span>
                {selectedCluster.latestAction && (
                  <span className={`px-1.5 py-0.5 rounded-md text-[9px] font-bold uppercase tracking-wider border ${
                    selectedCluster.latestAction.generatedBy === 'gemini'
                      ? 'bg-indigo-500/10 text-indigo-400 border-indigo-500/20'
                      : 'bg-amber-500/10 text-amber-400 border-amber-500/20'
                  }`}>
                    {selectedCluster.latestAction.generatedBy === 'gemini' ? 'Gemini AI' : 'Rules'}
                  </span>
                )}
              </div>
              {selectedCluster.latestAction ? (
                <div className="p-3.5 bg-indigo-500/5 border border-indigo-500/10 rounded-xl">
                  <div className="flex items-start gap-2">
                    {selectedCluster.latestAction.generatedBy === 'gemini' ? (
                      <Bot className="w-3.5 h-3.5 text-indigo-400 mt-0.5 shrink-0" />
                    ) : (
                      <Zap className="w-3.5 h-3.5 text-amber-400 mt-0.5 shrink-0" />
                    )}
                    <p className="text-[11px] text-indigo-200/80 leading-relaxed italic flex-1">
                      &quot;{selectedCluster.latestAction.text}&quot;
                    </p>
                  </div>
                  <div className="text-[9px] text-neutral-600 font-mono mt-2 pt-2 border-t border-indigo-500/10">
                    {new Date(selectedCluster.latestAction.generatedAt).toLocaleString()}
                  </div>
                </div>
              ) : selectedCluster.recommendedAction ? (
                <div className="p-3.5 bg-indigo-500/5 border border-indigo-500/10 rounded-xl">
                  <p className="text-[11px] text-indigo-200/80 leading-relaxed italic">&quot;{selectedCluster.recommendedAction}&quot;</p>
                </div>
              ) : (
                <div className="p-3.5 bg-white/[0.02] border border-white/5 rounded-xl flex items-center gap-3">
                  <Loader2 className="w-4 h-4 text-indigo-400 animate-spin shrink-0" />
                  <p className="text-[11px] text-neutral-400">Generating recommendation...</p>
                </div>
              )}
            </div>

            {/* Operations */}
            {userRole && userRole !== 'citizen' && (
              <div>
                <span className="text-[11px] uppercase font-bold text-neutral-500 tracking-wider block mb-3">Actions</span>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => handleUpdateStatus('in_progress')}
                    disabled={selectedCluster.status === 'in_progress'}
                    className="px-4 py-2.5 bg-indigo-600 hover:bg-indigo-500 disabled:bg-indigo-600/20 text-white font-semibold text-xs rounded-xl transition-all cursor-pointer disabled:cursor-not-allowed"
                  >
                    In Progress
                  </button>
                  <button
                    onClick={() => handleUpdateStatus('resolved')}
                    disabled={selectedCluster.status === 'resolved'}
                    className="px-4 py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:bg-emerald-600/20 text-white font-semibold text-xs rounded-xl transition-all cursor-pointer disabled:cursor-not-allowed"
                  >
                    Resolve
                  </button>
                </div>
                <div className="text-[9px] text-neutral-600 text-center mt-2">Cascades to all linked complaints</div>
              </div>
            )}
            {(!userRole || userRole === 'citizen') && (
              <div className="p-3 bg-white/[0.02] border border-white/5 rounded-xl text-center text-neutral-500 text-[11px]">
                {userRole === 'citizen' ? 'Citizen accounts are read-only.' : 'Sign in with NGO/Govt/Admin to manage.'}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
