import {createI18n} from 'vue-i18n';
import en from './locales/en.json';
import zh from './locales/zh.json';
import ja from './locales/ja.json';
import ru from './locales/ru.json';
import es from './locales/es.json';

const availableLanguages = ['en', 'zh', 'ja', 'ru', 'es'];
const messages = {
    en,
    zh,
    ja,
    ru,
    es,
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