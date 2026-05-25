import '../shared/site.css'
import { mountBuoyancyDemo } from './buoy-demo'

const stage = document.querySelector('#buoy-demo-stage')
const controls = document.querySelector('#buoy-demo-controls')
if (stage instanceof HTMLElement && controls instanceof HTMLElement) {
  mountBuoyancyDemo(stage, controls)
}
