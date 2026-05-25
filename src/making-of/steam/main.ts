import '../shared/site.css'
import { mountSteamDemo } from './steam-demo'

const stage = document.querySelector('#steam-demo-stage')
const controls = document.querySelector('#steam-demo-controls')
if (stage instanceof HTMLElement && controls instanceof HTMLElement) {
  mountSteamDemo(stage, controls)
}
