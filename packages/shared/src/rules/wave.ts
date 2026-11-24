// Wave triggers (ASSIGNMENT "Wave": every 15 minutes, or at once when 50 orders are ready).
export type WaveTriggerInput = {
  readonly now: Date;
  /** End of the previous wave slot: the time the last wave was formed or the timer was reset. */
  readonly lastWaveAt: Date;
  readonly intervalMin: number;
  readonly readyCount: number;
  readonly readyThreshold: number;
};

export type WaveTrigger = 'threshold' | 'timer' | null;

export const nextWaveDueAt = (lastWaveAt: Date, intervalMin: number): Date =>
  new Date(lastWaveAt.getTime() + intervalMin * 60_000);

/**
 * The threshold fires at `readyCount >= readyThreshold`; the timer fires at `now >= due`.
 * The timer never forms an empty wave.
 */
export const waveTrigger = (i: WaveTriggerInput): WaveTrigger => {
  if (i.readyCount <= 0) return null;
  if (i.readyCount >= i.readyThreshold) return 'threshold';
  return i.now.getTime() >= nextWaveDueAt(i.lastWaveAt, i.intervalMin).getTime() ? 'timer' : null;
};
