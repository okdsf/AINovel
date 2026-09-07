import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { canonicalizeNativePasteText } from './native-gemini-paste.js';

const RUN_STATUSES = new Set([
  'draft',
  'queued',
  'running',
  'paused',
  'completed',
  'failed',
  'canceled',
  'needs_attention',
]);

const TASK_STATUSES = new Set([
  'pending',
  'leased',
  'submitted',
  'completed',
  'failed',
  'uncertain',
  'canceled',
]);

const EVENT_TYPES = new Set([
  'dispatching',
  'submitted',
  'completed',
  'failed',
  'blocked',
]);

const ACTIVE_TASK_STATUSES = new Set(['leased', 'submitted']);
const WORKFLOW_ACTIONS = new Set(['redo_only', 'send_then_redo', 'edit_then_redo']);
const REDO_SOURCES = new Set(['bound_user_turn', 'current_last_response']);
const REDO_OPTIONS = new Set(['try_again', 'longer', 'shorter']);
const ABSOLUTE_MAX_DELAY_MS = 60 * 60_000;
const MAX_DATE_MS = 8_640_000_000_000_000;

// Editing a historical prompt and then Redoing it is one Gemini branch event.
// Do not inject the generic inter-task cool-down between its accepted steps.
function isContinuousEditBranchStep(run, task) {
  return run?.runKind === 'workflow'
    && run?.actionBranch === 'edit_then_redo'
    && ['initial', 'redo'].includes(task?.workflowStep);
}

function taskCooldownMs(run, task) {
  return isContinuousEditBranchStep(run, task) ? 0 : run.minDelayMs;
}

export class AutomationStoreError extends Error {
  constructor(statusCode, code, message, details) {
    super(message);
    this.name = 'AutomationStoreError';
    this.status = statusCode;
    this.statusCode = statusCode;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function problem(statusCode, code, message, details) {
  return new AutomationStoreError(statusCode, code, message, details);
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function normalizeRedoOption(value) {
  const option = value == null || value === '' ? 'try_again' : String(value).trim().toLowerCase();
  return REDO_OPTIONS.has(option) ? option : null;
}

function toPosixPath(...parts) {
  return parts.join('/');
}

function parseTime(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isValidTime(value, headroomMs = 0) {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed)
    && parsed >= -MAX_DATE_MS
    && parsed <= MAX_DATE_MS - headroomMs;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sha256Text(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function normalizeTargetTurn(value) {
  if (!isPlainObject(value)) return null;
  const { turnKey, ordinal, sourceTextSha256, sourceTextLength } = value;
  if (
    typeof turnKey !== 'string'
    || !turnKey.trim()
    || turnKey.length > 500
    || !Number.isInteger(ordinal)
    || ordinal < 0
    || ordinal > 100_000
    || typeof sourceTextSha256 !== 'string'
    || !/^[a-f0-9]{64}$/.test(sourceTextSha256)
    || !Number.isInteger(sourceTextLength)
    || sourceTextLength < 0
    || sourceTextLength > 2_000_000
  ) return null;
  return {
    turnKey: turnKey.trim(),
    ordinal,
    sourceTextSha256,
    sourceTextLength,
  };
}

function normalizeTurnEvidence(value) {
  if (!isPlainObject(value)) return null;
  const expected = normalizeTargetTurn(value.expected);
  const observed = normalizeTargetTurn(value.observed);
  if (
    !expected
    || !observed
    || JSON.stringify(expected) !== JSON.stringify(observed)
    || typeof value.documentInstanceId !== 'string'
    || !value.documentInstanceId.trim()
    || value.documentInstanceId.length > 500
  ) return null;
  return {
    expected,
    observed,
    documentInstanceId: value.documentInstanceId.trim(),
  };
}

function normalizeVisibleThinkingSummary(value) {
  if (value == null) return null;
  if (!isPlainObject(value) || value.kind !== 'visible_ui_summary') return null;
  if (
    typeof value.text !== 'string'
    || value.text.length > 200_000
    || typeof value.textSha256 !== 'string'
    || value.textSha256 !== sha256Text(value.text)
    || !isValidTime(value.capturedAt)
  ) return null;
  return {
    kind: 'visible_ui_summary',
    text: value.text,
    textSha256: value.textSha256,
    capturedAt: new Date(Date.parse(value.capturedAt)).toISOString(),
  };
}

function normalizeResponseTiming(value) {
  if (!isPlainObject(value)) return null;
  const clientSubmittedAt = Date.parse(value.clientSubmittedAt);
  const completedAt = Date.parse(value.completedAt);
  if (!Number.isFinite(clientSubmittedAt) || !Number.isFinite(completedAt) || completedAt < clientSubmittedAt) {
    return null;
  }

  const firstResponseMissing = value.firstResponseVisibleAt == null && value.clickToFirstResponseMs == null;
  const inferredQuality = firstResponseMissing ? 'unobserved' : 'verified-body-change';
  const firstResponseTimingQuality = value.firstResponseTimingQuality ?? inferredQuality;
  if (!['verified-body-change', 'unobserved'].includes(firstResponseTimingQuality)) return null;

  let firstResponseVisibleAt = null;
  let clickToFirstResponseMs = null;
  if (firstResponseTimingQuality === 'unobserved') {
    if (!firstResponseMissing) return null;
  } else {
    const parsedFirstResponseVisibleAt = Date.parse(value.firstResponseVisibleAt);
    const parsedClickToFirstResponseMs = Number(value.clickToFirstResponseMs);
    if (
      !Number.isFinite(parsedFirstResponseVisibleAt)
      || parsedFirstResponseVisibleAt < clientSubmittedAt
      || completedAt < parsedFirstResponseVisibleAt
      || !Number.isFinite(parsedClickToFirstResponseMs)
      || parsedClickToFirstResponseMs < 0
      || parsedClickToFirstResponseMs > ABSOLUTE_MAX_DELAY_MS
      || Math.abs((parsedFirstResponseVisibleAt - clientSubmittedAt) - parsedClickToFirstResponseMs) > 2_000
    ) return null;
    firstResponseVisibleAt = new Date(parsedFirstResponseVisibleAt).toISOString();
    clickToFirstResponseMs = parsedClickToFirstResponseMs;
  }
  return {
    clientSubmittedAt: new Date(clientSubmittedAt).toISOString(),
    firstResponseVisibleAt,
    completedAt: new Date(completedAt).toISOString(),
    clickToFirstResponseMs,
    firstResponseTimingQuality,
    totalMs: completedAt - clientSubmittedAt,
  };
}

function normalizeGeminiConversationUrl(value, { requireConversationId = false } = {}) {
  if (typeof value !== 'string' || value.length > 4_096) return null;
  try {
    const url = new URL(value);
    const appConversation = /^\/app\/[A-Za-z0-9_-]+$/.test(url.pathname);
    const gemConversation = /^\/gem\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(url.pathname);
    const validPath = requireConversationId
      ? appConversation || gemConversation
      : /^\/app\/?$/.test(url.pathname) || appConversation || gemConversation;
    if (
      url.protocol !== 'https:'
      || url.hostname !== 'gemini.google.com'
      || url.port
      || url.username
      || url.password
      || !validPath
    ) return null;
    if (requireConversationId) {
      url.search = '';
      url.hash = '';
    }
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Durable, single-worker state machine for browser-driven AI automation.
 *
 * A run is the unit shown in NovelWeb. Each prompt/variant pair is persisted to
 * its own directory before the task can be leased. The manifest is the safety
 * source of truth; human-readable Markdown and JSONL artifacts make recovery
 * and manual inspection possible without this class.
 */
export class AutomationStore {
  constructor(rootDir, options = {}) {
    if (typeof rootDir !== 'string' || !rootDir.trim()) {
      throw problem(400, 'invalid_root', 'rootDir must be a non-empty path');
    }

    this.rootDir = path.resolve(rootDir);
    this.runsDir = path.join(this.rootDir, 'runs');
    this.snapshotsDir = path.join(this.rootDir, 'conversation-snapshots');
    this.workersPath = path.join(this.rootDir, 'workers.json');
    this.queueStatePath = path.join(this.rootDir, 'queue-state.json');
    this.vpnExperimentsPath = path.join(this.rootDir, 'vpn-experiments.json');
    this.options = {
      leaseMs: options.leaseMs ?? 120_000,
      retryBaseMs: options.retryBaseMs ?? 5_000,
      maxRetryDelayMs: options.maxRetryDelayMs ?? 5 * 60_000,
      maxPrompts: options.maxPrompts ?? 100,
      maxRedoRepeats: options.maxRedoRepeats ?? 100,
      maxPromptLength: options.maxPromptLength ?? 200_000,
      maxTitleLength: options.maxTitleLength ?? 200,
      maxDelayMs: options.maxDelayMs ?? ABSOLUTE_MAX_DELAY_MS,
      maxResponseHtmlBytes: options.maxResponseHtmlBytes ?? 5 * 1024 * 1024,
      workerPersistIntervalMs: options.workerPersistIntervalMs ?? 30_000,
      clock: options.clock ?? (() => Date.now()),
      idFactory: options.idFactory ?? (() => randomUUID()),
    };

    if (
      !Number.isFinite(this.options.leaseMs)
      || this.options.leaseMs < 1
      || this.options.leaseMs > ABSOLUTE_MAX_DELAY_MS
    ) {
      throw problem(400, 'invalid_option', `leaseMs must be between 1 and ${ABSOLUTE_MAX_DELAY_MS}`);
    }
    if (
      !Number.isFinite(this.options.retryBaseMs)
      || this.options.retryBaseMs < 1
      || this.options.retryBaseMs > ABSOLUTE_MAX_DELAY_MS
    ) {
      throw problem(
        400,
        'invalid_option',
        `retryBaseMs must be between 1 and ${ABSOLUTE_MAX_DELAY_MS}`,
      );
    }
    if (
      !Number.isFinite(this.options.maxRetryDelayMs)
      || this.options.maxRetryDelayMs < 1
      || this.options.maxRetryDelayMs > ABSOLUTE_MAX_DELAY_MS
    ) {
      throw problem(
        400,
        'invalid_option',
        `maxRetryDelayMs must be between 1 and ${ABSOLUTE_MAX_DELAY_MS}`,
      );
    }
    if (
      !Number.isFinite(this.options.maxDelayMs)
      || this.options.maxDelayMs < 5_000
      || this.options.maxDelayMs > ABSOLUTE_MAX_DELAY_MS
    ) {
      throw problem(
        400,
        'invalid_option',
        `maxDelayMs must be between 5000 and ${ABSOLUTE_MAX_DELAY_MS}`,
      );
    }
    if (!Number.isInteger(this.options.maxResponseHtmlBytes) || this.options.maxResponseHtmlBytes < 0) {
      throw problem(400, 'invalid_option', 'maxResponseHtmlBytes must be a non-negative integer');
    }
    if (!Number.isInteger(this.options.maxRedoRepeats) || this.options.maxRedoRepeats < 1) {
      throw problem(400, 'invalid_option', 'maxRedoRepeats must be a positive integer');
    }
    if (!Number.isFinite(this.options.workerPersistIntervalMs) || this.options.workerPersistIntervalMs < 1) {
      throw problem(400, 'invalid_option', 'workerPersistIntervalMs must be a positive number');
    }

    this._runs = new Map();
    this._conversationSnapshots = new Map();
    this._vpnExperiments = new Map();
    this._workers = new Map();
    this._workerPersistedAt = new Map();
    this._queueState = {
      schemaVersion: 1,
      globalNextAvailableAt: new Date(0).toISOString(),
      updatedAt: null,
    };
    this._initialized = false;
    this._operationTail = Promise.resolve();
    this._lastActivityAt = null;
  }

  init() {
    return this._serialize(async () => {
      if (this._initialized) return this;

      await fs.mkdir(this.runsDir, { recursive: true });
      await fs.mkdir(this.snapshotsDir, { recursive: true });
      try {
        const queueState = JSON.parse(await fs.readFile(this.queueStatePath, 'utf8'));
        if (queueState?.schemaVersion === 1 && typeof queueState.globalNextAvailableAt === 'string') {
          this._queueState = queueState;
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          throw problem(500, 'invalid_queue_state', `Unable to read queue state: ${error.message}`);
        }
      }
      try {
        const workerState = JSON.parse(await fs.readFile(this.workersPath, 'utf8'));
        if (Array.isArray(workerState?.workers)) {
          for (const worker of workerState.workers) {
            if (worker && typeof worker.id === 'string' && typeof worker.lastSeenAt === 'string') {
              this._workers.set(worker.id, worker);
              this._workerPersistedAt.set(worker.id, parseTime(worker.lastSeenAt));
            }
          }
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          throw problem(500, 'invalid_workers', `Unable to read worker state: ${error.message}`);
        }
      }
      try {
        const vpnState = JSON.parse(await fs.readFile(this.vpnExperimentsPath, 'utf8'));
        if (vpnState?.schemaVersion !== 1 || !Array.isArray(vpnState.experiments)) {
          throw new Error('invalid VPN experiment registry');
        }
        for (const experiment of vpnState.experiments) {
          this._validateLoadedVpnExperiment(experiment);
          this._vpnExperiments.set(experiment.id, experiment);
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          throw problem(500, 'invalid_vpn_experiments', `Unable to read VPN experiments: ${error.message}`);
        }
      }
      const entries = await fs.readdir(this.runsDir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const manifestPath = path.join(this.runsDir, entry.name, 'manifest.json');
        let run;
        try {
          run = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
        } catch (error) {
          if (error?.code === 'ENOENT') continue;
          throw problem(
            500,
            'invalid_manifest',
            `Unable to read automation manifest ${manifestPath}: ${error.message}`,
          );
        }

        this._validateLoadedRun(run, entry.name);
        this._runs.set(run.id, run);
      }

      const snapshotEntries = await fs.readdir(this.snapshotsDir, { withFileTypes: true });
      for (const entry of snapshotEntries) {
        if (!entry.isDirectory()) continue;
        const manifestPath = path.join(this.snapshotsDir, entry.name, 'manifest.json');
        let inspection;
        try {
          inspection = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
        } catch (error) {
          if (error?.code === 'ENOENT') continue;
          throw problem(500, 'invalid_snapshot_manifest', `Unable to read ${manifestPath}: ${error.message}`);
        }
        this._validateLoadedConversationSnapshot(inspection, entry.name);
        this._conversationSnapshots.set(inspection.id, inspection);
      }

      this._initialized = true;

      for (const run of this._runs.values()) {
        const completionReconciled = await this._reconcileCompletionArtifacts(run);
        const recoveryReconciled = await this._reconcileRecoveryArtifacts(run);
        if (completionReconciled || recoveryReconciled) {
          this._refreshRunStatus(run);
          await this._persistRun(run);
        }
      }

      await this._restoreThrottleFromRuns();

      await this._recoverExpiredLeases();
      await this._recoverExpiredSnapshotLeases();
      return this;
    });
  }

  createRun(input) {
    return this._serialize(async () => {
      this._assertInitialized();
      const normalized = this._validateRunInput(input);
      const now = this._nowIso();
      const runId = this._newRunId(now);
      const runDir = this._runDir(runId);
      await fs.mkdir(runDir, { recursive: false });

      const tasks = [];
      const taskInputs = normalized.runKind === 'workflow'
        ? [
            ...(normalized.actionBranch === 'redo_only'
              ? []
              : [{
                  variant: 1,
                  promptIndex: 1,
                  repeatIndex: null,
                  resultOrdinal: 0,
                  resultRole: 'initial',
                  workflowStep: 'initial',
                  prompt: normalized.prompt,
                  conversationAction: normalized.actionBranch === 'edit_then_redo' ? 'edit' : 'continue',
                  conversationUrl: normalized.conversationUrl,
                  targetTurn: normalized.targetTurn,
                }]),
            ...Array.from({ length: normalized.redoCount }, (_, redoOffset) => ({
              variant: 1,
              promptIndex: (normalized.actionBranch === 'redo_only' ? 0 : 1) + redoOffset + 1,
              repeatIndex: redoOffset + 1,
              resultOrdinal: redoOffset + 1,
              resultRole: 'redo',
              workflowStep: 'redo',
              prompt: normalized.sourcePrompt,
              conversationAction: 'redo',
              conversationUrl: normalized.conversationUrl,
              targetTurn: null,
              // Redo always means the exact conversation's current final
              // answer. Gemini may redraw historical user nodes after any
              // regeneration, so they are never an execution prerequisite.
              redoSource: 'current_last_response',
              redoOption: normalized.redoOption,
            })),
          ]
        : normalized.runKind === 'redo'
        ? Array.from({ length: normalized.repeatCount }, (_, repeatOffset) => ({
            variant: 1,
            promptIndex: repeatOffset + 1,
            repeatIndex: repeatOffset + 1,
            prompt: '',
            conversationAction: 'redo',
            conversationUrl: normalized.conversationUrl,
            redoSource: 'current_last_response',
            redoOption: normalized.redoOption,
          }))
        : Array.from({ length: normalized.variants }, (_, variantOffset) =>
            normalized.prompts.map((prompt, promptOffset) => ({
              variant: variantOffset + 1,
              promptIndex: promptOffset + 1,
              repeatIndex: null,
              prompt,
              conversationAction: normalized.conversationUrl
                ? 'continue'
                : normalized.mode === 'same_thread' && promptOffset > 0 ? 'continue' : 'new',
              conversationUrl: normalized.conversationUrl,
            }))).flat();

      // A run is a sequence of single units, not a pre-filled task queue.
      // Only materialise the first unit now; each following unit is created
      // only after its predecessor has a confirmed Gemini result.
      for (const [taskOffset, taskInput] of taskInputs.slice(0, 1).entries()) {
        const sequence = taskOffset + 1;
        const {
          variant,
          promptIndex,
          repeatIndex,
          prompt,
          conversationAction,
          conversationUrl,
          targetTurn = null,
          redoSource = 'bound_user_turn',
          redoOption = null,
          workflowStep = null,
          resultRole = null,
          resultOrdinal = null,
        } = taskInput;
        const taskId = `${runId}-v${String(variant).padStart(2, '0')}-p${String(promptIndex).padStart(3, '0')}`;
        const taskDirRelative = toPosixPath('tasks', taskId);
        const promptPath = toPosixPath(taskDirRelative, 'prompt.md');
        const taskDir = path.join(runDir, 'tasks', taskId);
        await fs.mkdir(taskDir, { recursive: true });

        // This write deliberately precedes the manifest. A task cannot become
        // visible to claimNext until its exact input marker is durable on disk.
        await this._atomicWriteText(path.join(runDir, ...promptPath.split('/')), prompt);

        tasks.push({
          id: taskId,
          runId,
          sequence,
          variant,
          promptIndex,
          repeatIndex,
          redoIndex: repeatIndex,
          workflowStep,
          resultRole,
          resultOrdinal,
          targetTurn,
          redoSource,
          redoOption,
          documentInstanceId: null,
          conversationAction,
          status: 'pending',
          attempt: 0,
          availableAt: now,
          lease: null,
          lastWorkerId: null,
          lastLeaseId: null,
          acceptLateTerminal: false,
          dispatchingAt: null,
          submittedAt: null,
          deliveryConfirmed: null,
          completedAt: null,
          failedAt: null,
          uncertainAt: null,
          conversationUrl,
          model: null,
          error: null,
          blocked: false,
          promptPath,
          responsePath: toPosixPath(taskDirRelative, 'response.md'),
          responseHtmlPath: null,
          turnPath: toPosixPath(taskDirRelative, 'turn.json'),
          eventsPath: toPosixPath(taskDirRelative, 'events.jsonl'),
          responseSha256: null,
          recovery: null,
          events: [],
        });
      }

      const run = {
        schemaVersion: 1,
        id: runId,
        title: normalized.title,
        runKind: normalized.runKind,
        mode: normalized.mode,
        prompts: normalized.prompts,
        variants: normalized.variants,
        conversationUrl: normalized.conversationUrl,
        repeatCount: normalized.repeatCount,
        actionBranch: normalized.actionBranch ?? null,
        redoCount: normalized.redoCount ?? null,
        redoOption: normalized.redoOption ?? null,
        targetTurn: normalized.targetTurn ?? null,
        sourceTurn: normalized.sourceTurn ?? null,
        sourcePrompt: normalized.sourcePrompt ?? null,
        plannedTaskTotal: taskInputs.length,
        unitPlan: taskInputs,
        requiredModel: normalized.requiredModel,
        minDelayMs: normalized.minDelayMs,
        maxRetries: normalized.maxRetries,
        status: 'draft',
        createdAt: now,
        updatedAt: now,
        queuedAt: null,
        startedAt: null,
        pausedAt: null,
        completedAt: null,
        canceledAt: null,
        needsAttentionAt: null,
        nextAvailableAt: now,
        transcriptPath: 'transcript.jsonl',
        tasks,
        stats: this._computeStats(tasks, taskInputs.length),
      };

      await this._persistRun(run);
      this._runs.set(run.id, run);
      this._markActivity(now);
      return clone(run);
    });
  }

  listRuns() {
    return this._serialize(async () => {
      this._assertInitialized();
      await this._recoverExpiredLeases();
      return [...this._runs.values()]
        .sort((a, b) => parseTime(b.createdAt) - parseTime(a.createdAt))
        .map((run) => this._runSummary(run));
    });
  }

  getRun(id) {
    return this._serialize(async () => {
      this._assertInitialized();
      await this._recoverExpiredLeases();
      const run = this._requireRun(id);
      const detail = clone(run);
      if (run.runKind === 'workflow') {
        const transcript = (await this._readJsonLines(this._artifactPath(run, run.transcriptPath)))
          .slice()
          .sort((a, b) => a.sequence - b.sequence);
        detail.resultGroup = {
          sourcePrompt: run.sourcePrompt,
          sourceTurn: run.sourceTurn ?? null,
          results: transcript.map((entry, index) => ({
            resultOrdinal: Number.isInteger(entry.resultOrdinal) ? entry.resultOrdinal : index,
            resultRole: entry.resultRole ?? (index === 0 ? 'initial' : 'redo'),
            response: entry.response,
            responseSha256: entry.responseSha256,
            visibleThinkingSummary: entry.visibleThinkingSummary ?? null,
            timing: entry.timing ?? null,
            telemetry: entry.telemetry ?? null,
            serverReceivedAt: entry.completedAt,
            conversationUrl: entry.conversationUrl ?? null,
          })),
        };
      }
      return detail;
    });
  }

  getRunResults(id, { promptLab = false } = {}) {
    return this._serialize(async () => {
      this._assertInitialized();
      await this._recoverExpiredLeases();
      const run = this._requireRun(id);
      const transcript = (await this._readJsonLines(this._artifactPath(run, run.transcriptPath)))
        .slice()
        .sort((a, b) => a.sequence - b.sequence);

      const sourcePrompt = run.runKind === 'workflow'
        ? run.sourcePrompt
        : transcript.find((entry) => typeof entry.prompt === 'string' && entry.prompt)?.prompt ?? '';
      const responses = transcript.map((entry, index) => {
        const basic = {
          ordinal: Number.isInteger(entry.resultOrdinal) ? entry.resultOrdinal : index,
          role: entry.resultRole ?? (index === 0 ? 'initial' : 'redo'),
          text: entry.response,
        };
        if (promptLab) return basic;
        return {
          ...basic,
          taskId: entry.taskId,
          conversationAction: entry.conversationAction,
          responseSha256: entry.responseSha256,
          visibleThinkingSummary: entry.visibleThinkingSummary ?? null,
          timing: entry.timing ?? null,
          telemetry: entry.telemetry ?? null,
          conversationUrl: entry.conversationUrl ?? null,
          model: entry.model ?? null,
          completedAt: entry.completedAt,
        };
      });

      if (promptLab) {
        return {
          schemaVersion: 1,
          runId: run.id,
          groups: [{ sourcePrompt, responses }],
        };
      }
      return {
        schemaVersion: 1,
        runId: run.id,
        actionBranch: run.actionBranch ?? null,
        sourcePrompt,
        sourceTurn: run.sourceTurn ?? null,
        responses,
      };
    });
  }

  createConversationSnapshot(input) {
    return this._serialize(async () => {
      this._assertInitialized();
      if (!isPlainObject(input)) {
        throw problem(400, 'invalid_input', 'Conversation snapshot input must be an object');
      }
      const conversationUrl = normalizeGeminiConversationUrl(input.conversationUrl, {
        requireConversationId: true,
      });
      if (!conversationUrl) {
        throw problem(
          400,
          'invalid_conversation_url',
          'conversationUrl must be an exact Gemini /app/<conversation-id> or /gem/<gem-id>/<conversation-id> URL',
        );
      }
      const now = this._nowIso();
      const id = this._newSnapshotId(now);
      const inspection = {
        schemaVersion: 1,
        id,
        kind: 'conversation_snapshot',
        conversationUrl,
        status: 'pending',
        createdAt: now,
        updatedAt: now,
        completedAt: null,
        failedAt: null,
        attempt: 0,
        lease: null,
        lastWorkerId: null,
        lastLeaseId: null,
        snapshotPath: null,
        snapshotSha256: null,
        error: null,
        events: [],
      };
      await fs.mkdir(this._snapshotDir(id), { recursive: false });
      await this._persistConversationSnapshot(inspection);
      this._conversationSnapshots.set(id, inspection);
      this._markActivity(now);
      return clone(inspection);
    });
  }

  listConversationSnapshots() {
    return this._serialize(async () => {
      this._assertInitialized();
      await this._recoverExpiredSnapshotLeases();
      return [...this._conversationSnapshots.values()]
        .sort((a, b) => parseTime(b.createdAt) - parseTime(a.createdAt))
        .map((item) => clone(item));
    });
  }

  getConversationSnapshot(id) {
    return this._serialize(async () => {
      this._assertInitialized();
      await this._recoverExpiredSnapshotLeases();
      const inspection = this._requireConversationSnapshot(id);
      let snapshot = null;
      if (inspection.snapshotPath) {
        snapshot = JSON.parse(await fs.readFile(
          path.join(this._snapshotDir(id), inspection.snapshotPath),
          'utf8',
        ));
      }
      return { ...clone(inspection), snapshot };
    });
  }

  heartbeatConversationSnapshot(id, { workerId, leaseId } = {}) {
    return this._serialize(async () => {
      this._assertInitialized();
      this._validateWorkerId(workerId);
      this._validateLeaseId(leaseId);
      await this._recoverExpiredSnapshotLeases();
      const inspection = this._requireConversationSnapshot(id);
      this._assertSnapshotLease(inspection, workerId, leaseId);
      const nowMs = this._nowMs();
      inspection.lease.heartbeatAt = new Date(nowMs).toISOString();
      inspection.lease.expiresAt = new Date(nowMs + this.options.leaseMs).toISOString();
      inspection.updatedAt = inspection.lease.heartbeatAt;
      await this._persistConversationSnapshot(inspection);
      return {
        ok: true,
        inspectionId: id,
        status: inspection.status,
        leaseId,
        leaseExpiresAt: inspection.lease.expiresAt,
      };
    });
  }

  recordConversationSnapshotEvent(id, event, { workerId } = {}) {
    return this._serialize(async () => {
      this._assertInitialized();
      this._validateWorkerId(workerId);
      await this._recoverExpiredSnapshotLeases();
      const inspection = this._requireConversationSnapshot(id);
      if (!isPlainObject(event)) throw problem(400, 'invalid_event', 'event must be an object');
      if (typeof event.eventId !== 'string' || !event.eventId.trim() || event.eventId.length > 300) {
        throw problem(400, 'invalid_event_id', 'eventId must be a stable non-empty string');
      }
      if (!['completed', 'failed'].includes(event.type)) {
        throw problem(400, 'invalid_inspection_event', 'Snapshot inspection only accepts completed or failed');
      }
      this._validateLeaseId(event.leaseId);
      const existing = inspection.events.find((candidate) => candidate.eventId === event.eventId);
      if (existing) {
        if (existing.type !== event.type || existing.leaseId !== event.leaseId) {
          throw problem(409, 'event_id_conflict', 'The inspection eventId was already used');
        }
        if (existing.workerId !== workerId) {
          throw problem(409, 'event_worker_mismatch', 'The inspection event belongs to another worker');
        }
        return { ok: true, duplicate: true, inspection: clone(inspection) };
      }
      this._assertSnapshotLease(inspection, workerId, event.leaseId);
      const conversationUrl = normalizeGeminiConversationUrl(event.conversationUrl, {
        requireConversationId: true,
      });
      if (conversationUrl !== inspection.conversationUrl) {
        throw problem(409, 'conversation_url_mismatch', 'Snapshot result belongs to another Gemini conversation');
      }
      const now = this._nowIso();
      const eventSummary = {
        eventId: event.eventId.trim(),
        type: event.type,
        workerId,
        leaseId: event.leaseId,
        at: now,
      };
      if (event.type === 'completed') {
        const snapshot = this._validateConversationSnapshotPayload(event);
        const serialized = `${JSON.stringify(snapshot, null, 2)}\n`;
        inspection.snapshotPath = 'snapshot.json';
        inspection.snapshotSha256 = sha256Text(serialized);
        await this._atomicWriteText(path.join(this._snapshotDir(id), inspection.snapshotPath), serialized);
        inspection.status = 'completed';
        inspection.completedAt = now;
        eventSummary.snapshotSha256 = inspection.snapshotSha256;
        eventSummary.turnCount = snapshot.turns.length;
      } else {
        const message = typeof event.error === 'string' && event.error.trim()
          ? event.error.slice(0, 20_000)
          : 'Conversation inspection failed';
        inspection.status = 'failed';
        inspection.failedAt = now;
        inspection.error = message;
        eventSummary.error = message;
      }
      inspection.lease = null;
      inspection.updatedAt = now;
      inspection.events.push(eventSummary);
      await this._persistConversationSnapshot(inspection);
      this._markActivity(now);
      return { ok: true, duplicate: false, inspection: clone(inspection) };
    });
  }

  createVpnExperiment(input) {
    return this._serialize(async () => {
      this._assertInitialized();
      if (!isPlainObject(input)) throw problem(400, 'invalid_input', 'VPN experiment input must be an object');
      const title = typeof input.title === 'string' ? input.title.trim() : '';
      if (!title || title.length > this.options.maxTitleLength) {
        throw problem(400, 'invalid_title', `title must be 1-${this.options.maxTitleLength} characters`);
      }
      const conversationUrl = normalizeGeminiConversationUrl(input.conversationUrl, {
        requireConversationId: true,
      });
      if (!conversationUrl) {
        throw problem(400, 'invalid_conversation_url', 'VPN experiment requires an exact Gemini conversation URL');
      }
      const now = this._nowIso();
      const suffix = String(this.options.idFactory('vpn')).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 12);
      if (!suffix) throw problem(500, 'invalid_id', 'idFactory returned an unusable identifier');
      const id = `vpn-${now.replace(/[-:.TZ]/g, '').slice(0, 14)}-${suffix}`;
      const experiment = {
        schemaVersion: 1,
        id,
        title,
        conversationUrl,
        createdAt: now,
        updatedAt: now,
        trials: [],
      };
      this._vpnExperiments.set(id, experiment);
      await this._persistVpnExperiments();
      return { ...clone(experiment), aggregates: [] };
    });
  }

  listVpnExperiments() {
    return this._serialize(async () => {
      this._assertInitialized();
      const experiments = [...this._vpnExperiments.values()]
        .sort((a, b) => parseTime(b.createdAt) - parseTime(a.createdAt));
      const output = [];
      for (const experiment of experiments) {
        output.push(await this._vpnExperimentDetail(experiment));
      }
      return output;
    });
  }

  getVpnExperiment(id) {
    return this._serialize(async () => {
      this._assertInitialized();
      const experiment = this._vpnExperiments.get(id);
      if (!experiment) throw problem(404, 'vpn_experiment_not_found', `VPN experiment ${id} was not found`);
      return this._vpnExperimentDetail(experiment);
    });
  }

  addVpnExperimentTrial(id, input) {
    return this._serialize(async () => {
      this._assertInitialized();
      const experiment = this._vpnExperiments.get(id);
      if (!experiment) throw problem(404, 'vpn_experiment_not_found', `VPN experiment ${id} was not found`);
      if (!isPlainObject(input)) throw problem(400, 'invalid_input', 'VPN trial input must be an object');
      const nodeLabel = typeof input.nodeLabel === 'string' ? input.nodeLabel.trim() : '';
      if (!nodeLabel || nodeLabel.length > 200) {
        throw problem(400, 'invalid_node_label', 'nodeLabel must be a non-empty string of at most 200 characters');
      }
      const run = this._requireRun(input.runId);
      if (run.runKind !== 'workflow' || run.actionBranch !== 'redo_only') {
        throw problem(409, 'invalid_trial_run', 'A VPN trial must reference a redo_only workflow run');
      }
      if (run.conversationUrl !== experiment.conversationUrl) {
        throw problem(409, 'trial_conversation_mismatch', 'VPN trial run belongs to another conversation');
      }
      const duplicateBinding = [...this._vpnExperiments.values()].find((candidateExperiment) => (
        candidateExperiment.trials.some((trial) => trial.runId === run.id)
      ));
      if (duplicateBinding) {
        throw problem(
          409,
          'duplicate_trial_run',
          `This run is already attached to VPN experiment ${duplicateBinding.id}`,
        );
      }
      const terminalTrialStatuses = new Set(['completed', 'canceled', 'needs_attention', 'failed']);
      let activeBinding = null;
      for (const candidateExperiment of this._vpnExperiments.values()) {
        const candidateTrial = candidateExperiment.trials.find((trial) => {
          const trialRun = this._runs.get(trial.runId);
          return trialRun && !terminalTrialStatuses.has(trialRun.status);
        });
        if (candidateTrial) {
          activeBinding = {
            experiment: candidateExperiment,
            trial: candidateTrial,
            run: this._runs.get(candidateTrial.runId),
          };
          break;
        }
      }
      if (activeBinding) {
        throw problem(
          409,
          'vpn_trial_active',
          `VPN experiment ${activeBinding.experiment.id} trial ${activeBinding.trial.id} is still ${activeBinding.run.status}; keep its network exit unchanged until it reaches a terminal state`,
        );
      }
      const now = this._nowIso();
      experiment.trials.push({
        id: `trial-${String(this.options.idFactory('trial')).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 16)}`,
        nodeLabel,
        runId: run.id,
        attachedAt: now,
      });
      experiment.updatedAt = now;
      await this._persistVpnExperiments();
      return this._vpnExperimentDetail(experiment);
    });
  }

  runAction(id, action) {
    return this._serialize(async () => {
      this._assertInitialized();
      await this._recoverExpiredLeases();
      const run = this._requireRun(id);
      const now = this._nowIso();

      switch (action) {
        case 'start': {
          if (run.status !== 'draft') {
            throw problem(409, 'invalid_transition', `Cannot start a ${run.status} run`);
          }
          run.status = 'queued';
          run.queuedAt = now;
          run.nextAvailableAt = now;
          break;
        }

        case 'pause': {
          if (!['queued', 'running'].includes(run.status)) {
            throw problem(409, 'invalid_transition', `Cannot pause a ${run.status} run`);
          }
          // A lease that has not crossed the dispatch write-ahead fence is
          // still safe to revoke. Because all store operations are serialized,
          // pause and dispatching have a deterministic winner: if pause lands
          // first the worker's later fence receives 409 and must not click; if
          // dispatching lands first the task is submitted and finishes in place.
          for (const task of run.tasks) {
            if (task.status !== 'leased') continue;
            task.status = 'pending';
            task.availableAt = now;
            task.lease = null;
            task.acceptLateTerminal = false;
            task.dispatchingAt = null;
            task.error = null;
          }
          run.status = 'paused';
          run.pausedAt = now;
          break;
        }

        case 'resume': {
          if (run.status !== 'paused') {
            throw problem(409, 'invalid_transition', `Cannot resume a ${run.status} run`);
          }
          run.status = run.startedAt ? 'running' : 'queued';
          run.pausedAt = null;
          break;
        }

        case 'cancel': {
          if (['completed', 'canceled'].includes(run.status)) {
            throw problem(409, 'invalid_transition', `Cannot cancel a ${run.status} run`);
          }
          run.status = 'canceled';
          run.canceledAt = now;
          for (const task of run.tasks) {
            if (task.status !== 'completed') {
              if (task.lastLeaseId) task.acceptLateTerminal = true;
              task.status = 'canceled';
              task.lease = null;
              task.availableAt = null;
            }
          }
          break;
        }

        case 'retry': {
          if (!['needs_attention', 'failed'].includes(run.status)) {
            throw problem(409, 'invalid_transition', `Cannot retry a ${run.status} run`);
          }
          const retryableTasks = run.tasks.filter((task) => ['failed', 'uncertain'].includes(task.status));
          if (retryableTasks.length === 0) {
            throw problem(409, 'nothing_to_retry', 'The run has no failed or uncertain task');
          }
          for (const task of retryableTasks) {
            task.status = 'pending';
            task.availableAt = now;
            task.lease = null;
            task.dispatchingAt = null;
            task.submittedAt = null;
            task.deliveryConfirmed = null;
            task.failedAt = null;
            task.uncertainAt = null;
            task.error = null;
            task.blocked = false;
          }
          run.needsAttentionAt = null;
          run.nextAvailableAt = now;
          run.status = run.startedAt ? 'running' : 'queued';
          break;
        }

        default:
          throw problem(400, 'invalid_action', 'action must be start, pause, resume, cancel, or retry');
      }

      run.updatedAt = now;
      run.stats = this._computeRunStats(run);
      await this._persistRun(run);
      this._markActivity(now);
      return clone(run);
    });
  }

  claimNext({ workerId, pageUrl, modelLabel, currentModel } = {}) {
    return this._serialize(async () => {
      this._assertInitialized();
      this._validateWorkerId(workerId);
      await this._recoverExpiredLeases();
      await this._recoverExpiredSnapshotLeases();
      await this._touchWorker(workerId, { pageUrl, modelLabel: modelLabel ?? currentModel });

      if (this._activeTask() || this._activeConversationSnapshot()) return null;

      const pendingInspection = [...this._conversationSnapshots.values()]
        .filter((item) => item.status === 'pending')
        .sort((a, b) => parseTime(a.createdAt) - parseTime(b.createdAt))[0];
      if (pendingInspection) {
        const nowMs = this._nowMs();
        const now = new Date(nowMs).toISOString();
        const leaseId = randomUUID();
        pendingInspection.status = 'leased';
        pendingInspection.attempt += 1;
        pendingInspection.lastWorkerId = workerId;
        pendingInspection.lastLeaseId = leaseId;
        pendingInspection.updatedAt = now;
        pendingInspection.lease = {
          leaseId,
          workerId,
          claimedAt: now,
          heartbeatAt: now,
          expiresAt: new Date(nowMs + this.options.leaseMs).toISOString(),
        };
        await this._persistConversationSnapshot(pendingInspection);
        this._markActivity(now);
        return {
          jobType: 'conversation_snapshot',
          inspectionId: pendingInspection.id,
          conversationAction: 'snapshot',
          conversationUrl: pendingInspection.conversationUrl,
          attempt: pendingInspection.attempt,
          leaseId,
          leaseExpiresAt: pendingInspection.lease.expiresAt,
        };
      }

      const nowMs = this._nowMs();
      const runs = [...this._runs.values()].sort(
        (a, b) => parseTime(a.createdAt) - parseTime(b.createdAt),
      );

      let selectedRun = null;
      let selectedTask = null;
      for (const run of runs) {
        if (!['queued', 'running'].includes(run.status)) continue;
        if (parseTime(run.nextAvailableAt) > nowMs) continue;

        const task = run.tasks
          .slice()
          .sort((a, b) => a.sequence - b.sequence)
          .find((candidate) => candidate.status === 'pending');
        if (!task || parseTime(task.availableAt) > nowMs) continue;

        selectedRun = run;
        selectedTask = task;
        break;
      }

      if (!selectedRun || !selectedTask) return null;

      const now = new Date(nowMs).toISOString();
      const leaseExpiresAt = new Date(nowMs + this.options.leaseMs).toISOString();
      const leaseId = randomUUID();
      selectedTask.status = 'leased';
      selectedTask.attempt += 1;
      selectedTask.lastWorkerId = workerId;
      selectedTask.lastLeaseId = leaseId;
      selectedTask.acceptLateTerminal = false;
      selectedTask.lease = {
        leaseId,
        workerId,
        claimedAt: now,
        heartbeatAt: now,
        expiresAt: leaseExpiresAt,
      };
      if (!selectedRun.startedAt) selectedRun.startedAt = now;
      selectedRun.status = 'running';
      selectedRun.updatedAt = now;
      selectedRun.stats = this._computeStats(selectedRun.tasks);

      // The lease becomes durable before its prompt is returned to a worker.
      await this._persistRun(selectedRun);
      const prompt = await fs.readFile(this._artifactPath(selectedRun, selectedTask.promptPath), 'utf8');
      const previous = this._previousTaskInVariant(selectedRun, selectedTask);
      this._markActivity(now);

      return {
        jobType: 'generation',
        runId: selectedRun.id,
        runTitle: selectedRun.title,
        runKind: selectedRun.runKind ?? 'prompt',
        taskId: selectedTask.id,
        sequence: selectedTask.sequence,
        variant: selectedTask.variant,
        promptIndex: selectedTask.promptIndex,
        prompt:
          selectedTask.conversationAction === 'redo'
            ? null
            : prompt,
        mode: selectedRun.mode,
        conversationAction: selectedTask.conversationAction,
        conversationUrl:
          ['continue', 'edit', 'redo'].includes(selectedTask.conversationAction)
            ? selectedTask.conversationUrl ?? previous?.conversationUrl ?? null
            : null,
        workflowStep: selectedTask.workflowStep ?? null,
        resultRole: selectedTask.resultRole ?? null,
        resultOrdinal: selectedTask.resultOrdinal ?? null,
        targetTurn: selectedTask.targetTurn ?? null,
        redoSource: selectedTask.redoSource ?? 'bound_user_turn',
        redoOption: selectedTask.conversationAction === 'redo'
          ? selectedTask.redoOption ?? selectedRun.redoOption ?? 'try_again'
          : null,
        sourceTurn: selectedTask.conversationAction === 'redo'
          && selectedTask.redoSource !== 'current_last_response'
          ? selectedRun.sourceTurn ?? selectedRun.targetTurn ?? null
          : null,
        repeatIndex: selectedTask.repeatIndex ?? null,
        redoIndex: selectedTask.redoIndex ?? selectedTask.repeatIndex ?? null,
        repeatCount: selectedRun.repeatCount ?? null,
        requiredModel: selectedRun.requiredModel,
        attempt: selectedTask.attempt,
        maxRetries: selectedRun.maxRetries,
        leaseId,
        leaseExpiresAt,
      };
    });
  }

  prepareNativePaste(taskId, { workerId, leaseId } = {}) {
    return this._serialize(async () => {
      this._assertInitialized();
      this._validateWorkerId(workerId);
      this._validateLeaseId(leaseId);
      await this._recoverExpiredLeases();
      const { run, task } = this._requireTask(taskId);
      if (
        run.runKind === 'redo'
        || !['continue', 'edit'].includes(task.conversationAction)
      ) {
        throw problem(
          409,
          'native_paste_unsupported_task',
          'Native paste is only available for send/edit tasks on an exact Gemini conversation',
        );
      }
      if (task.status !== 'leased' || task.dispatchingAt || task.submittedAt || !task.lease) {
        throw problem(409, 'native_paste_invalid_state', `Task ${taskId} is not safely awaiting prompt entry`);
      }
      if (task.lease.workerId !== workerId) {
        throw problem(409, 'lease_owner_mismatch', `Task ${taskId} is leased by another worker`);
      }
      if (task.lease.leaseId !== leaseId) {
        throw problem(409, 'lease_id_mismatch', `Task ${taskId} belongs to another attempt`);
      }
      const previous = this._previousTaskInVariant(run, task);
      const storedTargetUrl = task.conversationUrl ?? previous?.conversationUrl ?? null;
      const targetUrl = normalizeGeminiConversationUrl(storedTargetUrl, { requireConversationId: true });
      if (!targetUrl || targetUrl !== storedTargetUrl) {
        throw problem(409, 'native_paste_invalid_target', 'The task does not have an exact canonical Gemini conversation URL');
      }
      const prompt = await fs.readFile(this._artifactPath(run, task.promptPath), 'utf8');
      if (!prompt.trim()) {
        throw problem(409, 'native_paste_empty_prompt', 'The queued prompt is empty');
      }
      return {
        prompt,
        targetUrl,
        // The content script owns edit provenance through its exact clicked
        // user-turn root + live textarea binding. The native helper only has
        // OS-level visibility, so it must replace the one already-open Edit
        // prompt surface rather than try to reinterpret Gemini's UIA text.
        pasteMode: task.conversationAction === 'edit' ? 'replace-open-edit' : 'fill-empty',
        runId: run.id,
        taskId: task.id,
        leaseId,
      };
    });
  }

  heartbeat(taskId, { workerId, leaseId, pageUrl, modelLabel, currentModel } = {}) {
    return this._serialize(async () => {
      this._assertInitialized();
      this._validateWorkerId(workerId);
      this._validateLeaseId(leaseId);
      await this._recoverExpiredLeases();
      await this._touchWorker(workerId, { pageUrl, modelLabel: modelLabel ?? currentModel });
      const { run, task } = this._requireTask(taskId);

      if (!ACTIVE_TASK_STATUSES.has(task.status) || !task.lease) {
        throw problem(409, 'task_not_active', `Task ${taskId} is ${task.status}`);
      }
      if (task.lease.workerId !== workerId) {
        throw problem(409, 'lease_owner_mismatch', `Task ${taskId} is leased by another worker`);
      }
      if (task.lease.leaseId !== leaseId) {
        throw problem(409, 'lease_id_mismatch', `Task ${taskId} belongs to another attempt`);
      }

      const nowMs = this._nowMs();
      const now = new Date(nowMs).toISOString();
      task.lease.heartbeatAt = now;
      task.lease.expiresAt = new Date(nowMs + this.options.leaseMs).toISOString();
      run.updatedAt = now;
      await this._persistRun(run);
      this._markActivity(now);

      return {
        ok: true,
        taskId,
        status: task.status,
        leaseId,
        leaseExpiresAt: task.lease.expiresAt,
      };
    });
  }

  recordTaskEvent(taskId, event, { workerId } = {}) {
    return this._serialize(async () => {
      this._assertInitialized();
      this._validateWorkerId(workerId);
      await this._recoverExpiredLeases();
      const { run, task } = this._requireTask(taskId);
      const normalized = this._validateTaskEvent(event);
      if (
        run.runKind === 'workflow'
        && ['dispatching', 'submitted', 'completed'].includes(normalized.type)
      ) {
        const eventConversationUrl = normalizeGeminiConversationUrl(normalized.conversationUrl, {
          requireConversationId: true,
        });
        if (eventConversationUrl !== run.conversationUrl) {
          throw problem(
            409,
            normalized.conversationUrl ? 'conversation_url_mismatch' : 'conversation_url_required',
            'A workflow fence/result must identify the exact Gemini conversation bound to its run',
          );
        }
        normalized.conversationUrl = run.conversationUrl;

        const evidenceField = task.conversationAction === 'edit'
          ? 'targetTurnEvidence'
          : task.conversationAction === 'redo' && task.redoSource !== 'current_last_response'
            ? 'sourceTurnEvidence'
            : null;
        const expectedTurn = task.conversationAction === 'edit'
          ? task.targetTurn
          : task.conversationAction === 'redo' && task.redoSource !== 'current_last_response'
            ? run.sourceTurn
            : null;
        if (evidenceField) {
          const evidence = normalized[evidenceField];
          if (!expectedTurn || !evidence || JSON.stringify(evidence.expected) !== JSON.stringify(expectedTurn)) {
            throw problem(
              409,
              evidenceField === 'targetTurnEvidence'
                ? 'target_turn_evidence_mismatch'
                : 'source_turn_evidence_mismatch',
              'The observed Gemini turn does not match the durable workflow snapshot',
            );
          }
          if (
            task.documentInstanceId
            && evidence.documentInstanceId !== task.documentInstanceId
          ) {
            throw problem(
              409,
              'document_instance_mismatch',
              'Workflow evidence cannot be stitched across Gemini page reloads',
            );
          }
        }
        if (
          ['submitted', 'completed'].includes(normalized.type)
          && (!task.dispatchingAt || task.status === 'leased')
        ) {
          throw problem(409, 'workflow_dispatch_fence_required', 'Workflow result requires a durable pre-click dispatch fence');
        }
        if (normalized.type === 'completed' && !normalized.timing) {
          throw problem(400, 'timing_required', 'Workflow completion requires client response timing');
        }
        if (
          normalized.type === 'completed'
          && task.workflowStep === 'initial'
          && ['continue', 'edit'].includes(task.conversationAction)
          && !normalized.resultSourceTurn
        ) {
          throw problem(400, 'result_source_turn_required', 'Initial workflow completion requires resultSourceTurn for fenced Redo steps');
        }
        if (
          normalized.type === 'completed'
          && task.workflowStep === 'initial'
          && normalized.resultSourceTurn
        ) {
          const canonicalSource = canonicalizeNativePasteText(run.sourcePrompt);
          // Gemini normalizes whitespace when an existing historical prompt is
          // edited.  For an edit workflow the verified target binding proves
          // which message was changed; preserve the page's resulting turn as
          // the source for its following Redos instead of rejecting it for
          // presentation-only normalization.
          if (
            task.conversationAction !== 'edit'
            && (normalized.resultSourceTurn.sourceTextSha256 !== sha256Text(canonicalSource)
              || normalized.resultSourceTurn.sourceTextLength !== canonicalSource.length)
          ) {
            throw problem(
              409,
              'result_source_turn_mismatch',
              'The submitted user turn does not match the durable workflow prompt',
            );
          }
        }
      }
      if (
        run.runKind === 'redo'
        && ['dispatching', 'submitted', 'completed'].includes(normalized.type)
        && normalized.conversationUrl === undefined
      ) {
        throw problem(
          409,
          'conversation_url_required',
          'Redo dispatch and result events must identify their exact Gemini conversation',
        );
      }
      if (run.runKind === 'redo' && normalized.conversationUrl !== undefined) {
        const eventConversationUrl = normalizeGeminiConversationUrl(normalized.conversationUrl, {
          requireConversationId: true,
        });
        if (eventConversationUrl !== run.conversationUrl) {
          throw problem(
            409,
            'conversation_url_mismatch',
            'A redo result must belong to the conversation bound to its run',
          );
        }
        normalized.conversationUrl = run.conversationUrl;
      }

      const existingEvent = task.events.find((item) => item.eventId === normalized.eventId);
      if (existingEvent) {
        if (existingEvent.type !== normalized.type) {
          throw problem(
            409,
            'event_id_conflict',
            `eventId ${normalized.eventId} was already used for ${existingEvent.type}`,
          );
        }
        if (existingEvent.workerId && existingEvent.workerId !== workerId) {
          throw problem(409, 'event_worker_mismatch', 'The event belongs to another worker');
        }
        if (existingEvent.leaseId && existingEvent.leaseId !== normalized.leaseId) {
          throw problem(409, 'event_lease_mismatch', 'The event belongs to another lease');
        }
        if (['dispatching', 'submitted'].includes(existingEvent.type)) {
          const activeSameLease =
            task.lease
            && ACTIVE_TASK_STATUSES.has(task.status)
            && task.lease.workerId === workerId
            && task.lease.leaseId === normalized.leaseId;
          if (!activeSameLease) {
            throw problem(
              409,
              'stale_lease',
              'The dispatch lease is no longer active; the worker must not submit.',
            );
          }
        }
        if (
          existingEvent.type === 'completed'
          && existingEvent.responseSha256
          && createHash('sha256').update(normalized.response, 'utf8').digest('hex')
            !== existingEvent.responseSha256
        ) {
          throw problem(409, 'event_payload_conflict', 'The completed event payload has changed');
        }
        if (
          ['failed', 'blocked'].includes(existingEvent.type)
          && existingEvent.recoverySha256
          && typeof normalized.responsePartial === 'string'
          && createHash('sha256').update(normalized.responsePartial, 'utf8').digest('hex')
            !== existingEvent.recoverySha256
        ) {
          throw problem(409, 'event_payload_conflict', 'The recovery event payload has changed');
        }
        if (['completed', 'failed', 'blocked'].includes(existingEvent.type)) {
          const terminalAt = task.completedAt ?? task.failedAt ?? existingEvent.at;
          await this._setGlobalNextAvailableAt(
            new Date(parseTime(terminalAt) + taskCooldownMs(run, task)).toISOString(),
          );
        }
        // A previous attempt may have mutated memory but failed its atomic
        // manifest replacement. Never acknowledge a duplicate event until the
        // safety state is durable; dispatching in particular gates the click.
        await this._persistRun(run);
        await this._appendTaskEventLog(run, task, existingEvent);
        return {
          ok: true,
          duplicate: true,
          run: this._runSummary(run),
          task: clone(task),
        };
      }

      // A worker can be reloaded after claiming but before the dispatch fence.
      // Lease recovery safely returns that untouched task to pending, but the
      // old page may still report its local abort. Acknowledge only this narrow
      // no-click/no-response diagnostic so it cannot jam the durable outbox.
      const stalePreDispatchDiagnostic =
        ['failed', 'blocked'].includes(normalized.type)
        && task.status === 'pending'
        && !task.lease
        && !task.acceptLateTerminal
        && !task.dispatchingAt
        && !task.submittedAt
        && !normalized.responsePartial
        && task.lastWorkerId === workerId
        && task.lastLeaseId === normalized.leaseId;
      if (stalePreDispatchDiagnostic) {
        const now = new Date(this._nowMs()).toISOString();
        const eventSummary = {
          eventId: normalized.eventId,
          type: normalized.type,
          at: now,
          workerId,
          leaseId: normalized.leaseId,
          error: normalized.error || 'Worker aborted before dispatch',
          ignoredBeforeDispatch: true,
        };
        if (normalized.clientAt) eventSummary.clientAt = normalized.clientAt;
        if (normalized.conversationUrl) eventSummary.conversationUrl = normalized.conversationUrl;
        if (normalized.model) eventSummary.model = normalized.model;
        if (normalized.telemetry) eventSummary.telemetry = normalized.telemetry;
        if (normalized.targetTurnEvidence) eventSummary.targetTurnEvidence = normalized.targetTurnEvidence;
        if (normalized.sourceTurnEvidence) eventSummary.sourceTurnEvidence = normalized.sourceTurnEvidence;
        if (normalized.timing) eventSummary.timing = normalized.timing;
        task.events.push(eventSummary);
        await this._persistRun(run);
        await this._appendTaskEventLog(run, task, eventSummary);
        this._markActivity(now);
        return {
          ok: true,
          duplicate: false,
          ignoredBeforeDispatch: true,
          run: this._runSummary(run),
          task: clone(task),
        };
      }

      this._assertEventWorker(task, workerId, normalized.type, normalized.leaseId);
      const nowMs = this._nowMs();
      const now = new Date(nowMs).toISOString();
      const eventSummary = {
        eventId: normalized.eventId,
        type: normalized.type,
        at: now,
        workerId,
        leaseId: normalized.leaseId,
      };
      let advanceGlobalThrottle = false;

      if (normalized.clientAt) eventSummary.clientAt = normalized.clientAt;
      if (normalized.conversationUrl) eventSummary.conversationUrl = normalized.conversationUrl;
      if (normalized.model) eventSummary.model = normalized.model;
      if (normalized.telemetry) eventSummary.telemetry = normalized.telemetry;
      if (normalized.targetTurnEvidence) eventSummary.targetTurnEvidence = normalized.targetTurnEvidence;
      if (normalized.sourceTurnEvidence) eventSummary.sourceTurnEvidence = normalized.sourceTurnEvidence;
      if (normalized.timing) eventSummary.timing = normalized.timing;
      if (normalized.visibleThinkingSummary !== undefined) {
        eventSummary.visibleThinkingSummary = normalized.visibleThinkingSummary;
      }

      switch (normalized.type) {
        case 'dispatching':
          if (task.status !== 'leased') {
            throw problem(409, 'invalid_task_transition', `Cannot dispatch a ${task.status} task`);
          }
          task.dispatchingAt = now;
          task.documentInstanceId = normalized.targetTurnEvidence?.documentInstanceId
            ?? normalized.sourceTurnEvidence?.documentInstanceId
            ?? task.documentInstanceId;
          // Write-ahead safety fence: the worker records dispatching immediately
          // before the irreversible click/keypress. From this point onward the
          // task may have consumed quota, so lease expiry must never auto-retry.
          task.status = 'submitted';
          task.submittedAt = now;
          task.deliveryConfirmed = false;
          eventSummary.deliveryConfirmed = false;
          if (task.lease) {
            task.lease.heartbeatAt = now;
            task.lease.expiresAt = new Date(nowMs + this.options.leaseMs).toISOString();
          }
          break;

        case 'submitted':
          if (!['leased', 'submitted'].includes(task.status)) {
            throw problem(409, 'invalid_task_transition', `Cannot submit a ${task.status} task`);
          }
          task.status = 'submitted';
          task.submittedAt = task.submittedAt ?? now;
          task.deliveryConfirmed = true;
          eventSummary.deliveryConfirmed = true;
          task.conversationUrl = normalized.conversationUrl ?? task.conversationUrl;
          task.model = normalized.model ?? task.model;
          if (task.lease) {
            task.lease.heartbeatAt = now;
            task.lease.expiresAt = new Date(nowMs + this.options.leaseMs).toISOString();
          }
          break;

        case 'completed':
          if (task.status === 'completed') {
            throw problem(409, 'already_completed', `Task ${task.id} is already completed`);
          }
          const isAcceptedLatePending = task.status === 'pending' && task.acceptLateTerminal;
          if (
            !['leased', 'submitted', 'uncertain', 'canceled'].includes(task.status)
            && !isAcceptedLatePending
          ) {
            throw problem(409, 'invalid_task_transition', `Cannot complete a ${task.status} task`);
          }
          await this._writeCompletionArtifacts(run, task, normalized, eventSummary, now);
          task.status = 'completed';
          task.completedAt = now;
          task.deliveryConfirmed = true;
          task.acceptLateTerminal = false;
          task.lease = null;
          task.error = null;
          task.blocked = false;
          task.conversationUrl = normalized.conversationUrl ?? task.conversationUrl;
          task.model = normalized.model ?? task.model;
          task.responseSha256 = createHash('sha256').update(normalized.response, 'utf8').digest('hex');
          eventSummary.responseSha256 = task.responseSha256;
          if (normalized.resultSourceTurn) {
            task.resultSourceTurn = normalized.resultSourceTurn;
            if (run.runKind === 'workflow' && task.workflowStep === 'initial') {
              run.sourceTurn = normalized.resultSourceTurn;
            }
          }
          const continuationCooldownMs = taskCooldownMs(run, task);
          run.nextAvailableAt = new Date(nowMs + continuationCooldownMs).toISOString();
          await this._appendNextUnitTask(run, now);
          advanceGlobalThrottle = continuationCooldownMs > 0;
          break;

        case 'failed': {
          if (task.status === 'canceled') {
            const message = normalized.error || 'Worker reported a late failure after cancellation';
            task.conversationUrl = normalized.conversationUrl ?? task.conversationUrl;
            task.model = normalized.model ?? task.model;
            if (normalized.responsePartial?.length) {
              task.recovery = await this._writeRecoveryArtifacts(
                run,
                task,
                normalized,
                now,
                message,
                workerId,
              );
              eventSummary.recoveryPath = task.recovery.recoveryPath;
              eventSummary.recoverySha256 = task.recovery.sha256;
            }
            eventSummary.error = message;
            eventSummary.ignoredAfterCancel = true;
            break;
          }
          if (!['leased', 'submitted', 'uncertain'].includes(task.status)) {
            throw problem(409, 'invalid_task_transition', `Cannot fail a ${task.status} task`);
          }
          const message = normalized.error || 'Worker reported an unknown failure';
          task.conversationUrl = normalized.conversationUrl ?? task.conversationUrl;
          task.model = normalized.model ?? task.model;
          if (normalized.responsePartial?.length) {
            task.recovery = await this._writeRecoveryArtifacts(
              run,
              task,
              normalized,
              now,
              message,
              workerId,
            );
            eventSummary.recoveryPath = task.recovery.recoveryPath;
            eventSummary.recoverySha256 = task.recovery.sha256;
          }
          const crossedDispatchFence = task.status !== 'leased' || Boolean(task.dispatchingAt);
          const canRetry =
            normalized.retryable
            && !crossedDispatchFence
            && task.attempt <= run.maxRetries;
          eventSummary.error = message;
          eventSummary.retryable = normalized.retryable;
          eventSummary.willRetry = canRetry;
          task.error = {
            code: crossedDispatchFence ? 'worker_failed_after_dispatch' : 'worker_failed',
            message,
            at: now,
            retryable: normalized.retryable,
          };
          task.failedAt = now;
          task.lease = null;
          if (canRetry) {
            const exponential = this.options.retryBaseMs * (2 ** Math.max(0, task.attempt - 1));
            const delay = Math.max(
              run.minDelayMs,
              Math.min(exponential, this.options.maxRetryDelayMs),
            );
            task.status = 'pending';
            task.deliveryConfirmed = null;
            task.acceptLateTerminal = false;
            task.availableAt = new Date(nowMs + delay).toISOString();
            run.nextAvailableAt = task.availableAt;
          } else if (crossedDispatchFence) {
            task.status = 'uncertain';
            task.uncertainAt = now;
            task.acceptLateTerminal = true;
            eventSummary.requiresAttention = true;
          } else {
            task.status = 'failed';
          }
          advanceGlobalThrottle = true;
          break;
        }

        case 'blocked': {
          if (task.status === 'canceled') {
            const message = normalized.error || 'Worker reported a late blocker after cancellation';
            task.conversationUrl = normalized.conversationUrl ?? task.conversationUrl;
            task.model = normalized.model ?? task.model;
            if (normalized.responsePartial?.length) {
              task.recovery = await this._writeRecoveryArtifacts(
                run,
                task,
                normalized,
                now,
                message,
                workerId,
              );
              eventSummary.recoveryPath = task.recovery.recoveryPath;
              eventSummary.recoverySha256 = task.recovery.sha256;
            }
            eventSummary.error = message;
            eventSummary.ignoredAfterCancel = true;
            break;
          }
          if (!['leased', 'submitted', 'uncertain'].includes(task.status)) {
            throw problem(409, 'invalid_task_transition', `Cannot block a ${task.status} task`);
          }
          const message = normalized.error || 'Worker requires user attention';
          eventSummary.error = message;
          task.conversationUrl = normalized.conversationUrl ?? task.conversationUrl;
          task.model = normalized.model ?? task.model;
          if (normalized.responsePartial?.length) {
            task.recovery = await this._writeRecoveryArtifacts(
              run,
              task,
              normalized,
              now,
              message,
              workerId,
            );
            eventSummary.recoveryPath = task.recovery.recoveryPath;
            eventSummary.recoverySha256 = task.recovery.sha256;
          }
          task.acceptLateTerminal = task.status === 'submitted' || Boolean(task.dispatchingAt);
          task.status = 'failed';
          task.failedAt = now;
          task.lease = null;
          task.blocked = true;
          task.error = {
            code: 'worker_blocked',
            message,
            at: now,
            retryable: false,
          };
          advanceGlobalThrottle = true;
          break;
        }

        default:
          throw problem(400, 'invalid_event', `Unsupported event ${normalized.type}`);
      }

      task.events.push(eventSummary);
      run.updatedAt = now;
      this._refreshRunStatus(run);

      if (advanceGlobalThrottle) {
        await this._setGlobalNextAvailableAt(
          new Date(nowMs + taskCooldownMs(run, task)).toISOString(),
        );
      }

      // The manifest is written before the audit JSONL. In particular, a
      // submitted marker must be crash-safe before a request can time out; this
      // ordering prevents automatic duplicate submissions after restart.
      await this._persistRun(run);
      await this._appendTaskEventLog(run, task, eventSummary);
      this._markActivity(now);

      return {
        ok: true,
        duplicate: false,
        run: this._runSummary(run),
        task: clone(task),
      };
    });
  }

  getWorkerStatus() {
    return this._serialize(async () => {
      this._assertInitialized();
      await this._recoverExpiredLeases();
      await this._recoverExpiredSnapshotLeases();
      const active = this._activeTask();
      const activeInspection = this._activeConversationSnapshot();
      let queuedTasks = 0;
      let delayedTasks = 0;
      let needsAttentionRuns = 0;
      let pausedRuns = 0;

      const nowMs = this._nowMs();
      for (const run of this._runs.values()) {
        if (run.status === 'needs_attention') needsAttentionRuns += 1;
        if (run.status === 'paused') pausedRuns += 1;
        if (!['queued', 'running'].includes(run.status)) continue;
        for (const task of run.tasks) {
          if (task.status !== 'pending') continue;
          queuedTasks += 1;
          if (parseTime(task.availableAt) > nowMs || parseTime(run.nextAvailableAt) > nowMs) {
            delayedTasks += 1;
          }
        }
      }

      return {
        now: new Date(nowMs).toISOString(),
        active: active
          ? {
              jobType: 'generation',
              runId: active.run.id,
              taskId: active.task.id,
              status: active.task.status,
              workerId: active.task.lease?.workerId ?? active.task.lastWorkerId,
              leaseExpiresAt: active.task.lease?.expiresAt ?? null,
            }
          : activeInspection
            ? {
                jobType: 'conversation_snapshot',
                inspectionId: activeInspection.id,
                status: activeInspection.status,
                workerId: activeInspection.lease?.workerId ?? activeInspection.lastWorkerId,
                leaseExpiresAt: activeInspection.lease?.expiresAt ?? null,
              }
            : null,
        queuedTasks,
        queuedInspections: [...this._conversationSnapshots.values()]
          .filter((item) => item.status === 'pending').length,
        delayedTasks,
        needsAttentionRuns,
        pausedRuns,
        globalNextAvailableAt: this._queueState.globalNextAvailableAt,
        globallyBlocked: this._hasGlobalSafetyBlock(),
        lastActivityAt: this._lastActivityAt,
        ...this._latestWorkerFields(),
        workers: [...this._workers.values()]
          .sort((a, b) => parseTime(b.lastSeenAt) - parseTime(a.lastSeenAt))
          .map((worker) => clone(worker)),
      };
    });
  }

  _serialize(operation) {
    const guarded = async () => {
      try {
        return await operation();
      } catch (error) {
        if (error && error.statusCode === undefined) error.statusCode = 500;
        if (error && error.status === undefined) error.status = error.statusCode ?? 500;
        throw error;
      }
    };
    const result = this._operationTail.then(guarded, guarded);
    this._operationTail = result.catch(() => undefined);
    return result;
  }

  _assertInitialized() {
    if (!this._initialized) {
      throw problem(500, 'not_initialized', 'AutomationStore.init() must be awaited first');
    }
  }

  _nowMs() {
    const value = Number(this.options.clock());
    if (
      !Number.isFinite(value)
      || value < -MAX_DATE_MS
      || value > MAX_DATE_MS - ABSOLUTE_MAX_DELAY_MS
    ) {
      throw problem(500, 'invalid_clock', 'The configured clock returned an unsafe timestamp');
    }
    return value;
  }

  _nowIso() {
    return new Date(this._nowMs()).toISOString();
  }

  _markActivity(at) {
    this._lastActivityAt = at;
  }

  _newRunId(now) {
    const stamp = now.replace(/[-:.TZ]/g, '').slice(0, 14);
    const suffix = String(this.options.idFactory('run')).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 12);
    if (!suffix) throw problem(500, 'invalid_id', 'idFactory returned an unusable identifier');
    return `run-${stamp}-${suffix}`;
  }

  _newSnapshotId(now) {
    const stamp = now.replace(/[-:.TZ]/g, '').slice(0, 14);
    const suffix = String(this.options.idFactory('snapshot')).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 12);
    if (!suffix) throw problem(500, 'invalid_id', 'idFactory returned an unusable identifier');
    return `snapshot-${stamp}-${suffix}`;
  }

  _snapshotDir(id) {
    if (typeof id !== 'string' || !/^snapshot-[A-Za-z0-9_-]+$/.test(id)) {
      throw problem(400, 'invalid_snapshot_id', 'Invalid conversation snapshot id');
    }
    return path.join(this.snapshotsDir, id);
  }

  _requireConversationSnapshot(id) {
    const inspection = this._conversationSnapshots.get(id);
    if (!inspection) {
      throw problem(404, 'conversation_snapshot_not_found', `Conversation snapshot ${id} was not found`);
    }
    return inspection;
  }

  _assertSnapshotLease(inspection, workerId, leaseId) {
    if (inspection.status !== 'leased' || !inspection.lease) {
      throw problem(409, 'snapshot_not_leased', `Conversation snapshot ${inspection.id} is ${inspection.status}`);
    }
    if (inspection.lease.workerId !== workerId) {
      throw problem(409, 'lease_owner_mismatch', 'Conversation snapshot is leased by another worker');
    }
    if (inspection.lease.leaseId !== leaseId) {
      throw problem(409, 'lease_id_mismatch', 'Conversation snapshot belongs to another attempt');
    }
  }

  _activeConversationSnapshot() {
    return [...this._conversationSnapshots.values()].find((item) => item.status === 'leased') ?? null;
  }

  async _persistConversationSnapshot(inspection) {
    await this._atomicWriteJson(path.join(this._snapshotDir(inspection.id), 'manifest.json'), inspection);
  }

  _validateLoadedConversationSnapshot(inspection, directoryName) {
    if (
      !isPlainObject(inspection)
      || inspection.schemaVersion !== 1
      || inspection.id !== directoryName
      || inspection.kind !== 'conversation_snapshot'
      || !['pending', 'leased', 'completed', 'failed'].includes(inspection.status)
      || normalizeGeminiConversationUrl(inspection.conversationUrl, { requireConversationId: true })
        !== inspection.conversationUrl
      || !isValidTime(inspection.createdAt, ABSOLUTE_MAX_DELAY_MS)
      || !isValidTime(inspection.updatedAt, ABSOLUTE_MAX_DELAY_MS)
      || !Array.isArray(inspection.events)
    ) {
      throw problem(500, 'invalid_snapshot_manifest', `Invalid conversation snapshot manifest in ${directoryName}`);
    }
    if ((inspection.status === 'leased') !== Boolean(inspection.lease)) {
      throw problem(500, 'invalid_snapshot_manifest', `Snapshot lease invariant failed in ${directoryName}`);
    }
    if (inspection.lease && (
      typeof inspection.lease.leaseId !== 'string'
      || typeof inspection.lease.workerId !== 'string'
      || !isValidTime(inspection.lease.claimedAt, ABSOLUTE_MAX_DELAY_MS)
      || !isValidTime(inspection.lease.heartbeatAt, ABSOLUTE_MAX_DELAY_MS)
      || !isValidTime(inspection.lease.expiresAt, ABSOLUTE_MAX_DELAY_MS)
    )) {
      throw problem(500, 'invalid_snapshot_manifest', `Invalid snapshot lease in ${directoryName}`);
    }
  }

  _validateConversationSnapshotPayload(event) {
    if (
      typeof event.documentInstanceId !== 'string'
      || !event.documentInstanceId.trim()
      || event.documentInstanceId.length > 500
      || (event.title !== undefined && (typeof event.title !== 'string' || event.title.length > 1_000))
      || !Array.isArray(event.turns)
      || event.turns.length > 5_000
    ) {
      throw problem(400, 'invalid_conversation_snapshot', 'Snapshot metadata or turns are malformed');
    }
    let totalUtf8Bytes = 0;
    const seenKeys = new Set();
    const seenOrdinals = new Set();
    const turns = event.turns.map((turn) => {
      if (!isPlainObject(turn)) {
        throw problem(400, 'invalid_snapshot_turn', 'Each snapshot turn must be an object');
      }
      const text = turn.text;
      const canonicalText = typeof text === 'string' ? canonicalizeNativePasteText(text) : '';
      totalUtf8Bytes += Buffer.byteLength(text ?? '', 'utf8');
      if (
        typeof turn.turnKey !== 'string'
        || !turn.turnKey.trim()
        || turn.turnKey.length > 500
        || seenKeys.has(turn.turnKey)
        || !Number.isInteger(turn.ordinal)
        || turn.ordinal < 0
        || turn.ordinal > 100_000
        || seenOrdinals.has(turn.ordinal)
        || !['user', 'model'].includes(turn.role)
        || typeof text !== 'string'
        || turn.textSha256 !== sha256Text(canonicalText)
        || turn.textLength !== canonicalText.length
        || typeof turn.editable !== 'boolean'
        || (turn.responseOrdinal !== undefined
          && (!Number.isInteger(turn.responseOrdinal) || turn.responseOrdinal < 0))
      ) {
        throw problem(400, 'invalid_snapshot_turn', 'Snapshot turn identity, text hash, or metadata is invalid');
      }
      const visibleThinkingSummary = turn.visibleThinkingSummary === undefined
        ? undefined
        : normalizeVisibleThinkingSummary(turn.visibleThinkingSummary);
      if (turn.visibleThinkingSummary !== undefined && turn.visibleThinkingSummary !== null && !visibleThinkingSummary) {
        throw problem(400, 'invalid_visible_thinking_summary', 'Snapshot visible thinking summary is invalid');
      }
      seenKeys.add(turn.turnKey);
      seenOrdinals.add(turn.ordinal);
      return {
        turnKey: turn.turnKey.trim(),
        ordinal: turn.ordinal,
        role: turn.role,
        text,
        textSha256: turn.textSha256,
        textLength: turn.textLength,
        editable: turn.editable,
        ...(turn.responseOrdinal === undefined ? {} : { responseOrdinal: turn.responseOrdinal }),
        ...(visibleThinkingSummary === undefined ? {} : { visibleThinkingSummary }),
      };
    });
    if (totalUtf8Bytes > 10 * 1024 * 1024) {
      throw problem(413, 'conversation_snapshot_too_large', 'Conversation snapshot text exceeds 10 MiB');
    }
    turns.sort((a, b) => a.ordinal - b.ordinal);
    return {
      schemaVersion: 1,
      conversationUrl: normalizeGeminiConversationUrl(event.conversationUrl, { requireConversationId: true }),
      documentInstanceId: event.documentInstanceId.trim(),
      title: typeof event.title === 'string' ? event.title : null,
      capturedAt: this._nowIso(),
      turns,
    };
  }

  async _recoverExpiredSnapshotLeases() {
    const nowMs = this._nowMs();
    const now = new Date(nowMs).toISOString();
    for (const inspection of this._conversationSnapshots.values()) {
      if (inspection.status !== 'leased' || !inspection.lease) continue;
      if (parseTime(inspection.lease.expiresAt) > nowMs) continue;
      const expiredLease = inspection.lease;
      inspection.status = 'pending';
      inspection.lease = null;
      inspection.updatedAt = now;
      inspection.events.push({
        eventId: `system:lease-expired:${expiredLease.leaseId}:${expiredLease.expiresAt}`,
        type: 'lease_expired',
        at: now,
        workerId: expiredLease.workerId,
        leaseId: expiredLease.leaseId,
      });
      await this._persistConversationSnapshot(inspection);
      this._markActivity(now);
    }
  }

  _validateLoadedVpnExperiment(experiment) {
    if (
      !isPlainObject(experiment)
      || experiment.schemaVersion !== 1
      || typeof experiment.id !== 'string'
      || !/^vpn-[A-Za-z0-9_-]+$/.test(experiment.id)
      || typeof experiment.title !== 'string'
      || !experiment.title.trim()
      || normalizeGeminiConversationUrl(experiment.conversationUrl, { requireConversationId: true })
        !== experiment.conversationUrl
      || !isValidTime(experiment.createdAt, ABSOLUTE_MAX_DELAY_MS)
      || !isValidTime(experiment.updatedAt, ABSOLUTE_MAX_DELAY_MS)
      || !Array.isArray(experiment.trials)
      || experiment.trials.some((trial) => (
        !isPlainObject(trial)
        || typeof trial.id !== 'string'
        || typeof trial.nodeLabel !== 'string'
        || !trial.nodeLabel.trim()
        || typeof trial.runId !== 'string'
        || !isValidTime(trial.attachedAt, ABSOLUTE_MAX_DELAY_MS)
      ))
    ) throw problem(500, 'invalid_vpn_experiment', 'VPN experiment registry contains invalid data');
  }

  async _persistVpnExperiments() {
    await this._atomicWriteJson(this.vpnExperimentsPath, {
      schemaVersion: 1,
      experiments: [...this._vpnExperiments.values()],
    });
  }

  _median(values) {
    const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
    if (!sorted.length) return null;
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  _prewarmDuration(telemetry) {
    const candidates = [
      telemetry?.prewarm?.durationMs,
      telemetry?.prewarm?.totalMs,
      telemetry?.networkPrewarm?.durationMs,
      telemetry?.prewarmMs,
    ];
    return candidates.map(Number).find((value) => Number.isFinite(value) && value >= 0) ?? null;
  }

  async _vpnExperimentDetail(experiment) {
    const nodeData = new Map();
    for (const trial of experiment.trials) {
      const bucket = nodeData.get(trial.nodeLabel) ?? {
        nodeLabel: trial.nodeLabel,
        total: 0,
        completed: 0,
        clickToFirst: [],
        totalTimes: [],
        prewarm: [],
      };
      bucket.total += 1;
      const run = this._runs.get(trial.runId);
      if (run?.status === 'completed') bucket.completed += 1;
      if (run) {
        const entries = await this._readJsonLines(this._artifactPath(run, run.transcriptPath));
        for (const entry of entries) {
          if (Number.isFinite(entry.timing?.clickToFirstResponseMs)) {
            bucket.clickToFirst.push(entry.timing.clickToFirstResponseMs);
          }
          if (Number.isFinite(entry.timing?.totalMs)) bucket.totalTimes.push(entry.timing.totalMs);
          const prewarmMs = this._prewarmDuration(entry.telemetry);
          if (prewarmMs !== null) bucket.prewarm.push(prewarmMs);
        }
      }
      nodeData.set(trial.nodeLabel, bucket);
    }
    const aggregates = [...nodeData.values()].map((bucket) => ({
      nodeLabel: bucket.nodeLabel,
      total: bucket.total,
      completed: bucket.completed,
      successRate: bucket.total ? bucket.completed / bucket.total : 0,
      medianClickToFirstResponseMs: this._median(bucket.clickToFirst),
      medianTotalMs: this._median(bucket.totalTimes),
      medianPrewarmMs: this._median(bucket.prewarm),
    }));
    return { ...clone(experiment), aggregates };
  }

  _validateRunInput(input) {
    if (!isPlainObject(input)) {
      throw problem(400, 'invalid_input', 'Run input must be an object');
    }

    const title = typeof input.title === 'string' ? input.title.trim() : '';
    if (!title) throw problem(400, 'invalid_title', 'title is required');
    if (title.length > this.options.maxTitleLength) {
      throw problem(400, 'invalid_title', `title must be at most ${this.options.maxTitleLength} characters`);
    }

    const runKind = input.runKind ?? 'prompt';
    if (!['prompt', 'redo', 'workflow'].includes(runKind)) {
      throw problem(400, 'invalid_run_kind', 'runKind must be prompt, redo, or workflow');
    }

    const requiredModel = input.requiredModel ?? '';
    if (typeof requiredModel !== 'string' || requiredModel.length > 200) {
      throw problem(400, 'invalid_required_model', 'requiredModel must be a string of at most 200 characters');
    }

    const minDelayMs = input.minDelayMs ?? 5_000;
    if (
      !Number.isFinite(minDelayMs)
      || minDelayMs < 5_000
      || minDelayMs > this.options.maxDelayMs
    ) {
      throw problem(
        400,
        'invalid_delay',
        `minDelayMs must be between 5000 and ${this.options.maxDelayMs}`,
      );
    }

    const maxRetries = input.maxRetries ?? 1;
    if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 3) {
      throw problem(400, 'invalid_retries', 'maxRetries must be an integer from 0 to 3');
    }

    const redoOption = normalizeRedoOption(input.redoOption);
    if (['redo', 'workflow'].includes(runKind) && !redoOption) {
      throw problem(400, 'invalid_redo_option', 'redoOption must be try_again, longer, or shorter');
    }

    if (runKind === 'workflow') {
      const conversationUrl = normalizeGeminiConversationUrl(input.conversationUrl, {
        requireConversationId: true,
      });
      if (!conversationUrl) {
        throw problem(
          400,
          'invalid_conversation_url',
          'workflow runs require an exact Gemini /app/<conversation-id> or /gem/<gem-id>/<conversation-id> URL',
        );
      }
      const actionBranch = input.actionBranch;
      if (!WORKFLOW_ACTIONS.has(actionBranch)) {
        throw problem(
          400,
          'invalid_action_branch',
          'actionBranch must be redo_only, send_then_redo, or edit_then_redo',
        );
      }
      const redoCount = input.redoCount;
      const minimumRedoCount = actionBranch === 'redo_only' ? 1 : 0;
      if (
        !Number.isInteger(redoCount)
        || redoCount < minimumRedoCount
        || redoCount > this.options.maxRedoRepeats
      ) {
        throw problem(
          400,
          'invalid_redo_count',
          `redoCount must be an integer from ${minimumRedoCount} to ${this.options.maxRedoRepeats}`,
        );
      }
      let prompt = '';
      let sourceTurn = null;
      if (actionBranch !== 'redo_only') {
        if (typeof input.prompt !== 'string' || !input.prompt.trim()) {
          throw problem(400, 'invalid_prompt', 'prompt is required for send/edit workflows');
        }
        if (input.prompt.length > this.options.maxPromptLength) {
          throw problem(
            400,
            'invalid_prompt',
            `prompt must be at most ${this.options.maxPromptLength} characters`,
          );
        }
        prompt = input.prompt;
      } else {
        if (typeof input.prompt !== 'string' || !input.prompt.trim()) {
          throw problem(400, 'invalid_prompt', 'redo_only requires the source prompt read from the conversation snapshot');
        }
        if (input.prompt.length > this.options.maxPromptLength) {
          throw problem(
            400,
            'invalid_prompt',
            `prompt must be at most ${this.options.maxPromptLength} characters`,
          );
        }
        prompt = input.prompt;
        sourceTurn = normalizeTargetTurn(input.sourceTurn);
        if (!sourceTurn) {
          throw problem(
            400,
            'invalid_source_turn',
            'redo_only requires sourceTurn from the conversation snapshot',
          );
        }
        const canonicalPrompt = canonicalizeNativePasteText(prompt);
        if (
          sha256Text(canonicalPrompt) !== sourceTurn.sourceTextSha256
          || canonicalPrompt.length !== sourceTurn.sourceTextLength
        ) {
          throw problem(
            409,
            'source_turn_mismatch',
            'prompt does not match the selected sourceTurn snapshot hash and length',
          );
        }
      }
      const targetTurn = input.targetTurn == null ? null : normalizeTargetTurn(input.targetTurn);
      if (actionBranch === 'edit_then_redo' && !targetTurn) {
        throw problem(
          400,
          'invalid_target_turn',
          'edit_then_redo requires targetTurn with turnKey, ordinal, sourceTextSha256, and sourceTextLength',
        );
      }
      if (actionBranch !== 'edit_then_redo' && input.targetTurn != null) {
        throw problem(400, 'invalid_target_turn', 'targetTurn is only accepted for edit_then_redo');
      }
      if (!requiredModel.trim()) {
        throw problem(400, 'invalid_required_model', 'requiredModel is required for workflow runs');
      }
      return {
        title,
        runKind,
        mode: 'same_thread',
        prompts: [prompt],
        prompt,
        sourcePrompt: prompt,
        sourceTurn,
        variants: 1,
        conversationUrl,
        repeatCount: redoCount,
        actionBranch,
        redoCount,
        redoOption,
        targetTurn,
        requiredModel: requiredModel.trim(),
        minDelayMs,
        maxRetries,
      };
    }

    if (runKind === 'redo') {
      const conversationUrl = normalizeGeminiConversationUrl(input.conversationUrl, {
        requireConversationId: true,
      });
      if (!conversationUrl) {
        throw problem(
          400,
          'invalid_conversation_url',
          'redo runs require an exact Gemini /app/<conversation-id> or /gem/<gem-id>/<conversation-id> URL',
        );
      }
      const repeatCount = input.repeatCount;
      if (
        !Number.isInteger(repeatCount)
        || repeatCount < 1
        || repeatCount > this.options.maxRedoRepeats
      ) {
        throw problem(
          400,
          'invalid_repeat_count',
          `repeatCount must be an integer from 1 to ${this.options.maxRedoRepeats}`,
        );
      }
      if (!requiredModel.trim()) {
        throw problem(400, 'invalid_required_model', 'requiredModel is required for redo runs');
      }

      return {
        title,
        runKind,
        mode: 'same_thread',
        prompts: [],
        variants: 1,
        conversationUrl,
        repeatCount,
        redoOption,
        requiredModel: requiredModel.trim(),
        minDelayMs,
        maxRetries,
      };
    }

    if (!['same_thread', 'new_thread_each'].includes(input.mode)) {
      throw problem(400, 'invalid_mode', 'mode must be same_thread or new_thread_each');
    }

    if (!Array.isArray(input.prompts) || input.prompts.length < 1) {
      throw problem(400, 'invalid_prompts', 'prompts must contain at least one string');
    }
    if (input.prompts.length > this.options.maxPrompts) {
      throw problem(400, 'invalid_prompts', `prompts may contain at most ${this.options.maxPrompts} items`);
    }
    const prompts = input.prompts.map((prompt, index) => {
      if (typeof prompt !== 'string' || !prompt.trim()) {
        throw problem(400, 'invalid_prompt', `prompts[${index}] must be a non-empty string`);
      }
      if (prompt.length > this.options.maxPromptLength) {
        throw problem(
          400,
          'invalid_prompt',
          `prompts[${index}] must be at most ${this.options.maxPromptLength} characters`,
        );
      }
      return prompt;
    });

    const variants = input.variants ?? 1;
    if (!Number.isInteger(variants) || variants < 1 || variants > 20) {
      throw problem(400, 'invalid_variants', 'variants must be an integer from 1 to 20');
    }

    const conversationUrl = input.conversationUrl == null || input.conversationUrl === ''
      ? null
      : normalizeGeminiConversationUrl(input.conversationUrl, { requireConversationId: true });
    if (input.conversationUrl != null && input.conversationUrl !== '' && !conversationUrl) {
      throw problem(
        400,
        'invalid_conversation_url',
        'conversationUrl must be an exact Gemini /app/<conversation-id> or /gem/<gem-id>/<conversation-id> URL',
      );
    }
    if (conversationUrl && input.mode !== 'same_thread') {
      throw problem(
        400,
        'invalid_conversation_url',
        'An existing Gemini conversation can only be used with same_thread mode',
      );
    }

    return {
      title,
      runKind,
      mode: input.mode,
      prompts,
      variants,
      conversationUrl,
      repeatCount: null,
      requiredModel: requiredModel.trim(),
      minDelayMs,
      maxRetries,
    };
  }

  _validateWorkerId(workerId) {
    if (typeof workerId !== 'string' || !workerId.trim() || workerId.length > 200) {
      throw problem(400, 'invalid_worker', 'workerId must be a non-empty string of at most 200 characters');
    }
  }

  _validateLeaseId(leaseId) {
    if (typeof leaseId !== 'string' || leaseId.length < 8 || leaseId.length > 200) {
      throw problem(400, 'invalid_lease_id', 'leaseId must be a string from 8 to 200 characters');
    }
  }

  _validateTaskEvent(event) {
    if (!isPlainObject(event)) {
      throw problem(400, 'invalid_event', 'event must be an object');
    }
    if (typeof event.eventId !== 'string' || !event.eventId.trim() || event.eventId.length > 300) {
      throw problem(400, 'invalid_event_id', 'eventId must be a stable non-empty string of at most 300 characters');
    }
    if (!EVENT_TYPES.has(event.type)) {
      throw problem(400, 'invalid_event_type', 'type must be dispatching, submitted, completed, failed, or blocked');
    }
    this._validateLeaseId(event.leaseId);
    if (event.type === 'completed' && typeof event.response !== 'string') {
      throw problem(400, 'invalid_response', 'completed events require a string response');
    }
    if (event.response !== undefined && typeof event.response !== 'string') {
      throw problem(400, 'invalid_response', 'response must be a string');
    }
    if (event.responsePartial !== undefined && typeof event.responsePartial !== 'string') {
      throw problem(400, 'invalid_response_partial', 'responsePartial must be a string');
    }
    if (
      event.responsePartial !== undefined
      && !['failed', 'blocked'].includes(event.type)
    ) {
      throw problem(
        400,
        'invalid_response_partial',
        'responsePartial is only accepted for failed or blocked events',
      );
    }
    if (
      typeof event.responsePartial === 'string'
      && Buffer.byteLength(event.responsePartial, 'utf8') > this.options.maxResponseHtmlBytes
    ) {
      throw problem(
        400,
        'response_partial_too_large',
        `responsePartial must be at most ${this.options.maxResponseHtmlBytes} bytes`,
      );
    }
    if (event.responseHtml !== undefined && typeof event.responseHtml !== 'string') {
      throw problem(400, 'invalid_response_html', 'responseHtml must be a string');
    }
    if (
      event.responseHtml !== undefined
      && !['completed', 'failed', 'blocked'].includes(event.type)
    ) {
      throw problem(
        400,
        'invalid_response_html',
        'responseHtml is only accepted for completed, failed, or blocked events',
      );
    }
    if (
      typeof event.responseHtml === 'string'
      && Buffer.byteLength(event.responseHtml, 'utf8') > this.options.maxResponseHtmlBytes
    ) {
      throw problem(
        400,
        'response_html_too_large',
        `responseHtml must be at most ${this.options.maxResponseHtmlBytes} bytes`,
      );
    }
    if (event.error !== undefined && typeof event.error !== 'string') {
      throw problem(400, 'invalid_error', 'error must be a string');
    }
    let telemetry;
    if (event.telemetry !== undefined) {
      if (!isPlainObject(event.telemetry)) {
        throw problem(400, 'invalid_telemetry', 'telemetry must be an object');
      }
      const serializedTelemetry = JSON.stringify(event.telemetry);
      if (Buffer.byteLength(serializedTelemetry, 'utf8') > 256 * 1024) {
        throw problem(400, 'invalid_telemetry', 'telemetry must be at most 256 KiB');
      }
      telemetry = clone(event.telemetry);
    }
    const conversationUrl = event.conversationUrl === undefined
      ? undefined
      : normalizeGeminiConversationUrl(event.conversationUrl);
    if (event.conversationUrl !== undefined && !conversationUrl) {
      throw problem(
        400,
        'invalid_conversation_url',
        'conversationUrl must be an exact Gemini conversation URL',
      );
    }
    if (event.model !== undefined && typeof event.model !== 'string') {
      throw problem(400, 'invalid_model', 'model must be a string');
    }
    const targetTurnEvidence = event.targetTurnEvidence === undefined
      ? undefined
      : normalizeTurnEvidence(event.targetTurnEvidence);
    if (event.targetTurnEvidence !== undefined && !targetTurnEvidence) {
      throw problem(400, 'invalid_target_turn_evidence', 'targetTurnEvidence is malformed or expected does not equal observed');
    }
    const sourceTurnEvidence = event.sourceTurnEvidence === undefined
      ? undefined
      : normalizeTurnEvidence(event.sourceTurnEvidence);
    if (event.sourceTurnEvidence !== undefined && !sourceTurnEvidence) {
      throw problem(400, 'invalid_source_turn_evidence', 'sourceTurnEvidence is malformed or expected does not equal observed');
    }
    const resultSourceTurn = event.resultSourceTurn === undefined
      ? undefined
      : normalizeTargetTurn(event.resultSourceTurn);
    if (event.resultSourceTurn !== undefined && !resultSourceTurn) {
      throw problem(400, 'invalid_result_source_turn', 'resultSourceTurn is malformed');
    }
    const visibleThinkingSummary = event.visibleThinkingSummary === undefined
      ? undefined
      : normalizeVisibleThinkingSummary(event.visibleThinkingSummary);
    if (event.visibleThinkingSummary !== undefined && event.visibleThinkingSummary !== null && !visibleThinkingSummary) {
      throw problem(400, 'invalid_visible_thinking_summary', 'visibleThinkingSummary must be a verified visible UI summary');
    }
    const timing = event.timing === undefined ? undefined : normalizeResponseTiming(event.timing);
    if (event.timing !== undefined && !timing) {
      throw problem(400, 'invalid_timing', 'timing must contain ordered client timestamps; first-response fields require verified-body-change evidence or must both be null with unobserved quality');
    }

    return {
      eventId: event.eventId.trim(),
      type: event.type,
      leaseId: event.leaseId,
      response: event.response,
      responsePartial: event.responsePartial,
      responseHtml: event.responseHtml,
      error: event.error?.slice(0, 20_000),
      retryable: event.retryable === true,
      conversationUrl,
      model: event.model?.slice(0, 200),
      clientAt: typeof event.clientAt === 'string' ? event.clientAt.slice(0, 100) : undefined,
      telemetry,
      targetTurnEvidence,
      sourceTurnEvidence,
      resultSourceTurn,
      visibleThinkingSummary,
      timing,
    };
  }

  _validateLoadedRun(run, directoryName) {
    if (!isPlainObject(run) || run.schemaVersion !== 1 || run.id !== directoryName) {
      throw problem(500, 'invalid_manifest', `Invalid automation manifest in ${directoryName}`);
    }
    if (!RUN_STATUSES.has(run.status) || !Array.isArray(run.tasks)) {
      throw problem(500, 'invalid_manifest', `Invalid run state in ${directoryName}`);
    }
    if (run.runKind === undefined) run.runKind = 'prompt';
    if (!['prompt', 'redo', 'workflow'].includes(run.runKind)) {
      throw problem(500, 'invalid_manifest', `Invalid run kind in ${directoryName}`);
    }
    if (run.conversationUrl === undefined) run.conversationUrl = null;
    if (run.repeatCount === undefined) run.repeatCount = null;
    if (run.redoOption === undefined) {
      run.redoOption = ['redo', 'workflow'].includes(run.runKind) ? 'try_again' : null;
    }
    if (run.plannedTaskTotal === undefined) run.plannedTaskTotal = run.tasks.length;
    if (
      !Number.isInteger(run.plannedTaskTotal)
      || run.plannedTaskTotal < run.tasks.length
      || run.plannedTaskTotal < 1
    ) {
      throw problem(500, 'invalid_manifest', `Invalid unit plan size in ${directoryName}`);
    }
    if (
      run.unitPlan !== undefined
      && (!Array.isArray(run.unitPlan) || run.unitPlan.length !== run.plannedTaskTotal)
    ) {
      throw problem(500, 'invalid_manifest', `Invalid unit plan in ${directoryName}`);
    }
    if (run.runKind === 'redo') {
      run.redoOption = normalizeRedoOption(run.redoOption);
      run.conversationUrl = normalizeGeminiConversationUrl(run.conversationUrl, {
        requireConversationId: true,
      });
      if (
        !run.conversationUrl
        || !Number.isInteger(run.repeatCount)
        || run.repeatCount < 1
        || run.repeatCount > this.options.maxRedoRepeats
        || run.plannedTaskTotal !== run.repeatCount
        || !run.redoOption
      ) {
        throw problem(500, 'invalid_manifest', `Invalid redo run in ${directoryName}`);
      }
    } else if (run.runKind === 'workflow') {
      run.redoOption = normalizeRedoOption(run.redoOption);
      run.conversationUrl = normalizeGeminiConversationUrl(run.conversationUrl, {
        requireConversationId: true,
      });
      if (
        !run.conversationUrl
        || !WORKFLOW_ACTIONS.has(run.actionBranch)
        || !Number.isInteger(run.redoCount)
        || run.redoCount < (run.actionBranch === 'redo_only' ? 1 : 0)
        || run.redoCount > this.options.maxRedoRepeats
        || run.mode !== 'same_thread'
        || run.plannedTaskTotal !== run.redoCount + (run.actionBranch === 'redo_only' ? 0 : 1)
        || !run.redoOption
      ) {
        throw problem(500, 'invalid_manifest', `Invalid workflow run in ${directoryName}`);
      }
      if (run.actionBranch === 'edit_then_redo') {
        run.targetTurn = normalizeTargetTurn(run.targetTurn);
        if (!run.targetTurn) {
          throw problem(500, 'invalid_manifest', `Invalid workflow target in ${directoryName}`);
        }
      }
      if (run.sourceTurn != null) {
        run.sourceTurn = normalizeTargetTurn(run.sourceTurn);
        if (!run.sourceTurn) {
          throw problem(500, 'invalid_manifest', `Invalid workflow source in ${directoryName}`);
        }
      }
      if (typeof run.sourcePrompt !== 'string' || !run.sourcePrompt.trim()) {
        throw problem(500, 'invalid_manifest', `Invalid workflow source prompt in ${directoryName}`);
      }
      if (run.actionBranch === 'redo_only') {
        const canonicalSource = canonicalizeNativePasteText(run.sourcePrompt);
        if (
          !run.sourceTurn
          || run.sourceTurn.sourceTextSha256 !== sha256Text(canonicalSource)
          || run.sourceTurn.sourceTextLength !== canonicalSource.length
        ) {
          throw problem(500, 'invalid_manifest', `Invalid workflow source binding in ${directoryName}`);
        }
      }
    } else if (run.conversationUrl !== null) {
      run.conversationUrl = normalizeGeminiConversationUrl(run.conversationUrl, {
        requireConversationId: true,
      });
      if (!run.conversationUrl || run.mode !== 'same_thread') {
        throw problem(500, 'invalid_manifest', `Invalid prompt run conversation in ${directoryName}`);
      }
    }
    if (Array.isArray(run.unitPlan)) {
      for (const unit of run.unitPlan) {
        if (!isPlainObject(unit)) {
          throw problem(500, 'invalid_manifest', `Invalid unit plan entry in ${directoryName}`);
        }
        if (unit.conversationAction === 'redo') {
          unit.redoOption = normalizeRedoOption(unit.redoOption ?? run.redoOption);
          if (!unit.redoOption || unit.redoOption !== run.redoOption) {
            throw problem(500, 'invalid_manifest', `Invalid unit redo option in ${directoryName}`);
          }
        } else if (unit.redoOption === undefined) {
          unit.redoOption = null;
        }
      }
    }
    if (
      !Number.isFinite(run.minDelayMs)
      || run.minDelayMs < 5_000
      || run.minDelayMs > this.options.maxDelayMs
    ) {
      throw problem(500, 'invalid_manifest', `Invalid minDelayMs in ${directoryName}`);
    }
    const requiredRunTimes = ['createdAt', 'updatedAt', 'nextAvailableAt'];
    const optionalRunTimes = [
      'queuedAt',
      'startedAt',
      'pausedAt',
      'completedAt',
      'canceledAt',
      'needsAttentionAt',
    ];
    if (requiredRunTimes.some((field) => !isValidTime(run[field], ABSOLUTE_MAX_DELAY_MS))) {
      throw problem(500, 'invalid_manifest', `Invalid run timestamp in ${directoryName}`);
    }
    if (
      optionalRunTimes.some(
        (field) => run[field] != null && !isValidTime(run[field], ABSOLUTE_MAX_DELAY_MS),
      )
    ) {
      throw problem(500, 'invalid_manifest', `Invalid optional run timestamp in ${directoryName}`);
    }
    for (const task of run.tasks) {
      if (!isPlainObject(task) || typeof task.id !== 'string' || !TASK_STATUSES.has(task.status)) {
        throw problem(500, 'invalid_manifest', `Invalid task state in ${directoryName}`);
      }
      if (!Array.isArray(task.events)) task.events = [];
      if (task.repeatIndex === undefined) task.repeatIndex = task.redoIndex ?? null;
      if (task.redoIndex === undefined) task.redoIndex = task.repeatIndex;
      if (task.workflowStep === undefined) task.workflowStep = null;
      if (task.resultRole === undefined) task.resultRole = null;
      if (task.resultOrdinal === undefined) task.resultOrdinal = null;
      if (task.targetTurn === undefined) task.targetTurn = null;
      if (task.conversationAction === 'redo') task.redoSource = 'current_last_response';
      else if (task.redoSource === undefined) task.redoSource = 'bound_user_turn';
      if (!REDO_SOURCES.has(task.redoSource)) {
        throw problem(500, 'invalid_manifest', `Invalid redo source in ${directoryName}`);
      }
      if (task.conversationAction === 'redo') {
        task.redoOption = normalizeRedoOption(task.redoOption ?? run.redoOption);
        if (!task.redoOption || task.redoOption !== run.redoOption) {
          throw problem(500, 'invalid_manifest', `Invalid redo option in ${directoryName}`);
        }
      } else if (task.redoOption === undefined) {
        task.redoOption = null;
      }
      if (task.resultSourceTurn === undefined) task.resultSourceTurn = null;
      if (task.documentInstanceId === undefined) task.documentInstanceId = null;
      if (
        task.documentInstanceId !== null
        && (typeof task.documentInstanceId !== 'string' || task.documentInstanceId.length > 500)
      ) {
        throw problem(500, 'invalid_manifest', `Invalid workflow document instance in ${directoryName}`);
      }
      if (run.runKind === 'redo') {
        if (
          task.conversationAction !== 'redo'
          || !Number.isInteger(task.repeatIndex)
          || task.repeatIndex < 1
          || task.repeatIndex > run.repeatCount
          || task.redoIndex !== task.repeatIndex
        ) {
          throw problem(500, 'invalid_manifest', `Invalid redo task in ${directoryName}`);
        }
        task.conversationUrl = run.conversationUrl;
      }
      if (run.runKind === 'workflow') {
        if (
          !['continue', 'edit', 'redo'].includes(task.conversationAction)
          || !['initial', 'redo'].includes(task.workflowStep)
          || !['initial', 'redo'].includes(task.resultRole)
          || !Number.isInteger(task.resultOrdinal)
          || task.resultOrdinal < 0
          || task.resultOrdinal > run.redoCount
        ) {
          throw problem(500, 'invalid_manifest', `Invalid workflow task in ${directoryName}`);
        }
        task.conversationUrl = run.conversationUrl;
        if (task.conversationAction === 'edit') {
          task.targetTurn = normalizeTargetTurn(task.targetTurn);
          if (!task.targetTurn || JSON.stringify(task.targetTurn) !== JSON.stringify(run.targetTurn)) {
            throw problem(500, 'invalid_manifest', `Invalid workflow edit target in ${directoryName}`);
          }
        }
        if (task.resultSourceTurn != null) {
          task.resultSourceTurn = normalizeTargetTurn(task.resultSourceTurn);
          if (!task.resultSourceTurn) {
            throw problem(500, 'invalid_manifest', `Invalid workflow result source in ${directoryName}`);
          }
        }
      }
      if (task.lastLeaseId === undefined) task.lastLeaseId = null;
      if (
        task.lastLeaseId !== null
        && (typeof task.lastLeaseId !== 'string'
          || task.lastLeaseId.length < 8
          || task.lastLeaseId.length > 200)
      ) {
        task.lastLeaseId = null;
      }
      if (typeof task.acceptLateTerminal !== 'boolean') task.acceptLateTerminal = false;
      if (task.conversationUrl != null) {
        task.conversationUrl = normalizeGeminiConversationUrl(task.conversationUrl);
      }
      if (task.recovery === undefined) task.recovery = null;
      this._validateLoadedRecovery(run, task, directoryName);
      for (const field of [
        'availableAt',
        'dispatchingAt',
        'submittedAt',
        'completedAt',
        'failedAt',
        'uncertainAt',
      ]) {
        if (task[field] != null && !isValidTime(task[field], ABSOLUTE_MAX_DELAY_MS)) {
          throw problem(500, 'invalid_manifest', `Invalid task timestamp in ${directoryName}`);
        }
      }
      if (ACTIVE_TASK_STATUSES.has(task.status) !== (task.lease !== null)) {
        throw problem(500, 'invalid_manifest', `Active task lease invariant failed in ${directoryName}`);
      }
      if (task.lease !== null) {
        if (
          !isPlainObject(task.lease)
          || typeof task.lease.leaseId !== 'string'
          || task.lease.leaseId.length < 8
          || task.lease.leaseId.length > 200
          || !isValidTime(task.lease.claimedAt, ABSOLUTE_MAX_DELAY_MS)
          || !isValidTime(task.lease.heartbeatAt, ABSOLUTE_MAX_DELAY_MS)
          || !isValidTime(task.lease.expiresAt, ABSOLUTE_MAX_DELAY_MS)
        ) {
          throw problem(500, 'invalid_manifest', `Invalid task lease in ${directoryName}`);
        }
        if (task.lastLeaseId !== task.lease.leaseId) {
          throw problem(500, 'invalid_manifest', `Active lease mismatch in ${directoryName}`);
        }
      }
    }
    run.stats = this._computeRunStats(run);
  }

  _validateLoadedRecovery(run, task, directoryName) {
    if (task.recovery === null) return;
    const recovery = task.recovery;
    if (!isPlainObject(recovery)) {
      throw problem(500, 'invalid_manifest', `Invalid recovery metadata in ${directoryName}`);
    }
    const taskDir = path.posix.dirname(task.responsePath);
    const expectedMarkdown = toPosixPath(taskDir, 'recovery.md');
    const expectedHtml = toPosixPath(taskDir, 'recovery.html');
    const expectedJson = toPosixPath(taskDir, 'recovery.json');
    const valid =
      typeof recovery.eventId === 'string'
      && recovery.eventId.length > 0
      && recovery.eventId.length <= 300
      && typeof recovery.leaseId === 'string'
      && recovery.leaseId.length >= 8
      && recovery.leaseId.length <= 200
      && recovery.recoveryPath === expectedMarkdown
      && (recovery.recoveryHtmlPath === null || recovery.recoveryHtmlPath === expectedHtml)
      && recovery.recoveryJsonPath === expectedJson
      && isValidTime(recovery.capturedAt, ABSOLUTE_MAX_DELAY_MS)
      && /^[a-f0-9]{64}$/.test(recovery.sha256)
      && recovery.unconfirmed === true
      && task.events.some(
        (event) =>
          event.eventId === recovery.eventId
          && event.leaseId === recovery.leaseId
          && event.recoveryPath === recovery.recoveryPath
          && event.recoverySha256 === recovery.sha256
          && ['failed', 'blocked'].includes(event.type),
      );
    if (!valid) {
      throw problem(500, 'invalid_manifest', `Invalid recovery fields in ${directoryName}`);
    }
    this._artifactPath(run, recovery.recoveryPath);
    if (recovery.recoveryHtmlPath) this._artifactPath(run, recovery.recoveryHtmlPath);
    this._artifactPath(run, recovery.recoveryJsonPath);
  }

  _requireRun(id) {
    const run = this._runs.get(id);
    if (!run) throw problem(404, 'run_not_found', `Automation run ${id} was not found`);
    return run;
  }

  _requireTask(taskId) {
    for (const run of this._runs.values()) {
      const task = run.tasks.find((candidate) => candidate.id === taskId);
      if (task) return { run, task };
    }
    throw problem(404, 'task_not_found', `Automation task ${taskId} was not found`);
  }

  _assertEventWorker(task, workerId, eventType, leaseId) {
    if (task.lease) {
      if (task.lease.workerId !== workerId) {
        throw problem(409, 'lease_owner_mismatch', `Task ${task.id} is leased by another worker`);
      }
      if (task.lease.leaseId !== leaseId) {
        throw problem(409, 'lease_id_mismatch', `Task ${task.id} belongs to another attempt`);
      }
      return;
    }

    const lateTerminalEvent = ['completed', 'failed', 'blocked'].includes(eventType);
    if (
      lateTerminalEvent
      && task.acceptLateTerminal
      && task.lastWorkerId === workerId
      && task.lastLeaseId === leaseId
    ) return;
    throw problem(409, 'task_not_leased', `Task ${task.id} has no lease for worker ${workerId}`);
  }

  _runDir(runOrId) {
    return path.join(this.runsDir, typeof runOrId === 'string' ? runOrId : runOrId.id);
  }

  _artifactPath(run, relativePath) {
    if (typeof relativePath !== 'string' || !relativePath) {
      throw problem(500, 'invalid_artifact_path', `Run ${run.id} contains an invalid artifact path`);
    }
    const base = path.resolve(this._runDir(run));
    const candidate = path.resolve(base, ...relativePath.split('/'));
    if (candidate !== base && !candidate.startsWith(`${base}${path.sep}`)) {
      throw problem(500, 'invalid_artifact_path', `Artifact path escapes run ${run.id}`);
    }
    return candidate;
  }

  _manifestPath(run) {
    return path.join(this._runDir(run), 'manifest.json');
  }

  async _persistRun(run) {
    run.stats = this._computeRunStats(run);
    try {
      await this._atomicWriteJson(this._manifestPath(run), run);
    } catch (error) {
      // Most callers mutate the in-memory run before replacing its manifest.
      // Restore the last durable snapshot so a failed start/claim/action cannot
      // continue executing from state that would disappear after a restart.
      if (this._runs.has(run.id)) {
        try {
          const durable = JSON.parse(await fs.readFile(this._manifestPath(run), 'utf8'));
          this._validateLoadedRun(durable, run.id);
          this._runs.set(run.id, durable);
        } catch {
          // Preserve the original I/O error; a later init will surface a
          // malformed or missing manifest with its precise recovery context.
        }
      }
      throw error;
    }
  }

  async _touchWorker(workerId, { pageUrl, modelLabel } = {}) {
    const nowMs = this._nowMs();
    const now = new Date(nowMs).toISOString();
    const previous = this._workers.get(workerId);
    const nextPageUrl =
      typeof pageUrl === 'string' ? pageUrl.slice(0, 4_096) : previous?.pageUrl ?? null;
    const nextModel =
      typeof modelLabel === 'string' ? modelLabel.slice(0, 200) : previous?.currentModel ?? null;
    const materiallyChanged =
      !previous
      || nextPageUrl !== previous.pageUrl
      || nextModel !== previous.currentModel;
    const worker = {
      id: workerId,
      lastSeenAt: now,
      pageUrl: nextPageUrl,
      currentModel: nextModel,
    };
    this._workers.set(workerId, worker);
    this._markActivity(now);
    const lastPersistedAt = this._workerPersistedAt.get(workerId) ?? 0;
    if (materiallyChanged || nowMs - lastPersistedAt >= this.options.workerPersistIntervalMs) {
      await this._atomicWriteJson(this.workersPath, {
        schemaVersion: 1,
        workers: [...this._workers.values()],
      });
      this._workerPersistedAt.set(workerId, nowMs);
    }
  }

  async _setGlobalNextAvailableAt(value) {
    if (parseTime(value) <= parseTime(this._queueState.globalNextAvailableAt)) return;
    const nextState = {
      schemaVersion: 1,
      globalNextAvailableAt: value,
      updatedAt: this._nowIso(),
    };
    await this._atomicWriteJson(this.queueStatePath, nextState);
    this._queueState = nextState;
  }

  async _restoreThrottleFromRuns() {
    let latest = this._queueState.globalNextAvailableAt;
    for (const run of this._runs.values()) {
      for (const task of run.tasks) {
        const terminalAt = task.completedAt ?? task.failedAt;
        if (!terminalAt) continue;
        const candidate = new Date(parseTime(terminalAt) + taskCooldownMs(run, task)).toISOString();
        if (parseTime(candidate) > parseTime(latest)) latest = candidate;
      }
    }
    await this._setGlobalNextAvailableAt(latest);
  }

  _latestWorkerFields() {
    const worker = [...this._workers.values()]
      .sort((a, b) => parseTime(b.lastSeenAt) - parseTime(a.lastSeenAt))[0];
    return {
      id: worker?.id ?? null,
      lastSeenAt: worker?.lastSeenAt ?? null,
      pageUrl: worker?.pageUrl ?? null,
      currentModel: worker?.currentModel ?? null,
    };
  }

  async _atomicWriteJson(filePath, value) {
    await this._atomicWriteText(filePath, `${JSON.stringify(value, null, 2)}\n`);
  }

  async _atomicWriteText(filePath, value) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tempPath = path.join(
      path.dirname(filePath),
      `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
    );
    let handle;
    try {
      handle = await fs.open(tempPath, 'wx');
      await handle.writeFile(value, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.rename(tempPath, filePath);
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      await fs.unlink(tempPath).catch(() => undefined);
      throw error;
    }
  }

  async _readJsonLines(filePath) {
    let text;
    try {
      text = await fs.readFile(filePath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
    return text
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
  }

  async _writeJsonLines(filePath, entries) {
    const text = entries.length > 0 ? `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n` : '';
    await this._atomicWriteText(filePath, text);
  }

  async _appendTaskEventLog(run, task, eventSummary) {
    const filePath = this._artifactPath(run, task.eventsPath);
    const entries = await this._readJsonLines(filePath);
    if (entries.some((entry) => entry.eventId === eventSummary.eventId)) return;
    entries.push(eventSummary);
    await this._writeJsonLines(filePath, entries);
  }

  _recoveryPaths(task, includeHtml) {
    const taskDir = path.posix.dirname(task.responsePath);
    return {
      recoveryPath: toPosixPath(taskDir, 'recovery.md'),
      recoveryHtmlPath: includeHtml ? toPosixPath(taskDir, 'recovery.html') : null,
      recoveryJsonPath: toPosixPath(taskDir, 'recovery.json'),
    };
  }

  async _writeRecoveryArtifacts(run, task, event, capturedAt, reason, workerId) {
    const paths = this._recoveryPaths(task, event.responseHtml !== undefined);
    const sha256 = createHash('sha256').update(event.responsePartial, 'utf8').digest('hex');
    const recovery = {
      eventId: event.eventId,
      leaseId: event.leaseId,
      ...paths,
      capturedAt,
      sha256,
      unconfirmed: true,
    };
    const metadata = {
      schemaVersion: 1,
      runId: run.id,
      taskId: task.id,
      eventType: event.type,
      eventId: event.eventId,
      leaseId: event.leaseId,
      workerId,
      capturedAt,
      reason,
      conversationUrl: event.conversationUrl ?? task.conversationUrl ?? null,
      model: event.model ?? task.model ?? null,
      ...paths,
      sha256,
      unconfirmed: true,
    };

    await this._atomicWriteText(this._artifactPath(run, paths.recoveryPath), event.responsePartial);
    if (paths.recoveryHtmlPath) {
      await this._atomicWriteText(
        this._artifactPath(run, paths.recoveryHtmlPath),
        event.responseHtml,
      );
    }
    // Metadata is the commit marker used to recover a crash between artifact
    // creation and the manifest replacement, so it is written last.
    await this._atomicWriteJson(this._artifactPath(run, paths.recoveryJsonPath), metadata);
    return recovery;
  }

  async _writeCompletionArtifacts(run, task, event, eventSummary, completedAt) {
    const prompt = await fs.readFile(this._artifactPath(run, task.promptPath), 'utf8');
    const turn = {
      schemaVersion: 1,
      completionEventId: event.eventId,
      runId: run.id,
      runKind: run.runKind ?? 'prompt',
      taskId: task.id,
      sequence: task.sequence,
      variant: task.variant,
      promptIndex: task.promptIndex,
      repeatIndex: task.repeatIndex ?? null,
      redoIndex: task.redoIndex ?? task.repeatIndex ?? null,
      repeatCount: run.repeatCount ?? null,
      actionBranch: run.actionBranch ?? null,
      redoCount: run.redoCount ?? null,
      redoOption: task.redoOption ?? run.redoOption ?? null,
      conversationAction: task.conversationAction,
      workflowStep: task.workflowStep ?? null,
      resultRole: task.resultRole ?? null,
      resultOrdinal: task.resultOrdinal ?? null,
      targetTurn: task.targetTurn ?? null,
      sourceTurn: task.conversationAction === 'redo' ? run.sourceTurn ?? null : null,
      resultSourceTurn: event.resultSourceTurn ?? null,
      attempt: task.attempt,
      leaseId: event.leaseId,
      prompt,
      response: event.response,
      responseHtmlPath: null,
      conversationUrl: event.conversationUrl ?? task.conversationUrl,
      model: event.model ?? task.model,
      dispatchingAt: task.dispatchingAt,
      submittedAt: task.submittedAt,
      completedAt,
      telemetry: event.telemetry ?? null,
      visibleThinkingSummary: event.visibleThinkingSummary ?? null,
      timing: event.timing ?? null,
    };

    await this._atomicWriteText(this._artifactPath(run, task.responsePath), event.response);
    if (event.responseHtml !== undefined) {
      task.responseHtmlPath = toPosixPath(path.posix.dirname(task.responsePath), 'response.html');
      turn.responseHtmlPath = task.responseHtmlPath;
      await this._atomicWriteText(this._artifactPath(run, task.responseHtmlPath), event.responseHtml);
    }
    await this._atomicWriteJson(this._artifactPath(run, task.turnPath), turn);
    await this._upsertTranscript(run, turn, eventSummary);
  }

  async _upsertTranscript(run, turn, eventSummary = {}) {
    const transcriptPath = this._artifactPath(run, run.transcriptPath);
    const entries = await this._readJsonLines(transcriptPath);
    const entry = {
      eventId: turn.completionEventId,
      runId: run.id,
      runKind: turn.runKind ?? run.runKind ?? 'prompt',
      taskId: turn.taskId,
      sequence: turn.sequence,
      variant: turn.variant,
      promptIndex: turn.promptIndex,
      repeatIndex: turn.repeatIndex ?? null,
      redoIndex: turn.redoIndex ?? turn.repeatIndex ?? null,
      repeatCount: turn.repeatCount ?? null,
      redoOption: turn.redoOption ?? null,
      conversationAction: turn.conversationAction,
      workflowStep: turn.workflowStep ?? null,
      resultRole: turn.resultRole ?? null,
      resultOrdinal: turn.resultOrdinal ?? null,
      prompt: turn.prompt,
      response: turn.response,
      conversationUrl: turn.conversationUrl ?? null,
      model: turn.model ?? null,
      completedAt: turn.completedAt,
      visibleThinkingSummary: turn.visibleThinkingSummary ?? null,
      timing: turn.timing ?? null,
      telemetry: turn.telemetry ?? null,
      responseSha256:
        eventSummary.responseSha256
        ?? createHash('sha256').update(turn.response, 'utf8').digest('hex'),
    };
    const withoutExisting = entries.filter(
      (candidate) => candidate.eventId !== entry.eventId && candidate.taskId !== entry.taskId,
    );
    withoutExisting.push(entry);
    withoutExisting.sort((a, b) => a.sequence - b.sequence);
    await this._writeJsonLines(transcriptPath, withoutExisting);
  }

  async _reconcileCompletionArtifacts(run) {
    let changed = false;
    for (const task of run.tasks) {
      if (task.status === 'completed') continue;
      let turn;
      try {
        turn = JSON.parse(await fs.readFile(this._artifactPath(run, task.turnPath), 'utf8'));
      } catch (error) {
        if (error?.code === 'ENOENT') continue;
        throw error;
      }
      if (
        turn?.schemaVersion !== 1
        || turn.taskId !== task.id
        || typeof turn.completionEventId !== 'string'
        || typeof turn.leaseId !== 'string'
        || turn.leaseId !== task.lastLeaseId
        || typeof turn.response !== 'string'
      ) {
        continue;
      }

      task.status = 'completed';
      task.completedAt = isValidTime(turn.completedAt, run.minDelayMs)
        ? turn.completedAt
        : this._nowIso();
      task.deliveryConfirmed = true;
      task.acceptLateTerminal = false;
      task.lease = null;
      task.error = null;
      task.blocked = false;
      task.conversationUrl = normalizeGeminiConversationUrl(turn.conversationUrl)
        ?? task.conversationUrl;
      task.model = turn.model ?? task.model;
      task.responseSha256 = createHash('sha256').update(turn.response, 'utf8').digest('hex');
      task.responseHtmlPath = turn.responseHtmlPath ?? task.responseHtmlPath ?? null;
      if (turn.resultSourceTurn != null) {
        const recoveredSourceTurn = normalizeTargetTurn(turn.resultSourceTurn);
        if (recoveredSourceTurn) {
          task.resultSourceTurn = recoveredSourceTurn;
          if (run.runKind === 'workflow' && task.workflowStep === 'initial') {
            run.sourceTurn = recoveredSourceTurn;
          }
        }
      }
      if (!task.events.some((event) => event.eventId === turn.completionEventId)) {
        task.events.push({
          eventId: turn.completionEventId,
          type: 'completed',
          at: task.completedAt,
          workerId: task.lastWorkerId,
          leaseId: turn.leaseId ?? task.lastLeaseId,
          responseSha256: task.responseSha256,
          recovered: true,
        });
      }
      await this._upsertTranscript(run, turn);
      const notBefore = new Date(parseTime(task.completedAt) + taskCooldownMs(run, task)).toISOString();
      if (parseTime(notBefore) > parseTime(run.nextAvailableAt)) run.nextAvailableAt = notBefore;
      await this._setGlobalNextAvailableAt(notBefore);
      changed = true;
    }
    // Completion artifacts are written before the manifest and the next unit.
    // A crash between those writes must recover the successor as well as the
    // answer; otherwise a lazy run appears complete after only its first unit.
    if (run.status !== 'canceled'
      && run.tasks.every(task => task.status === 'completed')
      && run.tasks.length < run.plannedTaskTotal) {
      await this._appendNextUnitTask(run, this._nowIso());
      run.completedAt = null;
      changed = true;
    }
    return changed;
  }

  async _reconcileRecoveryArtifacts(run) {
    let changed = false;
    for (const task of run.tasks) {
      const expectedPaths = this._recoveryPaths(task, false);
      let metadata;
      try {
        metadata = JSON.parse(
          await fs.readFile(this._artifactPath(run, expectedPaths.recoveryJsonPath), 'utf8'),
        );
      } catch (error) {
        if (error?.code === 'ENOENT') continue;
        throw problem(
          500,
          'invalid_recovery',
          `Unable to read recovery metadata for ${task.id}: ${error.message}`,
        );
      }

      const validMetadata =
        metadata?.schemaVersion === 1
        && metadata.runId === run.id
        && metadata.taskId === task.id
        && ['failed', 'blocked'].includes(metadata.eventType)
        && typeof metadata.eventId === 'string'
        && metadata.eventId.length > 0
        && metadata.eventId.length <= 300
        && typeof metadata.leaseId === 'string'
        && metadata.leaseId.length >= 8
        && metadata.leaseId.length <= 200
        && typeof metadata.reason === 'string'
        && metadata.reason.length <= 20_000
        && (metadata.model === null
          || (typeof metadata.model === 'string' && metadata.model.length <= 200))
        && isValidTime(metadata.capturedAt, ABSOLUTE_MAX_DELAY_MS)
        && /^[a-f0-9]{64}$/.test(metadata.sha256)
        && metadata.unconfirmed === true;
      if (!validMetadata) {
        throw problem(500, 'invalid_recovery', `Invalid recovery metadata for ${task.id}`);
      }

      const paths = this._recoveryPaths(task, metadata.recoveryHtmlPath !== null);
      if (
        metadata.recoveryPath !== paths.recoveryPath
        || metadata.recoveryHtmlPath !== paths.recoveryHtmlPath
        || metadata.recoveryJsonPath !== paths.recoveryJsonPath
      ) {
        throw problem(500, 'invalid_recovery', `Invalid recovery paths for ${task.id}`);
      }
      const partial = await fs.readFile(this._artifactPath(run, paths.recoveryPath), 'utf8');
      const actualSha = createHash('sha256').update(partial, 'utf8').digest('hex');
      if (actualSha !== metadata.sha256) {
        throw problem(500, 'invalid_recovery', `Recovery checksum mismatch for ${task.id}`);
      }

      const recovery = {
        eventId: metadata.eventId,
        leaseId: metadata.leaseId,
        ...paths,
        capturedAt: metadata.capturedAt,
        sha256: metadata.sha256,
        unconfirmed: true,
      };
      const hadThisRecovery = task.recovery?.eventId === metadata.eventId
        && task.recovery?.leaseId === metadata.leaseId;
      if (JSON.stringify(task.recovery) !== JSON.stringify(recovery)) {
        task.recovery = recovery;
        changed = true;
      }

      const recoveredEvent = {
        eventId: metadata.eventId,
        type: metadata.eventType,
        at: metadata.capturedAt,
        workerId: typeof metadata.workerId === 'string' ? metadata.workerId : task.lastWorkerId,
        leaseId: metadata.leaseId,
        error: metadata.reason,
        recoveryPath: paths.recoveryPath,
        recoverySha256: metadata.sha256,
        recovered: true,
      };
      if (!task.events.some((event) => event.eventId === metadata.eventId)) {
        task.events.push(recoveredEvent);
        changed = true;
      }

      const shouldReplayState =
        !hadThisRecovery
        && metadata.leaseId === task.lastLeaseId
        && ACTIVE_TASK_STATUSES.has(task.status);
      if (shouldReplayState) {
        task.lease = null;
        task.failedAt = metadata.capturedAt;
        task.acceptLateTerminal = true;
        task.conversationUrl = normalizeGeminiConversationUrl(metadata.conversationUrl)
          ?? task.conversationUrl;
        task.model = typeof metadata.model === 'string'
          ? metadata.model.slice(0, 200)
          : task.model;
        if (metadata.eventType === 'blocked') {
          task.status = 'failed';
          task.blocked = true;
          task.error = {
            code: 'worker_blocked',
            message: metadata.reason,
            at: metadata.capturedAt,
            retryable: false,
          };
        } else {
          task.status = 'uncertain';
          task.uncertainAt = metadata.capturedAt;
          task.error = {
            code: 'worker_failed_after_dispatch',
            message: metadata.reason,
            at: metadata.capturedAt,
            retryable: false,
          };
        }
        const notBefore = new Date(parseTime(metadata.capturedAt) + run.minDelayMs).toISOString();
        if (parseTime(notBefore) > parseTime(run.nextAvailableAt)) {
          run.nextAvailableAt = notBefore;
        }
        changed = true;
      }
    }
    if (changed) run.updatedAt = this._nowIso();
    return changed;
  }

  async _recoverExpiredLeases() {
    const nowMs = this._nowMs();
    const now = new Date(nowMs).toISOString();
    for (const run of this._runs.values()) {
      let changed = false;
      for (const task of run.tasks) {
        if (!ACTIVE_TASK_STATUSES.has(task.status) || !task.lease) continue;
        if (parseTime(task.lease.expiresAt) > nowMs) continue;

        const expiredLease = task.lease;
        task.lease = null;
        if (task.status === 'submitted' || task.submittedAt) {
          task.status = 'uncertain';
          task.acceptLateTerminal = true;
          task.uncertainAt = now;
          task.error = {
            code: 'lease_expired_after_submit',
            message: 'The worker disappeared after submission; inspect Gemini before retrying.',
            at: now,
            retryable: false,
          };
        } else {
          task.status = 'pending';
          task.acceptLateTerminal = false;
          task.availableAt = now;
          task.error = null;
        }
        task.events.push({
          eventId: `system:lease-expired:${expiredLease.leaseId}:${expiredLease.expiresAt}`,
          type: 'lease_expired',
          at: now,
          workerId: expiredLease.workerId,
          leaseId: expiredLease.leaseId,
          previousStatus: task.submittedAt ? 'submitted' : 'leased',
        });
        changed = true;
      }

      if (changed) {
        run.updatedAt = now;
        this._refreshRunStatus(run);
        await this._persistRun(run);
        this._markActivity(now);
      }
    }
  }

  _activeTask() {
    for (const run of this._runs.values()) {
      const task = run.tasks.find((candidate) => ACTIVE_TASK_STATUSES.has(candidate.status));
      if (task) return { run, task };
    }
    return null;
  }

  _hasGlobalSafetyBlock() {
    // Runs are independent atomic commands. A stale/failed command is a
    // record only; it must never prevent the next command from starting.
    return false;
  }

  _previousTaskInVariant(run, task) {
    return run.tasks
      .filter(
        (candidate) =>
          candidate.variant === task.variant
          && candidate.promptIndex < task.promptIndex
          && ['completed', 'submitted'].includes(candidate.status)
          && candidate.conversationUrl,
      )
      .sort((a, b) => b.promptIndex - a.promptIndex)[0] ?? null;
  }

  async _appendNextUnitTask(run, now) {
    const plannedTotal = Number(run.plannedTaskTotal ?? run.tasks.length);
    if (!Number.isInteger(plannedTotal) || run.tasks.length >= plannedTotal) return;
    if (!Array.isArray(run.unitPlan) || run.unitPlan.length !== plannedTotal) {
      throw problem(500, 'invalid_unit_plan', `Run ${run.id} cannot create its next unit`);
    }
    const sequence = run.tasks.length + 1;
    const taskInput = run.unitPlan[sequence - 1];
    if (!isPlainObject(taskInput)) {
      throw problem(500, 'invalid_unit_plan', `Run ${run.id} has an invalid unit ${sequence}`);
    }
    const {
      variant, promptIndex, repeatIndex, prompt, conversationAction, conversationUrl,
      targetTurn = null,
      redoSource = conversationAction === 'redo' ? 'current_last_response' : 'bound_user_turn',
      redoOption = conversationAction === 'redo'
        ? normalizeRedoOption(taskInput.redoOption ?? run.redoOption)
        : null,
      workflowStep = null,
      resultRole = null, resultOrdinal = null,
    } = taskInput;
    if (conversationAction === 'redo' && (!redoOption || redoOption !== run.redoOption)) {
      throw problem(500, 'invalid_unit_plan', `Run ${run.id} has an invalid Redo option for unit ${sequence}`);
    }
    const taskId = `${run.id}-v${String(variant).padStart(2, '0')}-p${String(promptIndex).padStart(3, '0')}`;
    const taskDirRelative = toPosixPath('tasks', taskId);
    const promptPath = toPosixPath(taskDirRelative, 'prompt.md');
    const taskDir = path.join(this._runDir(run), 'tasks', taskId);
    await fs.mkdir(taskDir, { recursive: true });
    await this._atomicWriteText(path.join(this._runDir(run), ...promptPath.split('/')), prompt);
    run.tasks.push({
      id: taskId, runId: run.id, sequence, variant, promptIndex, repeatIndex,
      redoIndex: repeatIndex, workflowStep, resultRole, resultOrdinal, targetTurn, redoSource, redoOption,
      documentInstanceId: null, conversationAction, status: 'pending', attempt: 0,
      availableAt: run.nextAvailableAt ?? now, lease: null, lastWorkerId: null,
      lastLeaseId: null, acceptLateTerminal: false, dispatchingAt: null,
      submittedAt: null, deliveryConfirmed: null, completedAt: null, failedAt: null,
      uncertainAt: null, conversationUrl, model: null, error: null, blocked: false,
      promptPath, responsePath: toPosixPath(taskDirRelative, 'response.md'),
      responseHtmlPath: null, turnPath: toPosixPath(taskDirRelative, 'turn.json'),
      eventsPath: toPosixPath(taskDirRelative, 'events.jsonl'), responseSha256: null,
      recovery: null, events: [],
    });
  }

  _refreshRunStatus(run) {
    run.stats = this._computeRunStats(run);
    if (run.status === 'canceled') return;

    if (run.tasks.every((task) => task.status === 'completed')) {
      run.status = 'completed';
      run.completedAt = run.completedAt ?? this._nowIso();
      run.needsAttentionAt = null;
      return;
    }

    if (run.tasks.some((task) => ['failed', 'uncertain'].includes(task.status))) {
      run.status = 'failed';
      run.needsAttentionAt = null;
      return;
    }

    if (run.status === 'paused') return;
    if (run.tasks.some((task) => ACTIVE_TASK_STATUSES.has(task.status))) {
      run.status = 'running';
      return;
    }
    if (run.tasks.some((task) => task.status === 'pending')) {
      run.status = run.queuedAt ? (run.startedAt ? 'running' : 'queued') : 'draft';
    }
  }

  _computeStats(tasks, plannedTotal = tasks.length) {
    const stats = {
      total: plannedTotal,
      pending: 0,
      leased: 0,
      submitted: 0,
      completed: 0,
      failed: 0,
      uncertain: 0,
      canceled: 0,
      finished: 0,
      percent: 0,
    };
    for (const task of tasks) stats[task.status] += 1;
    stats.finished = stats.completed + stats.canceled;
    stats.percent = stats.total === 0 ? 0 : Math.round((stats.completed / stats.total) * 100);
    return stats;
  }

  _computeRunStats(run) {
    const stats = this._computeStats(run.tasks, run.plannedTaskTotal);
    const completed = Number(run.completedUnitCount);
    if (!Number.isInteger(completed) || completed < 0) return stats;
    stats.completed = Math.min(stats.total, completed);
    stats.pending = Math.max(0, stats.total - stats.completed - stats.leased - stats.submitted);
    stats.finished = stats.completed + stats.canceled;
    stats.percent = stats.total === 0 ? 0 : Math.round((stats.completed / stats.total) * 100);
    return stats;
  }

  _runSummary(run) {
    return clone({
      id: run.id,
      title: run.title,
      runKind: run.runKind ?? 'prompt',
      mode: run.mode,
      variants: run.variants,
      conversationUrl: run.conversationUrl ?? null,
      repeatCount: run.repeatCount ?? null,
      actionBranch: run.actionBranch ?? null,
      redoCount: run.redoCount ?? null,
      redoOption: run.redoOption ?? null,
      requiredModel: run.requiredModel,
      minDelayMs: run.minDelayMs,
      maxRetries: run.maxRetries,
      status: run.status,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      queuedAt: run.queuedAt,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      nextAvailableAt: run.nextAvailableAt,
      stats: this._computeRunStats(run),
    });
  }
}

export default AutomationStore;
