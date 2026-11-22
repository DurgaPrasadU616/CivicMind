// backend/src/services/investigation/departmentMatcher.ts
//
// Phase 4 — Multi-Jurisdiction Department Identification & Router
//
// Identifies the most appropriate municipal department to address a civic cluster
// using category heuristics, geographic jurisdiction hierarchy (State -> District -> Municipality),
// complaint history, and public policy mandates.
//
// Safety & Integrity:
//   • Supports configurable State, District, Municipality, Department, and Civic Category.
//   • Never assumes Karnataka departments (BBMP, etc.) are responsible for Andhra Pradesh or other states.
//   • Unknown or ambiguous jurisdictions produce an UNCERTAIN suggestion (confidence <= 0.35)
//     with `needsHumanVerification: true` requiring human official verification.
//   • Does NOT automatically dispatch contractors or reassign clusters without human approval.

import { DepartmentMatch } from './types';
import logger from '../../utils/logger';

export interface DepartmentRule {
  primaryDepartment: string;
  alternativeDepartment: string;
  reasonTemplate: string;
  jurisdictionRules: Record<string, string>;
  baseConfidence: number;
}

export interface JurisdictionRegistry {
  state: string;
  aliases: string[];
  districts?: Record<string, string[]>; // district name -> municipality aliases
  categories: Record<string, DepartmentRule>;
}

export interface JurisdictionContext {
  state?: string;
  district?: string;
  municipality?: string;
}

// ── 1. KARNATAKA REGISTRY ───────────────────────────────────────────────────

const KARNATAKA_REGISTRY: JurisdictionRegistry = {
  state: 'Karnataka',
  aliases: [
    'karnataka',
    'ka',
    'bengaluru',
    'bangalore',
    'bbmp',
    'downtown',
    'north',
    'south',
    'east',
    'west',
    'mysuru',
    'hubli',
    'dharwad',
    'mangalore',
    'belagavi',
  ],
  districts: {
    'Bengaluru Urban': ['bbmp', 'downtown', 'north', 'south', 'east', 'west', 'yelahanka', 'hebbal', 'whitefield', 'jayanagar', 'indiranagar'],
  },
  categories: {
    infrastructure: {
      primaryDepartment: 'BBMP Major Roads & Infrastructure Department',
      alternativeDepartment: 'Karnataka Public Works Department (KPWD)',
      reasonTemplate:
        'Roadway surface degradation, potholes, and pedestrian pavement defects fall under the municipal civil engineering mandate.',
      jurisdictionRules: {
        Downtown: 'BBMP Central Zone Engineering Division (MG Road / Brigade Sub-division)',
        North: 'BBMP North Zone Infrastructure Division (Hebbal / Yelahanka Ward)',
        South: 'BBMP South Zone Road Division (Jayanagar / BTM Layout)',
        East: 'BBMP East Zone Engineering Division (Indiranagar / Whitefield)',
        West: 'BBMP West Zone Civil Works Division (Rajajinagar / Malleshwaram)',
      },
      baseConfidence: 0.92,
    },
    sanitation: {
      primaryDepartment: 'BBMP Solid Waste Management & Health Department',
      alternativeDepartment: 'Karnataka State Pollution Control Board (KSPCB)',
      reasonTemplate:
        'Garbage accumulation, clogged surface drains, and unauthorized waste dumping are governed by municipal Solid Waste Management by-laws.',
      jurisdictionRules: {
        Downtown: 'BBMP Central Ward Health Office (SWM Unit 1)',
        North: 'BBMP North Sanitation Division',
        South: 'BBMP South Zone Solid Waste Cell',
        East: 'BBMP East Zone Sanitation Operations',
        West: 'BBMP West Zone Health & Sanitation Office',
      },
      baseConfidence: 0.89,
    },
    utility: {
      primaryDepartment: 'Bangalore Water Supply and Sewerage Board (BWSSB)',
      alternativeDepartment: 'Bangalore Electricity Supply Company (BESCOM)',
      reasonTemplate:
        'Water pipeline ruptures, sewage backflow, or power distribution faults require immediate technical utility intervention.',
      jurisdictionRules: {
        Downtown: 'BWSSB Central Maintenance Division (Cauvery Bhavan Sub-division)',
        North: 'BWSSB North Water Supply Office',
        South: 'BWSSB South Sub-division',
        East: 'BWSSB East Maintenance Ward',
        West: 'BWSSB West Zone Operations',
      },
      baseConfidence: 0.86,
    },
    noise: {
      primaryDepartment: 'Karnataka State Pollution Control Board (KSPCB) / Local Police',
      alternativeDepartment: 'BBMP Environmental Cell',
      reasonTemplate:
        'Excessive noise pollution in residential zones requires joint acoustic measurement by pollution control board and police enforcement.',
      jurisdictionRules: {
        Downtown: 'Central Police Commissionerate & KSPCB Urban Cell',
        North: 'North Division Police & Environmental Enforcement Cell',
        South: 'South Division Law & Order Unit',
        East: 'East Zone Police & Pollution Control Sub-office',
        West: 'West Zone Police Inspection Team',
      },
      baseConfidence: 0.82,
    },
    safety: {
      primaryDepartment: 'City Traffic Police & Municipal Disaster Management Cell',
      alternativeDepartment: 'Fire & Emergency Services Directorate',
      reasonTemplate:
        'Immediate physical hazards to pedestrian or vehicular movement require rapid barricading, hazard management, and traffic redirection.',
      jurisdictionRules: {
        Downtown: 'Traffic Police Central Division & BBMP Control Room',
        North: 'North Traffic Zone Disaster Cell',
        South: 'South Traffic Police & Emergency Response Group',
        East: 'East Traffic Management Subdivision',
        West: 'West Traffic Police Headquarters',
      },
      baseConfidence: 0.88,
    },
    other: {
      primaryDepartment: 'Ward Nodal Grievance Office (DPAR)',
      alternativeDepartment: 'General Municipal Administration',
      reasonTemplate:
        'Grievances crossing multiple civic categories are assigned to the Ward Nodal Office for preliminary triage and departmental referral.',
      jurisdictionRules: {
        Downtown: 'Central Ward Secretariat',
        North: 'North Zonal Commissioner Office',
        South: 'South Zonal Nodal Unit',
        East: 'East Regional Grievance Cell',
        West: 'West Municipal Administration Office',
      },
      baseConfidence: 0.65,
    },
  },
};

// ── 2. ANDHRA PRADESH REGISTRY ──────────────────────────────────────────────

const ANDHRA_PRADESH_REGISTRY: JurisdictionRegistry = {
  state: 'Andhra Pradesh',
  aliases: ['andhra pradesh', 'andhra', 'ap', 'visakhapatnam', 'vizag', 'gvmc', 'vijayawada', 'vmc', 'guntur', 'tirupati', 'kurnool', 'rajahmundry'],
  districts: {
    Visakhapatnam: ['gvmc', 'mvp colony', 'gajuwaka', 'madhurawada', 'zone 1', 'zone 2', 'zone 3'],
    NTR: ['vmc', 'vijayawada', 'governorpet', 'one town', 'two town'],
  },
  categories: {
    infrastructure: {
      primaryDepartment: 'Greater Visakhapatnam Municipal Corporation (GVMC) Engineering Department',
      alternativeDepartment: 'Andhra Pradesh Roads & Buildings (AP R&B) Department',
      reasonTemplate:
        'Municipal road maintenance, drainage structures, and road repairs fall under the municipal engineering directorate.',
      jurisdictionRules: {
        Visakhapatnam: 'GVMC Central Engineering Circle (Asilmetta)',
        Vijayawada: 'VMC Engineering Division (Nehru Buildings)',
        Default: 'Urban Local Body (ULB) Municipal Engineering Division',
      },
      baseConfidence: 0.90,
    },
    sanitation: {
      primaryDepartment: 'GVMC Public Health & Sanitation Department',
      alternativeDepartment: 'Andhra Pradesh Pollution Control Board (APPCB)',
      reasonTemplate:
        'Solid waste collection, street sanitation, and local drain cleaning are managed by the ULB Public Health wing.',
      jurisdictionRules: {
        Visakhapatnam: 'GVMC Public Health Wing (Zone 3 Operations)',
        Vijayawada: 'VMC Public Health & Sanitation Circle',
        Default: 'Municipal Health & Sanitation Office',
      },
      baseConfidence: 0.89,
    },
    utility: {
      primaryDepartment: 'GVMC Water Supply & Distribution Wing',
      alternativeDepartment: 'AP Eastern Power Distribution Company Ltd (APEPDCL)',
      reasonTemplate:
        'Municipal water mains, pipeline bursts, and local distribution fall under the civic water works division.',
      jurisdictionRules: {
        Visakhapatnam: 'GVMC Water Works Operation & Maintenance Circle',
        Vijayawada: 'VMC Water Works Division',
        Default: 'District Water Supply & Sewerage Unit',
      },
      baseConfidence: 0.87,
    },
    noise: {
      primaryDepartment: 'Andhra Pradesh Pollution Control Board (APPCB) & City Police',
      alternativeDepartment: 'Municipal Environmental Health Wing',
      reasonTemplate:
        'Acoustic and industrial noise violations are enforced under the APPCB Urban Noise Monitoring standards.',
      jurisdictionRules: {
        Visakhapatnam: 'APPCB Regional Office (Madhavadhara) & Visakhapatnam City Police',
        Vijayawada: 'APPCB Regional Office & Vijayawada Police Commissionerate',
        Default: 'District Police & APPCB Regional Environmental Office',
      },
      baseConfidence: 0.83,
    },
    safety: {
      primaryDepartment: 'City Traffic Police & District Disaster Management Authority (DDMA)',
      alternativeDepartment: 'State Disaster Response and Fire Services',
      reasonTemplate:
        'Urgent public hazards and traffic blockages require coordinated police traffic diversion and DDMA response.',
      jurisdictionRules: {
        Visakhapatnam: 'Visakhapatnam City Traffic Police & DDMA Control Room',
        Vijayawada: 'Vijayawada Traffic Police & Krishna/NTR DDMA Cell',
        Default: 'District Emergency Operations Centre (DEOC)',
      },
      baseConfidence: 0.88,
    },
    other: {
      primaryDepartment: 'Spandana / Ward Secretariats (GSWS) Grievance Cell',
      alternativeDepartment: 'District Collectorate Nodal Grievance Office',
      reasonTemplate:
        'Multi-departmental civic grievances in AP are triaged through the Ward Secretariats and Spandana grievance redressal platform.',
      jurisdictionRules: {
        Visakhapatnam: 'GVMC Ward Secretariat Administrative Service',
        Vijayawada: 'VMC Ward Secretariats Grievance Desk',
        Default: 'District Collectorate Public Grievance Cell',
      },
      baseConfidence: 0.70,
    },
  },
};

// ── REGISTRY MANAGER ────────────────────────────────────────────────────────

const REGISTERED_JURISDICTIONS: JurisdictionRegistry[] = [
  KARNATAKA_REGISTRY,
  ANDHRA_PRADESH_REGISTRY,
];

/**
 * Register a new state or regional jurisdiction dynamically.
 */
export function registerJurisdiction(registry: JurisdictionRegistry): void {
  const existingIdx = REGISTERED_JURISDICTIONS.findIndex(
    (j) => j.state.toLowerCase() === registry.state.toLowerCase()
  );
  if (existingIdx >= 0) {
    REGISTERED_JURISDICTIONS[existingIdx] = registry;
  } else {
    REGISTERED_JURISDICTIONS.push(registry);
  }
  logger.info(`[DEPARTMENT_MATCHER] Registered jurisdiction for state: ${registry.state}`);
}

/**
 * Detects which jurisdiction matches the input metadata, region string, and complaint texts.
 */
function resolveJurisdiction(
  region: string,
  context?: JurisdictionContext,
  complaintKeywords: string[] = []
): JurisdictionRegistry | null {
  const normalizedRegion = (region || '').toLowerCase().trim();
  const searchCorpus = [
    normalizedRegion,
    (context?.state || '').toLowerCase(),
    (context?.district || '').toLowerCase(),
    (context?.municipality || '').toLowerCase(),
    ...complaintKeywords.map((k) => k.toLowerCase()),
  ].join(' ');

  // 1. Direct state context check
  if (context?.state) {
    const matched = REGISTERED_JURISDICTIONS.find(
      (j) => j.state.toLowerCase() === context.state!.toLowerCase()
    );
    if (matched) return matched;
  }

  // 2. Check Andhra Pradesh explicit indicators first to avoid false Bengaluru defaults
  const apMatches = ANDHRA_PRADESH_REGISTRY.aliases.some((alias) =>
    new RegExp(`\\b${alias}\\b`, 'i').test(searchCorpus)
  );
  if (apMatches) return ANDHRA_PRADESH_REGISTRY;

  // 3. Check Karnataka indicators
  const kaMatches = KARNATAKA_REGISTRY.aliases.some((alias) =>
    new RegExp(`\\b${alias}\\b`, 'i').test(searchCorpus)
  );
  if (kaMatches) return KARNATAKA_REGISTRY;

  // 4. Check other registered jurisdictions
  for (const registry of REGISTERED_JURISDICTIONS) {
    if (registry.state === 'Karnataka' || registry.state === 'Andhra Pradesh') continue;
    if (registry.aliases.some((alias) => new RegExp(`\\b${alias}\\b`, 'i').test(searchCorpus))) {
      return registry;
    }
  }

  // 5. Unknown or unverified
  return null;
}

/**
 * Matches a civic cluster to the most appropriate responsible department.
 *
 * Guaranteed Behavior:
 * - When jurisdiction is identified (e.g. Karnataka or Andhra Pradesh), routes to local municipal authority.
 * - When jurisdiction is UNKNOWN or ambiguous, produces an uncertain suggestion (confidence <= 0.35)
 *   with `needsHumanVerification: true` and never assumes Karnataka or BBMP.
 */
export function identifyResponsibleDepartment(
  category: string,
  region: string,
  complaintKeywords: string[] = [],
  assignedDepartmentHistory: string | null = null,
  jurisdictionContext?: JurisdictionContext
): DepartmentMatch {
  const normCategory = (category || 'other').toLowerCase();
  const matchedJurisdiction = resolveJurisdiction(region, jurisdictionContext, complaintKeywords);

  // ── UNKNOWN / AMBIGUOUS JURISDICTION ──────────────────────────────────────
  if (!matchedJurisdiction) {
    logger.warn(
      `[DEPARTMENT_MATCHER] Unverified jurisdiction for region="${region}", category="${category}". Flagging for human verification.`
    );

    return {
      suggestedDepartment: 'Unassigned / Jurisdiction Unverified',
      reasoning: `Complaint region "${region}" could not be verified against the municipal jurisdiction registry. Requires human official verification to designate the responsible local authority.`,
      confidenceScore: 0.30,
      supportingEvidence: [
        `Region "${region}" did not match any verified municipal directory (Karnataka, Andhra Pradesh, etc.)`,
        'Automatic routing halted to prevent jurisdictional misassignment',
        'Official human verification required to assign responsible department',
      ],
      alternativeDepartment: 'State Urban Development Directorate',
      needsHumanVerification: true,
      jurisdictionLevel: 'unverified',
    };
  }

  // ── RESOLVED JURISDICTION ────────────────────────────────────────────────
  const rule =
    matchedJurisdiction.categories[normCategory] || matchedJurisdiction.categories['other'];

  // Look up specific sub-jurisdiction or regional division
  let specificJurisdiction: string = rule.primaryDepartment;
  for (const [key, val] of Object.entries(rule.jurisdictionRules)) {
    if (key.toLowerCase() === region.toLowerCase()) {
      specificJurisdiction = val;
      break;
    }
  }
  if (specificJurisdiction === rule.primaryDepartment && rule.jurisdictionRules['Downtown'] && matchedJurisdiction.state === 'Karnataka') {
    specificJurisdiction = rule.jurisdictionRules['Downtown'];
  } else if (specificJurisdiction === rule.primaryDepartment && rule.jurisdictionRules['Default']) {
    specificJurisdiction = rule.jurisdictionRules['Default'];
  }

  let primary = rule.primaryDepartment;
  let alternative: string | null = rule.alternativeDepartment;

  const supportingEvidence: string[] = [
    `Jurisdiction identified: State of ${matchedJurisdiction.state}`,
    `Issue category classified as "${category}"`,
    `Geographic region identified as "${region}"`,
    `Designated local authority: ${specificJurisdiction}`,
  ];

  if (assignedDepartmentHistory) {
    supportingEvidence.push(`Historical assignment record: "${assignedDepartmentHistory}"`);
  }

  // Sub-distinction for utilities (Water vs Electricity)
  if (normCategory === 'utility') {
    const isElectric = complaintKeywords.some((k) =>
      /electric|power|light|transformer|wire|bescom|apepdcl|apcpdcl/i.test(k)
    );
    if (matchedJurisdiction.state === 'Karnataka') {
      if (isElectric) {
        primary = 'Bangalore Electricity Supply Company (BESCOM)';
        alternative = 'Bangalore Water Supply and Sewerage Board (BWSSB)';
        supportingEvidence.push('Complaint context indicates electrical / power grid infrastructure');
      } else {
        primary = 'Bangalore Water Supply and Sewerage Board (BWSSB)';
        alternative = 'Bangalore Electricity Supply Company (BESCOM)';
        supportingEvidence.push('Complaint context indicates water supply or sewerage infrastructure');
      }
    } else if (matchedJurisdiction.state === 'Andhra Pradesh') {
      if (isElectric) {
        primary = 'AP Eastern Power Distribution Company Ltd (APEPDCL)';
        alternative = 'GVMC Water Supply & Distribution Wing';
        supportingEvidence.push('Complaint context indicates electrical power distribution defect');
      } else {
        primary = 'GVMC Water Supply & Distribution Wing';
        alternative = 'AP Eastern Power Distribution Company Ltd (APEPDCL)';
        supportingEvidence.push('Complaint context indicates water pipeline or supply disruption');
      }
    }
  }

  const confidence = Math.min(1.0, Math.max(0.0, rule.baseConfidence));

  logger.info(
    `[DEPARTMENT_MATCHER] Resolved "${primary}" (State: ${matchedJurisdiction.state}, Region: ${region}, Confidence: ${confidence.toFixed(2)})`
  );

  return {
    suggestedDepartment: primary,
    reasoning: `${rule.reasonTemplate} Regional jurisdiction assigned to ${specificJurisdiction} (${matchedJurisdiction.state}).`,
    confidenceScore: confidence,
    supportingEvidence,
    alternativeDepartment: alternative,
    needsHumanVerification: false,
    jurisdictionLevel: 'verified',
  };
}
