import * as Tone from 'tone';
import type { ToneAudioNode } from 'tone';
import type { Config } from '@/app/config';
import { bus } from '@/core/bus';
import type { SingerInfo } from '@/app/sessionInfo';
import { detectPitch, SingingHarmonizer } from './harmonizer';

export interface MicrophoneInfo {
  deviceId: string;
  label: string;
}

/**
 * The singer: a microphone channel with echo and reverb into the master
 * output. Not an Instrument (no detectors, no gestures); the UI drives it
 * through `session.singer`.
 */
export class SingerChannel {
  readonly harmonizer = new SingingHarmonizer();
  private isEnabled = false;
  private lastError: string | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private analysisBuffer: Float32Array<ArrayBuffer> | null = null;
  private analysisTimer: ReturnType<typeof setInterval> | null = null;
  private inputGain: Tone.Gain | null = null;
  private echo: Tone.FeedbackDelay | null = null;
  private reverb: Tone.Reverb | null = null;
  private meter: Tone.Meter | null = null;
  /** Bumped whenever a request is replaced so a late permission response cannot reopen the mic. */
  private generation = 0;

  constructor(
    private readonly config: Config['singer'],
    /** Master output to connect to (available once the audio engine started). */
    protected readonly output: () => ToneAudioNode,
  ) {}

  get enabled(): boolean {
    return this.isEnabled;
  }

  /** false when the browser has no microphone API (or the page is not on HTTPS/localhost). */
  get available(): boolean {
    return typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getUserMedia === 'function';
  }

  /** Input level, 0..1. */
  get level(): number {
    if (!this.meter) return 0;
    const value = this.meter.getValue();
    const peak = Array.isArray(value) ? Math.max(...value) : value;
    return Number.isFinite(peak) ? clamp(peak) : 0;
  }

  get error(): string | null {
    return this.lastError;
  }

  /** The device the browser actually opened (which can differ from the requested default). */
  get deviceId(): string {
    return this.stream?.getAudioTracks()[0]?.getSettings().deviceId ?? this.config.deviceId;
  }

  /** Open or close the mic. Resolves once the change took effect; failures land in `error` and a toast. */
  async setEnabled(on: boolean): Promise<void> {
    this.config.enabled = on;
    if (!on) {
      this.generation++;
      this.close();
      this.lastError = null;
      return;
    }
    await this.open();
  }

  /** Select a browser audio input. A live channel is reopened on the new device. */
  async setDevice(deviceId: string): Promise<void> {
    if (deviceId === this.config.deviceId && (!this.isEnabled || deviceId === this.deviceId)) return;
    this.config.deviceId = deviceId;
    if (this.isEnabled) await this.open();
    else this.lastError = null;
  }

  /** Audio inputs visible to the browser. Labels appear after microphone permission is granted. */
  async list(): Promise<MicrophoneInfo[]> {
    if (!this.available || typeof navigator.mediaDevices.enumerateDevices !== 'function') return [];
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices
        .filter((device) => device.kind === 'audioinput')
        .map((device, index) => ({ deviceId: device.deviceId, label: device.label || `Microphone ${index + 1}` }));
    } catch {
      return [];
    }
  }

  /** Echo wet amount, 0..1. */
  setEcho(amount: number): void {
    this.config.echo = clamp(amount);
    if (this.echo) this.echo.wet.value = this.config.echo;
  }

  /** Reverb wet amount, 0..1. */
  setReverb(amount: number): void {
    this.config.reverb = clamp(amount);
    if (this.reverb) this.reverb.wet.value = this.config.reverb;
  }

  /** Linear microphone gain, 0..2. Values above 1 boost quiet inputs. */
  setGain(amount: number): void {
    this.config.gain = clampRange(amount, 0, 2);
    if (this.inputGain) this.inputGain.gain.value = this.config.gain;
  }

  setHarmonyActive(active: boolean): void {
    this.harmonizer.setActive(active);
  }

  /** null = estimate the major key from the melody. */
  setHarmonyKey(key: string | null): void {
    this.harmonizer.setKeyOverride(key);
  }

  info(): SingerInfo {
    const harmony = this.harmonizer.snapshot();
    return {
      enabled: this.enabled,
      available: this.available,
      level: this.level,
      gain: this.config.gain,
      echo: this.config.echo,
      reverb: this.config.reverb,
      deviceId: this.deviceId,
      error: this.error,
      harmony,
    };
  }

  dispose(): void {
    this.generation++;
    this.close();
    this.config.enabled = false;
  }

  private async open(): Promise<void> {
    const generation = ++this.generation;
    this.close();
    this.lastError = null;

    if (!this.available) {
      this.fail('No microphone available. Use Chrome on localhost or an HTTPS page.');
      return;
    }

    const audio: MediaTrackConstraints = {
      channelCount: { ideal: 1 },
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    };
    if (this.config.deviceId) audio.deviceId = { exact: this.config.deviceId };

    let stream: MediaStream | null = null;
    let source: MediaStreamAudioSourceNode | null = null;
    let analyser: AnalyserNode | null = null;
    let inputGain: Tone.Gain | null = null;
    let echo: Tone.FeedbackDelay | null = null;
    let reverb: Tone.Reverb | null = null;
    let meter: Tone.Meter | null = null;

    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
      if (generation !== this.generation) {
        stopStream(stream);
        return;
      }

      const rawContext = Tone.getContext().rawContext as AudioContext;
      source = rawContext.createMediaStreamSource(stream);
      if (typeof rawContext.createAnalyser === 'function') {
        analyser = rawContext.createAnalyser();
        analyser.fftSize = 4096;
        analyser.smoothingTimeConstant = 0;
        source.connect(analyser);
      }
      inputGain = new Tone.Gain(this.config.gain);
      echo = new Tone.FeedbackDelay({ delayTime: 0.22, feedback: 0.28, wet: this.config.echo });
      reverb = new Tone.Reverb({ decay: 1.8, preDelay: 0.01, wet: this.config.reverb });
      meter = new Tone.Meter({ normalRange: true, smoothing: 0.82, channelCount: 1 });

      source.connect(inputGain.input);
      inputGain.connect(meter);
      inputGain.chain(echo, reverb, this.output());

      this.stream = stream;
      this.source = source;
      this.analyser = analyser;
      this.analysisBuffer = analyser ? new Float32Array(analyser.fftSize) : null;
      this.inputGain = inputGain;
      this.echo = echo;
      this.reverb = reverb;
      this.meter = meter;
      this.isEnabled = true;
      this.config.enabled = true;
      this.config.deviceId = this.deviceId;
      if (analyser) this.startAnalysis(rawContext.sampleRate);
    } catch (error) {
      source?.disconnect();
      analyser?.disconnect();
      stopStream(stream);
      meter?.dispose();
      reverb?.dispose();
      echo?.dispose();
      inputGain?.dispose();
      if (generation === this.generation) this.fail(microphoneError(error));
    }
  }

  private fail(message: string): void {
    this.close();
    this.config.enabled = false;
    this.lastError = message;
    bus.emit({ type: 'ui.toast', t: performance.now(), text: message, kind: 'warn' });
  }

  private close(): void {
    this.isEnabled = false;
    if (this.analysisTimer !== null) clearInterval(this.analysisTimer);
    this.analysisTimer = null;
    this.analysisBuffer = null;
    this.analyser?.disconnect();
    this.analyser = null;
    this.source?.disconnect();
    this.source = null;
    stopStream(this.stream);
    this.stream = null;
    this.meter?.dispose();
    this.meter = null;
    this.reverb?.dispose();
    this.reverb = null;
    this.echo?.dispose();
    this.echo = null;
    this.inputGain?.dispose();
    this.inputGain = null;
  }

  private startAnalysis(sampleRate: number): void {
    if (this.analysisTimer !== null) clearInterval(this.analysisTimer);
    this.analysisTimer = setInterval(() => {
      const analyser = this.analyser;
      const buffer = this.analysisBuffer;
      if (!analyser || !buffer || !this.harmonizer.active) return;
      analyser.getFloatTimeDomainData(buffer);
      const estimate = detectPitch(buffer, sampleRate);
      if (estimate) this.harmonizer.observe(estimate);
      else this.harmonizer.observeSilence();
    }, 50);
  }
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function clampRange(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function stopStream(stream: MediaStream | null): void {
  for (const track of stream?.getTracks() ?? []) track.stop();
}

function microphoneError(error: unknown): string {
  if (!(error instanceof DOMException)) return error instanceof Error ? error.message : 'Could not open the microphone';
  switch (error.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Microphone permission was denied. Allow microphone access in Chrome and try again.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'The selected microphone is no longer available. Connect it and try again.';
    case 'NotReadableError':
      return 'The microphone is busy in another app. Close that app and try again.';
    default:
      return `Could not open the microphone: ${error.message || error.name}`;
  }
}
