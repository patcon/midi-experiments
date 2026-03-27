import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import * as Soundfont from 'soundfont-player'
import './App.css'

interface NoteEvent {
  note: number
  velocity: number
  start: number
}

interface Track {
  name: string
  notes: NoteEvent[]
}

type DeckId = 'A' | 'B'

// Preserve the exact MIDI parsing logic from midi-crossfader.html
function parseMidi(data: Uint8Array): NoteEvent[] {
  let i = 0
  const notes: NoteEvent[] = []
  while (i < data.length) {
    const b = data[i]
    const nibLo = b & 0x0f
    const nibHi = (b & 0xf0) >> 4
    if (nibHi === 0x09 || (nibLo >= 0 && nibLo <= 15)) {
      const b1 = data[i + 1]
      if (b1 !== undefined) {
        const nib1Hi = (b1 & 0xf0) >> 4
        if (nib1Hi === 9 || nib1Hi === 8) {
          const note = data[i + 2]
          const velocity = data[i + 3]
          if (note !== undefined && velocity !== undefined) {
            notes.push({ note, velocity, start: i })
          }
          i += 3
          continue
        }
      }
    }
    i++
  }
  return notes
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
  const [tracks, setTracks] = useState<Track[]>([])
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
  const canPlay =
    !!deckATrack &&
    deckATrack.notes.length > 0 &&
    !!deckBTrack &&
    deckBTrack.notes.length > 0

  useEffect(() => {
    if (!isPlaying) {
      if (canPlay) {
        setStatus(`Ready: A = ${deckATrack!.name} | B = ${deckBTrack!.name}`)
        setStatusError(false)
      } else if (tracks.length > 0) {
        setStatus('Assign one track to A and one to B to begin')
        setStatusError(false)
      }
    }
  }, [canPlay, deckATrack, deckBTrack, isPlaying, tracks.length])

  const volAPercent = Math.round(faderValue)
  const volBPercent = 100 - Math.round(faderValue)

  const handleFileUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files || files.length === 0) return

    for (const file of files) {
      const reader = new FileReader()
      reader.onload = ev => {
        const data = ev.target?.result as ArrayBuffer
        try {
          const notes = parseMidi(new Uint8Array(data))
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
    if (!deckATrack || !deckBTrack) return

    const volA = faderValue / 100
    const volB = 1 - volA

    const eventsA = deckATrack.notes.map(n => ({
      note: n.note,
      time: (n.start * 1000) / 44100,
      vol: volA,
    }))
    const eventsB = deckBTrack.notes.map(n => ({
      note: n.note,
      time: (n.start * 1000) / 44100,
      vol: volB,
    }))
    const allEvents = [...eventsA, ...eventsB].sort((a, b) => a.time - b.time)

    if (allEvents.length === 0) return

    const maxTimeSec = Math.max(...allEvents.map(e => e.time)) / 1000

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
      instrument.play(event.note, t0 + event.time / 1000, {
        gain: event.vol * 0.9,
        duration: 0.4,
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
