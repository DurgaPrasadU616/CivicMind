import type { Metadata } from 'next';
import './globals.css';
import { AppContextProvider } from '../context/AppContext';
import { AuthContextProvider } from '../context/AuthContext';
import { AppShell } from '../components/AppShell';

export const metadata: Metadata = {
  title: 'CivicMind AI - Smart Ingestion & Dashboard',
  description: 'Ingest civic complaints, cluster similar issues, and prioritize local NGO and Govt action plans.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className="h-full antialiased dark"
      style={{ colorScheme: 'dark' }}
      suppressHydrationWarning
    >
      <body className="min-h-full bg-[#08080c] text-neutral-100 selection:bg-indigo-500/20 selection:text-indigo-300" suppressHydrationWarning>
        <AuthContextProvider>
          <AppContextProvider>
            <AppShell>{children}</AppShell>
          </AppContextProvider>
        </AuthContextProvider>
      </body>
    </html>
  );
}
