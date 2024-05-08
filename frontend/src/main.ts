import {createApp} from 'vue'
import App from './App.vue'
import VueTelegram from 'vue-tg'
// main.ts
import 'virtual:uno.css'
import '@unocss/reset/tailwind.css'
// Vuetify
import 'vuetify/styles'
import {createVuetify} from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'

// Components
const vuetify = createVuetify({
    components,
    directives,
})
createApp(App).use(vuetify).use(VueTelegram).mount('#app')
