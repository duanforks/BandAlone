import type { ChordName, InstrumentId, PlayerId, PlayMode } from '@/core/types';
import type { CalibrationState } from '@/core/views';
import type { HarmonySnapshot } from '@/audio/harmonizer';

/**
 * Everything the UI and HUD need to know about a running session, as plain
 * data from `session.info()`. Poll it (it is cheap); never compute any of this
 * in the UI. The first four fields are `HudInfo`, so a SessionInfo can be
 * handed to the Hud as is.
 */
export interface SessionInfo {
  mode: PlayMode;
  /** null until a song clock exists (HudInfo semantics); `song.title` is always set. */
  songTitle: string | null;
  songRunning: boolean;
  beatsPerBar: number;

  /** Player 0's instrument; null = none picked (just the camera picture). */
  instrument: InstrumentId | null;
  paused: boolean;
  /** The band is held while the players are edited: hands are tracked, nothing plays (see `Session.setStandby`). */
  standby: boolean;
  song: SongInfo;
  backing: {
    enabled: boolean;
    parts: { bass: boolean; pad: boolean; drums: boolean };
    /** Generated backing master level, dB. */
    volume: number;
    /** Automatic guitar level used by Sing Freely, dB. */
    singFreelyGuitarVolume: number;
  };
  singer: SingerInfo;
  players: PlayerInfo[];
}

export interface SongInfo {
  id: string;
  title: string;
  bpm: number;
  /** 0-based, keeps counting past the end of the chart (the chart loops). */
  bar: number;
  beat: number;
  /** 0..1 inside the beat. */
  beatPhase: number;
  chord: ChordName | null;
  /** Chord of the next bar (it can equal `chord`); null while no song runs. */
  nextChord: ChordName | null;
  lyric: string | null;
  nextLyric: string | null;
  section: string | null;
  /** Bars in one pass of the chart. */
  barCount: number;
  running: boolean;
  /**
   * The clicks before bar 0. While `active`, `beat` is the 0-based beat inside
   * the count-in (show `beats - beat`), `bar` / `beat` / `beatPhase` above stay
   * 0, `chord` is the chart's first chord. Always an
   * object; `active` is false once the chart runs and whenever no song runs.
   */
  countIn: CountInInfo;
}

export interface CountInInfo {
  active: boolean;
  beat: number;
  /** Length of the count-in, beats (one bar). */
  beats: number;
}

export interface SingerInfo {
  enabled: boolean;
  /** false when the browser has no microphone API. */
  available: boolean;
  /** Input level, 0..1. */
  level: number;
  /** Linear monitor gain, 0..2. */
  gain: number;
  echo: number;
  reverb: number;
  /** Browser ID of the active or selected audio input. */
  deviceId: string;
  /** Last mic error (e.g. permission denied); null when fine. */
  error: string | null;
  /** Live melody analysis and the harmony selected for sing-freely mode. */
  harmony: HarmonySnapshot;
}

export interface PlayerInfo {
  id: PlayerId;
  /** null = "None": this player holds no instrument. */
  instrument: InstrumentId | null;
  /** Hands tracked for this player in the latest frame. */
  hands: number;
  /** Linear instrument output level, 0..1. */
  volume: number;
  calibration: CalibrationState;
}
