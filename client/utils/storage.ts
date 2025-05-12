import { reactive, watch, Reactive } from 'vue'

export const tryJsonParse = <T>(json: string): T => {
  try {
    return JSON.parse(json)
  }
  catch {
    return undefined
  }
}

export const storeReactive = <T extends object>(key: string, defaultValue: T): Reactive<T> & Disposable => {
  const value = tryJsonParse<T>(localStorage.getItem(key)) ?? defaultValue
  const valueR = reactive(value)
  const unwatch = watch(valueR, newValue => localStorage.setItem(key, JSON.stringify(newValue)))
  return Object.assign(valueR, {
    [Symbol.dispose]: unwatch
  })
}