'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAuth } from '../context/AuthContext';
import {
  ShieldAlert, LayoutDashboard, FileText, Search,
  ChevronLeft, ChevronRight, LogOut, User, Briefcase,
  Settings, Shield, LogIn, X, FileSearch, CheckCircle2,
  Building2, BarChart3
} from 'lucide-react';
import { cn } from '../lib/utils';
import { Button } from './ui/button';
import { Separator } from './ui/separator';

const ROLE_META: Record<string, { label: string; icon: React.ReactNode; color: string }> = {
  citizen: { label: 'Citizen', icon: <User className="w-3.5 h-3.5" />, color: 'text-emerald-400' },
  ngo: { label: 'NGO', icon: <Briefcase className="w-3.5 h-3.5" />, color: 'text-indigo-400' },
  govt: { label: 'Govt', icon: <Settings className="w-3.5 h-3.5" />, color: 'text-amber-400' },
  admin: { label: 'Admin', icon: <Shield className="w-3.5 h-3.5" />, color: 'text-rose-400' },
};

interface SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
  mobileOpen: boolean;
  onMobileClose: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({ collapsed, onToggle, mobileOpen, onMobileClose }) => {
  const { isAuthenticated, user, userRole, logout } = useAuth();
  const pathname = usePathname();
  const roleMeta = userRole ? ROLE_META[userRole] : null;

  const navItems = [
    { href: '/dashboard', label: 'Overview', icon: LayoutDashboard },
    { href: '/investigations', label: 'Investigations', icon: FileSearch },
    { href: '/actions', label: 'Civic Actions', icon: CheckCircle2 },
    { href: '/departments', label: 'Departments', icon: Building2 },
    { href: '/analytics', label: 'Analytics', icon: BarChart3 },
    { href: '/portal', label: 'Public Portal', icon: FileText },
    { href: '/track', label: 'Track Complaint', icon: Search },
  ];

  const isActive = (href: string) => pathname === href;

  const sidebarContent = (
    <div className="flex flex-col h-full">
      <div className={cn('flex items-center gap-3 px-5 py-5', collapsed && 'justify-center px-3')}>
        <div className="w-9 h-9 rounded-lg bg-indigo-600 flex items-center justify-center shrink-0">
          <ShieldAlert className="w-4.5 h-4.5 text-white" />
        </div>
        {!collapsed && (
          <span className="text-base font-bold text-white tracking-tight whitespace-nowrap">
            CivicMind
          </span>
        )}
      </div>

      <Separator />

      <nav className="flex-1 px-3 py-4 space-y-1">
        {isAuthenticated && navItems.map((item) => {
          const active = isActive(item.href);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={onMobileClose}
              className={cn(
                'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors',
                active
                  ? 'bg-indigo-500/10 text-indigo-400'
                  : 'text-neutral-400 hover:text-white hover:bg-white/5',
                collapsed && 'justify-center'
              )}
              title={collapsed ? item.label : undefined}
            >
              <Icon className={cn('w-[18px] h-[18px] shrink-0', active ? 'text-indigo-400' : 'text-neutral-500')} />
              {!collapsed && <span>{item.label}</span>}
            </Link>
          );
        })}

        {!isAuthenticated && (
          <Link
            href="/login"
            onClick={onMobileClose}
            className={cn(
              'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-neutral-400 hover:text-white hover:bg-white/5 transition-colors',
              collapsed && 'justify-center'
            )}
          >
            <LogIn className="w-[18px] h-[18px] shrink-0 text-neutral-500" />
            {!collapsed && <span>Sign In</span>}
          </Link>
        )}
      </nav>

      <div className="px-3 pb-4 space-y-1">
        <Separator className="mb-3" />
        {isAuthenticated && user && (
          <div className={cn('flex items-center gap-3 px-3 py-2.5 rounded-lg bg-white/[0.02]', collapsed && 'justify-center')}>
            <div className="w-8 h-8 rounded-full bg-indigo-500/15 border border-indigo-500/20 flex items-center justify-center shrink-0">
              <span className="text-xs font-bold text-indigo-400">
                {user.name.charAt(0).toUpperCase()}
              </span>
            </div>
            {!collapsed && (
              <div className="flex-1 min-w-0">
                <div className="text-xs font-semibold text-white truncate">{user.name}</div>
                <div className={cn('inline-flex items-center gap-1 text-[10px] font-medium', roleMeta?.color)}>
                  {roleMeta?.icon}
                  <span>{roleMeta?.label}</span>
                </div>
              </div>
            )}
          </div>
        )}

        {isAuthenticated && (
          <Button
            variant="ghost"
            size="sm"
            onClick={logout}
            className={cn('w-full justify-start text-neutral-500 hover:text-rose-400 hover:bg-rose-500/5', collapsed && 'justify-center')}
            title={collapsed ? 'Logout' : undefined}
          >
            <LogOut className="w-[18px] h-[18px] shrink-0" />
            {!collapsed && <span>Logout</span>}
          </Button>
        )}

        <Button
          variant="ghost"
          size="sm"
          onClick={onToggle}
          className="hidden lg:flex w-full justify-center text-neutral-600 hover:text-neutral-300 mt-2"
        >
          {collapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
        </Button>
      </div>
    </div>
  );

  return (
    <>
      {mobileOpen && (
        <div
          className="fixed inset-0 bg-black/60 backdrop-blur-sm z-40 lg:hidden"
          onClick={onMobileClose}
        />
      )}

      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-50 w-[260px] bg-surface border-r border-white/5 transform transition-transform duration-200 lg:hidden',
          mobileOpen ? 'translate-x-0' : '-translate-x-full'
        )}
      >
        <Button
          variant="ghost"
          size="icon"
          onClick={onMobileClose}
          className="absolute top-4 right-4"
        >
          <X className="w-4 h-4" />
        </Button>
        {sidebarContent}
      </aside>

      <aside
        className={cn(
          'hidden lg:flex flex-col fixed inset-y-0 left-0 z-30 bg-surface border-r border-white/5 transition-all duration-200',
          collapsed ? 'w-[68px]' : 'w-[240px]'
        )}
      >
        {sidebarContent}
      </aside>
    </>
  );
};
