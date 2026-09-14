import test from 'node:test'
import assert from 'node:assert/strict'
import { countWords } from '../src/utils/wordCount.js'

const examples = [
  ['English words, not letters', 'Hello world', 2],
  ['one long word', 'extraordinary', 1],
  ['Chinese characters', '你好，世界！', 4],
  ['mixed punctuation', '你好，world!', 3],
  ['mixed without spaces', '中文English混排test', 6],
  ['apostrophes', "don't John's can’t", 3],
  ['hyphenated compounds', 'well-known mother-in-law non\u2011breaking', 3],
  ['sentence dashes separate words', 'hello—world – again', 3],
  ['whitespace separates words', 'one\ntwo\tthree\u00a0four', 4],
  ['numbers and alphanumeric words', '2026 GPT4 3.14 1,000', 4],
  ['punctuation before numbers', 'hello,2026 word.123', 4],
  ['supplementary Han characters', '𠀀你好', 3],
  ['precomposed and combining accents', 'café cafe\u0301 naïve', 3],
  ['emoji do not inflate text', '你好 👩‍💻 hello 🌍 world', 4],
  ['keycap emoji are not numbers', '1️⃣ 2️⃣ #️⃣ *️⃣', 0],
  ['punctuation only', '，。！？...—---✨👩‍💻', 0],
  ['whitespace only', ' \n\t\u00a0', 0],
  ['empty', '', 0],
  ['missing', undefined, 0],
  ['null', null, 0],
]

for (const [name, input, expected] of examples) {
  test(`writing count: ${name}`, () => {
    assert.equal(countWords(input), expected)
    assert.equal(countWords(input), expected, 'repeat calls must not retain regex state')
  })
}

test('writing count is stable for a long mixed manuscript', () => {
  const paragraph = "你好 world! We can't wait.\n"
  assert.equal(countWords(paragraph.repeat(10000)), 60000)
})
