export type SeverityTier = 'critical' | 'medium' | 'low';

export interface SeverityConfig {
  tier: SeverityTier;
  label: string;
  icon: string;
  color: string;
  bgClass: string;
  textClass: string;
  borderClass: string;
  dotClass: string;
  barClass: string;
}

export function getSeverityConfig(score: number): SeverityConfig {
  if (score >= 75) {
    return {
      tier: 'critical',
      label: 'Critical',
      icon: '\u{1F534}',
      color: 'red',
      bgClass: 'bg-red-500/10',
      textClass: 'text-red-400',
      borderClass: 'border-red-500/20',
      dotClass: 'bg-red-500',
      barClass: 'bg-red-500',
    };
  }
  if (score >= 40) {
    return {
      tier: 'medium',
      label: 'Medium',
      icon: '\u{1F7E0}',
      color: 'amber',
      bgClass: 'bg-amber-500/10',
      textClass: 'text-amber-400',
      borderClass: 'border-amber-500/20',
      dotClass: 'bg-amber-500',
      barClass: 'bg-amber-500',
    };
  }
  return {
    tier: 'low',
    label: 'Low',
    icon: '\u{1F7E2}',
    color: 'green',
    bgClass: 'bg-green-500/10',
    textClass: 'text-green-400',
    borderClass: 'border-green-500/20',
    dotClass: 'bg-green-500',
    barClass: 'bg-green-500',
  };
}

export function getSeverityBadgeClass(score: number): string {
  const c = getSeverityConfig(score);
  return `${c.bgClass} ${c.textClass} ${c.borderClass}`;
}

export function getMapDotFill(score: number): string {
  const c = getSeverityConfig(score);
  if (c.tier === 'critical') return 'fill-red-500';
  if (c.tier === 'medium') return 'fill-amber-500';
  return 'fill-green-500';
}

export const STATUS_LABELS: Record<string, string> = {
  open: 'Open',
  in_progress: 'In Progress',
  resolved: 'Resolved',
  escalated: 'Needs Attention',
};

export function getStatusDisplay(status: string): string {
  return STATUS_LABELS[status] || status.replace(/_/g, ' ');
}

export function getStatusConfig(status: string): { label: string; dotClass: string; bgClass: string; textClass: string; borderClass: string } {
  switch (status) {
    case 'open':
      return { label: 'Open', dotClass: 'bg-amber-500', bgClass: 'bg-amber-500/10', textClass: 'text-amber-400', borderClass: 'border-amber-500/20' };
    case 'in_progress':
      return { label: 'In Progress', dotClass: 'bg-indigo-500', bgClass: 'bg-indigo-500/10', textClass: 'text-indigo-400', borderClass: 'border-indigo-500/20' };
    case 'resolved':
      return { label: 'Resolved', dotClass: 'bg-green-500', bgClass: 'bg-green-500/10', textClass: 'text-green-400', borderClass: 'border-green-500/20' };
    case 'escalated':
      return { label: 'Needs Attention', dotClass: 'bg-red-500', bgClass: 'bg-red-500/10', textClass: 'text-red-400', borderClass: 'border-red-500/20' };
    default:
      return { label: status, dotClass: 'bg-neutral-500', bgClass: 'bg-neutral-500/10', textClass: 'text-neutral-400', borderClass: 'border-neutral-500/20' };
  }
}

export function getTransitionLabel(status: string): string {
  switch (status) {
    case 'open': return 'Open';
    case 'in_progress': return 'In Progress';
    case 'resolved': return 'Resolved';
    case 'escalated': return 'Needs Attention';
    default: return status.replace(/_/g, ' ');
  }
}

export function getTransitionColor(status: string): string {
  switch (status) {
    case 'open': return 'bg-amber-600 hover:bg-amber-500 text-white';
    case 'in_progress': return 'bg-indigo-600 hover:bg-indigo-500 text-white';
    case 'resolved': return 'bg-green-600 hover:bg-green-500 text-white';
    case 'escalated': return 'bg-red-600 hover:bg-red-500 text-white';
    default: return 'bg-neutral-600 hover:bg-neutral-500 text-white';
  }
}

export function getSourceLabel(source: string): string {
  switch (source) {
    case 'citizen_portal': return 'Portal';
    case 'news_rss': return 'News';
    case 'social_media': return 'Social';
    default: return source || 'Unknown';
  }
}
