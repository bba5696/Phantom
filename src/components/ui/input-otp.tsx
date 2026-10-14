import * as React from "react"
import { OTPInput, OTPInputContext } from "input-otp"

function cn(...classes: (string | undefined | false | null)[]) {
  return classes.filter(Boolean).join(" ")
}

const InputOTP = React.forwardRef<
  React.ElementRef<typeof OTPInput>,
  React.ComponentPropsWithoutRef<typeof OTPInput>
>(({ className, containerClassName, ...props }, ref) => (
  <OTPInput
    ref={ref}
    containerClassName={cn(
      "flex w-full items-center gap-1 has-[:disabled]:opacity-50",
      containerClassName
    )}
    className={cn("disabled:cursor-not-allowed", className)}
    {...props}
  />
))
InputOTP.displayName = "InputOTP"

const InputOTPGroup = React.forwardRef<
  React.ElementRef<"div">,
  React.ComponentPropsWithoutRef<"div">
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("flex flex-1 items-center rounded-xl border border-zinc-700 overflow-hidden", className)}
    {...props}
  />
))
InputOTPGroup.displayName = "InputOTPGroup"

const InputOTPSlot = React.forwardRef<
  React.ElementRef<"div">,
  React.ComponentPropsWithoutRef<"div"> & { index: number }
>(({ index, className, ...props }, ref) => {
  const inputOTPContext = React.useContext(OTPInputContext)
  const { char, hasFakeCaret, isActive } = inputOTPContext.slots[index]

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { ...divProps } = props

  return (
    <div
      ref={ref}
      className={cn(
        "relative flex flex-1 h-8 min-w-0 items-center justify-center font-mono text-[11px] transition-all",
        "border-l border-zinc-700 first:border-l-0",
        isActive && "bg-zinc-800/70 text-blue-400 z-10",
        !isActive && "text-zinc-100",
        className
      )}
      {...divProps}
    >
      {char ? (
        <span>{char}</span>
      ) : (
        <span className="text-zinc-700">·</span>
      )}
      {hasFakeCaret && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="h-4 w-px animate-caret-blink bg-blue-400 duration-1000" />
        </div>
      )}
    </div>
  )
})
InputOTPSlot.displayName = "InputOTPSlot"

const InputOTPSeparator = React.forwardRef<
  React.ElementRef<"div">,
  React.ComponentPropsWithoutRef<"div">
>(({ ...props }, ref) => (
  <div ref={ref} role="separator" className="text-zinc-600 text-[10px] font-mono px-0.5 shrink-0" {...props}>
    —
  </div>
))
InputOTPSeparator.displayName = "InputOTPSeparator"

export { InputOTP, InputOTPGroup, InputOTPSlot, InputOTPSeparator }
