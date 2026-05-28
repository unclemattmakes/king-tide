import '../shared/site.css'
import { mountAnatomyDemo } from './anatomy-demo'
import { mountDriveDemo } from './drive-demo'
import { mountHoverSpringDemo } from './hover-spring-demo'

mountIfPresent('anatomy-demo', mountAnatomyDemo)
mountIfPresent('hover-spring-demo', mountHoverSpringDemo)
mountIfPresent('drive-demo', mountDriveDemo)

function mountIfPresent(
  prefix: string,
  mount: (stage: HTMLElement, controls: HTMLElement) => () => void,
): void {
  const stage = document.querySelector(`#${prefix}-stage`)
  const controls = document.querySelector(`#${prefix}-controls`)
  if (stage instanceof HTMLElement && controls instanceof HTMLElement) {
    mount(stage, controls)
  }
}
