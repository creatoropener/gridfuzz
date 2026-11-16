/// <reference lib="webworker" />
/**
 * Runs business-rule tests off the main thread so the interface stays responsive.
 * Everything here is local: the workbook arrives by postMessage and results go back the same way.
 */
import { runRule } from '../engine/runRule';
import { applyEdits } from '../engine/workbook/edits';
import type { WorkerRequest, WorkerResponse } from '../types/worker';

const scope = self as unknown as DedicatedWorkerGlobalScope;

function send(message: WorkerResponse): void {
  scope.postMessage(message);
}

scope.addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  if (request.type !== 'run') return;
  const { runId } = request;
  try {
    // Edits are applied on a copy; the workbook received here is never modified.
    const working = applyEdits(request.workbook, request.edits);
    request.rules.forEach((rule, index) => {
      send({ type: 'rule-start', runId, ruleId: rule.id, index, total: request.rules.length });
      const result = runRule(working, rule, request.config, {
        edits: request.edits,
        onProgress: (executed, requested) =>
          send({ type: 'progress', runId, ruleId: rule.id, executed, requested }),
      });
      send({ type: 'rule-result', runId, result });
    });
    send({ type: 'done', runId });
  } catch (error) {
    send({ type: 'error', runId, message: error instanceof Error ? error.message : String(error) });
  }
});
