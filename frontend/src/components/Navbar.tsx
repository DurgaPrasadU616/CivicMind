'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAuth } from '../context/AuthContext';
import {
  ShieldAlert, User, Shield, Briefcase, FileText,
  BarChart3, Search, Settings, LogOut, LogIn
} from 'lucide-react';

const ROLE_META: Record<string, { label: string; icon: React.ReactNode; color: string }> = {
  citizen: { label: 'Citizen',      icon: <User className="w-3.5 h-3.5" />,     color: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' },
  ngo:     { label: 'NGO Officer',  icon: <Briefcase className="w-3.5 h-3.5" />, color: 'bg-indigo-500/10 text-indigo-400 border-indigo-500/20' },
  govt:    { label: 'Govt Official',icon: <Settings className="w-3.5 h-3.5" />,  color: 'bg-amber-500/10 text-amber-400 border-amber-500/20' },
  admin:   { label: 'Admin',        icon: <Shield className="w-3.5 h-3.5" />,    color: 'bg-rose-500/10 text-rose-400 border-rose-500/20' },
};

export const Navbar: React.FC = () => {
  const { isAuthenticated, user, userRole, logout } = useAuth();
  const pathname = usePathname();

  const roleMeta = userRole ? ROLE_META[userRole] : null;

  const linkClass = (path: string) => {
    const isActive = pathname === path;
    return `px-4 py-2 rounded-lg text-sm font-medium transition-all duration-200 ${
      isActive
        ? 'bg-neutral-800 text-white shadow-lg border border-neutral-700/50'
        : 'text-neutral-400 hover:text-white hover:bg-neutral-900'
    }`;
  };

  return (
    <nav className="sticky top-0 z-50 bg-neutral-950/80 backdrop-blur-md border-b border-neutral-800/80 px-6 py-4 flex items-center justify-between">
      {/* Brand Logo */}
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-emerald-500 to-indigo-600 flex items-center justify-center shadow-lg shadow-emerald-500/10 border border-emerald-400/20">
          <ShieldAlert className="w-5 h-5 text-white" />
        </div>
        <span className="text-xl font-bold bg-gradient-to-r from-white via-neutral-100 to-neutral-400 bg-clip-text text-transparent tracking-wide">
          CivicMind AI
        </span>
      </div>

      {/* Navigation Links — only show when authenticated */}
      {isAuthenticated && (
        <div className="hidden md:flex items-center gap-2">
          <Link href="/portal" className={linkClass('/portal')}>
            <div className="flex items-center gap-2">
              <FileText className="w-4 h-4" />
              <span>Public Portal</span>
            </div>
          </Link>
          <Link href="/dashboard" className={linkClass('/dashboard')}>
            <div className="flex items-center gap-2">
              <BarChart3 className="w-4 h-4" />
              <span>Dashboard</span>
            </div>
          </Link>
          <Link href="/track" className={linkClass('/track')}>
            <div className="flex items-center gap-2">
              <Search className="w-4 h-4" />
              <span>Track Complaint</span>
            </div>
          </Link>
        </div>
      )}

      {/* Right side: Auth state */}
      <div className="flex items-center gap-3">
        {isAuthenticated && user ? (
          <>
            {/* User badge */}
            <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full border text-xs font-semibold ${roleMeta?.color}`}>
              {roleMeta?.icon}
              <span className="hidden sm:inline">{user.name}</span>
              <span className="text-[10px] opacity-70">· {roleMeta?.label}</span>
            </div>

            {/* Logout */}
            <button
              id="navbar-logout"
              onClick={logout}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-neutral-400 hover:text-white hover:bg-neutral-800 border border-transparent hover:border-neutral-700 transition-all cursor-pointer"
            >
              <LogOut className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Logout</span>
            </button>
          </>
        ) : (
          <Link
            href="/login"
            className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white transition-all"
          >
            <LogIn className="w-3.5 h-3.5" />
            <span>Sign In</span>
          </Link>
        )}
      </div>
    </nav>
  );
};
