import {createI18n} from 'vue-i18n';
import en from './locales/en.json';
import zh from './locales/zh.json';
import ja from './locales/ja.json';
import ru from './locales/ru.json';
import es from './locales/es.json';
import ar from './locales/ar.json';
import bn from './locales/bn.json';
import hi from './locales/hi.json';

const availableLanguages = ['en', 'zh', 'ja', 'ru', 'es', 'ar', 'bn', 'hi'];
const messages = {
    en,
    zh,
    ja,
    ru,
    es,
    ar,
    bn,
    hi
};

// Function to detect browser language
function getBrowserLanguage() {
    const language = navigator.language
    for (const lang of availableLanguages) {
        if (language.includes(lang)) {
            return lang;
        }
    }
    return 'en';
}

const i18n = createI18n({
    locale: getBrowserLanguage(), // set locale based on browser language
    fallbackLocale: 'en', // set fallback locale
    messages,
});

export default i18n;