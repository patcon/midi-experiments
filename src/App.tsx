import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import * as Tone from 'tone'
import { Midi } from '@tonejs/midi'
import './App.css'

interface NoteEvent {
  note: number
  velocity: number
  time: number     // absolute time in seconds
  duration: number // note duration in seconds
}

interface Track {
  name: string
  bpm: number | null
  notes: NoteEvent[]
}

type DeckId = 'A' | 'B'

// Salamander Grand Piano samples (used by Tone.js Sampler)
// Keys are Tone.js note names; values are the actual Salamander filenames
const SALAMANDER_URLS: Record<string, string> = {
  A0: 'A0.mp3', C1: 'C1.mp3', 'D#1': 'Ds1.mp3', 'F#1': 'Fs1.mp3',
  A1: 'A1.mp3', C2: 'C2.mp3', 'D#2': 'Ds2.mp3', 'F#2': 'Fs2.mp3',
  A2: 'A2.mp3', C3: 'C3.mp3', 'D#3': 'Ds3.mp3', 'F#3': 'Fs3.mp3',
  A3: 'A3.mp3', C4: 'C4.mp3', 'D#4': 'Ds4.mp3', 'F#4': 'Fs4.mp3',
  A4: 'A4.mp3', C5: 'C5.mp3', 'D#5': 'Ds5.mp3', 'F#5': 'Fs5.mp3',
  A5: 'A5.mp3', C6: 'C6.mp3', 'D#6': 'Ds6.mp3', 'F#6': 'Fs6.mp3',
  A6: 'A6.mp3', C7: 'C7.mp3', 'D#7': 'Ds7.mp3', 'F#7': 'Fs7.mp3',
  A7: 'A7.mp3', C8: 'C8.mp3',
}
const SALAMANDER_BASE = 'https://tonejs.github.io/audio/salamander/'

function parseMidi(data: ArrayBuffer): { notes: NoteEvent[]; bpm: number | null } {
  const midi = new Midi(data)
  const bpm = midi.header.tempos.length > 0 ? Math.round(midi.header.tempos[0].bpm) : null
  const notes: NoteEvent[] = []
  for (const track of midi.tracks) {
    for (const note of track.notes) {
      notes.push({
        note: note.midi,
        velocity: note.velocity,
        time: note.time,
        duration: note.duration,
      })
    }
  }
  return { notes: notes.sort((a, b) => a.time - b.time), bpm }
}


function WaveDisplay({ active }: { active: boolean }) {
  const bars = useMemo(
    () =>
      Array.from({ length: 20 }, () => ({
        d: (0.3 + Math.random() * 0.4).toFixed(2),
        del: (Math.random() * 0.3).toFixed(2),
        lo: Math.round(4 + Math.random() * 8),
        hi: Math.round(16 + Math.random() * 16),
      })),
    [],
  )

  return (
    <div className={`wave${active ? ' on' : ''}`}>
      {bars.map((bar, i) => (
        <div
          key={i}
          className="b"
          style={
            {
              '--d': `${bar.d}s`,
              '--del': `${bar.del}s`,
              '--lo': `${bar.lo}px`,
              '--hi': `${bar.hi}px`,
            } as React.CSSProperties
          }
        />
      ))}
    </div>
  )
}

function App() {
  const [tracks, setTracks] = useState<Track[]>(() => {
    try {
      const saved = localStorage.getItem('bk-crossfader-tracks-v2')
      return saved ? (JSON.parse(saved) as Track[]) : []
    } catch {
      return []
    }
  })
  const [assignments, setAssignments] = useState<Map<string, DeckId>>(new Map())
  const [faderValue, setFaderValue] = useState(50)
  const [isPlaying, setIsPlaying] = useState(false)
  const [status, setStatus] = useState('Upload two tracks and assign them to begin')
  const [statusError, setStatusError] = useState(false)
  const samplerARef = useRef<Tone.Sampler | null>(null)
  const samplerBRef = useRef<Tone.Sampler | null>(null)
  const endTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const deckATrack = tracks.find(t => assignments.get(t.name) === 'A')
  const deckBTrack = tracks.find(t => assignments.get(t.name) === 'B')
  const canPlay = (!!deckATrack || !!deckBTrack)

  useEffect(() => {
    if (!isPlaying) {
      if (deckATrack && deckBTrack) {
        setStatus(`Ready: A = ${deckATrack.name} | B = ${deckBTrack.name}`)
        setStatusError(false)
      } else if (deckATrack) {
        setStatus(`Ready: A = ${deckATrack.name}`)
        setStatusError(false)
      } else if (deckBTrack) {
        setStatus(`Ready: B = ${deckBTrack.name}`)
        setStatusError(false)
      } else if (tracks.length > 0) {
        setStatus('Assign a track to A or B to begin')
        setStatusError(false)
      }
    }
  }, [canPlay, deckATrack, deckBTrack, isPlaying, tracks.length])

  // Update sampler volumes in real-time as the fader moves during playback
  useEffect(() => {
    if (!isPlaying) return
    const volA = deckBTrack ? 1 - faderValue / 100 : 1
    const volB = deckATrack ? faderValue / 100 : 1
    if (samplerARef.current) samplerARef.current.volume.value = Tone.gainToDb(volA)
    if (samplerBRef.current) samplerBRef.current.volume.value = Tone.gainToDb(volB)
  }, [faderValue, isPlaying, deckATrack, deckBTrack])

  useEffect(() => {
    try {
      localStorage.setItem('bk-crossfader-tracks-v2', JSON.stringify(tracks))
    } catch (err) {
      console.warn('Failed to save tracks to localStorage:', err)
    }
  }, [tracks])

  const volAPercent = 100 - Math.round(faderValue)
  const volBPercent = Math.round(faderValue)

  const handleFileUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files || files.length === 0) return

    for (const file of files) {
      const reader = new FileReader()
      reader.onload = ev => {
        const data = ev.target?.result as ArrayBuffer
        try {
          const { notes, bpm } = parseMidi(data)
          if (notes.length > 0) {
            setTracks(prev => {
              if (prev.find(t => t.name === file.name)) return prev
              return [...prev, { name: file.name, bpm, notes }]
            })
            setStatusError(false)
          }
        } catch (err) {
          console.error('MIDI parse error:', err)
          setStatus('Error parsing MIDI file')
          setStatusError(true)
        }
      }
      reader.readAsArrayBuffer(file)
    }
    e.target.value = ''
  }, [])

  const handleRemove = useCallback((trackName: string) => {
    setTracks(prev => prev.filter(t => t.name !== trackName))
    setAssignments(prev => {
      const next = new Map(prev)
      next.delete(trackName)
      return next
    })
  }, [])

  const handleAssign = useCallback((trackName: string, deck: DeckId) => {
    setAssignments(prev => {
      const next = new Map(prev)
      if (next.get(trackName) === deck) {
        next.delete(trackName)
      } else {
        for (const [name, d] of next.entries()) {
          if (d === deck) next.delete(name)
        }
        next.set(trackName, deck)
      }
      return next
    })
  }, [])

  const handleFaderChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setFaderValue(Number(e.target.value))
  }, [])

  const stopPlayback = useCallback(() => {
    if (endTimerRef.current) { clearTimeout(endTimerRef.current); endTimerRef.current = null }
    Tone.Transport.stop()
    Tone.Transport.cancel()
    samplerARef.current?.dispose()
    samplerARef.current = null
    samplerBRef.current?.dispose()
    samplerBRef.current = null
  }, [])

  const handlePlay = useCallback(async () => {
    if (isPlaying) return
    if (!deckATrack && !deckBTrack) return

    // Must be first — AudioContext can only resume inside a user gesture
    await Tone.start()

    const volA = deckBTrack ? 1 - faderValue / 100 : 1
    const volB = deckATrack ? faderValue / 100 : 1

    setStatus('Loading samples...')
    setStatusError(false)

    const samplerA = deckATrack
      ? new Tone.Sampler({ urls: SALAMANDER_URLS, baseUrl: SALAMANDER_BASE }).toDestination()
      : null
    const samplerB = deckBTrack
      ? new Tone.Sampler({ urls: SALAMANDER_URLS, baseUrl: SALAMANDER_BASE }).toDestination()
      : null

    samplerARef.current = samplerA
    samplerBRef.current = samplerB

    await Tone.loaded()

    if (samplerA) samplerA.volume.value = Tone.gainToDb(volA)
    if (samplerB) samplerB.volume.value = Tone.gainToDb(volB)

    // Schedule notes via Transport — callbacks fire one-by-one at the right moment
    if (deckATrack && samplerA) {
      for (const n of deckATrack.notes) {
        Tone.Transport.schedule((time) => {
          samplerARef.current?.triggerAttackRelease(
            Tone.Midi(n.note).toNote(),
            Math.max(n.duration, 0.05),
            time,
            n.velocity,
          )
        }, n.time)
      }
    }
    if (deckBTrack && samplerB) {
      for (const n of deckBTrack.notes) {
        Tone.Transport.schedule((time) => {
          samplerBRef.current?.triggerAttackRelease(
            Tone.Midi(n.note).toNote(),
            Math.max(n.duration, 0.05),
            time,
            n.velocity,
          )
        }, n.time)
      }
    }

    const maxTimeSec = Math.max(
      ...(deckATrack?.notes ?? []).map(n => n.time + n.duration),
      ...(deckBTrack?.notes ?? []).map(n => n.time + n.duration),
      0,
    )

    setIsPlaying(true)
    setStatus('Playing...')
    Tone.Transport.start()

    endTimerRef.current = setTimeout(() => {
      stopPlayback()
      setIsPlaying(false)
      setStatus('Playback complete')
      setStatusError(false)
    }, (maxTimeSec + 1) * 1000)
  }, [isPlaying, deckATrack, deckBTrack, faderValue, stopPlayback])

  const handleStop = useCallback(() => {
    stopPlayback()
    setIsPlaying(false)
    setStatusError(false)
    setStatus('Playback stopped')
  }, [stopPlayback])

  const handleCenter = useCallback(() => {
    setFaderValue(50)
  }, [])

  return (
    <>
      <header>
        <h1>BK Crossfader</h1>
        <div className="sub">Banjo-Kazooie · MIDI Blend Mixer</div>
      </header>

      <div className="card">
        <div className="panel-header">
          <div>
            <div className="panel-title">Track Library</div>
            <div className="panel-hint">
              {tracks.length > 0
                ? `${tracks.length} track${tracks.length > 1 ? 's' : ''} loaded`
                : 'No tracks loaded — upload a .mid file to begin'}
            </div>
          </div>
          <button className="upload-trigger" onClick={() => fileInputRef.current?.click()}>
            <svg
              width="11"
              height="11"
              viewBox="0 0 12 12"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            >
              <path d="M6 8V2M3 5l3-3 3 3M2 10h8" />
            </svg>
            Upload MIDI
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".mid,.midi"
            multiple
            style={{ display: 'none' }}
            onChange={handleFileUpload}
          />
        </div>
        <div className="track-list">
          {tracks.length === 0 ? (
            <div className="empty-state">
              No tracks yet.
              <br />
              Upload .mid files above to build your library.
            </div>
          ) : (
            tracks.map(track => {
              const assignment = assignments.get(track.name)
              return (
                <div key={track.name} className="track-row">
                  <div className="track-icon">♪</div>
                  <div className="track-name">{track.name}</div>
                  {track.bpm !== null && <div className="track-bpm">{track.bpm} BPM</div>}
                  {assignment && (
                    <div className={`track-badge badge-${assignment.toLowerCase()}`}>
                      {assignment}
                    </div>
                  )}
                  <button
                    className={`assign-btn${assignment === 'A' ? ' sel-a' : ''}`}
                    onClick={() => handleAssign(track.name, 'A')}
                  >
                    A
                  </button>
                  <button
                    className={`assign-btn${assignment === 'B' ? ' sel-b' : ''}`}
                    onClick={() => handleAssign(track.name, 'B')}
                  >
                    B
                  </button>
                  <button
                    className="remove-btn"
                    onClick={() => handleRemove(track.name)}
                    aria-label="Remove track"
                  >
                    ×
                  </button>
                </div>
              )
            })
          )}
        </div>
      </div>

      <div className="card mixer">
        <div className="decks">
          <div className="deck deck-a">
            <div className="deck-letter">A</div>
            <div className={`deck-name${deckATrack ? ' set' : ''}`}>
              {deckATrack ? deckATrack.name : '— unassigned —'}
            </div>
          </div>
          <div className="deck deck-b">
            <div className="deck-letter">B</div>
            <div className={`deck-name${deckBTrack ? ' set' : ''}`}>
              {deckBTrack ? deckBTrack.name : '— unassigned —'}
            </div>
          </div>
        </div>

        <div className="waves">
          <div className="deck deck-a">
            <WaveDisplay active={isPlaying} />
          </div>
          <div className="deck deck-b">
            <WaveDisplay active={isPlaying} />
          </div>
        </div>

        <div className="vu-row">
          <div className="deck deck-a" style={{ flex: 1 }}>
            <div className="vu">
              <div className="vu-fill" style={{ width: `${volAPercent}%` }} />
            </div>
          </div>
          <div className="vu-lbl">vol</div>
          <div className="deck deck-b" style={{ flex: 1 }}>
            <div className="vu">
              <div className="vu-fill" style={{ width: `${volBPercent}%` }} />
            </div>
          </div>
        </div>

        <div className="fader-wrap">
          <div className="rail" />
          <input
            type="range"
            min="0"
            max="100"
            value={faderValue}
            onChange={handleFaderChange}
          />
          <div className="thumb" style={{ left: `${faderValue}%` }} />
        </div>
        <div className="fader-labels">
          <span>A only</span>
          <span>blend</span>
          <span>B only</span>
        </div>

        <div className="ctrl">
          <button
            className={`btn${canPlay && !isPlaying ? ' go' : ''}`}
            onClick={handlePlay}
            disabled={!canPlay || isPlaying}
          >
            Play
          </button>
          <button className="btn" onClick={handleStop} disabled={!isPlaying}>
            Stop
          </button>
          <button className="btn" onClick={handleCenter}>
            Center
          </button>
        </div>
        <div className="vols">
          A: <span>{volAPercent}%</span> &nbsp; B: <span>{volBPercent}%</span>
        </div>
      </div>

      <div id="status" className={statusError ? 'err' : ''}>
        {status}
      </div>
    </>
  )
}

export default App
