import { useEffect, useRef, useState, type CSSProperties } from 'react'

// ── Splash intro ───────────────────────────────────────────────────────────────
//
// Plays once on launch, then calls onDone():
//   enter   "PHANTOM" blurs in letter by letter; the moon icon blooms in above it
//   engulf  the letters are drawn into the icon (nearest first) and slip behind
//           it; the icon pulses as it absorbs them and settles to dead centre
//   exit    a brief hold on the icon, then the whole splash fades to black
//
// The @keyframes live in index.css (@layer base). Every duration and delay is
// set inline from T below, so the phase timers and the CSS share one timeline.

type Phase = 'enter' | 'engulf' | 'exit'

interface Geometry {
  /** Offset from each letter's centre to the icon's centre, in px. */
  offsets: { dx: number; dy: number }[]
  /** Downward shift that leaves the icon dead centre once the word is gone, in px. */
  settle: number
}

/** Inline style that can also carry CSS custom properties. */
type StyleVars = CSSProperties & Record<`--${string}`, string>

const WORD = 'PHANTOM'.split('')
const MID  = (WORD.length - 1) / 2
const ICON = 128 // half the 256px source, so the pixel art downsamples cleanly
const HALO = 340

// Timeline in ms, measured from mount. The entrance finishes (1120) before the
// engulf starts, and the engulf/settle finish (1990) before the exit.
const T = {
  letterDelay:   140, // first letter starts
  letterStagger:  65,
  letterDur:     560,
  iconDelay:     360,
  iconDur:       760,
  engulf:       1150, // phase -> engulf
  engulfStagger:  40, // centre-out: N first, P and M last
  engulfDur:     640,
  settleDelay:   120,
  settleDur:     720,
  absorbDelay:   250, // icon pulse peaks (~1720) as the letters slip into it
  absorbDur:     720,
  exit:         2040, // phase -> exit
  exitDur:       420, // onDone() fires at exit + exitDur = 2460
}

const EASE_OUT    = 'cubic-bezier(0.22, 1, 0.36, 1)'      // easeOutQuint
const EASE_IN_OUT = 'cubic-bezier(0.65, 0, 0.35, 1)'      // easeInOutCubic
const EASE_PULL   = 'cubic-bezier(0.36, -0.15, 0.7, 0.15)' // small inhale, then accelerates in
const EASE_FADE   = 'cubic-bezier(0.37, 0, 0.63, 1)'      // easeInOutSine

const anim = (name: string, dur: number, ease: string, delay = 0) =>
  `${name} ${dur}ms ${ease} ${delay}ms both`

export default function Splash({ onDone }: { onDone: () => void }) {
  const [phase, setPhase] = useState<Phase>('enter')
  const [geo, setGeo]     = useState<Geometry | null>(null)
  // Honour the OS "reduce motion" setting: same timeline, opacity fades only.
  const [reduce] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches)

  const stageRef   = useRef<HTMLDivElement>(null)
  const iconRef    = useRef<HTMLImageElement>(null)
  const letterRefs = useRef<(HTMLSpanElement | null)[]>([])
  const onDoneRef  = useRef(onDone)

  useEffect(() => { onDoneRef.current = onDone }, [onDone])

  useEffect(() => {
    // offset* report layout boxes and ignore transforms, so this is exact no
    // matter where the entrance animations are. Icon and letters share the
    // stage (position: relative) as their offsetParent.
    const measure = (): Geometry | null => {
      const stage = stageRef.current
      const icon  = iconRef.current
      if (!stage || !icon) return null
      const cx = icon.offsetLeft + icon.offsetWidth / 2
      const cy = icon.offsetTop + icon.offsetHeight / 2
      return {
        offsets: letterRefs.current.map(el =>
          el
            ? { dx: cx - (el.offsetLeft + el.offsetWidth / 2), dy: cy - (el.offsetTop + el.offsetHeight / 2) }
            : { dx: 0, dy: 0 },
        ),
        settle: stage.offsetHeight / 2 - cy,
      }
    }

    const timers = [
      window.setTimeout(() => { setGeo(measure()); setPhase('engulf') }, T.engulf),
      window.setTimeout(() => setPhase('exit'), T.exit),
      window.setTimeout(() => onDoneRef.current(), T.exit + T.exitDur),
    ]
    return () => timers.forEach(id => window.clearTimeout(id))
  }, [])

  // engulf and exit keep the same animation strings, so nothing restarts when
  // the exit fade begins; only the root picks up a new animation.
  const absorbing = phase !== 'enter'

  const rootStyle: CSSProperties = {
    animation: phase === 'exit'
      ? anim(reduce ? 'phantom-fade-out' : 'phantom-splash-out', T.exitDur, EASE_FADE)
      : undefined,
  }

  const stageStyle: StyleVars = {
    '--settle': `${geo?.settle ?? 0}px`,
    animation: absorbing && !reduce
      ? anim('phantom-stage-settle', T.settleDur, EASE_IN_OUT, T.settleDelay)
      : undefined,
  }

  const haloStyle: CSSProperties = {
    left: '50%',
    top: ICON / 2,
    width: HALO,
    height: HALO,
    marginLeft: -HALO / 2,
    marginTop: -HALO / 2,
    opacity: 0,
    background:
      'radial-gradient(circle, rgb(91 110 225 / 0.28) 0%, rgb(91 110 225 / 0.1) 38%, transparent 68%)',
    animation: reduce
      ? undefined
      : absorbing
        ? anim('phantom-halo-pulse', T.absorbDur, EASE_IN_OUT, T.absorbDelay)
        : anim('phantom-halo-in', T.iconDur + 240, EASE_OUT, T.iconDelay),
  }

  const iconStyle: CSSProperties = {
    width: ICON,
    height: ICON,
    animation: reduce
      ? anim('phantom-fade-in', T.iconDur, EASE_OUT, T.iconDelay)
      : absorbing
        ? anim('phantom-icon-absorb', T.absorbDur, EASE_IN_OUT, T.absorbDelay)
        : anim('phantom-icon-in', T.iconDur, EASE_OUT, T.iconDelay),
  }

  const letterStyle = (i: number): StyleVars => {
    const off = geo?.offsets[i] ?? { dx: 0, dy: 0 }
    return {
      '--sx': `${(i - MID) * 4}px`, // letters start slightly spread and track in
      '--dx': `${off.dx}px`,
      '--dy': `${off.dy}px`,
      animation: absorbing
        ? anim(
            reduce ? 'phantom-fade-out' : 'phantom-letter-engulf',
            T.engulfDur,
            reduce ? EASE_FADE : EASE_PULL,
            Math.abs(i - MID) * T.engulfStagger,
          )
        : anim(
            reduce ? 'phantom-fade-in' : 'phantom-letter-in',
            T.letterDur,
            EASE_OUT,
            T.letterDelay + i * T.letterStagger,
          ),
    }
  }

  return (
    <div
      aria-hidden="true"
      data-phase={phase}
      className="fixed inset-0 z-50 flex cursor-default items-center justify-center bg-[#09090b]"
      style={rootStyle}
    >
      <div ref={stageRef} className="relative flex flex-col items-center" style={stageStyle}>
        <div className="pointer-events-none absolute" style={haloStyle} />

        {/* z-10 keeps the icon above the letters, so they slip into it rather than over it */}
        <img
          ref={iconRef}
          src="/icon.png"
          alt=""
          draggable={false}
          className="relative z-10 block"
          style={iconStyle}
        />

        <div className="mt-7 flex gap-[0.55em] text-[32px] leading-none font-light text-zinc-50">
          {WORD.map((ch, i) => (
            <span
              key={i}
              ref={el => { letterRefs.current[i] = el }}
              style={letterStyle(i)}
            >
              {ch}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}
