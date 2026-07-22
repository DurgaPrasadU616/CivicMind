'use client';

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { apiClient, ApiError } from '../../lib/api';
import { MapPin, Send, AlertTriangle, CheckCircle2, RefreshCw, WifiOff } from 'lucide-react';

export default function PortalPage() {
  const router = useRouter();

  // Form states
  const [text, setText] = useState('');
  const [category, setCategory] = useState<'infrastructure' | 'sanitation' | 'utility' | 'noise' | 'safety' | 'other'>('infrastructure');
  const [latitude, setLatitude] = useState<string>('');
  const [longitude, setLongitude] = useState<string>('');
  const [contactName, setContactName] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  
  // Simulation switches
  const [simulateFail, setSimulateFail] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState('');

  // UI status states
  const [errors, setErrors] = useState<{ [key: string]: string }>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitSuccess, setSubmitSuccess] = useState<any>(null);
  const [networkErrorCount, setNetworkErrorCount] = useState(0);

  // Generate an idempotency key when the form is mounted or after successful submission
  useEffect(() => {
    if (typeof window !== 'undefined') {
      setIdempotencyKey(crypto.randomUUID());
    }
  }, [submitSuccess]);

  // Mock Geolocation generator inside Metro City bounds
  const handleGetLocation = () => {
    const mockLat = (12.9400 + Math.random() * 0.05).toFixed(6);
    const mockLng = (77.5600 + Math.random() * 0.08).toFixed(6);
    setLatitude(mockLat);
    setLongitude(mockLng);
    
    if (errors.location) {
      const newErrors = { ...errors };
      delete newErrors.location;
      setErrors(newErrors);
    }
  };

  const validate = () => {
    const newErrors: { [key: string]: string } = {};

    if (!text.trim()) {
      newErrors.text = 'Please describe the issue in detail.';
    } else if (text.length > 5000) {
      newErrors.text = 'Description is too long (maximum 5000 characters).';
    }

    if (latitude || longitude) {
      const latVal = parseFloat(latitude);
      const lngVal = parseFloat(longitude);
      if (isNaN(latVal) || latVal < -90 || latVal > 90) {
        newErrors.location = 'Latitude must be a valid number between -90 and 90.';
      } else if (isNaN(lngVal) || lngVal < -180 || lngVal > 180) {
        newErrors.location = 'Longitude must be a valid number between -180 and 180.';
      }
    }

    if (contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) {
      newErrors.email = 'Please enter a valid email address.';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validate()) return;

    setIsSubmitting(true);
    setErrors({});

    // Simulate submission delay
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Handle Network Failure Simulation
    if (simulateFail && networkErrorCount < 1) {
      setNetworkErrorCount(networkErrorCount + 1);
      setIsSubmitting(false);
      setErrors({
        network: 'Simulated connection timeout. Click submit again to retry. The form is preserving your idempotency key to prevent duplicates.',
      });
      return;
    }

    // Success E2E API flow
    try {
      const payload = {
        text: text.trim(),
        category,
        latitude: latitude ? parseFloat(latitude) : null,
        longitude: longitude ? parseFloat(longitude) : null,
        idempotencyKey,
        metaData: {
          contactName: contactName.trim() || undefined,
          contactEmail: contactEmail.trim() || undefined,
          userAgent: typeof window !== 'undefined' ? navigator.userAgent : 'Server',
        },
      };

      const result = await apiClient.submitComplaint(payload);
      
      setSubmitSuccess(result.data);
      setNetworkErrorCount(0);
      setErrors({});
      
      // Auto redirect to tracking page after 2.5 seconds
      setTimeout(() => {
        router.push(`/track?id=${result.data.id}`);
      }, 2500);
    } catch (err) {
      console.error('Submission failed:', err);
      if (err instanceof ApiError) {
        if (err.status === 409) {
          setErrors({ duplicate: err.message });
        } else if (err.status === 429) {
          setErrors({ rateLimit: err.message });
        } else if (err.status === 400 && err.details) {
          // Map Zod validations back to corresponding fields
          const fieldErrs: { [key: string]: string } = {};
          err.details.forEach((d) => {
            fieldErrs[d.path] = d.message;
          });
          setErrors(fieldErrs);
        } else {
          setErrors({ server: err.message });
        }
      } else {
        setErrors({ server: 'Unable to connect to the backend server. Please verify the API is running.' });
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleReset = () => {
    setText('');
    setCategory('infrastructure');
    setLatitude('');
    setLongitude('');
    setContactName('');
    setContactEmail('');
    setSubmitSuccess(null);
    setErrors({});
    setNetworkErrorCount(0);
  };

  return (
    <div className="max-w-4xl mx-auto px-6 py-12">
      {/* Header */}
      <div className="text-center mb-10">
        <h1 className="text-3xl font-extrabold tracking-tight bg-gradient-to-r from-white via-neutral-100 to-neutral-500 bg-clip-text text-transparent sm:text-4xl">
          Report a Civic Issue
        </h1>
        <p className="mt-3 text-neutral-400 max-w-lg mx-auto text-sm">
          Submit local complaints such as broken roads, garbage dumping, or utility leaks. The form connects to our Express/PostgreSQL API.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Form Panel */}
        <div className="lg:col-span-2 glass-panel p-8 rounded-2xl border-neutral-800">
          {submitSuccess ? (
            <div className="text-center py-10 animate-in fade-in duration-300">
              <div className="w-16 h-16 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 rounded-full flex items-center justify-center mx-auto mb-6">
                <CheckCircle2 className="w-8 h-8" />
              </div>
              <h2 className="text-2xl font-bold text-white mb-2">Complaint Logged!</h2>
              <p className="text-neutral-400 text-sm mb-6">
                Database reference ID: <span className="font-mono text-emerald-400 font-bold">CM-{submitSuccess.id}</span>
              </p>
              <div className="p-4 bg-neutral-900/50 rounded-xl border border-neutral-800/50 text-left mb-6 max-w-md mx-auto">
                <div className="flex items-center justify-between text-xs text-neutral-400 mb-2">
                  <span>Category</span>
                  <span className="font-semibold uppercase text-neutral-200">{submitSuccess.category}</span>
                </div>
                <div className="text-sm text-neutral-300 line-clamp-3 italic mb-2">
                  "{submitSuccess.text}"
                </div>
                <div className="flex items-center justify-between text-xs text-neutral-500 pt-2 border-t border-neutral-800/80">
                  <span>Location</span>
                  <span>
                    {submitSuccess.latitude && submitSuccess.longitude
                      ? `${parseFloat(submitSuccess.latitude).toFixed(4)}, ${parseFloat(submitSuccess.longitude).toFixed(4)}`
                      : 'Not provided'}
                  </span>
                </div>
              </div>
              <p className="text-xs text-neutral-500 animate-pulse">
                Redirecting to E2E Tracking Center...
              </p>
              <button
                onClick={handleReset}
                className="mt-6 px-4 py-2 bg-neutral-900 border border-neutral-800 text-neutral-300 hover:text-white rounded-xl text-sm transition-all"
              >
                File Another Complaint
              </button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-6">
              {/* Errors notifications */}
              {errors.network && (
                <div className="p-4 bg-amber-500/10 border border-amber-500/20 rounded-xl text-sm text-amber-400 flex gap-3 items-start animate-shake">
                  <WifiOff className="w-5 h-5 shrink-0 mt-0.5" />
                  <div>
                    <span className="font-semibold">Simulated Timeout:</span> {errors.network}
                  </div>
                </div>
              )}
              {errors.duplicate && (
                <div className="p-4 bg-amber-500/10 border border-amber-500/20 rounded-xl text-sm text-amber-400 flex gap-3 items-start">
                  <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" />
                  <div>
                    <span className="font-semibold">Duplicate Blocked:</span> {errors.duplicate}
                  </div>
                </div>
              )}
              {errors.rateLimit && (
                <div className="p-4 bg-rose-500/10 border border-rose-500/20 rounded-xl text-sm text-rose-400 flex gap-2 items-center">
                  <AlertTriangle className="w-5 h-5" />
                  <span>{errors.rateLimit}</span>
                </div>
              )}
              {errors.server && (
                <div className="p-4 bg-rose-500/10 border border-rose-500/20 rounded-xl text-sm text-rose-400 flex gap-2 items-center">
                  <AlertTriangle className="w-5 h-5" />
                  <span>{errors.server}</span>
                </div>
              )}

              {/* Description Text */}
              <div>
                <label className="block text-sm font-medium text-neutral-300 mb-2">
                  Description of Complaint <span className="text-rose-500">*</span>
                </label>
                <textarea
                  value={text}
                  onChange={(e) => {
                    setText(e.target.value);
                    if (errors.text) {
                      const newErrs = { ...errors };
                      delete newErrs.text;
                      setErrors(newErrs);
                    }
                  }}
                  rows={4}
                  maxLength={5000}
                  className={`w-full px-4 py-3 bg-neutral-950/80 border rounded-xl text-sm text-white placeholder-neutral-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 transition-all ${
                    errors.text ? 'border-rose-500/50' : 'border-neutral-800 focus:border-emerald-500'
                  }`}
                  placeholder="Describe the issue, e.g., 'Broken sewer pipe causing massive leakage on Main Road.'"
                />
                <div className="flex justify-between mt-1 text-[11px]">
                  <span className="text-rose-500/70">{errors.text}</span>
                  <span className="text-neutral-500">
                    {text.length}/5000 characters
                  </span>
                </div>
              </div>

              {/* Category selector */}
              <div>
                <label className="block text-sm font-medium text-neutral-300 mb-2">
                  Complaint Category <span className="text-rose-500">*</span>
                </label>
                <select
                  value={category}
                  onChange={(e) => setCategory(e.target.value as any)}
                  className="w-full px-4 py-3 bg-neutral-950 border border-neutral-800 rounded-xl text-sm text-white focus:outline-none focus:ring-1 focus:ring-emerald-500 focus:border-emerald-500 transition-all"
                >
                  <option value="infrastructure">🛣️ Infrastructure (Roads, Pavement, Bridges)</option>
                  <option value="sanitation">🧹 Sanitation (Garbage piling, Litter, Drain blockage)</option>
                  <option value="utility">🚰 Utility (Water pipeline burst, Power cuts, Streetlight dead)</option>
                  <option value="noise">🔊 Noise (Loudspeakers, Construction late hours)</option>
                  <option value="safety">🛡️ Public Safety (Dark alleyway, Open manhole, Hazard)</option>
                  <option value="other">⚙️ Other issues</option>
                </select>
              </div>

              {/* Coordinates inputs */}
              <div>
                <div className="flex justify-between items-center mb-2">
                  <label className="text-sm font-medium text-neutral-300">
                    Location Coordinates <span className="text-neutral-500 text-xs font-normal">(Optional)</span>
                  </label>
                  <button
                    type="button"
                    onClick={handleGetLocation}
                    className="flex items-center gap-1 text-[11px] font-bold uppercase text-emerald-400 hover:text-emerald-300 transition-all cursor-pointer"
                  >
                    <MapPin className="w-3 h-3" />
                    <span>Mock GPS Coordinates</span>
                  </button>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <input
                    type="text"
                    placeholder="Latitude (e.g. 12.9716)"
                    value={latitude}
                    onChange={(e) => {
                      setLatitude(e.target.value);
                      if (errors.location) {
                        const newErrs = { ...errors };
                        delete newErrs.location;
                        setErrors(newErrs);
                      }
                    }}
                    className="px-4 py-3 bg-neutral-950/80 border border-neutral-800 rounded-xl text-sm text-white focus:outline-none"
                  />
                  <input
                    type="text"
                    placeholder="Longitude (e.g. 77.5946)"
                    value={longitude}
                    onChange={(e) => {
                      setLongitude(e.target.value);
                      if (errors.location) {
                        const newErrs = { ...errors };
                        delete newErrs.location;
                        setErrors(newErrs);
                      }
                    }}
                    className="px-4 py-3 bg-neutral-950/80 border border-neutral-800 rounded-xl text-sm text-white focus:outline-none"
                  />
                </div>
                {errors.location && (
                  <p className="mt-1.5 text-xs text-rose-500/70">{errors.location}</p>
                )}
              </div>

              {/* Contact info (optional) */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-neutral-300 mb-2">
                    Contact Name <span className="text-neutral-500 text-xs font-normal">(Optional)</span>
                  </label>
                  <input
                    type="text"
                    placeholder="John Doe"
                    value={contactName}
                    onChange={(e) => setContactName(e.target.value)}
                    className="w-full px-4 py-3 bg-neutral-950/80 border border-neutral-800 rounded-xl text-sm text-white focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-neutral-300 mb-2">
                    Contact Email <span className="text-neutral-500 text-xs font-normal">(Optional)</span>
                  </label>
                  <input
                    type="text"
                    placeholder="john@example.com"
                    value={contactEmail}
                    onChange={(e) => {
                      setContactEmail(e.target.value);
                      if (errors.email) {
                        const newErrs = { ...errors };
                        delete newErrs.email;
                        setErrors(newErrs);
                      }
                    }}
                    className={`w-full px-4 py-3 bg-neutral-950/80 border rounded-xl text-sm text-white focus:outline-none ${
                      errors.email ? 'border-rose-500/50' : 'border-neutral-800'
                    }`}
                  />
                  {errors.email && <p className="mt-1 text-xs text-rose-500/70">{errors.email}</p>}
                </div>
              </div>

              {/* Action row */}
              <div className="pt-2">
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="w-full bg-emerald-500 hover:bg-emerald-600 disabled:bg-emerald-500/40 text-neutral-950 font-bold py-3.5 px-6 rounded-xl transition-all shadow-lg shadow-emerald-500/10 flex items-center justify-center gap-2 cursor-pointer disabled:cursor-not-allowed"
                >
                  {isSubmitting ? (
                    <>
                      <RefreshCw className="w-5 h-5 animate-spin" />
                      <span>Writing to Database...</span>
                    </>
                  ) : (
                    <>
                      <Send className="w-4 h-4" />
                      <span>Submit Complaint</span>
                    </>
                  )}
                </button>
              </div>
            </form>
          )}
        </div>

        {/* Side Panel: Info & Simulation Settings */}
        <div className="space-y-6">
          {/* Metadata/Token panel */}
          <div className="glass-panel p-6 rounded-2xl border-neutral-800">
            <h3 className="text-sm font-bold text-white uppercase tracking-wider mb-4 flex items-center gap-2">
              <div className="w-1.5 h-3 rounded-full bg-emerald-500" />
              <span>Idempotency Protection</span>
            </h3>
            <p className="text-xs text-neutral-400 leading-relaxed mb-4">
              A UUIDv4 token is bundled with this form submission. Retrying when network drops is safe and won't write duplicate rows to Postgres.
            </p>
            <div className="bg-neutral-950 p-3 rounded-lg border border-neutral-900 select-all">
              <div className="text-[10px] text-neutral-500 font-bold uppercase mb-1">Idempotency Key</div>
              <div className="font-mono text-xs text-emerald-400/90 break-all">{idempotencyKey || 'generating...'}</div>
            </div>
          </div>

          {/* Simulation Toggle */}
          <div className="glass-panel p-6 rounded-2xl border-neutral-800">
            <h3 className="text-sm font-bold text-white uppercase tracking-wider mb-4 flex items-center gap-2">
              <div className="w-1.5 h-3 rounded-full bg-indigo-500" />
              <span>Simulation Panel</span>
            </h3>
            <p className="text-xs text-neutral-400 leading-relaxed mb-4">
              Simulate edge-case environments to test retry mechanisms.
            </p>

            <label className="flex items-center gap-3 justify-between p-3 bg-neutral-900 border border-neutral-900 rounded-xl cursor-pointer hover:bg-neutral-900/40 select-none">
              <div className="space-y-0.5">
                <span className="text-xs font-semibold text-neutral-300">Simulate Offline Submit</span>
                <p className="text-[10px] text-neutral-500">Triggers a local catch block timeout. Resubmitting sends the same token.</p>
              </div>
              <input
                type="checkbox"
                checked={simulateFail}
                onChange={() => {
                  setSimulateFail(!simulateFail);
                  setNetworkErrorCount(0);
                }}
                className="w-4 h-4 accent-emerald-500"
              />
            </label>
          </div>
        </div>
      </div>
    </div>
  );
}
