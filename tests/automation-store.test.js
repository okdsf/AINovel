import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import AutomationStore from '../server/automation-store.js';

const BASE_TIME = Date.UTC(2026, 7, 17, 12, 0, 0);

async function createHarness(t, options = {}) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'novelweb-automation-store-'));
  t.after(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  let now = options.startTime ?? BASE_TIME;
  let idCounter = 0;
  const storeOptions = {
    leaseMs: options.leaseMs ?? 1_000,
    retryBaseMs: options.retryBaseMs ?? 1_000,
    clock: () => now,
    idFactory: () => `test${++idCounter}`,
  };
  const store = new AutomationStore(rootDir, storeOptions);
  await store.init();

  return {
    rootDir,
    store,
    storeOptions,
    now: () => now,
    advance(ms) {
      now += ms;
    },
    async restart() {
      const restarted = new AutomationStore(rootDir, storeOptions);
      await restarted.init();
      this.store = restarted;
      return restarted;
    },
  };
}

function runInput(overrides = {}) {
  return {
    title: 'Novel variants',
    mode: 'same_thread',
    prompts: ['Write an opening.', 'Continue with a reversal.'],
    variants: 1,
    requiredModel: 'Deep Think',
    minDelayMs: 5_000,
    maxRetries: 1,
    ...overrides,
  };
}

function redoInput(overrides = {}) {
  return {
    runKind: 'redo',
    title: 'Regenerate an existing answer',
    conversationUrl: 'https://gemini.google.com/app/0123456789abcdef',
    repeatCount: 3,
    redoOption: 'try_again',
    requiredModel: 'Pro Extended',
    minDelayMs: 5_000,
    maxRetries: 1,
    ...overrides,
  };
}

function canonicalTurn(text, overrides = {}) {
  const canonical = String(text).replace(/\r\n?/g, '\n').split('\n').reduce((lines, line) => {
    const blank = !line.trim();
    if (!blank || lines.at(-1) !== '') lines.push(blank ? '' : line);
    return lines;
  }, []).join('\n');
  return {
    turnKey: 'user:0:test',
    ordinal: 0,
    sourceTextSha256: createHash('sha256').update(canonical, 'utf8').digest('hex'),
    sourceTextLength: canonical.length,
    ...overrides,
  };
}

function workflowTiming(start = BASE_TIME) {
  return {
    clientSubmittedAt: new Date(start).toISOString(),
    firstResponseVisibleAt: new Date(start + 250).toISOString(),
    completedAt: new Date(start + 1_000).toISOString(),
    clickToFirstResponseMs: 250,
    firstResponseTimingQuality: 'verified-body-change',
  };
}

async function finishTask(store, claim, suffix = claim.sequence) {
  const conversationUrl = `https://gemini.google.com/app/thread-${claim.variant}`;
  await store.recordTaskEvent(
    claim.taskId,
    { eventId: `dispatch-${suffix}`, type: 'dispatching', leaseId: claim.leaseId },
    { workerId: 'worker-a' },
  );
  await store.recordTaskEvent(
    claim.taskId,
    {
      eventId: `submitted-${suffix}`,
      type: 'submitted',
      leaseId: claim.leaseId,
      conversationUrl,
      model: 'Deep Think',
    },
    { workerId: 'worker-a' },
  );
  return store.recordTaskEvent(
    claim.taskId,
    {
      eventId: `completed-${suffix}`,
      type: 'completed',
      leaseId: claim.leaseId,
      response: `Response ${suffix}`,
      conversationUrl,
      model: 'Deep Think',
    },
    { workerId: 'worker-a' },
  );
}

test('creation persists prompts and same-thread tasks are leased in deterministic order', async (t) => {
  const harness = await createHarness(t);
  const created = await harness.store.createRun(runInput({ variants: 2 }));

  assert.equal(created.status, 'draft');
  assert.equal(created.tasks.length, 1);
  assert.equal(created.plannedTaskTotal, 4);
  assert.equal(created.stats.total, 4);
  assert.deepEqual(
    created.unitPlan.map((task) => [task.variant, task.promptIndex, task.conversationAction]),
    [
      [1, 1, 'new'],
      [1, 2, 'continue'],
      [2, 1, 'new'],
      [2, 2, 'continue'],
    ],
  );
  assert.equal(await harness.store.claimNext({ workerId: 'worker-a' }), null);

  for (const [index, task] of created.tasks.entries()) {
    const promptPath = path.join(
      harness.rootDir,
      'runs',
      created.id,
      ...task.promptPath.split('/'),
    );
    assert.equal(await fs.readFile(promptPath, 'utf8'), created.prompts[index % 2]);
  }

  await harness.store.runAction(created.id, 'start');
  const first = await harness.store.claimNext({
    workerId: 'worker-a',
    pageUrl: 'https://gemini.google.com/app',
    modelLabel: 'Deep Think',
  });
  assert.equal(first.sequence, 1);
  assert.equal(first.conversationAction, 'new');
  assert.equal(first.prompt, 'Write an opening.');
  assert.equal(first.requiredModel, 'Deep Think');
  assert.equal(await harness.store.claimNext({ workerId: 'worker-b' }), null, 'global concurrency is one');
  assert.equal((await harness.store.getRun(created.id)).tasks.length, 1, 'claiming does not create the next unit');
  await finishTask(harness.store, first);
  const afterFirst = await harness.store.getRun(created.id);
  assert.deepEqual(afterFirst.tasks.map(task => task.status), ['completed', 'pending']);
  assert.equal(await fs.readFile(path.join(harness.rootDir, 'runs', created.id,
    ...afterFirst.tasks[1].promptPath.split('/')), 'utf8'), created.prompts[1]);
  assert.equal(await harness.store.claimNext({ workerId: 'worker-a' }), null, 'continuation respects this run\'s cooldown');

  harness.advance(5_000);
  const second = await harness.store.claimNext({ workerId: 'worker-a' });
  assert.equal(second.sequence, 2);
  assert.equal(second.conversationAction, 'continue');
  assert.equal(second.conversationUrl, 'https://gemini.google.com/app/thread-1');
  await finishTask(harness.store, second);

  harness.advance(5_000);
  const third = await harness.store.claimNext({ workerId: 'worker-a' });
  assert.equal(third.sequence, 3);
  assert.equal(third.variant, 2);
  assert.equal(third.conversationAction, 'new');
  assert.equal(third.conversationUrl, null);
});

test('new_thread_each marks every task as a new conversation', async (t) => {
  const harness = await createHarness(t);
  const run = await harness.store.createRun(
    runInput({ mode: 'new_thread_each', variants: 2 }),
  );
  assert.deepEqual(run.tasks.map((task) => task.conversationAction), ['new']);
  assert.deepEqual(run.unitPlan.map((task) => task.conversationAction), ['new', 'new', 'new', 'new']);
});

test('prompt runs can continue an existing custom Gem conversation from the first task', async (t) => {
  const harness = await createHarness(t);
  const conversationUrl = 'https://gemini.google.com/gem/custom-gem-1/thread_abc';
  const run = await harness.store.createRun(runInput({
    conversationUrl: `${conversationUrl}?utm_source=test#latest`,
  }));

  assert.equal(run.conversationUrl, conversationUrl);
  assert.deepEqual(run.tasks.map((task) => task.conversationAction), ['continue']);
  assert.deepEqual(run.unitPlan.map((task) => task.conversationAction), ['continue', 'continue']);
  assert.deepEqual(run.unitPlan.map((task) => task.conversationUrl), [conversationUrl, conversationUrl]);

  await harness.store.runAction(run.id, 'start');
  const claim = await harness.store.claimNext({
    workerId: 'worker-a',
    pageUrl: conversationUrl,
    modelLabel: 'Deep Think',
  });
  assert.equal(claim.conversationAction, 'continue');
  assert.equal(claim.conversationUrl, conversationUrl);
});

test('existing prompt conversations require same_thread and a canonical Gemini URL', async (t) => {
  const harness = await createHarness(t);
  await assert.rejects(
    harness.store.createRun(runInput({
      mode: 'new_thread_each',
      conversationUrl: 'https://gemini.google.com/app/thread-1',
    })),
    (error) => error.code === 'invalid_conversation_url',
  );
  await assert.rejects(
    harness.store.createRun(runInput({
      conversationUrl: 'https://gemini.google.com/gem/only-one-id',
    })),
    (error) => error.code === 'invalid_conversation_url',
  );
});

test('native paste preparation exposes a prompt only for its exact active continuation lease', async (t) => {
  const harness = await createHarness(t);
  const run = await harness.store.createRun(runInput());
  await harness.store.runAction(run.id, 'start');
  const first = await harness.store.claimNext({ workerId: 'worker-a' });
  await assert.rejects(
    harness.store.prepareNativePaste(first.taskId, {
      workerId: 'worker-a',
      leaseId: first.leaseId,
    }),
    error => error.code === 'native_paste_unsupported_task',
  );
  await finishTask(harness.store, first);

  harness.advance(5_000);
  const second = await harness.store.claimNext({ workerId: 'worker-a' });
  await assert.rejects(
    harness.store.prepareNativePaste(second.taskId, {
      workerId: 'worker-b',
      leaseId: second.leaseId,
    }),
    error => error.code === 'lease_owner_mismatch',
  );
  const prepared = await harness.store.prepareNativePaste(second.taskId, {
    workerId: 'worker-a',
    leaseId: second.leaseId,
  });
  assert.equal(prepared.prompt, 'Continue with a reversal.');
  assert.equal(prepared.targetUrl, 'https://gemini.google.com/app/thread-1');
  assert.equal(prepared.leaseId, second.leaseId);

  await harness.store.recordTaskEvent(
    second.taskId,
    { eventId: 'native-paste-fence', type: 'dispatching', leaseId: second.leaseId },
    { workerId: 'worker-a' },
  );
  await assert.rejects(
    harness.store.prepareNativePaste(second.taskId, {
      workerId: 'worker-a',
      leaseId: second.leaseId,
    }),
    error => error.code === 'native_paste_invalid_state',
  );
});

test('redo runs durably lease one bound regeneration per repetition without a prompt', async (t) => {
  const harness = await createHarness(t);
  const sourceUrl = 'https://gemini.google.com/app/0123456789abcdef';
  const run = await harness.store.createRun(redoInput({
    conversationUrl: `${sourceUrl}?utm_source=test#answer`,
  }));

  assert.equal(run.runKind, 'redo');
  assert.equal(run.mode, 'same_thread');
  assert.deepEqual(run.prompts, []);
  assert.equal(run.variants, 1);
  assert.equal(run.repeatCount, 3);
  assert.equal(run.redoOption, 'try_again');
  assert.equal(run.conversationUrl, sourceUrl);
  assert.equal(run.plannedTaskTotal, 3);
  assert.equal(run.unitPlan.length, 3);
  assert.deepEqual(
    run.tasks.map((task) => ({
      sequence: task.sequence,
      repeatIndex: task.repeatIndex,
      redoIndex: task.redoIndex,
      promptIndex: task.promptIndex,
      action: task.conversationAction,
      url: task.conversationUrl,
      redoOption: task.redoOption,
    })),
    [1].map((repeatIndex) => ({
      sequence: repeatIndex,
      repeatIndex,
      redoIndex: repeatIndex,
      promptIndex: repeatIndex,
      action: 'redo',
      url: sourceUrl,
      redoOption: 'try_again',
    })),
  );
  for (const task of run.tasks) {
    assert.equal(
      await fs.readFile(
        path.join(harness.rootDir, 'runs', run.id, ...task.promptPath.split('/')),
        'utf8',
      ),
      '',
    );
  }

  await harness.store.runAction(run.id, 'start');
  const first = await harness.store.claimNext({ workerId: 'worker-a' });
  assert.equal(first.runKind, 'redo');
  assert.equal(first.conversationAction, 'redo');
  assert.equal(first.conversationUrl, sourceUrl);
  assert.equal(first.prompt, null);
  assert.equal(first.repeatIndex, 1);
  assert.equal(first.redoIndex, 1);
  assert.equal(first.repeatCount, 3);
  assert.equal(first.redoOption, 'try_again');
  assert.equal(first.requiredModel, 'Pro Extended');

  await harness.store.recordTaskEvent(
    first.taskId,
    {
      eventId: 'redo-1-fence',
      type: 'dispatching',
      leaseId: first.leaseId,
      conversationUrl: sourceUrl,
    },
    { workerId: 'worker-a' },
  );
  await harness.store.recordTaskEvent(
    first.taskId,
    {
      eventId: 'redo-1-submitted',
      type: 'submitted',
      leaseId: first.leaseId,
      conversationUrl: `${sourceUrl}?canonicalized=yes`,
      model: 'Pro Extended',
    },
    { workerId: 'worker-a' },
  );
  await harness.store.recordTaskEvent(
    first.taskId,
    {
      eventId: 'redo-1-completed',
      type: 'completed',
      leaseId: first.leaseId,
      response: 'First regenerated answer',
      conversationUrl: sourceUrl,
      model: 'Pro Extended',
    },
    { workerId: 'worker-a' },
  );

  const restarted = await harness.restart();
  harness.advance(5_000);
  const second = await restarted.claimNext({ workerId: 'worker-a' });
  assert.equal(second.conversationAction, 'redo');
  assert.equal(second.conversationUrl, sourceUrl);
  assert.equal(second.prompt, null);
  assert.equal(second.repeatIndex, 2);
  assert.equal(second.redoIndex, 2);
  assert.equal(second.redoOption, 'try_again');

  const turn = JSON.parse(await fs.readFile(
    path.join(harness.rootDir, 'runs', run.id, ...run.tasks[0].turnPath.split('/')),
    'utf8',
  ));
  assert.equal(turn.runKind, 'redo');
  assert.equal(turn.repeatIndex, 1);
  assert.equal(turn.redoIndex, 1);
  assert.equal(turn.repeatCount, 3);
  assert.equal(turn.redoOption, 'try_again');
  assert.equal(turn.prompt, '');
  assert.equal(turn.response, 'First regenerated answer');
});

test('redo run validation requires a concrete Gemini conversation, count, and model', async (t) => {
  const harness = await createHarness(t);
  const invalidInputs = [
    [redoInput({ conversationUrl: 'https://gemini.google.com/app' }), 'invalid_conversation_url'],
    [redoInput({ conversationUrl: 'http://gemini.google.com/app/thread' }), 'invalid_conversation_url'],
    [redoInput({ conversationUrl: 'https://example.com/app/thread' }), 'invalid_conversation_url'],
    [redoInput({ conversationUrl: 'https://gemini.google.com/app/thread/nested' }), 'invalid_conversation_url'],
    [redoInput({ repeatCount: 0 }), 'invalid_repeat_count'],
    [redoInput({ repeatCount: 101 }), 'invalid_repeat_count'],
    [redoInput({ requiredModel: '   ' }), 'invalid_required_model'],
    [redoInput({ redoOption: 'more_casual' }), 'invalid_redo_option'],
  ];
  for (const [input, code] of invalidInputs) {
    await assert.rejects(
      harness.store.createRun(input),
      (error) => error.statusCode === 400 && error.code === code,
    );
  }
  assert.deepEqual(await harness.store.listRuns(), []);
});

test('redo runs persist and lease each exact supported Gemini menu option', async (t) => {
  for (const redoOption of ['try_again', 'longer', 'shorter']) {
    const harness = await createHarness(t);
    const run = await harness.store.createRun(redoInput({ repeatCount: 1, redoOption }));
    assert.equal(run.redoOption, redoOption);
    assert.equal(run.tasks[0].redoOption, redoOption);
    await harness.store.runAction(run.id, 'start');
    const claim = await harness.store.claimNext({ workerId: `worker-${redoOption}` });
    assert.equal(claim.redoOption, redoOption);
  }
});

test('workflow Redo units preserve the selected Gemini menu option across restart', async (t) => {
  const harness = await createHarness(t);
  const run = await harness.store.createRun({
    runKind: 'workflow',
    title: 'Shorter workflow',
    conversationUrl: 'https://gemini.google.com/app/shorter-workflow',
    actionBranch: 'send_then_redo',
    redoCount: 1,
    redoOption: 'shorter',
    prompt: 'Write this once.',
    requiredModel: 'Pro Extended',
    minDelayMs: 5_000,
    maxRetries: 0,
  });
  assert.equal(run.redoOption, 'shorter');
  assert.equal(run.tasks[0].redoOption, null);
  assert.equal(run.unitPlan[1].redoOption, 'shorter');
  const restarted = await harness.restart();
  const persisted = await restarted.getRun(run.id);
  assert.equal(persisted.redoOption, 'shorter');
  assert.equal(persisted.unitPlan[1].redoOption, 'shorter');
});

test('redo results cannot be attached to a different Gemini conversation', async (t) => {
  const harness = await createHarness(t);
  const run = await harness.store.createRun(redoInput({ repeatCount: 1 }));
  await harness.store.runAction(run.id, 'start');
  const claim = await harness.store.claimNext({ workerId: 'worker-a' });
  for (const type of ['dispatching', 'submitted', 'completed']) {
    await assert.rejects(
      harness.store.recordTaskEvent(
        claim.taskId,
        {
          eventId: `missing-redo-thread-${type}`,
          type,
          leaseId: claim.leaseId,
          ...(type === 'completed' ? { response: 'Wrongly unattributed answer' } : {}),
        },
        { workerId: 'worker-a' },
      ),
      (error) => error.statusCode === 409 && error.code === 'conversation_url_required',
    );
  }
  await assert.rejects(
    harness.store.recordTaskEvent(
      claim.taskId,
      {
        eventId: 'wrong-redo-thread',
        type: 'submitted',
        leaseId: claim.leaseId,
        conversationUrl: 'https://gemini.google.com/app/different-thread',
      },
      { workerId: 'worker-a' },
    ),
    (error) => error.statusCode === 409 && error.code === 'conversation_url_mismatch',
  );
});

test('rejects delays that could overflow persisted ISO timestamps', async (t) => {
  const harness = await createHarness(t);
  await assert.rejects(
    harness.store.createRun(runInput({ minDelayMs: 1e20 })),
    (error) => error.statusCode === 400 && error.code === 'invalid_delay',
  );
  assert.deepEqual(await harness.store.listRuns(), []);
});

for (const corruption of ['delay', 'timestamp']) {
  test(`init rejects a manifest with an invalid ${corruption}`, async (t) => {
    const harness = await createHarness(t);
    const run = await harness.store.createRun(runInput({ prompts: ['Validate me'] }));
    const manifestPath = path.join(harness.rootDir, 'runs', run.id, 'manifest.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    if (corruption === 'delay') manifest.minDelayMs = 1e20;
    else manifest.nextAvailableAt = 'not-a-time';
    await fs.writeFile(manifestPath, JSON.stringify(manifest), 'utf8');

    const restarted = new AutomationStore(harness.rootDir, harness.storeOptions);
    await assert.rejects(
      restarted.init(),
      (error) => error.statusCode === 500 && error.code === 'invalid_manifest',
    );
  });
}

test('completed turn is written as Markdown, JSON, and one idempotent transcript entry', async (t) => {
  const harness = await createHarness(t);
  const run = await harness.store.createRun(
    runInput({ prompts: ['A durable prompt'], mode: 'new_thread_each' }),
  );
  await harness.store.runAction(run.id, 'start');
  const claim = await harness.store.claimNext({ workerId: 'worker-a' });
  const dispatchTelemetry = {
    schemaVersion: 1,
    prewarm: { attempted: true, durationMs: 87.4, nextHopProtocol: 'h2' },
  };
  await harness.store.recordTaskEvent(
    claim.taskId,
    {
      eventId: 'dispatch-once',
      type: 'dispatching',
      leaseId: claim.leaseId,
      telemetry: dispatchTelemetry,
    },
    { workerId: 'worker-a' },
  );
  const submittedTelemetry = { ...dispatchTelemetry, fenceRoundTripMs: 23.1 };
  await harness.store.recordTaskEvent(
    claim.taskId,
    {
      eventId: 'submitted-once',
      type: 'submitted',
      leaseId: claim.leaseId,
      conversationUrl: 'https://gemini.google.com/app/durable',
      model: 'Deep Think',
      telemetry: submittedTelemetry,
    },
    { workerId: 'worker-a' },
  );
  const completion = {
    eventId: 'complete-once',
    type: 'completed',
    leaseId: claim.leaseId,
    response: '# Saved response\n\nNothing is lost.',
    responseHtml: '<article><h1>Saved response</h1><p>Nothing is lost.</p></article>',
    conversationUrl: 'https://gemini.google.com/app/durable',
    model: 'Deep Think',
    telemetry: {
      schemaVersion: 1,
      promptUtf8Bytes: 4096,
      prewarm: { attempted: true, durationMs: 121.5, nextHopProtocol: 'h3' },
    },
  };
  const firstResult = await harness.store.recordTaskEvent(
    claim.taskId,
    completion,
    { workerId: 'worker-a' },
  );
  const duplicateResult = await harness.store.recordTaskEvent(
    claim.taskId,
    completion,
    { workerId: 'worker-a' },
  );

  assert.equal(firstResult.duplicate, false);
  assert.equal(duplicateResult.duplicate, true);
  assert.equal((await harness.store.getRun(run.id)).status, 'completed');

  const taskDir = path.join(harness.rootDir, 'runs', run.id, 'tasks', claim.taskId);
  assert.equal(await fs.readFile(path.join(taskDir, 'response.md'), 'utf8'), completion.response);
  assert.equal(await fs.readFile(path.join(taskDir, 'response.html'), 'utf8'), completion.responseHtml);
  const turn = JSON.parse(await fs.readFile(path.join(taskDir, 'turn.json'), 'utf8'));
  assert.equal(turn.completionEventId, completion.eventId);
  assert.equal(turn.prompt, 'A durable prompt');
  assert.equal(turn.response, completion.response);
  assert.equal(turn.responseHtml, undefined, 'large HTML is not duplicated into turn.json');
  assert.equal(turn.responseHtmlPath.endsWith('/response.html'), true);
  assert.deepEqual(turn.telemetry, completion.telemetry);
  const savedTask = (await harness.store.getRun(run.id)).tasks[0];
  assert.equal(savedTask.responseHtmlPath, turn.responseHtmlPath);
  assert.deepEqual(savedTask.events.find((event) => event.eventId === 'dispatch-once').telemetry, dispatchTelemetry);
  assert.deepEqual(savedTask.events.find((event) => event.eventId === 'submitted-once').telemetry, submittedTelemetry);

  const transcript = (await fs.readFile(
    path.join(harness.rootDir, 'runs', run.id, 'transcript.jsonl'),
    'utf8',
  )).trim().split('\n').map(JSON.parse);
  assert.equal(transcript.length, 1);
  assert.equal(transcript[0].taskId, claim.taskId);

  const eventLog = (await fs.readFile(path.join(taskDir, 'events.jsonl'), 'utf8'))
    .trim().split('\n').map(JSON.parse);
  assert.equal(eventLog.filter((event) => event.eventId === completion.eventId).length, 1);
});

test('post-dispatch blocked saves unconfirmed partial recovery without completing the task', async (t) => {
  const harness = await createHarness(t);
  const run = await harness.store.createRun(runInput({ prompts: ['Long generation'] }));
  await harness.store.runAction(run.id, 'start');
  const claim = await harness.store.claimNext({ workerId: 'worker-a' });
  await harness.store.recordTaskEvent(
    claim.taskId,
    { eventId: 'partial-fence', type: 'dispatching', leaseId: claim.leaseId },
    { workerId: 'worker-a' },
  );
  const partial = 'A visible but unconfirmed partial answer.';
  const partialHtml = '<p>A visible but <strong>unconfirmed</strong> partial answer.</p>';
  const blocked = await harness.store.recordTaskEvent(
    claim.taskId,
    {
      eventId: 'stop-selector-blocked',
      type: 'blocked',
      leaseId: claim.leaseId,
      error: 'STOP_SELECTOR_DISAPPEARED after generation began',
      responsePartial: partial,
      responseHtml: partialHtml,
      conversationUrl: 'https://gemini.google.com/app/partial-thread',
      model: 'Deep Think',
    },
    { workerId: 'worker-a' },
  );

  assert.equal(blocked.run.status, 'failed');
  assert.equal(blocked.task.status, 'failed');
  assert.equal(blocked.task.completedAt, null);
  assert.equal(blocked.task.recovery.unconfirmed, true);
  assert.equal(blocked.task.conversationUrl, 'https://gemini.google.com/app/partial-thread');
  assert.equal(blocked.task.model, 'Deep Think');
  const recovery = blocked.task.recovery;
  const taskDir = path.join(harness.rootDir, 'runs', run.id, 'tasks', claim.taskId);
  assert.equal(await fs.readFile(path.join(taskDir, 'recovery.md'), 'utf8'), partial);
  assert.equal(await fs.readFile(path.join(taskDir, 'recovery.html'), 'utf8'), partialHtml);
  const metadata = JSON.parse(await fs.readFile(path.join(taskDir, 'recovery.json'), 'utf8'));
  assert.equal(metadata.eventId, 'stop-selector-blocked');
  assert.equal(metadata.leaseId, claim.leaseId);
  assert.equal(metadata.unconfirmed, true);
  assert.equal(metadata.reason, 'STOP_SELECTOR_DISAPPEARED after generation began');
  assert.equal(metadata.conversationUrl, 'https://gemini.google.com/app/partial-thread');
  const blockedEvent = blocked.task.events.find((event) => event.eventId === 'stop-selector-blocked');
  assert.equal(blockedEvent.recoveryPath, recovery.recoveryPath);
  assert.equal(blockedEvent.recoverySha256, recovery.sha256);
  await assert.rejects(
    fs.readFile(path.join(taskDir, 'response.md'), 'utf8'),
    (error) => error.code === 'ENOENT',
  );
  await assert.rejects(
    fs.readFile(path.join(harness.rootDir, 'runs', run.id, 'transcript.jsonl'), 'utf8'),
    (error) => error.code === 'ENOENT',
  );

  const restarted = await harness.restart();
  const recoveredRun = await restarted.getRun(run.id);
  assert.equal(recoveredRun.status, 'failed');
  assert.equal(recoveredRun.tasks[0].status, 'failed');
  assert.deepEqual(recoveredRun.tasks[0].recovery, recovery);
  assert.equal(
    recoveredRun.tasks[0].conversationUrl,
    'https://gemini.google.com/app/partial-thread',
  );
  assert.equal(recoveredRun.tasks[0].model, 'Deep Think');
  const retried = await restarted.runAction(run.id, 'retry');
  assert.equal(retried.tasks[0].status, 'pending');
  assert.deepEqual(retried.tasks[0].recovery, recovery, 'retry preserves the prior recovery');
});

test('restart reconciles recovery.json written before a blocked manifest replacement', async (t) => {
  const harness = await createHarness(t);
  const run = await harness.store.createRun(runInput({ prompts: ['Crash-safe partial'] }));
  await harness.store.runAction(run.id, 'start');
  const claim = await harness.store.claimNext({ workerId: 'worker-a' });
  await harness.store.recordTaskEvent(
    claim.taskId,
    { eventId: 'crash-partial-fence', type: 'dispatching', leaseId: claim.leaseId },
    { workerId: 'worker-a' },
  );

  const persistRun = harness.store._persistRun.bind(harness.store);
  let failOnce = true;
  harness.store._persistRun = async (value) => {
    if (failOnce) {
      failOnce = false;
      throw new Error('injected crash after recovery commit marker');
    }
    return persistRun(value);
  };
  await assert.rejects(
    harness.store.recordTaskEvent(
      claim.taskId,
      {
        eventId: 'crashed-blocked-event',
        type: 'blocked',
        leaseId: claim.leaseId,
        error: 'Stop selector became unavailable',
        responsePartial: 'Partial captured immediately before the crash.',
      },
      { workerId: 'worker-a' },
    ),
    /injected crash/,
  );

  const restarted = await harness.restart();
  const recovered = await restarted.getRun(run.id);
  assert.equal(recovered.status, 'failed');
  assert.equal(recovered.tasks[0].status, 'failed');
  assert.equal(recovered.tasks[0].completedAt, null);
  assert.equal(recovered.tasks[0].recovery.eventId, 'crashed-blocked-event');
  assert.equal(recovered.tasks[0].recovery.unconfirmed, true);
  assert.equal(
    recovered.tasks[0].events.some(
      (event) => event.eventId === 'crashed-blocked-event' && event.recovered === true,
    ),
    true,
  );
});

for (const recoveryCorruption of ['path', 'lease']) {
  test(`init rejects a recovery manifest with a corrupted ${recoveryCorruption}`, async (t) => {
    const harness = await createHarness(t);
    const run = await harness.store.createRun(runInput({ prompts: ['Validate recovery'] }));
    await harness.store.runAction(run.id, 'start');
    const claim = await harness.store.claimNext({ workerId: 'worker-a' });
    await harness.store.recordTaskEvent(
      claim.taskId,
      { eventId: `validate-fence-${recoveryCorruption}`, type: 'dispatching', leaseId: claim.leaseId },
      { workerId: 'worker-a' },
    );
    await harness.store.recordTaskEvent(
      claim.taskId,
      {
        eventId: `validate-recovery-${recoveryCorruption}`,
        type: 'blocked',
        leaseId: claim.leaseId,
        error: 'Validation fixture',
        responsePartial: 'Preserve me',
      },
      { workerId: 'worker-a' },
    );
    const manifestPath = path.join(harness.rootDir, 'runs', run.id, 'manifest.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    if (recoveryCorruption === 'path') {
      manifest.tasks[0].recovery.recoveryPath = '../../outside.md';
    } else {
      manifest.tasks[0].recovery.leaseId = 'short';
    }
    await fs.writeFile(manifestPath, JSON.stringify(manifest), 'utf8');

    const restarted = new AutomationStore(harness.rootDir, harness.storeOptions);
    await assert.rejects(
      restarted.init(),
      (error) => error.statusCode === 500 && error.code === 'invalid_manifest',
    );
  });
}

test('duplicate dispatch retries the manifest write before acknowledging the click fence', async (t) => {
  const harness = await createHarness(t);
  const run = await harness.store.createRun(runInput({ prompts: ['Exactly once'] }));
  await harness.store.runAction(run.id, 'start');
  const claim = await harness.store.claimNext({ workerId: 'worker-a' });

  const persistRun = harness.store._persistRun.bind(harness.store);
  let failOnce = true;
  harness.store._persistRun = async (value) => {
    if (failOnce) {
      failOnce = false;
      throw new Error('injected atomic manifest failure');
    }
    return persistRun(value);
  };

  const fence = {
    eventId: 'write-ahead-fence',
    type: 'dispatching',
    leaseId: claim.leaseId,
  };
  await assert.rejects(
    harness.store.recordTaskEvent(claim.taskId, fence, { workerId: 'worker-a' }),
    (error) => error.statusCode === 500,
  );
  const retried = await harness.store.recordTaskEvent(
    claim.taskId,
    fence,
    { workerId: 'worker-a' },
  );
  assert.equal(retried.duplicate, true);

  const manifest = JSON.parse(await fs.readFile(
    path.join(harness.rootDir, 'runs', run.id, 'manifest.json'),
    'utf8',
  ));
  assert.equal(manifest.tasks[0].status, 'submitted');
  assert.equal(manifest.tasks[0].deliveryConfirmed, false);
});

test('restart safely requeues an expired lease that never crossed the dispatch fence', async (t) => {
  const harness = await createHarness(t);
  const run = await harness.store.createRun(runInput({ prompts: ['Safe to retry'] }));
  await harness.store.runAction(run.id, 'start');
  const firstClaim = await harness.store.claimNext({ workerId: 'worker-a' });
  assert.equal(firstClaim.attempt, 1);

  harness.advance(1_001);
  const restarted = await harness.restart();
  const recovered = await restarted.getRun(run.id);
  assert.equal(recovered.tasks[0].status, 'pending');
  assert.equal(recovered.status, 'running');

  const secondClaim = await restarted.claimNext({ workerId: 'worker-b' });
  assert.equal(secondClaim.taskId, firstClaim.taskId);
  assert.equal(secondClaim.attempt, 2);
});

for (const fenceEvent of ['dispatching', 'submitted']) {
  test(`${fenceEvent} lease timeout becomes uncertain and is never blindly requeued`, async (t) => {
    const harness = await createHarness(t);
    const run = await harness.store.createRun(runInput({ prompts: ['Do not duplicate'] }));
    await harness.store.runAction(run.id, 'start');
    const claim = await harness.store.claimNext({ workerId: 'worker-a' });
    await harness.store.recordTaskEvent(
      claim.taskId,
      {
        eventId: `${fenceEvent}-fence`,
        type: fenceEvent,
        leaseId: claim.leaseId,
        conversationUrl:
          fenceEvent === 'submitted' ? 'https://gemini.google.com/app/uncertain' : undefined,
      },
      { workerId: 'worker-a' },
    );

    harness.advance(1_001);
    const restarted = await harness.restart();
    const recovered = await restarted.getRun(run.id);
    assert.equal(recovered.status, 'failed');
    assert.equal(recovered.tasks[0].status, 'uncertain');
    assert.equal(recovered.tasks[0].error.code, 'lease_expired_after_submit');
    assert.equal(await restarted.claimNext({ workerId: 'worker-b' }), null);

    const retried = await restarted.runAction(run.id, 'retry');
    assert.equal(retried.tasks[0].status, 'pending', 'only an explicit human retry releases it');
  });
}

test('pause revokes an unfenced lease and resume can safely claim it again', async (t) => {
  const harness = await createHarness(t);
  const run = await harness.store.createRun(runInput({ prompts: ['Paused prompt'] }));
  await harness.store.runAction(run.id, 'start');
  const firstClaim = await harness.store.claimNext({ workerId: 'worker-a' });
  assert.equal(firstClaim.attempt, 1);

  const paused = await harness.store.runAction(run.id, 'pause');
  assert.equal(paused.status, 'paused');
  assert.equal(paused.tasks[0].status, 'pending');
  assert.equal(paused.tasks[0].lease, null);
  await assert.rejects(
    harness.store.recordTaskEvent(
      firstClaim.taskId,
      {
        eventId: 'late-fence-after-pause',
        type: 'dispatching',
        leaseId: firstClaim.leaseId,
      },
      { workerId: 'worker-a' },
    ),
    (error) => error.statusCode === 409 && error.code === 'task_not_leased',
  );
  assert.equal(await harness.store.claimNext({ workerId: 'worker-a' }), null);
  assert.equal((await harness.store.runAction(run.id, 'resume')).status, 'running');
  const secondClaim = await harness.store.claimNext({ workerId: 'worker-a' });
  assert.equal(secondClaim.taskId, run.tasks[0].id);
  assert.equal(secondClaim.attempt, 2);
});

test('pause leaves a submitted task leased so its current round can finish', async (t) => {
  const harness = await createHarness(t);
  const run = await harness.store.createRun(runInput());
  await harness.store.runAction(run.id, 'start');
  const claim = await harness.store.claimNext({ workerId: 'worker-a' });
  await harness.store.recordTaskEvent(
    claim.taskId,
    { eventId: 'fence-before-pause', type: 'dispatching', leaseId: claim.leaseId },
    { workerId: 'worker-a' },
  );

  const paused = await harness.store.runAction(run.id, 'pause');
  assert.equal(paused.status, 'paused');
  assert.equal(paused.tasks[0].status, 'submitted');
  assert.equal(paused.tasks[0].lease.workerId, 'worker-a');

  await harness.store.recordTaskEvent(
    claim.taskId,
    {
      eventId: 'completion-after-pause',
      type: 'completed',
      leaseId: claim.leaseId,
      response: 'The in-flight round completed.',
      conversationUrl: 'https://gemini.google.com/app/paused-round',
    },
    { workerId: 'worker-a' },
  );
  const afterCompletion = await harness.store.getRun(run.id);
  assert.equal(afterCompletion.status, 'paused');
  assert.equal(afterCompletion.tasks[0].status, 'completed');
  assert.equal(afterCompletion.tasks[1].status, 'pending');
});

test('a new claim permanently rejects a late terminal event from the previous lease', async (t) => {
  const harness = await createHarness(t);
  const run = await harness.store.createRun(runInput({ prompts: ['Lease-isolated prompt'] }));
  await harness.store.runAction(run.id, 'start');
  const firstClaim = await harness.store.claimNext({ workerId: 'worker-a' });
  const attemptOneFence = {
    eventId: 'attempt-one-fence',
    type: 'dispatching',
    leaseId: firstClaim.leaseId,
  };
  await harness.store.recordTaskEvent(
    firstClaim.taskId,
    attemptOneFence,
    { workerId: 'worker-a' },
  );
  harness.advance(1_001);
  assert.equal((await harness.store.getRun(run.id)).tasks[0].status, 'uncertain');
  await harness.store.runAction(run.id, 'retry');
  await assert.rejects(
    harness.store.recordTaskEvent(
      firstClaim.taskId,
      attemptOneFence,
      { workerId: 'worker-a' },
    ),
    (error) => error.statusCode === 409 && error.code === 'stale_lease',
  );
  const secondClaim = await harness.store.claimNext({ workerId: 'worker-a' });
  assert.equal(secondClaim.attempt, 2);
  assert.notEqual(secondClaim.leaseId, firstClaim.leaseId);
  await assert.rejects(
    harness.store.recordTaskEvent(
      firstClaim.taskId,
      attemptOneFence,
      { workerId: 'worker-a' },
    ),
    (error) => error.statusCode === 409 && error.code === 'stale_lease',
  );

  await assert.rejects(
    harness.store.recordTaskEvent(
      firstClaim.taskId,
      {
        eventId: 'late-attempt-one-completion',
        type: 'completed',
        leaseId: firstClaim.leaseId,
        response: 'Stale result',
      },
      { workerId: 'worker-a' },
    ),
    (error) => error.statusCode === 409 && error.code === 'lease_id_mismatch',
  );

  const accepted = await harness.store.recordTaskEvent(
    secondClaim.taskId,
    {
      eventId: 'attempt-two-completion',
      type: 'completed',
      leaseId: secondClaim.leaseId,
      response: 'Current result',
    },
    { workerId: 'worker-a' },
  );
  assert.equal(accepted.task.status, 'completed');
});

test('cancel preserves the current lease identity for a late completion', async (t) => {
  const harness = await createHarness(t);
  const run = await harness.store.createRun(runInput({ prompts: ['Save a late result'] }));
  await harness.store.runAction(run.id, 'start');
  const claim = await harness.store.claimNext({ workerId: 'worker-a' });
  await harness.store.recordTaskEvent(
    claim.taskId,
    { eventId: 'cancel-fence', type: 'dispatching', leaseId: claim.leaseId },
    { workerId: 'worker-a' },
  );
  await harness.store.runAction(run.id, 'cancel');

  const late = await harness.store.recordTaskEvent(
    claim.taskId,
    {
      eventId: 'completion-after-cancel',
      type: 'completed',
      leaseId: claim.leaseId,
      response: 'Late but safely attributable result',
    },
    { workerId: 'worker-a' },
  );
  assert.equal(late.run.status, 'canceled');
  assert.equal(late.task.status, 'completed');
});

test('cancel acknowledges a late blocked recovery without reopening the run', async (t) => {
  const harness = await createHarness(t);
  const run = await harness.store.createRun(runInput({ prompts: ['Cancel then recover'] }));
  await harness.store.runAction(run.id, 'start');
  const claim = await harness.store.claimNext({ workerId: 'worker-a' });
  await harness.store.recordTaskEvent(
    claim.taskId,
    { eventId: 'cancel-recovery-dispatch', type: 'dispatching', leaseId: claim.leaseId },
    { workerId: 'worker-a' },
  );
  await harness.store.runAction(run.id, 'cancel');

  const result = await harness.store.recordTaskEvent(
    claim.taskId,
    {
      eventId: 'cancel-recovery-blocked',
      type: 'blocked',
      leaseId: claim.leaseId,
      error: 'Late page uncertainty',
      responsePartial: 'A locally recovered partial answer.',
      conversationUrl: 'https://gemini.google.com/app/canceled-recovery',
      model: 'Pro Extended',
    },
    { workerId: 'worker-a' },
  );

  assert.equal(result.task.status, 'canceled');
  assert.equal(result.task.recovery.unconfirmed, true);
  assert.equal((await harness.store.getRun(run.id)).status, 'canceled');
  assert.equal(result.task.events.at(-1).ignoredAfterCancel, true);
});

test('heartbeat and conversation links are bound to the active trusted lease', async (t) => {
  const harness = await createHarness(t);
  const run = await harness.store.createRun(runInput({ prompts: ['Trusted URL'] }));
  await harness.store.runAction(run.id, 'start');
  const claim = await harness.store.claimNext({ workerId: 'worker-a' });
  await assert.rejects(
    harness.store.heartbeat(claim.taskId, { workerId: 'worker-a', leaseId: 'wrong-id' }),
    (error) => error.statusCode === 409 && error.code === 'lease_id_mismatch',
  );
  assert.equal(
    (await harness.store.heartbeat(
      claim.taskId,
      { workerId: 'worker-a', leaseId: claim.leaseId },
    )).ok,
    true,
  );
  await assert.rejects(
    harness.store.recordTaskEvent(
      claim.taskId,
      {
        eventId: 'unsafe-link',
        type: 'submitted',
        leaseId: claim.leaseId,
        conversationUrl: 'javascript:alert(1)',
      },
      { workerId: 'worker-a' },
    ),
    (error) => error.statusCode === 400 && error.code === 'invalid_conversation_url',
  );
});

test('unsafe conversation links in an older manifest are neutralized on load', async (t) => {
  const harness = await createHarness(t);
  const run = await harness.store.createRun(runInput({ prompts: ['Old URL'] }));
  const manifestPath = path.join(harness.rootDir, 'runs', run.id, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.tasks[0].conversationUrl = 'javascript:alert(document.cookie)';
  await fs.writeFile(manifestPath, JSON.stringify(manifest), 'utf8');

  const restarted = new AutomationStore(harness.rootDir, harness.storeOptions);
  await restarted.init();
  assert.equal((await restarted.getRun(run.id)).tasks[0].conversationUrl, null);
});

test('retryable failure survives restart and observes persistent backoff', async (t) => {
  const harness = await createHarness(t);
  const run = await harness.store.createRun(
    runInput({ prompts: ['Retry later'], maxRetries: 1 }),
  );
  await harness.store.runAction(run.id, 'start');
  const claim = await harness.store.claimNext({ workerId: 'worker-a' });
  const failed = await harness.store.recordTaskEvent(
    claim.taskId,
    {
      eventId: 'temporary-failure',
      type: 'failed',
      leaseId: claim.leaseId,
      error: 'Transient UI issue',
      retryable: true,
    },
    { workerId: 'worker-a' },
  );
  assert.equal(failed.task.status, 'pending');

  const restarted = await harness.restart();
  assert.equal(await restarted.claimNext({ workerId: 'worker-a' }), null);
  harness.advance(4_999);
  assert.equal(await restarted.claimNext({ workerId: 'worker-a' }), null);
  harness.advance(1);
  const retry = await restarted.claimNext({ workerId: 'worker-a' });
  assert.equal(retry.attempt, 2);
});

test('failure after the dispatch fence requires a human retry even when marked retryable', async (t) => {
  const harness = await createHarness(t);
  const run = await harness.store.createRun(runInput({ prompts: ['Potentially delivered'] }));
  await harness.store.runAction(run.id, 'start');
  const claim = await harness.store.claimNext({ workerId: 'worker-a' });
  await harness.store.recordTaskEvent(
    claim.taskId,
    { eventId: 'fenced-dispatch', type: 'dispatching', leaseId: claim.leaseId },
    { workerId: 'worker-a' },
  );
  const failed = await harness.store.recordTaskEvent(
    claim.taskId,
    {
      eventId: 'failure-after-fence',
      type: 'failed',
      leaseId: claim.leaseId,
      error: 'Browser vanished',
      retryable: true,
    },
    { workerId: 'worker-a' },
  );
  assert.equal(failed.task.status, 'uncertain');
  assert.equal(failed.task.error.code, 'worker_failed_after_dispatch');
  assert.equal(failed.run.status, 'failed');
  assert.equal(await harness.store.claimNext({ workerId: 'worker-b' }), null);
});

test('a completed run does not delay the next independent run', async (t) => {
  const harness = await createHarness(t);
  const firstRun = await harness.store.createRun(runInput({ title: 'First', prompts: ['One'] }));
  const secondRun = await harness.store.createRun(runInput({ title: 'Second', prompts: ['Two'] }));
  await harness.store.runAction(firstRun.id, 'start');
  await harness.store.runAction(secondRun.id, 'start');

  const first = await harness.store.claimNext({ workerId: 'worker-a' });
  assert.equal(first.runId, firstRun.id);
  await finishTask(harness.store, first, 'global-first');
  assert.equal((await harness.store.getRun(firstRun.id)).status, 'completed');
  assert.equal((await harness.store.claimNext({ workerId: 'worker-a' })).runId, secondRun.id);
});

test('a blocked run preserves its failed task and lets the next independent run proceed', async (t) => {
  const harness = await createHarness(t);
  const blockedRun = await harness.store.createRun(runInput({ title: 'Blocked', prompts: ['One'] }));
  const waitingRun = await harness.store.createRun(runInput({ title: 'Waiting', prompts: ['Two'] }));
  await harness.store.runAction(blockedRun.id, 'start');
  await harness.store.runAction(waitingRun.id, 'start');
  const claim = await harness.store.claimNext({ workerId: 'worker-a' });
  await harness.store.recordTaskEvent(
    claim.taskId,
    {
      eventId: 'login-block',
      type: 'blocked',
      leaseId: claim.leaseId,
      error: 'Login required',
    },
    { workerId: 'worker-a' },
  );
  harness.advance(5_000);
  const blocked = await harness.store.getRun(blockedRun.id);
  assert.equal(blocked.status, 'failed');
  assert.equal(blocked.tasks[0].blocked, true);
  assert.equal(blocked.tasks[0].attempt, 1);
  assert.equal((await harness.store.getWorkerStatus()).globallyBlocked, false);
  const next = await harness.store.claimNext({ workerId: 'worker-a' });
  assert.equal(next.runId, waitingRun.id);
});

test('restart reconciles a completed turn artifact without delaying another run', async (t) => {
  const harness = await createHarness(t);
  const firstRun = await harness.store.createRun(runInput({ title: 'Crashed', prompts: ['One'] }));
  const secondRun = await harness.store.createRun(runInput({ title: 'Waiting', prompts: ['Two'] }));
  await harness.store.runAction(firstRun.id, 'start');
  await harness.store.runAction(secondRun.id, 'start');
  const claim = await harness.store.claimNext({ workerId: 'worker-a' });
  await harness.store.recordTaskEvent(
    claim.taskId,
    { eventId: 'crash-fence', type: 'dispatching', leaseId: claim.leaseId },
    { workerId: 'worker-a' },
  );

  const completedAt = new Date(harness.now()).toISOString();
  const taskDir = path.join(harness.rootDir, 'runs', firstRun.id, 'tasks', claim.taskId);
  await fs.writeFile(path.join(taskDir, 'response.md'), 'Recovered response', 'utf8');
  await fs.writeFile(
    path.join(taskDir, 'turn.json'),
    JSON.stringify({
      schemaVersion: 1,
      completionEventId: 'crashed-completion',
      runId: firstRun.id,
      taskId: claim.taskId,
      sequence: 1,
      variant: 1,
      promptIndex: 1,
      conversationAction: 'new',
      attempt: 1,
      leaseId: claim.leaseId,
      prompt: 'One',
      response: 'Recovered response',
      completedAt,
    }),
    'utf8',
  );

  harness.advance(1_001);
  const restarted = await harness.restart();
  assert.equal((await restarted.getRun(firstRun.id)).status, 'completed');
  assert.equal((await restarted.claimNext({ workerId: 'worker-a' })).runId, secondRun.id);
});

test('crash recovery creates exactly one next unit after recovering a durable completed answer', async (t) => {
  const harness = await createHarness(t);
  const run = await harness.store.createRun(runInput());
  await harness.store.runAction(run.id, 'start');
  const claim = await harness.store.claimNext({ workerId: 'worker-a' });
  await harness.store.recordTaskEvent(claim.taskId, {
    eventId: 'dispatch-recover-unit', type: 'dispatching', leaseId: claim.leaseId,
  }, { workerId: 'worker-a' });
  const manifestPath = path.join(harness.rootDir, 'runs', run.id, 'manifest.json');
  const beforeCompletion = await fs.readFile(manifestPath, 'utf8');
  await finishTask(harness.store, claim, 'recover-unit');
  // Simulate the persisted turn/transcript surviving a crash before the final
  // manifest replacement. An already-created next task directory is an orphan.
  await fs.writeFile(manifestPath, beforeCompletion, 'utf8');

  const restarted = await harness.restart();
  const recovered = await restarted.getRun(run.id);
  assert.equal(recovered.status, 'running');
  assert.deepEqual(recovered.tasks.map(task => task.status), ['completed', 'pending']);
  assert.equal(recovered.stats.total, 2);
  assert.equal(recovered.stats.completed, 1);
  assert.equal(await fs.readFile(path.join(harness.rootDir, 'runs', run.id,
    ...recovered.tasks[1].promptPath.split('/')), 'utf8'), run.prompts[1]);
  assert.equal(await restarted.claimNext({ workerId: 'worker-a' }), null);

  await harness.restart();
  assert.equal((await harness.store.getRun(run.id)).tasks.length, 2, 'recovery is idempotent');
  harness.advance(5_000);
  const second = await harness.store.claimNext({ workerId: 'worker-a' });
  assert.equal(second.sequence, 2);
  assert.equal(second.prompt, run.prompts[1]);
  assert.equal(second.conversationUrl, 'https://gemini.google.com/app/thread-1');
  await finishTask(harness.store, second, 'recover-unit-second');
  assert.equal((await harness.store.getRun(run.id)).status, 'completed');
});

test('an expired pre-dispatch lease acknowledges its stale abort without blocking the queue', async (t) => {
  const harness = await createHarness(t);
  const run = await harness.store.createRun(runInput({
    title: 'pre-dispatch reload',
    prompts: ['draft'],
    requiredModel: 'Pro Extended',
  }));
  await harness.store.runAction(run.id, 'start');
  const claimed = await harness.store.claimNext({ workerId: 'worker-pre-dispatch' });
  harness.advance(1_001);

  const afterExpiry = await harness.store.getRun(run.id);
  assert.equal(afterExpiry.tasks[0].status, 'pending');
  assert.equal(afterExpiry.tasks[0].dispatchingAt, null);

  const staleTelemetry = {
    schemaVersion: 1,
    prewarm: { attempted: true, ok: false, error: 'signal timed out' },
  };
  const ack = await harness.store.recordTaskEvent(claimed.taskId, {
    eventId: `${claimed.taskId}:stale-abort:${claimed.leaseId}`,
    leaseId: claimed.leaseId,
    type: 'blocked',
    error: 'Extension reloaded before dispatch',
    telemetry: staleTelemetry,
  }, { workerId: 'worker-pre-dispatch' });
  assert.equal(ack.ok, true);
  assert.equal(ack.ignoredBeforeDispatch, true);
  assert.equal(ack.task.status, 'pending');
  assert.equal(ack.task.events.at(-1).ignoredBeforeDispatch, true);
  assert.deepEqual(ack.task.events.at(-1).telemetry, staleTelemetry);

  const reclaimed = await harness.store.claimNext({ workerId: 'worker-pre-dispatch' });
  assert.equal(reclaimed.taskId, claimed.taskId);
  assert.notEqual(reclaimed.leaseId, claimed.leaseId);
});

test('worker presence persists page and model information across restart', async (t) => {
  const harness = await createHarness(t);
  await harness.store.claimNext({
    workerId: 'browser-worker',
    pageUrl: 'https://gemini.google.com/app',
    modelLabel: 'Deep Think',
  });
  let status = await harness.store.getWorkerStatus();
  assert.equal(status.id, 'browser-worker');
  assert.equal(status.pageUrl, 'https://gemini.google.com/app');
  assert.equal(status.currentModel, 'Deep Think');

  const restarted = await harness.restart();
  status = await restarted.getWorkerStatus();
  assert.equal(status.workers[0].id, 'browser-worker');
  assert.equal(status.workers[0].currentModel, 'Deep Think');
});

test('workflow redo_only fences the exact conversation and exports only source prompt plus responses', async (t) => {
  const harness = await createHarness(t);
  const conversationUrl = 'https://gemini.google.com/gem/gem-one/conversation-one';
  const prompt = 'First paragraph.\r\n\r\n\r\nSecond paragraph.';
  const sourceTurn = canonicalTurn(prompt, { turnKey: 'user:7:source', ordinal: 7 });
  const run = await harness.store.createRun({
    runKind: 'workflow',
    title: 'Redo twice',
    conversationUrl,
    actionBranch: 'redo_only',
    redoCount: 2,
    prompt,
    sourceTurn,
    requiredModel: 'Pro Extended',
    minDelayMs: 5_000,
    maxRetries: 0,
  });
  assert.equal(run.tasks.length, 1);
  assert.equal(run.plannedTaskTotal, 2);
  assert.deepEqual(run.unitPlan.map(task => task.resultOrdinal), [1, 2]);
  await harness.store.runAction(run.id, 'start');

  const claim = await harness.store.claimNext({ workerId: 'worker-a' });
  assert.equal(claim.jobType, 'generation');
  assert.equal(claim.runKind, 'workflow');
  assert.equal(claim.prompt, null);
  assert.equal(claim.conversationAction, 'redo');
  assert.equal(claim.redoSource, 'current_last_response');
  assert.equal(claim.sourceTurn, null);
  assert.deepEqual(run.sourceTurn, sourceTurn, 'source snapshot remains available for export');
  await assert.rejects(harness.store.recordTaskEvent(claim.taskId, {
    eventId: 'workflow-wrong-thread',
    type: 'dispatching',
    leaseId: claim.leaseId,
    conversationUrl: 'https://gemini.google.com/app/different-thread',
  }, { workerId: 'worker-a' }), error => error.code === 'conversation_url_mismatch');
  await harness.store.recordTaskEvent(claim.taskId, {
    eventId: 'workflow-dispatch',
    type: 'dispatching',
    leaseId: claim.leaseId,
    conversationUrl,
  }, { workerId: 'worker-a' });
  await harness.store.recordTaskEvent(claim.taskId, {
    eventId: 'workflow-completed',
    type: 'completed',
    leaseId: claim.leaseId,
    conversationUrl,
    response: 'Regenerated answer',
    timing: workflowTiming(),
    visibleThinkingSummary: {
      kind: 'visible_ui_summary',
      text: 'Visible summary',
      textSha256: createHash('sha256').update('Visible summary').digest('hex'),
      capturedAt: new Date(BASE_TIME + 900).toISOString(),
    },
    telemetry: { prewarm: { durationMs: 123 } },
  }, { workerId: 'worker-a' });

  const detail = await harness.store.getRun(run.id);
  assert.deepEqual(detail.tasks.map(task => task.status), ['completed', 'pending']);
  assert.equal(detail.resultGroup.results[0].responseSha256.length, 64);
  assert.equal(detail.resultGroup.results[0].timing.totalMs, 1_000);
  const exported = await harness.store.getRunResults(run.id, { promptLab: true });
  assert.deepEqual(exported.groups, [{
    sourcePrompt: prompt,
    responses: [{ ordinal: 1, role: 'redo', text: 'Regenerated answer' }],
  }]);
  assert.equal(JSON.stringify(exported).includes('telemetry'), false);
  assert.equal(JSON.stringify(exported).includes('Thinking'), false);
});

test('send workflow accepts zero through one hundred redo steps and builds initial plus N results', async (t) => {
  const harness = await createHarness(t);
  const common = {
    runKind: 'workflow', title: 'Send and redo',
    conversationUrl: 'https://gemini.google.com/app/send-thread',
    actionBranch: 'send_then_redo', prompt: 'A long-form prompt', requiredModel: 'Pro Extended',
    minDelayMs: 5_000, maxRetries: 0,
  };
  const noRedo = await harness.store.createRun({ ...common, redoCount: 0 });
  assert.equal(noRedo.tasks.length, 1);
  assert.equal(noRedo.tasks[0].conversationAction, 'continue');
  const hundred = await harness.store.createRun({ ...common, redoCount: 100, title: 'Send plus 100' });
  assert.equal(hundred.tasks.length, 1);
  assert.equal(hundred.plannedTaskTotal, 101);
  assert.deepEqual(hundred.unitPlan.slice(-2).map(task => task.resultOrdinal), [99, 100]);
  await assert.rejects(
    harness.store.createRun({ ...common, redoCount: 101, title: 'Too many' }),
    error => error.code === 'invalid_redo_count',
  );
});

test('edit workflow requires exact target evidence and promotes the replacement turn for redo', async (t) => {
  const harness = await createHarness(t);
  const conversationUrl = 'https://gemini.google.com/app/edit-thread';
  const original = canonicalTurn('Old prompt', { turnKey: 'user:2:old', ordinal: 2 });
  const replacement = 'New prompt\nwith detail';
  const replacementTurn = canonicalTurn(replacement, { turnKey: 'user:2:new', ordinal: 2 });
  const run = await harness.store.createRun({
    runKind: 'workflow',
    title: 'Edit and redo',
    conversationUrl,
    actionBranch: 'edit_then_redo',
    redoCount: 1,
    prompt: replacement,
    targetTurn: original,
    requiredModel: 'Pro Extended',
    minDelayMs: 5_000,
    maxRetries: 0,
  });
  await harness.store.runAction(run.id, 'start');
  const claim = await harness.store.claimNext({ workerId: 'worker-a' });
  assert.equal(claim.conversationAction, 'edit');
  assert.deepEqual(claim.targetTurn, original);
  const nativePaste = await harness.store.prepareNativePaste(claim.taskId, {
    workerId: 'worker-a', leaseId: claim.leaseId,
  });
  assert.equal(nativePaste.pasteMode, 'replace-open-edit');
  assert.equal('expectedExistingCanonicalSha256' in nativePaste, false);
  await assert.rejects(
    harness.store.recordTaskEvent(claim.taskId, {
      eventId: 'bad-edit-fence',
      type: 'dispatching',
      leaseId: claim.leaseId,
      conversationUrl,
      targetTurnEvidence: {
        expected: original,
        observed: { ...original, ordinal: 3 },
        documentInstanceId: 'document-1',
      },
    }, { workerId: 'worker-a' }),
    error => error.code === 'invalid_target_turn_evidence',
  );
  const evidence = { expected: original, observed: original, documentInstanceId: 'document-1' };
  await harness.store.recordTaskEvent(claim.taskId, {
    eventId: 'edit-fence', type: 'dispatching', leaseId: claim.leaseId, conversationUrl,
    targetTurnEvidence: evidence,
  }, { workerId: 'worker-a' });
  await harness.store.recordTaskEvent(claim.taskId, {
    eventId: 'edit-complete', type: 'completed', leaseId: claim.leaseId, conversationUrl,
    targetTurnEvidence: evidence,
    resultSourceTurn: replacementTurn,
    response: 'Initial edited answer',
    timing: workflowTiming(),
  }, { workerId: 'worker-a' });
  const redo = await harness.store.claimNext({ workerId: 'worker-a' });
  assert.equal(redo.conversationAction, 'redo');
  assert.equal(redo.redoSource, 'current_last_response');
  assert.equal(redo.sourceTurn, null);
  await harness.store.recordTaskEvent(redo.taskId, {
    eventId: 'branch-redo-fence', type: 'dispatching', leaseId: redo.leaseId,
    conversationUrl,
  }, { workerId: 'worker-a' });
  await harness.store.recordTaskEvent(redo.taskId, {
    eventId: 'branch-redo-complete', type: 'completed', leaseId: redo.leaseId,
    conversationUrl,
    response: 'Redo from the edited branch',
    timing: workflowTiming(),
  }, { workerId: 'worker-a' });
});

test('conversation snapshot inspection completes directly from its lease and persists canonical turns', async (t) => {
  const harness = await createHarness(t);
  const conversationUrl = 'https://gemini.google.com/app/snapshot-thread';
  const inspection = await harness.store.createConversationSnapshot({ conversationUrl });
  const claim = await harness.store.claimNext({ workerId: 'worker-a' });
  assert.equal(claim.jobType, 'conversation_snapshot');
  assert.equal(claim.inspectionId, inspection.id);
  const text = 'Prompt A\r\n\r\n\r\nPrompt B';
  const identity = canonicalTurn(text);
  await harness.store.recordConversationSnapshotEvent(inspection.id, {
    eventId: 'snapshot-complete',
    type: 'completed',
    leaseId: claim.leaseId,
    conversationUrl,
    documentInstanceId: 'document-snapshot',
    title: 'Snapshot title',
    turns: [{
      turnKey: 'user:0:test',
      ordinal: 0,
      role: 'user',
      text,
      textSha256: identity.sourceTextSha256,
      textLength: identity.sourceTextLength,
      editable: true,
    }],
  }, { workerId: 'worker-a' });
  const completed = await harness.store.getConversationSnapshot(inspection.id);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.snapshot.turns[0].text, text);
  assert.equal(completed.snapshot.turns[0].textSha256, identity.sourceTextSha256);
  await harness.restart();
  const restarted = await harness.store.getConversationSnapshot(inspection.id);
  assert.equal(restarted.snapshot.documentInstanceId, 'document-snapshot');
});

test('VPN experiment attaches only matching redo workflows and persists node aggregates', async (t) => {
  const harness = await createHarness(t);
  const conversationUrl = 'https://gemini.google.com/app/vpn-thread';
  const prompt = 'VPN source prompt';
  const sourceTurn = canonicalTurn(prompt);
  const run = await harness.store.createRun({
    runKind: 'workflow', title: 'VPN trial', conversationUrl, actionBranch: 'redo_only',
    redoCount: 1, prompt, sourceTurn, requiredModel: 'Pro Extended', minDelayMs: 5_000, maxRetries: 0,
  });
  const experiment = await harness.store.createVpnExperiment({ title: 'VPN nodes', conversationUrl });
  const detail = await harness.store.addVpnExperimentTrial(experiment.id, {
    nodeLabel: 'US Residential 1', runId: run.id,
  });
  assert.equal(detail.aggregates[0].nodeLabel, 'US Residential 1');
  assert.equal(detail.aggregates[0].total, 1);
  assert.equal(detail.aggregates[0].completed, 0);
  const duplicateExperiment = await harness.store.createVpnExperiment({
    title: 'Duplicate binding guard', conversationUrl,
  });
  await assert.rejects(
    harness.store.addVpnExperimentTrial(duplicateExperiment.id, {
      nodeLabel: 'Duplicate node', runId: run.id,
    }),
    error => error.status === 409
      && error.code === 'duplicate_trial_run'
      && error.message.includes(experiment.id),
  );
  const secondRun = await harness.store.createRun({
    runKind: 'workflow', title: 'VPN trial 2', conversationUrl, actionBranch: 'redo_only',
    redoCount: 1, prompt, sourceTurn, requiredModel: 'Pro Extended', minDelayMs: 5_000, maxRetries: 0,
  });
  await assert.rejects(
    harness.store.addVpnExperimentTrial(experiment.id, {
      nodeLabel: 'US Residential 2', runId: secondRun.id,
    }),
    error => error.status === 409 && error.code === 'vpn_trial_active',
  );
  const otherConversationUrl = 'https://gemini.google.com/app/other-vpn-thread';
  const otherRun = await harness.store.createRun({
    runKind: 'workflow', title: 'Other VPN trial', conversationUrl: otherConversationUrl,
    actionBranch: 'redo_only', redoCount: 1, prompt, sourceTurn,
    requiredModel: 'Pro Extended', minDelayMs: 5_000, maxRetries: 0,
  });
  const otherExperiment = await harness.store.createVpnExperiment({
    title: 'Other VPN nodes', conversationUrl: otherConversationUrl,
  });
  await assert.rejects(
    harness.store.addVpnExperimentTrial(otherExperiment.id, {
      nodeLabel: 'EU Residential 1', runId: otherRun.id,
    }),
    error => error.status === 409
      && error.code === 'vpn_trial_active'
      && error.message.includes(experiment.id),
  );
  await harness.store.runAction(run.id, 'cancel');
  const otherNode = await harness.store.addVpnExperimentTrial(otherExperiment.id, {
    nodeLabel: 'EU Residential 1', runId: otherRun.id,
  });
  assert.equal(otherNode.trials.length, 1);
  await harness.store.runAction(otherRun.id, 'cancel');
  const nextNode = await harness.store.addVpnExperimentTrial(experiment.id, {
    nodeLabel: 'US Residential 2', runId: secondRun.id,
  });
  assert.equal(nextNode.trials.length, 2);
  await harness.restart();
  const restarted = await harness.store.getVpnExperiment(experiment.id);
  assert.equal(restarted.trials[0].runId, run.id);
});

test('unobserved first-response timing is persisted but excluded from VPN latency median', async (t) => {
  const harness = await createHarness(t);
  const conversationUrl = 'https://gemini.google.com/app/vpn-unobserved';
  const prompt = 'Identical redo timing source';
  const sourceTurn = canonicalTurn(prompt);
  const run = await harness.store.createRun({
    runKind: 'workflow', title: 'Unobserved first token', conversationUrl,
    actionBranch: 'redo_only', redoCount: 1, prompt, sourceTurn,
    requiredModel: 'Pro Extended', minDelayMs: 5_000, maxRetries: 0,
  });
  const experiment = await harness.store.createVpnExperiment({ title: 'Timing quality', conversationUrl });
  await harness.store.addVpnExperimentTrial(experiment.id, { nodeLabel: 'Node A', runId: run.id });
  await harness.store.runAction(run.id, 'start');
  const claim = await harness.store.claimNext({ workerId: 'worker-a' });
  const evidence = { expected: sourceTurn, observed: sourceTurn, documentInstanceId: 'document-timing' };
  await harness.store.recordTaskEvent(claim.taskId, {
    eventId: 'timing-dispatch', type: 'dispatching', leaseId: claim.leaseId,
    conversationUrl, sourceTurnEvidence: evidence,
  }, { workerId: 'worker-a' });
  const timing = {
    clientSubmittedAt: new Date(BASE_TIME).toISOString(),
    firstResponseVisibleAt: null,
    completedAt: new Date(BASE_TIME + 1_000).toISOString(),
    clickToFirstResponseMs: null,
    firstResponseTimingQuality: 'unobserved',
  };
  await harness.store.recordTaskEvent(claim.taskId, {
    eventId: 'timing-completed', type: 'completed', leaseId: claim.leaseId,
    conversationUrl, sourceTurnEvidence: evidence, response: 'Same visible answer', timing,
  }, { workerId: 'worker-a' });

  const detail = await harness.store.getRun(run.id);
  assert.equal(detail.resultGroup.results[0].timing.firstResponseVisibleAt, null);
  assert.equal(detail.resultGroup.results[0].timing.clickToFirstResponseMs, null);
  assert.equal(detail.resultGroup.results[0].timing.firstResponseTimingQuality, 'unobserved');
  const vpn = await harness.store.getVpnExperiment(experiment.id);
  assert.equal(vpn.aggregates[0].medianClickToFirstResponseMs, null);
  assert.equal(vpn.aggregates[0].medianTotalMs, 1_000);

  const invalidRun = await harness.store.createRun({
    runKind: 'workflow', title: 'Invalid timing quality', conversationUrl,
    actionBranch: 'redo_only', redoCount: 1, prompt, sourceTurn,
    requiredModel: 'Pro Extended', minDelayMs: 5_000, maxRetries: 0,
  });
  await harness.store.runAction(invalidRun.id, 'start');
  harness.advance(5_000);
  const invalidClaim = await harness.store.claimNext({ workerId: 'worker-a' });
  await harness.store.recordTaskEvent(invalidClaim.taskId, {
    eventId: 'invalid-timing-dispatch', type: 'dispatching', leaseId: invalidClaim.leaseId,
    conversationUrl, sourceTurnEvidence: evidence,
  }, { workerId: 'worker-a' });
  await assert.rejects(
    harness.store.recordTaskEvent(invalidClaim.taskId, {
      eventId: 'invalid-timing-completed', type: 'completed', leaseId: invalidClaim.leaseId,
      conversationUrl, sourceTurnEvidence: evidence, response: 'Answer',
      timing: { ...timing, firstResponseTimingQuality: 'guessed-from-dom' },
    }, { workerId: 'worker-a' }),
    error => error.status === 400 && error.code === 'invalid_timing',
  );
});
