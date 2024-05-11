<script setup lang="ts">
import {ref, watch} from "vue";
import {useRoute} from 'vue-router';

const route = useRoute();
import Puzzles from "./components/Puzzles.vue";
import {useWebApp} from "vue-tg";
import {useWebAppBiometricManager} from 'vue-tg';
import {useWebAppPopup} from 'vue-tg'
import {useGyroscopeExists} from "./hook/useGyroscopeExists.ts";
import {useAccelerometerExists} from "./hook/useAccelerometerExists.ts";
import {onMounted} from 'vue';

onMounted(() => {
  console.log("获取到的参数", route.query)
});

enum AuthType {
  POW = 'pow',
  BIOMETRIC = 'biometric',
  OUTLINE = 'outline',
}

const authType = ref<AuthType>(AuthType.POW)
const authToken = ref<string | undefined>(undefined)
const isBiometricInitialized = ref<boolean>(false)
const WebAppPopup = useWebAppPopup()
const WebApp = useWebApp();
const WebAppBiometricManager = useWebAppBiometricManager();
const isGyroscopeExist = useGyroscopeExists();
const isAccelerometerExist = useAccelerometerExists();
WebAppBiometricManager.initBiometric(
    () => {
      console.log('Biometric initialized')
      if (WebAppBiometricManager.isBiometricAvailable) {
        console.log('Biometric available')
        console.log(WebAppBiometricManager.biometricType)
        userAcc.biometric = true
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
          WebAppPopup.showAlert('Biometric access denied')
        }
      }
  )
}

// 验证类型
const setAuthType = () => {
  // 验证类型
  if (WebApp.platform === 'unknown') {
    authType.value = AuthType.OUTLINE
  } else if (WebApp.version >= '7.2' && isBiometricInitialized) {
    authType.value = AuthType.BIOMETRIC
  } else {
    authType.value = AuthType.POW
  }
}
setAuthType()
watch(() => isBiometricInitialized, () => {
  setAuthType()
})

// 构造用户可信度信息
const buildUserAcc = () => {
  return {
    gyro: isGyroscopeExist.value,
    acc: isAccelerometerExist.isAvailable.value,
    biometric: WebAppBiometricManager.isBiometricAvailable.value,
    platform: WebApp.platform,
    version: WebApp.version,
    timeStamp: new Date().getTime(),
    deviceId: WebAppBiometricManager.biometricDeviceId,
  }
}
const userAcc = buildUserAcc()

const openAuthSettings = () => {
  WebAppBiometricManager.openBiometricSettings()
}

const authBiometric = () => {
  const biometricCallback = (is_authed: boolean, auth_token?: (string | undefined)) => {
    if (is_authed) {
      console.log('Biometric authenticated')
      authToken.value = auth_token || 'Biometric authenticated'
    } else {
      console.log('Biometric not authenticated')
      WebAppPopup.showAlert('Biometric not authenticated')
    }
  }
  if (!WebAppBiometricManager.isBiometricInited) {
    console.log('Biometric not initialized')
    WebAppPopup.showAlert('Biometric not initialized')
    return
  }
  if (!WebAppBiometricManager.isBiometricAvailable) {
    console.log('Biometric not supported')
    WebAppPopup.showAlert('Biometric not supported')
    return
  }
  const result = WebAppBiometricManager.authenticateBiometric(
      {reason: 'Press to join the party'},
      biometricCallback
  )
  console.log(result)
}

WebApp.ready()
/*
// 从列表里选一个 user ：110453675 110453675
const users = [110453675, 16256221, 59048777]
const user = users[Math.floor(Math.random() * users.length)]
const imageSrc = `https://avatars.githubusercontent.com/u/${user}?s=300&v=4`
*/
</script>

<template>
  <div class="mx-5 ma-5">
    <v-card
        class="mx-5 ma-5"
        prepend-icon="mdi-lock"
        color="indigo"
        variant="outlined"
        v-if="authType === AuthType.OUTLINE"
    >
      <template v-slot:title>
        <span class="font-weight-black">You Are Offline</span>
      </template>
      <v-card-text class="bg-surface
      -light pt-4">
        Please connect to the internet
      </v-card-text>
    </v-card>

    <Puzzles
        v-if="authType === AuthType.POW"
        :difficulty-level="2"
        :on-success="() => {console.log('success')}"
    />

    <v-card
        class="mx-5 ma-5"
        prepend-icon="mdi-fingerprint"
        color="indigo"
        v-if="authType === AuthType.BIOMETRIC"
        variant="outlined"
    >
      <template v-slot:title>
        <span class="font-weight-black">Biometric Auth</span>
      </template>
      <v-card-text class="bg-surface-light pt-4" v-if="authToken">
        {{ authToken }}
      </v-card-text>
      <v-card-actions>
        <v-btn @click="authBiometric">
          Auth
        </v-btn>
        <v-btn
            @click="openAuthSettings"
            v-if="!WebAppBiometricManager.isBiometricAccessGranted"
        >
          Settings
        </v-btn>
      </v-card-actions>
    </v-card>
  </div>
</template>

<style scoped>
</style>
