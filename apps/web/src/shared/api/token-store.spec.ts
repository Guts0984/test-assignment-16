import { describe, expect, it } from 'vitest';
import { refreshOnce } from './token-store';

describe('refreshOnce', () => {
  it('callers that need a refresh at the same time share one request (a rotating token is used once)', async () => {
    const calls = { n: 0 };
    const refresh = async () => {
      calls.n += 1;
      await new Promise((r) => setTimeout(r, 20));
      return { accessToken: `t${calls.n}` };
    };
    const results = await Promise.all([refreshOnce(refresh), refreshOnce(refresh), refreshOnce(refresh)]);
    expect(calls.n).toBe(1);
    expect(results.map((r) => r?.accessToken)).toEqual(['t1', 't1', 't1']);
    await refreshOnce(refresh);
    expect(calls.n).toBe(2);
  });
  it('a failed refresh does not wedge later attempts', async () => {
    expect(await refreshOnce(async () => null)).toBeNull();
    expect(await refreshOnce(async () => ({ ok: true }))).toEqual({ ok: true });
  });
});
