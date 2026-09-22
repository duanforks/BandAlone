import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import * as Tone from 'tone';
import { loadConfig } from './config';
import { Session, type SessionPhase, type SessionStats } from './session';
import type { SessionInfo, SongInfo } from './sessionInfo';
import { INSTRUMENT_IDS, INSTRUMENT_MODES, type PlayableInstrumentId } from './instruments';
import { LiveHarmonyPanel } from './LiveHarmonyPanel';
import type { CameraInfo } from '@/vision/camera';
import type { MicrophoneInfo } from '@/audio/singer';
import { bus } from '@/core/bus';
import type { PlayMode, UiToastEvent } from '@/core/types';
import { ConfigControls, DebugPanel, resetConfigControls } from '@/render/DebugPanel';
import { MAJOR_KEY_OPTIONS } from '@/audio/harmonizer';
import { SING_FREELY_ID, SING_FREELY_SONG, SONGS } from '@/song/songs';
import bassIconUrl from '../../bass.png';
import guitarIconUrl from '../../guitar.png';

const PHASE_TEXT: Record<SessionPhase, string> = {
  idle: '',
  camera: 'Opening camera…',
  model: 'Loading hand model…',
  audio: 'Loading sounds…',
  running: '',
  error: 'Something went wrong',
};

const INSTRUMENT_LABELS: Record<PlayableInstrumentId, { label: string; mark: string; hint: string }> = {
  drums: { label: 'Drums', mark: 'D', hint: 'Strike the pads' },
  guitar: { label: 'Guitar', mark: 'G', hint: 'Strum the song' },
  bass: { label: 'Bass', mark: 'B', hint: 'Pluck the groove' },
};

type PlayerInstrument = PlayableInstrumentId | 'none';
type PlayerCount = 1 | 2;
type ToastKind = NonNullable<UiToastEvent['kind']>;

interface PlayerSetup {
  instrument: PlayerInstrument;
  vocals: boolean;
}

interface ToastMessage {
  id: number;
  text: string;
  kind: ToastKind;
}

type MultiplayerSession = Session & {
  /** Optional until the shared multiplayer seam lands. */
  setSinger?: (playerId: number | null) => void;
};

const TOAST_DURATION_MS = 2000;
// Keep the mode implementation intact while the product UI is simplified.
const SHOW_MODE_CONTROLS = false;
const HARMONY_DRAG_TYPE = 'text/x-band-together-harmony-panel';

const PLAYER_DEFAULTS: [PlayerSetup, PlayerSetup] = [
  { instrument: 'drums', vocals: false },
  { instrument: 'guitar', vocals: false },
];

const PLAYER_INSTRUMENTS = [...INSTRUMENT_IDS, 'none'] as const;

function instrumentLabel(id: PlayerInstrument): string {
  return id === 'none' ? 'No instrument' : INSTRUMENT_LABELS[id].label;
}

function formatDb(value: number): string {
  return `${value > 0 ? '+' : ''}${value} dB`;
}

function InstrumentIcon({ instrument }: { instrument: PlayerInstrument }) {
  const common = {
    viewBox: '0 0 48 48',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };

  switch (instrument) {
    case 'drums':
      return (
        <svg {...common}>
          <ellipse cx="24" cy="28" rx="13" ry="6" />
          <path d="M11 28v9c0 3.3 5.8 6 13 6s13-2.7 13-6v-9M17 33v8M31 33v8M12 8l19 20M36 8 17 28" />
          <circle cx="10.5" cy="6.5" r="2" />
          <circle cx="37.5" cy="6.5" r="2" />
        </svg>
      );
    case 'guitar':
      return <img src={guitarIconUrl} alt="" aria-hidden="true" />;
    case 'bass':
      return <img src={bassIconUrl} alt="" aria-hidden="true" />;
    case 'none':
      return (
        <svg {...common}>
          <rect x="9" y="9" width="30" height="30" rx="8" />
          <path d="M17 24h14" />
        </svg>
      );
  }
}

type KaraokeSongInfo = SongInfo & {
  /** Keona's future song seam; the UI already has a place for it. */
  nextChord?: string | null;
  countIn?: { active: boolean; beat: number; beats: number };
};

type KaraokeSessionInfo = Omit<SessionInfo, 'song'> & { song: KaraokeSongInfo };

function PlayerCard({
  playerId,
  setup,
  live,
  hands,
  onInstrument,
  onVocals,
}: {
  playerId: 0 | 1;
  setup: PlayerSetup;
  live: boolean;
  hands: number;
  onInstrument: (instrument: PlayerInstrument) => void;
  onVocals: () => void;
}) {
  const ready = setup.instrument === 'none' ? setup.vocals : hands > 0;
  const readiness = live
    ? setup.instrument !== 'none' && hands > 0
      ? `${hands} ${hands === 1 ? 'hand' : 'hands'} ready`
      : playerId === 0
        ? 'Left'
        : 'Right'
    : null;

  return (
    <article className="player-card" data-player={playerId + 1}>
      <header className="player-card__header">
        <span className="player-card__number" aria-hidden="true">
          0{playerId + 1}
        </span>
        <h3>Player {playerId + 1}</h3>
        {readiness && (
          <span
            className="player-card__ready"
            data-ready={ready || setup.vocals ? '' : undefined}
            data-position={setup.instrument === 'none' || hands === 0 ? '' : undefined}
          >
            <i />
            {readiness}
          </span>
        )}
      </header>

      <fieldset>
        <legend className="sr-only">Player {playerId + 1} instrument</legend>
        <div className="player-card__instruments">
          {PLAYER_INSTRUMENTS.map((id) => {
            const item = id === 'none' ? { label: 'None', hint: 'Vocals or backing only' } : INSTRUMENT_LABELS[id];
            return (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={setup.instrument === id}
                title={item.hint}
                onClick={() => onInstrument(id)}
              >
                <InstrumentIcon instrument={id} />
                {item.label}
              </button>
            );
          })}
        </div>
      </fieldset>

      <button
        type="button"
        className="player-card__vocals"
        aria-pressed={setup.vocals}
        onClick={onVocals}
        title="There is one shared microphone. Choosing this transfers vocals from the other player."
      >
        <span aria-hidden="true">{setup.vocals ? '●' : '○'}</span>
        Vocals
      </button>
    </article>
  );
}

export function App() {
  const config = useMemo(() => loadConfig(), []);
  const [started, setStarted] = useState(config.debug.autostart);

  return (
    <main className="app">
      <header className="app__header">
        <div>
          <p className="app__eyebrow">A tiny webcam band</p>
          <h1 className="app__wordmark">
            Band Alone<span aria-hidden="true">.</span>
          </h1>
        </div>
        <p className="app__tagline">Move like you mean it!</p>
      </header>

      <Stage config={config} active={started} onStart={() => setStarted(true)} />
    </main>
  );
}

function Stage({
  config,
  active,
  onStart,
}: {
  config: ReturnType<typeof loadConfig>;
  active: boolean;
  onStart: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sessionRef = useRef<Session | null>(null);
  const vocalCueSynthRef = useRef<Tone.Synth | null>(null);
  const nextToastIdRef = useRef(0);
  const [phase, setPhase] = useState<SessionPhase>('idle');
  const [detail, setDetail] = useState<string>('');
  const [stats, setStats] = useState<SessionStats | null>(null);
  const [cameras, setCameras] = useState<CameraInfo[]>([]);
  const [deviceId, setDeviceId] = useState('');
  const [session, setSession] = useState<Session | null>(null);
  const [showDebug, setShowDebug] = useState(config.debug.panel);
  const [playerCount, setPlayerCount] = useState<PlayerCount>(config.players.count >= 2 ? 2 : 1);
  const [players, setPlayers] = useState<[PlayerSetup, PlayerSetup]>(() => structuredClone(PLAYER_DEFAULTS));
  const [editingPlayers, setEditingPlayers] = useState(false);
  /** The opening screen comes first; its button leads to player setup. */
  const [welcomed, setWelcomed] = useState(false);
  const playerSetupRef = useRef({ count: playerCount, players });
  const [mode, setMode] = useState<PlayMode>(config.play.mode);
  const [songId, setSongId] = useState(config.play.song);
  const [songRunning, setSongRunning] = useState(false);
  const [paused, setPaused] = useState(false);
  const [playerVolumes, setPlayerVolumes] = useState<[number, number]>([1, 1]);
  const [backingEnabled, setBackingEnabled] = useState(config.backing.enabled);
  const [bassEnabled, setBassEnabled] = useState(config.backing.parts.bass);
  const [drumsEnabled, setDrumsEnabled] = useState(config.backing.parts.drums);
  const [padEnabled, setPadEnabled] = useState(config.backing.parts.pad);
  const [backingVolume, setBackingVolume] = useState(config.backing.volume);
  const [singFreelyGuitarVolume, setSingFreelyGuitarVolume] = useState(config.backing.singFreelyGuitarVolume);
  const [sessionInfo, setSessionInfo] = useState<KaraokeSessionInfo | null>(null);
  const [micPending, setMicPending] = useState(false);
  const [microphones, setMicrophones] = useState<MicrophoneInfo[]>([]);
  const [micDeviceId, setMicDeviceId] = useState(config.singer.deviceId);
  const [micGain, setMicGain] = useState(config.singer.gain);
  const [echo, setEcho] = useState(config.singer.echo);
  const [reverb, setReverb] = useState(config.singer.reverb);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [harmonyPanelPlacement, setHarmonyPanelPlacement] = useState<'stage' | 'below'>(() => {
    try {
      return window.localStorage.getItem('band-together:harmony-panel') === 'stage' ? 'stage' : 'below';
    } catch {
      return 'below';
    }
  });
  const [harmonyPanelDragging, setHarmonyPanelDragging] = useState(false);
  const [, refreshConfig] = useState(0);

  playerSetupRef.current = { count: playerCount, players };

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const typing =
        ev.target instanceof HTMLInputElement || ev.target instanceof HTMLSelectElement || ev.target instanceof HTMLTextAreaElement;
      if (typing) return;
      if (ev.key === '`') setShowDebug((v) => !v);
      if (ev.key.toLowerCase() === 'c' && !ev.repeat) {
        sessionRef.current?.calibrate();
      }
      // Spacebar = kick pedal (any USB keyboard on the floor works).
      if (ev.code === 'Space') {
        ev.preventDefault();
        if (!ev.repeat && !sessionRef.current?.paused) sessionRef.current?.kick();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(
    () => () => {
      vocalCueSynthRef.current?.dispose();
      vocalCueSynthRef.current = null;
    },
    [],
  );

  useEffect(() => {
    const timers = new Set<number>();
    const unsubscribe = bus.on('ui.toast', (event) => {
      const id = ++nextToastIdRef.current;
      setToasts((current) => [...current, { id, text: event.text, kind: event.kind ?? 'info' }]);

      const timer = window.setTimeout(() => {
        setToasts((current) => current.filter((toast) => toast.id !== id));
        timers.delete(timer);
      }, TOAST_DURATION_MS);
      timers.add(timer);
    });

    return () => {
      unsubscribe();
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, []);

  useEffect(() => {
    if (!active) return;

    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;

    const session = new Session(video, canvas, config);
    const setup = playerSetupRef.current;
    session.setNumPlayers(setup.count);
    setup.players.slice(0, setup.count).forEach((player, playerId) => {
      if (player.instrument !== 'none') session.setInstrument(player.instrument, playerId);
    });
    (session as MultiplayerSession).setSinger?.(
      setup.players.slice(0, setup.count).findIndex((player) => player.vocals) < 0
        ? null
        : setup.players.slice(0, setup.count).findIndex((player) => player.vocals),
    );
    sessionRef.current = session;
    setSession(session);
    // Dev hook for console poking and headless checks: window.__airband.session
    if (import.meta.env.DEV) (window as unknown as { __airband?: unknown }).__airband = { session, config };
    session
      .start((p, d) => {
        setPhase(p);
        setDetail(d ?? '');
      })
      .then(async () => {
        setCameras(await session.listCameras());
        setDeviceId(session.currentDeviceId);
      })
      .catch(() => {});

    const statsTimer = window.setInterval(() => {
      setStats({ ...session.stats });
      const info = session.info() as KaraokeSessionInfo;
      setSessionInfo(info);
      setSongRunning(info.songRunning);
      setPaused(info.paused);
      setPlayerVolumes([info.players[0]?.volume ?? 1, info.players[1]?.volume ?? 1]);
      setBackingEnabled(info.backing.enabled);
      setBassEnabled(info.backing.parts.bass);
      setDrumsEnabled(info.backing.parts.drums);
      setPadEnabled(info.backing.parts.pad);
      setBackingVolume(info.backing.volume);
      setSingFreelyGuitarVolume(info.backing.singFreelyGuitarVolume);
      setMicGain(info.singer.gain);
      setEcho(info.singer.echo);
      setReverb(info.singer.reverb);
      if (info.singer.deviceId) setMicDeviceId(info.singer.deviceId);
    }, 250);

    return () => {
      window.clearInterval(statsTimer);
      session.stop();
      sessionRef.current = null;
      setSession(null);
      setSessionInfo(null);
      setMicrophones([]);
      setMicDeviceId('');
    };
  }, [active, config]);

  const onPickCamera = async (id: string) => {
    setDeviceId(id);
    await sessionRef.current?.switchCamera(id);
  };

  const updatePlayerInstrument = (playerId: 0 | 1, instrument: PlayerInstrument) => {
    setPlayers((current) => {
      const next = structuredClone(current);
      next[playerId].instrument = instrument;
      return next;
    });
  };

  const togglePlayerVocals = (playerId: 0 | 1) => {
    setPlayers((current) => {
      const turningOn = !current[playerId].vocals;
      return current.map((player, id) => ({
        ...player,
        vocals: turningOn && id === playerId,
      })) as [PlayerSetup, PlayerSetup];
    });
  };

  const applyPlayerSetup = () => {
    config.players.count = playerCount;
    const current = sessionRef.current;
    if (current) {
      current.setNumPlayers(playerCount);
      players.slice(0, playerCount).forEach((player, playerId) => {
        if (player.instrument !== 'none') current.setInstrument(player.instrument, playerId);
      });
      const singerId = players.slice(0, playerCount).findIndex((player) => player.vocals);
      (current as MultiplayerSession).setSinger?.(singerId < 0 ? null : singerId);
    }

    const assigned = players.slice(0, playerCount).filter((player) => player.instrument !== 'none');
    const supportsHard = assigned.every((player) => INSTRUMENT_MODES[player.instrument as PlayableInstrumentId].includes('hard'));
    if (!supportsHard && mode === 'hard') {
      setMode('easy');
      current?.setMode('easy');
      if (current?.songRunning) current.startSong();
    }
    setEditingPlayers(false);
  };

  const startBand = () => {
    applyPlayerSetup();
    onStart();
  };

  const applyMode = (next: PlayMode) => {
    const assigned = players.slice(0, playerCount).filter((player) => player.instrument !== 'none');
    const supported = assigned.every((player) => INSTRUMENT_MODES[player.instrument as PlayableInstrumentId].includes(next));
    if (next === mode || !supported) return;
    setMode(next);
    sessionRef.current?.setMode(next);
    // The auto kick belongs to easy mode: restart the clock so the option takes effect.
    if (sessionRef.current?.songRunning) sessionRef.current.startSong();
  };

  const toggleSong = async () => {
    const s = sessionRef.current;
    if (!s) return;
    if (s.songRunning) s.stopSong();
    else {
      if (songId === SING_FREELY_ID && !s.singer.enabled) {
        setMicPending(true);
        try {
          await s.singer.setEnabled(true);
          setSessionInfo(s.info() as KaraokeSessionInfo);
          if (!s.singer.enabled) return;
          setMicrophones(await s.listMicrophones());
          setMicDeviceId(s.currentMicrophoneId);
        } finally {
          setMicPending(false);
        }
      }
      s.startSong(songId);
    }
    setSongRunning(s.songRunning);
  };

  const togglePause = () => {
    const s = sessionRef.current;
    if (!s) return;
    if (s.paused) s.resume();
    else s.pause();
    setPaused(s.paused);
  };

  const pickSong = (id: string) => {
    setSongId(id);
    config.play.song = id;
    const s = sessionRef.current;
    if (!s?.songRunning) return;
    // Entering live harmony needs a permission-granting Play click if the mic is still off.
    if (id === SING_FREELY_ID && !s.singer.enabled) s.stopSong();
    else s.startSong(id);
    setSongRunning(s.songRunning);
  };

  const toggleBacking = () => {
    const next = !backingEnabled;
    setBackingEnabled(next);
    sessionRef.current?.setBacking(next);
  };

  const changePlayerVolume = (playerId: 0 | 1, volume: number) => {
    setPlayerVolumes((current) => {
      const next: [number, number] = [...current];
      next[playerId] = volume;
      return next;
    });
    sessionRef.current?.setPlayerVolume(playerId, volume);
  };

  const resetPlayerVolumes = () => {
    setPlayerVolumes([1, 1]);
    sessionRef.current?.resetPlayerVolumes();
  };

  const toggleBass = () => {
    const next = !bassEnabled;
    setBassEnabled(next);
    sessionRef.current?.setBackingPart('bass', next);
  };

  const toggleDrums = () => {
    const next = !drumsEnabled;
    setDrumsEnabled(next);
    sessionRef.current?.setBackingPart('drums', next);
  };

  const togglePad = () => {
    const next = !padEnabled;
    setPadEnabled(next);
    sessionRef.current?.setBackingPart('pad', next);
  };

  const changeBackingVolume = (volume: number) => {
    setBackingVolume(volume);
    sessionRef.current?.setBackingVolume(volume);
  };

  const changeSingFreelyGuitarVolume = (volume: number) => {
    setSingFreelyGuitarVolume(volume);
    sessionRef.current?.setSingFreelyGuitarVolume(volume);
  };

  const toggleSinger = async () => {
    const current = sessionRef.current;
    if (!current || micPending) return;
    setMicPending(true);
    try {
      await current.singer.setEnabled(!current.singer.enabled);
      setSessionInfo(current.info() as KaraokeSessionInfo);
      if (current.singer.enabled) {
        setMicrophones(await current.listMicrophones());
        setMicDeviceId(current.currentMicrophoneId);
      }
    } finally {
      setMicPending(false);
    }
  };

  const onPickMicrophone = async (id: string) => {
    const current = sessionRef.current;
    if (!current || micPending) return;
    setMicDeviceId(id);
    setMicPending(true);
    try {
      await current.switchMicrophone(id);
      setSessionInfo(current.info() as KaraokeSessionInfo);
      if (current.singer.enabled) {
        setMicrophones(await current.listMicrophones());
        setMicDeviceId(current.currentMicrophoneId);
      }
    } finally {
      setMicPending(false);
    }
  };

  const changeEcho = (amount: number) => {
    setEcho(amount);
    sessionRef.current?.singer.setEcho(amount);
  };

  const changeMicGain = (amount: number) => {
    setMicGain(amount);
    sessionRef.current?.singer.setGain(amount);
  };

  const changeReverb = (amount: number) => {
    setReverb(amount);
    sessionRef.current?.singer.setReverb(amount);
  };

  const changeSingingKey = (key: string) => {
    const current = sessionRef.current;
    current?.setSingingKey(key === 'auto' ? null : key);
    if (current) setSessionInfo(current.info() as KaraokeSessionInfo);
  };

  const playVocalCue = async (pitch: string) => {
    await Tone.start();
    const synth =
      vocalCueSynthRef.current ??
      new Tone.Synth({
        oscillator: { type: 'sine' },
        envelope: { attack: 0.02, decay: 0.12, sustain: 0.55, release: 0.45 },
        volume: -8,
      }).toDestination();
    vocalCueSynthRef.current = synth;
    synth.triggerAttackRelease(pitch, 0.9);
  };

  const moveHarmonyPanel = (placement: 'stage' | 'below') => {
    setHarmonyPanelPlacement(placement);
    try {
      window.localStorage.setItem('band-together:harmony-panel', placement);
    } catch {
      // Storage can be unavailable in private browsing; the in-memory choice still works.
    }
  };

  const startHarmonyPanelDrag = (event: DragEvent<HTMLDivElement>) => {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(HARMONY_DRAG_TYPE, 'live-harmony');
    setHarmonyPanelDragging(true);
  };

  const allowHarmonyPanelDrop = (event: DragEvent<HTMLElement>) => {
    if (!Array.from(event.dataTransfer.types).includes(HARMONY_DRAG_TYPE)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  };

  const dropHarmonyPanel = (event: DragEvent<HTMLElement>, placement: 'stage' | 'below') => {
    if (!event.dataTransfer.getData(HARMONY_DRAG_TYPE)) return;
    event.preventDefault();
    moveHarmonyPanel(placement);
    setHarmonyPanelDragging(false);
  };

  const aspect = stats && stats.width > 0 ? `${stats.width} / ${stats.height}` : '4 / 3';
  const visiblePlayers = players.slice(0, playerCount);
  const assignedPlayers = visiblePlayers.filter((player) => player.instrument !== 'none');
  const hasDrummer = assignedPlayers.some((player) => player.instrument === 'drums');
  // Only the drums differ between the modes; guitar and bass play the chart either way.
  const modeHintText = !hasDrummer
    ? 'The song picks the notes. Just play in time.'
    : mode === 'hard'
      ? 'Drums: each pad plays its own drum.'
      : 'Drums: hit anywhere in time and the song picks the drum. Green flash = in time, red = off the beat.';
  const hardModeAvailable = assignedPlayers.every((player) =>
    INSTRUMENT_MODES[player.instrument as PlayableInstrumentId].includes('hard'),
  );
  const singerId = visiblePlayers.findIndex((player) => player.vocals);
  const songInfo = sessionInfo?.song;
  const singerInfo = sessionInfo?.singer;
  const isSingFreely = songId === SING_FREELY_ID;
  const harmony = singerInfo?.harmony;
  const vocalCue = isSingFreely ? undefined : SONGS[songInfo?.running ? songInfo.id : songId]?.vocalCue;
  const songProgress =
    songInfo && songInfo.running && songInfo.barCount > 0
      ? (((songInfo.bar % songInfo.barCount) + (songInfo.beat + songInfo.beatPhase) / (sessionInfo?.beatsPerBar ?? 4)) /
          songInfo.barCount) *
        100
      : 0;

  const live = active && phase === 'running';
  const showPlayerSetup = !active || editingPlayers;
  const showWelcome = !active && !welcomed;
  const status = !live
    ? { tone: 'wait', label: active ? PHASE_TEXT[phase] || 'Starting…' : 'Camera off' }
    : paused
      ? { tone: 'paused', label: 'Paused' }
      : songRunning
        ? { tone: 'live', label: 'Playing' }
        : { tone: 'idle', label: 'Ready' };
  const liveHarmonyPanel =
    live && isSingFreely ? (
      <div
        className="live-harmony-placement"
        draggable
        role="group"
        aria-label="Moveable live harmony panel"
        onDragStart={startHarmonyPanelDrag}
        onDragEnd={() => setHarmonyPanelDragging(false)}
      >
        <button
          className="live-harmony-placement__move"
          type="button"
          draggable={false}
          aria-label={harmonyPanelPlacement === 'stage' ? 'Move notes below video' : 'Move notes onto video'}
          title={harmonyPanelPlacement === 'stage' ? 'Move notes below video' : 'Move notes onto video'}
          onClick={() => moveHarmonyPanel(harmonyPanelPlacement === 'stage' ? 'below' : 'stage')}
        >
          <span aria-hidden="true">{harmonyPanelPlacement === 'stage' ? '↘' : '↗'}</span>
        </button>
        <LiveHarmonyPanel
          harmony={harmony}
          chord={songInfo?.chord ?? null}
          beat={songInfo?.beat ?? 0}
          beatsPerBar={sessionInfo?.beatsPerBar ?? 4}
          running={songInfo?.running ?? false}
          micEnabled={singerInfo?.enabled ?? false}
        />
      </div>
    ) : null;

  return (
    <section className="stage-wrap" data-prestart={active ? undefined : ''}>
      <div className="console">
        <div className="console__bar">
          <div className="control-section">
            <div className="band-section__head">
              <span className="control-label">Band</span>
              <button
                className="volume-reset"
                type="button"
                disabled={!live || visiblePlayers.every((_, playerId) => playerVolumes[playerId] === 1)}
                onClick={resetPlayerVolumes}
              >
                Reset volume
              </button>
            </div>
            <div className="band-summary">
              {visiblePlayers.map((player, playerId) => (
                <div className="band-summary__player" key={playerId}>
                  <span className="band-summary__player-id">P{playerId + 1}</span>
                  <span className="band-summary__instrument">
                    <strong>{instrumentLabel(player.instrument)}</strong>
                    {player.vocals && <small>+Vocals</small>}
                  </span>
                  <label className="player-volume">
                    <span className="sr-only">Player {playerId + 1} volume</span>
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.01"
                      value={playerVolumes[playerId]}
                      disabled={!live}
                      onChange={(event) => changePlayerVolume(playerId as 0 | 1, Number(event.target.value))}
                    />
                    <output>{Math.round(playerVolumes[playerId] * 100)}%</output>
                  </label>
                </div>
              ))}
            </div>
            <button className="btn band-summary__edit" type="button" disabled={!live} onClick={() => setEditingPlayers(true)}>
              Edit players
            </button>
            {SHOW_MODE_CONTROLS && (
              <div className="sidebar-field">
                <span>Mode</span>
                <div className="segmented" data-mode={mode} role="group" aria-label="Difficulty">
                  <button
                    type="button"
                    onClick={() => applyMode('easy')}
                    disabled={!live}
                    aria-pressed={mode === 'easy'}
                    title="Easy: the song chooses what you play."
                  >
                    Easy
                  </button>
                  <button
                    type="button"
                    onClick={() => applyMode('hard')}
                    disabled={!live || !hardModeAvailable}
                    aria-pressed={mode === 'hard'}
                    title={hardModeAvailable ? 'Hard: your gesture chooses what you play.' : 'Guitar is easy mode only.'}
                  >
                    Hard
                  </button>
                </div>
                <p className="hint" style={{ margin: '0.35rem 0 0', fontSize: '0.62rem', lineHeight: 1.35 }}>
                  {modeHintText}
                </p>
              </div>
            )}
          </div>

          <div className="control-section">
            <span className="control-label">Session</span>
            <div className="control-actions">
              <button
                className={`btn ${songRunning ? '' : 'btn--primary'}`}
                onClick={() => void toggleSong()}
                disabled={!live}
                title="Start or stop the song clock"
              >
                {songRunning ? '■ Stop' : isSingFreely ? '▶ Start' : '▶ Play'}
              </button>
              <button
                className={`btn ${paused ? 'btn--paused' : ''}`}
                onClick={togglePause}
                disabled={!live}
                title="Freeze the camera, tracking, sound and song."
              >
                {paused ? '▶ Resume' : '⏸ Pause'}
              </button>
            </div>
            <select
              className="select"
              value={songId}
              onChange={(e) => pickSong(e.target.value)}
              disabled={!live}
              aria-label="Song"
            >
              <option value={SING_FREELY_ID}>{SING_FREELY_SONG.title} · {SING_FREELY_SONG.bpm} bpm</option>
              {Object.entries(SONGS).map(([id, s]) => (
                <option key={id} value={id}>
                  {s.title} · {s.bpm} bpm
                </option>
              ))}
            </select>
          </div>

          <div className="control-section">
            <span className="control-label">Backing mix</span>
            <div className="sidebar-toggles">
              <button
                type="button"
                className="backing-toggle"
                aria-pressed={backingEnabled}
                disabled={!live}
                onClick={toggleBacking}
                title="Let the generated band fill the parts nobody is playing."
              >
                <span aria-hidden="true">{backingEnabled ? '●' : '○'}</span>
                Backing
                <strong>{backingEnabled ? 'All On' : 'All Off'}</strong>
              </button>
              <button
                type="button"
                className="backing-toggle backing-toggle--part"
                aria-pressed={bassEnabled}
                disabled={!live || !backingEnabled}
                onClick={toggleBass}
                title="The generated bass under the band. Off leaves the drums and the pad."
              >
                <span aria-hidden="true">{bassEnabled ? '●' : '○'}</span>
                Bass
                <strong>{bassEnabled ? 'On' : 'Off'}</strong>
              </button>
              <button
                type="button"
                className="backing-toggle backing-toggle--part"
                aria-pressed={drumsEnabled}
                disabled={!live || !backingEnabled}
                onClick={toggleDrums}
                title="The generated groove. Off leaves the easy-mode kick on 1 and 3 to hold the beat."
              >
                <span aria-hidden="true">{drumsEnabled ? '●' : '○'}</span>
                Drums
                <strong>{drumsEnabled ? 'On' : 'Off'}</strong>
              </button>
              <button
                type="button"
                className="backing-toggle backing-toggle--part"
                aria-pressed={padEnabled}
                disabled={!live || !backingEnabled}
                onClick={togglePad}
                title="The generated chord pad holding each bar. Off leaves the bass and the drums."
              >
                <span aria-hidden="true">{padEnabled ? '●' : '○'}</span>
                Pad
                <strong>{padEnabled ? 'On' : 'Off'}</strong>
              </button>
            </div>
            {isSingFreely && (
              <div className="mix-levels" aria-label="Sing Freely accompaniment levels">
                <label>
                  <span>
                    Backing band <output>{formatDb(backingVolume)}</output>
                  </span>
                  <input
                    type="range"
                    min="-24"
                    max="6"
                    step="1"
                    value={backingVolume}
                    disabled={!live || !backingEnabled}
                    onChange={(event) => changeBackingVolume(Number(event.target.value))}
                  />
                </label>
                <label>
                  <span>
                    Auto guitar <output>{formatDb(singFreelyGuitarVolume)}</output>
                  </span>
                  <input
                    type="range"
                    min="-24"
                    max="6"
                    step="1"
                    value={singFreelyGuitarVolume}
                    disabled={!live}
                    onChange={(event) => changeSingFreelyGuitarVolume(Number(event.target.value))}
                  />
                </label>
              </div>
            )}
          </div>

          <div className="control-section vocals-sidebar">
            <span className="control-label">Vocals</span>
            {isSingFreely && (
              <div className="live-harmony">
                <label>
                  <span>Key</span>
                  <select
                    className="select select--sm"
                    value={harmony?.keyOverride ?? 'auto'}
                    disabled={!live}
                    onChange={(event) => changeSingingKey(event.target.value)}
                  >
                    <option value="auto">Auto-detect</option>
                    {MAJOR_KEY_OPTIONS.map((key) => (
                      <option key={key.value} value={key.value}>
                        {key.label} major
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            )}
            {vocalCue && (
              <button
                type="button"
                className="vocal-cue"
                aria-label={`Play starting vocal note ${vocalCue.pitch} for ${vocalCue.lyric}, sung over ${vocalCue.chord}`}
                title={`Click to hear ${vocalCue.pitch}`}
                onClick={() => void playVocalCue(vocalCue.pitch)}
              >
                <span>Starting note</span>
                <span className="vocal-cue__pitch">
                  <strong>{vocalCue.pitch}</strong>
                  <b>on {vocalCue.chord}</b>
                </span>
                <small>“{vocalCue.lyric}”</small>
              </button>
            )}
            <button
              type="button"
              className="mic-button mic-button--sidebar"
              data-enabled={singerInfo?.enabled ? '' : undefined}
              disabled={!live || (!isSingFreely && singerId < 0) || micPending || singerInfo?.available === false}
              onClick={() => void toggleSinger()}
            >
              <span className="mic-button__dot" aria-hidden="true" />
              {micPending
                ? 'Requesting microphone…'
                : singerInfo?.available === false
                  ? 'Microphone unavailable'
                  : singerInfo?.enabled
                    ? 'Turn microphone off'
                    : 'Enable microphone'}
            </button>
            <div className="mic-level" aria-label={`Microphone level ${Math.round((singerInfo?.level ?? 0) * 100)}%`}>
              <span>Level</span>
              <i>
                <b style={{ width: `${Math.round((singerInfo?.level ?? 0) * 100)}%` }} />
              </i>
            </div>
            {microphones.length > 0 && (
              <label className="mic-input-picker">
                <span>Input</span>
                <select
                  className="select select--sm"
                  value={micDeviceId}
                  disabled={micPending}
                  onChange={(event) => void onPickMicrophone(event.target.value)}
                  aria-label="Microphone input"
                >
                  {microphones.map((microphone) => (
                    <option key={microphone.deviceId} value={microphone.deviceId}>
                      {microphone.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div className="vocals-sidebar__effects">
              <label>
                <span>
                  Mic gain <output>{Math.round(micGain * 100)}%</output>
                </span>
                <input
                  type="range"
                  min="0"
                  max="2"
                  step="0.05"
                  value={micGain}
                  disabled={!live}
                  aria-label="Microphone gain"
                  title="Levels above 100% boost quiet microphones and may cause feedback."
                  onChange={(event) => changeMicGain(Number(event.target.value))}
                />
              </label>
              <label>
                <span>
                  Echo <output>{Math.round(echo * 100)}%</output>
                </span>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={echo}
                  disabled={!live}
                  onChange={(event) => changeEcho(Number(event.target.value))}
                />
              </label>
              <label>
                <span>
                  Reverb <output>{Math.round(reverb * 100)}%</output>
                </span>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={reverb}
                  disabled={!live}
                  onChange={(event) => changeReverb(Number(event.target.value))}
                />
              </label>
            </div>
          </div>
        </div>

        <div
          className="stage"
          style={{ aspectRatio: aspect }}
          data-harmony-drop={harmonyPanelDragging && harmonyPanelPlacement === 'below' ? '' : undefined}
          onDragOver={allowHarmonyPanelDrop}
          onDrop={(event) => dropHarmonyPanel(event, 'stage')}
        >
          <video ref={videoRef} className="stage__video" />
          <canvas ref={canvasRef} className="stage__canvas" />
          <div className="toast-stack" aria-live="polite" aria-relevant="additions">
            {toasts.map((toast) => (
              <div className="toast" data-kind={toast.kind} key={toast.id}>
                {toast.text}
              </div>
            ))}
          </div>
          {live && !showPlayerSetup && (
            <>
              {playerCount === 2 && <div className="stage__split-guide" aria-hidden="true" />}
              <div className="player-badges" data-count={playerCount}>
                {visiblePlayers.map((player, playerId) => {
                  const hands = sessionInfo?.players[playerId]?.hands ?? 0;
                  const ready = player.instrument === 'none' ? player.vocals : hands > 0;
                  return (
                    <div
                      className="player-badge"
                      data-player={playerId + 1}
                      data-ready={ready ? '' : undefined}
                      data-vocals={player.vocals ? '' : undefined}
                      key={playerId}
                    >
                      <span>P{playerId + 1}</span>
                      <div>
                        <strong>{instrumentLabel(player.instrument)}</strong>
                        <small>
                          {ready
                            ? player.instrument === 'none'
                              ? 'Ready'
                              : `${hands} ${hands === 1 ? 'hand' : 'hands'}`
                            : 'Waiting'}
                          {player.vocals && player.instrument !== 'none' ? ' · vocals' : ''}
                        </small>
                      </div>
                      {playerCount === 2 && (
                        <button
                          className="player-badge__calibrate"
                          type="button"
                          onClick={() => sessionRef.current?.calibrate(playerId)}
                          disabled={player.instrument === 'none' || hands === 0}
                          aria-label={`Calibrate Player ${playerId + 1}`}
                        >
                          Calibrate
                        </button>
                      )}
                      <i aria-hidden="true" />
                    </div>
                  );
                })}
              </div>
            </>
          )}
          {live &&
            (isSingFreely ? (
              <div className="karaoke-hud karaoke-hud--live">
                <div className="karaoke-hud__song">
                  <span>{SING_FREELY_SONG.title}</span>
                  <small>{songInfo?.running ? 'Live accompaniment' : 'Ready when you are'}</small>
                </div>
                <div className="karaoke-hud__beat" aria-label={`Beat ${(songInfo?.beat ?? 0) + 1}`}>
                  {Array.from({ length: sessionInfo?.beatsPerBar ?? 4 }, (_, beat) => (
                    <i key={beat} data-active={songInfo?.running && beat === songInfo.beat ? '' : undefined} />
                  ))}
                </div>
              </div>
            ) : (
              <div className="karaoke-hud" aria-live="polite">
                <div className="karaoke-hud__song">
                  <span>{songInfo?.running ? songInfo.title : SONGS[songId]?.title}</span>
                  <small>
                    {songInfo?.running
                      ? `${songInfo.section ?? 'Song'} · bar ${(songInfo.bar % Math.max(songInfo.barCount, 1)) + 1}`
                      : 'Choose a song, then press Play'}
                  </small>
                </div>
                <div className="karaoke-hud__chords">
                  <div>
                    <small>Now</small>
                    <strong>{songInfo?.chord ?? '—'}</strong>
                  </div>
                  <span aria-hidden="true">→</span>
                  <div>
                    <small>Next</small>
                    <strong>{songInfo?.nextChord ?? '—'}</strong>
                  </div>
                </div>
                <div className="karaoke-hud__beat" aria-label={`Beat ${(songInfo?.beat ?? 0) + 1}`}>
                  {Array.from({ length: sessionInfo?.beatsPerBar ?? 4 }, (_, beat) => (
                    <i key={beat} data-active={songInfo?.running && beat === songInfo.beat ? '' : undefined} />
                  ))}
                </div>
                <div className="karaoke-hud__progress" aria-hidden="true">
                  <i style={{ width: `${songProgress}%` }} />
                </div>
              </div>
            ))}
          {harmonyPanelPlacement === 'stage' && liveHarmonyPanel}
          {live && songInfo?.countIn?.active && (
            <div className="count-in" role="status">
              <span>Get ready</span>
              <strong>{Math.max(1, songInfo.countIn.beats - songInfo.countIn.beat)}</strong>
            </div>
          )}
          {showWelcome ? (
            <div className="stage__welcome">
              <p className="stage__kicker">Acapella is way overrated</p>
              <h2>Ready to band alone?</h2>
              <button className="stage__start" type="button" onClick={() => setWelcomed(true)}>
                <span aria-hidden="true">▶</span> Start
              </button>
            </div>
          ) : showPlayerSetup ? (
            <div className="player-setup" data-editing={active ? '' : undefined}>
              <div className="player-setup__head">
                <div>
                  <p className="stage__kicker">{active ? 'Band setup' : 'Acapella is way overrated'}</p>
                  <h2>{active ? 'Edit your players' : 'Who’s playing?'}</h2>
                </div>
                <div className="player-count" role="group" aria-label="Number of players">
                  <button type="button" aria-pressed={playerCount === 1} onClick={() => setPlayerCount(1)}>
                    One player
                  </button>
                  <button type="button" aria-pressed={playerCount === 2} onClick={() => setPlayerCount(2)}>
                    Two players
                  </button>
                </div>
              </div>
              <div className="player-setup__cards" data-count={playerCount}>
                {visiblePlayers.map((player, playerId) => (
                  <PlayerCard
                    key={playerId}
                    playerId={playerId as 0 | 1}
                    setup={player}
                    live={live}
                    hands={sessionInfo?.players[playerId]?.hands ?? 0}
                    onInstrument={(instrument) => updatePlayerInstrument(playerId as 0 | 1, instrument)}
                    onVocals={() => togglePlayerVocals(playerId as 0 | 1)}
                  />
                ))}
              </div>
              <div className="player-setup__actions">
                <button className="stage__start" type="button" onClick={active ? applyPlayerSetup : startBand}>
                  <span aria-hidden="true">{active ? '✓' : '▶'}</span> {active ? 'Done' : 'Start band'}
                </button>
              </div>
            </div>
          ) : phase !== 'running' ? (
            <div className="stage__status">
              <p>{PHASE_TEXT[phase]}</p>
              {detail && <p className="stage__detail">{detail}</p>}
            </div>
          ) : null}
        </div>

        <div className="console__foot">
          <div className="console__group">
            <span className="status" data-tone={status.tone}>
              <i />
              {status.label}
            </span>
            {visiblePlayers.map((player, playerId) => (
              <span className="instrument-chip" data-player={playerId + 1} key={playerId}>
                P{playerId + 1} · {instrumentLabel(player.instrument)}
              </span>
            ))}
            {SHOW_MODE_CONTROLS && <span className="instrument-chip">{mode}</span>}
            <span className="hint">
              <kbd>C</kbd> calibrate · <kbd>space</kbd> kick
            </span>
          </div>
          <div className="console__group">
            <span className="readout">
              {stats && live
                ? `${stats.fps.toFixed(0)} fps · ${stats.inferenceMs.toFixed(1)} ms · ` +
                  `${stats.hands} hand${stats.hands === 1 ? '' : 's'} · ${stats.width}×${stats.height}`
                : detail}
            </span>
            {cameras.length > 1 && (
              <select
                className="select select--sm"
                value={deviceId}
                onChange={(e) => void onPickCamera(e.target.value)}
                aria-label="Camera"
              >
                {cameras.map((c) => (
                  <option key={c.deviceId} value={c.deviceId}>
                    {c.label}
                  </option>
                ))}
              </select>
            )}
            <button className="btn btn--quiet" onClick={() => setShowDebug((v) => !v)} title="Toggle debug panel (`)">
              Debug
            </button>
          </div>
          <details className="app__config">
            <summary>
              <span>Config</span>
              <button
                type="button"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  resetConfigControls(config);
                  refreshConfig((value) => value + 1);
                }}
              >
                Reset
              </button>
            </summary>
            <ConfigControls config={config} />
          </details>
        </div>
      </div>

      {live && isSingFreely && (
        <div
          className="harmony-dock"
          data-empty={harmonyPanelPlacement === 'stage' ? '' : undefined}
          data-drag-active={harmonyPanelDragging ? '' : undefined}
          onDragOver={allowHarmonyPanelDrop}
          onDrop={(event) => dropHarmonyPanel(event, 'below')}
        >
          {harmonyPanelPlacement === 'below' ? (
            liveHarmonyPanel
          ) : (
            <div className="harmony-dock__target" role="region" aria-label="Live notes drop area">
              <strong>Live notes dock</strong>
              <span>Drag the note panel here or use its corner arrow.</span>
            </div>
          )}
        </div>
      )}

      {showDebug && session && <DebugPanel session={session} config={config} onClose={() => setShowDebug(false)} />}
    </section>
  );
}
