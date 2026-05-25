import '../shared/site.css'
import { mountSimRenderDemo } from './sim-render-demo'

const stage = document.querySelector('#sr-demo-stage')
const controls = document.querySelector('#sr-demo-controls')
if (stage instanceof HTMLElement && controls instanceof HTMLElement) {
  mountSimRenderDemo(stage, controls)
}
