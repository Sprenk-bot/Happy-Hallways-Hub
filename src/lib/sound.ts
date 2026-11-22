import type { HubKioskChime } from './types';

/**
 * Short tones made in the browser, so there are no sound files to load: a
 * rising two-note "your turn" for the kiosk, and a soft falling chime for the
 * teacher when a pass becomes Overdue. Browsers only play sound after someone
 * has tapped or clicked the page, which the kiosk and the teacher's pages
 * both have by the time a sound matters.
 */
let context: AudioContext | null = null;

export const hubChimeOptions: readonly { value: HubKioskChime; label: string }[] = [
  { value: 'soft', label: 'Soft two-note' },
  { value: 'warm', label: 'Warm two-note' },
  { value: 'bright', label: 'Bright two-note' },
  { value: 'none', label: 'No chime' },
];

function play(
  notes: { frequency: number; at: number; length: number }[],
  volume = 100,
) {
  const amplitude = Math.max(0, Math.min(100, volume)) / 100;
  if (!amplitude) return;
  try {
    context ??= new AudioContext();
    if (context.state === 'suspended') void context.resume();
    const start = context.currentTime;
    for (const note of notes) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.value = note.frequency;
      gain.gain.setValueAtTime(0.0001, start + note.at);
      gain.gain.exponentialRampToValueAtTime(0.25 * amplitude, start + note.at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + note.at + note.length);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(start + note.at);
      oscillator.stop(start + note.at + note.length + 0.05);
    }
  } catch {
    // No sound available: nothing else depends on it.
  }
}

const hubChimeNotes: Record<Exclude<HubKioskChime, 'none'>, { frequency: number; at: number; length: number }[]> = {
  soft: [
    { frequency: 523, at: 0, length: 0.2 },
    { frequency: 659, at: 0.18, length: 0.28 },
  ],
  warm: [
    { frequency: 587, at: 0, length: 0.22 },
    { frequency: 698, at: 0.18, length: 0.3 },
  ],
  bright: [
    { frequency: 659, at: 0, length: 0.18 },
    { frequency: 784, at: 0.16, length: 0.28 },
  ],
};

/** A Hub movement chime; volume is a percentage from 0 to 100. */
export function playHubChime(chime: HubKioskChime, volume: number) {
  if (chime !== 'none') play(hubChimeNotes[chime], volume);
}

/** A separate gentle alert used only on the Hub kiosk for new classroom notifications. */
export function playHubNotificationChime(volume: number) {
  play(
    [
      { frequency: 784, at: 0, length: 0.13 },
      { frequency: 587, at: 0.2, length: 0.22 },
    ],
    volume,
  );
}

/** Opens/resumes audio from a kiosk tap without producing sound before Host acknowledgement. */
export function prepareHubAudio() {
  try {
    context ??= new AudioContext();
    if (context.state === 'suspended') void context.resume();
  } catch {
    // Audio is optional; movement recording must continue if the browser blocks it.
  }
}

/** The kiosk's "your turn": a student in line may go now. */
export function yourTurnSound() {
  play([
    { frequency: 660, at: 0, length: 0.18 },
    { frequency: 880, at: 0.16, length: 0.3 },
  ]);
}

/** The teacher's chime when a pass becomes Overdue. Only if they turned it on. */
export function overdueChime() {
  play([
    { frequency: 784, at: 0, length: 0.35 },
    { frequency: 587, at: 0.22, length: 0.5 },
  ]);
}
