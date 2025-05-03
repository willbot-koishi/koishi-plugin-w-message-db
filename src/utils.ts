export const stripUndefined = <T extends object>(obj: T): T => {
  for (const key in obj)
    if (obj[key] === undefined)
      delete obj[key]
  
  return obj
}

export const divide = <T, U extends T>(arr: T[], pred: (it: T) => it is U): [ U[], Exclude<T, U>[] ] => {
  const trueArr: U[] = []
  const falseArr: Exclude<T, U>[] = []
  for (const it of arr)
    if (pred(it))
      trueArr.push(it)
    else
      falseArr.push(it as Exclude<T, U>)
  return [ trueArr, falseArr ]
}

export const formatSize = (size: number) => {
  const units = [ 'B', 'KB', 'MB', 'GB' ]
  while (true) {
    const unit = units.shift()
    if (size < 1024 || ! units.length) return `${size.toFixed(2)} ${unit}`
    size /= 1024
  }
}