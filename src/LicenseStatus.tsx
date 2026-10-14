import { invoke } from '@tauri-apps/api/core'

const IS_DEV_PREVIEW = import.meta.env.DEV && !(window as any).__TAURI_INTERNALS__

const invokeCmd = IS_DEV_PREVIEW
  ? (cmd: string, args?: any) => (window as any).__mockInvoke(cmd, args)
  : invoke

interface Props {
  licenseKey: string
  expiresAt: string | null
  onDeactivated: () => void
}

function maskKey(key: string): string {
  const clean = key.replace(/-/g, '')
  const last4 = clean.slice(-4)
  return `••••-••••-••••-${last4}`
}

export default function LicenseStatus({ licenseKey, expiresAt, onDeactivated }: Props) {
  async function handleDeactivate() {
    const confirmed = window.confirm('Deactivate this license? You will need to re-enter your key to use the app.')
    if (!confirmed) return
    try {
      await invokeCmd('deactivate_license')
      onDeactivated()
    } catch {}
  }

  const expiry = expiresAt
    ? `Expires ${new Date(expiresAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}`
    : 'Lifetime'

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-zinc-800 bg-zinc-900 p-3">
      <p className="text-[10px] font-medium uppercase tracking-widest text-zinc-500">
        License
      </p>

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <span className="size-1.5 rounded-full bg-emerald-500" />
          <span className="text-[11px] text-emerald-400">Active</span>
        </div>
        <button
          type="button"
          onClick={handleDeactivate}
          className="text-[11px] text-zinc-500 transition-colors hover:text-red-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-500"
        >
          Deactivate
        </button>
      </div>

      <p className="font-mono text-[11px] text-zinc-400">{maskKey(licenseKey)}</p>
      <p className="text-[10px] text-zinc-500">{expiry}</p>
    </div>
  )
}
