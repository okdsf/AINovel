import test from 'node:test';
import assert from 'node:assert/strict';
import { countWords } from '../src/utils/wordCount.js';

test('English words count once regardless of their number of letters', () => {
  assert.equal(countWords('Hello'), 1);
  assert.equal(countWords('Hello world'), 2);
  assert.equal(countWords('pneumonoultramicroscopicsilicovolcanoconiosis'), 1);
  assert.equal(countWords('This sentence has exactly seven English words.'), 7);
});

test('Han characters count individually alongside unspaced English words', () => {
  assert.equal(countWords('你好世界'), 4);
  assert.equal(countWords('你好Hello世界'), 5);
  assert.equal(countWords('Hello，世界！Good morning。'), 5);
  assert.equal(countWords('中文𠀀𪚥'), 4);
  assert.equal(countWords('𠀀Hello𪚥'), 3);
});

test('Unicode letters and combining accents remain within their words', () => {
  for (const text of ['café', 'cafe\u0301', 'naïve', 'Привет', 'مرحبا']) {
    assert.equal(countWords(text), 1, text);
  }
  assert.equal(countWords('café cafe\u0301'), 2);
  assert.equal(countWords('Привет мир'), 2);
  assert.equal(countWords('résumé中文'), 3);
});

test('Internal apostrophes and hyphens join one word', () => {
  for (const text of ["don't", 'it’s', 'rock’n’roll', 'mother-in-law', 'well\u2010known', 'non\u2011breaking', 'GPT-4o']) {
    assert.equal(countWords(text), 1, text);
  }
  assert.equal(countWords("'Hello' ‘world’"), 2);
  assert.equal(countWords('alpha - beta'), 2);
  assert.equal(countWords('中文-English'), 3);
});

test('En and em dashes separate words without contributing to the count', () => {
  assert.equal(countWords('hello–world'), 2);
  assert.equal(countWords('hello—world'), 2);
  assert.equal(countWords('你好—Hello世界'), 5);
});

test('Numbers, decimals, grouped numbers and alphanumeric terms count as units', () => {
  for (const text of ['2026', '3.14', '1,000', '1,000.25', '1234567890', '１２３', 'R12', 'GPT4o']) {
    assert.equal(countWords(text), 1, text);
  }
  assert.equal(countWords('2026 3.14 1,000'), 3);
  assert.equal(countWords('共1,000字'), 3);
});

test('Whitespace, punctuation and emoji do not become words', () => {
  for (const text of ['', ' \t\r\n\u00a0\u3000', '，。！？—–…', "'’‘--", '😀 👨‍👩‍👧‍👦 ❤️']) {
    assert.equal(countWords(text), 0, JSON.stringify(text));
  }
  assert.equal(countWords('Hello\tworld\r\n你好\u3000again'), 5);
  assert.equal(countWords('Hello😀world'), 2);
  assert.equal(countWords('你好，世界！'), 4);
  assert.equal(countWords('# Title\n\n**Hello world**'), 3);
});

test('Missing and non-string values safely count as zero', () => {
  for (const value of [undefined, null, 42, false, {}, [], Symbol('text')]) {
    assert.equal(countWords(value), 0);
  }
});

test('Repeated counts do not retain tokenizer state between editors', () => {
  for (let i = 0; i < 10; i += 1) {
    assert.equal(countWords('Hello world'), 2);
    assert.equal(countWords(''), 0);
    assert.equal(countWords('你好Hello世界'), 5);
  }
});

test('Long mixed-language drafts count completely', () => {
  assert.equal(countWords('Hello 世界\n'.repeat(20_000)), 60_000);
});
