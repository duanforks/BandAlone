import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '@/app/config';
import { getSong, SING_FREELY_ID } from '@/song/songs';
import { Session } from '@/app/session';
import { bus } from '@/core/bus';
import { FREEPLAY_CONTEXT } from '@/audio/modes';
import type { AppEvent, InstrumentId, SongContext, VisionFrame } from '@/core/types';
import { GuitarFx } from '@/render/fx';
import { handAt } from './helpers/hands';

/** A Session never touches the camera, model or audio context until `start()`, so fakes are enough. */
function makeSession(instrument: InstrumentId | null = 'drums'): Session {
  const video = {} as HTMLVideoElement;
  const canvas = { getContext: () => ({}) } as unknown as HTMLCanvasElement;
  const s = new Session(video, canvas, structuredClone(DEFAULT_CONFIG));
  s.setInstrument(instrument); // what the UI does for a player who picked one
  return s;
}

const seen: AppEvent[] = [];
let off = bus.onAny((e) => seen.push(e));
afterEach(() => {
  off();
  seen.length = 0;
  off = bus.onAny((e) => seen.push(e));
});

describe('Session seams', () => {
  it('a new session has no instrument: nothing to play or draw, and the full band may back it', () => {
    const s = makeSession(null);
    expect(s.controllers).toHaveLength(0);
    expect(s.info().instrument).toBeNull();
    expect(s.info().players).toHaveLength(1);
    expect(s.info().players[0]).toMatchObject({ id: 0, instrument: null, hands: 0, calibration: 'none' });
    s.kick(); // no drummer: nothing is emitted
    expect(seen.filter((e) => e.type === 'drum.hit')).toHaveLength(0);
    expect(s.calibrate()).toBe(false);
    s.setMode('hard');
    s.setStandby(true);
    s.setStandby(false);
    s.stop();
  });

  it('setInstrument(null) takes the instrument away and gives it back on request', () => {
    const s = makeSession();
    const drums = s.controllers[0];
    let triggers = 0;
    drums.instrument.voice.trigger = () => void triggers++;
    s.setInstrument(null);
    expect(s.controllers).toHaveLength(0);
    expect(s.info().players[0].instrument).toBeNull();
    bus.emit({ type: 'drum.hit', t: 1, playerId: 0, pad: 'snare', velocity: 0.8 });
    expect(triggers).toBe(0);
    s.setInstrument('guitar');
    expect(s.info().instrument).toBe('guitar');
    s.setInstrument('drums', 1); // there is no player 2 until setNumPlayers(2)
    expect(s.info().players).toHaveLength(1);
    expect(s.controllers).toHaveLength(1);
    s.stop();
  });

  it('a player setup that names no instrument for a player clears it (the UI says nothing for "None")', async () => {
    const s = makeSession();
    // Done with drums still picked: the same controller stays, calibration with it.
    const drums = s.controllers[0];
    s.setNumPlayers(1);
    s.setInstrument('drums', 0);
    await Promise.resolve();
    expect(s.controllers[0]).toBe(drums);
    // Done with "None": only setNumPlayers is called.
    s.setNumPlayers(1);
    expect(s.info().instrument).toBe('drums'); // nothing happens inside the tick
    await Promise.resolve();
    expect(s.info().instrument).toBeNull();
    // An explicit null (ask 13) is the same thing, at once.
    s.setInstrument('guitar');
    s.setNumPlayers(1);
    s.setInstrument(null, 0);
    expect(s.info().instrument).toBeNull();
    await Promise.resolve();
    s.setInstrument('bass');
    await Promise.resolve();
    expect(s.info().instrument).toBe('bass'); // no sweep left over
    s.stop();
  });

  it('reports the drums through info() once the UI picks them', () => {
    const s = makeSession();
    const info = s.info();
    expect(info.instrument).toBe('drums');
    expect(info.players).toHaveLength(1);
    expect(info.players[0]).toMatchObject({ id: 0, instrument: 'drums', hands: 0, calibration: 'locked' }); // the default kit stays put until C
    // HudInfo fields stay at the top level.
    expect(info).toMatchObject({ mode: 'easy', songTitle: null, songRunning: false, beatsPerBar: 4, paused: false });
    expect(info.song).toMatchObject({ id: 'viva-la-vida', bpm: 138, barCount: 8, running: false, lyric: null });
    expect(info.backing.enabled).toBe(true);
    expect(info.singer).toMatchObject({ enabled: false, level: 0, error: null });
    s.stop();
  });

  it('tracks, clamps, and resets an independent volume for each player', () => {
    const s = makeSession();
    s.setNumPlayers(2);
    s.setPlayerVolume(0, 0.35);
    s.setPlayerVolume(1, 2);
    expect(s.info().players.map((player) => player.volume)).toEqual([0.35, 1]);

    s.setPlayerVolume(1, -1);
    expect(s.info().players[1].volume).toBe(0);
    s.resetPlayerVolumes();
    expect(s.info().players.map((player) => player.volume)).toEqual([1, 1]);
    s.stop();
  });

  it('setInstrument swaps the controller and uses registered guitar art', () => {
    const s = makeSession();
    const drums = s.controllers[0];
    s.setInstrument('guitar');
    const guitar = s.controllers[0];
    expect(guitar).not.toBe(drums);
    expect(guitar.instrument.id).toBe('guitar');
    expect(guitar.instrument.overlay).toBeInstanceOf(GuitarFx);
    expect(guitar.instrument.view?.()).toMatchObject({ instrument: 'guitar', chord: null });
    expect(s.info().instrument).toBe('guitar');

    s.setInstrument('bass');
    expect(s.info().players[0].instrument).toBe('bass');
    expect(s.controllers[0].instrument.view?.()).toMatchObject({ instrument: 'bass', note: null });

    expect(() => s.setInstrument('kazoo' as never)).toThrow(); // an id that does not exist
    expect(s.info().instrument).toBe('bass'); // a failed swap leaves the old instrument in place
    s.stop();
  });

  it('the swapped-out controller stops listening to the bus', () => {
    const s = makeSession();
    const drums = s.controllers[0];
    let triggers = 0;
    drums.instrument.voice.trigger = () => void triggers++;
    s.kick();
    expect(triggers).toBe(1);
    s.setInstrument('guitar');
    s.kick(); // no drummer: nothing is emitted
    bus.emit({ type: 'drum.hit', t: 1, playerId: 0, pad: 'snare', velocity: 0.8 });
    expect(triggers).toBe(1);
    expect(seen.filter((e) => e.type === 'drum.hit')).toHaveLength(2);
    s.stop();
  });

  it('calibrate always answers with a toast', () => {
    const s = makeSession();
    expect(s.calibrate()).toBe(false);
    const toasts = seen.filter((e) => e.type === 'ui.toast');
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatchObject({ kind: 'warn' });

    // The drum kit is placed with two presses: the first starts following the hands, the second pins it.
    s.lastFrame = { t: 1, aspect: 4 / 3, hands: [], inferenceMs: 0 };
    expect(s.calibrate()).toBe(true);
    expect(s.info().players[0].calibration).toBe('auto');
    expect(s.calibrate()).toBe(true);
    const texts = seen.filter((e) => e.type === 'ui.toast').slice(1);
    expect(texts[0]).toMatchObject({ kind: 'success' });
    expect(texts[1]).toMatchObject({ text: 'Kit locked', kind: 'success' });

    // Any other instrument that can calibrate gets the latest frame and a plain answer.
    s.setInstrument('guitar');
    s.controllers[0].instrument.calibrate = () => true;
    expect(s.calibrate()).toBe(true);
    expect(seen.filter((e) => e.type === 'ui.toast')[3]).toMatchObject({ text: 'Calibrated', kind: 'success' });
    s.stop();
  });

  it('standby holds the band: no sound, no kick, and instruments picked meanwhile stay quiet until it ends', () => {
    const s = makeSession();
    let triggers = 0;
    s.controllers[0].instrument.voice.trigger = () => void triggers++;
    s.kick();
    expect(triggers).toBe(1);

    s.setStandby(true);
    expect(s.info().standby).toBe(true);
    s.kick();
    bus.emit({ type: 'drum.hit', t: 1, playerId: 0, pad: 'snare', velocity: 0.8 });
    expect(triggers).toBe(1);

    s.setInstrument('guitar'); // what Edit players does before Done
    expect(s.controllers[0].muted).toBe(true);
    let strums = 0;
    s.controllers[0].instrument.voice.trigger = () => void strums++;
    bus.emit({ type: 'guitar.strum', t: 2, playerId: 0, direction: 'down', velocity: 0.8, chord: null });
    expect(strums).toBe(0);

    s.setStandby(false);
    expect(s.info().standby).toBe(false);
    bus.emit({ type: 'guitar.strum', t: 3, playerId: 0, direction: 'down', velocity: 0.8, chord: null });
    expect(strums).toBe(1);
    s.stop();
  });

  it('setMode reaches every controller; setBacking and setNumPlayers record the choice', () => {
    const s = makeSession();
    s.setMode('hard');
    expect((s.controllers[0].resolver as { id?: string }).id).toBe('hard');
    s.setBacking(false);
    expect(s.info().backing.enabled).toBe(false);
    s.setBackingVolume(20);
    s.setSingFreelyGuitarVolume(-12);
    expect(s.info().backing).toMatchObject({ volume: 6, singFreelyGuitarVolume: -12 });
    expect(s.config.guitar.volume).toBe(DEFAULT_CONFIG.guitar.volume);
    s.setNumPlayers(5);
    expect(s.config.players.count).toBe(2);
    s.stop();
  });

  it('info().song.countIn is always an object, idle until a song counts in; the backing band builds nothing before start()', () => {
    const s = makeSession();
    expect(s.info().song.countIn).toEqual({ active: false, beat: 0, beats: 4 });
    expect(s.backing.ready).toBe(false);
    s.setBacking(false); // releasing a band that was never built is a no-op
    s.pause();
    s.setStandby(true);
    s.stop();
  });

  it('reports the chart position, the chord and the next bar\'s chord', () => {
    const s = makeSession();
    expect(s.info().song).toMatchObject({ chord: null, nextChord: null, running: false });

    // Stand in for a running song clock (the real one needs an audio context).
    const song = getSong('stand-by-me'); // verse G Em C D | chorus G Em C D
    let bar = 0;
    let countIn = false;
    const context = (): SongContext => ({ ...FREEPLAY_CONTEXT, bpm: song.bpm, bar, beat: 2, beatPhase: 0.5, countIn, chord: song.sections[0].bars[bar % 4].chord });
    (s as unknown as { songClock: unknown }).songClock = { song, running: true, beatsPerBar: 4, context, opts: {}, dispose() {} };

    expect(s.info().song).toMatchObject({ title: 'Stand By Me', running: true, chord: 'G', nextChord: 'Em', section: 'verse' });
    expect(s.info().song).toMatchObject({ beat: 2, beatPhase: 0.5, countIn: { active: false, beat: 0, beats: 4 } });
    // During the count-in the chart sits at its top and the position moves to `countIn`.
    countIn = true;
    expect(s.info().song).toMatchObject({ bar: 0, beat: 0, beatPhase: 0, chord: 'G', nextChord: 'Em', countIn: { active: true, beat: 2, beats: 4 } });
    countIn = false;
    bar = 3;
    expect(s.info().song).toMatchObject({ chord: 'D', nextChord: 'G' });
    bar = 7; // last bar of the chart: the next chord wraps to the top
    expect(s.info().song.nextChord).toBe('G');
    bar = 8 + 5; // past the end the chart loops
    expect(s.info().song).toMatchObject({ nextChord: 'C', section: 'chorus' });
    s.stop();
    expect(s.info().song.nextChord).toBeNull();
  });

  it('passes the sing-freely note window and live harmony metadata through info()', () => {
    const s = makeSession(null);
    s.config.play.song = SING_FREELY_ID;
    s.singer.harmonizer.setActive(true);
    let t = 0;
    for (const frequency of [261.63, 329.63, 392]) {
      for (let frame = 0; frame < 3; frame++) {
        s.singer.harmonizer.observe({ frequency, clarity: 0.95, rms: 0.3 }, (t += 50));
      }
    }

    const info = s.info();
    expect(info.song).toMatchObject({ id: SING_FREELY_ID, barCount: 0, running: false });
    expect(info.singer.harmony).toMatchObject({
      active: true,
      keyWindowSize: 12,
      keyReady: false,
      recentChords: [],
    });
    expect(info.singer.harmony.recentNotes.map((note) => note.name)).toEqual(['C4', 'E4', 'G4']);
    s.stop();
  });

  it('pause and resume flip the paused flag, and info() reports it', () => {
    const video = { pause() {}, play: async () => {} } as unknown as HTMLVideoElement;
    const canvas = { getContext: () => ({}) } as unknown as HTMLCanvasElement;
    const s = new Session(video, canvas, structuredClone(DEFAULT_CONFIG));
    s.setInstrument('drums');
    s.overlay.drawLabel = () => {};
    // Stand in for a started session: pause() is a no-op without a frame loop.
    (s as unknown as { loop: { start(): void; stop(): void } }).loop = { start() {}, stop() {} };

    s.pause();
    expect(s.paused).toBe(true);
    expect(s.info().paused).toBe(true);
    s.resume();
    expect(s.paused).toBe(false);
    expect(s.info().paused).toBe(false);
    s.stop();
  });

  it('calibrate takes the stage: it stops a running song and wakes a paused band', () => {
    const video = { pause() {}, play: async () => {} } as unknown as HTMLVideoElement;
    const canvas = { getContext: () => ({}) } as unknown as HTMLCanvasElement;
    const s = new Session(video, canvas, structuredClone(DEFAULT_CONFIG));
    s.setInstrument('drums');
    s.overlay.drawLabel = () => {};
    let loopRunning = false;
    (s as unknown as { loop: { start(): void; stop(): void } }).loop = { start: () => void (loopRunning = true), stop: () => void (loopRunning = false) };
    s.lastFrame = { t: 1, aspect: 4 / 3, hands: [], inferenceMs: 0 };
    // Stand in for a running song clock.
    let stopped = 0;
    const clock = { running: true, song: { title: 'x' }, opts: {}, pause() {}, resume() {}, dispose: () => void ((clock.running = false), stopped++) };
    (s as unknown as { songClock: unknown }).songClock = clock;
    expect(s.songRunning).toBe(true);

    s.pause();
    expect(s.paused).toBe(true);
    expect(s.calibrate()).toBe(true);
    expect(s.songRunning).toBe(false);
    expect(stopped).toBeGreaterThan(0);
    expect(s.paused).toBe(false);
    expect(loopRunning).toBe(true); // frames flow again, so the kit can follow the hands
    expect(s.info().players[0].calibration).toBe('auto');

    // Nothing to calibrate: the song is left alone.
    s.setInstrument(null);
    clock.running = true;
    (s as unknown as { songClock: unknown }).songClock = clock;
    expect(s.calibrate()).toBe(false);
    expect(s.songRunning).toBe(true);
    (s as unknown as { songClock: unknown }).songClock = null;
    s.stop();
  });

  it('an unavailable microphone reports an error and a toast without changing the session', async () => {
    const s = makeSession();
    await s.singer.setEnabled(true);
    expect(s.info().singer.enabled).toBe(false);
    expect(s.info().singer.error).toContain('No microphone available');
    expect(seen.some((e) => e.type === 'ui.toast')).toBe(true);
    s.singer.setEcho(2);
    expect(s.info().singer.echo).toBe(1);
    s.stop();
  });
});

describe('two players', () => {
  const ASPECT = 4 / 3;
  const MID = ASPECT / 2;
  const toasts = () => seen.filter((e) => e.type === 'ui.toast').map((e) => (e as { text: string }).text);
  /** What the frame loop does for the instruments: remember the frame, run every controller on it. */
  const feed = (s: Session, frame: VisionFrame) => {
    s.lastFrame = frame;
    for (const c of s.controllers) c.onFrame(frame);
  };
  const hands = (t: number): VisionFrame => ({
    t, aspect: ASPECT, inferenceMs: 0,
    hands: [handAt(1, { x: 0.3, y: 0.5 }, t, t ? 33 : 0, { playerId: 0 }), handAt(2, { x: MID + 0.35, y: 0.45 }, t, t ? 33 : 0, { playerId: 1 }), handAt(3, { x: MID + 0.5, y: 0.45 }, t, t ? 33 : 0, { playerId: 1 })],
  });
  const pads = (s: Session, playerId: number) => {
    const view = s.controllers.find((c) => c.playerId === playerId)?.instrument.view?.();
    if (view?.instrument !== 'drums') throw new Error('no drums view');
    return view;
  };
  const twoPlayers = (a: InstrumentId | null, b: InstrumentId | null): Session => {
    const s = makeSession(null);
    s.setNumPlayers(2);
    s.setInstrument(a, 0);
    s.setInstrument(b, 1);
    return s;
  };

  it('each player has a slot: own instrument, own half, own hands, own voice', () => {
    const s = twoPlayers('drums', 'drums');
    expect(s.config.players.count).toBe(2);
    expect(s.controllers.map((c) => c.playerId)).toEqual([0, 1]);
    feed(s, hands(0));
    const info = s.info();
    expect(info.players.map((p) => [p.id, p.instrument, p.hands])).toEqual([[0, 'drums', 1], [1, 'drums', 2]]);
    expect(info.instrument).toBe('drums');

    // Two drummers, two kits, each inside its own half (player 0 = screen-left).
    expect(Math.max(...pads(s, 0).pads.map((p) => p.x1))).toBeLessThanOrEqual(MID + 1e-9);
    expect(Math.min(...pads(s, 1).pads.map((p) => p.x0))).toBeGreaterThanOrEqual(MID - 1e-9);
    expect(pads(s, 0).anchor?.cx).toBeCloseTo(ASPECT / 4);
    expect(pads(s, 1).anchor?.cx).toBeCloseTo((3 * ASPECT) / 4);

    // Same instrument twice: both voices are registered and each answers its own player only.
    expect((s.audio as unknown as { voices: Set<unknown> }).voices.size).toBe(2);
    const played = [0, 0];
    for (const c of s.controllers) c.instrument.voice.trigger = () => void played[c.playerId]++;
    bus.emit({ type: 'drum.hit', t: 1, playerId: 1, pad: 'snare', velocity: 0.8 });
    expect(played).toEqual([0, 1]);
    s.stop();
  });

  it('setInstrument(null, 1) empties a player; going back to one player drops player 2 and gives player 1 the whole frame', () => {
    const s = twoPlayers('drums', 'guitar');
    feed(s, hands(0));
    const voice = s.controllers[1].instrument.voice;
    let disposed = 0;
    voice.dispose = () => void disposed++;
    s.setInstrument(null, 1);
    expect(disposed).toBe(1);
    expect(s.info().players[1]).toMatchObject({ id: 1, instrument: null, hands: 2 });
    expect(s.controllers.map((c) => c.playerId)).toEqual([0]);

    s.setInstrument('guitar', 1);
    const drums = s.controllers[0];
    s.setNumPlayers(1);
    s.setInstrument('drums', 0);
    expect(s.info().players).toHaveLength(1);
    expect(s.controllers).toEqual([drums]); // player 1 keeps their controller through the change
    feed(s, hands(33));
    expect(pads(s, 0).anchor?.cx).toBeCloseTo(MID); // re-fitted into the whole frame at once
    s.setInstrument('guitar', 1); // no such player any more
    expect(s.controllers).toHaveLength(1);
    s.stop();
  });

  it('the UI names players in one tick: an unnamed player 2 ends up with nothing', async () => {
    const s = twoPlayers('guitar', 'drums');
    await Promise.resolve();
    expect(s.info().players.map((p) => p.instrument)).toEqual(['guitar', 'drums']);
    s.setNumPlayers(2);
    s.setInstrument('guitar', 0); // player 2 went to "None": the UI says nothing about them
    await Promise.resolve();
    expect(s.info().players.map((p) => p.instrument)).toEqual(['guitar', null]);
    s.stop();
  });

  it('calibrate() is everyone, calibrate(id) is one player, and one press keeps two drummers in step', () => {
    const s = twoPlayers('drums', 'drums');
    feed(s, hands(0));
    expect(s.calibrate()).toBe(true);
    expect(s.info().players.map((p) => p.calibration)).toEqual(['auto', 'auto']);
    expect(toasts()).toHaveLength(2);
    expect(toasts()[0]).toMatch(/^Player 1: Rest your hands/);
    expect(toasts()[1]).toMatch(/^Player 2: Rest your hands/);
    for (let t = 33; t < 1500; t += 33) feed(s, hands(t));
    expect(pads(s, 0).anchor?.cx).not.toBeCloseTo(ASPECT / 4, 2); // off its default, onto the player's hand (as far as the half allows)

    // Player 2's badge pins player 2's kit only.
    const kit0 = pads(s, 0).anchor;
    expect(s.calibrate(1)).toBe(true);
    expect(s.info().players.map((p) => p.calibration)).toEqual(['auto', 'locked']);
    expect(toasts()[2]).toBe('Player 2: Kit locked');
    // One press for everyone: the kit still being placed is pinned, the pinned one is left alone.
    const kit1 = pads(s, 1).anchor;
    expect(s.calibrate()).toBe(true);
    expect(s.info().players.map((p) => p.calibration)).toEqual(['locked', 'locked']);
    expect(toasts().slice(3)).toEqual(['Player 1: Kit locked']);
    expect(pads(s, 1).anchor).toEqual(kit1);
    expect(pads(s, 0).anchor?.cx).toBeCloseTo(kit0!.cx, 2);

    // Reset one player: the other kit stays where it was pinned.
    s.resetCalibration(0);
    feed(s, hands(1600));
    expect(pads(s, 0).anchor?.cx).toBeCloseTo(ASPECT / 4);
    expect(pads(s, 1).anchor).toEqual(kit1);
    s.resetCalibration();
    feed(s, hands(1633));
    expect(pads(s, 1).anchor?.cx).toBeCloseTo((3 * ASPECT) / 4);
    s.stop();
  });

  it('two guitarists are two guitars: calibrate(1) moves only player 2\'s band, calibrate() moves both', () => {
    const s = twoPlayers('guitar', 'guitar');
    const band = (id: number) => {
      const view = s.controllers[id].instrument.view?.();
      if (view?.instrument !== 'guitar') throw new Error('no guitar view');
      return view.band;
    };
    feed(s, hands(0));
    expect(band(0).x1).toBeLessThanOrEqual(MID);
    expect(band(1).x0).toBeGreaterThanOrEqual(MID);
    const before = band(0);
    expect(s.calibrate(1)).toBe(true);
    expect(band(0)).toEqual(before);
    expect(band(1).y).toBeCloseTo(0.45);
    expect((band(1).x0 + band(1).x1) / 2).toBeCloseTo(MID + 0.5); // the screen-right hand of player 2's two
    expect(toasts()).toEqual(['Player 2: Calibrated']);

    expect(s.calibrate()).toBe(true);
    expect((band(0).x0 + band(0).x1) / 2).toBeCloseTo(0.3);
    expect(band(0).y).toBeCloseTo(0.5);
    expect(toasts().slice(1)).toEqual(['Player 1: Calibrated', 'Player 2: Calibrated']);

    // A player with nothing to calibrate is skipped; one with no hands in view is told so.
    s.setInstrument(null, 0);
    feed(s, { ...hands(33), hands: [] });
    expect(s.calibrate()).toBe(false);
    expect(toasts().slice(3)).toEqual(['Player 2: Hold your hands where you want to play, then calibrate']);
    s.setInstrument(null, 1);
    expect(s.calibrate()).toBe(false);
    expect(toasts()[4]).toBe('Nothing to calibrate');
    s.stop();
  });
});
