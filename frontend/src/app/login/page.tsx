'use client';

import React, { useState } from 'react';
import { useAuth, UserRole } from '../../context/AuthContext';
import { ShieldAlert, Eye, EyeOff, Loader2, AlertCircle, User, Briefcase, Settings, Shield } from 'lucide-react';

type Mode = 'login' | 'register';

const ROLES: { value: UserRole; label: string; icon: React.ReactNode; color: string }[] = [
  { value: 'citizen', label: 'Citizen', icon: <User className="w-4 h-4" />, color: 'text-emerald-400' },
  { value: 'ngo', label: 'NGO Officer', icon: <Briefcase className="w-4 h-4" />, color: 'text-indigo-400' },
  { value: 'govt', label: 'Govt Official', icon: <Settings className="w-4 h-4" />, color: 'text-amber-400' },
  { value: 'admin', label: 'Admin', icon: <Shield className="w-4 h-4" />, color: 'text-rose-400' },
];

export default function LoginPage() {
  const { login, register } = useAuth();
  const [mode, setMode] = useState<Mode>('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<UserRole>('citizen');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      if (mode === 'login') await login(email, password);
      else await register(name, email, password, role);
    } catch (err: any) {
      setError(err.message || 'Something went wrong.');
    } finally {
      setLoading(false);
    }
  };

  const inputClass = 'w-full px-4 py-2.5 bg-white/[0.03] border border-white/[0.06] rounded-xl text-sm text-white placeholder-neutral-500 focus:outline-none focus:border-indigo-500/40 focus:ring-1 focus:ring-indigo-500/10 transition-all';

  return (
    <div className="min-h-screen flex items-center justify-center px-6 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-indigo-950/20 via-[#08080c] to-[#08080c]">
      <div className="w-full max-w-md fade-in">
        {/* Brand */}
        <div className="text-center mb-8">
          <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-indigo-500 to-blue-600 flex items-center justify-center shadow-2xl shadow-indigo-500/20 mx-auto mb-4 border border-indigo-400/20">
            <ShieldAlert className="w-7 h-7 text-white" />
          </div>
          <h1 className="text-2xl font-extrabold tracking-tight text-white">CivicMind AI</h1>
          <p className="mt-2 text-neutral-500 text-sm">
            {mode === 'login' ? 'Sign in to your account' : 'Create a new account'}
          </p>
        </div>

        {/* Card */}
        <div className="cm-card p-8" suppressHydrationWarning>
          {/* Mode toggle */}
          <div className="flex bg-white/[0.03] p-1 rounded-xl border border-white/5 mb-6 select-none">
            {(['login', 'register'] as Mode[]).map((m) => (
              <button
                key={m}
                type="button"
                suppressHydrationWarning
                onClick={() => { setMode(m); setError(''); }}
                className={`flex-1 py-2 rounded-lg text-xs font-semibold transition-all cursor-pointer capitalize ${
                  mode === m ? 'bg-white/5 text-white shadow-sm' : 'text-neutral-500 hover:text-white'
                }`}
              >
                {m === 'login' ? 'Sign In' : 'Register'}
              </button>
            ))}
          </div>

          {error && (
            <div className="flex items-center gap-2 p-3 mb-4 bg-rose-500/10 border border-rose-500/20 rounded-xl text-rose-400 text-xs">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4" suppressHydrationWarning>
            {mode === 'register' && (
              <div>
                <label className="block text-xs font-semibold text-neutral-400 mb-1.5">Full Name</label>
                <input id="auth-name" type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Jane Doe" autoComplete="name" required suppressHydrationWarning className={inputClass} />
              </div>
            )}

            <div>
              <label className="block text-xs font-semibold text-neutral-400 mb-1.5">Email Address</label>
              <input id="auth-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@civicmind.gov" autoComplete="email" required suppressHydrationWarning className={inputClass} />
            </div>

            <div>
              <label className="block text-xs font-semibold text-neutral-400 mb-1.5">
                Password {mode === 'register' && <span className="text-neutral-600 font-normal">(min 8 chars, 1 number)</span>}
              </label>
              <div className="relative">
                <input id="auth-password" type={showPassword ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)} placeholder={mode === 'register' ? 'secure123' : '••••••••'} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required suppressHydrationWarning className={`${inputClass} pr-10`} />
                <button type="button" onClick={() => setShowPassword(!showPassword)} suppressHydrationWarning className="absolute right-3 top-2.5 text-neutral-500 hover:text-neutral-300 transition-colors cursor-pointer">
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {mode === 'register' && (
              <div>
                <label className="block text-xs font-semibold text-neutral-400 mb-1.5">Account Role</label>
                <div className="grid grid-cols-2 gap-2">
                  {ROLES.map((r) => (
                    <button key={r.value} type="button" onClick={() => setRole(r.value)} suppressHydrationWarning className={`flex items-center gap-2 px-3 py-2 rounded-xl border text-xs font-medium transition-all cursor-pointer ${
                      role === r.value ? 'border-indigo-500/30 bg-indigo-500/10 text-white' : 'border-white/5 bg-white/[0.02] text-neutral-400 hover:border-white/10'
                    }`}>
                      <span className={r.color}>{r.icon}</span>
                      {r.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <button id="auth-submit" type="submit" disabled={loading} suppressHydrationWarning className="w-full mt-2 py-3 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-bold text-sm rounded-xl transition-all cursor-pointer disabled:cursor-not-allowed flex items-center justify-center gap-2">
              {loading ? (
                <><Loader2 className="w-4 h-4 animate-spin" /> {mode === 'login' ? 'Signing in...' : 'Creating account...'}</>
              ) : (
                mode === 'login' ? 'Sign In' : 'Create Account'
              )}
            </button>
          </form>

          <p className="mt-5 text-center text-[11px] text-neutral-600">
            {mode === 'login' ? 'In-memory token — session ends on page refresh.' : 'Already have an account? Switch to Sign In above.'}
          </p>
        </div>
      </div>
    </div>
  );
}
