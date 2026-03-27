import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import * as Soundfont from 'soundfont-player'
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
  notes: NoteEvent[]
}

type DeckId = 'A' | 'B'

// Transpose out-of-range notes by octaves to fit the acoustic piano's sample range (A0–C8)
function clampToRange(note: number, min = 21, max = 108): number {
  while (note < min) note += 12
  while (note > max) note -= 12
  return note
}

function parseMidi(data: ArrayBuffer): NoteEvent[] {
  const midi = new Midi(data)
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
  return notes.sort((a, b) => a.time - b.time)
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
  const instrumentRef = useRef<Soundfont.Instrument | null>(null)
  const acRef = useRef<AudioContext | null>(null)
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
          const notes = parseMidi(data)
          if (notes.length > 0) {
            setTracks(prev => {
              if (prev.find(t => t.name === file.name)) return prev
              return [...prev, { name: file.name, notes }]
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

  const handlePlay = useCallback(async () => {
    if (isPlaying || instrumentRef.current) return
    if (!deckATrack && !deckBTrack) return

    const volA = 1 - faderValue / 100
    const volB = faderValue / 100

    const eventsA = deckATrack
      ? deckATrack.notes.map(n => ({
          note: clampToRange(n.note),
          time: n.time,
          duration: n.duration,
          vol: deckBTrack ? volA : 1,
        }))
      : []
    const eventsB = deckBTrack
      ? deckBTrack.notes.map(n => ({
          note: clampToRange(n.note),
          time: n.time,
          duration: n.duration,
          vol: deckATrack ? volB : 1,
        }))
      : []
    const allEvents = [...eventsA, ...eventsB].sort((a, b) => a.time - b.time)

    if (allEvents.length === 0) return

    const maxTimeSec = Math.max(...allEvents.map(e => e.time + e.duration))

    setStatus('Loading soundfont...')
    const ac = new AudioContext()
    acRef.current = ac

    const instrument = await Soundfont.instrument(ac, 'acoustic_grand_piano', {
      format: 'mp3',
      soundfont: 'MusyngKite',
    })
    instrumentRef.current = instrument

    // Pre-schedule all notes via Web Audio clock (accurate, no setTimeout drift)
    const t0 = ac.currentTime + 0.1
    for (const event of allEvents) {
      instrument.play(event.note, t0 + event.time, {
        gain: event.vol * 0.9,
        duration: event.duration,
      })
    }

    setIsPlaying(true)
    setStatus('Playing...')

    endTimerRef.current = setTimeout(() => {
      instrumentRef.current?.stop()
      instrumentRef.current = null
      acRef.current?.close()
      acRef.current = null
      setIsPlaying(false)
      setStatus('Playback complete')
      setStatusError(false)
    }, (maxTimeSec + 1) * 1000)
  }, [isPlaying, deckATrack, deckBTrack, faderValue])

  const handleStop = useCallback(() => {
    if (endTimerRef.current) clearTimeout(endTimerRef.current)
    instrumentRef.current?.stop()
    instrumentRef.current = null
    acRef.current?.close()
    acRef.current = null
    setIsPlaying(false)
    setStatusError(false)
    setStatus('Playback stopped')
  }, [])

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
