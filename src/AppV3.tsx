import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import * as Tone from 'tone'
import { Midi } from '@tonejs/midi'
import './AppV1.css'

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

function crossfadeGains(fader: number, hasA: boolean, hasB: boolean): [number, number] {
  if (!hasA || !hasB) return [1, 1]
  const t = (fader / 100) * (Math.PI / 2)
  return [Math.cos(t), Math.sin(t)]
}

function lerp(a: number, b: number, t: number) { return a + (b - a) * t }

function interpolateBpm(faderValue: number, bpmA: number, bpmB: number): number {
  return lerp(bpmA, bpmB, faderValue / 100)
}

// Cross-correlate onset-density histograms to find the offset (seconds) that
// best aligns trackB to trackA. Positive result = B should be delayed.
function autoAlign(trackA: Track, trackB: Track): number {
  const BIN = 0.05
  const MAX_LAG = 10
  const BINS_PER_LAG = Math.round(MAX_LAG / BIN)

  const allTimes = [
    ...trackA.notes.map(n => n.time + n.duration),
    ...trackB.notes.map(n => n.time + n.duration),
  ]
  if (allTimes.length === 0) return 0

  const numBins = Math.ceil(Math.max(...allTimes) / BIN) + 1
  const histA = new Float32Array(numBins)
  const histB = new Float32Array(numBins)

  for (const n of trackA.notes) {
    const bin = Math.floor(n.time / BIN)
    if (bin < numBins) histA[bin] += n.velocity
  }
  for (const n of trackB.notes) {
    const bin = Math.floor(n.time / BIN)
    if (bin < numBins) histB[bin] += n.velocity
  }

  let bestScore = -Infinity
  let bestLag = 0
  for (let lag = -BINS_PER_LAG; lag <= BINS_PER_LAG; lag++) {
    let score = 0
    for (let i = 0; i < numBins; i++) {
      const j = i + lag
      if (j >= 0 && j < numBins) score += histA[i] * histB[j]
    }
    if (score > bestScore) { bestScore = score; bestLag = lag }
  }
  return Math.max(-10, Math.min(10, bestLag * BIN))
}

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

// Piano roll visualization — shows both tracks overlaid with the B offset applied
interface PianoRollProps {
  trackA: Track | null
  trackB: Track | null
  offsetB: number
  isPlaying: boolean
  contextA: Tone.Context | null
}

function PianoRoll({ trackA, trackB, offsetB, isPlaying, contextA }: PianoRollProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rafRef = useRef<number>(0)

  const { minNote, maxNote, maxTime } = useMemo(() => {
    const allA = trackA?.notes ?? []
    const allB = trackB?.notes ?? []
    const noteNums = [...allA.map(n => n.note), ...allB.map(n => n.note)]
    const times = [
      ...allA.map(n => n.time + n.duration),
      ...allB.map(n => n.time + offsetB + n.duration),
      1,
    ]
    if (noteNums.length === 0) return { minNote: 48, maxNote: 72, maxTime: 10 }
    return {
      minNote: Math.max(0, Math.min(...noteNums) - 3),
      maxNote: Math.min(127, Math.max(...noteNums) + 3),
      maxTime: Math.max(...times),
    }
  }, [trackA, trackB, offsetB])

  const drawFrame = useCallback((playheadTime: number) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const W = canvas.width
    const H = canvas.height
    const noteRange = maxNote - minNote + 1
    const noteH = H / noteRange
    const pxPerSec = W / maxTime

    const tx = (t: number) => t * pxPerSec
    const ny = (n: number) => (maxNote - n) * noteH

    ctx.clearRect(0, 0, W, H)

    // Pitch lane backgrounds
    for (let n = minNote; n <= maxNote; n++) {
      const semitone = n % 12
      const isBlack = [1, 3, 6, 8, 10].includes(semitone)
      ctx.fillStyle = isBlack ? 'rgba(0,0,0,0.3)' : 'rgba(255,255,255,0.04)'
      ctx.fillRect(0, ny(n), W, noteH)
    }

    // Read CSS color variables from the canvas element (inherits from :root)
    const style = getComputedStyle(canvas)
    const colorA = style.getPropertyValue('--a').trim() || '#f0c040'
    const colorB = style.getPropertyValue('--b').trim() || '#4090f0'

    const drawNotes = (notes: NoteEvent[], color: string, timeShift: number) => {
      ctx.fillStyle = color + 'cc'
      for (const n of notes) {
        const x = tx(n.time + timeShift)
        const y = ny(n.note)
        const w = Math.max(2, n.duration * pxPerSec)
        ctx.fillRect(x, y + 1, w, Math.max(1, noteH - 2))
      }
    }

    if (trackA) drawNotes(trackA.notes, colorA, 0)
    if (trackB) drawNotes(trackB.notes, colorB, offsetB)

    // Playhead
    if (playheadTime > 0) {
      ctx.strokeStyle = 'rgba(255,255,255,0.65)'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(tx(playheadTime), 0)
      ctx.lineTo(tx(playheadTime), H)
      ctx.stroke()
    }
  }, [trackA, trackB, offsetB, minNote, maxNote, maxTime])

  // Static redraw when tracks/offset changes
  useEffect(() => {
    drawFrame(0)
  }, [drawFrame])

  // RAF loop during playback
  useEffect(() => {
    if (!isPlaying || !contextA) {
      cancelAnimationFrame(rafRef.current)
      return
    }
    const loop = () => {
      drawFrame(contextA.transport.seconds)
      rafRef.current = requestAnimationFrame(loop)
    }
    rafRef.current = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(rafRef.current)
  }, [isPlaying, contextA, drawFrame])

  return (
    <canvas
      ref={canvasRef}
      width={600}
      height={160}
      style={{ width: '100%', height: '160px', display: 'block', background: 'var(--dim)', borderRadius: '2px' }}
    />
  )
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
          style={{ '--d': `${bar.d}s`, '--del': `${bar.del}s`, '--lo': `${bar.lo}px`, '--hi': `${bar.hi}px` } as React.CSSProperties}
        />
      ))}
    </div>
  )
}

function AppV3() {
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
  const [currentBpm, setCurrentBpm] = useState<number | null>(null)
  const [offsetB, setOffsetB] = useState(0)
  const [activeContextA, setActiveContextA] = useState<Tone.Context | null>(null)

  const samplerARef = useRef<Tone.Sampler | null>(null)
  const samplerBRef = useRef<Tone.Sampler | null>(null)
  const contextARef = useRef<Tone.Context | null>(null)
  const contextBRef = useRef<Tone.Context | null>(null)
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
    if (!isPlaying) return
    const [volA, volB] = crossfadeGains(faderValue, !!deckATrack, !!deckBTrack)
    if (samplerARef.current) samplerARef.current.volume.rampTo(Tone.gainToDb(volA), 0.08)
    if (samplerBRef.current) samplerBRef.current.volume.rampTo(Tone.gainToDb(volB), 0.08)
  }, [faderValue, isPlaying, deckATrack, deckBTrack])

  useEffect(() => {
    if (!isPlaying || !deckATrack?.bpm || !deckBTrack?.bpm) return
    const bpm = interpolateBpm(faderValue, deckATrack.bpm, deckBTrack.bpm)
    contextARef.current?.transport.bpm.rampTo(bpm, 0.1)
    contextBRef.current?.transport.bpm.rampTo(bpm, 0.1)
    setCurrentBpm(Math.round(bpm))
  }, [faderValue, isPlaying, deckATrack, deckBTrack])

  useEffect(() => {
    try {
      localStorage.setItem('bk-crossfader-tracks-v2', JSON.stringify(tracks))
    } catch (err) {
      console.warn('Failed to save tracks to localStorage:', err)
    }
  }, [tracks])

  const [volADisplay, volBDisplay] = crossfadeGains(faderValue, !!deckATrack, !!deckBTrack)
  const volAPercent = Math.round(volADisplay * 100)
  const volBPercent = Math.round(volBDisplay * 100)

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
    contextARef.current?.transport.stop()
    contextARef.current?.transport.cancel()
    contextBRef.current?.transport.stop()
    contextBRef.current?.transport.cancel()
    samplerARef.current?.dispose()
    samplerARef.current = null
    samplerBRef.current?.dispose()
    samplerBRef.current = null
    contextARef.current?.dispose()
    contextARef.current = null
    contextBRef.current?.dispose()
    contextBRef.current = null
    setCurrentBpm(null)
    setActiveContextA(null)
  }, [])

  const handlePlay = useCallback(async () => {
    if (isPlaying) return
    if (!deckATrack && !deckBTrack) return

    const ctxA = new Tone.Context()
    const ctxB = new Tone.Context()
    contextARef.current = ctxA
    contextBRef.current = ctxB

    await Promise.all([ctxA.resume(), ctxB.resume()])

    const [volA, volB] = crossfadeGains(faderValue, !!deckATrack, !!deckBTrack)

    if (deckATrack?.bpm && deckBTrack?.bpm) {
      const bpm = interpolateBpm(faderValue, deckATrack.bpm, deckBTrack.bpm)
      ctxA.transport.bpm.value = bpm
      ctxB.transport.bpm.value = bpm
      setCurrentBpm(Math.round(bpm))
    } else {
      if (deckATrack?.bpm) ctxA.transport.bpm.value = deckATrack.bpm
      if (deckBTrack?.bpm) ctxB.transport.bpm.value = deckBTrack.bpm
    }

    setStatus('Loading samples...')
    setStatusError(false)

    let samplerA: Tone.Sampler | null = null
    let samplerB: Tone.Sampler | null = null

    await Promise.all([
      deckATrack
        ? new Promise<void>(res => {
            samplerA = new Tone.Sampler({ urls: SALAMANDER_URLS, baseUrl: SALAMANDER_BASE, context: ctxA, onload: res }).connect(ctxA.destination)
          })
        : Promise.resolve(),
      deckBTrack
        ? new Promise<void>(res => {
            samplerB = new Tone.Sampler({ urls: SALAMANDER_URLS, baseUrl: SALAMANDER_BASE, context: ctxB, onload: res }).connect(ctxB.destination)
          })
        : Promise.resolve(),
    ])

    const resolvedA = samplerA as Tone.Sampler | null
    const resolvedB = samplerB as Tone.Sampler | null

    samplerARef.current = resolvedA
    samplerBRef.current = resolvedB

    if (resolvedA) resolvedA.volume.value = Tone.gainToDb(volA)
    if (resolvedB) resolvedB.volume.value = Tone.gainToDb(volB)

    if (deckATrack && resolvedA) {
      for (const n of deckATrack.notes) {
        ctxA.transport.schedule((time) => {
          samplerARef.current?.triggerAttackRelease(
            Tone.Midi(n.note).toNote(), Math.max(n.duration, 0.05), time, n.velocity,
          )
        }, n.time)
      }
    }
    if (deckBTrack && resolvedB) {
      for (const n of deckBTrack.notes) {
        ctxB.transport.schedule((time) => {
          samplerBRef.current?.triggerAttackRelease(
            Tone.Midi(n.note).toNote(), Math.max(n.duration, 0.05), time, n.velocity,
          )
        }, Math.max(0, n.time + offsetB))
      }
    }

    const maxTimeSec = Math.max(
      ...(deckATrack?.notes ?? []).map(n => n.time + n.duration),
      ...(deckBTrack?.notes ?? []).map(n => Math.max(0, n.time + offsetB) + n.duration),
      0,
    )

    setIsPlaying(true)
    setStatus('Playing...')
    ctxA.transport.start()
    ctxB.transport.start()
    setActiveContextA(ctxA)

    endTimerRef.current = setTimeout(() => {
      stopPlayback()
      setIsPlaying(false)
      setStatus('Playback complete')
      setStatusError(false)
    }, (maxTimeSec + 5) * 1000)
  }, [isPlaying, deckATrack, deckBTrack, faderValue, offsetB, stopPlayback])

  const handleStop = useCallback(() => {
    stopPlayback()
    setIsPlaying(false)
    setStatusError(false)
    setStatus('Playback stopped')
  }, [stopPlayback])

  const handleCenter = useCallback(() => setFaderValue(50), [])

  const faderLabelLeft = deckATrack?.bpm ? `${deckATrack.bpm} BPM` : 'A only'
  const faderLabelRight = deckBTrack?.bpm ? `${deckBTrack.bpm} BPM` : 'B only'
  const faderLabelCenter = currentBpm ? `${currentBpm} BPM` : 'blend'

  const nudge = useCallback((delta: number) => {
    setOffsetB(v => Math.max(-10, Math.min(10, parseFloat((v + delta).toFixed(3)))))
  }, [])

  return (
    <>
      <header>
        <h1>MIDI Crossfader</h1>
        <div className="sub">MIDI Blend Mixer · Alignment</div>
      </header>

      {/* Track Library */}
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
            <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M6 8V2M3 5l3-3 3 3M2 10h8" />
            </svg>
            Upload MIDI
          </button>
          <input ref={fileInputRef} type="file" accept=".mid,.midi" multiple style={{ display: 'none' }} onChange={handleFileUpload} />
        </div>
        <div className="track-list">
          {tracks.length === 0 ? (
            <div className="empty-state">
              No tracks yet.<br />Upload .mid files above to build your library.
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
                    <div className={`track-badge badge-${assignment.toLowerCase()}`}>{assignment}</div>
                  )}
                  <button className={`assign-btn${assignment === 'A' ? ' sel-a' : ''}`} onClick={() => handleAssign(track.name, 'A')}>A</button>
                  <button className={`assign-btn${assignment === 'B' ? ' sel-b' : ''}`} onClick={() => handleAssign(track.name, 'B')}>B</button>
                  <button className="remove-btn" onClick={() => handleRemove(track.name)} aria-label="Remove track">×</button>
                </div>
              )
            })
          )}
        </div>
      </div>

      {/* Alignment card — only shown when tracks are assigned */}
      {(deckATrack || deckBTrack) && (
        <div className="card" style={{ padding: '1.2rem 1.5rem' }}>
          <div className="panel-header" style={{ padding: 0, marginBottom: '0.8rem', borderBottom: 'none' }}>
            <div className="panel-title">Alignment</div>
            <div className="panel-hint">
              B offset:{' '}
              <span style={{ color: 'var(--text)' }}>
                {offsetB >= 0 ? '+' : ''}{offsetB.toFixed(2)}s
              </span>
            </div>
          </div>

          <PianoRoll
            trackA={deckATrack ?? null}
            trackB={deckBTrack ?? null}
            offsetB={offsetB}
            isPlaying={isPlaying}
            contextA={activeContextA}
          />

          <div style={{ marginTop: '1rem' }}>
            <div className="fader-wrap">
              <div className="rail" style={{ background: 'var(--border2)' }} />
              <input
                type="range"
                min="-10"
                max="10"
                step="0.05"
                value={offsetB}
                onChange={e => setOffsetB(Number(e.target.value))}
              />
              <div className="thumb" style={{ left: `${((offsetB + 10) / 20) * 100}%` }} />
            </div>
            <div className="fader-labels">
              <span>-10s</span>
              <span>0</span>
              <span>+10s</span>
            </div>
          </div>

          <div className="ctrl" style={{ flexWrap: 'wrap', gap: '0.4rem', paddingTop: '0.8rem', borderTop: 'none' }}>
            {([-1, -0.5, -0.05] as const).map(d => (
              <button key={d} className="btn" onClick={() => nudge(d)}>{d}s</button>
            ))}
            <button className="btn" onClick={() => setOffsetB(0)}>Reset</button>
            {([0.05, 0.5, 1] as const).map(d => (
              <button key={d} className="btn" onClick={() => nudge(d)}>+{d}s</button>
            ))}
            <button
              className="btn lit"
              disabled={!deckATrack || !deckBTrack}
              onClick={() => {
                if (deckATrack && deckBTrack) setOffsetB(autoAlign(deckATrack, deckBTrack))
              }}
            >
              Auto-Align
            </button>
          </div>
        </div>
      )}

      {/* Mixer */}
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
          <div className="deck deck-a"><WaveDisplay active={isPlaying} /></div>
          <div className="deck deck-b"><WaveDisplay active={isPlaying} /></div>
        </div>

        <div className="vu-row">
          <div className="deck deck-a" style={{ flex: 1 }}>
            <div className="vu"><div className="vu-fill" style={{ width: `${volAPercent}%` }} /></div>
          </div>
          <div className="vu-lbl">vol</div>
          <div className="deck deck-b" style={{ flex: 1 }}>
            <div className="vu"><div className="vu-fill" style={{ width: `${volBPercent}%` }} /></div>
          </div>
        </div>

        <div className="fader-wrap">
          <div className="rail" />
          <input type="range" min="0" max="100" value={faderValue} onChange={handleFaderChange} />
          <div className="thumb" style={{ left: `${faderValue}%` }} />
        </div>
        <div className="fader-labels">
          <span>{faderLabelLeft}</span>
          <span>{faderLabelCenter}</span>
          <span>{faderLabelRight}</span>
        </div>

        <div className="ctrl">
          <button className={`btn${canPlay && !isPlaying ? ' go' : ''}`} onClick={handlePlay} disabled={!canPlay || isPlaying}>Play</button>
          <button className="btn" onClick={handleStop} disabled={!isPlaying}>Stop</button>
          <button className="btn" onClick={handleCenter}>Center</button>
        </div>
        <div className="vols">
          A: <span>{volAPercent}%</span> &nbsp; B: <span>{volBPercent}%</span>
        </div>
      </div>

      <div id="status" className={statusError ? 'err' : ''}>{status}</div>
    </>
  )
}

export default AppV3
