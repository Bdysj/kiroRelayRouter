import { useEffect, useRef, useState } from 'react'
import { Input } from '@/components/ui/input'

type TokenInputProps = Omit<
  React.ComponentProps<typeof Input>,
  'type' | 'value' | 'onChange' | 'inputMode'
> & {
  value: number | null
  nullable?: boolean
  onValueChange: (value: number | null) => void
}

/** Non-negative integer editor that permits an empty draft and has no stepper. */
export function TokenInput({
  value,
  nullable = false,
  onValueChange,
  ...props
}: TokenInputProps) {
  const [text, setText] = useState(() => (value === null ? '' : String(value)))
  const focused = useRef(false)

  useEffect(() => {
    if (!focused.current) setText(value === null ? '' : String(value))
  }, [value])

  return (
    <Input
      {...props}
      type='text'
      inputMode='numeric'
      pattern='[0-9]*'
      value={text}
      onFocus={() => {
        focused.current = true
      }}
      onChange={(event) => {
        const next = event.target.value
        if (!/^\d*$/.test(next)) return
        setText(next)
        if (next !== '') onValueChange(Number(next))
        else if (nullable) onValueChange(null)
      }}
      onBlur={() => {
        focused.current = false
        if (text === '') {
          if (nullable) {
            onValueChange(null)
            return
          }
          setText('0')
          onValueChange(0)
          return
        }
        const normalized = String(Number(text))
        setText(normalized)
        onValueChange(Number(normalized))
      }}
    />
  )
}
