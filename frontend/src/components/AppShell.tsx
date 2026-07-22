'use client';

import React, { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { Sidebar } from './Sidebar';
import { usePathname } from 'next/navigation';
import Link from 'next/link';
import { Search, Bell, Menu } from 'lucide-react';

const PAGE_TITLES: Record<string, string> = {
  '/dashboard': 'Dashboard',
  '/portal': 'Public Portal',
  '/track': 'Track Complaint',
  '/login': 'Sign In',
};

export const AppShell: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { isAuthenticated, user, userRole } = useAuth();
  const pathname = usePathname();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  const isLoginPage = pathname === '/login';
  const pageTitle = PAGE_TITLES[pathname] || 'CivicMind';

  // Login page gets no shell — full screen
  if (isLoginPage) {
    return <>{children}</>;
  }

  return (
    <div className="flex min-h-screen">
      <Sidebar
        collapsed={sidebarCollapsed}
        onToggle={() => setSidebarCollapsed(!sidebarCollapsed)}
        mobileOpen={mobileOpen}
        onMobileClose={() => setMobileOpen(false)}
      />

      {/* Main area */}
      <div
        className={`flex-1 flex flex-col transition-all duration-200 ${
          sidebarCollapsed ? 'lg:ml-[68px]' : 'lg:ml-[240px]'
        }`}
      >
        {/* Top bar */}
        <header className="sticky top-0 z-20 flex items-center justify-between px-6 py-3 bg-[#08080c]/85 backdrop-blur-xl border-b border-white/5">
          <div className="flex items-center gap-4">
            {/* Mobile menu button */}
            <button
              onClick={() => setMobileOpen(true)}
              className="lg:hidden p-2 rounded-lg text-neutral-400 hover:text-white hover:bg-white/5 transition-all"
            >
              <Menu className="w-5 h-5" />
            </button>

            {/* Page title */}
            <div>
              <h1 className="text-sm font-bold text-white">{pageTitle}</h1>
            </div>
          </div>

          {/* Right side — search hint + user */}
          <div className="flex items-center gap-3">
            {isAuthenticated && (
              <>
                <div className="hidden md:flex items-center gap-2 px-3 py-1.5 rounded-xl bg-white/[0.03] border border-white/5 text-neutral-500 text-xs">
                  <Search className="w-3.5 h-3.5" />
                  <span>Search...</span>
                  <kbd className="ml-1 px-1.5 py-0.5 rounded bg-white/5 text-[10px] text-neutral-600 font-mono">/</kbd>
                </div>

                <button className="relative p-2 rounded-xl text-neutral-500 hover:text-white hover:bg-white/5 transition-all">
                  <Bell className="w-4 h-4" />
                  <span className="absolute top-1.5 right-1.5 w-1.5 h-1.5 bg-rose-500 rounded-full" />
                </button>
              </>
            )}

            {isAuthenticated && user ? (
              <Link href="/dashboard" className="flex items-center gap-2.5 pl-1 pr-3 py-1 rounded-xl hover:bg-white/5 transition-all">
                <div className="w-8 h-8 rounded-full bg-indigo-500/15 border border-indigo-500/20 flex items-center justify-center">
                  <span className="text-xs font-bold text-indigo-400">
                    {user.name.charAt(0).toUpperCase()}
                  </span>
                </div>
                <div className="hidden sm:block text-left">
                  <div className="text-xs font-semibold text-white leading-tight">{user.name}</div>
                  <div className="text-[10px] text-neutral-500 capitalize">{userRole}</div>
                </div>
              </Link>
            ) : (
              <Link
                href="/login"
                className="px-4 py-2 rounded-xl text-xs font-semibold bg-indigo-600 hover:bg-indigo-500 text-white transition-all"
              >
                Sign In
              </Link>
            )}
          </div>
        </header>

        {/* Page content */}
        <main className="flex-1 overflow-y-auto">
          {children}
        </main>
      </div>
    </div>
  );
};
