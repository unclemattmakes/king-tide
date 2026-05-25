import '../shared/site.css'
import { mountWaveDemo } from './wave-demo'

const stage = document.querySelector('#wave-demo-stage')
const controls = document.querySelector('#wave-demo-controls')
if (stage instanceof HTMLElement && controls instanceof HTMLElement) {
  mountWaveDemo(stage, controls)
}
