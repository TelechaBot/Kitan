<script setup lang="ts">
import {computed, reactive, ref, watch} from "vue";
import {useRoute} from 'vue-router';
import axios from 'axios';
import VueTurnstile from 'vue-turnstile';
import Puzzles from "./components/Puzzles.vue";
import {useWebApp, useWebAppBiometricManager, useWebAppPopup} from "vue-tg";
import {useGyroscopeExists} from "./hook/useGyroscopeExists.ts";
import {useAccelerometerExists} from "./hook/useAccelerometerExists.ts";

const route = useRoute();

enum AuthType {
  POW = 'pow',
  BIOMETRIC = 'biometric',
  OUTLINE = 'outline',
}

const authToken = ref<string | undefined>(undefined)
const isBiometricInitialized = ref<boolean>(false)
const turnstile_token = ref<string>('')
const cloudflareSiteKey = ref(import.meta.env.VITE_CLOUDFLARE_SITE_KEY)
const verifyBackendMessage = reactive({
  success: false,
  message: ''
})
const isCloudflareFailed = reactive(
    {
      status: false,
      message: '',
      show_turnstile: true,
    }
)
const WebAppPopup = useWebAppPopup()
const WebApp = useWebApp();
const WebAppBiometricManager = useWebAppBiometricManager();
const isGyroscopeExist = useGyroscopeExists();
const isAccelerometerExist = useAccelerometerExists();
const routerGet = () => {
  if (!route.query.chat_id || !route.query.message_id || !route.query.timestamp || !route.query.signature) {
    return null
  }
  return {
    chat_id: route.query.chat_id as string,
    message_id: route.query.message_id as string,
    timestamp: route.query.timestamp as string,
    signature: route.query.signature as string,
  }
}

console.log(routerGet())

// 验证类型
const authType = computed(() => {
  // 验证类型
  if (WebApp.isPlatformUnknown || !WebApp.initData) {
    console.log('OUTLINE')
    return AuthType.OUTLINE
  } else if (WebApp.version >= '7.2' && isBiometricInitialized.value) {
    console.log('BIOMETRIC')
    return AuthType.BIOMETRIC
  } else {
    console.log('POW')
    return AuthType.POW
  }
});
// 构造用户可信度信息
const getUserAcc = () => {
  return {
    gyro: isGyroscopeExist.value,
    acc: isAccelerometerExist.isAvailable.value,
    biometric: WebAppBiometricManager.isBiometricAvailable.value,
    platform: WebApp.platform,
    version: WebApp.version,
    timeStamp: new Date().getTime(),
    deviceId: WebAppBiometricManager.biometricDeviceId.value,
    verify_mode: authType.value,
  }
}
const openAuthSettings = () => {
  if (!WebAppBiometricManager.isBiometricInited.value) {
    return WebAppPopup.showAlert('Biometric not initialized')
  }
  WebAppBiometricManager.openBiometricSettings()
}
const authBiometric = () => {
  const biometricCallback = (is_authed: boolean, auth_token?: (string | undefined)) => {
    if (is_authed) {
      console.log('Biometric authenticated')
      authToken.value = auth_token || `authenticated as ${WebAppBiometricManager.biometricType.value} type`
      authSuccess()
    } else {
      console.log('Biometric not authenticated')
      WebAppPopup.showAlert('Biometric not authenticated')
    }
  }
  if (!WebAppBiometricManager.isBiometricInited.value) {
    console.log('Biometric not initialized')
    WebAppPopup.showAlert('Biometric not initialized')
    return
  }
  if (!WebAppBiometricManager.isBiometricAvailable.value) {
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


const authCloudflare = () => {
  const backendEndpoint = import.meta.env.VITE_BACKEND_URL
  if (!backendEndpoint) {
    console.error('Backend URL not found')
    verifyBackendMessage.success = false
    verifyBackendMessage.message = 'Backend URL not configured in this deployment'
    return
  }
  const backendUrl = `${backendEndpoint.trim()}/endpoints/verify-cloudflare`
  const router = routerGet()
  if (!router) {
    console.error('User params not found')
    verifyBackendMessage.success = false
    verifyBackendMessage.message = 'Who are you?'
    return
  }
  //console.log('Backend URL:', backendUrl)
  const requestBody = {
    // 路由
    source: router,
    // 从 Cloudflare 获取的 token
    turnstile_token: turnstile_token.value,
    // 已经被签名的数据，由服务端自动验证签名
    web_app_data: WebApp.initData,
  }
  //console.log('Request body:', requestBody)
  axios.post(backendUrl, requestBody)
      .then((response) => {
        console.log('Response:', response)
        if (response.status === 200) {
          authSuccess()
        } else {
          isCloudflareFailed.status = true
          isCloudflareFailed.message = `Cloudflare verification failed: ${response.status} ${response.statusText}`
        }
      })
      .catch((error) => {
        console.error('Error:', error)
        isCloudflareFailed.status = true
        isCloudflareFailed.message = `Network issue: ${error.response?.data?.message}` || `Cloudflare server error: ${error.code}`
      })
}

// 发送数据到后端，代表验证成功
const authSuccess = () => {
  // 从环境变量获取后端地址
  const backendEndpoint = import.meta.env.VITE_BACKEND_URL
  if (!backendEndpoint) {
    console.error('Backend URL not found')
    verifyBackendMessage.success = false
    verifyBackendMessage.message = 'Backend URL not configured in this deployment'
    return
  }
  // 去除空格
  const backendUrl = `${backendEndpoint.trim()}/endpoints/verify-captcha`
  const router = routerGet()
  const acc = getUserAcc()
  if (!router) {
    console.error('User params not found')
    verifyBackendMessage.success = false
    verifyBackendMessage.message = 'Who are you?'
    return
  }
  // console.log('Backend URL:', backendUrl)
  // 将本人移出死亡定时队列 :D
  const requestBody = {
    // 路由
    source: router,
    // 来源信息
    acc: acc,
    // 路由信息的签名，保证此次会话不是被伪造的。
    signature: router.signature,
    // 已经被签名的数据，由服务端自动验证签名
    web_app_data: WebApp.initData,
  }
  //console.log('Request body:', requestBody)
  // 发送请求
  axios.post(backendUrl, requestBody)
      .then((response) => {
        console.log('Response:', response)
        if (response.status === 202) {
          verifyBackendMessage.success = true
          verifyBackendMessage.message = 'You are verified'
          // 延迟几秒
          setTimeout(() => {
            WebApp.close()
          }, 3000)
        } else {
          console.error('Error:', response)
          // 获取可能的 message 字段
          if (response.data && response.data.message) {
            verifyBackendMessage.message = response.data.message
          } else {
            verifyBackendMessage.message = `Backend verification failed: ${response.status} ${response.statusText}`
          }
          verifyBackendMessage.success = false
        }
      })
      .catch((error) => {
        console.error('Error:', error)
        verifyBackendMessage.success = false
        verifyBackendMessage.message = error.response?.data?.message || `Backend verification error: ${error.code}`
      })
}
const grantBiometricAccess = () => {
  if (!WebAppBiometricManager.isBiometricInited.value) {
    return console.log('Biometric not initialized')
  }
  WebAppBiometricManager.requestBiometricAccess(
      {reason: 'Please grant biometric access first'},
      (isAccessGranted: boolean) => {
        if (isAccessGranted) {
          console.log('Biometric access granted')
        } else {
          console.log('Biometric access denied')
          // WebAppPopup.showAlert('Biometric access denied, you can click settings to open the settings')
        }
      }
  )
}
const initBiometric = () => {
  WebAppBiometricManager.initBiometric(
      () => {
        console.log('Biometric initialized')
      }
  )
}

// 逻辑区域
WebAppBiometricManager.onBiometricManagerUpdated(() => {
  console.log('Biometric manager updated')
  if (WebAppBiometricManager.isBiometricAvailable.value) {
    console.log('Biometric now available')
    console.log(WebAppBiometricManager.biometricType.value)
    isBiometricInitialized.value = true
  } else {
    console.log('Biometric now unavailable')
    isBiometricInitialized.value = false
  }
  if (WebAppBiometricManager.isBiometricAccessGranted.value) {
    console.log('Biometric granted')
  } else {
    console.log('Biometric not granted')
    grantBiometricAccess()
  }
})
isCloudflareFailed.status = false
isCloudflareFailed.show_turnstile = true
watch(turnstile_token, () => {
  // 长度大于 3 时自动验证
  if (turnstile_token.value.length > 3) {
    authCloudflare()
  }
})
console.log(getUserAcc())
initBiometric()
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
    <!-- 更新提示 -->
    <v-card
        class="mx-0 ma-5"
        prepend-icon="mdi-update"
        color="indigo"
        variant="outlined"
        v-if="authType === AuthType.OUTLINE"
        link
        href="https://telegram.org/"
    >
      <template v-slot:title>
        <span class="font-weight-black">Update Needed</span>
      </template>
      <v-card-text
          class="bg-surface-light pt-4">
        This page should run on the version of the app which supports WebApp
        <br>
        Details:
        https://telegram.org/
      </v-card-text>
    </v-card>
    <!-- 拼图辅助验证 -->
    <div class="mx-0 ma-5"
         v-if="authType===AuthType.POW && cloudflareSiteKey"
    >
      <v-card
          prepend-icon="mdi-cloud"
          color="indigo"
          variant="outlined"
          subtitle="If loading failed, solve game instead"
      >
        <template v-slot:title>
          <span class="font-weight-black">Cloudflare Auth</span>
        </template>
        <v-card-text
            v-if="isCloudflareFailed.show_turnstile"
        >
          <vue-turnstile
              v-model="turnstile_token"
              :site-key="cloudflareSiteKey"
              @error="(error) => {
                isCloudflareFailed.status = true
                isCloudflareFailed.message = `Cloudflare error: ${error}`
              }"
              @unsupported="() => {
                isCloudflareFailed.status = true
                isCloudflareFailed.message = 'Cloudflare not supported'
                isCloudflareFailed.show_turnstile = false
              }"
          ></vue-turnstile>
        </v-card-text>
        <v-card-text class="bg-surface-light pt-4" v-if="isCloudflareFailed.status">
          <span
              :class="isCloudflareFailed.status ? 'font-mono color-black' : 'font-mono color-green'"
          >
            {{ isCloudflareFailed.message }}
          </span>
        </v-card-text>
      </v-card>
    </div>
    <!-- 拼图验证 -->
    <div class="mx-0 ma-5"
         v-if="authType === AuthType.POW">
      <v-card
          class="mx-0 pb-10"
          prepend-icon="mdi-puzzle"
          color="indigo"
          variant="outlined"
          subtitle="Solve the puzzle to join group (1~9)"
      >
        <template v-slot:title>
          <span class="font-weight-black">Game Auth</span>
        </template>
        <Puzzles
            :difficulty-level="1"
            :on-success="() => {
            console.log('Puzzle success')
            authSuccess()
          }"
        />
      </v-card>
    </div>
    <!-- 生物识别验证 -->
    <v-card
        class="mx-0 ma-5"
        prepend-icon="mdi-fingerprint"
        color="indigo"
        v-if="authType === AuthType.BIOMETRIC"
        subtitle="Press to authenticate with biometric"
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
        >
          Settings
        </v-btn>
      </v-card-actions>
    </v-card>
    <!-- 后端验证 -->
    <v-alert
        v-if="verifyBackendMessage.message"
        :text="verifyBackendMessage.message"
        :title="verifyBackendMessage.success ? 'Success' : 'Error'"
        :type="verifyBackendMessage.success ? 'success' : 'error'"
    ></v-alert>
  </div>
</template>

<style scoped>
</style>
