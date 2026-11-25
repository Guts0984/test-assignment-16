'use client';

import { useEffect, useRef, useState } from 'react';
import { useOutboundControllerPack } from '@/shared/api/generated/packing/packing';
import { codeOf, messageOf } from '@/shared/lib/form-errors';
import { newIdempotencyKey, normalizeScan } from '@/shared/lib/scan';
import { playBeep } from '@/shared/lib/sound';
import { getAccessToken } from '@/shared/api/token-store';
import { publicEnv } from '@/shared/config/env';
import { Banner, Button, Card, Field, TextInput } from '@/shared/ui';

const MESSAGES: Record<string, string> = {
  ORDER_CANCELLED: 'This order was cancelled. Take the goods to the return cell.',
  NOT_FOUND: 'No such order at this warehouse.',
};

/** Packer: scan the order, the system packs it and prints the label (PDF). Keyboard only. */
/** The label needs the bearer token, which a plain link cannot send: fetch it and open it as a blob. */
const openLabel = async (url: string): Promise<void> => {
  const token = getAccessToken();
  const res = await fetch(`${publicEnv.NEXT_PUBLIC_API_BASE_URL}${url.replace(/^\/api/, '')}`, {
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
    credentials: 'include',
  });
  if (!res.ok) throw new Error('label not available');
  window.open(URL.createObjectURL(await res.blob()), '_blank');
};

export const PackForm = ({ warehouseId }: { warehouseId: string }) => {
  const pack = useOutboundControllerPack();
  const input = useRef<HTMLInputElement>(null);
  const [result, setResult] = useState<{ orderNumber: string; shipDay: string; labelUrl: string } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  useEffect(() => input.current?.focus(), [result, error]);
  return (
    <div className="flex flex-col gap-4">
      <Card title="Pack an order">
        <form
          className="flex flex-col gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            const el = input.current;
            const ref = normalizeScan(el?.value ?? '');
            if (el === null || ref === '') return;
            el.value = '';
            setError(null);
            try {
              const r = await pack.mutateAsync({
                warehouseId,
                data: { orderRef: ref, idempotencyKey: newIdempotencyKey() },
              });
              playBeep('ok');
              setResult(r);
            } catch (err) {
              playBeep('error');
              setResult(null);
              setError(MESSAGES[codeOf(err)] ?? messageOf(err));
            }
          }}
        >
          <Field label="Scan the order number">
            {(f) => (
              <TextInput
                id={f.id}
                ref={input}
                autoFocus
                autoComplete="off"
                data-testid="pack-input"
                className="text-xl"
              />
            )}
          </Field>
          <button type="submit" className="sr-only">
            Pack
          </button>
        </form>
      </Card>
      {error !== null && <Banner kind="error">{error}</Banner>}
      {result !== null && (
        <Card title={`Packed ${result.orderNumber}`}>
          <p className="mb-3 text-sm">Ships on {result.shipDay}.</p>
          <Button
            onClick={() =>
              void openLabel(result.labelUrl).catch(() => setError('Could not open the label. Try again.'))
            }
          >
            Open the label (PDF)
          </Button>
        </Card>
      )}
    </div>
  );
};
