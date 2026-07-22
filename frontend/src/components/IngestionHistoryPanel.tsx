'use client';

import React, { useState, useEffect } from 'react';
import { apiClient, IngestionLogItem } from '../lib/api';
import { RefreshCw, AlertTriangle, CheckCircle2, Clock, Rss, Share2 } from 'lucide-react';

export const IngestionHistoryPanel: React.FC = () => {
  const [logs, setLogs] = useState<IngestionLogItem[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const fetchLogs = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiClient.getIngestionLogs(7, 1);
      setLogs(res.logs || []);
    } catch (err: unknown) {
      console.error('Failed to fetch ingestion logs:', err);
      if (err && typeof err === 'object' && 'status' in err && (err as { status?: number }).status === 403) {
        setError('Audit logs restricted to Admin and Govt accounts.');
      } else {
        setError('Failed to load ingestion log history.');
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let mounted = true;
    apiClient
      .getIngestionLogs(7, 1)
      .then((res) => {
        if (mounted) {
          setLogs(res.logs || []);
          setError(null);
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (mounted) {
          console.error('Failed to fetch ingestion logs:', err);
          if (err && typeof err === 'object' && 'status' in err && (err as { status?: number }).status === 403) {
            setError('Audit logs restricted to Admin and Govt accounts.');
          } else {
            setError('Failed to load ingestion log history.');
          }
          setLoading(false);
        }
      });
    return () => {
      mounted = false;
    };
  }, []);

  const getSourceIcon = (source: string) => {
    if (source === 'news_rss') return <Rss className="w-3.5 h-3.5 text-cyan-400 shrink-0" />;
    if (source === 'social_media') return <Share2 className="w-3.5 h-3.5 text-pink-400 shrink-0" />;
    return <Clock className="w-3.5 h-3.5 text-neutral-400 shrink-0" />;
  };

  const getSourceLabel = (source: string) => {
    if (source === 'news_rss') return 'News RSS';
    if (source === 'social_media') return 'Social Media';
    return source;
  };

  return (
    <div className="cm-card p-5">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Clock className="w-4 h-4 text-indigo-400" />
          <span className="text-xs font-bold text-neutral-300 uppercase tracking-wider">
            Ingestion History (Last 7 Runs)
          </span>
        </div>
        <button
          onClick={fetchLogs}
          disabled={loading}
          className="p-1.5 hover:bg-white/5 rounded-lg transition-colors text-neutral-400 hover:text-white disabled:opacity-50 cursor-pointer"
          title="Refresh logs"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {loading ? (
        <div className="py-8 text-center text-xs text-neutral-500">Loading audit history...</div>
      ) : error ? (
        <div className="py-4 px-3 bg-neutral-900/50 border border-neutral-800 rounded-xl text-center text-xs text-neutral-500">
          {error}
        </div>
      ) : logs.length === 0 ? (
        <div className="py-8 text-center text-xs text-neutral-500">No ingestion logs recorded yet.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-white/5 text-[10px] text-neutral-500 font-bold uppercase tracking-wider">
                <th className="pb-2 pl-1">Date & Time</th>
                <th className="pb-2">Source</th>
                <th className="pb-2 text-right">Proc / Created / Dup</th>
                <th className="pb-2 text-right">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.03] text-[11px]">
              {logs.map((log) => {
                const isSuccess = log.status === 'success';
                const isPartial = log.status === 'partial';
                const isFailed = log.status === 'failed' || (!isSuccess && !isPartial);

                return (
                  <tr key={log.id} className="hover:bg-white/[0.01] transition-colors">
                    <td className="py-2.5 pl-1 text-neutral-400 font-mono text-[10px]">
                      {new Date(log.run_at).toLocaleString(undefined, {
                        month: 'short',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </td>
                    <td className="py-2.5">
                      <div className="flex items-center gap-1.5 text-neutral-300 font-medium">
                        {getSourceIcon(log.source_type)}
                        <span>{getSourceLabel(log.source_type)}</span>
                      </div>
                    </td>
                    <td className="py-2.5 text-right font-mono text-neutral-400 text-[10px]">
                      <span className="text-neutral-200">{log.processed}</span> /{' '}
                      <span className="text-emerald-400 font-semibold">{log.created}</span> /{' '}
                      <span className="text-amber-400">{log.duplicates}</span>
                    </td>
                    <td className="py-2.5 text-right">
                      <div className="flex items-center justify-end gap-1">
                        {isFailed ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[9px] font-bold uppercase tracking-wider bg-rose-500/10 text-rose-400 border border-rose-500/20">
                            <AlertTriangle className="w-3 h-3 shrink-0" />
                            Failed
                          </span>
                        ) : isPartial ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[9px] font-bold uppercase tracking-wider bg-amber-500/10 text-amber-400 border border-amber-500/20">
                            <AlertTriangle className="w-3 h-3 shrink-0" />
                            Partial
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[9px] font-bold uppercase tracking-wider bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                            <CheckCircle2 className="w-3 h-3 shrink-0" />
                            Success
                          </span>
                        )}
                      </div>
                      {log.failed_feeds && log.failed_feeds.length > 0 && (
                        <div className="text-[9px] text-rose-400/80 font-mono mt-0.5">
                          {log.failed_feeds.length} feed(s) failed
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
