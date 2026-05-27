import express from 'express';
import cors from 'cors';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
import { promisify } from 'util';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const BOOKS_DIR = path.join(DATA_DIR, 'books');
const BOOKS_INDEX = path.join(DATA_DIR, 'books.json');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// --- Helpers ---
async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function readBooksIndex() {
  try {
    return JSON.parse(await fs.readFile(BOOKS_INDEX, 'utf-8'));
  } catch {
    return [];
  }
}

async function writeBooksIndex(data) {
  await fs.writeFile(BOOKS_INDEX, JSON.stringify(data, null, 2), 'utf-8');
}

function bookDir(bookId) { return path.join(BOOKS_DIR, bookId); }
function bookMetaPath(bookId) { return path.join(BOOKS_DIR, bookId, 'meta.json'); }
function bookChaptersDir(bookId) { return path.join(BOOKS_DIR, bookId, 'chapters'); }

async function readMeta(bookId) {
  return JSON.parse(await fs.readFile(bookMetaPath(bookId), 'utf-8'));
}

async function writeMeta(bookId, data) {
  await fs.writeFile(bookMetaPath(bookId), JSON.stringify(data, null, 2), 'utf-8');
}

// === Books CRUD ===
app.get('/api/books', async (req, res) => {
  try {
    const books = await readBooksIndex();
    res.json(books);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/books', async (req, res) => {
  try {
    const books = await readBooksIndex();
    const { title, description } = req.body;
    const id = `book-${String(books.length + 1).padStart(3, '0')}`;

    await ensureDir(bookChaptersDir(id));
    await writeMeta(id, { title, description: description || '', volumes: [] });

    books.push({ id, title, description: description || '' });
    await writeBooksIndex(books);
    res.json({ id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/books/:bookId', async (req, res) => {
  try {
    let books = await readBooksIndex();
    books = books.filter(b => b.id !== req.params.bookId);
    await writeBooksIndex(books);
    // Don't delete files, just unlink from index (safe)
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/books/:bookId', async (req, res) => {
  try {
    const books = await readBooksIndex();
    const book = books.find(b => b.id === req.params.bookId);
    if (!book) return res.status(404).json({ error: 'Book not found' });
    if (req.body.title) book.title = req.body.title;
    if (req.body.description !== undefined) book.description = req.body.description;
    await writeBooksIndex(books);

    // Also update meta
    const meta = await readMeta(req.params.bookId);
    if (req.body.title) meta.title = req.body.title;
    if (req.body.description !== undefined) meta.description = req.body.description;
    await writeMeta(req.params.bookId, meta);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// === Meta / Structure (book-scoped) ===
app.get('/api/books/:bookId/meta', async (req, res) => {
  try {
    res.json(await readMeta(req.params.bookId));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/books/:bookId/meta', async (req, res) => {
  try {
    await writeMeta(req.params.bookId, req.body);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// === Volumes ===
app.post('/api/books/:bookId/volumes', async (req, res) => {
  try {
    const meta = await readMeta(req.params.bookId);
    const { title } = req.body;
    const id = `vol-${String(meta.volumes.length + 1).padStart(3, '0')}`;
    meta.volumes.push({ id, title, chapters: [] });
    await writeMeta(req.params.bookId, meta);
    res.json({ id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/books/:bookId/volumes/:volId/title', async (req, res) => {
  try {
    const meta = await readMeta(req.params.bookId);
    const vol = meta.volumes.find(v => v.id === req.params.volId);
    if (!vol) return res.status(404).json({ error: 'Volume not found' });
    vol.title = req.body.title;
    await writeMeta(req.params.bookId, meta);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/books/:bookId/volumes/:volId', async (req, res) => {
  try {
    const meta = await readMeta(req.params.bookId);
    const CHDIR = bookChaptersDir(req.params.bookId);
    const volIndex = meta.volumes.findIndex(v => v.id === req.params.volId);
    if (volIndex === -1) return res.status(404).json({ error: 'Not found' });
    const vol = meta.volumes[volIndex];
    for (const ch of vol.chapters) {
      try { await fs.unlink(path.join(CHDIR, `${ch.id}.md`)); } catch {}
      try { await fs.unlink(path.join(CHDIR, `${ch.id}.conv.json`)); } catch {}
    }
    meta.volumes.splice(volIndex, 1);
    await writeMeta(req.params.bookId, meta);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// === Chapters ===
app.post('/api/books/:bookId/volumes/:volId/chapters', async (req, res) => {
  try {
    const meta = await readMeta(req.params.bookId);
    const CHDIR = bookChaptersDir(req.params.bookId);
    const vol = meta.volumes.find(v => v.id === req.params.volId);
    if (!vol) return res.status(404).json({ error: 'Volume not found' });
    const { title } = req.body;
    let maxId = 0;
    for (const v of meta.volumes)
      for (const c of v.chapters) {
        const num = parseInt(c.id.replace('ch-', ''));
        if (num > maxId) maxId = num;
      }
    const id = `ch-${String(maxId + 1).padStart(3, '0')}`;
    vol.chapters.push({ id, title });
    await writeMeta(req.params.bookId, meta);
    await fs.writeFile(path.join(CHDIR, `${id}.md`), '', 'utf-8');
    await fs.writeFile(path.join(CHDIR, `${id}.conv.json`), '[]', 'utf-8');
    res.json({ id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/books/:bookId/volumes/:volId/chapters/:chId', async (req, res) => {
  try {
    const meta = await readMeta(req.params.bookId);
    const CHDIR = bookChaptersDir(req.params.bookId);
    const vol = meta.volumes.find(v => v.id === req.params.volId);
    if (!vol) return res.status(404).json({ error: 'Volume not found' });
    const chIndex = vol.chapters.findIndex(c => c.id === req.params.chId);
    if (chIndex === -1) return res.status(404).json({ error: 'Chapter not found' });
    try { await fs.unlink(path.join(CHDIR, `${req.params.chId}.md`)); } catch {}
    try { await fs.unlink(path.join(CHDIR, `${req.params.chId}.conv.json`)); } catch {}
    vol.chapters.splice(chIndex, 1);
    await writeMeta(req.params.bookId, meta);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Chapter Content ---
app.get('/api/books/:bookId/chapters/:id/content', async (req, res) => {
  try {
    const filePath = path.join(bookChaptersDir(req.params.bookId), `${req.params.id}.md`);
    const content = await fs.readFile(filePath, 'utf-8');
    res.json({ content });
  } catch (e) {
    if (e.code === 'ENOENT') return res.json({ content: '' });
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/books/:bookId/chapters/:id/content', async (req, res) => {
  try {
    const filePath = path.join(bookChaptersDir(req.params.bookId), `${req.params.id}.md`);
    await fs.writeFile(filePath, req.body.content, 'utf-8');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Conversation ---
app.get('/api/books/:bookId/chapters/:id/conversation', async (req, res) => {
  try {
    const filePath = path.join(bookChaptersDir(req.params.bookId), `${req.params.id}.conv.json`);
    const raw = await fs.readFile(filePath, 'utf-8');
    res.json(JSON.parse(raw));
  } catch (e) {
    if (e.code === 'ENOENT') return res.json([]);
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/books/:bookId/chapters/:id/conversation', async (req, res) => {
  try {
    const CHDIR = bookChaptersDir(req.params.bookId);
    const convPath = path.join(CHDIR, `${req.params.id}.conv.json`);
    const contentPath = path.join(CHDIR, `${req.params.id}.md`);
    const turns = req.body;
    await fs.writeFile(convPath, JSON.stringify(turns, null, 2), 'utf-8');
    const novelParts = turns.filter(t => t.role === 'assistant').map(t => t.content);
    await fs.writeFile(contentPath, novelParts.join('\n\n'), 'utf-8');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/books/:bookId/chapters/:id/conversation/turn', async (req, res) => {
  try {
    const CHDIR = bookChaptersDir(req.params.bookId);
    const convPath = path.join(CHDIR, `${req.params.id}.conv.json`);
    const contentPath = path.join(CHDIR, `${req.params.id}.md`);
    let turns = [];
    try { turns = JSON.parse(await fs.readFile(convPath, 'utf-8')); } catch {}
    const { userMessage, assistantMessage } = req.body;
    if (userMessage) turns.push({ role: 'user', content: userMessage });
    if (assistantMessage) turns.push({ role: 'assistant', content: assistantMessage });
    await fs.writeFile(convPath, JSON.stringify(turns, null, 2), 'utf-8');
    const novelParts = turns.filter(t => t.role === 'assistant').map(t => t.content);
    await fs.writeFile(contentPath, novelParts.join('\n\n'), 'utf-8');
    res.json({ ok: true, totalTurns: turns.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Rename chapter ---
app.put('/api/books/:bookId/chapters/:chId/title', async (req, res) => {
  try {
    const meta = await readMeta(req.params.bookId);
    const { title } = req.body;
    for (const vol of meta.volumes) {
      const ch = vol.chapters.find(c => c.id === req.params.chId);
      if (ch) {
        ch.title = title;
        await writeMeta(req.params.bookId, meta);
        return res.json({ ok: true });
      }
    }
    res.status(404).json({ error: 'Chapter not found' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Split chapter ---
app.post('/api/books/:bookId/chapters/:chId/split', async (req, res) => {
  try {
    const meta = await readMeta(req.params.bookId);
    const CHDIR = bookChaptersDir(req.params.bookId);
    const { splitIndex, newTitle } = req.body;
    let targetVol = null, chIndex = -1;
    for (const vol of meta.volumes) {
      const idx = vol.chapters.findIndex(c => c.id === req.params.chId);
      if (idx !== -1) { targetVol = vol; chIndex = idx; break; }
    }
    if (!targetVol) return res.status(404).json({ error: 'Chapter not found' });
    const contentPath = path.join(CHDIR, `${req.params.chId}.md`);
    const content = await fs.readFile(contentPath, 'utf-8');
    const before = content.substring(0, splitIndex).trimEnd();
    const after = content.substring(splitIndex).trimStart();
    let maxId = 0;
    for (const v of meta.volumes)
      for (const c of v.chapters) {
        const num = parseInt(c.id.replace('ch-', ''));
        if (num > maxId) maxId = num;
      }
    const newChId = `ch-${String(maxId + 1).padStart(3, '0')}`;
    await fs.writeFile(contentPath, before, 'utf-8');
    await fs.writeFile(path.join(CHDIR, `${newChId}.md`), after, 'utf-8');
    await fs.writeFile(path.join(CHDIR, `${newChId}.conv.json`), '[]', 'utf-8');
    targetVol.chapters.splice(chIndex + 1, 0, { id: newChId, title: newTitle || '新章节' });
    await writeMeta(req.params.bookId, meta);
    res.json({ ok: true, newChapterId: newChId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Merge chapter with next ---
app.post('/api/books/:bookId/chapters/:chId/merge', async (req, res) => {
  try {
    const meta = await readMeta(req.params.bookId);
    const CHDIR = bookChaptersDir(req.params.bookId);
    let targetVol = null, chIndex = -1;
    for (const vol of meta.volumes) {
      const idx = vol.chapters.findIndex(c => c.id === req.params.chId);
      if (idx !== -1) { targetVol = vol; chIndex = idx; break; }
    }
    if (!targetVol) return res.status(404).json({ error: 'Chapter not found' });
    if (chIndex >= targetVol.chapters.length - 1) return res.status(400).json({ error: 'No next chapter to merge with' });
    const currentCh = targetVol.chapters[chIndex];
    const nextCh = targetVol.chapters[chIndex + 1];
    const currentContent = await fs.readFile(path.join(CHDIR, `${currentCh.id}.md`), 'utf-8');
    const nextContent = await fs.readFile(path.join(CHDIR, `${nextCh.id}.md`), 'utf-8');
    let currentConv = [], nextConv = [];
    try { currentConv = JSON.parse(await fs.readFile(path.join(CHDIR, `${currentCh.id}.conv.json`), 'utf-8')); } catch {}
    try { nextConv = JSON.parse(await fs.readFile(path.join(CHDIR, `${nextCh.id}.conv.json`), 'utf-8')); } catch {}
    await fs.writeFile(path.join(CHDIR, `${currentCh.id}.md`), currentContent.trimEnd() + '\n\n' + nextContent.trimStart(), 'utf-8');
    await fs.writeFile(path.join(CHDIR, `${currentCh.id}.conv.json`), JSON.stringify([...currentConv, ...nextConv], null, 2), 'utf-8');
    try { await fs.unlink(path.join(CHDIR, `${nextCh.id}.md`)); } catch {}
    try { await fs.unlink(path.join(CHDIR, `${nextCh.id}.conv.json`)); } catch {}
    targetVol.chapters.splice(chIndex + 1, 1);
    await writeMeta(req.params.bookId, meta);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Move chapter ---
app.post('/api/books/:bookId/chapters/:chId/move', async (req, res) => {
  try {
    const meta = await readMeta(req.params.bookId);
    const { targetVolId, targetIndex } = req.body;
    let chapter = null;
    for (const vol of meta.volumes) {
      const idx = vol.chapters.findIndex(c => c.id === req.params.chId);
      if (idx !== -1) { chapter = vol.chapters.splice(idx, 1)[0]; break; }
    }
    if (!chapter) return res.status(404).json({ error: 'Chapter not found' });
    const targetVol = meta.volumes.find(v => v.id === targetVolId);
    if (!targetVol) return res.status(404).json({ error: 'Target volume not found' });
    const insertAt = Math.min(Math.max(0, targetIndex), targetVol.chapters.length);
    targetVol.chapters.splice(insertAt, 0, chapter);
    await writeMeta(req.params.bookId, meta);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Word Count Stats ---
app.get('/api/books/:bookId/stats', async (req, res) => {
  try {
    const meta = await readMeta(req.params.bookId);
    const CHDIR = bookChaptersDir(req.params.bookId);
    const stats = { total: 0, volumes: [] };
    for (const vol of meta.volumes) {
      const volStat = { id: vol.id, title: vol.title, wordCount: 0, chapters: [] };
      for (const ch of vol.chapters) {
        let content = '';
        try { content = await fs.readFile(path.join(CHDIR, `${ch.id}.md`), 'utf-8'); } catch {}
        const chineseChars = (content.match(/[\u4e00-\u9fff]/g) || []).length;
        const englishWords = (content.match(/[a-zA-Z]+/g) || []).length;
        const count = chineseChars + englishWords;
        volStat.chapters.push({ id: ch.id, title: ch.title, wordCount: count });
        volStat.wordCount += count;
      }
      stats.volumes.push(volStat);
      stats.total += volStat.wordCount;
    }
    res.json(stats);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Search & Replace ---
app.post('/api/books/:bookId/search', async (req, res) => {
  try {
    const meta = await readMeta(req.params.bookId);
    const CHDIR = bookChaptersDir(req.params.bookId);
    const { query } = req.body;
    if (!query) return res.json({ results: [] });
    const results = [];
    let globalCh = 0;
    for (const vol of meta.volumes) {
      for (const ch of vol.chapters) {
        globalCh++;
        let content = '';
        try { content = await fs.readFile(path.join(CHDIR, `${ch.id}.md`), 'utf-8'); } catch {}
        const indices = [];
        let pos = 0;
        while ((pos = content.indexOf(query, pos)) !== -1) {
          const start = Math.max(0, pos - 20);
          const end = Math.min(content.length, pos + query.length + 20);
          indices.push({ pos, context: content.substring(start, end) });
          pos += 1;
        }
        if (indices.length > 0) {
          results.push({ chId: ch.id, chTitle: ch.title, chNum: globalCh, count: indices.length, matches: indices.slice(0, 50) });
        }
      }
    }
    res.json({ results, totalCount: results.reduce((s, r) => s + r.count, 0) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/books/:bookId/replace', async (req, res) => {
  try {
    const meta = await readMeta(req.params.bookId);
    const CHDIR = bookChaptersDir(req.params.bookId);
    const { search, replace } = req.body;
    let { chapterIds } = req.body;
    if (!search) return res.status(400).json({ error: 'search is required' });
    const replaceStr = replace || '';
    if (!chapterIds) {
      chapterIds = [];
      for (const vol of meta.volumes) for (const ch of vol.chapters) chapterIds.push(ch.id);
    }
    let totalReplaced = 0, filesChanged = 0;
    for (const chId of chapterIds) {
      const filePath = path.join(CHDIR, `${chId}.md`);
      let content = '';
      try { content = await fs.readFile(filePath, 'utf-8'); } catch { continue; }
      const count = content.split(search).length - 1;
      if (count > 0) {
        await fs.writeFile(filePath, content.split(search).join(replaceStr), 'utf-8');
        totalReplaced += count;
        filesChanged++;
      }
    }
    res.json({ ok: true, totalReplaced, filesChanged });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Export ---
const CN = ['零','一','二','三','四','五','六','七','八','九','十',
  '十一','十二','十三','十四','十五','十六','十七','十八','十九','二十',
  '二十一','二十二','二十三','二十四','二十五','二十六','二十七','二十八','二十九','三十',
  '三十一','三十二','三十三','三十四','三十五','三十六','三十七','三十八','三十九','四十',
  '四十一','四十二','四十三','四十四','四十五','四十六','四十七','四十八','四十九','五十'];
function cn(n) { return n < CN.length ? CN[n] : String(n); }

app.post('/api/books/:bookId/export/novel', async (req, res) => {
  try {
    const meta = await readMeta(req.params.bookId);
    const CHDIR = bookChaptersDir(req.params.bookId);
    const EXPORT_DIR = path.join(bookDir(req.params.bookId), 'export');
    await ensureDir(EXPORT_DIR);
    const lines = [`# ${meta.title}\n\n> ${meta.description || ''}\n\n---\n`];
    let globalCh = 0;
    for (let vi = 0; vi < meta.volumes.length; vi++) {
      const vol = meta.volumes[vi];
      lines.push(`\n## 第${cn(vi + 1)}卷 ${vol.title}\n`);
      for (const ch of vol.chapters) {
        globalCh++;
        lines.push(`\n### 第${cn(globalCh)}章 ${ch.title}\n`);
        let content = '';
        try { content = await fs.readFile(path.join(CHDIR, `${ch.id}.md`), 'utf-8'); } catch {}
        lines.push(content.trim());
        lines.push('\n');
      }
    }
    const filePath = path.join(EXPORT_DIR, `${meta.title}-小说版.md`);
    await fs.writeFile(filePath, lines.join('\n'), 'utf-8');
    res.json({ ok: true, path: filePath });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/books/:bookId/export/conversation', async (req, res) => {
  try {
    const meta = await readMeta(req.params.bookId);
    const CHDIR = bookChaptersDir(req.params.bookId);
    const EXPORT_DIR = path.join(bookDir(req.params.bookId), 'export');
    await ensureDir(EXPORT_DIR);
    const lines = [`# ${meta.title} — 对话记录\n\n---\n`];
    let globalCh = 0;
    for (let vi = 0; vi < meta.volumes.length; vi++) {
      const vol = meta.volumes[vi];
      lines.push(`\n## 第${cn(vi + 1)}卷 ${vol.title}\n`);
      for (const ch of vol.chapters) {
        globalCh++;
        lines.push(`\n### 第${cn(globalCh)}章 ${ch.title}\n`);
        let turns = [];
        try { turns = JSON.parse(await fs.readFile(path.join(CHDIR, `${ch.id}.conv.json`), 'utf-8')); } catch {}
        if (turns.length === 0) {
          lines.push('*暂无对话记录*\n');
        } else {
          for (const t of turns) {
            lines.push(`${t.role === 'user' ? '**我的 Prompt：**' : '**AI 回复：**'}\n`);
            lines.push(`${t.content.trim()}\n`);
            lines.push('---\n');
          }
        }
      }
    }
    const filePath = path.join(EXPORT_DIR, `${meta.title}-对话版.md`);
    await fs.writeFile(filePath, lines.join('\n'), 'utf-8');
    res.json({ ok: true, path: filePath });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// === Git ===
const execFileAsync = promisify(execFile);
const PROJECT_ROOT = path.join(__dirname, '..');
const GIT_CONFIG_PATH = path.join(DATA_DIR, 'git-config.json');

async function git(...args) {
  const { stdout } = await execFileAsync('git', args, { cwd: PROJECT_ROOT, encoding: 'utf-8' });
  return stdout.trim();
}

// Safely read a single git config value or current state — return '' on failure.
async function gitSafe(...args) {
  try { return await git(...args); } catch { return ''; }
}

const DEFAULT_CONFIG = {
  remoteUrl: '',                          // empty = use whatever git already has
  branch: '',                             // empty = use current HEAD
  userName: 'NovelWeb',                   // historical default
  userEmail: 'novelweb@local',            // historical default
  commitTemplate: 'update: {date}',
  forcePush: true,                        // historical behaviour
  syncPublic: false                       // also publish to AINovel public repo on push
};

async function readSavedConfig() {
  try {
    const raw = await fs.readFile(GIT_CONFIG_PATH, 'utf-8');
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

// Compute the effective config — merges saved overrides with the repo's actual
// state. Anything blank in the saved config falls back to what git reports.
async function effectiveConfig() {
  const saved = await readSavedConfig();
  const liveRemote = await gitSafe('config', '--get', 'remote.origin.url');
  const liveBranch = await gitSafe('symbolic-ref', '--short', 'HEAD');
  const liveName = await gitSafe('config', '--get', 'user.name');
  const liveEmail = await gitSafe('config', '--get', 'user.email');
  return {
    remoteUrl: saved.remoteUrl || liveRemote,
    branch: saved.branch || liveBranch || 'main',
    userName: saved.userName || liveName || DEFAULT_CONFIG.userName,
    userEmail: saved.userEmail || liveEmail || DEFAULT_CONFIG.userEmail,
    commitTemplate: saved.commitTemplate || DEFAULT_CONFIG.commitTemplate,
    forcePush: saved.forcePush !== undefined ? saved.forcePush : DEFAULT_CONFIG.forcePush,
    syncPublic: saved.syncPublic !== undefined ? saved.syncPublic : DEFAULT_CONFIG.syncPublic,
    _live: { remoteUrl: liveRemote, branch: liveBranch, userName: liveName, userEmail: liveEmail }
  };
}

function formatDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

app.get('/api/git/config', async (req, res) => {
  try {
    res.json(await effectiveConfig());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/git/config', async (req, res) => {
  try {
    const current = await readSavedConfig();
    const incoming = req.body || {};
    const next = { ...current };
    for (const k of Object.keys(DEFAULT_CONFIG)) {
      if (incoming[k] !== undefined) next[k] = incoming[k];
    }
    // Persist overrides
    await ensureDir(DATA_DIR);
    await fs.writeFile(GIT_CONFIG_PATH, JSON.stringify(next, null, 2), 'utf-8');
    // Push the remote URL into git itself if it was changed (so external git tooling stays consistent).
    if (incoming.remoteUrl !== undefined && incoming.remoteUrl.trim()) {
      const existingRemote = await gitSafe('config', '--get', 'remote.origin.url');
      if (existingRemote !== incoming.remoteUrl.trim()) {
        if (existingRemote) {
          await git('remote', 'set-url', 'origin', incoming.remoteUrl.trim());
        } else {
          await git('remote', 'add', 'origin', incoming.remoteUrl.trim());
        }
      }
    }
    res.json({ ok: true, config: await effectiveConfig() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Detect private (NovelWeb) vs public (AINovel) repo mode
app.get('/api/git/repo-mode', async (req, res) => {
  const check = async (p) => { try { await fs.access(p); return true } catch { return false } }
  const isPrivate = await check(path.join(DATA_DIR, '..', '.private'))
  const publicDir = path.resolve(DATA_DIR, '..', '..', 'AINovel')
  const publicExists = await check(path.join(publicDir, '.git'))
  res.json({ isPrivate, publicExists, publicDir })
});

// Run publish-public.mjs to sync code to AINovel
app.post('/api/git/publish-public', async (req, res) => {
  try {
    const { message } = req.body || {};
    const script = path.join(DATA_DIR, '..', 'scripts', 'publish-public.mjs');
    const args = [];
    if (message) args.push('-m', message);
    else args.push('-m', `sync: ${formatDate(new Date())}`);
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    const { stdout, stderr } = await execFileAsync('node', [script, ...args], {
      cwd: path.join(DATA_DIR, '..'),
      timeout: 60000,
    });
    res.json({ ok: true, message: 'AINovel 已同步', output: (stdout + '\n' + stderr).trim() });
  } catch (e) {
    const output = (e.stdout || '') + '\n' + (e.stderr || '');
    res.status(500).json({ error: e.message, output: output.trim() });
  }
});

app.post('/api/git/push', async (req, res) => {
  try {
    const cfg = await effectiveConfig();
    const { message } = req.body || {};
    const dateStr = formatDate(new Date());
    const tmpl = cfg.commitTemplate.replace('{date}', dateStr);
    const commitMsg = (message && message.trim()) ? message.trim() : tmpl;
    await git('add', '-A');
    const status = await gitSafe('status', '--porcelain');
    let committed = false;
    if (status) {
      await git(
        '-c', `user.name=${cfg.userName}`,
        '-c', `user.email=${cfg.userEmail}`,
        'commit', '-m', commitMsg
      );
      committed = true;
    }
    const pushArgs = ['push'];
    if (cfg.forcePush) pushArgs.push('--force');
    pushArgs.push('origin', cfg.branch);
    let resultMsg = '';
    if (committed) {
      await git(...pushArgs);
      resultMsg = `已推送 ${cfg.branch}: ${commitMsg}`;
    } else {
      const ahead = await gitSafe('rev-list', '--count', `origin/${cfg.branch}..HEAD`);
      if (parseInt(ahead || '0', 10) > 0) {
        await git(...pushArgs);
        resultMsg = `已${cfg.forcePush ? '强制' : ''}推送本地提交到 ${cfg.branch}`;
      } else {
        res.json({ ok: true, message: '没有需要提交或推送的更改' });
        return;
      }
    }
    // If syncPublic is enabled, also publish to AINovel
    let publicMsg = '';
    if (cfg.syncPublic) {
      try {
        const script = path.join(DATA_DIR, '..', 'scripts', 'publish-public.mjs');
        const { execFile } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const execFileAsync = promisify(execFile);
        await execFileAsync('node', [script, '-m', commitMsg], {
          cwd: path.join(DATA_DIR, '..'), timeout: 60000,
        });
        publicMsg = ' · AINovel 已同步';
      } catch (pe) {
        publicMsg = ` · AINovel 同步失败: ${pe.message}`;
      }
    }
    res.json({ ok: true, message: resultMsg + publicMsg });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

app.get('/api/git/status', async (req, res) => {
  try {
    const cfg = await effectiveConfig();
    const status = await git('status', '--porcelain');
    const lines = status ? status.split('\n').filter(l => l.trim()) : [];
    let ahead = 0, behind = 0;
    const counts = await gitSafe('rev-list', '--left-right', '--count', `origin/${cfg.branch}...HEAD`);
    if (counts) {
      const [b, a] = counts.split(/\s+/).map(n => parseInt(n, 10) || 0);
      behind = b; ahead = a;
    }
    res.json({
      branch: cfg.branch,
      changedFiles: lines.length,
      details: lines.slice(0, 50),
      ahead, behind
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/git/versions', async (req, res) => {
  try {
    const cfg = await effectiveConfig();
    await gitSafe('fetch', 'origin');
    const log = await gitSafe('log', `origin/${cfg.branch}`, '--oneline', '-20');
    const versions = log.split('\n').filter(l => l.trim()).map(line => {
      const [hash, ...rest] = line.split(' ');
      return { hash, message: rest.join(' ') };
    });
    res.json(versions);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/git/pull', async (req, res) => {
  try {
    const cfg = await effectiveConfig();
    const { scope = 'all', version } = req.body || {};
    await git('fetch', 'origin');
    const target = version || `origin/${cfg.branch}`;
    if (scope === 'all') {
      await git('reset', '--hard', target);
      await git('clean', '-fd');
      res.json({ ok: true, message: '已同步全部（数据+代码）' });
    } else if (scope === 'data') {
      await git('checkout', target, '--', 'data/');
      res.json({ ok: true, message: '已同步数据（data/）' });
    } else if (scope === 'code') {
      const codePaths = ['src/', 'server/', 'index.html', 'vite.config.js', 'package.json', 'package-lock.json', 'start.bat', 'public/'];
      for (const p of codePaths) {
        try { await git('checkout', target, '--', p); } catch {}
      }
      res.json({ ok: true, message: '已同步代码（src/+server/）' });
    } else {
      res.status(400).json({ error: '无效的 scope' });
    }
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

// === Archive (multi-POV world-building layer) ===
// Archive is now per-book: data/books/{bookId}/archive/{events,pieces,entities}/
function bookArchiveDir(bookId)  { return path.join(BOOKS_DIR, bookId, 'archive'); }
function bookEventsDir(bookId)   { return path.join(bookArchiveDir(bookId), 'events'); }
function bookPiecesDir(bookId)   { return path.join(bookArchiveDir(bookId), 'pieces'); }
function bookEntitiesDir(bookId) { return path.join(bookArchiveDir(bookId), 'entities'); }
function bookTaxonomyPath(bookId){ return path.join(bookArchiveDir(bookId), 'taxonomy.json'); }

async function listJsonFiles(dir) {
  try {
    const files = await fs.readdir(dir);
    const out = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const raw = await fs.readFile(path.join(dir, f), 'utf-8');
      out.push(JSON.parse(raw));
    }
    return out;
  } catch { return []; }
}

async function listPiecesForBook(bookId) {
  const piecesDir = bookPiecesDir(bookId);
  try {
    const dirs = await fs.readdir(piecesDir, { withFileTypes: true });
    const out = [];
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      try {
        const raw = await fs.readFile(path.join(piecesDir, d.name, 'meta.json'), 'utf-8');
        out.push(JSON.parse(raw));
      } catch {}
    }
    return out;
  } catch { return []; }
}

// Scan the chapters of a single book that declare events.
async function listTaggedChaptersForBook(bookId) {
  const out = [];
  let meta;
  try { meta = await readMeta(bookId); } catch { return out; }
  for (const vol of meta.volumes || []) {
    for (const ch of vol.chapters || []) {
      const events = ch.events || [];
      if (events.length === 0) continue;
      out.push({
        bookId, bookTitle: meta.title,
        volId: vol.id, volTitle: vol.title,
        chId: ch.id, chTitle: ch.title,
        events,
        world_date: ch.world_date || null
      });
    }
  }
  return out;
}

// Parse world dates into a sortable numeric rank.
// Supports: "公元1776年", "公元前500年", "约公元前500年", "公元1799/12", "公元1799/12/14"
// Also supports legacy "泰元412" format.
// Unknown / unparseable → Infinity (sorts last).
function dateRank(s) {
  if (!s) return Number.POSITIVE_INFINITY;
  const str = String(s);
  // 公元前/公元 format
  const ce = str.match(/约?公元(前)?(\d+)(?:年?[./](\d+))?(?:[./](\d+))?/);
  if (ce) {
    const neg = ce[1] ? -1 : 1;
    const year = parseInt(ce[2], 10) * neg;
    const month = ce[3] ? parseInt(ce[3], 10) : 0;
    const day = ce[4] ? parseInt(ce[4], 10) : 0;
    return (year + 10000) * 10000 + month * 100 + day; // offset to keep BC positive for sorting
  }
  // Legacy 泰元 format
  const te = str.match(/泰元(\d+)(?:[.\/](Q\d|\d+))?(?:\/(\d+))?/);
  if (te) {
    const year = parseInt(te[1], 10);
    let month = 0;
    if (te[2]) {
      if (te[2].startsWith('Q')) {
        month = (parseInt(te[2].slice(1), 10) - 1) * 3 + 1;
      } else {
        month = parseInt(te[2], 10);
      }
    }
    return (year + 10000) * 10000 + month * 100 + (te[3] ? parseInt(te[3], 10) : 0);
  }
  return Number.POSITIVE_INFINITY;
}

app.get('/api/books/:bookId/archive/taxonomy', async (req, res) => {
  try {
    res.json(JSON.parse(await fs.readFile(bookTaxonomyPath(req.params.bookId), 'utf-8')));
  } catch (e) {
    if (e.code === 'ENOENT') return res.json({});
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/books/:bookId/archive/overview', async (req, res) => {
  try {
    const { bookId } = req.params;
    const [events, pieces, chapters, taxonomy] = await Promise.all([
      listJsonFiles(bookEventsDir(bookId)),
      listPiecesForBook(bookId),
      listTaggedChaptersForBook(bookId),
      fs.readFile(bookTaxonomyPath(bookId), 'utf-8').then(JSON.parse).catch(() => ({}))
    ]);
    events.sort((a, b) => dateRank(a.world_date) - dateRank(b.world_date));
    for (const evt of events) {
      evt.pieceCount = pieces.filter(p =>
        p.primary_event === evt.id || (p.related_events || []).includes(evt.id)
      ).length;
      evt.chapterCount = chapters.filter(c => (c.events || []).includes(evt.id)).length;
    }
    res.json({ events, pieces, chapters, taxonomy });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/books/:bookId/archive/event/:id', async (req, res) => {
  try {
    const { bookId } = req.params;
    const eventPath = path.join(bookEventsDir(bookId), `${req.params.id}.json`);
    const event = JSON.parse(await fs.readFile(eventPath, 'utf-8'));
    const [pieces, chapters] = await Promise.all([
      listPiecesForBook(bookId),
      listTaggedChaptersForBook(bookId)
    ]);
    const relatedPieces = pieces.filter(p =>
      p.primary_event === req.params.id || (p.related_events || []).includes(req.params.id)
    );
    const relatedChapters = chapters.filter(c =>
      (c.events || []).includes(req.params.id)
    );
    res.json({ event, pieces: relatedPieces, chapters: relatedChapters });
  } catch (e) {
    if (e.code === 'ENOENT') return res.status(404).json({ error: 'Event not found' });
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/books/:bookId/archive/piece/:id', async (req, res) => {
  try {
    const metaPath = path.join(bookPiecesDir(req.params.bookId), req.params.id, 'meta.json');
    res.json(JSON.parse(await fs.readFile(metaPath, 'utf-8')));
  } catch (e) {
    if (e.code === 'ENOENT') return res.status(404).json({ error: 'Piece not found' });
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/books/:bookId/archive/piece/:id', async (req, res) => {
  try {
    const pieceDir = path.join(bookPiecesDir(req.params.bookId), req.params.id);
    await fs.rm(pieceDir, { recursive: true, force: true });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/books/:bookId/archive/event/:id', async (req, res) => {
  try {
    const { bookId } = req.params;
    const eventId = req.params.id;
    const eventPath = path.join(bookEventsDir(bookId), `${eventId}.json`);
    const pieces = await listPiecesForBook(bookId);
    const linked = pieces.filter(p =>
      p.primary_event === eventId || (p.related_events || []).includes(eventId)
    );
    for (const p of linked) {
      await fs.rm(path.join(bookPiecesDir(bookId), p.id), { recursive: true, force: true }).catch(() => {});
    }
    await fs.unlink(eventPath).catch(() => {});
    res.json({ ok: true, deletedPieces: linked.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Serve a piece's rendered HTML (for iframe embed). Book-scoped now.
app.get('/pieces-render/:bookId/:id/:file', async (req, res) => {
  try {
    const baseDir = bookPiecesDir(req.params.bookId);
    const filePath = path.join(baseDir, req.params.id, req.params.file);
    if (!filePath.startsWith(baseDir)) return res.status(400).end();
    res.sendFile(filePath);
  } catch (e) { res.status(500).send(e.message); }
});

// === Drafts (草稿本) ===
const DRAFTS_DIR = path.join(DATA_DIR, 'drafts');
const DRAFTS_INDEX = path.join(DRAFTS_DIR, 'index.json');

async function readDraftsIndex() {
  try {
    return JSON.parse(await fs.readFile(DRAFTS_INDEX, 'utf-8'));
  } catch {
    return [];
  }
}

async function writeDraftsIndex(data) {
  await ensureDir(DRAFTS_DIR);
  await fs.writeFile(DRAFTS_INDEX, JSON.stringify(data, null, 2), 'utf-8');
}

function draftPath(id) { return path.join(DRAFTS_DIR, `${id}.md`); }

app.get('/api/drafts', async (req, res) => {
  try {
    res.json(await readDraftsIndex());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/drafts/:id', async (req, res) => {
  try {
    const id = req.params.id;
    if (!/^draft-[a-z0-9]+$/.test(id)) return res.status(400).json({ error: 'bad id' });
    const content = await fs.readFile(draftPath(id), 'utf-8');
    const index = await readDraftsIndex();
    const meta = index.find(d => d.id === id);
    res.json({ id, content, ...(meta || {}) });
  } catch (e) {
    if (e.code === 'ENOENT') return res.status(404).json({ error: 'Draft not found' });
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/drafts', async (req, res) => {
  try {
    const { title, content, sourceId } = req.body;
    const index = await readDraftsIndex();
    const id = `draft-${Date.now().toString(36)}`;
    const now = new Date().toISOString();

    // 自动命名：title 为空时分配下一个 "草稿N"（N 从 0 递增，取现有最大值 +1）
    let finalTitle = (title || '').trim();
    if (!finalTitle) {
      const nums = index
        .map(d => {
          const m = /^草稿(\d+)$/.exec(d.title || '');
          return m ? parseInt(m[1], 10) : -1;
        })
        .filter(n => n >= 0);
      const next = nums.length ? Math.max(...nums) + 1 : 0;
      finalTitle = `草稿${next}`;
    }

    const entry = {
      id,
      title: finalTitle,
      sourceId: sourceId || null,
      createdAt: now,
      updatedAt: now
    };
    await ensureDir(DRAFTS_DIR);
    await fs.writeFile(draftPath(id), content || '', 'utf-8');
    index.unshift(entry);
    await writeDraftsIndex(index);
    res.json(entry);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/drafts/:id', async (req, res) => {
  try {
    const id = req.params.id;
    if (!/^draft-[a-z0-9]+$/.test(id)) return res.status(400).json({ error: 'bad id' });
    const index = await readDraftsIndex();
    const meta = index.find(d => d.id === id);
    if (!meta) return res.status(404).json({ error: 'Draft not found' });

    if (typeof req.body.title === 'string') meta.title = req.body.title.trim() || meta.title;
    if (typeof req.body.content === 'string') {
      await fs.writeFile(draftPath(id), req.body.content, 'utf-8');
    }
    meta.updatedAt = new Date().toISOString();
    await writeDraftsIndex(index);
    res.json(meta);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/drafts/:id', async (req, res) => {
  try {
    const id = req.params.id;
    if (!/^draft-[a-z0-9]+$/.test(id)) return res.status(400).json({ error: 'bad id' });
    let index = await readDraftsIndex();
    index = index.filter(d => d.id !== id);
    await writeDraftsIndex(index);
    try { await fs.unlink(draftPath(id)); } catch {}
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// === Prompt Groups (Prompt 迭代) ===
const PG_DIR = path.join(DATA_DIR, 'drafts', 'prompt-groups');
const PG_INDEX = path.join(PG_DIR, 'index.json');

async function readPGIndex() {
  try { return JSON.parse(await fs.readFile(PG_INDEX, 'utf-8')); }
  catch { return []; }
}

async function writePGIndex(data) {
  await ensureDir(PG_DIR);
  await fs.writeFile(PG_INDEX, JSON.stringify(data, null, 2), 'utf-8');
}

function pgDir(id) { return path.join(PG_DIR, id); }

app.get('/api/prompt-groups', async (req, res) => {
  try { res.json(await readPGIndex()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/prompt-groups', async (req, res) => {
  try {
    const { title } = req.body;
    const index = await readPGIndex();
    const id = `pg-${Date.now().toString(36)}`;
    const now = new Date().toISOString();

    let finalTitle = (title || '').trim();
    if (!finalTitle) {
      const nums = index
        .map(d => { const m = /^迭代组(\d+)$/.exec(d.title || ''); return m ? parseInt(m[1], 10) : -1; })
        .filter(n => n >= 0);
      const next = nums.length ? Math.max(...nums) + 1 : 0;
      finalTitle = `迭代组${next}`;
    }

    const entry = { id, title: finalTitle, createdAt: now, updatedAt: now };
    const dir = pgDir(id);
    await ensureDir(dir);
    await fs.writeFile(path.join(dir, 'prompt.md'), '', 'utf-8');
    for (let i = 1; i <= 6; i++) {
      await fs.writeFile(path.join(dir, `r${i}.md`), '', 'utf-8');
    }
    index.unshift(entry);
    await writePGIndex(index);
    res.json(entry);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/prompt-groups/:id', async (req, res) => {
  try {
    const id = req.params.id;
    if (!/^pg-[a-z0-9]+$/.test(id)) return res.status(400).json({ error: 'bad id' });
    const index = await readPGIndex();
    const meta = index.find(d => d.id === id);
    if (!meta) return res.status(404).json({ error: 'Group not found' });

    const dir = pgDir(id);
    let prompt = '';
    try { prompt = await fs.readFile(path.join(dir, 'prompt.md'), 'utf-8'); } catch {}

    const responses = {};
    for (let i = 1; i <= 6; i++) {
      try { responses[i] = await fs.readFile(path.join(dir, `r${i}.md`), 'utf-8'); } catch { responses[i] = ''; }
    }

    res.json({ ...meta, prompt, responses });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/prompt-groups/:id', async (req, res) => {
  try {
    const id = req.params.id;
    if (!/^pg-[a-z0-9]+$/.test(id)) return res.status(400).json({ error: 'bad id' });
    const index = await readPGIndex();
    const meta = index.find(d => d.id === id);
    if (!meta) return res.status(404).json({ error: 'Group not found' });

    if (typeof req.body.title === 'string') meta.title = req.body.title.trim() || meta.title;
    meta.updatedAt = new Date().toISOString();
    await writePGIndex(index);
    res.json(meta);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/prompt-groups/:id/prompt', async (req, res) => {
  try {
    const id = req.params.id;
    if (!/^pg-[a-z0-9]+$/.test(id)) return res.status(400).json({ error: 'bad id' });
    const index = await readPGIndex();
    const meta = index.find(d => d.id === id);
    if (!meta) return res.status(404).json({ error: 'Group not found' });

    await ensureDir(pgDir(id));
    await fs.writeFile(path.join(pgDir(id), 'prompt.md'), req.body.content || '', 'utf-8');
    meta.updatedAt = new Date().toISOString();
    await writePGIndex(index);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/prompt-groups/:id/r/:slot', async (req, res) => {
  try {
    const id = req.params.id;
    const slot = parseInt(req.params.slot, 10);
    if (!/^pg-[a-z0-9]+$/.test(id)) return res.status(400).json({ error: 'bad id' });
    if (slot < 1 || slot > 6) return res.status(400).json({ error: 'slot must be 1-6' });
    const index = await readPGIndex();
    const meta = index.find(d => d.id === id);
    if (!meta) return res.status(404).json({ error: 'Group not found' });

    await ensureDir(pgDir(id));
    await fs.writeFile(path.join(pgDir(id), `r${slot}.md`), req.body.content || '', 'utf-8');
    meta.updatedAt = new Date().toISOString();
    await writePGIndex(index);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/prompt-groups/:id', async (req, res) => {
  try {
    const id = req.params.id;
    if (!/^pg-[a-z0-9]+$/.test(id)) return res.status(400).json({ error: 'bad id' });
    let index = await readPGIndex();
    index = index.filter(d => d.id !== id);
    await writePGIndex(index);
    try {
      const dir = pgDir(id);
      const files = await fs.readdir(dir);
      for (const f of files) await fs.unlink(path.join(dir, f));
      await fs.rmdir(dir);
    } catch {}
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Shutdown endpoint — kills all related processes for clean exit
app.post('/api/shutdown', (req, res) => {
  res.json({ ok: true, message: 'Shutting down…' });
  setTimeout(() => process.exit(0), 300);
});

const PORT = parseInt(process.env.NOVELWEB_API_PORT || '3001', 10);
app.listen(PORT, () => {
  console.log(`NovelWeb API running on http://localhost:${PORT}`);
});
