import { describe, expect, it } from 'vitest';
import { detectPitch, noteFromFrequency, SingingHarmonizer } from '@/audio/harmonizer';

function sine(frequency: number, sampleRate = 48_000, length = 4096): Float32Array {
  return Float32Array.from({ length }, (_, i) => Math.sin((2 * Math.PI * frequency * i) / sampleRate) * 0.5);
}

function sing(harmonizer: SingingHarmonizer, frequencies: number[]): void {
  let t = 0;
  for (const frequency of frequencies) {
    // Two frames establish the note; extra frames represent its duration.
    for (let frame = 0; frame < 5; frame++) {
      harmonizer.observe({ frequency, clarity: 0.95, rms: 0.3 }, (t += 50));
    }
  }
}

function singFrom(harmonizer: SingingHarmonizer, frequencies: number[], start = 0): number {
  let t = start;
  for (const frequency of frequencies) {
    for (let frame = 0; frame < 3; frame++) {
      harmonizer.observe({ frequency, clarity: 0.95, rms: 0.3 }, (t += 50));
    }
  }
  return t;
}

describe('microphone pitch analysis', () => {
  it('finds a sung sine pitch and rejects silence', () => {
    const estimate = detectPitch(sine(440), 48_000);
    expect(estimate?.frequency).toBeCloseTo(440, 0);
    expect(estimate?.clarity).toBeGreaterThan(0.9);
    expect(detectPitch(new Float32Array(4096), 48_000)).toBeNull();
  });

  it('turns frequency into a concert-pitch note name', () => {
    expect(noteFromFrequency(440)).toEqual({ midi: 69, pitchClass: 9, name: 'A4' });
    expect(noteFromFrequency(261.63)?.name).toBe('C4');
  });
});

describe('singing harmonizer', () => {
  it('chooses the C chord for a C major triad', () => {
    const harmonizer = new SingingHarmonizer();
    harmonizer.setKeyOverride('C');
    harmonizer.setActive(true);
    sing(harmonizer, [261.63, 329.63, 392]);
    expect(harmonizer.chooseChord()).toBe('C');
    expect(harmonizer.snapshot()).toMatchObject({ key: 'C', keyOverride: 'C', chord: 'C' });
  });

  it('chooses A minor for A-C-E and holds it through an empty bar', () => {
    const harmonizer = new SingingHarmonizer();
    harmonizer.setKeyOverride('C');
    harmonizer.setActive(true);
    sing(harmonizer, [220, 261.63, 329.63]);
    expect(harmonizer.chooseChord()).toBe('Am');
    expect(harmonizer.chooseChord()).toBe('Am');
  });

  it('holds the last detected note briefly through consonants, then clears it', () => {
    const harmonizer = new SingingHarmonizer();
    harmonizer.setActive(true);
    harmonizer.observe({ frequency: 440, clarity: 0.95, rms: 0.3 }, 100);
    harmonizer.observeSilence(300);
    expect(harmonizer.snapshot().detectedNote).toBe('A4');
    harmonizer.observeSilence(500);
    expect(harmonizer.snapshot().detectedNote).toBeNull();
  });

  it('records stabilized note onsets without filling the key window with held frames', () => {
    const harmonizer = new SingingHarmonizer();
    harmonizer.setActive(true);
    let t = singFrom(harmonizer, [440]);
    t = singFrom(harmonizer, [440], t);
    expect(harmonizer.snapshot().recentNotes.map((note) => note.name)).toEqual(['A4']);

    t = singFrom(harmonizer, [493.88], t);
    expect(harmonizer.snapshot().recentNotes.map((note) => note.name)).toEqual(['A4', 'B4']);

    harmonizer.observeSilence(t + 300);
    singFrom(harmonizer, [493.88], t + 300);
    expect(harmonizer.snapshot().recentNotes.map((note) => note.name)).toEqual(['A4', 'B4', 'B4']);
  });

  it('uses and exposes exactly the latest 12 stabilized notes for automatic key detection', () => {
    const harmonizer = new SingingHarmonizer();
    harmonizer.setActive(true);
    const frequencies = [261.63, 293.66, 329.63, 349.23, 392, 440, 493.88, 523.25, 587.33, 659.25, 698.46, 783.99, 880];
    singFrom(harmonizer, frequencies);
    const snapshot = harmonizer.snapshot();
    expect(snapshot.keyWindowSize).toBe(12);
    expect(snapshot.recentNotes).toHaveLength(12);
    expect(snapshot.recentNotes[0].name).toBe('D4');
    expect(snapshot.recentNotes.at(-1)?.name).toBe('A5');
    expect(snapshot.keyReady).toBe(true);
    expect(snapshot.keyConfidence).toBeGreaterThan(0);
  });

  it('detects C major from the same note window shown to the user', () => {
    const harmonizer = new SingingHarmonizer();
    harmonizer.setActive(true);
    singFrom(harmonizer, [261.63, 329.63, 392, 293.66, 349.23, 440, 261.63, 329.63]);
    expect(harmonizer.snapshot()).toMatchObject({ key: 'C', keyReady: true, keyOverride: null });
  });

  it('reports a manual key as locked while continuing to collect visible notes', () => {
    const harmonizer = new SingingHarmonizer();
    harmonizer.setKeyOverride('F#');
    harmonizer.setActive(true);
    singFrom(harmonizer, [369.99, 466.16]);
    expect(harmonizer.snapshot()).toMatchObject({ key: 'F#', keyConfidence: 1, keyReady: true, keyOverride: 'F#' });
    expect(harmonizer.snapshot().recentNotes).toHaveLength(2);
  });

  it('resets note and chord histories between sing-freely sessions', () => {
    const harmonizer = new SingingHarmonizer();
    harmonizer.setActive(true);
    singFrom(harmonizer, [261.63, 329.63, 392]);
    for (let bar = 0; bar < 5; bar++) harmonizer.chooseChord();
    expect(harmonizer.snapshot().recentChords).toHaveLength(4);

    harmonizer.setActive(false);
    expect(harmonizer.snapshot()).toMatchObject({ recentNotes: [], recentChords: [], keyReady: false });
    harmonizer.setActive(true);
    expect(harmonizer.snapshot()).toMatchObject({ recentNotes: [], recentChords: [] });
  });
});
