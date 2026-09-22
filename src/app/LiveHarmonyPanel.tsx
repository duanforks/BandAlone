import type { CSSProperties } from 'react';
import type { HarmonyNote, HarmonySnapshot } from '@/audio/harmonizer';
import type { ChordName } from '@/core/types';

const PITCH_COLORS = [
  '#ff6b5e',
  '#ff8a4c',
  '#f3b83f',
  '#c7c94a',
  '#75c86a',
  '#42c59b',
  '#3fc2c9',
  '#4aa9e8',
  '#7288ed',
  '#9b72e8',
  '#c966d4',
  '#e4619b',
] as const;

const LETTER_INDEX = [0, 0, 1, 1, 2, 3, 3, 4, 4, 5, 5, 6] as const;
const SHARP_PITCH_CLASSES = new Set([1, 3, 6, 8, 10]);
const STAFF_BASELINE_Y = 90;
const STAFF_HALF_STEP = 5;
const STAFF_FIRST_X = 112;
const STAFF_LAST_X = 930;

interface LiveHarmonyPanelProps {
  harmony?: HarmonySnapshot;
  chord: ChordName | null;
  beat: number;
  beatsPerBar: number;
  running: boolean;
  micEnabled: boolean;
}

function staffStep(note: HarmonyNote): number {
  const octave = Math.floor(note.midi / 12) - 1;
  const diatonicIndex = octave * 7 + LETTER_INDEX[note.pitchClass];
  const e4Index = 4 * 7 + 2;
  return diatonicIndex - e4Index;
}

function noteY(note: HarmonyNote): number {
  const raw = STAFF_BASELINE_Y - staffStep(note) * STAFF_HALF_STEP;
  // Keep extreme vocal notes clear of the key-window label while the octave
  // remains explicit in the note name below the staff.
  return Math.max(20, Math.min(126, raw));
}

function ledgerLines(note: HarmonyNote): number[] {
  const y = noteY(note);
  const lines: number[] = [];
  if (y > STAFF_BASELINE_Y) {
    for (let line = STAFF_BASELINE_Y + 10; line <= y + 2; line += 10) lines.push(line);
  } else if (y < 50) {
    for (let line = 40; line >= y - 2; line -= 10) lines.push(line);
  }
  return lines;
}

function noteX(index: number): number {
  return STAFF_FIRST_X + index * ((STAFF_LAST_X - STAFF_FIRST_X) / 11);
}

export function LiveHarmonyPanel({
  harmony,
  chord,
  beat,
  beatsPerBar,
  running,
  micEnabled,
}: LiveHarmonyPanelProps) {
  const notes = harmony?.recentNotes ?? [];
  const newestId = notes.at(-1)?.id;
  const keyLocked = harmony?.keyOverride !== null && harmony?.keyOverride !== undefined;
  const keyReady = harmony?.keyReady ?? false;
  const keyLabel = keyLocked
    ? `${harmony?.key ?? 'G'} major · locked`
    : keyReady
      ? `${harmony?.key ?? 'G'} major · ${Math.round((harmony?.keyConfidence ?? 0) * 100)}%`
      : `Listening · ${notes.length}/${harmony?.keyWindowSize ?? 12} notes`;
  const status = !micEnabled
    ? 'Microphone off'
    : !running
      ? 'Press Start to sing freely'
      : harmony?.detectedNote
        ? `Hearing ${harmony.detectedNote}`
        : 'Sing a note';
  const chordHistory = harmony?.recentChords ?? [];
  const windowStart = notes.length ? noteX(0) - 22 : STAFF_FIRST_X - 22;
  const windowEnd = notes.length ? noteX(notes.length - 1) + 22 : STAFF_FIRST_X + 22;
  const spokenSummary = `${keyLabel}. ${chord ? `Playing ${chord}.` : 'No chord playing.'}`;

  return (
    <section className="live-harmony-panel" aria-label="Live singing harmony">
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {spokenSummary}
      </div>
      <div className="live-harmony-panel__staff" aria-hidden="true">
        <svg viewBox="0 0 1000 180" preserveAspectRatio="xMidYMid meet">
          <g className="live-staff__lines">
            {Array.from({ length: 5 }, (_, index) => (
              <line key={index} x1="70" x2="970" y1={50 + index * 10} y2={50 + index * 10} />
            ))}
          </g>
          <text className="live-staff__clef" x="24" y="101">
            𝄞
          </text>
          {notes.map((note, index) => {
            const x = noteX(index);
            const y = noteY(note);
            const color = PITCH_COLORS[note.pitchClass];
            const style = { '--note-color': color } as CSSProperties;
            return (
              <g
                className="live-staff__note"
                key={note.id}
                data-newest={note.id === newestId ? '' : undefined}
                style={style}
              >
                {ledgerLines(note).map((ledgerY) => (
                  <line className="live-staff__ledger" key={ledgerY} x1={x - 14} x2={x + 14} y1={ledgerY} y2={ledgerY} />
                ))}
                {SHARP_PITCH_CLASSES.has(note.pitchClass) && (
                  <text className="live-staff__accidental" x={x - 18} y={y + 5}>
                    ♯
                  </text>
                )}
                {note.id === newestId && <circle className="live-staff__pulse" cx={x} cy={y} r="11" />}
                <ellipse className="live-staff__notehead" cx={x} cy={y} rx="10" ry="7" transform={`rotate(-18 ${x} ${y})`} />
                <text className="live-staff__label" x={x} y="147">
                  {note.name}
                </text>
              </g>
            );
          })}
          <g className="live-staff__window">
            <line x1={windowStart} x2={windowEnd} y1="163" y2="163" />
            <line x1={windowStart} x2={windowStart} y1="157" y2="169" />
            <line x1={windowEnd} x2={windowEnd} y1="157" y2="169" />
            <text x={(windowStart + windowEnd) / 2} y="176">
              Key window · {notes.length}/{harmony?.keyWindowSize ?? 12}
            </text>
          </g>
        </svg>
      </div>
      <div className="live-harmony-panel__readout">
        <div className="live-harmony-panel__key" data-ready={keyReady ? '' : undefined}>
          <small>Detected key</small>
          <strong>{keyLabel}</strong>
          <span>{status}</span>
        </div>
        <div className="live-harmony-panel__playing">
          <small>Playing</small>
          <strong>{chord ?? '—'}</strong>
          <div className="live-harmony-panel__chord-history" aria-label="Recent accompaniment chords">
            {chordHistory.length ? (
              chordHistory.map((event) => (
                <span key={event.id} data-current={event.id === chordHistory.at(-1)?.id ? '' : undefined}>
                  {event.chord}
                </span>
              ))
            ) : (
              <span>Waiting</span>
            )}
          </div>
        </div>
        <div className="live-harmony-panel__beat" aria-label={`Beat ${beat + 1} of ${beatsPerBar}`}>
          <small>Beat</small>
          <div>
            {Array.from({ length: beatsPerBar }, (_, index) => (
              <i key={index} data-active={running && index === beat ? '' : undefined} />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
