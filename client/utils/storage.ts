import { reactive, watch, Reactive, MaybeRefOrGetter, toValue, toRef } from 'vue'
import { applyA } from '../../shared/utils'

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
  const dispose = watch(valueR, newValue => localStorage.setItem(key, JSON.stringify(newValue)))
  return Object.assign(valueR, {
    [Symbol.dispose]: dispose
  })
}

export const storeWrappedReactive = <T extends object>(keyM: MaybeRefOrGetter<string>, defaultValue: T): Reactive<{ value: T } & Disposable> => {
  const wrapper = reactive({ value: undefined })
  const keyR = toRef(keyM)

  const dispose = applyA([
    watch(wrapper, ({ value }) => {
      const key = keyR.value
      if (! key) return
      localStorage.setItem(key, JSON.stringify(value))
    }),
    watch(keyR, key => {
      if (! key) return
      const value = tryJsonParse<T>(localStorage.getItem(key)) ?? defaultValue
      wrapper.value = value
    }, { immediate: true }),
  ])
  return Object.assign(wrapper, {
    [Symbol.dispose]: dispose,
  })
}