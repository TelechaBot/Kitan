<template>
  <div :style="containerStyle">
    <label
        :id="INPUT_LABEL_ID"
        :data-mcaptchaUrl="widget.widgetLink.toString()"
        :for="INPUT_NAME"
    >
      mCaptcha authorization token.
      <a :href="INSTRUCTIONS_URL">Instructions</a>.
      <input
          v-model="token"
          :id="INPUT_NAME"
          :name="INPUT_NAME"
          required
          type="text"
      />
    </label>
    <iframe
        title="mCaptcha"
        :src="widget.widgetLink.toString()"
        role="presentation"
        name="mcaptcha-widget__iframe"
        id="mcaptcha-widget__iframe"
        scrolling="no"
        sandbox="allow-same-origin allow-scripts allow-popups"
        width="100%"
        height="100%"
        frameBorder="0"
    >
    </iframe>
  </div>
</template>

<script lang="ts">
// Import vue composition api
import {ref, onMounted, onUnmounted} from 'vue'
import Widget from '@mcaptcha/core-glue'

const INPUT_NAME = 'mcaptcha__token'
const INPUT_LABEL_ID = 'mcaptcha__token-label'
const INSTRUCTIONS_URL = 'https://mcaptcha.org/docs/user-manual/how-to-mcaptcha-without-js/'

export default {
  name: 'MCaptchaWidget',
  props: {
    config: {
      type: Object,
      required: true,
    }
  },
  setup(props) {
    const containerStyle = {
      width: '340px',
      height: '78px',
    }

    const token = ref('')
    // Instantiate new widget
    const widget = new Widget(props.config, val => {
      token.value = val
    })

    onMounted(() => {
      widget.listen()
    })

    onUnmounted(() => {
      widget.destroy()
    })

    return {
      containerStyle,
      INPUT_NAME,
      INPUT_LABEL_ID,
      INSTRUCTIONS_URL,
      token,
      widget
    }
  },
}
</script>