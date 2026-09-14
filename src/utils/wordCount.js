/**
 * Writing count shared by editors and book statistics: one per Han character,
 * one per word/number elsewhere. Internal apostrophes and hyphens stay in a
 * word; spaces, punctuation and emoji do not count. Count the supplied text
 * without changing it; this is not a character length or a cursor offset.
 */
export function countWords(text) {
  let count = 0
  const remainder = String(text ?? '').replace(/[0-9#*]\uFE0F?\u20E3/gu, ' ').replace(/\p{Script=Han}/gu, () => {
    count += 1
    return ' '
  })
  const words = /[\p{L}\p{N}][\p{L}\p{M}\p{N}]*(?:['’\-\u2010\u2011][\p{L}\p{N}][\p{L}\p{M}\p{N}]*|(?<=\p{N})[.,]\p{N}+)*/gu
  for (const _ of remainder.matchAll(words)) count += 1
  return count
}
