import { createApp } from 'vue'
import { createPinia } from 'pinia'
import router from './router'
import App from './App.vue'
import './assets/main.css'

// Downloaded font assets are optional and absent from a clean Git checkout.
// Load this stylesheet in the browser so the build needs only tracked files.
const readingFonts = document.createElement('link')
readingFonts.rel = 'stylesheet'
readingFonts.href = `${import.meta.env.BASE_URL}fonts/lxgw-wenkai-screen/lxgwwenkaiscreen.css`
document.head.appendChild(readingFonts)

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')
