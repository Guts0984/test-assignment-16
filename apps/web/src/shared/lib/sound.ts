// Sound on a bad scan (ASSIGNMENT): a short low beep from the Web Audio API, no asset needed.
type Ctx = {
  createOscillator: () => {
    frequency: { value: number };
    type: string;
    connect: (n: unknown) => void;
    start: () => void;
    stop: (t: number) => void;
  };
  createGain: () => { gain: { value: number }; connect: (n: unknown) => void };
  destination: unknown;
  currentTime: number;
};

const state: { ctx: Ctx | null } = { ctx: null };

export const playBeep = (kind: 'error' | 'ok'): void => {
  try {
    const W = window as unknown as {
      AudioContext?: new () => Ctx;
      webkitAudioContext?: new () => Ctx;
      __beeps?: string[];
    };
    (W.__beeps ??= []).push(kind);
    const C = W.AudioContext ?? W.webkitAudioContext;
    if (C === undefined) return;
    state.ctx ??= new C();
    const o = state.ctx.createOscillator();
    const g = state.ctx.createGain();
    o.type = kind === 'error' ? 'square' : 'sine';
    o.frequency.value = kind === 'error' ? 180 : 880;
    g.gain.value = 0.15;
    o.connect(g);
    g.connect(state.ctx.destination);
    o.start();
    o.stop(state.ctx.currentTime + (kind === 'error' ? 0.35 : 0.08));
  } catch {
    // audio may be blocked until the first user gesture; the visible message still shows
  }
};
