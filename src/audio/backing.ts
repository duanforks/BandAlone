import * as Tone from 'tone';
import type { Config } from '@/app/config';
import type { InstrumentId, Voice } from '@/core/types';
import { chordTones, midiToNote } from '@/song/chords';
import type { ClockStep } from './songClock';
import { DrumsVoice } from './voices/drumsVoice';

/**
 * Generated backing band: a synth bass on roots and fifths, a pad holding the
 * bar's triad and a drum groove, all derived from the chart, so one player
 * sounds like a band. It is driven by `SongClock.onStep` (sample-accurate, one
 * eighth at a time) and leaves out the part a human is playing.
 *
 * `planStep` is the whole arrangement and is pure; the class only owns the
 * Tone nodes.
 */

export type BackingPart = 'bass' | 'pad' | 'drums';
export type BackingConfig = Config['backing'];
export type BassLine = BackingConfig['bassLine'];

/** The backing part a player on this instrument replaces. */
const PART_OF: Partial<Record<InstrumentId, BackingPart>> = { drums: 'drums', bass: 'bass', guitar: 'pad' };

export function partPlayedBy(instrument: InstrumentId): BackingPart | null {
  return PART_OF[instrument] ?? null;
}

export interface BackingNote {
  part: BackingPart;
  /** Pitched parts: note names. */
  notes?: string[];
  /** Drums: the sample to play. */
  sample?: string;
  /** Length in eighth notes (pitched parts). */
  steps?: number;
  velocity: number;
}

/**
 * Lowest bass root (E2, a bass guitar's E string an octave up). Laptop speakers
 * give nothing below about 150 Hz, so the bass is heard through its harmonics:
 * the register is kept this high and the filter this open on purpose.
 */
export const BASS_LOWEST = 40;
/** Lowest pad root (E3): the charts' G C D Em land between E3 and A4. */
export const PAD_LOWEST = 52;
/** A crash marks the top of every this many bars (the charts are 8 bars long). */
const CRASH_EVERY_BARS = 8;

type StepInput = Pick<ClockStep, 'bar' | 'beat' | 'sub' | 'countIn' | 'beatsPerBar' | 'chord'>;

/**
 * Everything the band plays on one eighth-note step. Nothing during the
 * count-in. `padSounding` = the pad already holds this bar's chord; when it
 * does not (after a pause, or the pad was just un-muted) the pad comes back on
 * the next beat instead of waiting for the next bar.
 */
export function planStep(step: StepInput, padSounding: boolean, bassLine: BassLine = 'root'): BackingNote[] {
  if (step.countIn) return [];
  const { bar, beat, sub, beatsPerBar } = step;
  const out: BackingNote[] = [];

  // Drums: kick on 1 and 3, snare on 2 and 4, hats on every eighth.
  if (sub === 0) {
    if (beat === 0 && bar % CRASH_EVERY_BARS === 0) out.push({ part: 'drums', sample: 'crash', velocity: 0.45 });
    out.push(beat % 2 === 0 ? { part: 'drums', sample: 'kick', velocity: beat === 0 ? 0.9 : 0.8 } : { part: 'drums', sample: 'snare', velocity: 0.75 });
  }
  out.push({ part: 'drums', sample: 'hihat', velocity: sub === 0 ? 0.5 : 0.32 });

  const bass = chordTones(step.chord, BASS_LOWEST);
  if (bass) {
    const root = midiToNote(bass.root);
    if (bassLine === 'root') {
      // One note a bar, half a bar long. The root lands with the chord change and then gets
      // out of the way: the guitarist, not the synth, is the one filling the bar.
      if (sub === 0 && beat === 0) out.push({ part: 'bass', notes: [root], steps: beatsPerBar, velocity: 0.85 });
    } else {
      // The fifth goes under a high root (C3 -> G2) so the line stays inside one octave.
      const fifth = midiToNote(bass.root >= BASS_LOWEST + 5 ? bass.root - 5 : bass.fifth);
      // Root on 1 (held), a root pickup on the "and" of 2, the fifth on 3, the root again on every later beat.
      if (sub === 0 && beat === 0) out.push({ part: 'bass', notes: [root], steps: 3, velocity: 0.9 });
      else if (sub === 1 && beat === 1) out.push({ part: 'bass', notes: [root], steps: 1, velocity: 0.7 });
      else if (sub === 0 && beat === 2) out.push({ part: 'bass', notes: [fifth], steps: 2, velocity: 0.8 });
      else if (sub === 0 && beat > 2) out.push({ part: 'bass', notes: [root], steps: 2, velocity: 0.75 });
    }
  }

  const pad = chordTones(step.chord, PAD_LOWEST);
  if (pad && sub === 0 && (beat === 0 || !padSounding)) {
    const notes = [pad.root, pad.third, pad.fifth].map(midiToNote);
    out.push({ part: 'pad', notes, steps: (beatsPerBar - beat) * 2, velocity: 0.7 });
  }
  return out;
}

/** Notes end this far short of their written length so a bar's pad is released before the next one attacks. */
const GATE = 0.92;

export class BackingBand {
  private out: Tone.Volume | null = null;
  private bass: Tone.MonoSynth | null = null;
  private pad: Tone.PolySynth | null = null;
  private padFilter: Tone.Filter | null = null;
  private drumsOut: Tone.Volume | null = null;
  private drums: DrumsVoice | null = null;
  private padSounding = false;

  constructor(
    private readonly cfg: () => BackingConfig,
    private readonly output: () => Tone.ToneAudioNode,
  ) {}

  /** true once the synths exist (the drum samples may still be loading; the rest plays without them). */
  get ready(): boolean {
    return this.out !== null;
  }

  /** The band's kit, so the song clock's auto kick has something to play when nobody is drumming. */
  get drumVoice(): Voice | null {
    return this.drums;
  }

  /** Set the generated band's master level in dB, immediately if it is loaded. */
  setVolume(volume: number): void {
    this.cfg().volume = volume;
    if (this.out) this.out.volume.value = volume;
  }

  /** Build the band on the current audio context; call after the engine started. Safe to call again after `dispose()`. */
  async load(): Promise<void> {
    if (this.out) return;
    const cfg = this.cfg();
    const out = new Tone.Volume(cfg.volume).connect(this.output());
    this.out = out;
    this.bass = new Tone.MonoSynth({
      oscillator: { type: 'sawtooth' },
      envelope: { attack: 0.005, decay: 0.2, sustain: 0.6, release: 0.12 },
      filter: { type: 'lowpass', Q: 1.5, rolloff: -24 },
      filterEnvelope: { attack: 0.005, decay: 0.25, sustain: 0.5, release: 0.2, baseFrequency: 200, octaves: 3 },
      volume: cfg.bassVolume,
    }).connect(out);
    // Detuned saws through a low-pass: a warm string-machine pad that small speakers still carry.
    this.padFilter = new Tone.Filter({ type: 'lowpass', frequency: 2000, rolloff: -12 }).connect(out);
    this.pad = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: 'fatsawtooth', count: 3, spread: 18 },
      envelope: { attack: 0.18, decay: 0.4, sustain: 0.75, release: 0.5 },
      volume: cfg.padVolume,
    }).connect(this.padFilter);
    const drumsOut = new Tone.Volume(cfg.drumsVolume).connect(out);
    this.drumsOut = drumsOut;
    const drums = new DrumsVoice(() => drumsOut);
    this.drums = drums;
    try {
      await drums.load();
    } catch (err) {
      console.warn('[backing] drum samples failed to load; the band plays without drums', err);
    }
  }

  /** Play one clock step at audio time `time`, leaving out the parts in `muted`. */
  step(step: ClockStep, time: number, muted: ReadonlySet<BackingPart>): void {
    if (!this.out || !this.bass || !this.pad || !this.drumsOut) return;
    const cfg = this.cfg();
    // Read live so the levels can be tuned on site from the URL or the debug panel.
    this.out.volume.value = cfg.volume;
    this.bass.volume.value = cfg.bassVolume;
    this.pad.volume.value = cfg.padVolume;
    this.drumsOut.volume.value = cfg.drumsVolume;

    if (step.countIn || muted.has('pad')) this.releasePad(time);
    for (const n of planStep(step, this.padSounding, cfg.bassLine)) {
      if (muted.has(n.part)) continue;
      const seconds = (n.steps ?? 1) * step.stepSec * GATE;
      if (n.part === 'drums') this.drums?.trigger({ sample: n.sample, velocity: n.velocity }, time);
      else if (n.part === 'bass' && n.notes) this.bass.triggerAttackRelease(n.notes[0], seconds, time, n.velocity);
      else if (n.part === 'pad' && n.notes) {
        this.pad.triggerAttackRelease(n.notes, seconds, time, n.velocity);
        this.padSounding = true;
      }
    }
    // The pad was written to end with the bar: the next bar attacks a new one.
    if (step.sub === 1 && step.beat === step.beatsPerBar - 1) this.padSounding = false;
  }

  /** Cut one part where it stands, for a part that was switched off mid-bar. */
  releasePart(part: BackingPart): void {
    if (part === 'bass') this.bass?.triggerRelease();
    else if (part === 'pad') this.releasePad();
    else this.drums?.releaseAll();
  }

  private releasePad(time?: number): void {
    if (!this.padSounding) return;
    this.pad?.releaseAll(time);
    this.padSounding = false;
  }

  /** Cut everything that rings (pause, standby, backing switched off, song stopped). */
  releaseAll(): void {
    this.bass?.triggerRelease();
    this.pad?.releaseAll();
    this.padSounding = false;
    this.drums?.releaseAll();
  }

  dispose(): void {
    this.releaseAll();
    this.bass?.dispose();
    this.pad?.dispose();
    this.padFilter?.dispose();
    this.drumsOut?.dispose();
    this.out?.dispose();
    this.bass = this.pad = null;
    this.padFilter = null;
    this.drums = null;
    this.drumsOut = this.out = null;
  }
}
