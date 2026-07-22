'use client';

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { apiClient, ApiError } from '../../lib/api';
import { MapPin, Send, AlertTriangle, CheckCircle2, RefreshCw, WifiOff, FileText } from 'lucide-react';

export default function PortalPage() {
  const router = useRouter();
  const [text, setText] = useState('');
  const [category, setCategory] = useState<'infrastructure' | 'sanitation' | 'utility' | 'noise' | 'safety' | 'other'>('infrastructure');
  const [latitude, setLatitude] = useState('');
  const [longitude, setLongitude] = useState('');
  const [contactName, setContactName] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [simulateFail, setSimulateFail] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitSuccess, setSubmitSuccess] = useState<{ category?: string; text?: string; complaintId?: string; id?: string } | null>(null);
  const [networkErrorCount, setNetworkErrorCount] = useState(0);

  useEffect(() => {
    if (typeof window !== 'undefined') queueMicrotask(() => setIdempotencyKey(crypto.randomUUID()));
  }, [submitSuccess]);

  const handleGetLocation = () => {
    setLatitude((12.9400 + Math.random() * 0.05).toFixed(6));
    setLongitude((77.5600 + Math.random() * 0.08).toFixed(6));
    if (errors.location) { const n = { ...errors }; delete n.location; setErrors(n); }
  };

  const validate = () => {
    const e: Record<string, string> = {};
    if (!text.trim()) e.text = 'Please describe the issue.';
    else if (text.length > 5000) e.text = 'Max 5000 characters.';
    if (latitude || longitude) {
      const lat = parseFloat(latitude), lng = parseFloat(longitude);
      if (isNaN(lat) || lat < -90 || lat > 90) e.location = 'Invalid latitude.';
      else if (isNaN(lng) || lng < -180 || lng > 180) e.location = 'Invalid longitude.';
    }
    if (contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) e.email = 'Invalid email.';
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validate()) return;
    setIsSubmitting(true);
    setErrors({});
    await new Promise(r => setTimeout(r, 800));

    if (simulateFail && networkErrorCount < 1) {
      setNetworkErrorCount(n => n + 1);
      setIsSubmitting(false);
      setErrors({ network: 'Simulated timeout. Retry to resubmit with same idempotency key.' });
      return;
    }

    try {
      const result = await apiClient.submitComplaint({
        text: text.trim(), category,
        latitude: latitude ? parseFloat(latitude) : null,
        longitude: longitude ? parseFloat(longitude) : null,
        idempotencyKey,
        metaData: { contactName: contactName.trim() || undefined, contactEmail: contactEmail.trim() || undefined },
      });
      const data = result.data as { category?: string; text?: string; complaintId?: string; id?: string };
      setSubmitSuccess(data);
      setNetworkErrorCount(0);
      setErrors({});
      setTimeout(() => router.push(`/track?id=${data.id || data.complaintId || ''}`), 2500);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 409) setErrors({ duplicate: err.message });
        else if (err.status === 429) setErrors({ rateLimit: err.message });
        else if (err.status === 400 && err.details) {
          const f: Record<string, string> = {};
          err.details.forEach(d => { f[d.path] = d.message; });
          setErrors(f);
        } else setErrors({ server: err.message });
      } else {
        setErrors({ server: 'Unable to connect to backend.' });
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleReset = () => {
    setText(''); setCategory('infrastructure'); setLatitude(''); setLongitude('');
    setContactName(''); setContactEmail(''); setSubmitSuccess(null); setErrors({}); setNetworkErrorCount(0);
  };

  return (
    <div className="p-6 lg:p-8 max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-xl font-bold text-white flex items-center gap-2">
          <FileText className="w-5 h-5 text-indigo-400" />
          Report a Civic Issue
        </h1>
        <p className="text-sm text-neutral-500 mt-1">
          Submit complaints about infrastructure, sanitation, utilities, or safety. Data is persisted to PostgreSQL and auto-clustered with AI.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Form */}
        <div className="lg:col-span-2 cm-card p-6 lg:p-8">
          {submitSuccess ? (
            <div className="text-center py-10 fade-in">
              <div className="w-16 h-16 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 rounded-full flex items-center justify-center mx-auto mb-5">
                <CheckCircle2 className="w-8 h-8" />
              </div>
              <h2 className="text-lg font-bold text-white mb-2">Complaint Logged!</h2>
              <p className="text-neutral-400 text-sm mb-5">
                Reference: <span className="font-mono text-indigo-400 font-bold">CM-{submitSuccess.id}</span>
              </p>
              <div className="cm-card-sm p-4 text-left max-w-md mx-auto mb-5">
                <div className="flex items-center justify-between text-xs text-neutral-400 mb-2">
                  <span>Category</span>
                  <span className="font-semibold uppercase text-neutral-200">{submitSuccess.category}</span>
                </div>
                <p className="text-sm text-neutral-300 italic line-clamp-2">&quot;{submitSuccess?.text}&quot;</p>
              </div>
              <p className="text-xs text-neutral-500 animate-pulse mb-4">Redirecting to tracker...</p>
              <button onClick={handleReset} className="px-4 py-2 bg-white/5 border border-white/5 text-neutral-300 hover:text-white rounded-xl text-sm transition-all cursor-pointer">
                File Another
              </button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-5">
              {errors.network && (
                <div className="p-3 bg-amber-500/10 border border-amber-500/20 rounded-xl text-xs text-amber-400 flex gap-2 items-start">
                  <WifiOff className="w-4 h-4 shrink-0 mt-0.5" /> <span>{errors.network}</span>
                </div>
              )}
              {errors.duplicate && (
                <div className="p-3 bg-amber-500/10 border border-amber-500/20 rounded-xl text-xs text-amber-400 flex gap-2 items-start">
                  <AlertTriangle className="w-4 h-4 shrink-0" /> <span>{errors.duplicate}</span>
                </div>
              )}
              {errors.rateLimit && (
                <div className="p-3 bg-rose-500/10 border border-rose-500/20 rounded-xl text-xs text-rose-400 flex gap-2 items-center">
                  <AlertTriangle className="w-4 h-4" /> <span>{errors.rateLimit}</span>
                </div>
              )}
              {errors.server && (
                <div className="p-3 bg-rose-500/10 border border-rose-500/20 rounded-xl text-xs text-rose-400 flex gap-2 items-center">
                  <AlertTriangle className="w-4 h-4" /> <span>{errors.server}</span>
                </div>
              )}

              <div>
                <label className="block text-xs font-semibold text-neutral-400 mb-1.5">Description <span className="text-rose-500">*</span></label>
                <textarea
                  value={text} onChange={(e) => { setText(e.target.value); if (errors.text) { const n = { ...errors }; delete n.text; setErrors(n); } }}
                  rows={4} maxLength={5000}
                  className={`w-full px-4 py-3 bg-white/[0.03] border rounded-xl text-sm text-white placeholder-neutral-500 focus:outline-none focus:ring-1 focus:ring-indigo-500/20 transition-all ${
                    errors.text ? 'border-rose-500/50' : 'border-white/[0.06] focus:border-indigo-500/40'
                  }`}
                  placeholder="Describe the issue..."
                />
                <div className="flex justify-between mt-1 text-[11px]">
                  <span className="text-rose-500/70">{errors.text}</span>
                  <span className="text-neutral-600">{text.length}/5000</span>
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-neutral-400 mb-1.5">Category <span className="text-rose-500">*</span></label>
                <select value={category} onChange={(e) => setCategory(e.target.value as 'infrastructure' | 'sanitation' | 'utility' | 'noise' | 'safety' | 'other')} className="w-full px-4 py-3 bg-white/[0.03] border border-white/[0.06] rounded-xl text-sm text-white focus:outline-none focus:border-indigo-500/40 transition-all">
                  <option value="infrastructure">Infrastructure (Roads, Bridges)</option>
                  <option value="sanitation">Sanitation (Garbage, Drainage)</option>
                  <option value="utility">Utility (Water, Power, Streetlights)</option>
                  <option value="noise">Noise (Loudspeakers, Construction)</option>
                  <option value="safety">Public Safety (Hazards, Crime)</option>
                  <option value="other">Other</option>
                </select>
              </div>

              <div>
                <div className="flex justify-between items-center mb-1.5">
                  <label className="text-xs font-semibold text-neutral-400">Coordinates <span className="text-neutral-600 font-normal">(optional)</span></label>
                  <button type="button" onClick={handleGetLocation} className="flex items-center gap-1 text-[11px] font-bold text-indigo-400 hover:text-indigo-300 transition-all cursor-pointer">
                    <MapPin className="w-3 h-3" /> Mock GPS
                  </button>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <input type="text" placeholder="Latitude" value={latitude} onChange={(e) => { setLatitude(e.target.value); if (errors.location) { const n = { ...errors }; delete n.location; setErrors(n); } }} className="px-4 py-3 bg-white/[0.03] border border-white/[0.06] rounded-xl text-sm text-white focus:outline-none" />
                  <input type="text" placeholder="Longitude" value={longitude} onChange={(e) => { setLongitude(e.target.value); if (errors.location) { const n = { ...errors }; delete n.location; setErrors(n); } }} className="px-4 py-3 bg-white/[0.03] border border-white/[0.06] rounded-xl text-sm text-white focus:outline-none" />
                </div>
                {errors.location && <p className="mt-1 text-xs text-rose-500/70">{errors.location}</p>}
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-neutral-400 mb-1.5">Contact Name <span className="text-neutral-600 font-normal">(optional)</span></label>
                  <input type="text" placeholder="Jane Doe" value={contactName} onChange={(e) => setContactName(e.target.value)} className="w-full px-4 py-3 bg-white/[0.03] border border-white/[0.06] rounded-xl text-sm text-white focus:outline-none" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-neutral-400 mb-1.5">Contact Email <span className="text-neutral-600 font-normal">(optional)</span></label>
                  <input type="text" placeholder="jane@example.com" value={contactEmail} onChange={(e) => { setContactEmail(e.target.value); if (errors.email) { const n = { ...errors }; delete n.email; setErrors(n); } }} className={`w-full px-4 py-3 bg-white/[0.03] border rounded-xl text-sm text-white focus:outline-none ${errors.email ? 'border-rose-500/50' : 'border-white/[0.06]'}`} />
                  {errors.email && <p className="mt-1 text-xs text-rose-500/70">{errors.email}</p>}
                </div>
              </div>

              <button type="submit" disabled={isSubmitting} className="w-full py-3 bg-indigo-600 hover:bg-indigo-500 disabled:bg-indigo-600/30 text-white font-bold text-sm rounded-xl transition-all cursor-pointer disabled:cursor-not-allowed flex items-center justify-center gap-2">
                {isSubmitting ? <><RefreshCw className="w-4 h-4 animate-spin" /> Submitting...</> : <><Send className="w-4 h-4" /> Submit Complaint</>}
              </button>
            </form>
          )}
        </div>

        {/* Side panels */}
        <div className="space-y-4">
          <div className="cm-card p-5">
            <h3 className="text-xs font-bold text-neutral-300 uppercase tracking-wider mb-3 flex items-center gap-2">
              <div className="w-1.5 h-3 rounded-full bg-indigo-500" /> Idempotency
            </h3>
            <p className="text-[11px] text-neutral-500 leading-relaxed mb-3">
              A UUID token prevents duplicate rows on retry. Same key = same result.
            </p>
            <div className="bg-white/[0.02] p-3 rounded-lg border border-white/5 select-all">
              <div className="text-[9px] text-neutral-600 font-bold uppercase mb-1">Key</div>
              <div className="font-mono text-[11px] text-indigo-400/80 break-all">{idempotencyKey || 'generating...'}</div>
            </div>
          </div>

          <div className="cm-card p-5">
            <h3 className="text-xs font-bold text-neutral-300 uppercase tracking-wider mb-3 flex items-center gap-2">
              <div className="w-1.5 h-3 rounded-full bg-amber-500" /> Simulation
            </h3>
            <p className="text-[11px] text-neutral-500 leading-relaxed mb-3">
              Test retry behavior under simulated network failure.
            </p>
            <label className="flex items-center gap-3 justify-between p-3 bg-white/[0.02] border border-white/5 rounded-xl cursor-pointer select-none">
              <div>
                <span className="text-xs font-semibold text-neutral-300">Simulate Offline</span>
                <p className="text-[10px] text-neutral-600 mt-0.5">Triggers timeout on first submit.</p>
              </div>
              <input type="checkbox" checked={simulateFail} onChange={() => { setSimulateFail(!simulateFail); setNetworkErrorCount(0); }} className="w-4 h-4 accent-indigo-500" />
            </label>
          </div>

          <div className="cm-card p-5">
            <h3 className="text-xs font-bold text-neutral-300 uppercase tracking-wider mb-3 flex items-center gap-2">
              <div className="w-1.5 h-3 rounded-full bg-emerald-500" /> How it works
            </h3>
            <div className="space-y-2 text-[11px] text-neutral-500">
              <div className="flex items-start gap-2"><span className="text-indigo-400 font-bold">1.</span> Your complaint is written to PostgreSQL</div>
              <div className="flex items-start gap-2"><span className="text-indigo-400 font-bold">2.</span> AI generates a 1536-dim embedding vector</div>
              <div className="flex items-start gap-2"><span className="text-indigo-400 font-bold">3.</span> pgvector finds the closest cluster by cosine similarity</div>
              <div className="flex items-start gap-2"><span className="text-indigo-400 font-bold">4.</span> Severity + priority scores are recalculated</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
