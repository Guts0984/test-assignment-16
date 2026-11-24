import { describe, expect, it } from 'vitest';
import {
  defaultReportParams,
  listParamsToSearch,
  parseListParams,
  parseReportParams,
  reportParamsToSearch,
} from './url-state';

const today = '2026-11-24';
const wid = '00000000-0000-4000-8000-000000000001';

describe('report URL state', () => {
  it('round-trips period and filters', () => {
    const p = { from: '2026-09-01', to: '2026-11-24', warehouseId: wid };
    expect(parseReportParams(new URLSearchParams(reportParamsToSearch(p)), today)).toEqual(p);
  });
  it('falls back to the last 30 days for missing, malformed or inverted input', () => {
    const d = defaultReportParams(today);
    expect(d).toEqual({ from: '2026-10-26', to: '2026-11-24' });
    for (const q of [
      '',
      'from=nope&to=2026-01-01',
      'from=2026-12-01&to=2026-01-01',
      `from=2026-01-01&to=2026-02-01&warehouseId=not-a-uuid`,
    ]) {
      expect(parseReportParams(new URLSearchParams(q), today)).toEqual(d);
    }
  });
});

describe('list URL state', () => {
  it('drops empty values and bounds the query length', () => {
    expect(listParamsToSearch({ q: 'abc', status: '', cursor: '' })).toBe('q=abc');
    expect(parseListParams(new URLSearchParams(`q=${'x'.repeat(500)}`)).q).toHaveLength(100);
    expect(parseListParams(new URLSearchParams('status=picked&cursor=zz'))).toEqual({
      q: '',
      status: 'picked',
      cursor: 'zz',
    });
  });
});
