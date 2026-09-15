// Count Han characters individually and other text by words. Internal
// apostrophes/hyphens stay within a word; punctuation and emoji do not count.
const HAN_CHARACTER = /\p{Script=Han}/gu
const WORD = /\p{N}+(?:[.,]\p{N}+)+|[\p{L}\p{N}][\p{L}\p{M}\p{N}]*(?:['’ʼ\-‐‑][\p{L}\p{N}][\p{L}\p{M}\p{N}]*)*/gu

export function countWords(text) {
  if (typeof text !== 'string' || !text) return 0

  let count = 0
  // Replace with a boundary so English words on either side cannot merge.
  const words = text.replace(HAN_CHARACTER, () => {
    count++
    return ' '
  })
  for (const _ of words.matchAll(WORD)) count++
  return count
}
