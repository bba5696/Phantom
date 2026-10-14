import { useState, useEffect, useRef, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import Splash from './Splash'
import License from './License'

const CHECKOUT_URL = import.meta.env.VITE_CHECKOUT_URL ?? 'https://your-checkout-url.com'

const IS_DEV_PREVIEW = import.meta.env.DEV && !(window as any).__TAURI_INTERNALS__

if (IS_DEV_PREVIEW) {
  ;(window as any).__mockInvoke = async (cmd: string, args?: any) => {
    if (cmd === 'check_license') return false
    if (cmd === 'activate_license') {
      if (args?.key === 'AAAA-BBBB-CCCC-DDDD') return { expires_at: null }
      throw 'Invalid license key'
    }
    if (cmd === 'deactivate_license') return
    if (cmd === 'get_creds') return ['', '']
    if (cmd === 'get_settings') return [true, true, false]
    if (cmd === 'save_creds') return
    if (cmd === 'save_settings') return
    if (cmd === 'start') return
    if (cmd === 'stop') return
    throw `Unknown command: ${cmd}`
  }
}

const invokeCmd = IS_DEV_PREVIEW
  ? (cmd: string, args?: any) => (window as any).__mockInvoke(cmd, args)
  : invoke

// ── Types ──────────────────────────────────────────────────────────────────────

type LogColor    = 'info' | 'good' | 'warn' | 'error' | 'dim'
type StatusState = 'idle' | 'running' | 'warning' | 'error'

interface LogEntry {
  id: number
  ts: string
  msg: string
  color: LogColor
}

const LOG_CLASS: Record<LogColor, string> = {
  info:  'text-zinc-400',
  good:  'text-emerald-400',
  warn:  'text-amber-400',
  error: 'text-red-400',
  dim:   'text-zinc-500',
}

const DOT_BG: Record<StatusState, string> = {
  idle:    'bg-zinc-600',
  running: 'bg-emerald-500',
  warning: 'bg-amber-400',
  error:   'bg-red-500',
}

const INPUT_CLASS =
  'h-8 w-full flex-shrink-0 rounded-md border border-zinc-800 bg-[#09090b] px-3 text-[12px] text-zinc-100 ' +
  'outline-none transition-colors placeholder:text-zinc-600 ' +
  'focus:border-zinc-500 focus:ring-2 focus:ring-zinc-500/20'

const FOCUS_RING =
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-500'

function nowTs() {
  return new Date().toTimeString().slice(0, 8)
}

// Pill h-5 w-9 (20×36px), thumb h-4 w-4 (16px), 2px inset on every side:
//   OFF x = 2px                → translate-x-0.5
//   ON  x = 36 − 16 − 2 = 18px → translate-x-[18px]
// left-0 is required: <button> keeps the browser's text-align:center, so an
// absolute thumb left at left:auto starts mid-pill and slides out when ON.
function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer select-none items-center justify-between gap-3">
      <span className="text-[12px] text-zinc-400">{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={value}
        onClick={() => onChange(!value)}
        className={`relative h-5 w-9 flex-shrink-0 cursor-pointer rounded-full transition-colors duration-200 ${FOCUS_RING} ${
          value ? 'bg-white' : 'bg-zinc-700'
        }`}
      >
        <span
          className={`absolute left-0 top-0.5 h-4 w-4 rounded-full transition duration-200 ${
            value ? 'translate-x-[18px] bg-zinc-900' : 'translate-x-0.5 bg-zinc-500'
          }`}
        />
      </button>
    </label>
  )
}

// ── App ────────────────────────────────────────────────────────────────────────

// The main UI mounts immediately underneath the splash (so credentials and the
// event listeners load during the intro) but stays transparent. When the splash
// has faded to black it calls onDone, unmounts, and the main UI fades in.

function LoadingScreen() {
  return (
    <div className="flex h-full w-full items-center justify-center bg-[#09090b]">
      <svg className="animate-spin h-5 w-5 text-zinc-600" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
      </svg>
    </div>
  )
}

export default function App() {
  const [splashDone, setSplashDone] = useState(false)
  const [licensed, setLicensed]     = useState<boolean | null>(null)

  useEffect(() => {
    invokeCmd('check_license')
      .then((v: unknown) => setLicensed(v as boolean))
      .catch(() => setLicensed(false))
  }, [])

  if (licensed === null) return <LoadingScreen />
  if (!licensed) return <License onActivated={() => setLicensed(true)} checkoutUrl={CHECKOUT_URL} />

  return (
    <>
      <div
        aria-hidden={splashDone ? undefined : true}
        className={`h-full w-full transition-opacity duration-[450ms] ease-out ${
          splashDone ? 'opacity-100' : 'opacity-0'
        }`}
      >
        <MainView />
      </div>
      {!splashDone && <Splash onDone={() => setSplashDone(true)} />}
    </>
  )
}

// ── Main view ──────────────────────────────────────────────────────────────────

function MainView() {
  const [running,  setRunning]  = useState(false)
  const [status,   setStatus]   = useState<{ label: string; state: StatusState }>({ label: 'Idle', state: 'idle' })
  // Seeded here instead of appended from the mount effect: StrictMode runs
  // effects twice in dev, which printed "Phantom ready." twice.
  const [logs,     setLogs]     = useState<LogEntry[]>(() => [
    { id: 0, ts: nowTs(), msg: 'Phantom ready.', color: 'dim' },
  ])
  const [email,    setEmail]    = useState('')
  const [password, setPassword] = useState('')
  const [focusSpoof,      setFocusSpoof]      = useState(true)
  const [fullscreenSpoof, setFullscreenSpoof] = useState(true)
  const [debugMode,       setDebugMode]       = useState(false)

  const logRef = useRef<HTMLDivElement>(null)
  const idRef  = useRef(1)

  const appendLog = useCallback((msg: string, color: LogColor = 'info') => {
    setLogs(prev => [...prev, { id: idRef.current++, ts: nowTs(), msg, color }])
  }, [])

  useEffect(() => {
    invokeCmd('get_creds')
      .then((v: any) => { const [e, p] = v; if (e) setEmail(e); if (p) setPassword(p) })
      .catch(() => {})

    invokeCmd('get_settings')
      .then((v: any) => { const [fs, fss, dm] = v; setFocusSpoof(fs); setFullscreenSpoof(fss); setDebugMode(dm) })
      .catch(() => {})

    const unLog = listen<{ msg: string; color: string }>('log', ev => {
      appendLog(ev.payload.msg, (ev.payload.color as LogColor) ?? 'info')
    })
    const unStatus = listen<{ label: string; state: string }>('status', ev => {
      const s = ev.payload.state as StatusState
      setStatus({ label: ev.payload.label, state: s })
      if (s === 'idle') setRunning(false)
    })

    return () => {
      unLog.then(f => f())
      unStatus.then(f => f())
    }
  }, [appendLog])

  // Scroll only the log panel. scrollIntoView() would also scroll the
  // overflow-hidden ancestors (root div / body) and could shift the whole
  // window, clipping the header or the bottom controls.
  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [logs])

  async function handleLaunch() {
    if (!running) {
      if (!email || !password) { appendLog('Enter credentials first.', 'warn'); return }
      try {
        await invokeCmd('start', { email, password, focusSpoof, fullscreenSpoof, debugMode })
        setRunning(true)
      } catch (e) {
        appendLog(`Error: ${e}`, 'error')
        setStatus({ label: 'Error', state: 'error' })
      }
    } else {
      try { await invokeCmd('stop') } catch {}
      setRunning(false)
    }
  }

  async function handleSave() {
    try {
      await invokeCmd('save_creds', { email, password })
      appendLog('Credentials saved.', 'dim')
    } catch (e) {
      appendLog(`Save failed: ${e}`, 'error')
    }
  }

  async function handleToggle(key: 'focus' | 'fullscreen' | 'debug', value: boolean) {
    const fs  = key === 'focus'      ? value : focusSpoof
    const fss = key === 'fullscreen' ? value : fullscreenSpoof
    const dm  = key === 'debug'      ? value : debugMode
    if (key === 'focus')      setFocusSpoof(value)
    if (key === 'fullscreen') setFullscreenSpoof(value)
    if (key === 'debug')      setDebugMode(value)
    try { await invokeCmd('save_settings', { focusSpoof: fs, fullscreenSpoof: fss, debugMode: dm }) } catch {}
  }

  const dotClass = DOT_BG[status.state] ?? DOT_BG.idle

  return (
    <div className="h-full w-full flex flex-col overflow-hidden bg-[#09090b] text-zinc-100">

      {/* ── Header ── */}
      <header className="flex h-10 flex-shrink-0 items-center justify-between gap-4 border-b border-zinc-800 px-4">
        <span className="flex-shrink-0 text-[11px] font-semibold uppercase tracking-[0.2em] text-zinc-100">
          Phantom
        </span>
        <div className="flex min-w-0 items-center gap-2" title={status.label}>
          <span
            className={`size-1.5 flex-shrink-0 rounded-full ${dotClass} ${status.state === 'running' ? 'animate-pulse' : ''}`}
          />
          <span className="truncate text-[11px] text-zinc-400">{status.label}</span>
        </div>
      </header>

      {/* ── Log panel ── */}
      <div
        ref={logRef}
        className="flex-1 overflow-y-auto min-h-0 overflow-x-hidden px-4 py-3 font-mono text-[11.5px] leading-[1.65] select-text"
      >
        {logs.map(entry => (
          <div key={entry.id} className="flex items-baseline gap-3">
            <span className="flex-shrink-0 text-[10.5px] text-zinc-600 select-none">
              {entry.ts}
            </span>
            <span className={`min-w-0 flex-1 break-words ${LOG_CLASS[entry.color] ?? LOG_CLASS.info}`}>
              {entry.msg}
            </span>
          </div>
        ))}
      </div>

      {/* ── Bottom section ── */}
      <div className="flex flex-shrink-0 flex-col gap-3 border-t border-zinc-800 p-4">

        {/* Launch / Stop */}
        <button
          type="button"
          onClick={handleLaunch}
          className={`h-9 w-full flex-shrink-0 cursor-pointer rounded-md border text-[13px] font-medium transition-colors ${FOCUS_RING} ${
            running
              ? 'border-zinc-700 bg-transparent text-red-400 hover:bg-zinc-900'
              : 'border-transparent bg-zinc-100 text-zinc-900 hover:bg-zinc-200'
          }`}
        >
          {running ? 'Stop' : 'Launch'}
        </button>

        {/* Spoofing toggles */}
        <div className="flex flex-shrink-0 flex-col gap-2 rounded-lg border border-zinc-800 bg-zinc-900 p-3">
          <p className="text-[10px] font-medium uppercase tracking-widest text-zinc-500">
            Spoofing
          </p>
          <Toggle
            label="Focus spoof"
            value={focusSpoof}
            onChange={v => handleToggle('focus', v)}
          />
          <Toggle
            label="Fullscreen spoof"
            value={fullscreenSpoof}
            onChange={v => handleToggle('fullscreen', v)}
          />
          <Toggle
            label="Enable debug"
            value={debugMode}
            onChange={v => handleToggle('debug', v)}
          />
        </div>

        {/* Credentials card */}
        <div className="flex flex-shrink-0 flex-col gap-2 rounded-lg border border-zinc-800 bg-zinc-900 p-3">
          <p className="text-[10px] font-medium uppercase tracking-widest text-zinc-500">
            Credentials
          </p>
          <input
            type="text"
            placeholder="Email address"
            aria-label="Email address"
            autoComplete="off"
            spellCheck={false}
            value={email}
            onChange={e => setEmail(e.target.value)}
            className={INPUT_CLASS}
          />
          <input
            type="password"
            placeholder="Password"
            aria-label="Password"
            autoComplete="off"
            value={password}
            onChange={e => setPassword(e.target.value)}
            className={INPUT_CLASS}
          />
          <button
            type="button"
            onClick={handleSave}
            className={`h-8 w-full flex-shrink-0 cursor-pointer rounded-md border border-zinc-800 bg-transparent text-[12px] text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-zinc-100 ${FOCUS_RING}`}
          >
            Save
          </button>
        </div>

      </div>
    </div>
  )
}
