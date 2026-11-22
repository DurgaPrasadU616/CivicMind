// backend/src/utils/agentLogger.ts
//
// Reusable agent execution logging utility.
//
// Provides:
//   logAgentStep()  — inserts one row into agent_execution_log (append-only)
//   startAgentRun() — creates a run_id and returns a bound step logger
//
// Design principles:
//   • NEVER throws — a logging failure must not crash the calling agent.
//   • Returns the inserted row ID (or null on failure) so callers can reference it.
//   • Works offline / without DB: logs a warning and returns null gracefully.
//   • No external dependencies beyond the existing pool and winston logger.
//
// Usage:
//   const run = startAgentRun('investigation', { clusterId: 42 });
//   await run.log({ stepName: 'fetch_cluster', status: 'success', outputData: { ... } });
//   await run.log({ stepName: 'generate_report', status: 'failed', errorMessage: 'timeout' });

import { randomUUID } from 'crypto';
import { pool } from '../config/db';
import logger from './logger';

// ── Types ─────────────────────────────────────────────────────────────────────

export type AgentType =
  | 'investigation'
  | 'routing'
  | 'planning'
  | 'monitoring'
  | 'hybrid_clustering'
  | 'media_analysis'
  | 'system';

export type AgentStepStatus = 'running' | 'success' | 'failed' | 'skipped';

export interface LogAgentStepInput {
  /** UUID grouping all steps of one agent invocation. */
  runId: string;
  /** Which autonomous agent is writing this log entry. */
  agentType: AgentType;
  /** 0-based position within the run. */
  stepIndex: number;
  /** Short human-readable label (e.g. 'fetch_cluster', 'embed_text'). */
  stepName: string;
  /** DB row for the cluster this run is working on (optional). */
  clusterId?: number | null;
  /** DB row for a specific complaint this step processed (optional). */
  complaintId?: number | null;
  /** Serialisable inputs fed into this step. */
  inputData?: Record<string, unknown> | null;
  /** Serialisable outputs produced by this step. */
  outputData?: Record<string, unknown> | null;
  /** LLM model identifier if an AI call was made (e.g. 'gemini-2.0-flash'). */
  modelUsed?: string | null;
  /** Token count reported by the AI SDK (optional). */
  tokensUsed?: number | null;
  /** Wall-clock duration in milliseconds for this step. */
  durationMs?: number | null;
  /** Step lifecycle status. */
  status: AgentStepStatus;
  /** Populated when status === 'failed'. */
  errorMessage?: string | null;
  /**
   * Who triggered this agent run.
   * Format: 'system' | 'cron' | 'api' | 'user:<userId>'
   */
  triggeredBy?: string;
}

export interface LogAgentStepResult {
  /** DB primary key of the inserted row, or null if the write failed. */
  id: number | null;
  runId: string;
}

export interface AgentRunHandle {
  /** The UUID for this run — pass to every step log. */
  runId: string;
  /** Agent type bound at run creation. */
  agentType: AgentType;
  /** Who triggered this run. */
  triggeredBy: string;
  /** Auto-incrementing step counter. */
  nextStepIndex: () => number;
  /**
   * Log one step.  stepIndex is auto-assigned if omitted.
   * Never throws — returns null on DB failure.
   */
  log: (opts: Omit<LogAgentStepInput, 'runId' | 'agentType' | 'triggeredBy' | 'stepIndex'> & { stepIndex?: number }) => Promise<LogAgentStepResult>;
}

// ── Core insert function ──────────────────────────────────────────────────────

/**
 * Writes one row to agent_execution_log.
 *
 * NEVER throws — if the DB write fails the error is logged at WARN level
 * and the function returns { id: null, runId }.  Agent callers must not
 * depend on this succeeding in order to continue their own logic.
 */
export const logAgentStep = async (input: LogAgentStepInput): Promise<LogAgentStepResult> => {
  const {
    runId,
    agentType,
    stepIndex,
    stepName,
    clusterId = null,
    complaintId = null,
    inputData = null,
    outputData = null,
    modelUsed = null,
    tokensUsed = null,
    durationMs = null,
    status,
    errorMessage = null,
    triggeredBy = 'system',
  } = input;

  if (!pool) {
    logger.warn(`[AGENT_LOG] DB pool unavailable — skipping log for run ${runId} step "${stepName}"`);
    return { id: null, runId };
  }

  try {
    const res = await pool.query(
      `INSERT INTO agent_execution_log
         (agent_type, cluster_id, complaint_id, run_id, step_index, step_name,
          input_data, output_data, model_used, tokens_used, duration_ms,
          status, error_message, triggered_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING id`,
      [
        agentType,
        clusterId,
        complaintId,
        runId,
        stepIndex,
        stepName,
        inputData ? JSON.stringify(inputData) : null,
        outputData ? JSON.stringify(outputData) : null,
        modelUsed,
        tokensUsed,
        durationMs,
        status,
        errorMessage,
        triggeredBy,
      ]
    );

    const insertedId: number = res.rows[0]?.id ?? null;
    logger.debug(`[AGENT_LOG] Logged step "${stepName}" (run=${runId}, step=${stepIndex}, status=${status})`);
    return { id: insertedId, runId };
  } catch (err: any) {
    logger.warn(
      `[AGENT_LOG] Failed to write agent_execution_log row for run ${runId} step "${stepName}": ${err.message}`
    );
    return { id: null, runId };
  }
};

// ── Convenience factory ───────────────────────────────────────────────────────

/**
 * Creates a bound run handle so callers don't have to repeat runId / agentType
 * on every step.  The step counter is auto-managed.
 *
 * @example
 * const run = startAgentRun('investigation', { clusterId: 42, triggeredBy: 'api' });
 * await run.log({ stepName: 'fetch_cluster', status: 'success', outputData: { title } });
 * await run.log({ stepName: 'generate_report', status: 'failed', errorMessage: 'timeout' });
 */
export const startAgentRun = (
  agentType: AgentType,
  options: {
    clusterId?: number | null;
    complaintId?: number | null;
    triggeredBy?: string;
    /** Supply a fixed runId (e.g. for resuming a run). Defaults to new UUID. */
    runId?: string;
  } = {}
): AgentRunHandle => {
  const runId = options.runId ?? randomUUID();
  const triggeredBy = options.triggeredBy ?? 'system';

  let _stepIndex = 0;
  const nextStepIndex = () => _stepIndex++;

  logger.info(`[AGENT_LOG] Starting agent run ${runId} (type=${agentType}, triggeredBy=${triggeredBy})`);

  const log = async (
    opts: Omit<LogAgentStepInput, 'runId' | 'agentType' | 'triggeredBy' | 'stepIndex'> & {
      stepIndex?: number;
    }
  ): Promise<LogAgentStepResult> => {
    const resolvedStepIndex = opts.stepIndex !== undefined ? opts.stepIndex : nextStepIndex();
    return logAgentStep({
      ...opts,
      runId,
      agentType,
      triggeredBy,
      stepIndex: resolvedStepIndex,
      clusterId: opts.clusterId ?? options.clusterId ?? null,
      complaintId: opts.complaintId ?? options.complaintId ?? null,
    });
  };

  return { runId, agentType, triggeredBy, nextStepIndex, log };
};
