'use client';

import React, { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { registerAuthAccessors } from '../lib/api';

// ─── Types ───────────────────────────────────────────────────────────────────
export type UserRole = 'citizen' | 'ngo' | 'govt' | 'admin';

export interface AuthUser {
  id: number;
  name: string;
  email: string;
  role: UserRole;
}

interface AuthContextType {
  token: string | null;
  user: AuthUser | null;
  isAuthenticated: boolean;
  userRole: UserRole | null;
  login: (email: string, password: string) => Promise<void>;
  register: (name: string, email: string, password: string, role: UserRole) => Promise<void>;
  logout: () => void;
  /** Internal: used by api.ts to read the current token synchronously */
  getToken: () => string | null;
}

// ─── Context ─────────────────────────────────────────────────────────────────
const AuthContext = createContext<AuthContextType | undefined>(undefined);

const BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000';

// ─── Provider ────────────────────────────────────────────────────────────────
export const AuthContextProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null);
  const router = useRouter();

  // Keep a ref so api.ts can read the token synchronously without a context hook
  const tokenRef = useRef<string | null>(null);
  const getToken = useCallback(() => tokenRef.current, []);

  // Wire api.ts module to use our token + logout on 401
  const logoutRef = useRef<() => void>(() => {});
  useEffect(() => {
    logoutRef.current = () => {
      tokenRef.current = null;
      setToken(null);
      setUser(null);
      router.push('/login');
    };
    registerAuthAccessors(getToken, () => logoutRef.current());
  }, [getToken, router]);

  const login = useCallback(async (email: string, password: string) => {
    const res = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });

    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || 'Login failed.');
    }

    tokenRef.current = data.token;
    setToken(data.token);
    setUser(data.user);

    // Route based on role
    if (data.user.role === 'citizen') {
      router.push('/portal');
    } else {
      router.push('/dashboard');
    }
  }, [router]);

  const register = useCallback(async (name: string, email: string, password: string, role: UserRole) => {
    const res = await fetch(`${BASE_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, password, role }),
    });

    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || 'Registration failed.');
    }

    // Auto-login after registration
    await login(email, password);
  }, [login]);

  const logout = useCallback(() => {
    tokenRef.current = null;
    setToken(null);
    setUser(null);
    router.push('/login');
  }, [router]);

  return (
    <AuthContext.Provider
      value={{
        token,
        user,
        isAuthenticated: !!token,
        userRole: user?.role ?? null,
        login,
        register,
        logout,
        getToken,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

// ─── Hook ─────────────────────────────────────────────────────────────────────
export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthContextProvider');
  }
  return context;
};
