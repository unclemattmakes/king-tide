import '../shared/site.css'
import { mountTuckDemo } from './tuck-demo'

const stage = document.querySelector('#tuck-demo-stage')
const controls = document.querySelector('#tuck-demo-controls')
if (stage instanceof HTMLElement && controls instanceof HTMLElement) {
  mountTuckDemo(stage, controls)
}
