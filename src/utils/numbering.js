const CHINESE_NUMS = ['零','一','二','三','四','五','六','七','八','九','十',
  '十一','十二','十三','十四','十五','十六','十七','十八','十九','二十',
  '二十一','二十二','二十三','二十四','二十五','二十六','二十七','二十八','二十九','三十',
  '三十一','三十二','三十三','三十四','三十五','三十六','三十七','三十八','三十九','四十',
  '四十一','四十二','四十三','四十四','四十五','四十六','四十七','四十八','四十九','五十']

function toChineseNum(n) {
  if (n < CHINESE_NUMS.length) return CHINESE_NUMS[n]
  return String(n)
}

/**
 * Get the display title with auto-numbering for a chapter
 * @param {object} meta - the full novel meta
 * @param {string} chapterId - the chapter ID
 * @returns {{ volLabel: string, chLabel: string, fullTitle: string }}
 */
export function getChapterDisplay(meta, chapterId) {
  if (!meta) return { volLabel: '', chLabel: '', fullTitle: '' }

  let globalChIndex = 0
  for (let vi = 0; vi < meta.volumes.length; vi++) {
    const vol = meta.volumes[vi]
    for (let ci = 0; ci < vol.chapters.length; ci++) {
      globalChIndex++
      if (vol.chapters[ci].id === chapterId) {
        const chLabel = `第${toChineseNum(globalChIndex)}章`
        const volLabel = `第${toChineseNum(vi + 1)}卷`
        return {
          volLabel,
          chLabel,
          fullTitle: `${chLabel} ${vol.chapters[ci].title}`
        }
      }
    }
  }
  return { volLabel: '', chLabel: '', fullTitle: '' }
}

/**
 * Get volume display label
 */
export function getVolumeLabel(meta, volId) {
  if (!meta) return ''
  const idx = meta.volumes.findIndex(v => v.id === volId)
  if (idx === -1) return ''
  return `第${toChineseNum(idx + 1)}卷`
}

/**
 * Get chapter label by position within the entire novel
 */
export function getChapterLabel(meta, chapterId) {
  if (!meta) return ''
  let globalIndex = 0
  for (const vol of meta.volumes) {
    for (const ch of vol.chapters) {
      globalIndex++
      if (ch.id === chapterId) {
        return `第${toChineseNum(globalIndex)}章`
      }
    }
  }
  return ''
}
