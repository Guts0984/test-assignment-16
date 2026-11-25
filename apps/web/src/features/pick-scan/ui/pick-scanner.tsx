'use client';

import { useEffect, useRef, useState } from 'react';
import { type ApiError, isApiError } from '@/shared/api/mutator';
import {
  pickingControllerTask,
  usePickingControllerNext,
  usePickingControllerScan,
  usePickingControllerScanCell,
  usePickingControllerShortage,
} from '@/shared/api/generated/picking/picking';
import type { TaskDto } from '@/shared/api/generated/model';
import { newIdempotencyKey, nextLine, normalizeScan, stepFor } from '@/shared/lib/scan';
import { playBeep } from '@/shared/lib/sound';
import { Banner, Button, Card, Field, Spinner, TextInput } from '@/shared/ui';
import { afterCellOk, afterError, afterItemOk, initialScanUi, type ScanUi } from '../model/scan-session';

const errOf = (e: unknown): { code: string; message: string } =>
  isApiError(e)
    ? { code: (e as ApiError).body.code, message: (e as ApiError).body.message }
    : { code: 'NETWORK', message: 'No connection. Scan again.' };

/**
 * Picker screen: keyboard only. The scan field is focused all the time (and gets focus back after
 * every action), Enter submits, a bad scan beeps and shows a clear message. Each scan carries its
 * own idempotency key, so a resend after a dropped connection counts once.
 */
export const PickScanner = ({ warehouseId }: { warehouseId: string }) => {
  const next = usePickingControllerNext();
  const scanCell = usePickingControllerScanCell();
  const scan = usePickingControllerScan();
  const shortage = usePickingControllerShortage();
  const [task, setTaskState] = useState<TaskDto | null>(null);
  const [ui, setUiState] = useState<ScanUi>(initialScanUi);
  // Scans are processed one at a time against the LATEST task and step (refs, updated synchronously):
  // an item scanned before the answer to the cell scan arrived must not be read as another cell scan.
  const taskRef = useRef<TaskDto | null>(null);
  const uiRef = useRef<ScanUi>(initialScanUi);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const setTask = (t: TaskDto | null) => {
    taskRef.current = t;
    setTaskState(t);
  };
  const setUi = (next: ScanUi | ((u: ScanUi) => ScanUi)) => {
    uiRef.current = typeof next === 'function' ? next(uiRef.current) : next;
    setUiState(uiRef.current);
  };
  const [batch, setBatch] = useState('');
  const [empty, setEmpty] = useState(false);
  const [short, setShort] = useState<{ found: string } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  // The idempotency key of a scan whose outcome is unknown (dropped connection). A resend of the same
  // scan reuses it, so the server counts it once.
  const pending = useRef<{ fingerprint: string; key: string } | null>(null);
  const refocus = () => requestAnimationFrame(() => input.current?.focus());

  // Focus recovery: any click elsewhere or window focus returns the cursor to the scan field.
  useEffect(() => {
    const back = () => refocus();
    // Clicks on other form controls keep their focus (shortage form, batch field).
    const onClick = (e: MouseEvent) => {
      const t = e.target;
      if (t instanceof HTMLElement && t.closest('input, select, textarea, label') !== null) return;
      refocus();
    };
    window.addEventListener('focus', back);
    document.addEventListener('click', onClick);
    return () => {
      window.removeEventListener('focus', back);
      document.removeEventListener('click', onClick);
    };
  }, []);

  const takeTask = async () => {
    setEmpty(false);
    try {
      const t = await next.mutateAsync({ warehouseId });
      setTask(t);
      setUi(initialScanUi);
    } catch (e) {
      const { code, message } = errOf(e);
      if (code === 'NO_TASK_AVAILABLE') setEmpty(true);
      else setUi({ scannedCell: null, message: { kind: 'error', text: message } });
    }
    refocus();
  };

  useEffect(() => {
    void takeTask();
    // once on open: continue the current task or take the next one
  }, [warehouseId]);

  const lines = task?.lines ?? [];
  const line = nextLine(lines);
  const step = stepFor(lines, ui.scannedCell);

  const fail = (code: string, message: string) => {
    playBeep('error');
    setUi((u) => afterError(u, code, message));
  };

  const submit = async (raw: string) => {
    const value = normalizeScan(raw);
    const task = taskRef.current;
    const current = task?.lines ?? [];
    const line = nextLine(current);
    const step = stepFor(current, uiRef.current.scannedCell);
    if (value === '' || task === null || line === undefined) return;
    if (step === 'cell') {
      try {
        await scanCell.mutateAsync({ warehouseId, id: task.id, data: { cellCode: value } });
        setUi((u) => afterCellOk(u, value));
      } catch (e) {
        const { code, message } = errOf(e);
        fail(code, message);
      }
      return;
    }
    const fingerprint = [task.id, line.lineId, line.cellCode, value, batch].join('|');
    const key = pending.current?.fingerprint === fingerprint ? pending.current.key : newIdempotencyKey();
    pending.current = { fingerprint, key };
    try {
      const r = await scan.mutateAsync({
        warehouseId,
        id: task.id,
        data: {
          lineId: line.lineId,
          cellCode: line.cellCode,
          barcode: value,
          ...(line.tracksExpiry && batch !== '' ? { batchCode: batch } : {}),
          qty: 1,
          idempotencyKey: key,
        },
      });
      pending.current = null;
      playBeep('ok');
      if (r.taskDone) {
        const finished = task.lines.map((l) =>
          l.lineId === r.lineId ? { ...l, pickedQty: r.pickedQty, status: 'done' } : l,
        );
        setTask({ ...task, lines: finished });
        setUi((u) => afterItemOk(u, finished));
      } else {
        // Re-read the current task (never "take next": that would assign another task).
        const fresh = await pickingControllerTask(warehouseId, task.id).catch(() => task);
        setTask(fresh);
        setUi((u) => afterItemOk(u, fresh.lines));
      }
    } catch (e) {
      const { code, message } = errOf(e);
      if (code !== 'NETWORK') pending.current = null;
      fail(code, message);
    }
  };

  const reportShortage = async () => {
    if (task === null || line === undefined || short === null) return;
    const fingerprint = `${task.id}|${line.lineId}|${short.found}`;
    const key = pending.current?.fingerprint === fingerprint ? pending.current.key : newIdempotencyKey();
    pending.current = { fingerprint, key };
    try {
      const t = await shortage.mutateAsync({
        warehouseId,
        id: task.id,
        data: {
          lineId: line.lineId,
          foundQty: Number(short.found || 0),
          idempotencyKey: key,
        },
      });
      pending.current = null;
      setTask(t);
      setShort(null);
      setUi({
        scannedCell: null,
        message: { kind: 'info', text: 'Shortage recorded. The cell is closed for a count.' },
      });
    } catch (e) {
      const { code, message } = errOf(e);
      if (code !== 'NETWORK') pending.current = null;
      fail(code, message);
    }
    refocus();
  };

  if (next.isPending && task === null) return <Spinner />;
  if (task === null) {
    return (
      <Card title="Pick">
        <p className="mb-3 text-sm">{empty ? 'No pick task is waiting.' : 'Could not load a task.'}</p>
        <Button onClick={() => void takeTask()}>Check again</Button>
      </Card>
    );
  }
  const done = line === undefined;
  return (
    <div className="flex flex-col gap-4">
      <Card title={`Order ${task.orderNumber}`}>
        {done ? (
          <p className="text-lg font-semibold">Task complete. Hand over to packing.</p>
        ) : (
          <p className="text-3xl font-bold" aria-live="polite" data-testid="instruction">
            {step === 'cell'
              ? `Go to cell ${line.cellCode}`
              : `Scan ${line.skuName} (${line.pickedQty}/${line.qty})${line.tracksExpiry ? ` batch ${line.batchCode}` : ''}`}
          </p>
        )}
      </Card>
      {ui.message !== null && <Banner kind={ui.message.kind}>{ui.message.text}</Banner>}
      {!done && (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            const el = input.current;
            if (el === null) return;
            const v = el.value;
            el.value = '';
            // queued: the next scan starts only after the previous one was answered and applied
            queue.current = queue.current.then(() => submit(v)).finally(refocus);
          }}
        >
          <Field label={step === 'cell' ? 'Scan cell' : 'Scan item'}>
            {(f) => (
              <TextInput
                id={f.id}
                ref={input}
                autoFocus
                autoComplete="off"
                inputMode="none"
                data-testid="scan-input"
                className="text-xl"
              />
            )}
          </Field>
          {step === 'item' && line.tracksExpiry && (
            <Field label="Batch (scan or type)">
              {(f) => (
                <TextInput
                  id={f.id}
                  value={batch}
                  onChange={(e) => setBatch(e.target.value)}
                  autoComplete="off"
                />
              )}
            </Field>
          )}
          <button type="submit" className="sr-only">
            Submit scan
          </button>
        </form>
      )}
      <ol className="flex flex-col gap-1 text-sm" aria-label="Route">
        {lines.map((l) => (
          <li key={l.lineId} className={l.lineId === line?.lineId ? 'font-semibold' : 'text-[var(--muted)]'}>
            {l.cellCode} - {l.skuName} - {l.pickedQty}/{l.qty}{' '}
            {l.status === 'short' ? '(short)' : l.status === 'done' ? '(done)' : ''}
          </li>
        ))}
      </ol>
      {done ? (
        <Button onClick={() => void takeTask()}>Next task</Button>
      ) : short === null ? (
        <Button variant="secondary" onClick={() => setShort({ found: '0' })}>
          Not enough in the cell
        </Button>
      ) : (
        <Card title="Report a shortage">
          <Field label="Units found in the cell">
            {(f) => (
              <TextInput
                id={f.id}
                type="number"
                min={0}
                value={short.found}
                onChange={(e) => setShort({ found: e.target.value })}
              />
            )}
          </Field>
          <div className="mt-3 flex gap-2">
            <Button variant="danger" onClick={() => void reportShortage()}>
              Confirm shortage
            </Button>
            <Button variant="secondary" onClick={() => setShort(null)}>
              Cancel
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
};
