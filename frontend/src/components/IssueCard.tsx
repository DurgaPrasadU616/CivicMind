'use client';

import React, { useState } from 'react';
import { ChevronRight, AlertTriangle } from 'lucide-react';
import { getSeverityConfig, getStatusConfig } from '../lib/dashboard-utils';
import { Badge } from './ui/badge';
import { cn } from '../lib/utils';

export interface IssueCardCluster {
  id: string | number;
  title: string;
  category: string;
  region: string;
  complaintCount: number;
  severity: number;
  status: string;
  hybridScore?: number;
  geoCentroidLat?: number;
  geoCentroidLng?: number;
  needsReview?: boolean;
  latestAction?: { text?: string } | null;
  recommendedAction?: string;
  lastUpdated?: string;
}

interface IssueCardProps {
  cluster: IssueCardCluster;
  isSelected: boolean;
  onSelect: (id: string) => void;
}

const severityToBadgeVariant = (severity: number) => {
  if (severity >= 75) return 'destructive' as const;
  if (severity >= 40) return 'warning' as const;
  return 'success' as const;
};

const statusToBadgeVariant = (status: string) => {
  switch (status) {
    case 'open': return 'warning' as const;
    case 'in_progress': return 'info' as const;
    case 'resolved': return 'success' as const;
    case 'escalated': return 'destructive' as const;
    default: return 'secondary' as const;
  }
};

export const IssueCard: React.FC<IssueCardProps> = ({ cluster, isSelected, onSelect }) => {
  const sev = getSeverityConfig(cluster.severity);
  const [now] = useState(() => Date.now());

  let summary = cluster.latestAction?.text || cluster.recommendedAction || '';
  try {
    const parsed = JSON.parse(summary);
    if (parsed.executive_summary) {
      summary = parsed.executive_summary;
    }
  } catch {
    // If not JSON, use as-is
  }
  const displaySummary = summary.length > 100 ? summary.slice(0, 100) + '...' : summary;

  const timeAgo = cluster.lastUpdated
    ? (() => {
        const diff = now - new Date(cluster.lastUpdated).getTime();
        const hrs = Math.floor(diff / 3600000);
        if (hrs < 1) return 'Just now';
        if (hrs < 24) return `${hrs}h ago`;
        const days = Math.floor(hrs / 24);
        return `${days}d ago`;
      })()
    : '';

  return (
    <div
      onClick={() => onSelect(String(cluster.id))}
      className={cn(
        'rounded-lg bg-white/[0.03] border p-5 cursor-pointer transition-all select-none',
        isSelected
          ? 'border-indigo-500/30'
          : 'border-white/5 hover:border-white/10'
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1.5 flex-wrap">
            <Badge variant={severityToBadgeVariant(cluster.severity)}>
              {sev.icon} {sev.label}
            </Badge>
            <Badge variant={statusToBadgeVariant(cluster.status)}>
              <span className={cn('w-1.5 h-1.5 rounded-full mr-1', sev.dotClass)} />
              {(() => {
                const st = getStatusConfig(cluster.status);
                return st.label;
              })()}
            </Badge>
            {cluster.needsReview && (
              <Badge variant="warning" className="animate-pulse">
                <AlertTriangle className="w-3 h-3 mr-1" /> Needs Review
              </Badge>
            )}
          </div>
          <h3 className="text-sm font-bold text-white leading-snug">{cluster.title}</h3>
          {displaySummary && (
            <p className="text-xs text-neutral-500 mt-1.5 leading-relaxed line-clamp-2">{displaySummary}</p>
          )}
          <div className="flex items-center gap-3 mt-2.5 text-[11px] text-neutral-600">
            <span>{cluster.complaintCount} report{cluster.complaintCount !== 1 ? 's' : ''}</span>
            <span className="w-1 h-1 rounded-full bg-neutral-700" />
            <span className="capitalize">{cluster.region}</span>
            <span className="w-1 h-1 rounded-full bg-neutral-700" />
            <span className="capitalize">{cluster.category}</span>
            {timeAgo && (
              <>
                <span className="w-1 h-1 rounded-full bg-neutral-700" />
                <span>{timeAgo}</span>
              </>
            )}
          </div>
        </div>
        <ChevronRight className={cn('w-5 h-5 mt-1 shrink-0 transition-colors', isSelected ? 'text-indigo-400' : 'text-neutral-700')} />
      </div>
    </div>
  );
};
