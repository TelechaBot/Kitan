<script setup lang="ts">
import {useWebApp} from "vue-tg";
import {useWebAppBiometricManager} from 'vue-tg';
import {useWebAppPopup} from 'vue-tg'
import {ref} from "vue";

console.log('1705')
// 响应式数据
const token = ref<string | undefined>(undefined)
const popup = useWebAppPopup()
const WebApp = useWebApp();
const WebAppBiometricManager = useWebAppBiometricManager();
WebApp.ready()
WebAppBiometricManager.initBiometric()
console.log(WebApp.platform)

const openAuthSettings = () => {
  WebAppBiometricManager.openBiometricSettings()
}

const authBiometric = () => {
  const callback = (is_authed: boolean, auth_token?: (string | undefined)) => {
    console.log(is_authed)
    console.log(auth_token)
    if (!auth_token) {
      token.value = `Auth Not Passed ${is_authed}`
    } else {
      token.value = auth_token
    }
  }
  if (!WebAppBiometricManager.isBiometricInited) {
    console.log('Biometric not initialized')
    popup.showAlert('Biometric not initialized')
    return
  }
  if (!WebAppBiometricManager.isBiometricAvailable) {
    console.log('Biometric not supported')
    popup.showAlert('Biometric not supported')
    return
  }
  const result = WebAppBiometricManager.authenticateBiometric(
      {reason: 'Please authenticate to continue'},
      callback
  )
  console.log("End of authBiometric")
  console.log(result)
}

WebAppBiometricManager.initBiometric()
if (WebAppBiometricManager.isBiometricAccessGranted) {
  console.log('Biometric available')
} else {
  console.log('Biometric not available')
  WebAppBiometricManager.requestBiometricAccess(
      {reason: 'Please authenticate to continue'},
      (isAccessGranted: boolean) => {
        if (isAccessGranted) {
          console.log('Biometric access granted')
        } else {
          console.log('Biometric access denied')
          popup.showAlert('Biometric access denied')
        }
      }
  )
}
</script>

<template>
  <div
  >
    <v-card
        class="mx-auto ma-5"
        width="400"
        prepend-icon="$vuetify"

    >
      <template v-slot:title>
        <span class="font-weight-black">Token</span>
      </template>
      <v-card-text class="bg-surface-light pt-4" v-if="token">
        {{ token }}
      </v-card-text>
      <v-card-actions>
        <v-btn
            @click="authBiometric"
        >
          Auth
        </v-btn>
        <v-btn
            @click="openAuthSettings"
        >
          Settings
        </v-btn>
      </v-card-actions>
    </v-card>
    <div class="flex flex-col items-center justify-center">
      Platform: <span>{{ WebApp.platform }}</span>
      <br>
      Version: <span>{{ WebApp.version }}</span>
      <br>
    </div>
  </div>
</template>

<style scoped>
</style>
