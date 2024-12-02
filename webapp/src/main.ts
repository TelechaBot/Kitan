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
import {createRouter, createWebHistory} from "vue-router";

const routes = [
    {path: '/', component: App},
]
const router = createRouter({
    history: createWebHistory(),
    routes,
})
import '@mdi/font/css/materialdesignicons.css'
// Components
const vuetify = createVuetify({
    components,
    directives,
    icons: {
        defaultSet: 'mdi', // This is already the default value - only for display purposes
    },
})
import i18n from './i18n';

const app = createApp(App)
app.use(vuetify).use(VueTelegram).use(router)
app.use(i18n)
app.mount('#app')
