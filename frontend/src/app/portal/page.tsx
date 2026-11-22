'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { apiClient, ApiError } from '../../lib/api';
import {
  MapPin, Send, AlertTriangle, CheckCircle2, RefreshCw, ChevronDown, ChevronUp,
  Clock, ArrowRight, X, TrafficCone, Trash2, Droplets, Volume2, TriangleAlert,
  MessageSquare, Camera, Mic, Video, Sparkles, FileAudio, FileVideo,
  Check, Square
} from 'lucide-react';
import { Card, CardContent } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Textarea } from '../../components/ui/textarea';
import { Badge } from '../../components/ui/badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../../components/ui/collapsible';
import { Separator } from '../../components/ui/separator';
import { cn } from '../../lib/utils';

type Category = 'infrastructure' | 'sanitation' | 'utility' | 'noise' | 'safety' | 'other';

const CATEGORIES: { value: Category; label: string; icon: React.ReactNode }[] = [
  { value: 'infrastructure', label: 'Roads & Pavements', icon: <TrafficCone className="w-5 h-5" /> },
  { value: 'sanitation', label: 'Garbage & Drains', icon: <Trash2 className="w-5 h-5" /> },
  { value: 'utility', label: 'Water & Power', icon: <Droplets className="w-5 h-5" /> },
  { value: 'noise', label: 'Noise & Disturbances', icon: <Volume2 className="w-5 h-5" /> },
  { value: 'safety', label: 'Safety & Hazards', icon: <TriangleAlert className="w-5 h-5" /> },
  { value: 'other', label: 'Other', icon: <MessageSquare className="w-5 h-5" /> },
];

export default function PortalPage() {
  const router = useRouter();
  const [text, setText] = useState('');
  const [category, setCategory] = useState<Category | null>(null);
  const [showManualLocation, setShowManualLocation] = useState(false);
  const [latitude, setLatitude] = useState('');
  const [longitude, setLongitude] = useState('');
  const [locationSet, setLocationSet] = useState(false);
  const [showOptionalFields, setShowOptionalFields] = useState(false);
  const [contactName, setContactName] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [idempotencyKey, setIdempotencyKey] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitSuccess, setSubmitSuccess] = useState<{ category?: string; text?: string; complaintId?: string; id?: string } | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const topRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Multimodal Media Evidence State (Phase 3)
  const [mediaFile, setMediaFile] = useState<File | null>(null);
  const [mediaPreview, setMediaPreview] = useState<string | null>(null);
  const [mediaType, setMediaType] = useState<'image' | 'audio' | 'video' | null>(null);
  const [isAnalyzingMedia, setIsAnalyzingMedia] = useState(false);
  const [aiAnalysis, setAiAnalysis] = useState<{
    description: string;
    detectedCategory: Category | null;
    confidence: number;
    severityIndicators: string[];
  } | null>(null);
  const [isRecordingAudio, setIsRecordingAudio] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);

  // Phase 3: visibility + retry for post-submission media attachment
  const [mediaAttach, setMediaAttach] = useState<{
    status: 'idle' | 'uploading' | 'attached' | 'failed';
    error?: string;
    complaintId?: string;
    mediaId?: number;
  }>({ status: 'idle' });

  useEffect(() => {
    if (typeof window !== 'undefined') queueMicrotask(() => setIdempotencyKey(crypto.randomUUID()));
  }, [submitSuccess]);

  const clearError = (field: string) => {
    if (errors[field]) {
      const n = { ...errors };
      delete n[field];
      setErrors(n);
    }
  };

  const handleFileSelect = async (file: File) => {
    const normType = file.type.toLowerCase();
    const type = normType.startsWith('image/')
      ? 'image'
      : normType.startsWith('audio/')
      ? 'audio'
      : normType.startsWith('video/')
      ? 'video'
      : null;

    if (!type) {
      setSubmitError('Please upload an image, audio, or video file.');
      return;
    }

    setMediaFile(file);
    setMediaType(type);
    setMediaPreview(URL.createObjectURL(file));
    setIsAnalyzingMedia(true);
    setSubmitError(null);

    try {
      const res = await apiClient.analyzeMedia(file);
      const analysis = res.data.analysis;
      setAiAnalysis({
        description: analysis.description,
        detectedCategory: (analysis.detectedCategory as Category) || null,
        confidence: analysis.confidence,
        severityIndicators: analysis.severityIndicators || [],
      });

      // Auto-suggest category if not yet selected
      if (analysis.detectedCategory && !category) {
        setCategory(analysis.detectedCategory as Category);
      }

      // Pre-fill description if currently empty
      if (!text.trim() && analysis.description) {
        setText(analysis.description);
      }
    } catch (err) {
      console.warn('Media analysis non-fatal warning:', err);
    } finally {
      setIsAnalyzingMedia(false);
    }
  };

  const handleClearMedia = () => {
    if (mediaPreview) URL.revokeObjectURL(mediaPreview);
    setMediaFile(null);
    setMediaPreview(null);
    setMediaType(null);
    setAiAnalysis(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const startAudioRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;
      audioChunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };

      recorder.onstop = () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        const recordedFile = new File([audioBlob], `voice-note-${Date.now()}.webm`, { type: 'audio/webm' });
        handleFileSelect(recordedFile);
        stream.getTracks().forEach((track) => track.stop());
      };

      recorder.start();
      setIsRecordingAudio(true);
    } catch {
      setSubmitError('Microphone access denied or audio recording not supported by browser.');
    }
  };

  const stopAudioRecording = () => {
    if (mediaRecorderRef.current && isRecordingAudio) {
      mediaRecorderRef.current.stop();
      setIsRecordingAudio(false);
    }
  };

  const validate = useCallback(() => {
    const e: Record<string, string> = {};
    if (!text.trim()) e.text = 'Please describe the issue you\'re reporting.';
    else if (text.length > 5000) e.text = 'Description must be under 5,000 characters.';
    if (latitude || longitude) {
      const lat = parseFloat(latitude);
      const lng = parseFloat(longitude);
      if (latitude && (isNaN(lat) || lat < -90 || lat > 90)) e.location = 'Latitude should be a number between -90 and 90.';
      if (longitude && (isNaN(lng) || lng < -180 || lng > 180)) e.location = 'Longitude should be a number between -180 and 180.';
    }
    if (contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) e.email = 'Please enter a valid email address.';
    setErrors(e);
    return Object.keys(e).length === 0;
  }, [text, latitude, longitude, contactEmail]);

  const handleBlur = (field: string) => {
    setTouched(prev => ({ ...prev, [field]: true }));
    validate();
  };

  const handleGetLocation = () => {
    setLatitude((12.9400 + Math.random() * 0.05).toFixed(6));
    setLongitude((77.5600 + Math.random() * 0.08).toFixed(6));
    setLocationSet(true);
    setShowManualLocation(false);
    clearError('location');
  };

  const handleClearLocation = () => {
    setLatitude('');
    setLongitude('');
    setLocationSet(false);
    setShowManualLocation(false);
  };

  const charCount = text.length;
  const charLimit = 5000;
  const isNearLimit = charCount > 4500;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setTouched({ text: true, category: true });
    if (!category) {
      setErrors(prev => ({ ...prev, category: 'Please select a category.' }));
      return;
    }
    if (!validate()) return;
    setIsSubmitting(true);
    setSubmitError(null);
    setErrors({});

    try {
      const result = await apiClient.submitComplaint({
        text: text.trim(),
        category,
        latitude: latitude ? parseFloat(latitude) : null,
        longitude: longitude ? parseFloat(longitude) : null,
        idempotencyKey,
        metaData: {
          ...(contactName.trim() ? { contactName: contactName.trim() } : {}),
          ...(contactEmail.trim() ? { contactEmail: contactEmail.trim() } : {}),
        },
      });
      const data = result.data as { category?: string; text?: string; complaintId?: string; id?: string };

      // Phase 3: Attach uploaded media to the newly created complaint.
      // The complaint is ALWAYS preserved — a media failure is surfaced to the
      // citizen (with a retry) instead of being swallowed by console.warn.
      if (mediaFile && data.id) {
        setMediaAttach({ status: 'uploading', complaintId: data.id });
        try {
          const attachRes = await apiClient.attachComplaintMedia(data.id, mediaFile);
          if (attachRes.data.processingStatus === 'failed') {
            setMediaAttach({
              status: 'failed',
              complaintId: data.id,
              mediaId: attachRes.data.mediaId,
              error: 'The file was saved but AI analysis failed. You can retry the analysis.',
            });
          } else {
            setMediaAttach({
              status: 'attached',
              complaintId: data.id,
              mediaId: attachRes.data.mediaId,
            });
          }
        } catch (mediaAttachErr) {
          const message =
            mediaAttachErr instanceof ApiError
              ? mediaAttachErr.message
              : 'Your report was saved, but the evidence file could not be uploaded.';
          setMediaAttach({ status: 'failed', complaintId: data.id, error: message });
        }
      }

      setSubmitSuccess(data);
      setErrors({});
      if (topRef.current) topRef.current.scrollIntoView({ behavior: 'smooth' });
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 409) setSubmitError('This report looks like one you\'ve already submitted. Duplicates are not allowed.');
        else if (err.status === 429) setSubmitError('You\'ve submitted too many reports recently. Please wait a moment and try again.');
        else if (err.status === 400 && err.details) {
          const f: Record<string, string> = {};
          err.details.forEach(d => { f[d.path] = d.message; });
          setErrors(f);
        } else setSubmitError(err.message || 'Something went wrong. Please try again.');
      } else {
        setSubmitError('Unable to connect. Please check your internet connection and try again.');
      }
      if (topRef.current) topRef.current.scrollIntoView({ behavior: 'smooth' });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleReset = () => {
    setText('');
    setCategory(null);
    setLatitude('');
    setLongitude('');
    setLocationSet(false);
    setShowManualLocation(false);
    setContactName('');
    setContactEmail('');
    setShowOptionalFields(false);
    setSubmitSuccess(null);
    setSubmitError(null);
    setErrors({});
    setTouched({});
    setMediaAttach({ status: 'idle' });
    handleClearMedia();
    if (topRef.current) topRef.current.scrollIntoView({ behavior: 'smooth' });
  };

  // Retry a failed media attachment without re-creating the complaint.
  // The backend reuses the existing complaint_media record (no duplicates).
  const handleRetryMediaAttach = async () => {
    if (!mediaFile || !mediaAttach.complaintId) return;
    setMediaAttach((prev) => ({ ...prev, status: 'uploading', error: undefined }));
    try {
      const res = mediaAttach.mediaId
        ? await apiClient.retryComplaintMedia(mediaAttach.complaintId, mediaAttach.mediaId)
        : await apiClient.attachComplaintMedia(mediaAttach.complaintId, mediaFile);

      if (res.data.processingStatus === 'failed') {
        setMediaAttach({
          status: 'failed',
          complaintId: mediaAttach.complaintId,
          mediaId: res.data.mediaId,
          error: 'AI analysis failed again. Your report and file are safe — you can keep retrying.',
        });
      } else {
        setMediaAttach({
          status: 'attached',
          complaintId: mediaAttach.complaintId,
          mediaId: res.data.mediaId,
        });
      }
    } catch (err) {
      const message =
        err instanceof ApiError ? err.message : 'Retry failed. Please try again.';
      setMediaAttach((prev) => ({ ...prev, status: 'failed', error: message }));
    }
  };

  const handleGoToTrack = () => {
    if (submitSuccess?.id) {
      router.push(`/track?id=${submitSuccess.id}`);
    }
  };

  if (submitSuccess) {
    return (
      <div className="p-4 sm:p-6 lg:p-8 max-w-2xl mx-auto" ref={topRef}>
        <Card className="p-6 sm:p-8 lg:p-10 text-center fade-in">
          <div className="w-16 h-16 bg-green-500/10 border border-green-500/20 text-green-400 rounded-full flex items-center justify-center mx-auto mb-5">
            <CheckCircle2 className="w-8 h-8" />
          </div>

          <h1 className="text-xl sm:text-2xl font-bold text-white mb-2">
            Thanks — your report has been logged
          </h1>
          <p className="text-sm text-neutral-400 mb-6 max-w-md mx-auto leading-relaxed">
            Your report will be reviewed and grouped with similar reports from your area.
            Officials will see it and take action.
          </p>

          <Card className="p-5 text-left max-w-sm mx-auto mb-6 space-y-3">
            <div className="flex items-center justify-between text-xs">
              <span className="text-neutral-500">Reference number</span>
              <span className="font-mono text-indigo-400 font-bold text-sm">CM-{submitSuccess.id}</span>
            </div>
            <Separator />
            <div className="flex items-center justify-between text-xs">
              <span className="text-neutral-500">Category</span>
              <span className="font-semibold text-neutral-200 capitalize">{submitSuccess.category}</span>
            </div>
            {submitSuccess.text && (
              <>
                <Separator />
                <div>
                  <span className="text-[10px] text-neutral-500 block mb-1">Description</span>
                  <p className="text-xs text-neutral-300 leading-relaxed line-clamp-2">&ldquo;{submitSuccess.text}&rdquo;</p>
                </div>
              </>
            )}
          </Card>

          {/* Phase 3: media attachment status (visible to the citizen) */}
          {mediaAttach.status !== 'idle' && mediaFile && (
            <Card
              className={cn(
                'p-4 text-left max-w-sm mx-auto mb-6 space-y-3',
                mediaAttach.status === 'failed'
                  ? 'bg-amber-500/10 border-amber-500/30'
                  : mediaAttach.status === 'attached'
                  ? 'bg-green-500/10 border-green-500/20'
                  : 'bg-white/[0.02] border-white/10'
              )}
            >
              <div className="flex items-start gap-2.5">
                {mediaAttach.status === 'failed' ? (
                  <AlertTriangle className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
                ) : mediaAttach.status === 'attached' ? (
                  <CheckCircle2 className="w-4 h-4 text-green-400 mt-0.5 shrink-0" />
                ) : (
                  <RefreshCw className="w-4 h-4 text-indigo-400 mt-0.5 shrink-0 animate-spin" />
                )}
                <div className="flex-1 space-y-1">
                  <p
                    className={cn(
                      'text-xs font-semibold',
                      mediaAttach.status === 'failed'
                        ? 'text-amber-300'
                        : mediaAttach.status === 'attached'
                        ? 'text-green-300'
                        : 'text-neutral-300'
                    )}
                  >
                    {mediaAttach.status === 'failed'
                      ? 'Evidence not attached yet'
                      : mediaAttach.status === 'attached'
                      ? 'Evidence attached'
                      : 'Attaching your evidence…'}
                  </p>
                  <p className="text-[11px] text-neutral-400 leading-relaxed">
                    {mediaAttach.status === 'failed'
                      ? mediaAttach.error ||
                        'Your report (CM-' +
                          mediaAttach.complaintId +
                          ') was saved successfully — only the evidence file failed to attach.'
                      : mediaAttach.status === 'attached'
                      ? mediaFile.name + ' is linked to your report.'
                      : mediaFile.name}
                  </p>
                </div>
              </div>

              {mediaAttach.status === 'failed' && (
                <div className="flex gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="default"
                    onClick={handleRetryMediaAttach}
                    className="flex-1"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    Retry attach
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setMediaAttach((prev) => ({ ...prev, status: 'idle' }))}
                  >
                    Continue without
                  </Button>
                </div>
              )}
            </Card>
          )}

          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <Button onClick={handleGoToTrack}>
              <Clock className="w-4 h-4" />
              Track your report
              <ArrowRight className="w-4 h-4" />
            </Button>
            <Button variant="outline" onClick={handleReset}>
              Report another issue
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  const showGlobalError = submitError && Object.keys(errors).length === 0;

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-2xl mx-auto" ref={topRef}>
      <div className="mb-6 sm:mb-8">
        <h1 className="text-xl sm:text-2xl font-bold text-white">
          Report a problem in your area
        </h1>
        <p className="text-sm text-neutral-400 mt-2 leading-relaxed">
          Your report will be reviewed and grouped with similar reports to help officials respond faster.
        </p>
      </div>

      {showGlobalError && (
        <Card className="mb-5 p-4 bg-red-500/10 border-red-500/20">
          <div className="flex gap-3 items-start">
            <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5 text-red-400" />
            <div className="flex-1">
              <p className="font-semibold text-sm text-red-400">{submitError}</p>
            </div>
            <Button variant="ghost" size="icon" onClick={() => setSubmitError(null)}>
              <X className="w-4 h-4" />
            </Button>
          </div>
        </Card>
      )}

      <form onSubmit={handleSubmit} className="space-y-6">
        <Card className="p-5 sm:p-6 lg:p-8">
          <div className="space-y-6">
            {/* Phase 3: Multimodal Evidence Upload & AI Assistant */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="block text-sm font-semibold text-neutral-300">
                  Attach Evidence (Optional)
                </label>
                <span className="text-[11px] text-neutral-500">Photo, audio note, or video clip</span>
              </div>

              {/* Hidden file input */}
              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp,image/gif,audio/mpeg,audio/wav,audio/webm,audio/mp4,audio/ogg,video/mp4,video/webm,video/quicktime"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleFileSelect(file);
                }}
              />

              {/* Upload trigger buttons when no media is chosen */}
              {!mediaFile && (
                <div className="grid grid-cols-3 gap-2.5">
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="flex flex-col items-center justify-center gap-1.5 p-3 rounded-lg border border-dashed border-white/10 bg-white/[0.01] hover:bg-white/[0.04] hover:border-indigo-500/40 text-neutral-400 hover:text-neutral-200 transition-colors cursor-pointer"
                  >
                    <Camera className="w-5 h-5 text-indigo-400" />
                    <span className="text-xs font-medium">Add Photo</span>
                  </button>

                  {!isRecordingAudio ? (
                    <button
                      type="button"
                      onClick={startAudioRecording}
                      className="flex flex-col items-center justify-center gap-1.5 p-3 rounded-lg border border-dashed border-white/10 bg-white/[0.01] hover:bg-white/[0.04] hover:border-amber-500/40 text-neutral-400 hover:text-neutral-200 transition-colors cursor-pointer"
                    >
                      <Mic className="w-5 h-5 text-amber-400" />
                      <span className="text-xs font-medium">Record Voice</span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={stopAudioRecording}
                      className="flex flex-col items-center justify-center gap-1.5 p-3 rounded-lg border border-red-500/50 bg-red-500/10 text-red-400 animate-pulse cursor-pointer"
                    >
                      <Square className="w-5 h-5 fill-current" />
                      <span className="text-xs font-medium">Stop Recording</span>
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="flex flex-col items-center justify-center gap-1.5 p-3 rounded-lg border border-dashed border-white/10 bg-white/[0.01] hover:bg-white/[0.04] hover:border-sky-500/40 text-neutral-400 hover:text-neutral-200 transition-colors cursor-pointer"
                  >
                    <Video className="w-5 h-5 text-sky-400" />
                    <span className="text-xs font-medium">Add Video</span>
                  </button>
                </div>
              )}

              {/* Media Preview & AI Analysis Feedback */}
              {mediaFile && (
                <div className="p-3.5 bg-neutral-900/60 border border-white/10 rounded-lg space-y-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-3">
                      {mediaType === 'image' && mediaPreview && (
                        /* eslint-disable-next-line @next/next/no-img-element */
                        <img
                          src={mediaPreview}
                          alt="Evidence preview"
                          className="w-16 h-16 object-cover rounded-md border border-white/10"
                        />
                      )}
                      {mediaType === 'audio' && (
                        <div className="w-14 h-14 bg-amber-500/10 rounded-md border border-amber-500/20 flex items-center justify-center text-amber-400">
                          <FileAudio className="w-7 h-7" />
                        </div>
                      )}
                      {mediaType === 'video' && (
                        <div className="w-14 h-14 bg-sky-500/10 rounded-md border border-sky-500/20 flex items-center justify-center text-sky-400">
                          <FileVideo className="w-7 h-7" />
                        </div>
                      )}
                      <div>
                        <p className="text-xs font-semibold text-neutral-200 truncate max-w-[220px]">
                          {mediaFile.name}
                        </p>
                        <p className="text-[11px] text-neutral-500">
                          {(mediaFile.size / (1024 * 1024)).toFixed(2)} MB &bull; {mediaType?.toUpperCase()}
                        </p>
                        {isAnalyzingMedia && (
                          <div className="flex items-center gap-1.5 mt-1 text-xs text-indigo-400">
                            <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                            <span>Analyzing with Gemini AI...</span>
                          </div>
                        )}
                      </div>
                    </div>

                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={handleClearMedia}
                      className="text-neutral-400 hover:text-red-400"
                    >
                      <X className="w-4 h-4" />
                    </Button>
                  </div>

                  {/* Audio inline player preview */}
                  {mediaType === 'audio' && mediaPreview && (
                    <audio controls src={mediaPreview} className="w-full h-8 mt-1" />
                  )}

                  {/* Video inline player preview */}
                  {mediaType === 'video' && mediaPreview && (
                    <video controls src={mediaPreview} className="w-full max-h-40 rounded-md mt-1" />
                  )}

                  {/* AI Analysis Result Card */}
                  {aiAnalysis && (
                    <div className="p-3 bg-indigo-500/10 border border-indigo-500/20 rounded-md text-xs space-y-2">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-1.5 font-semibold text-indigo-300">
                          <Sparkles className="w-3.5 h-3.5 text-indigo-400" />
                          <span>AI Evidence Analysis</span>
                        </div>
                        {aiAnalysis.detectedCategory && (
                          <Badge variant="default" className="text-[10px] uppercase font-mono">
                            Detected: {aiAnalysis.detectedCategory}
                          </Badge>
                        )}
                      </div>
                      <p className="text-neutral-300 leading-relaxed italic">
                        &ldquo;{aiAnalysis.description}&rdquo;
                      </p>
                      {text !== aiAnalysis.description && (
                        <button
                          type="button"
                          onClick={() => setText(aiAnalysis.description)}
                          className="inline-flex items-center gap-1 text-[11px] font-semibold text-indigo-400 hover:text-indigo-300 cursor-pointer"
                        >
                          <Check className="w-3 h-3" />
                          Use AI description for complaint
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>

            <Separator />

            <div>
              <label className="block text-sm font-semibold text-neutral-300 mb-2">
                What&rsquo;s the problem?
              </label>
              <Textarea
                value={text}
                onChange={(e) => { setText(e.target.value); clearError('text'); }}
                onBlur={() => handleBlur('text')}
                rows={4}
                maxLength={charLimit}
                placeholder="Tell us what you see — potholes, garbage buildup, broken streetlights, etc."
                className={cn(errors.text && touched.text && 'border-red-500/50')}
              />
              <div className="flex justify-between mt-1.5 text-xs">
                <span className={errors.text && touched.text ? 'text-red-400' : 'text-neutral-600'}>
                  {errors.text && touched.text ? errors.text : ''}
                </span>
                <span className={isNearLimit ? 'text-amber-400' : 'text-neutral-500'}>
                  {charCount}/{charLimit}
                </span>
              </div>
            </div>

            <fieldset>
              <legend className="block text-sm font-semibold text-neutral-300 mb-2.5">
                What type of issue is it?
              </legend>
              {errors.category && (
                <p className="text-xs text-red-400 mb-2">{errors.category}</p>
              )}
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
                {CATEGORIES.map((cat) => {
                  const selected = category === cat.value;
                  return (
                    <button
                      key={cat.value}
                      type="button"
                      onClick={() => { setCategory(cat.value); clearError('category'); }}
                      className={cn(
                        'flex flex-col items-center gap-1.5 px-3 py-3.5 rounded-lg border text-sm font-medium transition-colors cursor-pointer select-none',
                        selected
                          ? 'bg-indigo-500/10 border-indigo-500/30 text-indigo-300'
                          : 'bg-white/[0.02] border-white/[0.06] text-neutral-400 hover:border-white/10 hover:text-neutral-200'
                      )}
                    >
                      {cat.icon}
                      <span className="text-xs leading-tight text-center">{cat.label}</span>
                    </button>
                  );
                })}
              </div>
            </fieldset>

            <div>
              <label className="block text-sm font-semibold text-neutral-300 mb-2.5">
                Where is this happening?
              </label>

              {!locationSet && !showManualLocation ? (
                <div className="flex flex-col sm:flex-row gap-2.5">
                  <Button
                    type="button"
                    variant="default"
                    onClick={handleGetLocation}
                    className="flex-1"
                  >
                    <MapPin className="w-5 h-5" />
                    Add my location
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => setShowManualLocation(true)}
                    className="flex-1"
                  >
                    Enter coordinates
                  </Button>
                </div>
              ) : (
                <div className="space-y-3">
                  {locationSet && (
                    <div className="flex items-center justify-between p-3.5 bg-indigo-500/5 border border-indigo-500/10 rounded-lg">
                      <div className="flex items-center gap-2.5">
                        <MapPin className="w-5 h-5 text-indigo-400" />
                        <div>
                          <span className="text-xs text-neutral-400 block">Location set</span>
                          <span className="text-xs font-mono text-indigo-300">{latitude}, {longitude}</span>
                        </div>
                      </div>
                      <Button type="button" variant="ghost" size="sm" onClick={handleClearLocation}>
                        Remove
                      </Button>
                    </div>
                  )}
                  {showManualLocation && (
                    <div className="space-y-2.5">
                      <div className="grid grid-cols-2 gap-2.5">
                        <Input
                          type="text"
                          placeholder="Latitude (e.g. 12.9716)"
                          value={latitude}
                          onChange={(e) => { setLatitude(e.target.value); clearError('location'); setLocationSet(true); }}
                          onBlur={() => handleBlur('location')}
                          className={cn(errors.location && touched.location && 'border-red-500/50')}
                        />
                        <Input
                          type="text"
                          placeholder="Longitude (e.g. 77.5946)"
                          value={longitude}
                          onChange={(e) => { setLongitude(e.target.value); clearError('location'); setLocationSet(true); }}
                          onBlur={() => handleBlur('location')}
                          className={cn(errors.location && touched.location && 'border-red-500/50')}
                        />
                      </div>
                      {errors.location && touched.location && (
                        <p className="text-xs text-red-400">{errors.location}</p>
                      )}
                      <Button type="button" variant="link" size="sm" onClick={handleGetLocation}>
                        <MapPin className="w-3.5 h-3.5" />
                        Use suggested location instead
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </div>

            <Separator />

            <Collapsible open={showOptionalFields} onOpenChange={setShowOptionalFields}>
              <CollapsibleTrigger asChild>
                <Button type="button" variant="ghost" size="sm">
                  {showOptionalFields ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                  {showOptionalFields ? 'Hide optional details' : 'Add your details (optional)'}
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="mt-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-semibold text-neutral-500 mb-1.5">Your name</label>
                    <Input
                      type="text"
                      placeholder="Jane Doe"
                      value={contactName}
                      onChange={(e) => setContactName(e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-neutral-500 mb-1.5">Email address</label>
                    <Input
                      type="text"
                      placeholder="jane@example.com"
                      value={contactEmail}
                      onChange={(e) => { setContactEmail(e.target.value); clearError('email'); }}
                      onBlur={() => handleBlur('email')}
                      className={cn(errors.email && touched.email && 'border-red-500/50')}
                    />
                    {errors.email && touched.email && (
                      <p className="mt-1 text-xs text-red-400">{errors.email}</p>
                    )}
                  </div>
                </div>
              </CollapsibleContent>
            </Collapsible>

            <Button
              type="submit"
              disabled={isSubmitting}
              className="w-full"
            >
              {isSubmitting ? (
                <><RefreshCw className="w-4 h-4 animate-spin" /> Sending report...</>
              ) : (
                <><Send className="w-4 h-4" /> Submit report</>
              )}
            </Button>

            {Object.keys(errors).length > 0 && !showGlobalError && (
              <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-xs text-red-400 flex gap-2 items-start">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>Please fix the highlighted fields above before submitting.</span>
              </div>
            )}
          </div>
        </Card>
      </form>

      <Card className="mt-6 p-5">
        <CardContent>
          <h3 className="text-sm font-bold text-neutral-300 mb-3">What happens next?</h3>
          <div className="space-y-3 text-xs text-neutral-500">
            {[
              { num: '1', title: 'Review & group', desc: 'Your report is reviewed and combined with similar reports from your area.' },
              { num: '2', title: 'Officials notified', desc: 'The relevant department gets an alert with all the details.' },
              { num: '3', title: 'Action taken', desc: 'Officials address the issue and update its status. You can track progress anytime.' },
            ].map((step) => (
              <div key={step.num} className="flex items-start gap-3">
                <Badge variant="info" className="w-6 h-6 rounded-full p-0 flex items-center justify-center text-[11px] shrink-0 mt-0.5">
                  {step.num}
                </Badge>
                <div>
                  <span className="text-neutral-300 font-semibold">{step.title}</span>
                  <p className="mt-0.5">{step.desc}</p>
                </div>
              </div>
            ))}
          </div>
          <Separator className="my-4" />
          <a href="/track" className="inline-flex items-center gap-1.5 text-xs font-semibold text-indigo-400 hover:text-indigo-300 transition-colors">
            <Clock className="w-3.5 h-3.5" />
            Track an existing report
            <ArrowRight className="w-3.5 h-3.5" />
          </a>
        </CardContent>
      </Card>
    </div>
  );
}
