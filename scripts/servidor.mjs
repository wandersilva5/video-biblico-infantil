import { createServer } from 'node:http';
import { readFile, writeFile, readdir, mkdir, unlink, rename } from 'node:fs/promises';
import { existsSync, createReadStream, statSync } from 'node:fs';
import { join, dirname, basename, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { verificarEtapa } from './verificar_servicos.mjs';
import { buildPromptImagem } from './gerar_imagens.mjs';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SCRIPTS_DIR, '..');
const WEB_DIR = join(ROOT, 'web');
const OUTPUT_DIR = join(ROOT, 'output');
const CONFIG_PATH = join(ROOT, '.config.json');

const DEFAULTS = {
  LLAMA_URL: 'http://127.0.0.1:8091',
  COMFY_URL: 'http://127.0.0.1:8188',
  COMFY_OUTPUT_DIR: 'D:\\ComfyUI_windows_portable\\ComfyUI\\output',
  ZIMAGE_UNET: 'z-image\\z_image_turbo-Q4_K_M.gguf',
  ZIMAGE_CLIP: 'qwen\\qwen3_4b_fp8_scaled.safetensors',
  ZIMAGE_VAE: 'FLUX-Anime-VAE-B2.safetensors',
  ZIMAGE_LORA: 'z-image\\z-image-anime-01.safetensors',
  TTS: 'edge-tts',
  VOZ: 'pt-BR-FranciscaNeural',
  FORMATO: '16:9',
  PORTA: '5173',
};

async function carregarConfig() {
  const doArquivo = await (async () => {
    try {
      return JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
    } catch {
      return {};
    }
  })();
  const cfg = { ...DEFAULTS, ...doArquivo };
  if (process.env.PORTA) cfg.PORTA = process.env.PORTA;
  return cfg;
}

let CONFIG = await carregarConfig();

async function salvarConfig() {
  await writeFile(CONFIG_PATH, JSON.stringify(CONFIG, null, 2), 'utf8');
}

const slugDe = (t) =>
  t
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const hashDe = (t) => createHash('sha1').update(t ?? '').digest('hex');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

// ---------------------------------------------------------------------------
// Fila de eventos (SSE)
// ---------------------------------------------------------------------------
const clientes = new Set();

function broadcast(msg) {
  const payload = `event: progresso\ndata: ${JSON.stringify(msg)}\n\n`;
  for (const res of clientes) {
    try {
      res.write(payload);
    } catch {
      /* cliente caiu */
    }
  }
}

// ---------------------------------------------------------------------------
// Executor de jobs (um por vez)
// ---------------------------------------------------------------------------
let jobAtual = null;

function matarArvore(pid) {
  return new Promise((resolve) => {
    try {
      const p = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
      p.on('error', resolve);
      p.on('exit', resolve);
    } catch {
      resolve();
    }
  });
}

function runJob({ etapa, args, env = {} }) {
  return new Promise((resolve, reject) => {
    if (jobAtual) {
      const err = new Error(`Já existe um job em execução (${jobAtual.etapa}). Aguarde terminar.`);
      err.code = 'JOB_ATIVO';
      reject(err);
      return;
    }
    const jobId = `${etapa}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const emit = (tipo, linha) => broadcast({ jobId, etapa, tipo, linha, ts: Date.now() });
    const child = spawn(process.execPath, args, { env: { ...process.env, ...CONFIG, ...env } });
    jobAtual = { jobId, etapa, child };
    let stdout = '';
    let stderr = '';
    emit('inicio', `Iniciando etapa: ${etapa} ...`);
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => {
      stderr += d.toString();
      for (const raw of d.toString().split(/\r?\n/)) {
        const l = raw.trim();
        if (!l) continue;
        const m = /^(\d{1,3})%\s+(.*)$/.exec(l);
        if (m) emit('progress', m[2].trim() + ` (${m[1]}%)`);
        else {
          const pm = /^\[([^\]]+?)\s+(\d+)\/(\d+)\]\s*(.*)$/.exec(l);
          if (pm) {
            const pct = Math.round((Number(pm[2]) / Number(pm[3])) * 100);
            emit('progress', `${pm[1]} ${pm[2]}/${pm[3]}${pm[4] ? ' · ' + pm[4].trim() : ''} (${pct}%)`);
          } else if (/erro/i.test(l)) emit('erro', l);
          else if (/OK:/.test(l)) emit('ok', l);
          else emit('log', l);
        }
      }
    });

    // Log persistido do job (output/<slug>/logs/<jobId>.log)
    const roteiroArg = args.find((a) => typeof a === 'string' && a.toLowerCase().endsWith('roteiro.json'));
    const slugLog = roteiroArg ? basename(dirname(roteiroArg)) : slugDe(String(args[1] ?? etapa));
    const logDir = join(OUTPUT_DIR, slugLog, 'logs');
    async function gravarLog() {
      try {
        await mkdir(logDir, { recursive: true });
        const corpo = [
          `# job ${jobId} · etapa ${etapa} · ${new Date().toISOString()}`,
          `$ node ${args.join(' ')}`,
          '',
          '--- stdout ---',
          stdout.trim(),
          '',
          '--- stderr ---',
          stderr.trim(),
          '',
        ].join('\n');
        await writeFile(join(logDir, `${jobId}.log`), corpo, 'utf8');
      } catch (e) {
        console.error('[log] erro ao gravar log:', e.message);
      }
    }

    child.on('error', async (err) => {
      jobAtual = null;
      await gravarLog();
      emit('erro', `Falha ao iniciar processo: ${err.message}`);
      broadcast({ jobId, etapa, tipo: 'fim', ok: false, ts: Date.now() });
      reject(err);
    });
    child.on('exit', async (code) => {
      jobAtual = null;
      await gravarLog();
      let resultado = null;
      try {
        resultado = JSON.parse(stdout.trim());
      } catch {
        /* stdout não é JSON */
      }
      broadcast({ jobId, etapa, tipo: 'fim', ok: code === 0, resultado, ts: Date.now() });
      if (code === 0) {
        resolve(resultado ?? {});
      } else {
        const stderrSummary = stderr.trim().split(/\r?\n/).slice(-20).join('\n');
        const err = new Error(
          stderrSummary || `Etapa ${etapa} falhou (código ${code})`,
        );
        err.code = 'JOB_FALHOU';
        err.stderr = stderr; // stderr completo para debug
        err.stdout = stdout;
        reject(err);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Leitura do roteiro e artefatos
// ---------------------------------------------------------------------------
async function lerRoteiro(slug) {
  return JSON.parse(await readFile(join(OUTPUT_DIR, slug, 'roteiro.json'), 'utf8'));
}

function itensDoRoteiro(roteiro) {
  const total = roteiro.slides.length + 2;
  return [
    { id: 'intro', prefix: '00-intro', texto: roteiro.introducao },
    ...roteiro.slides.map((s, i) => ({
      id: s.id,
      prefix: String(i + 1).padStart(2, '0'),
      texto: s.narracao,
      prompt: s.imagem_prompt,
      idx: i,
    })),
    { id: 'conclusao', prefix: `${String(total - 1).padStart(2, '0')}-conclusao`, texto: roteiro.conclusao },
  ];
}

async function lerManifesto(slug) {
  try {
    return JSON.parse(await readFile(join(OUTPUT_DIR, slug, 'manifesto.json'), 'utf8'));
  } catch {
    return { audio: {}, imagem: {} };
  }
}

async function salvarManifesto(slug, manifest) {
  await writeFile(join(OUTPUT_DIR, slug, 'manifesto.json'), JSON.stringify(manifest, null, 2), 'utf8');
}

const mtimeDe = (p) => {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return null;
  }
};

async function artefatos(slug) {
  const roteiro = await lerRoteiro(slug);
  const outDir = join(OUTPUT_DIR, slug);
  const manifest = await lerManifesto(slug);
  const itens = itensDoRoteiro(roteiro);
  const roteiroMtime = mtimeDe(join(outDir, 'roteiro.json'));

  const audioDe = (item) => {
    const p = join(outDir, `${item.prefix}-narracao.mp3`);
    const esperado = manifest.audio?.[item.id];
    return {
      existe: existsSync(p),
      mtime: mtimeDe(p),
      desatualizado: esperado ? esperado !== hashDe(item.texto) : false,
    };
  };

  const slides = roteiro.slides.map((s, i) => {
    const item = itens[i + 1];
    const img = join(outDir, `slide-${String(i + 1).padStart(2, '0')}.png`);
    const esperado = manifest.imagem?.[s.id];
    return {
      id: s.id,
      idx: i + 1,
      titulo: s.titulo,
      imagem: {
        existe: existsSync(img),
        mtime: mtimeDe(img),
        desatualizado: esperado ? esperado !== hashDe(s.imagem_prompt) : false,
        prompt: buildPromptImagem(s),
      },
      audio: audioDe(item),
    };
  });

  const videos = (await readdir(outDir))
    .filter((f) => f.toLowerCase().endsWith('.mp4'))
    .map((f) => {
      const p = join(outDir, f);
      return { arquivo: f, mtime: mtimeDe(p), tamanho: existsSync(p) ? statSync(p).size : 0 };
    })
    .sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0));
  const ultimo = videos[0] ?? null;
  return {
    slug,
    roteiroMtime,
    intro: audioDe(itens[0]),
    slides,
    conclusao: audioDe(itens[itens.length - 1]),
    video: {
      existe: !!ultimo,
      mtime: ultimo?.mtime ?? null,
      tamanho: ultimo?.tamanho ?? 0,
      arquivo: ultimo?.arquivo ?? null,
    },
    videos,
    audioCompleto: [itens[0], ...itens.slice(1, -1), itens[itens.length - 1]].every((it) => audioDe(it).existe),
    imagensCompletas: slides.every((s) => s.imagem.existe),
  };
}

// ---------------------------------------------------------------------------
// Helpers HTTP
// ---------------------------------------------------------------------------
async function lerBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function arquivo(res, path) {
  if (!existsSync(path)) {
    json(res, 404, { erro: 'Arquivo não encontrado' });
    return;
  }
  const type = MIME[extname(path).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
  createReadStream(path).pipe(res);
}

function dentroDe(base, alvo) {
  const rel = resolve(base).length + 1;
  return resolve(alvo).startsWith(resolve(base) + sep) || resolve(alvo) === resolve(base);
}

function ehSlugValido(s) {
  return /^[a-z0-9-]+$/.test(s);
}

async function exigirServico(etapa, res) {
  const { ok, msg } = await verificarEtapa(etapa, CONFIG);
  if (!ok) {
    json(res, 400, { erro: msg });
    return false;
  }
  return true;
}

async function listarAulas() {
  if (!existsSync(OUTPUT_DIR)) return [];
  const dirs = (await readdir(OUTPUT_DIR, { withFileTypes: true })).filter((d) => d.isDirectory());
  const aulas = [];
  for (const d of dirs) {
    const rp = join(OUTPUT_DIR, d.name, 'roteiro.json');
    if (!existsSync(rp)) continue;
    try {
      const roteiro = JSON.parse(await readFile(rp, 'utf8'));
      const st = await artefatos(d.name);
      aulas.push({
        slug: d.name,
        topico: roteiro.topico || roteiro.titulo_aula,
        titulo_aula: roteiro.titulo_aula,
        slides: roteiro.slides.length,
        audioCompleto: st.audioCompleto,
        imagensCompletas: st.imagensCompletas,
        videoPronto: st.video.existe,
      });
    } catch (e) {
      console.error(`[listarAulas] Erro ao ler ${d.name}/roteiro.json:`, e.message);
    }
  }
  aulas.sort((a, b) => (a.slug < b.slug ? 1 : -1));
  return aulas;
}

// ---------------------------------------------------------------------------
// Servidor
// ---------------------------------------------------------------------------
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  try {
    // ---- Cancelar job ativo ----
    if (path === '/api/cancel' && req.method === 'POST') {
      if (!jobAtual) return json(res, 200, { ok: true, msg: 'Nenhum job ativo' });
      const { jobId, etapa, child } = jobAtual;
      await matarArvore(child.pid);
      try {
        await fetch(`${CONFIG.COMFY_URL}/interrupt`, { method: 'POST' });
      } catch {
        /* ComfyUI fora do ar ou sem job */
      }
      broadcast({ jobId, etapa, tipo: 'fim', ok: false, cancelado: true, ts: Date.now() });
      return json(res, 200, { ok: true, msg: `Job ${etapa} cancelado` });
    }

    // ---- SSE de progresso ----
    if (path === '/api/progresso' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write('event: pronto\ndata: {}\n\n');
      clientes.add(res);
      const hb = setInterval(() => {
        try {
          res.write(': ping\n\n');
        } catch {
          clearInterval(hb);
        }
      }, 25000);
      req.on('close', () => {
        clearInterval(hb);
        clientes.delete(res);
      });
      return;
    }

    // ---- Arquivos de mídia (output/<slug>/...) ----
    if (path.startsWith('/media/')) {
      const [, , slug, ...resto] = path.split('/');
      if (!ehSlugValido(slug) || resto.length !== 1) return json(res, 400, { erro: 'Caminho inválido' });
      const alvo = join(OUTPUT_DIR, slug, basename(resto[0]));
      if (!dentroDe(OUTPUT_DIR, alvo)) return json(res, 400, { erro: 'Caminho inválido' });
      return arquivo(res, alvo);
    }

    // ---- Estáticos (web/) ----
    if (path === '/' || path.startsWith('/api/') === false) {
      const rel = path === '/' ? 'index.html' : path.replace(/^\/+/, '');
      const alvo = join(WEB_DIR, rel);
      if (dentroDe(WEB_DIR, alvo) && existsSync(alvo) && !statSync(alvo).isDirectory()) {
        return arquivo(res, alvo);
      }
      return arquivo(res, join(WEB_DIR, 'index.html'));
    }

    // ---- API ----
    const m = path.match(/^\/api\/([^/]+)(?:\/([^/]+))?$/);
    if (!m) return json(res, 404, { erro: 'Rota não encontrada' });
    const recurso = m[1];
    const slug = m[2] ?? '';

    if (recurso === 'aulas' && req.method === 'GET') {
      return json(res, 200, await listarAulas());
    }

    if (recurso === 'config') {
      if (req.method === 'GET') return json(res, 200, CONFIG);
      if (req.method === 'PUT') {
        const body = await lerBody(req);
        CONFIG = { ...CONFIG, ...body };
        await salvarConfig();
        return json(res, 200, CONFIG);
      }
    }

    // --- Roteiro (POST cria nova aula — não tem slug ainda) ---
    if (recurso === 'roteiro' && req.method === 'POST') {
      const body = await lerBody(req);
      if (!body.topico) return json(res, 400, { erro: 'Campo "topico" é obrigatório' });
      if (!(await exigirServico('roteiro', res))) return;
      try {
        await runJob({ etapa: 'roteiro', args: [join(SCRIPTS_DIR, 'gerar_roteiro.mjs'), body.topico] });
      } catch (e) {
        return json(res, e.code === 'JOB_ATIVO' ? 409 : 500, { erro: e.message });
      }
      const novoSlug = slugDe(body.topico);
      const roteiro = await lerRoteiro(novoSlug);
      return json(res, 200, { slug: novoSlug, roteiro });
    }

    if (!slug || !ehSlugValido(slug)) return json(res, 400, { erro: 'Slug inválido' });
    const roteiroPath = join(OUTPUT_DIR, slug, 'roteiro.json');

    if (recurso === 'roteiro' && req.method === 'GET') {
      if (!existsSync(roteiroPath)) return json(res, 404, { erro: 'Roteiro não existe' });
      return json(res, 200, await lerRoteiro(slug));
    }

    if (recurso === 'roteiro' && req.method === 'PUT') {
      const body = await lerBody(req);
      if (!body.titulo_aula || !Array.isArray(body.slides)) {
        return json(res, 400, { erro: 'Roteiro inválido: faltam "titulo_aula" ou "slides"' });
      }
      body.slug = slug;
      if (!body.topico) body.topico = body.titulo_aula;
      await writeFile(roteiroPath, JSON.stringify(body, null, 2), 'utf8');
      return json(res, 200, body);
    }

    // --- Artefatos ---
    if (recurso === 'artefatos' && req.method === 'GET') {
      if (!existsSync(roteiroPath)) return json(res, 404, { erro: 'Roteiro não existe' });
      return json(res, 200, await artefatos(slug));
    }

    // --- Imagens ---
    if (recurso === 'imagens' && req.method === 'DELETE') {
      const body = await lerBody(req);
      if (!body.slideId) return json(res, 400, { erro: 'Campo "slideId" é obrigatório' });
      const roteiro = await lerRoteiro(slug);
      const idx = roteiro.slides.findIndex((s) => s.id === body.slideId);
      if (idx === -1) return json(res, 400, { erro: `Slide "${body.slideId}" não encontrado` });
      const png = join(OUTPUT_DIR, slug, `slide-${String(idx + 1).padStart(2, '0')}.png`);
      if (existsSync(png)) await unlink(png);
      const manifest = await lerManifesto(slug);
      delete manifest.imagem[body.slideId];
      await salvarManifesto(slug, manifest);
      return json(res, 200, { ok: true });
    }

    if (recurso === 'imagens' && req.method === 'POST') {
      const body = await lerBody(req);
      if (!(await exigirServico('imagens', res))) return;
      const roteiro = await lerRoteiro(slug);
      const outDir = join(OUTPUT_DIR, slug);
      const backups = [];
      if (body.slideId) {
        const idx = roteiro.slides.findIndex((s) => s.id === body.slideId);
        if (idx === -1) return json(res, 400, { erro: `Slide "${body.slideId}" não encontrado` });
        const png = join(outDir, `slide-${String(idx + 1).padStart(2, '0')}.png`);
        if (existsSync(png)) {
          const bak = png + '.bak';
          await rename(png, bak);
          backups.push({ original: png, backup: bak });
        }
      } else if (body.recriarTodos) {
        for (let i = 0; i < roteiro.slides.length; i++) {
          const png = join(outDir, `slide-${String(i + 1).padStart(2, '0')}.png`);
          if (existsSync(png)) {
            const bak = png + '.bak';
            await rename(png, bak);
            backups.push({ original: png, backup: bak });
          }
        }
      }
      const env = body.variar ? { KREA2_SEED_BASE: String(Math.floor(Math.random() * 1e9)) } : {};
      try {
        await runJob({ etapa: 'imagens', args: [join(SCRIPTS_DIR, 'gerar_imagens.mjs'), roteiroPath], env });
        for (const { backup } of backups) {
          if (existsSync(backup)) await unlink(backup);
        }
      } catch (e) {
        for (const { original, backup } of backups) {
          if (existsSync(backup)) await rename(backup, original);
        }
        return json(res, e.code === 'JOB_ATIVO' ? 409 : 500, { erro: e.message });
      }
      const manifest = await lerManifesto(slug);
      const alvos = body.slideId ? [body.slideId] : roteiro.slides.map((s) => s.id);
      for (const id of alvos) {
        const s = roteiro.slides.find((x) => x.id === id);
        if (s) manifest.imagem[id] = hashDe(s.imagem_prompt);
      }
      await salvarManifesto(slug, manifest);
      return json(res, 200, { ok: true });
    }

    // --- Narração ---
    if (recurso === 'narracao' && req.method === 'DELETE') {
      const body = await lerBody(req);
      if (!body.slideId) return json(res, 400, { erro: 'Campo "slideId" é obrigatório' });
      const roteiro = await lerRoteiro(slug);
      const itens = itensDoRoteiro(roteiro);
      const item = itens.find((x) => x.id === body.slideId);
      if (!item) return json(res, 400, { erro: `Item "${body.slideId}" não encontrado` });
      const mp3 = join(OUTPUT_DIR, slug, `${item.prefix}-narracao.mp3`);
      if (existsSync(mp3)) await unlink(mp3);
      const manifest = await lerManifesto(slug);
      delete manifest.audio[body.slideId];
      await salvarManifesto(slug, manifest);
      return json(res, 200, { ok: true });
    }

    if (recurso === 'narracao' && req.method === 'POST') {
      const body = await lerBody(req);
      if (!(await exigirServico('narracao', res))) return;
      const roteiro = await lerRoteiro(slug);
      const args = [join(SCRIPTS_DIR, 'gerar_narracao.mjs'), roteiroPath];
      if (body.slideId) args.push('--apenas', body.slideId);
      else if (body.recriarTodos) {
        // Apaga todos os MP3s de narração para que sejam regenerados do zero.
        const outDir = join(OUTPUT_DIR, slug);
        for (const it of itensDoRoteiro(roteiro)) {
          const mp3 = join(outDir, `${it.prefix}-narracao.mp3`);
          if (existsSync(mp3)) await unlink(mp3);
        }
      }
      try {
        await runJob({ etapa: 'narracao', args });
      } catch (e) {
        return json(res, e.code === 'JOB_ATIVO' ? 409 : 500, { erro: e.message });
      }
      const manifest = await lerManifesto(slug);
      const itens = itensDoRoteiro(roteiro);
      const alvos = body.slideId ? [body.slideId] : itens.map((it) => it.id);
      for (const id of alvos) {
        const it = itens.find((x) => x.id === id);
        if (it) manifest.audio[id] = hashDe(it.texto);
      }
      await salvarManifesto(slug, manifest);
      return json(res, 200, { ok: true });
    }

    // --- Vídeo ---
    if (recurso === 'video' && req.method === 'DELETE') {
      const body = await lerBody(req);
      if (!body.arquivo) return json(res, 400, { erro: 'Campo "arquivo" é obrigatório' });
      const alvo = join(OUTPUT_DIR, slug, basename(body.arquivo));
      if (!dentroDe(OUTPUT_DIR, alvo)) return json(res, 400, { erro: 'Caminho inválido' });
      if (!existsSync(alvo)) return json(res, 404, { erro: 'Arquivo não encontrado' });
      await unlink(alvo);
      return json(res, 200, { ok: true });
    }

    if (recurso === 'video' && req.method === 'POST') {
      const body = await lerBody(req);
      if (!(await exigirServico('video', res))) return;
      if (!existsSync(roteiroPath)) return json(res, 404, { erro: 'Roteiro não existe' });
      const st = await artefatos(slug);
      const faltando = [];
      if (!st.imagensCompletas) faltando.push('imagens de todos os slides');
      if (!st.audioCompleto) faltando.push('narrações de todos os itens');
      if (faltando.length) {
        return json(res, 400, { erro: `Faltam artefatos: ${faltando.join(' e ')}. Gere-os antes de montar o vídeo.` });
      }
      const env = {
        VIDEO_FPS: String(body.fps ?? 30),
        VIDEO_WIDTH: String(body.width ?? 1920),
        VIDEO_HEIGHT: String(body.height ?? 1080),
        VIDEO_PADDING: String(body.padding ?? 0.3),
      };
      try {
        await runJob({ etapa: 'video', args: [join(SCRIPTS_DIR, 'montar_video.mjs'), roteiroPath], env });
      } catch (e) {
        return json(res, e.code === 'JOB_ATIVO' ? 409 : 500, { erro: e.message });
      }
      const arquivo = `${slug}-${String(body.width ?? 1920)}x${String(body.height ?? 1080)}.mp4`;
      return json(res, 200, { ok: true, output_path: arquivo, url: `/media/${slug}/${arquivo}` });
    }

    return json(res, 404, { erro: 'Rota não encontrada' });
  } catch (e) {
    if (!res.headersSent) return json(res, 500, { erro: e.message });
    res.end();
  }
});

await mkdir(OUTPUT_DIR, { recursive: true });
server.listen(Number(CONFIG.PORTA), () => {
  console.log(`Servidor rodando em http://localhost:${CONFIG.PORTA}`);
});
