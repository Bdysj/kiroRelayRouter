import { useEffect, useMemo, useRef, useState } from 'react'
import { Input } from '@/components/ui/input'

/**
 * 价格允许的小数位数，与后端 relay_*_pricing 的 numeric(30,12) 保持一致。
 * 数据库标度是硬上限，这里放到同一个值，前端不再成为更严格的一层限制。
 */
export const PRICE_DECIMALS = 12

type PriceInputProps = Omit<
  React.ComponentProps<typeof Input>,
  'type' | 'value' | 'onChange'
> & {
  value: number
  onValueChange: (value: number) => void
  /** 允许的小数位数，默认 {@link PRICE_DECIMALS}。 */
  maxDecimals?: number
}

/** 把中文输入法常见的全角数字、全角句号和千分位分隔符折算成半角小数写法。 */
function sanitize(raw: string) {
  return raw
    .replace(/[\uff10-\uff19]/g, (character) =>
      String.fromCharCode(character.charCodeAt(0) - 0xfee0)
    )
    .replace(/[\u3002\uff0e\uff61]/g, '.')
    .replace(/[,\uff0c\s]/g, '')
}

/** 渲染成定点小数，避免 1e-9 这类科学计数法直接出现在输入框里。 */
function decimalText(value: number, maxDecimals: number) {
  if (!Number.isFinite(value)) return '0'
  const raw = String(value)
  if (!/[eE]/.test(raw)) return raw
  const fixed = value.toFixed(maxDecimals)
  return fixed.includes('.')
    ? fixed.replace(/0+$/, '').replace(/\.$/, '')
    : fixed
}

/**
 * 小数价格输入框。
 *
 * 用受控的草稿文本而不是 `type='number'`：既能在输入过程中保留 `0.` 这类中间态，
 * 又不会出现原生步进器把小数吞掉的问题。超出允许位数的按键会被忽略，其余一律接受。
 */
export function PriceInput({
  value,
  onValueChange,
  maxDecimals = PRICE_DECIMALS,
  ...props
}: PriceInputProps) {
  const [text, setText] = useState(() => decimalText(value, maxDecimals))
  const focused = useRef(false)
  const pattern = useMemo(
    () => new RegExp(`^\\d*(?:\\.\\d{0,${maxDecimals}})?$`),
    [maxDecimals]
  )

  useEffect(() => {
    if (!focused.current) setText(decimalText(value, maxDecimals))
  }, [value, maxDecimals])

  return (
    <Input
      {...props}
      type='text'
      inputMode='decimal'
      autoComplete='off'
      value={text}
      onFocus={() => {
        focused.current = true
      }}
      onChange={(event) => {
        const next = sanitize(event.target.value)
        if (!pattern.test(next)) return
        setText(next)
        // `''`、`'.'`、`'0.'` 都是合法的中间态，此时不回写数值，等用户补全。
        if (next !== '' && next !== '.' && !next.endsWith('.')) {
          onValueChange(Number(next))
        }
      }}
      onBlur={() => {
        focused.current = false
        const normalized = decimalText(Number(text || 0), maxDecimals)
        setText(normalized)
        onValueChange(Number(normalized))
      }}
    />
  )
}
