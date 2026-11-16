import type { Rule } from '../schemas/rule';
import type { RuleRunResult, TestConfig } from '../types/testing';
import type { CellEdit, WorkbookModel } from '../types/workbook';
import type { WorkerRequest, WorkerResponse } from '../types/worker';

export interface RunHandlers {
  onRuleStart?: (ruleId: string, index: number, total: number) => void;
  onProgress?: (ruleId: string, executed: number, requested: number) => void;
  onResult?: (result: RuleRunResult) => void;
}

export interface RunHandle {
  /** Resolves when every rule has finished; rejects on worker failure; resolves `cancelled` if stopped. */
  done: Promise<'finished' | 'cancelled'>;
  /** Stops the run immediately by terminating the worker (a running test cannot be paused politely). */
  cancel: () => void;
}

let counter = 0;

/** Starts a test run in a fresh Web Worker. One worker per run keeps cancelling trivial and leak-free. */
export function startRun(
  workbook: WorkbookModel,
  edits: CellEdit[],
  rules: Rule[],
  config: TestConfig,
  handlers: RunHandlers = {},
): RunHandle {
  const runId = ++counter;
  const worker = new Worker(new URL('../workers/testRunner.worker.ts', import.meta.url), { type: 'module' });
  let settled = false;
  let resolveDone: (value: 'finished' | 'cancelled') => void = () => undefined;
  let rejectDone: (reason: Error) => void = () => undefined;
  const done = new Promise<'finished' | 'cancelled'>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  const finish = (outcome: 'finished' | 'cancelled'): void => {
    if (settled) return;
    settled = true;
    worker.terminate();
    resolveDone(outcome);
  };
  const fail = (message: string): void => {
    if (settled) return;
    settled = true;
    worker.terminate();
    rejectDone(new Error(message));
  };

  worker.addEventListener('message', (event: MessageEvent<WorkerResponse>) => {
    const message = event.data;
    if (message.runId !== runId) return;
    switch (message.type) {
      case 'rule-start':
        handlers.onRuleStart?.(message.ruleId, message.index, message.total);
        break;
      case 'progress':
        handlers.onProgress?.(message.ruleId, message.executed, message.requested);
        break;
      case 'rule-result':
        handlers.onResult?.(message.result);
        break;
      case 'done':
        finish('finished');
        break;
      case 'error':
        fail(message.message);
        break;
    }
  });
  worker.addEventListener('error', (event) => fail(event.message || 'The test worker crashed.'));

  const request: WorkerRequest = { type: 'run', runId, workbook, edits, rules, config };
  worker.postMessage(request);

  return { done, cancel: () => finish('cancelled') };
}
