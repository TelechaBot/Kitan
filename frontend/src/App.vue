<script setup lang="ts">
import {computed, reactive, ref, watch} from "vue";
import {useRoute} from 'vue-router';
import axios from 'axios';
import VueTurnstile from 'vue-turnstile';
import Puzzles from "./components/Puzzles.vue";
import {useWebApp, useWebAppBiometricManager, useWebAppNavigation, useWebAppPopup} from "vue-tg";
import {useGyroscopeExists} from "./hook/useGyroscopeExists.ts";
import {useAccelerometerExists} from "./hook/useAccelerometerExists.ts";
import CryptoJS from 'crypto-js';
import VersionInfo from "./components/VersionInfo.vue";
import {useI18n} from 'vue-i18n';

const {t} = useI18n();
const route = useRoute();
const {openLink} = useWebAppNavigation()

enum AuthType {
  POW = 'pow',
  BIOMETRIC = 'biometric',
  OUTLINE = 'outline',
}

interface RouteParams {
  chat_id: string;
  message_id: string;
  timestamp: string;
  signature: string;
}

const authToken = ref<string | undefined>(undefined)
const isBiometricInitialized = ref<boolean>(false)
const turnstile_token = ref<string>('')
const cloudflareSiteKey = ref(import.meta.env.VITE_CLOUDFLARE_SITE_KEY)
const verifyBackendMessage = reactive({
  success: false,
  message: ''
})
// Cloudflare 验证失败
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
// 路由参数
const routerGet = (): RouteParams | null => {
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

console.log(`Page Route`, routerGet())

function compareVersions(v1: string, v2: string): number {
  const v1Parts = v1.split('.').map(Number);
  const v2Parts = v2.split('.').map(Number);
  for (let i = 0; i < Math.max(v1Parts.length, v2Parts.length); i++) {
    const v1Part = v1Parts[i] || 0;
    const v2Part = v2Parts[i] || 0;

    if (v1Part > v2Part) return 1;
    if (v1Part < v2Part) return -1;
  }
  return 0;
}

// 验证类型
const authType = computed(() => {
  // 验证类型
  if (WebApp.isPlatformUnknown || !WebApp.initData) {
    console.log('OUTLINE')
    return AuthType.OUTLINE
  } else if (compareVersions(WebApp.version, '7.2') >= 0 && isBiometricInitialized.value) {
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

class Data {
  getTime(data: string): string {
    const cc = CryptoJS.SHA256(data).toString().split('').filter((char: string) => char === '0').length;
    let vx = Date.now();
    while (vx % (cc + 1) !== 0) vx++;
    return vx.toString();
  }
}

// 处理 Cloudflare 验证失败
const handleCloudflareFail = (error: string) => {
  isCloudflareFailed.status = true
  isCloudflareFailed.message = `Cloudflare error: ${error}`
}
// 处理 Cloudflare 不支持
const handleCloudflareUnsupported = () => {
  isCloudflareFailed.status = true
  isCloudflareFailed.message = 'Cloudflare not supported'
  isCloudflareFailed.show_turnstile = false
}
// 处理拼图验证成功
const handlePuzzleSuccess = () => {
  console.log('Puzzle success')
  authSuccess()
}
// 打开生物识别设置
const openAuthSettings = () => {
  if (!WebAppBiometricManager.isBiometricInited.value) {
    return WebAppPopup.showAlert('Biometric not initialized')
  }
  WebAppBiometricManager.openBiometricSettings()
}
// 生物识别验证
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
// 验证 Cloudflare
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
// 通知后端中心
const authSuccess = () => {
  // 从环境变量获取后端地址
  const backendEndpoint = import.meta.env.VITE_BACKEND_URL
  if (!backendEndpoint) {
    console.error('Backend URL not found')
    verifyBackendMessage.success = false
    verifyBackendMessage.message = 'Backend URL not configured in this deployment'
    return
  }
  const date_now = new Date().getUTCDate().toString()
  // 去除空格
  const backendUrl = `${backendEndpoint.trim()}/endpoints/verify-captcha`
  const acc = getUserAcc()
  const router = routerGet()
  if (!router) {
    console.error('User params not found')
    verifyBackendMessage.success = false
    verifyBackendMessage.message = 'Who are you?'
    return
  }
  // console.log('Backend URL:', backendUrl)
  const requestBody = {
    // 防止攻击，记录时间戳
    id: `${router.chat_id}-${router.message_id}-${date_now}`,
    // 路由
    source: router,
    // 来源信息
    acc: acc,
    // 路由信息的签名，保证此次会话不是被伪造的。
    signature: router.signature,
    // 已经被签名的数据，由服务端自动验证签名
    web_app_data: WebApp.initData,
    // 日志时间戳
    timestamp: new Data().getTime(WebApp.initData),
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
// 初始化生物识别
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
  <v-container class="py-8">
    <!-- 更新提示 -->
    <v-card
        v-if="authType === AuthType.OUTLINE"
        class="mb-6"
        color="indigo"
        variant="outlined"
        link
        @click="openLink('https://telegram.org/')"
    >
      <v-card-item prepend-icon="mdi-update">
        <v-card-title class="font-weight-bold">
          Update Needed
        </v-card-title>
      </v-card-item>
      <v-card-text class="bg-surface-light pt-4">
        {{ t('updateNeeded') }}
        <br>
        Details: https://telegram.org/
      </v-card-text>
    </v-card>

    <!-- Cloudflare 验证 -->
    <v-card
        v-if="authType === AuthType.POW && cloudflareSiteKey"
        class="mb-6"
        color="indigo"
        variant="outlined"
    >
      <v-card-item prepend-icon="mdi-cloud">
        <v-card-title class="font-weight-bold">
          {{ t('cloudflareAuth') }}
        </v-card-title>
        <v-card-subtitle>
          {{ t('cloudflareAuthIfLoadingFailed') }}
        </v-card-subtitle>
      </v-card-item>
      <v-card-text v-if="isCloudflareFailed.show_turnstile" class="d-flex justify-center">
        <vue-turnstile
            v-model="turnstile_token"
            :site-key="cloudflareSiteKey"
            @error="handleCloudflareFail"
            @unsupported="handleCloudflareUnsupported"
        ></vue-turnstile>
      </v-card-text>
      <v-card-text v-if="isCloudflareFailed.status" class="bg-surface-light pt-4">
        <span :class="{'text-error': isCloudflareFailed.status, 'text-success': !isCloudflareFailed.status}">
          {{ isCloudflareFailed.message }}
        </span>
      </v-card-text>
    </v-card>

    <!-- 拼图验证 -->
    <v-card
        v-if="authType === AuthType.POW"
        class="mb-6"
        color="indigo"
        variant="outlined"
    >
      <v-card-item prepend-icon="mdi-puzzle">
        <v-card-title class="font-weight-bold">
          {{ t('gameAuthTitle') }}
        </v-card-title>
        <v-card-subtitle>
          {{ t('gameTips') }}
        </v-card-subtitle>
      </v-card-item>
      <v-card-text>
        <Puzzles
            :difficulty-level="1"
            :on-success="handlePuzzleSuccess"
        />
        <span
            class="pt-2 self-center flex text-caption text-gray"
        >
          Tips: {{ t('gameBottomTips') }}
        </span>
      </v-card-text>
    </v-card>

    <!-- 生物识别验证 -->
    <v-card
        v-if="authType === AuthType.BIOMETRIC"
        class="mb-6"
        color="indigo"
        variant="outlined"
    >
      <v-card-item>
        <v-card-title class="font-weight-bold">
          {{ t('biometricTitle') }}
        </v-card-title>
        <v-card-subtitle>
          {{ t('biometricSubtitle') }}
        </v-card-subtitle>
      </v-card-item>
      <v-card-text
          v-if="authToken"
          class="pt-4"
      >
        <v-icon>mdi-progress-check</v-icon>
        Success {{ authToken }}
      </v-card-text>
      <v-card-text v-else class="d-flex justify-center align-center py-8">
        <v-btn
            icon="mdi-fingerprint"
            size="x-large"
            variant="plain"
            elevation="0"
            @click="authBiometric"
        >
          <div class="flex flex-col items-center">
            <v-icon size="64">mdi-fingerprint</v-icon>
            <span
                class="p-5 self-center flex text-caption text-gray"
            >
              {{ t('biometricTips') }}
          </span>
          </div>
        </v-btn>
      </v-card-text>
      <v-card-actions class="justify-center">

        <v-btn
            prepend-icon="mdi-cog"
            base-color="indigo-lighten-2"
            text="Settings"
            rounded="2xl"
            size="small"
            @click="openAuthSettings">
          Settings
        </v-btn>

      </v-card-actions>
    </v-card>

    <!-- 后端验证结果 -->
    <v-alert
        v-if="verifyBackendMessage.message"
        :type="verifyBackendMessage.success ? 'success' : 'error'"
        :title="verifyBackendMessage.success ? 'Success' : 'Error'"
        :text="verifyBackendMessage.message"
        class="mb-6"
    ></v-alert>
    <VersionInfo/>
  </v-container>
</template>

<style scoped>
</style>
