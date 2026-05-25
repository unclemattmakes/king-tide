/**
 * Tiny DOM helpers for building the slider/toggle panels that sit beside
 * each demo. No framework — these articles are static HTML and a handful
 * of imperative widgets is lighter than pulling in a UI library.
 */

type Children = (Node | string)[]

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<Record<string, string>> = {},
  children: Children = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined) continue
    if (k === 'class') node.className = v
    else node.setAttribute(k, v)
  }
  for (const c of children) node.append(c)
  return node
}

export type SliderOpts = {
  label: string
  min: number
  max: number
  step: number
  value: number
  /** Formats the live value readout (e.g. (v) => `${v.toFixed(2)} m`). */
  format?: (v: number) => string
  onInput: (v: number) => void
}

export function slider(opts: SliderOpts): HTMLElement {
  const format = opts.format ?? ((v: number) => String(v))
  const valueOut = el('span', { class: 'mo-ctrl-value' }, [format(opts.value)])
  const input = el('input', {
    type: 'range',
    min: String(opts.min),
    max: String(opts.max),
    step: String(opts.step),
    value: String(opts.value),
    class: 'mo-slider',
  })
  input.addEventListener('input', () => {
    const v = Number(input.value)
    valueOut.textContent = format(v)
    opts.onInput(v)
  })
  return el('label', { class: 'mo-ctrl' }, [
    el('span', { class: 'mo-ctrl-head' }, [
      el('span', { class: 'mo-ctrl-label' }, [opts.label]),
      valueOut,
    ]),
    input,
  ])
}

export type ToggleOpts = {
  label: string
  value: boolean
  onChange: (v: boolean) => void
}

export function toggle(opts: ToggleOpts): HTMLElement {
  const input = el('input', { type: 'checkbox', class: 'mo-checkbox' })
  if (opts.value) input.setAttribute('checked', '')
  input.addEventListener('change', () => opts.onChange(input.checked))
  return el('label', { class: 'mo-ctrl mo-ctrl-toggle' }, [
    input,
    el('span', { class: 'mo-ctrl-label' }, [opts.label]),
  ])
}

export type SegmentedOpts = {
  label: string
  options: { value: string; label: string }[]
  value: string
  onChange: (v: string) => void
}

export function segmented(opts: SegmentedOpts): HTMLElement {
  const group = el('div', { class: 'mo-segmented', role: 'group' })
  const buttons: HTMLButtonElement[] = []
  for (const o of opts.options) {
    const btn = el('button', { type: 'button', class: 'mo-seg-btn' }, [o.label])
    if (o.value === opts.value) btn.classList.add('is-active')
    btn.addEventListener('click', () => {
      for (const b of buttons) b.classList.remove('is-active')
      btn.classList.add('is-active')
      opts.onChange(o.value)
    })
    buttons.push(btn)
    group.append(btn)
  }
  return el('label', { class: 'mo-ctrl' }, [
    el('span', { class: 'mo-ctrl-label' }, [opts.label]),
    group,
  ])
}

export function panel(title: string, children: HTMLElement[]): HTMLElement {
  return el('div', { class: 'mo-panel' }, [
    el('div', { class: 'mo-panel-title' }, [title]),
    ...children,
  ])
}

/** A small live numeric readout that a demo can update each frame. */
export function readout(label: string): { node: HTMLElement; set: (v: string) => void } {
  const value = el('span', { class: 'mo-readout-value' }, ['—'])
  const node = el('div', { class: 'mo-readout' }, [
    el('span', { class: 'mo-readout-label' }, [label]),
    value,
  ])
  return { node, set: (v) => (value.textContent = v) }
}
