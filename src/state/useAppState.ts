import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CalcEngine, isCalcError } from '../engine/calculation/CalcEngine';
import { analyzeWorkbook } from '../engine/calculation/formulaAnalysis';
import {
  SAMPLE_FAULTY_CELL,
  SAMPLE_FIXED_FORMULA,
  SAMPLE_SHEET,
  SAMPLE_WORKBOOK_ID,
  SAMPLE_FLAGSHIP_RULE_ID,
  buildFreightRules,
  buildFreightWorkbook,
} from '../engine/samples/freightQuote';
import { applyEdits, editsFingerprint, upsertEdit } from '../engine/workbook/edits';
import { ImportError, importWorkbook, validateUpload } from '../engine/workbook/importer';
import { buildXlsx } from '../engine/workbook/sheetjsAdapter';
import { DEFAULT_RUNS, DEFAULT_SEED, RuleSchema, TestConfigSchema, type Rule } from '../schemas/rule';
import { readJson, removeByPrefix, writeJson } from '../services/storage';
import { buildReport, counterexampleText, downloadBlob, reportFileName } from '../services/report';
import {
  clearAll,
  loadActivity,
  loadRecent,
  loadStats,
  pushActivity,
  pushRecent,
  recordRulesCreated,
  recordRun,
  type ActivityEntry,
  type RecentWorkbook,
  type Stats,
} from '../services/stats';
import { startRun, type RunHandle } from '../services/testRunnerClient';
import type { RuleRunResult, TestConfig } from '../types/testing';
import type { CellEdit, CellRefModel, Diagnostic, WorkbookModel } from '../types/workbook';
import {
  IDLE_RUN,
  type ImportState,
  type MobilePane,
  type RightTab,
  type RunState,
  type SavedWorkspace,
  type ScenarioView,
  type Session,
  type ToastMessage,
  type View,
} from './types';

const SAMPLE_URL = `${import.meta.env.BASE_URL}samples/freight-quote.xlsx`;
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const workspaceKey = (id: string): string => `workspace.${id}`;

const isSaved = (value: unknown): value is SavedWorkspace =>
  typeof value === 'object' &&
  value !== null &&
  Array.isArray((value as SavedWorkspace).rules) &&
  Array.isArray((value as SavedWorkspace).edits);

function readTheme(): 'dark' | 'light' {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

/** Rules and edits from a previous Save, re-validated: stored data is never trusted. */
function loadSaved(workbook: WorkbookModel): { rules: Rule[]; edits: CellEdit[]; config: TestConfig } | null {
  const saved = readJson<SavedWorkspace | null>(workspaceKey(workbook.id), null, isSaved as (v: unknown) => v is SavedWorkspace | null);
  if (!saved) return null;
  const rules: Rule[] = [];
  for (const candidate of saved.rules) {
    const parsed = RuleSchema.safeParse(candidate);
    if (parsed.success) rules.push(parsed.data);
  }
  const edits = saved.edits.filter(
    (e): e is CellEdit =>
      typeof e === 'object' &&
      e !== null &&
      typeof e.sheet === 'string' &&
      typeof e.address === 'string' &&
      typeof e.content === 'string' &&
      workbook.sheets.some((s) => s.name === e.sheet),
  );
  const config = TestConfigSchema.safeParse(saved.config);
  return { rules, edits, config: config.success ? config.data : { numRuns: DEFAULT_RUNS, seed: DEFAULT_SEED } };
}

export function useAppState() {
  const [theme, setThemeState] = useState<'dark' | 'light'>(readTheme);
  const [view, setView] = useState<View>('dashboard');
  const [session, setSessionState] = useState<Session | null>(null);
  const [importState, setImportState] = useState<ImportState>({ status: 'idle' });
  const [rightTab, setRightTab] = useState<RightTab>('rules');
  const [scenarioView, setScenarioView] = useState<ScenarioView | null>(null);
  const [mobilePane, setMobilePane] = useState<MobilePane>('grid');
  const [run, setRun] = useState<RunState>(IDLE_RUN);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [stats, setStats] = useState<Stats>(loadStats);
  const [recent, setRecent] = useState<RecentWorkbook[]>(loadRecent);
  const [activity, setActivity] = useState<ActivityEntry[]>(loadActivity);

  // Refs hold the latest values so asynchronous callbacks (worker messages, timers) never read stale state.
  const sessionRef = useRef<Session | null>(null);
  const runHandle = useRef<RunHandle | null>(null);
  const toastId = useRef(0);
  const rightTabRef = useRef<RightTab>('rules');
  rightTabRef.current = rightTab;
  const statsRef = useRef(stats);
  const recentRef = useRef(recent);
  const activityRef = useRef(activity);
  statsRef.current = stats;
  recentRef.current = recent;
  activityRef.current = activity;

  /** All session changes go through here so synchronous follow-up reads see the new value. */
  const updateSession = useCallback((change: (s: Session) => Session): Session | null => {
    const current = sessionRef.current;
    if (!current) return null;
    const next = change(current);
    sessionRef.current = next;
    setSessionState(next);
    return next;
  }, []);

  const setSession = useCallback((next: Session | null) => {
    sessionRef.current = next;
    setSessionState(next);
  }, []);

  const toast = useCallback((text: string, tone: ToastMessage['tone'] = 'info') => {
    const id = ++toastId.current;
    setToasts((list) => [...list.slice(-3), { id, tone, text }]);
    window.setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), tone === 'fail' ? 9000 : 5000);
  }, []);
  const dismissToast = useCallback((id: number) => setToasts((list) => list.filter((t) => t.id !== id)), []);

  const logActivity = useCallback((entry: Omit<ActivityEntry, 'at'>) => {
    const next = pushActivity(activityRef.current, entry);
    activityRef.current = next;
    setActivity(next);
  }, []);

  // ---------- derived: the working copy and its calculation engine ----------
  const original = session?.original ?? null;
  const edits = session?.edits ?? null;
  const working = useMemo(() => (original && edits ? applyEdits(original, edits) : null), [original, edits]);
  const fingerprint = useMemo(() => editsFingerprint(edits ?? []), [edits]);

  // The engine is rebuilt whenever the working copy changes. Old instances are simply dropped:
  // they own no external resources, and destroying inside a memo is unsafe under React's double render.
  const calc = useMemo(() => {
    if (!working) return null;
    try {
      return { engine: CalcEngine.fromWorkbook(working), error: null as string | null };
    } catch (error) {
      return { engine: null, error: error instanceof Error ? error.message : String(error) };
    }
  }, [working]);

  const diagnostics: Diagnostic[] = useMemo(() => {
    if (!working) return [];
    return calc?.engine ? [...working.warnings, ...analyzeWorkbook(working, calc.engine)] : working.warnings;
  }, [working, calc]);

  // ---------- theme ----------
  const toggleTheme = useCallback(() => {
    const next = readTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try {
      window.localStorage.setItem('gridfuzz.theme', next);
    } catch {
      /* storage unavailable: the theme still applies for this visit */
    }
    setThemeState(next);
  }, []);

  // ---------- navigation ----------
  const goDashboard = useCallback(() => setView('dashboard'), []);
  const goImport = useCallback(() => {
    setImportState({ status: 'idle' });
    setView('import');
  }, []);
  const goWorkspace = useCallback(() => {
    if (sessionRef.current) setView('workspace');
  }, []);

  // ---------- opening workbooks ----------
  const openSession = useCallback(
    (workbook: WorkbookModel, bytes: ArrayBuffer | null, sheet: string, defaults: { rules: Rule[]; selectedRuleId: string | null }) => {
      runHandle.current?.cancel();
      runHandle.current = null;
      setRun(IDLE_RUN);
      setScenarioView(null);
      const saved = loadSaved(workbook);
      const rules = saved && saved.rules.length > 0 ? saved.rules : defaults.rules;
      const selectedRuleId =
        defaults.selectedRuleId && rules.some((r) => r.id === defaults.selectedRuleId) ? defaults.selectedRuleId : (rules[0]?.id ?? null);
      const initialSheet = workbook.sheets.some((s) => s.name === sheet) ? sheet : (workbook.sheets[0]?.name ?? '');
      setSession({
        original: workbook,
        originalBytes: bytes,
        edits: saved?.edits ?? [],
        rules,
        config: saved?.config ?? { numRuns: DEFAULT_RUNS, seed: DEFAULT_SEED },
        activeSheet: initialSheet,
        selected: null,
        selectedRuleId,
        results: {},
        previous: {},
        dirty: false,
        restored: saved !== null,
      });
      setRightTab('rules');
      setView('workspace');
      const entry: RecentWorkbook = {
        id: workbook.id,
        name: workbook.name,
        sizeBytes: workbook.sizeBytes,
        source: workbook.source,
        openedAt: new Date().toISOString(),
      };
      const nextRecent = pushRecent(recentRef.current, entry);
      recentRef.current = nextRecent;
      setRecent(nextRecent);
      logActivity({ kind: 'opened', text: `Opened ${workbook.name}${saved ? ' with saved rules' : ''}` });
      if (saved) toast('Restored the rules, settings and edits you saved for this workbook.', 'info');
    },
    [logActivity, setSession, toast],
  );

  const openSample = useCallback(() => {
    const workbook = buildFreightWorkbook();
    openSession(workbook, null, SAMPLE_SHEET, { rules: buildFreightRules(), selectedRuleId: SAMPLE_FLAGSHIP_RULE_ID });
  }, [openSession]);

  const importFile = useCallback(async (file: File) => {
    setImportState({ status: 'reading', fileName: file.name });
    try {
      // Validate type and size from the first bytes before the whole file is read into memory.
      const head = new Uint8Array(await file.slice(0, 4096).arrayBuffer());
      validateUpload(file.name, file.size, head);
      const bytes = await file.arrayBuffer();
      const workbook = await importWorkbook(file.name, bytes);
      setImportState({ status: 'ready', pending: { workbook, bytes, sheet: workbook.sheets[0]?.name ?? '' } });
    } catch (error) {
      const message = error instanceof ImportError || error instanceof Error ? error.message : 'The file could not be read.';
      setImportState({ status: 'error', fileName: file.name, message });
    }
  }, []);

  const chooseImportSheet = useCallback((sheet: string) => {
    setImportState((state) => (state.status === 'ready' ? { status: 'ready', pending: { ...state.pending, sheet } } : state));
  }, []);

  const confirmImport = useCallback(() => {
    if (importState.status !== 'ready') return;
    const { workbook, bytes, sheet } = importState.pending;
    setImportState({ status: 'idle' });
    openSession(workbook, bytes, sheet, { rules: [], selectedRuleId: null });
  }, [importState, openSession]);

  // ---------- selection ----------
  const setActiveSheet = useCallback(
    (sheet: string) => {
      updateSession((s) => (s.activeSheet === sheet ? s : { ...s, activeSheet: sheet, selected: null }));
      setScenarioView(null);
    },
    [updateSession],
  );
  const selectCell = useCallback(
    (ref: CellRefModel | null) => updateSession((s) => ({ ...s, selected: ref, activeSheet: ref ? ref.sheet : s.activeSheet })),
    [updateSession],
  );
  const selectRule = useCallback((ruleId: string | null) => updateSession((s) => ({ ...s, selectedRuleId: ruleId })), [updateSession]);

  // ---------- edits ----------
  const commitEdit = useCallback(
    (sheet: string, address: string, content: string): CellEdit[] | null => {
      const next = updateSession((s) => ({
        ...s,
        edits: upsertEdit(s.original, s.edits, sheet, address, content),
        dirty: true,
      }));
      if (!next) return null;
      setScenarioView(null);
      logActivity({ kind: 'fix', text: `Edited ${sheet}!${address} in the working copy` });
      return next.edits;
    },
    [logActivity, updateSession],
  );

  const resetEdits = useCallback(() => {
    updateSession((s) => (s.edits.length === 0 ? s : { ...s, edits: [], dirty: true }));
    setScenarioView(null);
  }, [updateSession]);

  // ---------- rules ----------
  const addRule = useCallback(
    (rule: Rule) => {
      let created = false;
      updateSession((s) => {
        const exists = s.rules.some((r) => r.id === rule.id);
        created = !exists;
        const results = { ...s.results };
        const previous = { ...s.previous };
        delete results[rule.id];
        delete previous[rule.id];
        return {
          ...s,
          rules: exists ? s.rules.map((r) => (r.id === rule.id ? rule : r)) : [...s.rules, rule],
          selectedRuleId: rule.id,
          results,
          previous,
          dirty: true,
        };
      });
      setScenarioView(null);
      if (created) {
        const next = recordRulesCreated(statsRef.current, 1);
        statsRef.current = next;
        setStats(next);
        logActivity({ kind: 'rule', text: `Created rule “${rule.name}”` });
      }
      return created;
    },
    [logActivity, updateSession],
  );

  const deleteRule = useCallback(
    (ruleId: string) => {
      updateSession((s) => {
        const results = { ...s.results };
        const previous = { ...s.previous };
        delete results[ruleId];
        delete previous[ruleId];
        const rules = s.rules.filter((r) => r.id !== ruleId);
        return { ...s, rules, results, previous, selectedRuleId: s.selectedRuleId === ruleId ? (rules[0]?.id ?? null) : s.selectedRuleId, dirty: true };
      });
      setScenarioView(null);
    },
    [updateSession],
  );

  const setConfig = useCallback(
    (patch: Partial<TestConfig>) => updateSession((s) => ({ ...s, config: { ...s.config, ...patch }, dirty: true })),
    [updateSession],
  );

  // ---------- running ----------
  const runRules = useCallback(
    (ids?: readonly string[]): boolean => {
      const s = sessionRef.current;
      if (!s || runHandle.current) return false;
      const rules = s.rules.filter((r) => !ids || ids.includes(r.id));
      if (rules.length === 0) {
        toast('Add and confirm a rule before running tests.', 'info');
        setRightTab('rules');
        return false;
      }
      const config = TestConfigSchema.safeParse(s.config);
      if (!config.success) {
        toast(config.error.issues[0]?.message ?? 'The test settings are not valid.', 'fail');
        return false;
      }

      setScenarioView(null);
      const startedFrom = rightTabRef.current;
      setRun({ status: 'running', total: rules.length, finished: 0, currentRuleId: null, progress: null, error: null });
      const collected: RuleRunResult[] = [];
      const runEdits = s.edits;
      const workbookName = s.original.name;
      const workbookId = s.original.id;

      const handle = startRun(s.original, runEdits, rules, config.data, {
        onRuleStart: (ruleId) => setRun((r) => ({ ...r, currentRuleId: ruleId, progress: null })),
        onProgress: (_ruleId, executed, requested) => setRun((r) => ({ ...r, progress: { executed, requested } })),
        onResult: (result) => {
          collected.push(result);
          updateSession((cur) => {
            const old = cur.results[result.ruleId];
            const previous = old && old.workingCopy !== result.workingCopy ? { ...cur.previous, [result.ruleId]: old } : cur.previous;
            return { ...cur, results: { ...cur.results, [result.ruleId]: result }, previous };
          });
          setRun((r) => ({ ...r, finished: r.finished + 1, progress: null }));
        },
      });
      runHandle.current = handle;

      void handle.done
        .then((outcome) => {
          runHandle.current = null;
          setRun(IDLE_RUN);
          if (collected.length > 0) {
            const next = recordRun(statsRef.current, workbookId, collected);
            statsRef.current = next;
            setStats(next);
            const failed = collected.filter((r) => r.status === 'failed').length;
            const status = failed > 0 ? 'failed' : collected.every((r) => r.status === 'passed') ? 'passed' : 'inconclusive';
            logActivity({
              kind: 'run',
              status,
              text: `${outcome === 'cancelled' ? 'Cancelled after ' : 'Ran '}${collected.length} of ${rules.length} rule${rules.length === 1 ? '' : 's'} on ${workbookName}${failed > 0 ? ` — ${failed} failed` : ''}`,
            });
            const firstFailed = collected.find((r) => r.status === 'failed');
            // A rule that used to fail and no longer does: show the before/after, not just the totals.
            const verified = collected.find((r) => r.status !== 'failed' && sessionRef.current?.previous[r.ruleId]?.counterexample);
            if (firstFailed) {
              updateSession((cur) => ({ ...cur, selectedRuleId: firstFailed.ruleId }));
              setRightTab('counterexample');
            } else if (verified && startedFrom === 'counterexample') {
              // The rerun came from the Fix and retest panel: stay there and show the before/after.
              updateSession((cur) => ({ ...cur, selectedRuleId: verified.ruleId }));
              setRightTab('counterexample');
            } else {
              setRightTab('results');
            }
          }
          if (outcome === 'cancelled') toast(`Run cancelled. ${collected.length} of ${rules.length} rules had finished.`, 'info');
        })
        .catch((error: unknown) => {
          runHandle.current = null;
          const message = error instanceof Error ? error.message : 'The test worker stopped unexpectedly.';
          setRun({ ...IDLE_RUN, error: message });
          toast(`The run could not finish: ${message}`, 'fail');
        });
      return true;
    },
    [logActivity, toast, updateSession],
  );

  const cancelRun = useCallback(() => runHandle.current?.cancel(), []);

  useEffect(
    () => () => {
      runHandle.current?.cancel();
    },
    [],
  );

  // ---------- save and exports ----------
  const saveSession = useCallback(() => {
    const s = sessionRef.current;
    if (!s) return;
    const payload: SavedWorkspace = { rules: s.rules, config: s.config, edits: s.edits, savedAt: new Date().toISOString() };
    if (writeJson(workspaceKey(s.original.id), payload)) {
      updateSession((cur) => ({ ...cur, dirty: false }));
      toast('Saved. Rules, test settings and your edits are stored in this browser only; workbook contents are not.', 'pass');
    } else {
      toast('Could not save: browser storage is unavailable or full.', 'fail');
    }
  }, [toast, updateSession]);

  const exportReport = useCallback(() => {
    const s = sessionRef.current;
    if (!s) return;
    const results = s.rules.map((r) => s.results[r.id]).filter((r): r is RuleRunResult => Boolean(r));
    if (results.length === 0) {
      toast('Run at least one test first. The report contains test results.', 'info');
      return;
    }
    const report = buildReport({
      workbook: s.original,
      edits: s.edits,
      rules: s.rules.filter((r) => s.results[r.id]),
      results,
      config: s.config,
      appVersion: __APP_VERSION__,
    });
    downloadBlob(reportFileName(s.original.name), JSON.stringify(report, null, 2), 'application/json');
    toast('Exported the JSON report.', 'pass');
  }, [toast]);

  const downloadOriginal = useCallback(async () => {
    const s = sessionRef.current;
    if (!s) return;
    try {
      if (s.originalBytes) {
        const type = s.original.name.toLowerCase().endsWith('.csv') ? 'text/csv' : XLSX_MIME;
        downloadBlob(s.original.name, s.originalBytes, type);
      } else if (s.original.id === SAMPLE_WORKBOOK_ID) {
        const response = await fetch(SAMPLE_URL);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        downloadBlob('freight-quote.xlsx', await response.arrayBuffer(), XLSX_MIME);
      }
      toast('Downloaded the original workbook, unchanged.', 'pass');
    } catch (error) {
      toast(`Could not download the original workbook: ${error instanceof Error ? error.message : 'unknown error'}`, 'fail');
    }
  }, [toast]);

  const downloadWorkingCopy = useCallback(async () => {
    if (!working || !calc?.engine) return;
    const engine = calc.engine;
    try {
      const bytes = await buildXlsx(working.sheets, (sheet, address) => {
        const value = engine.getValue(sheet, address);
        return isCalcError(value) ? undefined : value;
      });
      const base = working.name.replace(/\.[^.]+$/, '');
      downloadBlob(`${base}-working-copy.xlsx`, bytes as BlobPart, XLSX_MIME);
      toast('Downloaded the working copy with your edits. The original file is untouched.', 'pass');
    } catch (error) {
      toast(`Could not build the working copy: ${error instanceof Error ? error.message : 'unknown error'}`, 'fail');
    }
  }, [calc, toast, working]);

  const copyCounterexample = useCallback(
    async (ruleId: string) => {
      const result = sessionRef.current?.results[ruleId];
      if (!result?.counterexample) return;
      const text = counterexampleText(result, result.counterexample);
      try {
        await navigator.clipboard.writeText(text);
        toast('Copied the counterexample to the clipboard.', 'pass');
      } catch {
        // Clipboard access can be denied (insecure context, permissions); fall back to a download.
        downloadBlob(`counterexample-${ruleId}.txt`, text, 'text/plain');
        toast('Clipboard access was blocked, so the counterexample was downloaded as a text file.', 'info');
      }
    },
    [toast],
  );

  // ---------- local data ----------
  const clearLocalData = useCallback(() => {
    const cleared = clearAll();
    removeByPrefix('workspace.');
    statsRef.current = cleared.stats;
    recentRef.current = cleared.recent;
    activityRef.current = cleared.activity;
    setStats(cleared.stats);
    setRecent(cleared.recent);
    setActivity(cleared.activity);
    toast('Cleared statistics, recent workbooks, activity and saved rules from this browser.', 'info');
  }, [toast]);

  const applySampleFix = useCallback((): CellEdit[] | null => {
    const s = sessionRef.current;
    if (!s || s.original.id !== SAMPLE_WORKBOOK_ID) return null;
    return commitEdit(SAMPLE_SHEET, SAMPLE_FAULTY_CELL, SAMPLE_FIXED_FORMULA);
  }, [commitEdit]);

  return {
    theme,
    toggleTheme,
    view,
    goDashboard,
    goImport,
    goWorkspace,
    session,
    working,
    fingerprint,
    calc,
    diagnostics,
    importState,
    importFile,
    chooseImportSheet,
    confirmImport,
    cancelImport: goImport,
    openSample,
    rightTab,
    setRightTab,
    scenarioView,
    setScenarioView,
    mobilePane,
    setMobilePane,
    run,
    runRules,
    cancelRun,
    setActiveSheet,
    selectCell,
    selectRule,
    commitEdit,
    resetEdits,
    addRule,
    deleteRule,
    setConfig,
    saveSession,
    exportReport,
    downloadOriginal,
    downloadWorkingCopy,
    copyCounterexample,
    applySampleFix,
    stats,
    recent,
    activity,
    clearLocalData,
    toasts,
    toast,
    dismissToast,
  };
}

export type AppState = ReturnType<typeof useAppState>;
