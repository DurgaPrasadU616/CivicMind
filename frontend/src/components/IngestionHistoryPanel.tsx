'use client';

import React, { useState, useEffect } from 'react';
import { apiClient, IngestionLogItem } from '../lib/api';
import { RefreshCw, AlertTriangle, CheckCircle2, Clock, Rss, Share2 } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent } from './ui/card';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Skeleton } from './ui/skeleton';
import { cn } from '../lib/utils';

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

  const statusBadge = (status: string) => {
    if (status === 'failed') return <Badge variant="destructive"><AlertTriangle className="w-3 h-3 mr-1" /> Failed</Badge>;
    if (status === 'partial') return <Badge variant="warning"><AlertTriangle className="w-3 h-3 mr-1" /> Partial</Badge>;
    return <Badge variant="success"><CheckCircle2 className="w-3 h-3 mr-1" /> Success</Badge>;
  };

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2 text-xs uppercase tracking-wider text-neutral-300">
          <Clock className="w-4 h-4 text-indigo-400" />
          Ingestion History (Last 7 Runs)
        </CardTitle>
        <Button variant="ghost" size="icon" onClick={fetchLogs} disabled={loading}>
          <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />
        </Button>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="flex items-center gap-4">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-4 w-20" />
                <Skeleton className="h-4 w-16 ml-auto" />
              </div>
            ))}
          </div>
        ) : error ? (
          <Card className="p-3 bg-red-500/10 border border-red-500/20">
            <div className="flex items-center gap-2 text-xs text-red-400">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <span>{error}</span>
            </div>
          </Card>
        ) : logs.length === 0 ? (
          <Card className="p-8 text-center">
            <Clock className="w-8 h-8 text-neutral-700 mx-auto mb-2" />
            <p className="text-xs text-neutral-500">No ingestion logs recorded yet.</p>
          </Card>
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
                {logs.map((log) => (
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
                      <span className="text-green-400 font-semibold">{log.created}</span> /{' '}
                      <span className="text-amber-400">{log.duplicates}</span>
                    </td>
                    <td className="py-2.5 text-right">
                      {statusBadge(log.status)}
                      {log.failed_feeds && log.failed_feeds.length > 0 && (
                        <div className="text-[9px] text-red-400/80 font-mono mt-0.5">
                          {log.failed_feeds.length} feed(s) failed
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
};
