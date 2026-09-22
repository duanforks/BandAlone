import { beforeEach, describe, expect, it, vi } from 'vitest';

const tone = vi.hoisted(() => ({
  gains: [] as Array<{ input: object; gain: { value: number }; connections: unknown[]; disposed: boolean }>,
  delays: [] as Array<{ wet: { value: number }; disposed: boolean }>,
  reverbs: [] as Array<{ wet: { value: number }; disposed: boolean }>,
  meters: [] as Array<{ value: number | number[]; disposed: boolean }>,
  sources: [] as Array<{ connections: unknown[]; disconnected: boolean }>,
}));

vi.mock('tone', () => {
  class Gain {
    readonly input = {};
    readonly gain: { value: number };
    readonly connections: unknown[] = [];
    disposed = false;

    constructor(value: number) {
      this.gain = { value };
      tone.gains.push(this);
    }

    connect(destination: unknown) {
      this.connections.push(destination);
      return this;
    }

    chain(...nodes: unknown[]) {
      this.connections.push(...nodes);
      return this;
    }

    dispose() {
      this.disposed = true;
      return this;
    }
  }

  class FeedbackDelay {
    readonly wet: { value: number };
    disposed = false;

    constructor(options: { wet: number }) {
      this.wet = { value: options.wet };
      tone.delays.push(this);
    }

    dispose() {
      this.disposed = true;
      return this;
    }
  }

  class Reverb {
    readonly wet: { value: number };
    disposed = false;

    constructor(options: { wet: number }) {
      this.wet = { value: options.wet };
      tone.reverbs.push(this);
    }

    dispose() {
      this.disposed = true;
      return this;
    }
  }

  class Meter {
    value: number | number[] = 0;
    disposed = false;

    constructor() {
      tone.meters.push(this);
    }

    getValue() {
      return this.value;
    }

    dispose() {
      this.disposed = true;
      return this;
    }
  }

  return {
    Gain,
    FeedbackDelay,
    Reverb,
    Meter,
    getContext: () => ({
      rawContext: {
        createMediaStreamSource: () => {
          const source = {
            connections: [] as unknown[],
            disconnected: false,
            connect(destination: unknown) {
              source.connections.push(destination);
            },
            disconnect() {
              source.disconnected = true;
            },
          };
          tone.sources.push(source);
          return source;
        },
      },
    }),
  };
});

import { DEFAULT_CONFIG } from '@/app/config';
import { SingerChannel } from '@/audio/singer';
import { bus } from '@/core/bus';

interface FakeStream {
  stream: MediaStream;
  track: { stopped: boolean; stop: () => void; getSettings: () => MediaTrackSettings };
}

function fakeStream(deviceId: string): FakeStream {
  const track = {
    stopped: false,
    stop() {
      track.stopped = true;
    },
    getSettings: () => ({ deviceId }),
  };
  return {
    stream: {
      active: true,
      getTracks: () => [track],
      getAudioTracks: () => [track],
    } as unknown as MediaStream,
    track,
  };
}

const getUserMedia = vi.fn<(constraints: MediaStreamConstraints) => Promise<MediaStream>>();
const enumerateDevices = vi.fn<() => Promise<MediaDeviceInfo[]>>();

function makeSinger(deviceId = ''): SingerChannel {
  const config = structuredClone(DEFAULT_CONFIG.singer);
  config.deviceId = deviceId;
  return new SingerChannel(config, () => ({ name: 'master' }) as never);
}

beforeEach(() => {
  tone.gains.length = 0;
  tone.delays.length = 0;
  tone.reverbs.length = 0;
  tone.meters.length = 0;
  tone.sources.length = 0;
  getUserMedia.mockReset();
  enumerateDevices.mockReset();
  enumerateDevices.mockResolvedValue([]);
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { mediaDevices: { getUserMedia, enumerateDevices } },
  });
});

describe('SingerChannel', () => {
  it('opens the selected mono input with browser voice processing off and builds the live effects chain', async () => {
    const mic = fakeStream('wired-mic');
    getUserMedia.mockResolvedValue(mic.stream);
    const singer = makeSinger('wired-mic');

    await singer.setEnabled(true);

    expect(getUserMedia).toHaveBeenCalledWith({
      audio: {
        channelCount: { ideal: 1 },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        deviceId: { exact: 'wired-mic' },
      },
      video: false,
    });
    expect(singer.info()).toMatchObject({ enabled: true, deviceId: 'wired-mic', error: null });
    expect(tone.sources[0].connections).toContain(tone.gains[0].input);
    expect(tone.gains[0].connections).toEqual([tone.meters[0], tone.delays[0], tone.reverbs[0], { name: 'master' }]);

    tone.meters[0].value = 0.42;
    expect(singer.level).toBe(0.42);
    singer.setGain(1.6);
    singer.setEcho(0.6);
    singer.setReverb(2);
    expect(tone.gains[0].gain.value).toBe(1.6);
    expect(tone.delays[0].wet.value).toBe(0.6);
    expect(tone.reverbs[0].wet.value).toBe(1);
    expect(singer.info().gain).toBe(1.6);

    await singer.setEnabled(false);
    expect(mic.track.stopped).toBe(true);
    expect(tone.sources[0].disconnected).toBe(true);
    expect(tone.gains[0].disposed).toBe(true);
    expect(singer.info()).toMatchObject({ enabled: false, level: 0, error: null });
  });

  it('lists audio inputs and safely reopens a live channel on a different device', async () => {
    const first = fakeStream('earbuds');
    const second = fakeStream('iphone');
    getUserMedia.mockResolvedValueOnce(first.stream).mockResolvedValueOnce(second.stream);
    enumerateDevices.mockResolvedValue([
      { kind: 'audioinput', deviceId: 'earbuds', label: 'External Microphone' },
      { kind: 'videoinput', deviceId: 'camera', label: 'Camera' },
      { kind: 'audioinput', deviceId: 'iphone', label: 'iPhone Microphone' },
    ] as MediaDeviceInfo[]);
    const singer = makeSinger();

    await singer.setEnabled(true);
    expect(await singer.list()).toEqual([
      { deviceId: 'earbuds', label: 'External Microphone' },
      { deviceId: 'iphone', label: 'iPhone Microphone' },
    ]);

    await singer.setDevice('iphone');
    expect(first.track.stopped).toBe(true);
    expect(singer.deviceId).toBe('iphone');
    expect(getUserMedia).toHaveBeenLastCalledWith(
      expect.objectContaining({ audio: expect.objectContaining({ deviceId: { exact: 'iphone' } }) }),
    );

    singer.dispose();
    expect(second.track.stopped).toBe(true);
    expect(singer.enabled).toBe(false);
  });

  it('stops a stream whose permission response arrives after the mic was disabled', async () => {
    const late = fakeStream('late');
    let resolveRequest: (stream: MediaStream) => void = () => {};
    getUserMedia.mockImplementation(
      () =>
        new Promise<MediaStream>((resolve) => {
          resolveRequest = resolve;
        }),
    );
    const singer = makeSinger();

    const opening = singer.setEnabled(true);
    await singer.setEnabled(false);
    resolveRequest(late.stream);
    await opening;

    expect(late.track.stopped).toBe(true);
    expect(singer.enabled).toBe(false);
    expect(tone.gains).toHaveLength(0);
  });

  it('reports a permission failure without leaving the channel enabled', async () => {
    getUserMedia.mockRejectedValue(new DOMException('Permission denied', 'NotAllowedError'));
    const singer = makeSinger();
    const toasts: string[] = [];
    const off = bus.on('ui.toast', (event) => toasts.push(event.text));

    await singer.setEnabled(true);

    expect(singer.enabled).toBe(false);
    expect(singer.error).toContain('permission was denied');
    expect(toasts.at(-1)).toBe(singer.error);
    off();
  });
});
