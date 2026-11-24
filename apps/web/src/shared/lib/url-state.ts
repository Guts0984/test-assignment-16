// Page state that must survive reload and "Back" lives in the URL (ASSIGNMENT): report period and
// filters, search, pagination. Pure codecs over URLSearchParams.
import { z } from 'zod';

export const reportParamsSchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  warehouseId: z.string().uuid().optional(),
  staffId: z.string().uuid().optional(),
});
export type ReportParams = z.infer<typeof reportParamsSchema>;

const isoDay = (d: Date): string => d.toISOString().slice(0, 10);

/** The default period is the last 30 days ending on the (server) date. */
export const defaultReportParams = (todayIso: string): ReportParams => ({
  from: isoDay(new Date(Date.parse(`${todayIso}T00:00:00Z`) - 29 * 86_400_000)),
  to: todayIso,
});

export const parseReportParams = (sp: URLSearchParams, todayIso: string): ReportParams => {
  const raw = {
    from: sp.get('from') ?? undefined,
    to: sp.get('to') ?? undefined,
    warehouseId: sp.get('warehouseId') ?? undefined,
    staffId: sp.get('staffId') ?? undefined,
  };
  const parsed = reportParamsSchema.safeParse(raw);
  return parsed.success && parsed.data.from <= parsed.data.to ? parsed.data : defaultReportParams(todayIso);
};

export const reportParamsToSearch = (p: ReportParams): string => {
  const sp = new URLSearchParams({ from: p.from, to: p.to });
  if (p.warehouseId !== undefined) sp.set('warehouseId', p.warehouseId);
  if (p.staffId !== undefined) sp.set('staffId', p.staffId);
  return sp.toString();
};

export type ListParams = { readonly q: string; readonly status: string; readonly cursor: string };

export const parseListParams = (sp: URLSearchParams): ListParams => ({
  q: (sp.get('q') ?? '').slice(0, 100),
  status: sp.get('status') ?? '',
  cursor: sp.get('cursor') ?? '',
});

/** Empty values are dropped so the URL stays short; the cursor resets when the filters change. */
export const listParamsToSearch = (p: Partial<ListParams>): string => {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) if (typeof v === 'string' && v !== '') sp.set(k, v);
  return sp.toString();
};
