'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAuth } from '../context/AuthContext';
import {
  ShieldAlert, LayoutDashboard, FileText, Search,
  ChevronLeft, ChevronRight, LogOut, User, Briefcase,
  Settings, Shield, LogIn, X
} from 'lucide-react';

const ROLE_META: Record<string, { label: string; icon: React.ReactNode; color: string }> = {
  citizen: { label: 'Citizen', icon: <User className="w-3.5 h-3.5" />, color: 'bg-emerald-500/10 text-emerald-400' },
  ngo: { label: 'NGO', icon: <Briefcase className="w-3.5 h-3.5" />, color: 'bg-indigo-500/10 text-indigo-400' },
  govt: { label: 'Govt', icon: <Settings className="w-3.5 h-3.5" />, color: 'bg-amber-500/10 text-amber-400' },
  admin: { label: 'Admin', icon: <Shield className="w-3.5 h-3.5" />, color: 'bg-rose-500/10 text-rose-400' },
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
    { href: '/portal', label: 'Public Portal', icon: FileText },
    { href: '/track', label: 'Track Complaint', icon: Search },
  ];

  const isActive = (href: string) => pathname === href;

  const sidebarContent = (
    <div className="flex flex-col h-full">
      {/* Brand */}
      <div className={`flex items-center gap-3 px-5 py-5 border-b border-white/5 ${collapsed ? 'justify-center px-3' : ''}`}>
        <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-indigo-500 to-blue-600 flex items-center justify-center shadow-lg shadow-indigo-500/20 shrink-0">
          <ShieldAlert className="w-4.5 h-4.5 text-white" />
        </div>
        {!collapsed && (
          <span className="text-base font-bold text-white tracking-tight whitespace-nowrap">
            CivicMind
          </span>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-3 py-4 space-y-1">
        {isAuthenticated && navItems.map((item) => {
          const active = isActive(item.href);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={onMobileClose}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all duration-150 group ${
                active
                  ? 'bg-indigo-500/10 text-indigo-400 border border-indigo-500/20'
                  : 'text-neutral-400 hover:text-white hover:bg-white/5 border border-transparent'
              } ${collapsed ? 'justify-center' : ''}`}
              title={collapsed ? item.label : undefined}
            >
              <Icon className={`w-[18px] h-[18px] shrink-0 ${active ? 'text-indigo-400' : 'text-neutral-500 group-hover:text-neutral-300'}`} />
              {!collapsed && <span>{item.label}</span>}
            </Link>
          );
        })}

        {!isAuthenticated && (
          <Link
            href="/login"
            onClick={onMobileClose}
            className={`flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all text-neutral-400 hover:text-white hover:bg-white/5 border border-transparent ${collapsed ? 'justify-center' : ''}`}
          >
            <LogIn className="w-[18px] h-[18px] shrink-0 text-neutral-500" />
            {!collapsed && <span>Sign In</span>}
          </Link>
        )}
      </nav>

      {/* Bottom section */}
      <div className="px-3 pb-4 space-y-1 border-t border-white/5 pt-3">
        {isAuthenticated && user && (
          <div className={`flex items-center gap-3 px-3 py-2.5 rounded-xl bg-white/[0.02] ${collapsed ? 'justify-center' : ''}`}>
            <div className="w-8 h-8 rounded-full bg-indigo-500/15 border border-indigo-500/20 flex items-center justify-center shrink-0">
              <span className="text-xs font-bold text-indigo-400">
                {user.name.charAt(0).toUpperCase()}
              </span>
            </div>
            {!collapsed && (
              <div className="flex-1 min-w-0">
                <div className="text-xs font-semibold text-white truncate">{user.name}</div>
                <div className={`inline-flex items-center gap-1 text-[10px] font-medium ${roleMeta?.color} px-1.5 py-0.5 rounded-md mt-0.5`}>
                  {roleMeta?.icon}
                  <span>{roleMeta?.label}</span>
                </div>
              </div>
            )}
          </div>
        )}

        {isAuthenticated && (
          <button
            onClick={logout}
            className={`flex items-center gap-3 w-full px-3 py-2.5 rounded-xl text-sm font-medium text-neutral-500 hover:text-rose-400 hover:bg-rose-500/5 transition-all cursor-pointer ${collapsed ? 'justify-center' : ''}`}
            title={collapsed ? 'Logout' : undefined}
          >
            <LogOut className="w-[18px] h-[18px] shrink-0" />
            {!collapsed && <span>Logout</span>}
          </button>
        )}

        {/* Collapse toggle — desktop only */}
        <button
          onClick={onToggle}
          className="hidden lg:flex items-center justify-center w-full px-3 py-2 rounded-xl text-neutral-600 hover:text-neutral-300 hover:bg-white/5 transition-all cursor-pointer mt-2"
        >
          {collapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
        </button>
      </div>
    </div>
  );

  return (
    <>
      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="fixed inset-0 bg-black/60 backdrop-blur-sm z-40 lg:hidden"
          onClick={onMobileClose}
        />
      )}

      {/* Mobile sidebar */}
      <aside
        className={`fixed inset-y-0 left-0 z-50 w-[260px] bg-[#0c0c10] border-r border-white/5 transform transition-transform duration-200 lg:hidden ${
          mobileOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <button
          onClick={onMobileClose}
          className="absolute top-4 right-4 p-1.5 rounded-lg text-neutral-500 hover:text-white hover:bg-white/10 transition-all z-10"
        >
          <X className="w-4 h-4" />
        </button>
        {sidebarContent}
      </aside>

      {/* Desktop sidebar */}
      <aside
        className={`hidden lg:flex flex-col fixed inset-y-0 left-0 z-30 bg-[#0c0c10] border-r border-white/5 transition-all duration-200 ${
          collapsed ? 'w-[68px]' : 'w-[240px]'
        }`}
      >
        {sidebarContent}
      </aside>
    </>
  );
};
