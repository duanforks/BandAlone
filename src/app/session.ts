import * as Tone from 'tone';
import type { Config } from './config';
import { FpsMeter, FrameLoop } from '@/core/loop';
import { Camera, type CameraInfo } from '@/vision/camera';
import { HandTracker } from '@/vision/handLandmarker';
import { FrameAdapter } from '@/vision/frameAdapter';
import { LM, type VisionFrame } from '@/core/types';
import { bus } from '@/core/bus';
import type { CalibrationState } from '@/core/views';
import { Overlay } from '@/render/overlay';
import { MAX_PLAYERS, PlayerAssigner, regionFor } from '@/vision/players';
import { Recorder, Replayer, type Recording, type ReplayerOptions } from '@/vision/recorder';
import { BackingBand, partPlayedBy, type BackingPart } from '@/audio/backing';
import { AudioEngine } from '@/audio/engine';
import { createResolver, FREEPLAY_CONTEXT, strumChord } from '@/audio/modes';
import { SingerChannel, type MicrophoneInfo } from '@/audio/singer';
import { KickCover } from '@/audio/groove';
import { SongClock, type ClockStep } from '@/audio/songClock';
import { GuitarVoice } from '@/audio/voices/guitarVoice';
import type { InstrumentId, PlayerId, PlayMode, SongContext, Voice } from '@/core/types';
import { Hud } from '@/render/hud';
import { getSong, SING_FREELY_ID, SING_FREELY_SONG } from '@/song/songs';
import { barAt, barCount } from '@/song/types';
import { InstrumentController } from './controller';
import { createInstrument } from './instruments';
import type { PlayerInfo, SessionInfo, SongInfo } from './sessionInfo';

export interface SessionStats {
  fps: number;
  inferenceMs: number;
  hands: number;
  delegate: 'GPU' | 'CPU' | '-';
  width: number;
  height: number;
  usingVideoFrameCallback: boolean;
}

export type SessionPhase = 'idle' | 'camera' | 'model' | 'audio' | 'running' | 'error';

const HAND_COLORS = [
  { Left: '#ff5c8a', Right: '#5cd6ff' },
  { Left: '#8aff5c', Right: '#ffd75c' },
] as const;

/**
 * Top-level runtime: camera → hand landmarker → frame adapter → instrument
 * controllers (detectors → bus → mode → voice) → overlay, on the video frame
 * loop. One controller per player who holds an instrument. A new session has
 * none: it is just the camera picture until the UI calls `setInstrument`, and
 * `setInstrument(null)` goes back to that. With two players, player 0 owns the
 * screen-left half and player 1 the right one (vision/players.ts): hands,
 * instruments and calibration all follow that split. The UI reads state from
 * `info()`.
 */
export class Session {
  readonly camera: Camera;
  readonly overlay: Overlay;
  readonly audio: AudioEngine;
  readonly singer: SingerChannel;
  readonly backing: BackingBand;
  readonly hud: Hud;
  /** Index = player id; null = that player holds no instrument ("None": they only watch or sing). */
  private readonly slots: (InstrumentController | null)[];
  /** One post-instrument gain per player, shared across instrument swaps. */
  private readonly playerGains: [Tone.Gain | null, Tone.Gain | null] = [null, null];
  private readonly playerVolumes: [number, number] = [1, 1];
  /** Sampled guitar that accompanies sing-freely mode without requiring a camera gesture. */
  private autoGuitar: GuitarVoice | null = null;
  private autoGuitarOutput: Tone.Volume | null = null;
  private singingFreely = false;
  /** Players the UI has not named since the last `setNumPlayers` (see there). */
  private unconfirmed: Set<PlayerId> | null = null;
  private songClock: SongClock | null = null;
  /** Which easy-mode kicks the players landed themselves; the auto kick skips those. Shared by every drummer. */
  private readonly kickCover = new KickCover();
  readonly stats: SessionStats = {
    fps: 0,
    inferenceMs: 0,
    hands: 0,
    delegate: '-',
    width: 0,
    height: 0,
    usingVideoFrameCallback: false,
  };

  /** Shared, mutable at runtime by the debug panel. */
  readonly config: Config;
  private tracker: HandTracker | null = null;
  private adapter: FrameAdapter;
  private loop: FrameLoop | null = null;
  private readonly recorder = new Recorder();
  private replayer: Replayer | null = null;
  /** Most recent adapted frame, for consumers that poll instead of subscribing. */
  lastFrame: VisionFrame | null = null;
  private readonly fpsMeter = new FpsMeter();
  private disposed = false;
  private isPaused = false;
  private isStandby = false;
  private onPhase: (phase: SessionPhase, detail?: string) => void = () => {};

  constructor(video: HTMLVideoElement, canvas: HTMLCanvasElement, config: Config) {
    this.camera = new Camera(video);
    this.overlay = new Overlay(canvas);
    this.config = config;
    config.players.count = clampPlayers(config.players.count);
    this.slots = Array.from({ length: config.players.count }, () => null);
    this.adapter = new FrameAdapter(config);
    this.audio = new AudioEngine(config.audio);
    this.singer = new SingerChannel(config.singer, () => this.audio.output);
    this.backing = new BackingBand(() => config.backing, () => this.audio.output);
    this.hud = new Hud(() => this.info());
  }

  // --- players and instruments ---------------------------------------------

  /** The players who hold an instrument, in player order. Use `controller.playerId`, not the index. */
  get controllers(): ReadonlyArray<InstrumentController> {
    return this.players;
  }

  private get players(): InstrumentController[] {
    return this.slots.filter((c): c is InstrumentController => c !== null);
  }

  private createController(id: InstrumentId, playerId: PlayerId): InstrumentController {
    const instrument = createInstrument(id, {
      config: this.config,
      output: () => this.playerOutput(playerId),
      playerId,
      song: () => this.songContext(),
      mode: () => this.mode,
      // Read live: going from one player to two squeezes everything into its half at once.
      region: () => regionFor(playerId, this.config.players.count),
    });
    void this.audio.addVoice(instrument.voice);
    const controller = new InstrumentController({
      playerId,
      instrument,
      resolver: createResolver(this.config.play.mode, this.kickCover),
      audio: this.audio,
      song: () => this.songContext(),
    });
    controller.muted = this.isStandby; // instruments picked while the players are edited stay quiet until Done
    return controller;
  }

  /** Linear player level, 0..1. Applies to every instrument that player selects. */
  setPlayerVolume(playerId: PlayerId, volume: number): void {
    const level = Math.min(1, Math.max(0, volume));
    this.playerVolumes[playerId] = level;
    this.playerGains[playerId]?.gain.rampTo(level, 0.02);
  }

  resetPlayerVolumes(): void {
    for (let playerId = 0; playerId < MAX_PLAYERS; playerId++) this.setPlayerVolume(playerId as PlayerId, 1);
  }

  private playerOutput(playerId: PlayerId): Tone.Gain {
    let gain = this.playerGains[playerId];
    if (!gain) {
      gain = new Tone.Gain(this.playerVolumes[playerId]).connect(this.audio.output);
      this.playerGains[playerId] = gain;
    }
    return gain;
  }

  /**
   * Give a player an instrument, swap it, or take it away (`null` = "None": no
   * detectors, no voice, no overlay, just the picture). Safe while running,
   * paused or mid-song. Two players may hold the same instrument: each gets
   * their own. A player past `setNumPlayers` is ignored.
   */
  setInstrument(id: InstrumentId | null, playerId: PlayerId = 0): void {
    if (playerId >= this.slots.length) return;
    this.unconfirmed?.delete(playerId);
    const old = this.slots[playerId];
    if ((old?.instrument.id ?? null) === id) return;
    const next = id === null ? null : this.createController(id, playerId); // throws on an unknown id before anything is torn down
    if (old) {
      old.dispose();
      this.audio.removeVoice(old.instrument.voice);
    }
    this.slots[playerId] = next;
  }

  /**
   * One or two players. With two, each owns a half of the picture (player 0 =
   * screen-left); every instrument re-fits into its region at once, hands are
   * re-dealt by half, and the model tracks four hands. Going back to one
   * removes player 1's instrument.
   *
   * It also opens a player setup: the UI follows it with one `setInstrument`
   * per player, in the same tick, but says nothing at all for a player set to
   * "None". So whoever was not named by the end of the tick loses their
   * instrument. Once the UI passes `setInstrument(null, id)` itself (ask 13)
   * every player is named and this sweep never finds anything.
   */
  setNumPlayers(n: number): void {
    const count = clampPlayers(n);
    this.config.players.count = count;
    for (let id = this.slots.length - 1; id >= count; id--) this.setInstrument(null, id);
    this.slots.length = Math.min(this.slots.length, count);
    while (this.slots.length < count) this.slots.push(null);
    void this.tracker?.setNumHands(this.numHands);
    if (this.unconfirmed) return; // a sweep is already queued for this tick
    this.unconfirmed = new Set(this.slots.map((_, id) => id as PlayerId));
    queueMicrotask(() => {
      const unnamed = this.unconfirmed;
      this.unconfirmed = null;
      if (this.disposed || !unnamed) return;
      for (const id of unnamed) this.setInstrument(null, id);
    });
  }

  /** Hands the model should track: two per player, or more if `vision.numHands` asks for it. */
  private get numHands(): number {
    return Math.max(this.config.vision.numHands, 2 * this.config.players.count);
  }

  /**
   * Snap an instrument to where its player is right now (the C key; for drums,
   * start or finish placing the kit). With no argument, every player who holds
   * something that can calibrate; with a player id, that player only. A
   * running song is stopped and a paused band resumed first. Always answers
   * with a toast, one per player; true if anyone calibrated.
   */
  calibrate(playerId?: PlayerId): boolean {
    const everyone = playerId === undefined;
    const ids = everyone ? this.slots.map((_, id) => id as PlayerId) : [playerId];
    const able = ids.filter((id) => this.slots[id]?.instrument.calibrate);
    const frame = this.lastFrame;
    if (able.length === 0 || !frame) {
      let text = 'Start the camera first';
      if (able.length === 0) text = ids.length > 1 ? 'Nothing to calibrate' : `Nothing to calibrate on ${this.slots[ids[0]]?.instrument.id ?? 'that player'}`;
      bus.emit({ type: 'ui.toast', t: performance.now(), text, kind: 'warn' });
      return false;
    }
    // Calibrating takes the stage: the song stops and a paused band wakes up, so the hands are tracked live.
    if (this.songRunning) this.stopSong();
    if (this.isPaused) this.resume();
    // A drum kit is placed with two presses (it follows the hands in between). One
    // press for everyone keeps the drummers together: if any kit is being placed
    // this press pins them, and a kit that is already pinned stays where it is.
    const pinning = everyone && able.some((id) => this.calibrationOf(id) === 'auto');
    let any = false;
    for (const id of able) {
      const instrument = this.slots[id]!.instrument;
      const isDrums = instrument.id === 'drums';
      if (pinning && isDrums && this.calibrationOf(id) !== 'auto') continue;
      const ok = instrument.calibrate!(frame);
      let text: string;
      if (ok && isDrums) text = this.calibrationOf(id) === 'auto' ? 'Rest your hands where you want the kit, then calibrate again to lock it' : 'Kit locked';
      else text = ok ? 'Calibrated' : 'Hold your hands where you want to play, then calibrate';
      if (this.slots.length > 1) text = `Player ${id + 1}: ${text}`;
      bus.emit({ type: 'ui.toast', t: performance.now(), text, kind: ok ? 'success' : 'warn' });
      any ||= ok;
    }
    return any;
  }

  /** Back to the default spot: everyone's instrument, or one player's. */
  resetCalibration(playerId?: PlayerId): void {
    for (const c of this.players) {
      if (playerId === undefined || c.playerId === playerId) c.instrument.resetCalibration?.();
    }
  }

  private calibrationOf(playerId: PlayerId): CalibrationState {
    const view = this.slots[playerId]?.instrument.view?.();
    return view?.instrument === 'drums' ? view.calibration : 'none';
  }

  /** Generated bass, pad and drums under the players. With it on, the click goes quiet after the count-in. */
  setBacking(on: boolean): void {
    this.config.backing.enabled = on;
    if (!on) this.backing.releaseAll();
  }

  /** Generated backing master level in dB. */
  setBackingVolume(volume: number): void {
    this.backing.setVolume(clampDb(volume));
  }

  /** Automatic sampled guitar level in Sing Freely, in dB. */
  setSingFreelyGuitarVolume(volume: number): void {
    this.config.backing.singFreelyGuitarVolume = clampDb(volume);
    if (this.autoGuitarOutput) this.autoGuitarOutput.volume.value = this.config.backing.singFreelyGuitarVolume;
  }

  /** The band carries the beat (so the click may go quiet) only when it is switched on and built. */
  private get backingOn(): boolean {
    return this.config.backing.enabled && this.backing.ready;
  }

  /** Switch one generated part on or off on its own; the rest of the band keeps playing. */
  setBackingPart(part: BackingPart, on: boolean): void {
    this.config.backing.parts[part] = on;
    if (!on) this.backing.releasePart(part);
  }

  /** Parts the band leaves out: the ones a human is playing, plus the ones switched off. */
  private mutedParts(): Set<BackingPart> {
    const parts = new Set<BackingPart>();
    for (const c of this.players) {
      const part = partPlayedBy(c.instrument.id);
      if (part) parts.add(part);
    }
    const { parts: on } = this.config.backing;
    for (const part of ['bass', 'pad', 'drums'] as const) if (!on[part]) parts.add(part);
    // The always-on sampled guitar is the harmonic backing in sing-freely mode.
    if (this.singingFreely) parts.add('pad');
    return parts;
  }

  /** The foot: play the kick for whoever is on drums (spacebar). Goes through the bus like a real hit. */
  kick(velocity = 0.9): void {
    if (this.isStandby) return;
    const drummer = this.players.find((c) => c.instrument.id === 'drums');
    if (!drummer) return;
    bus.emit({ type: 'drum.hit', t: performance.now(), playerId: drummer.playerId, pad: 'kick', velocity });
  }

  /**
   * What the easy-mode auto kick plays through: a human drummer's own kit, else
   * the band's, but only once the band's groove has been switched off — with the
   * groove running its own kick on 1 and 3 would double this one.
   */
  private kickVoice(): Voice | null {
    const human = this.players.find((c) => c.instrument.id === 'drums')?.instrument.voice;
    if (human) return human;
    return this.backingOn && !this.config.backing.parts.drums ? this.backing.drumVoice : null;
  }

  /** Snapshot of everything the UI and HUD show. Cheap: poll it every frame or on a timer. */
  info(): SessionInfo {
    const hands = this.lastFrame?.hands ?? [];
    // One entry per player, instrument or not, so `players[i]` is always player i.
    const players: PlayerInfo[] = this.slots.map((c, i) => {
      const id = i as PlayerId;
      return {
        id,
        instrument: c?.instrument.id ?? null,
        hands: hands.filter((h) => h.playerId === id).length,
        volume: this.playerVolumes[id],
        calibration: this.calibrationOf(id),
      };
    });
    return {
      mode: this.mode,
      songTitle: this.songClock?.song.title ?? null,
      songRunning: this.songRunning,
      beatsPerBar: this.songClock?.beatsPerBar ?? 4,
      instrument: this.slots[0]?.instrument.id ?? null,
      paused: this.isPaused,
      standby: this.isStandby,
      song: this.songInfo(),
      backing: {
        enabled: this.config.backing.enabled,
        parts: { ...this.config.backing.parts },
        volume: this.config.backing.volume,
        singFreelyGuitarVolume: this.config.backing.singFreelyGuitarVolume,
      },
      singer: this.singer.info(),
      players,
    };
  }

  private songInfo(): SongInfo {
    const id = this.config.play.song;
    const liveHarmony = id === SING_FREELY_ID;
    const song = this.songClock?.song ?? (liveHarmony ? SING_FREELY_SONG : getSong(id));
    const ctx = this.songContext();
    const running = this.songRunning;
    const counting = ctx.countIn === true;
    const bar = running && !liveHarmony ? barAt(song, ctx.bar) : null;
    const nextBar = running && !liveHarmony ? barAt(song, ctx.bar + 1) : null;
    return {
      id,
      title: song.title,
      bpm: song.bpm,
      bar: ctx.bar,
      // The chart has not started during the count-in: its position is in `countIn`.
      beat: counting ? 0 : ctx.beat,
      beatPhase: counting ? 0 : ctx.beatPhase,
      chord: ctx.chord,
      nextChord: nextBar?.chord ?? null,
      lyric: bar?.lyric ?? null,
      nextLyric: nextBar?.lyric ?? null,
      section: liveHarmony && running ? 'Live harmony' : (bar?.section ?? null),
      barCount: liveHarmony ? 0 : barCount(song),
      running,
      countIn: { active: counting, beat: counting ? ctx.beat : 0, beats: this.songClock?.countInBeats ?? song.timeSig[0] },
    };
  }

  // --- mode and song -------------------------------------------------------

  get mode(): PlayMode {
    return this.config.play.mode;
  }

  setMode(mode: PlayMode): void {
    this.config.play.mode = mode;
    for (const c of this.players) c.resolver = createResolver(mode, this.kickCover);
  }

  get songRunning(): boolean {
    return this.songClock?.running ?? false;
  }

  get songTitle(): string | null {
    return this.songClock?.song.title ?? (this.config.play.song === SING_FREELY_ID ? SING_FREELY_SONG : getSong(this.config.play.song)).title;
  }

  /** Start (or restart) the song clock; needs the audio engine running. */
  startSong(songId = this.config.play.song): void {
    if (this.audio.state !== 'running') return;
    this.stopSong();
    this.kickCover.reset();
    this.config.play.song = songId;
    this.singingFreely = songId === SING_FREELY_ID;
    this.singer.setHarmonyActive(this.singingFreely);
    if (this.singingFreely) this.ensureAutoGuitar();
    const { play } = this.config;
    const song = this.singingFreely ? SING_FREELY_SONG : getSong(songId);
    this.songClock = new SongClock(song, {
      click: play.click,
      autoKick: !this.singingFreely && play.autoKick && this.mode === 'easy',
      kickVoice: () => this.kickVoice(),
      kickVelocity: () => this.config.backing.autoKickVelocity,
      skipAutoKick: (bar, beat, beatsPerBar) => this.kickCover.covers(bar, beat, beatsPerBar),
      carried: () => this.backingOn,
      chordAtBar: this.singingFreely ? () => this.singer.harmonizer.chord : undefined,
      onBar: this.singingFreely ? () => void this.singer.harmonizer.chooseChord() : undefined,
    });
    this.songClock.onStep((step, time) => {
      if (this.singingFreely) this.playAutoGuitar(step, time);
      if (this.backingOn) this.backing.step(step, time, this.mutedParts());
    });
    this.songClock.start();
    if (this.isPaused || this.isStandby) this.songClock.pause();
  }

  stopSong(): void {
    this.songClock?.dispose();
    this.songClock = null;
    this.singingFreely = false;
    this.singer.setHarmonyActive(false);
    this.autoGuitar?.releaseAll();
    this.backing.releaseAll();
  }

  /** null returns to automatic key estimation. */
  setSingingKey(key: string | null): void {
    this.singer.setHarmonyKey(key);
  }

  private ensureAutoGuitar(): void {
    if (this.autoGuitar) return;
    this.autoGuitarOutput = new Tone.Volume(this.config.backing.singFreelyGuitarVolume).connect(this.audio.output);
    this.autoGuitar = new GuitarVoice(() => this.autoGuitarOutput!, () => this.config.guitar);
    void this.audio.addVoice(this.autoGuitar);
  }

  /** A restrained pop strum; the selected harmony itself only changes at bar boundaries. */
  private playAutoGuitar(step: ClockStep, time: number): void {
    if (step.countIn) return;
    const down = step.sub === 0 && (step.beat === 0 || step.beat === 2);
    const up = step.sub === 1 && (step.beat === 1 || step.beat === 3);
    if (!down && !up) return;
    const direction = down ? 'down' : 'up';
    const sound = strumChord(
      { type: 'guitar.strum', t: performance.now(), playerId: 0, direction, velocity: down ? 0.78 : 0.52, chord: step.chord },
      step.chord,
    );
    this.autoGuitar?.trigger(sound, time);
  }

  private songContext(): SongContext {
    return this.songClock?.context() ?? FREEPLAY_CONTEXT;
  }

  async start(onPhase?: (phase: SessionPhase, detail?: string) => void): Promise<void> {
    const report = onPhase ?? (() => {});
    this.onPhase = (phase, detail) => {
      // A stopped session stays silent so it can't overwrite a newer session's UI state.
      if (this.disposed && phase !== 'idle') return;
      console.info(`[session] ${phase}${detail ? ` — ${detail}` : ''}`);
      report(phase, detail);
    };
    try {
      // Audio first: it is quick, and the Start click that got us here counts
      // as the user gesture the browser wants for resuming the context.
      this.onPhase('audio');
      await this.audio.start();
      if (this.disposed) return this.teardown();
      // Not awaited: the synths exist at once and the drum samples have the count-in to arrive.
      void this.backing.load();

      this.onPhase('camera');
      await this.camera.start(this.config.camera);
      if (this.disposed) return this.teardown();

      this.onPhase('model');
      this.tracker = await HandTracker.create({ ...this.config.vision, numHands: this.numHands });
      if (this.disposed) return this.teardown();
      const warmMs = this.tracker.warmUp();
      this.stats.delegate = this.tracker.delegate;
      this.onPhase('model', `warm-up ${warmMs.toFixed(0)} ms on ${this.tracker.delegate}`);

      this.overlay.aspect = this.camera.aspect;
      this.stats.width = this.camera.width;
      this.stats.height = this.camera.height;

      this.loop = new FrameLoop(this.camera.video, (video, t) => this.onFrame(video, t));
      this.stats.usingVideoFrameCallback = this.loop.usingVideoFrameCallback;
      this.fpsMeter.reset();
      this.loop.start();
      this.onPhase('running');
      if (this.config.play.autostartSong) this.startSong();
    } catch (err) {
      this.teardown();
      if (this.disposed) return;
      this.onPhase('error', err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  // --- standby and pause ---------------------------------------------------

  get standby(): boolean {
    return this.isStandby;
  }

  /**
   * Hold the band while the players are edited. Unlike `pause()`, the camera,
   * the hand tracking and `info().players[i].hands` stay live (the setup cards
   * show who is in position), but no instrument detects or sounds, ringing
   * notes are cut, and the song holds its beat.
   */
  setStandby(on: boolean): void {
    if (on === this.isStandby) return;
    this.isStandby = on;
    for (const c of this.players) c.muted = on;
    if (on) {
      this.songClock?.pause();
      this.backing.releaseAll();
    } else if (!this.isPaused) this.songClock?.resume();
  }

  get paused(): boolean {
    return this.isPaused;
  }

  /**
   * Freeze the band: the picture holds its last frame, no frames are tracked,
   * detected, recorded or drawn, the song holds its beat and ringing notes are
   * cut. The camera stream and the model stay open so `resume()` is instant.
   */
  pause(): void {
    if (this.isPaused || !this.loop) return;
    this.isPaused = true;
    this.loop.stop();
    if (this.replayer) {
      this.replayer.stop();
      this.replayer = null;
    }
    this.camera.video.pause();
    this.songClock?.pause();
    this.backing.releaseAll();
    for (const c of this.players) c.instrument.voice.releaseAll();
    const aspect = this.lastFrame?.aspect ?? this.camera.aspect;
    this.overlay.drawLabel('PAUSED', { x: aspect / 2, y: 0.08 }, '#ffd75c');
  }

  resume(): void {
    if (!this.isPaused) return;
    this.clearPause();
    if (!this.loop || this.disposed) return;
    // Tracks and detector state are stale after a freeze: start clean so the
    // first frame back can't fire a phantom hit.
    this.adapter.reset();
    this.resetControllers();
    this.fpsMeter.reset();
    this.loop.start();
  }

  private resetControllers(): void {
    for (const c of this.players) c.reset();
  }

  /** Leave the paused state without touching the frame loop (callers restart it themselves). */
  private clearPause(): void {
    if (!this.isPaused) return;
    this.isPaused = false;
    void this.camera.video.play().catch(() => {});
    if (!this.isStandby) this.songClock?.resume();
  }

  /** 'camera' while the live loop feeds frames, 'replay' while a recording does. */
  get source(): 'camera' | 'replay' {
    return this.replayer ? 'replay' : 'camera';
  }

  get isRecording(): boolean {
    return this.recorder.isRecording;
  }

  get recordedFrames(): number {
    return this.recorder.frameCount;
  }

  startRecording(): void {
    this.recorder.start();
  }

  stopRecording(note?: string): Recording {
    return this.recorder.stop(note);
  }

  /** Pause the camera loop and drive the pipeline from a recording instead. */
  replay(rec: Recording, opts: ReplayerOptions = {}): void {
    this.clearPause();
    this.stopReplay();
    this.loop?.stop();
    // A recording's hands are dealt again by screen half, for whoever is playing now.
    const players = new PlayerAssigner(() => this.config.players);
    this.replayer = new Replayer(rec, (frame) => this.consume(players.assign(frame)), opts);
    this.overlay.aspect = rec.aspect;
    this.replayer.start();
  }

  stopReplay(): void {
    if (!this.replayer) return;
    this.replayer.stop();
    this.replayer = null;
    this.adapter.reset();
    this.resetControllers();
    this.fpsMeter.reset();
    if (this.loop && !this.disposed) this.loop.start();
  }

  /** Restart the camera on another device; the model stays loaded. */
  async switchCamera(deviceId: string): Promise<void> {
    this.config.camera.deviceId = deviceId;
    if (!this.loop) return;
    this.clearPause();
    this.stopReplay();
    this.loop.stop();
    await this.camera.start(this.config.camera);
    this.overlay.aspect = this.camera.aspect;
    this.stats.width = this.camera.width;
    this.stats.height = this.camera.height;
    this.fpsMeter.reset();
    this.adapter.reset();
    this.resetControllers();
    this.loop.start();
  }

  listCameras(): Promise<CameraInfo[]> {
    return Camera.list();
  }

  get currentDeviceId(): string {
    return this.camera.deviceId;
  }

  listMicrophones(): Promise<MicrophoneInfo[]> {
    return this.singer.list();
  }

  async switchMicrophone(deviceId: string): Promise<void> {
    await this.singer.setDevice(deviceId);
  }

  get currentMicrophoneId(): string {
    return this.singer.deviceId;
  }

  stop(): void {
    this.disposed = true;
    // The MediaStream and its Tone nodes hang off the master, so release them
    // before teardown disposes the audio engine.
    this.singer.dispose();
    this.teardown();
    for (const c of this.players) c.dispose();
    this.hud.dispose();
    this.onPhase('idle');
  }

  private teardown(): void {
    this.isPaused = false;
    this.stopSong();
    this.backing.dispose(); // before the engine: its nodes hang off the master
    if (this.autoGuitar) {
      this.audio.removeVoice(this.autoGuitar);
      this.autoGuitar = null;
    }
    this.autoGuitarOutput?.dispose();
    this.autoGuitarOutput = null;
    for (const gain of this.playerGains) gain?.dispose();
    this.playerGains.fill(null);
    this.audio.stop();
    this.replayer?.stop();
    this.replayer = null;
    this.loop?.stop();
    this.loop = null;
    this.tracker?.close();
    this.tracker = null;
    this.camera.stop();
  }

  private onFrame(video: HTMLVideoElement, t: number): void {
    if (!this.tracker) return;
    const { result, inferenceMs } = this.tracker.detect(video, t);
    const frame = this.adapter.adapt(result, t, this.camera.aspect, inferenceMs);
    this.consume(frame);
  }

  /** Everything downstream of the frame adapter; fed by the camera loop or a replay. */
  private consume(frame: VisionFrame): void {
    this.lastFrame = frame;
    // Sound first: the controller triggers the voice synchronously, so nothing
    // below (recording, drawing) adds to the motion-to-sound latency.
    for (const c of this.players) c.onFrame(frame);
    this.recorder.push(frame);
    bus.emit({ type: 'vision.frame', frame });

    this.overlay.syncSize();
    this.overlay.aspect = frame.aspect;
    this.overlay.clear();
    for (const c of this.players) c.instrument.overlay.draw(this.overlay.ctx, frame, this.overlay.toPx);
    this.hud.draw(this.overlay.ctx, frame, this.overlay.toPx);

    if (this.config.debug.skeleton) {
      for (const hand of frame.hands) {
        // Stable semantic colours: P1 left/right are pink/blue; P2 are green/yellow.
        const color = HAND_COLORS[hand.playerId]?.[hand.handedness] ?? '#ffffff';
        this.overlay.drawHand(hand.smooth, { color });
        // Corrected + voted label. Raise only your right hand: it must read "R".
        // If it reads "L", set vision.swapHandedness=true (URL: ?vision.swapHandedness=true).
        const label = `${hand.handedness === 'Left' ? 'L' : 'R'} ${hand.handednessScore.toFixed(2)}`;
        this.overlay.drawLabel(label, hand.smooth[LM.WRIST], color);
      }
    }
    if (this.replayer) this.overlay.drawLabel('REPLAY', { x: frame.aspect / 2, y: 0.08 }, '#ffd75c');

    this.stats.fps = this.fpsMeter.tick(frame.t);
    this.stats.inferenceMs = this.stats.inferenceMs
      ? this.stats.inferenceMs + 0.1 * (frame.inferenceMs - this.stats.inferenceMs)
      : frame.inferenceMs;
    this.stats.hands = frame.hands.length;
  }
}

function clampPlayers(n: number): number {
  return Math.min(MAX_PLAYERS, Math.max(1, Math.round(n) || 1));
}

function clampDb(volume: number): number {
  return Math.min(6, Math.max(-24, volume));
}
