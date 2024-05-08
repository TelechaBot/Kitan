<script setup lang="ts">
import {useWebApp} from "vue-tg";
import {useWebAppBiometricManager} from 'vue-tg';
import {useWebAppPopup} from 'vue-tg'
import {ref} from "vue";


// 响应式数据
const token = ref<string | undefined>(undefined)
const popup = useWebAppPopup()
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
  const result = WebAppBiometricManager.requestBiometricAccess(
      {reason: 'Please authenticate to continue'},
      callback
  )
  console.log(result)
}
WebAppBiometricManager.initBiometric()
</script>

<template>
  <div
  >
    <v-card
        class="mx-auto mt-5"
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
      </v-card-actions>
    </v-card>
    <div class="flex flex-col items-center justify-center">
      Platform: <span>{{ WebApp.platform }}</span>
      <br>
      Version: <span>{{ WebApp.version }}</span>
      <br>
      Device ID: <span>{{ WebAppBiometricManager.biometricDeviceId }}</span>
      <br>
    </div>
  </div>
</template>

<style scoped>
</style>
