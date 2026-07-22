import type { Metadata } from 'next';
import './globals.css';
import { AppContextProvider } from '../context/AppContext';
import { AuthContextProvider } from '../context/AuthContext';
import { Navbar } from '../components/Navbar';

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
    >
      <body className="min-h-full flex flex-col bg-neutral-950 text-neutral-100 selection:bg-emerald-500/20 selection:text-emerald-300">
        <AuthContextProvider>
          <AppContextProvider>
            <Navbar />
            <main className="flex-1 flex flex-col">{children}</main>
          </AppContextProvider>
        </AuthContextProvider>
      </body>
    </html>
  );
}
