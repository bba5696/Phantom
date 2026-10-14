import { useState, useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { KeyRound, Lock, Loader2, CheckCircle2 } from 'lucide-react'
import { REGEXP_ONLY_DIGITS_AND_CHARS } from 'input-otp'
import { InputOTP, InputOTPGroup, InputOTPSlot, InputOTPSeparator } from './components/ui/input-otp'

const CHECKOUT_URL = import.meta.env.VITE_CHECKOUT_URL ?? 'https://your-checkout-url.com'

const IS_DEV_PREVIEW = import.meta.env.DEV && !(window as any).__TAURI_INTERNALS__

const invokeCmd = IS_DEV_PREVIEW
  ? (cmd: string, args?: any) => (window as any).__mockInvoke(cmd, args)
  : invoke

const FOCUS_RING =
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-500'


interface Props {
  onActivated: () => void
  checkoutUrl?: string
}

export default function License({ onActivated, checkoutUrl = CHECKOUT_URL }: Props) {
  const [otpValue, setOtpValue] = useState('')
  const [loading, setLoading]  = useState(false)
  const [error, setError]      = useState<string | null>(null)
  const [success, setSuccess]  = useState(false)

  const hasError = error !== null

  // Tauri's WebView2 doesn't forward Ctrl+V to input-otp's hidden input,
  // so we catch paste at window level and inject it directly.
  useEffect(() => {
    function onPaste(e: ClipboardEvent) {
      if (loading || success) return
      const text = e.clipboardData?.getData('text') ?? ''
      const clean = text.replace(/[^A-Z0-9]/gi, '').toUpperCase().slice(0, 16)
      if (clean.length > 0) {
        setError(null)
        setOtpValue(clean)
      }
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [loading, success])

  function handleOtpChange(val: string) {
    setError(null)
    setOtpValue(val.toUpperCase())
  }

  async function handleActivate() {
    if (otpValue.length < 16) { setError('Enter a complete 16-character key.'); return }
    const key = `${otpValue.slice(0,4)}-${otpValue.slice(4,8)}-${otpValue.slice(8,12)}-${otpValue.slice(12,16)}`
    setLoading(true)
    setError(null)
    try {
      await invokeCmd('activate_license', { key })
      setSuccess(true)
      setTimeout(() => onActivated(), 900)
    } catch (err: any) {
      setError(typeof err === 'string' ? err : 'Activation failed. Check your key and try again.')
    } finally {
      setLoading(false)
    }
  }

  async function handleBuy() {
    if ((window as any).__TAURI_INTERNALS__) {
      try {
        await invokeCmd('open_url', { url: checkoutUrl })
        return
      } catch {}
    }
    window.open(checkoutUrl, '_blank')
  }

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-[#09090b] text-zinc-100">

      <header className="flex h-10 flex-shrink-0 items-center justify-between border-b border-zinc-800 px-4">
        <span className="text-[11px] font-semibold uppercase tracking-[0.2em] text-zinc-100">
          Phantom
        </span>
        <div className="flex items-center gap-1.5">
          <Lock size={14} className="text-zinc-500" />
          <span className="text-[11px] text-zinc-500">Unlicensed</span>
        </div>
      </header>

      <div className="flex flex-1 flex-col items-center justify-center gap-5 px-4 py-6">

        <div className="flex flex-col items-center gap-2 text-center">
          <KeyRound size={32} className="text-zinc-400" />
          <p className="text-[15px] font-semibold text-zinc-100">Activate Phantom</p>
          <p className="text-[11px] text-zinc-500">Enter your license key to unlock the app.</p>
        </div>

        <div className="w-full rounded-lg border border-zinc-800 bg-zinc-900 p-3 flex flex-col gap-2">
          <p className="text-[10px] font-medium uppercase tracking-widest text-zinc-500">
            License Key
          </p>

          <InputOTP
            maxLength={16}
            pattern={REGEXP_ONLY_DIGITS_AND_CHARS}
            value={otpValue}
            onChange={handleOtpChange}
            disabled={loading || success}
          >
            <InputOTPGroup>
              <InputOTPSlot index={0} />
              <InputOTPSlot index={1} />
              <InputOTPSlot index={2} />
              <InputOTPSlot index={3} />
            </InputOTPGroup>
            <InputOTPSeparator />
            <InputOTPGroup>
              <InputOTPSlot index={4} />
              <InputOTPSlot index={5} />
              <InputOTPSlot index={6} />
              <InputOTPSlot index={7} />
            </InputOTPGroup>
            <InputOTPSeparator />
            <InputOTPGroup>
              <InputOTPSlot index={8} />
              <InputOTPSlot index={9} />
              <InputOTPSlot index={10} />
              <InputOTPSlot index={11} />
            </InputOTPGroup>
            <InputOTPSeparator />
            <InputOTPGroup>
              <InputOTPSlot index={12} />
              <InputOTPSlot index={13} />
              <InputOTPSlot index={14} />
              <InputOTPSlot index={15} />
            </InputOTPGroup>
          </InputOTP>

          {hasError && (
            <p className="text-[11px] text-zinc-400">{error}</p>
          )}

          <button
            type="button"
            onClick={handleActivate}
            disabled={loading || success}
            className={`h-9 w-full cursor-pointer rounded-md border-transparent bg-zinc-100 text-[13px] font-medium text-zinc-900 transition-colors hover:bg-zinc-200 disabled:opacity-60 disabled:cursor-not-allowed flex items-center justify-center gap-2 ${FOCUS_RING}`}
          >
            {loading && <Loader2 size={14} className="animate-spin" />}
            {success && <CheckCircle2 size={14} className="text-emerald-600" />}
            {loading ? 'Activating…' : success ? 'Activated!' : 'Activate'}
          </button>
        </div>

        <div className="relative w-full flex items-center gap-3">
          <div className="flex-1 border-t border-zinc-800" />
          <span className="text-[11px] text-zinc-600">or</span>
          <div className="flex-1 border-t border-zinc-800" />
        </div>

        <button
          type="button"
          onClick={handleBuy}
          className={`h-8 w-full cursor-pointer rounded-md border border-zinc-800 bg-transparent text-[12px] text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-zinc-100 ${FOCUS_RING}`}
        >
          Buy a License
        </button>

        <p className="text-[10px] text-zinc-600 text-center">
          Already purchased? Check your email for your key.
        </p>

      </div>
    </div>
  )
}
