export const stripUndefined = <T extends object>(obj: T): T => {
  for (const key in obj)
    if (obj[key] === undefined)
      delete obj[key]
  
  return obj
}

interface Divide {
  <T, U extends T>(arr: T[], pred: (it: T) => it is U): [ U[], Exclude<T, U>[] ]
  <T>(arr: T[], pred: (it: T) => boolean): [ T[], T[] ]
}
export const divide: Divide = <T, U extends T>(arr: T[], pred: (it: T) => it is U): [ U[], Exclude<T, U>[] ] => {
  const trueArr: U[] = []
  const falseArr: Exclude<T, U>[] = []
  for (const it of arr)
    if (pred(it))
      trueArr.push(it)
    else
      falseArr.push(it as Exclude<T, U>)
  return [ trueArr, falseArr ]
}

export const sumBy = <T>(arr: T[], getValue: (it: T) => number) =>
  arr.reduce((acc, it) => acc + getValue(it), 0)

export const maxBy = <T>(arr: T[], getValue: (it: T) => number) =>
  Math.max(...arr.map(getValue))
export const minBy = <T>(arr: T[], getValue: (it: T) => number) =>
  Math.min(...arr.map(getValue))

export const formatSize = (size: number) => {
  const units = [ 'B', 'KB', 'MB', 'GB' ]
  while (true) {
    const unit = units.shift()
    if (size < 1024 || ! units.length) return `${size.toFixed(2)} ${unit}`
    size /= 1024
  }
}

export const mapFromList = <T, K>(items: T[], getKey: (item: T) => K) =>
  new Map(items.map((item) => [ getKey(item), item ]))