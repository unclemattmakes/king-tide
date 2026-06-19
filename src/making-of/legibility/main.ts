import '../shared/site.css'
import { mountLegibilityDemo } from './legibility-demo'

const stage = document.querySelector('#legibility-demo-stage')
const controls = document.querySelector('#legibility-demo-controls')
if (stage instanceof HTMLElement && controls instanceof HTMLElement) {
  mountLegibilityDemo(stage, controls)
}
