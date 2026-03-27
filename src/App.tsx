import { useState, useEffect } from 'react'
import AppV1 from './AppV1'
import AppV2 from './AppV2'
import AppV3 from './AppV3'

type Route = 'index' | 'v1' | 'v2' | 'v3'

function getRoute(): Route {
  const hash = window.location.hash
  if (hash === '#v1') return 'v1'
  if (hash === '#v2') return 'v2'
  if (hash === '#v3') return 'v3'
  return 'index'
}

export default function App() {
  const [route, setRoute] = useState<Route>(getRoute)

  useEffect(() => {
    const onChange = () => setRoute(getRoute())
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])

  if (route === 'v1') return <AppV1 />
  if (route === 'v2') return <AppV2 />
  if (route === 'v3') return <AppV3 />
  return <IndexPage />
}

function IndexPage() {
  const prototypes = [
    {
      id: 'v1',
      title: 'MIDI Crossfader',
      desc: 'Equal-power crossfade, no BPM sync',
    },
    {
      id: 'v2',
      title: 'MIDI Crossfader — BPM Sync',
      desc: 'Independent transports per deck, interpolated BPM during crossfade',
    },
    {
      id: 'v3',
      title: 'MIDI Crossfader — Alignment',
      desc: 'Piano roll overlay, manual offset nudge, auto-align via cross-correlation',
    },
  ]

  return (
    <>
      <header>
        <h1>MIDI Experiments</h1>
        <div className="sub">Prototype Index</div>
      </header>
      <div className="card" style={{ padding: '0.5rem 0' }}>
        {prototypes.map((p, i) => (
          <a
            key={p.id}
            href={`#${p.id}`}
            style={{
              display: 'block',
              textDecoration: 'none',
              padding: '1rem 1.2rem',
              borderBottom: i < prototypes.length - 1 ? '1px solid var(--border)' : 'none',
            }}
          >
            <div style={{ fontSize: '0.63rem', color: 'var(--text)', letterSpacing: '0.06em' }}>
              {p.title}
            </div>
            <div style={{ fontSize: '0.52rem', color: 'var(--muted)', marginTop: '0.3rem', letterSpacing: '0.1em' }}>
              {p.desc}
            </div>
          </a>
        ))}
      </div>
    </>
  )
}
