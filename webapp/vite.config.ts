import {defineConfig, searchForWorkspaceRoot} from 'vite'
import vue from '@vitejs/plugin-vue'
// vite.config.ts
import UnoCSS from 'unocss/vite'
import process from "node:process";
// Obfuscator
import vitePluginBundleObfuscator from 'vite-plugin-bundle-obfuscator';
// All configurations
const customObfuscatorConfig = {
    excludes: [],
    enable: true,
    log: true,
    autoExcludeNodeModules: true,
    // autoExcludeNodeModules: { enable: true, manualChunks: ['vue'] }
    threadPool: true,
    // threadPool: { enable: true, size: 4 }
    options: {
        stringArray: true,
    },
};
// https://vitejs.dev/config/
export default defineConfig({
    plugins: [
        vue(),
        UnoCSS(),
        vitePluginBundleObfuscator(customObfuscatorConfig)
    ],
    define: {
        'import.meta.env.VITE_BUILD_DATE': JSON.stringify(new Date().toISOString().split('T')[0]),
    },
    base: '/',
    server: {
        fs: {
            allow: [
                // search up for workspace root
                searchForWorkspaceRoot(process.cwd()),
                // custom rules
                // '/path/to/custom/allow',
            ],
        },
    },
})