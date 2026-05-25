import '../shared/site.css'

const yearEl = document.querySelector('#mo-year')
if (yearEl) yearEl.textContent = String(new Date().getFullYear())
