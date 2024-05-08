<script setup lang="ts">
import HelloWorld from './components/HelloWorld.vue'
import {useWebApp} from "vue-tg";
import {BiometricManager} from "vue-tg";
import {useWebAppBiometricManager} from 'vue-tg';
import {ref} from "vue";

// 响应式数据
const token = ref<string | undefined>(undefined)

const WebApp = useWebApp();
const WebAppBiometricManager = useWebAppBiometricManager();
WebApp.ready()
WebAppBiometricManager.initBiometric()
console.log(WebApp.platform)
const authBiometric = () => {
  const callback = (is_authed: boolean, auth_token?: (string | undefined)) => {
    console.log(is_authed)
    console.log(auth_token)
    token.value = auth_token
  }
  const result = WebAppBiometricManager.authenticateBiometric(
      {reason: 'Please authenticate to continue'},
      callback
  )
  console.log(result)
}
const handleInit = () => {
  console.log('BiometricManager initialized')
}

</script>

<template>
  <div>
    <BiometricManager @init="handleInit"/>
    Platform: <span>{{ WebApp.platform }}</span>
    <br>
    Version: <span>{{ WebApp.version }}</span>
    <br>
    Device ID: <span>{{ WebAppBiometricManager.biometricDeviceId }}</span>
    <br>
    Token: <span>{{ token }}</span>
    <br>
    <button @click="authBiometric">Authenticate</button>
  </div>
  <HelloWorld msg="Vite + Vue"/>
</template>

<style scoped>
.logo {
  height: 6em;
  padding: 1.5em;
  will-change: filter;
  transition: filter 300ms;
}

.logo:hover {
  filter: drop-shadow(0 0 2em #646cffaa);
}

.logo.vue:hover {
  filter: drop-shadow(0 0 2em #42b883aa);
}
</style>
