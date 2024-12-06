import {ref, onMounted} from 'vue'

export function useGyroscopeExists() {
    const gyroscopeExists = ref(false)
    // onMounted类似于React Hook中的useEffect，但仅在组件被装载后调用
    onMounted(() => {
        if (typeof window !== 'undefined' && window.DeviceOrientationEvent) {
            gyroscopeExists.value = true
        }
    })
    return gyroscopeExists
}