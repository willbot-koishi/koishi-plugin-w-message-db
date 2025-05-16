const root: Record<string, any> = {}

export const defineStore = <T>(name: string, setup: () => T) => {
  return (): T => root[name] ??= setup()
}
