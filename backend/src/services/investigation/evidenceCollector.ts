// backend/src/services/investigation/evidenceCollector.ts
//
// Phase 4 — Evidence Collector Service
//
// Gathers complaints, media descriptions, cluster metadata, and historical
// records for an investigation. Stores structured evidence items into
// the investigation_evidence table while preserving provenance.

import { pool } from '../../config/db';
import logger from '../../utils/logger';
import { EvidenceItem } from './types';

export interface CollectedEvidenceBundle {
  cluster: {
    id: number;
    title: string;
    category: string;
    region: string;
    severityScore: number;
    priorityScore: number;
    hybridScore: number;
    complaintCount: number;
    geoCentroidLat: number | null;
    geoCentroidLng: number | null;
    assignedDepartment: string | null;
    createdAt: string;
    updatedAt: string;
  };
  complaints: Array<{
    id: number;
    text: string;
    category: string;
    latitude: number | null;
    longitude: number | null;
    createdAt: string;
    status: string;
  }>;
  mediaItems: Array<{
    id: number;
    complaintId: number;
    mediaType: string;
    extractedDescription: string | null;
    detectedCategory: string | null;
    confidenceScore: number | null;
    originalFilename: string;
  }>;
  evidenceItems: EvidenceItem[];
}

/**
 * Collects all relevant evidence for an investigation from the database.
 */
export async function collectInvestigationEvidence(
  investigationId: number,
  clusterId: number
): Promise<CollectedEvidenceBundle> {
  if (!pool) {
    throw new Error('[EVIDENCE_COLLECTOR] Database pool unavailable');
  }

  // 1. Fetch cluster
  const clusterRes = await pool.query(
    `SELECT id, title, category, region, severity_score, priority_score,
            hybrid_score, complaint_count, geo_centroid_lat, geo_centroid_lng,
            assigned_department, created_at, updated_at
     FROM cluster
     WHERE id = $1`,
    [clusterId]
  );

  if (clusterRes.rows.length === 0) {
    throw new Error(`[EVIDENCE_COLLECTOR] Cluster ${clusterId} not found`);
  }

  const cRow = clusterRes.rows[0];
  const cluster = {
    id: cRow.id,
    title: cRow.title,
    category: cRow.category,
    region: cRow.region,
    severityScore: cRow.severity_score != null ? parseInt(cRow.severity_score, 10) : 40,
    priorityScore: cRow.priority_score != null ? parseFloat(cRow.priority_score) : 40,
    hybridScore: cRow.hybrid_score != null ? parseFloat(cRow.hybrid_score) : 0,
    complaintCount: cRow.complaint_count != null ? parseInt(cRow.complaint_count, 10) : 0,
    geoCentroidLat: cRow.geo_centroid_lat != null ? parseFloat(cRow.geo_centroid_lat) : null,
    geoCentroidLng: cRow.geo_centroid_lng != null ? parseFloat(cRow.geo_centroid_lng) : null,
    assignedDepartment: cRow.assigned_department || null,
    createdAt: cRow.created_at?.toISOString() || new Date().toISOString(),
    updatedAt: cRow.updated_at?.toISOString() || new Date().toISOString(),
  };

  // 2. Fetch all linked complaints
  const complaintsRes = await pool.query(
    `SELECT id, text, category, latitude, longitude, created_at, status
     FROM complaint
     WHERE cluster_id = $1
     ORDER BY created_at ASC`,
    [clusterId]
  );

  const complaints = complaintsRes.rows.map((row) => ({
    id: row.id,
    text: row.text,
    category: row.category,
    latitude: row.latitude != null ? parseFloat(row.latitude) : null,
    longitude: row.longitude != null ? parseFloat(row.longitude) : null,
    createdAt: row.created_at?.toISOString() || new Date().toISOString(),
    status: row.status,
  }));

  // 3. Fetch media attachments for linked complaints
  const complaintIds = complaints.map((c) => c.id);
  let mediaItems: any[] = [];

  if (complaintIds.length > 0) {
    try {
      const mediaRes = await pool.query(
        `SELECT id, complaint_id, media_type, extracted_description,
                detected_category, confidence_score, original_filename
         FROM complaint_media
         WHERE complaint_id = ANY($1)
         ORDER BY created_at ASC`,
        [complaintIds]
      );

      mediaItems = mediaRes.rows.map((m) => ({
        id: m.id,
        complaintId: m.complaint_id,
        mediaType: m.media_type,
        extractedDescription: m.extracted_description,
        detectedCategory: m.detected_category,
        confidenceScore: m.confidence_score ? parseFloat(m.confidence_score) : null,
        originalFilename: m.original_filename,
      }));
    } catch (mediaErr: any) {
      logger.warn(`[EVIDENCE_COLLECTOR] complaint_media query failed (non-fatal): ${mediaErr.message}`);
    }
  }

  // 4. Construct normalized evidence items
  const evidenceItems: EvidenceItem[] = [];

  // Add complaints as verified evidence
  for (const comp of complaints) {
    evidenceItems.push({
      complaintId: comp.id,
      evidenceType: 'complaint',
      evidenceDescription: `[Citizen Report #${comp.id}]: ${comp.text}`,
      verificationStatus: 'verified',
      retrievedAt: comp.createdAt,
    });
  }

  // Add media as verified or AI-inferred evidence
  for (const m of mediaItems) {
    if (m.extractedDescription) {
      evidenceItems.push({
        complaintId: m.complaintId,
        mediaId: m.id,
        evidenceType: 'media',
        evidenceDescription: `[${m.mediaType.toUpperCase()} Evidence from ${m.originalFilename}]: ${m.extractedDescription}`,
        verificationStatus: m.confidenceScore && m.confidenceScore >= 0.7 ? 'verified' : 'ai_inferred',
      });
    }
  }

  // 5. Persist evidence items to investigation_evidence table (with duplicate protection on retry)
  try {
    for (const item of evidenceItems) {
      const existing = await pool.query(
        `SELECT id FROM investigation_evidence 
         WHERE investigation_id = $1 
           AND COALESCE(complaint_id, -1) = COALESCE($2, -1) 
           AND COALESCE(media_id, -1) = COALESCE($3, -1)
           AND evidence_type = $4`,
        [investigationId, item.complaintId || null, item.mediaId || null, item.evidenceType]
      );

      if (existing.rows.length === 0) {
        await pool.query(
          `INSERT INTO investigation_evidence
             (investigation_id, complaint_id, media_id, evidence_type, evidence_description, verification_status)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            investigationId,
            item.complaintId || null,
            item.mediaId || null,
            item.evidenceType,
            item.evidenceDescription,
            item.verificationStatus,
          ]
        );
      }
    }
    logger.info(
      `[EVIDENCE_COLLECTOR] Persisted ${evidenceItems.length} evidence items for Investigation ${investigationId}`
    );
  } catch (persistErr: any) {
    logger.warn(`[EVIDENCE_COLLECTOR] Could not persist evidence items (schema might not be applied): ${persistErr.message}`);
  }

  return {
    cluster,
    complaints,
    mediaItems,
    evidenceItems,
  };
}
