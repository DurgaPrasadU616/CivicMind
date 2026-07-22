'use client';

import React, { useState } from 'react';
import { useAuth, UserRole } from '../../context/AuthContext';
import { ShieldAlert, Eye, EyeOff, Loader2, AlertCircle, User, Briefcase, Settings, Shield } from 'lucide-react';

type Mode = 'login' | 'register';

const ROLES: { value: UserRole; label: string; icon: React.ReactNode; color: string }[] = [
  { value: 'citizen',  label: 'Citizen',     icon: <User className="w-4 h-4" />,     color: 'text-emerald-400' },
  { value: 'ngo',      label: 'NGO Officer', icon: <Briefcase className="w-4 h-4" />, color: 'text-indigo-400' },
  { value: 'govt',     label: 'Govt Official',icon: <Settings className="w-4 h-4" />, color: 'text-amber-400' },
  { value: 'admin',    label: 'Admin',        icon: <Shield className="w-4 h-4" />,   color: 'text-rose-400' },
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
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setFieldErrors({});
    setLoading(true);

    try {
      if (mode === 'login') {
        await login(email, password);
      } else {
        await register(name, email, password, role);
      }
    } catch (err: any) {
      const msg: string = err.message || 'Something went wrong.';
      // Backend returns field-level errors for validation failures
      if (msg.includes('Validation failed')) {
        setError('Please fix the highlighted fields.');
      } else {
        setError(msg);
      }
    } finally {
      setLoading(false);
    }
  };

  const inputClass =
    'w-full px-4 py-2.5 bg-neutral-900 border border-neutral-800 rounded-xl text-sm text-white placeholder-neutral-500 focus:outline-none focus:border-emerald-500/50 focus:ring-1 focus:ring-emerald-500/20 transition-all';

  return (
    <div className="flex-1 flex flex-col items-center justify-center px-6 py-16 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-neutral-900 via-neutral-950 to-neutral-950">
      {/* Brand */}
      <div className="text-center mb-8">
        <div className="w-14 h-14 rounded-2xl bg-gradient-to-tr from-emerald-500 to-indigo-600 flex items-center justify-center shadow-2xl mx-auto mb-4 border border-emerald-400/20">
          <ShieldAlert className="w-7 h-7 text-white" />
        </div>
        <h1 className="text-3xl font-extrabold tracking-tight text-white">CivicMind AI</h1>
        <p className="mt-2 text-neutral-400 text-sm">
          {mode === 'login' ? 'Sign in to your account' : 'Create a new account'}
        </p>
      </div>

      {/* Card */}
      <div className="w-full max-w-md glass-panel rounded-2xl border-neutral-800 p-8">
        {/* Mode toggle */}
        <div className="flex bg-neutral-950 p-1 rounded-xl border border-neutral-800 mb-6 select-none">
          {(['login', 'register'] as Mode[]).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => { setMode(m); setError(''); setFieldErrors({}); }}
              className={`flex-1 py-2 rounded-lg text-xs font-semibold transition-all cursor-pointer capitalize ${
                mode === m ? 'bg-neutral-800 text-white' : 'text-neutral-400 hover:text-white'
              }`}
            >
              {m === 'login' ? 'Sign In' : 'Register'}
            </button>
          ))}
        </div>

        {/* Error banner */}
        {error && (
          <div className="flex items-center gap-2 p-3 mb-4 bg-rose-500/10 border border-rose-500/20 rounded-xl text-rose-400 text-xs">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Name — register only */}
          {mode === 'register' && (
            <div>
              <label className="block text-xs font-semibold text-neutral-400 mb-1.5">Full Name</label>
              <input
                id="auth-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Jane Doe"
                autoComplete="name"
                required
                className={inputClass}
              />
            </div>
          )}

          {/* Email */}
          <div>
            <label className="block text-xs font-semibold text-neutral-400 mb-1.5">Email Address</label>
            <input
              id="auth-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@civicmind.gov"
              autoComplete="email"
              required
              className={inputClass}
            />
          </div>

          {/* Password */}
          <div>
            <label className="block text-xs font-semibold text-neutral-400 mb-1.5">
              Password {mode === 'register' && <span className="text-neutral-600 font-normal">(min 8 chars, 1 number)</span>}
            </label>
            <div className="relative">
              <input
                id="auth-password"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={mode === 'register' ? 'secure123' : '••••••••'}
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                required
                className={`${inputClass} pr-10`}
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-2.5 text-neutral-500 hover:text-neutral-300 transition-colors cursor-pointer"
              >
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          {/* Role — register only */}
          {mode === 'register' && (
            <div>
              <label className="block text-xs font-semibold text-neutral-400 mb-1.5">Account Role</label>
              <div className="grid grid-cols-2 gap-2">
                {ROLES.map((r) => (
                  <button
                    key={r.value}
                    type="button"
                    onClick={() => setRole(r.value)}
                    className={`flex items-center gap-2 px-3 py-2 rounded-xl border text-xs font-medium transition-all cursor-pointer ${
                      role === r.value
                        ? 'border-emerald-500/40 bg-emerald-500/10 text-white'
                        : 'border-neutral-800 bg-neutral-900 text-neutral-400 hover:border-neutral-700'
                    }`}
                  >
                    <span className={r.color}>{r.icon}</span>
                    {r.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Submit */}
          <button
            id="auth-submit"
            type="submit"
            disabled={loading}
            className="w-full mt-2 py-3 bg-gradient-to-r from-emerald-600 to-indigo-600 hover:from-emerald-500 hover:to-indigo-500 disabled:opacity-50 text-white font-bold text-sm rounded-xl transition-all cursor-pointer disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {loading ? (
              <><Loader2 className="w-4 h-4 animate-spin" /> {mode === 'login' ? 'Signing in…' : 'Creating account…'}</>
            ) : (
              mode === 'login' ? 'Sign In' : 'Create Account'
            )}
          </button>
        </form>

        {/* Session note */}
        <p className="mt-5 text-center text-[11px] text-neutral-600">
          {mode === 'login'
            ? 'Session ends on page refresh (in-memory token, no localStorage).'
            : 'Already have an account? Switch to Sign In above.'}
        </p>
      </div>
    </div>
  );
}
