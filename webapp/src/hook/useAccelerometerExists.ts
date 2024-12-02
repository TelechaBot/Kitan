import {ref, onMounted, onUnmounted} from 'vue'

export function useAccelerometerExists() {
    const isAvailable = ref(false)

    const handleEvent = () => {
        if ('DeviceMotionEvent' in window) {
            window.addEventListener('devicemotion', (event) => {
                isAvailable.value = !!event.accelerationIncludingGravity;
                // 从现在开始我们已经检测出是否可以访问加速度计，取消订阅
                window.removeEventListener('devicemotion', handleEvent)
            })
        }
    }

    onMounted(() => {
        handleEvent()
    })

    onUnmounted(() => {
        // 移除校验事件
        window.removeEventListener('devicemotion', handleEvent)
    })

    return {
        isAvailable
    }
}