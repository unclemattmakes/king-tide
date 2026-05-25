import '../shared/site.css'
import { mountDriftDemo } from './drift-demo'

const stage = document.querySelector('#drift-demo-stage')
const controls = document.querySelector('#drift-demo-controls')
if (stage instanceof HTMLElement && controls instanceof HTMLElement) {
  mountDriftDemo(stage, controls)
}
