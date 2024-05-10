<script setup lang="ts">
import {useWebApp} from "vue-tg";
import {useWebAppBiometricManager} from 'vue-tg';
import {useWebAppPopup} from 'vue-tg'
import {ref} from "vue";
import Puzzles from "./components/Puzzles.vue";
import {useGyroscopeExists} from "./hook/useGyroscopeExists.ts";
import {useAccelerometerExists} from "./hook/useAccelerometerExists.ts";

const token = ref<string | undefined>(undefined)
const isBiometricInitialized = ref<boolean>(false)
const popup = useWebAppPopup()
const WebApp = useWebApp();
const gyroscope = useGyroscopeExists();
const accelerometer = useAccelerometerExists();
const WebAppBiometricManager = useWebAppBiometricManager();

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

WebAppBiometricManager.initBiometric(
    () => {
      console.log('Biometric initialized')
      if (WebAppBiometricManager.isBiometricAvailable) {
        console.log('Biometric available')
        isBiometricInitialized.value = true
      } else {
        console.log('Biometric not available')
        isBiometricInitialized.value = false
      }
    }
)
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

WebApp.ready()

</script>

<template>
  <span>{{ gyroscope ? 'Gyroscope exists' : 'Gyroscope does not exist' }}</span>
  <span>{{ accelerometer ? 'Accelerometer exists' : 'Accelerometer does not exist' }}</span>
  <Puzzles :difficulty-level="2" :on-success="() => {
    console.log('success')
  }"/>
  <div
  >
    <v-card
        class="mx-5 ma-5"
        prepend-icon="$vuetify"
        v-if="WebApp.version>='5.2' && isBiometricInitialized"
    >
      <template v-slot:title>
        <span class="font-weight-black">Biometric Auth</span>
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
            v-if="!WebAppBiometricManager.isBiometricAccessGranted"
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
