'use client';

import React, { useState } from 'react';
import { useAuth, UserRole } from '../../context/AuthContext';
import { ShieldAlert, Eye, EyeOff, Loader2, AlertCircle, User, Briefcase, Settings, Shield } from 'lucide-react';
import { Card, CardContent } from '../../components/ui/card';
import { Input } from '../../components/ui/input';
import { Button } from '../../components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '../../components/ui/tabs';

type Mode = 'login' | 'register';

const ROLES: { value: UserRole; label: string; icon: React.ReactNode }[] = [
  { value: 'citizen', label: 'Citizen', icon: <User className="w-4 h-4" /> },
  { value: 'ngo', label: 'NGO Officer', icon: <Briefcase className="w-4 h-4" /> },
  { value: 'govt', label: 'Govt Official', icon: <Settings className="w-4 h-4" /> },
  { value: 'admin', label: 'Admin', icon: <Shield className="w-4 h-4" /> },
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
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : typeof err === 'object' && err !== null && 'message' in err ? String((err as { message: unknown }).message) : '';
      if (message.includes('Invalid') || message.includes('invalid') || message.includes('not found')) {
        setError('Invalid email or password. Please try again.');
      } else if (message.includes('already exists') || message.includes('already registered')) {
        setError('An account with this email already exists.');
      } else if (message.includes('password') && message.toLowerCase().includes('weak')) {
        setError('Password does not meet security requirements (min 8 characters, 1 number).');
      } else if (message.includes('network') || message.includes('connect') || message.includes('fetch')) {
        setError('Unable to connect. Please check your internet connection.');
      } else {
        setError(message || 'Something went wrong. Please try again.');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center px-6 bg-base">
      <div className="w-full max-w-md fade-in">
        <div className="text-center mb-8">
          <div className="w-14 h-14 rounded-lg bg-indigo-600 flex items-center justify-center mx-auto mb-4">
            <ShieldAlert className="w-7 h-7 text-white" />
          </div>
          <h1 className="text-2xl font-extrabold tracking-tight text-white">CivicMind AI</h1>
          <p className="mt-2 text-neutral-500 text-sm">
            {mode === 'login' ? 'Sign in to your account' : 'Create a new account'}
          </p>
        </div>

        <Card>
          <CardContent className="p-8" suppressHydrationWarning>
            <Tabs value={mode} onValueChange={(v) => { setMode(v as Mode); setError(''); }}>
              <TabsList className="grid grid-cols-2 mb-6">
                <TabsTrigger value="login">Sign In</TabsTrigger>
                <TabsTrigger value="register">Register</TabsTrigger>
              </TabsList>
            </Tabs>

            {error && (
              <div className="flex items-center gap-2 p-3 mb-4 bg-red-500/10 border border-red-500/20 rounded-lg text-red-400 text-xs">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-4" suppressHydrationWarning>
              {mode === 'register' && (
                <div>
                  <label className="block text-xs font-semibold text-neutral-400 mb-1.5">Full Name</label>
                  <Input id="auth-name" type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Jane Doe" autoComplete="name" required suppressHydrationWarning />
                </div>
              )}

              <div>
                <label className="block text-xs font-semibold text-neutral-400 mb-1.5">Email Address</label>
                <Input id="auth-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@civicmind.gov" autoComplete="email" required suppressHydrationWarning />
              </div>

              <div>
                <label className="block text-xs font-semibold text-neutral-400 mb-1.5">
                  Password {mode === 'register' && <span className="text-neutral-600 font-normal">(min 8 chars, 1 number)</span>}
                </label>
                <div className="relative">
                  <Input id="auth-password" type={showPassword ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)} placeholder={mode === 'register' ? 'secure123' : '••••••••'} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required suppressHydrationWarning className="pr-10" />
                  <Button type="button" variant="ghost" size="icon" onClick={() => setShowPassword(!showPassword)} suppressHydrationWarning className="absolute right-1 top-1 text-neutral-500 hover:text-neutral-300">
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </Button>
                </div>
              </div>

              {mode === 'register' && (
                <div>
                  <label className="block text-xs font-semibold text-neutral-400 mb-1.5">Account Role</label>
                  <div className="grid grid-cols-2 gap-2">
                    {ROLES.map((r) => (
                      <Button
                        key={r.value}
                        type="button"
                        variant={role === r.value ? 'default' : 'outline'}
                        size="sm"
                        onClick={() => setRole(r.value)}
                        suppressHydrationWarning
                        className="justify-start"
                      >
                        {r.icon}
                        {r.label}
                      </Button>
                    ))}
                  </div>
                </div>
              )}

              <Button id="auth-submit" type="submit" disabled={loading} className="w-full mt-2" suppressHydrationWarning>
                {loading ? (
                  <><Loader2 className="w-4 h-4 animate-spin" /> {mode === 'login' ? 'Signing in...' : 'Creating account...'}</>
                ) : (
                  mode === 'login' ? 'Sign In' : 'Create Account'
                )}
              </Button>
            </form>

            <p className="mt-5 text-center text-[11px] text-neutral-600">
              {mode === 'login' ? 'In-memory token \u2014 session ends on page refresh.' : 'Already have an account? Switch to Sign In above.'}
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
