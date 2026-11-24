// "Time to cutoff" is computed from the server clock, never the browser clock (ASSIGNMENT).
// The offset is estimated with the round-trip midpoint, so a wrong local clock or a slow network
// does not move the countdown.
export type TimeSample = {
  readonly serverNowMs: number;
  readonly sentAtMs: number;
  readonly receivedAtMs: number;
};

/** serverNow - localNow, taken at the midpoint of the request. */
export const clockOffset = (s: TimeSample): number =>
  s.serverNowMs - (s.sentAtMs + (s.receivedAtMs - s.sentAtMs) / 2);

export const serverNow = (localNowMs: number, offsetMs: number): number => localNowMs + offsetMs;

export const msUntil = (targetMs: number, localNowMs: number, offsetMs: number): number =>
  targetMs - serverNow(localNowMs, offsetMs);

/** "1:05:09", "12:09", or "late 0:12" once the cutoff has passed. */
export const formatCountdown = (ms: number): string => {
  const late = ms < 0;
  const total = Math.floor(Math.abs(ms) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const body =
    h > 0
      ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
      : `${m}:${String(s).padStart(2, '0')}`;
  return late ? `late ${body}` : body;
};
