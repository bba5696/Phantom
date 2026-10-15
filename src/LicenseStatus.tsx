import { useState, useRef, useEffect } from 'react'

export interface LicenseInfo {
  valid: boolean
  key: string
  expires_at: string | null
  email: string | null
  activated_at: string | null
}

interface Props {
  info: LicenseInfo
  onDeactivated: () => void
  invokeCmd: (cmd: string, args?: any) => Promise<any>
}

function maskKey(key: string): string {
  const clean = key.replace(/-/g, '')
  return `••••-••••-••••-${clean.slice(-4)}`
}

function daysLeft(expires_at: string | null): number | null {
  if (!expires_at) return null
  return Math.ceil((new Date(expires_at).getTime() - Date.now()) / 86_400_000)
}

function badgeLabel(days: number | null): string {
  if (days === null) return '∞'
  if (days <= 0) return 'Expired'
  if (days === 1) return '1d left'
  if (days <= 14) return `${days}d left`
  return `Exp ${new Date(Date.now() + days * 86_400_000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
}

function badgeColor(days: number | null): string {
  if (days === null) return 'text-zinc-500 border-zinc-700'
  if (days <= 0) return 'text-red-400 border-red-800 animate-pulse'
  if (days <= 3) return 'text-red-400 border-red-800'
  if (days <= 7) return 'text-amber-400 border-amber-800'
  return 'text-emerald-400 border-emerald-800'
}

function progressPercent(activated_at: string | null, expires_at: string | null): number | null {
  if (!expires_at || !activated_at) return null
  const start = new Date(activated_at).getTime()
  const end = new Date(expires_at).getTime()
  const now = Date.now()
  if (end <= start) return null
  return Math.min(100, Math.max(0, ((now - start) / (end - start)) * 100))
}

export default function ExpiryBadge({ info, onDeactivated, invokeCmd }: Props) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    if (open) document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [open])

  const days = daysLeft(info.expires_at)
  const pct = progressPercent(info.activated_at, info.expires_at)

  async function handleDeactivate() {
    setOpen(false)
    const ok = window.confirm('Deactivate this license? You will need to re-enter your key to use the app.')
    if (!ok) return
    try { await invokeCmd('deactivate_license') } catch {}
    onDeactivated()
  }

  return (
    <div ref={ref} className="relative flex-shrink-0">
      {/* Badge */}
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className={`rounded border px-1.5 py-0.5 text-[10px] font-medium leading-none transition-colors hover:opacity-80 ${badgeColor(days)}`}
      >
        {badgeLabel(days)}
      </button>

      {/* Hover panel */}
      {open && (
        <div className="absolute right-0 top-full z-50 mt-1.5 w-56 rounded-lg border border-zinc-700 bg-[#09090b] p-3 shadow-xl">
          <p className="mb-2 text-[10px] font-medium uppercase tracking-widest text-zinc-500">License</p>

          {/* Key */}
          <p className="font-mono text-[11px] text-zinc-300">{maskKey(info.key)}</p>

          {/* Email */}
          {info.email && (
            <p className="mt-1 text-[11px] text-zinc-400 truncate">{info.email}</p>
          )}

          {/* Progress bar */}
          {pct !== null && (
            <div className="mt-3">
              <div className="mb-1 flex justify-between text-[10px] text-zinc-500">
                <span>{days !== null && days > 0 ? `${days}d remaining` : 'Expired'}</span>
                <span>{Math.round(pct)}% used</span>
              </div>
              <div className="h-1 w-full rounded-full bg-zinc-800">
                <div
                  className={`h-1 rounded-full transition-all ${pct >= 90 ? 'bg-red-500' : pct >= 70 ? 'bg-amber-400' : 'bg-emerald-500'}`}
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
          )}

          {/* Expiry */}
          <p className="mt-2 text-[10px] text-zinc-500">
            {info.expires_at
              ? `Expires ${new Date(info.expires_at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}`
              : 'Lifetime license'}
          </p>

          <button
            type="button"
            onClick={handleDeactivate}
            className="mt-3 w-full rounded border border-zinc-800 py-1 text-[11px] text-zinc-500 transition-colors hover:border-red-800 hover:text-red-400"
          >
            Deactivate
          </button>
        </div>
      )}
    </div>
  )
}
