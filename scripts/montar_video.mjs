/**
 * montar_video.mjs — Renderiza uma videoaula a partir de um roteiro.json
 * usando o pipeline html-video (core API):
 *   - cada slide vira um frame HTML (imagem limpa + legenda da narração)
 *   - gera a narração concatenada em um MP3
 *   - renderiza frames via Chromium + ffmpeg e concatena
 *   - mixa a narração no MP4 final
 *
 * Uso: node montar_video.mjs <caminho/roteiro.json>
 */
import { readFile, writeFile, mkdir, copyFile, rename } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  AssetStore,
  EngineRegistry,
  ProjectOrchestrator,
  ProjectStore,
  TemplateRegistry,
} from '@html-video/core';
import hfAdapter from '@html-video/adapter-hyperframes';

const execFileAsync = promisify(execFile);
const HTML_VIDEO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const FPS = Number(process.env.VIDEO_FPS) || 30;
// Formato escolhido (16:9 | 9:16) define a resolução padrão; um formato por vez.
const FORMATO = (process.env.FORMATO || '16:9').trim();
const WIDTH = Number(process.env.VIDEO_WIDTH) || (FORMATO === '9:16' ? 1080 : 1920);
const HEIGHT = Number(process.env.VIDEO_HEIGHT) || (FORMATO === '9:16' ? 1920 : 1080);
const SLIDE_PADDING_SEC = process.env.VIDEO_PADDING !== undefined && process.env.VIDEO_PADDING !== '' ? Number(process.env.VIDEO_PADDING) : 0.3;
// LEGENDA=0 mostra só o título do slide; default (1) mostra a narração como legenda em destaque.
const MOSTRAR_LEGENDA = process.env.LEGENDA !== '0';
// Marca exibida na intro, rodapé e outro.
const MARCA = process.env.MARCA || 'Histórias Bíblicas Infantis';
// Trilha sonora de fundo opcional (caminho de um MP3/WAV). Mixada a baixo volume.
const TRILHA = process.env.TRILHA || '';
const TRILHA_VOLUME = Number(process.env.TRILHA_VOLUME) || 0.08;
// Fade-out suave da legenda antes de trocar de slide (LEGENDA_FADE=0 desliga).
const LEGENDA_FADE = process.env.LEGENDA_FADE !== '0';
// Efeito Ken Burns: zoom/pan suave na imagem para ela não ficar parada (KENBURNS=0 desliga).
const KENBURNS = process.env.KENBURNS !== '0';
// Transição entre slides: 'fade' (default) faz um fade para preto no fim/início de cada
// frame; 'corte' mantém cortes secos (comportamento antigo).
const TRANSICAO = (process.env.TRANSICAO || 'fade').trim() === 'fade';

// Escala tipográfica proporcional à largura (referência 16:9 = 1920px de largura).
// Assim o layout adapta a proporção escolhida (9:16, 4:5, etc.) sem quebrar.
const s = (v) => (v * (WIDTH / 1920)).toFixed(1);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function medirDuracaoMp3(path) {
  const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path]);
  return parseFloat(stdout.trim());
}

/** Divide a narração em segmentos de até maxChars (por frases e vírgulas). */
function segmentarTexto(texto, maxChars) {
  const seg = [];
  const frases = String(texto ?? '').split(/(?<=[.!?…])[\s]+/).filter(Boolean);
  for (const frase of frases) {
    if (frase.length <= maxChars) {
      seg.push(frase);
      continue;
    }
    const porVirgula = frase.split(/(?<=[,;:])[\s]+/).filter(Boolean);
    let acum = '';
    for (const p of porVirgula) {
      if (acum && acum.length + 1 + p.length > maxChars) {
        seg.push(acum);
        acum = p;
      } else {
        acum = acum ? acum + ' ' + p : p;
      }
    }
    if (acum) seg.push(acum);
  }
  return seg.length ? seg : [String(texto ?? '')];
}

/** Gera as linhas da legenda com timeline proporcional à duração do áudio do slide. */
function gerarLegendaSincronizada(texto, durationSec, maxChars) {
  const segs = segmentarTexto(texto, maxChars);
  const totalChars = segs.reduce((a, s) => a + s.length, 0) || 1;
  const D = Math.max(durationSec, 3);
  let acum = 0;
  return segs
    .map((s) => {
      const start = (acum / totalChars) * D;
      acum += s.length;
      const end = (acum / totalChars) * D;
      const dur = Math.max(end - start, 0.5);
      return `<div class="linha" style="animation-duration:${dur.toFixed(2)}s;animation-delay:${start.toFixed(2)}s">${escapeHtml(s)}</div>`;
    })
    .join('');
}

/** Mixa uma música de fundo (volume baixo, fade in/out) sobre o MP4 final. */
async function mixarTrilha(videoPath, trilhaPath) {
  const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', videoPath]);
  const dur = parseFloat(stdout.trim()) || 30;
  const fadeOut = Math.min(3, dur * 0.5);
  const tmp = videoPath + '.tmp.mp4';
  const filtro =
    `[1:a]aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${TRILHA_VOLUME},` +
    `afade=t=in:st=0:d=1.5,afade=t=out:st=${(dur - fadeOut).toFixed(2)}:d=${fadeOut.toFixed(2)}[bg];` +
    `[0:a][bg]amix=inputs=2:duration=first:dropout_transition=2[aout]`;
  await execFileAsync('ffmpeg', [
    '-y', '-i', videoPath, '-i', trilhaPath,
    '-filter_complex', filtro,
    '-map', '0:v', '-map', '[aout]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', tmp,
  ]);
  await rename(tmp, videoPath);
}

async function concatAudios(audios, outPath) {
  // Cada MP3 vira entrada separada e é concatenado com gaps de silêncio
  // (aresample + anullsrc) para alinhar com os frames (SLIDE_PADDING_SEC entre cada).
  // Observação: edge-tts produz MP3 24kHz mono; normalizamos tudo para 44.1kHz
  // stereo antes do concat, senão o filtro falha por incompatibilidade de formato.
  const { spawn } = await import('node:child_process');
  const args = ['-y'];
  const n = audios.length;
  const filters = [];
  const labels = [];
  for (let i = 0; i < n; i++) {
    args.push('-i', audios[i].path);
    filters.push(`[${i}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`);
    labels.push(`[a${i}]`);
    if (i < n - 1) {
      filters.push(`anullsrc=r=44100:cl=stereo:d=${SLIDE_PADDING_SEC}[pad${i}]`);
      labels.push(`[pad${i}]`);
    }
  }
  filters.push(`${labels.join('')}concat=n=${labels.length}:v=0:a=1[out]`);
  args.push('-filter_complex', filters.join(';'), '-map', '[out]', '-c:a', 'libmp3lame', '-b:a', '192k', outPath);

  await new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg concat audio exit ${code}: ${stderr.slice(-1000)}`));
    });
  });
}

// ---------------------------------------------------------------------------
// Geração dos frames HTML (slides)
// ---------------------------------------------------------------------------

function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** CSS dos efeitos de imagem (Ken Burns + fade para preto na transição). */
function cssEfeitosImagem(durationSec) {
  const dur = Math.max(3, Number(durationSec) || 8);
  let css = '';
  if (KENBURNS) {
    css += `
  .bg img, .img-zone img { animation: kenburns ${Math.max(6, dur)}s ease-in-out infinite; transform-origin: center center; }
  @keyframes kenburns { 0% { transform: scale(1.02) translate3d(0,0,0); } 50% { transform: scale(1.16) translate3d(-1.2%,1%,0); } 100% { transform: scale(1.02) translate3d(0,0,0); } }`;
  }
  if (TRANSICAO) {
    css += `
  .dip { position: absolute; inset: 0; z-index: 10; background: #000; pointer-events: none; animation: dip ${dur}s linear forwards; }
  @keyframes dip { 0% { opacity: 1; } 3% { opacity: 0; } 97% { opacity: 0; } 100% { opacity: 1; } }`;
  }
  return css;
}

/** Overlay de transição (fade para preto) adicionado ao body de cada frame. */
function htmlDip() {
  return TRANSICAO ? '<div class="dip"></div>' : '';
}

function gerarFrameHtml(slide, imagePath, durationSec = 8) {
  const imgName = basename(imagePath);
  // Legenda em destaque: fonte adaptativa ao tamanho do texto e da resolução.
  const TEXTO_LEGENDA = slide.narracao || '';
  const CHARS = TEXTO_LEGENDA.length;
  const BASE_FONTE = 44 * (WIDTH / 1920);
  const FATOR_FONTE = CHARS > 330 ? 0.66 : CHARS > 250 ? 0.76 : CHARS > 170 ? 0.88 : 1;
  const FONTE_LEGENDA = (BASE_FONTE * FATOR_FONTE).toFixed(1);
  const MAX_CHARS_LINHA = Math.max(16, Math.floor((WIDTH * 0.85) / (Number(FONTE_LEGENDA) * 0.5)));
  const DURACAO = Math.max(durationSec, 3);
  // Legenda "linha por linha", com timeline proporcional à duração do áudio:
  // cada linha da narração aparece na hora aproximada em que é narrada.
  const LINHAS_LEGENDA = gerarLegendaSincronizada(TEXTO_LEGENDA, DURACAO, MAX_CHARS_LINHA);
  const KEYFRAMES_LINHA = LEGENDA_FADE
    ? `@keyframes linhaLegenda { 0% { opacity: 0; transform: translateX(-50%) translateY(${s(12)}px); } 6% { opacity: 1; transform: translateX(-50%) translateY(0); } 82% { opacity: 1; transform: translateX(-50%) translateY(0); } 100% { opacity: 0; transform: translateX(-50%) translateY(-${s(8)}px); } }`
    : `@keyframes linhaLegenda { 0% { opacity: 0; transform: translateX(-50%); } 0.1% { opacity: 1; transform: translateX(-50%); } 99.9% { opacity: 1; transform: translateX(-50%); } 100% { opacity: 0; transform: translateX(-50%); } }`;
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8" />
<title>${escapeHtml(slide.titulo)}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { width: ${WIDTH}px; height: ${HEIGHT}px; overflow: hidden; font-family: 'Segoe UI', system-ui, sans-serif; position: relative; background: #0d1b2a; }
  .bg { position: absolute; inset: 0; }
  .bg img { width: 100%; height: 100%; object-fit: cover; }
  .legenda { position: absolute; left: 0; right: 0; bottom: ${s(60)}px; text-align: center; }
  .linha { position: absolute; left: 50%; bottom: 0; transform: translateX(-50%); max-width: 96%; font-size: ${FONTE_LEGENDA}px; font-weight: 800; color: #ffffff; line-height: 1.25; text-align: center; background: rgba(8,18,30,0.85); border: ${s(3)}px solid #ffd54a; border-radius: ${s(16)}px; padding: ${s(16)}px ${s(26)}px; text-shadow: 0 2px 6px rgba(0,0,0,0.9), 0 0 2px rgba(0,0,0,0.8); box-shadow: 0 8px 28px rgba(0,0,0,0.55); opacity: 0; animation-name: linhaLegenda; animation-timing-function: linear; animation-fill-mode: both; }
  .content { position: absolute; inset: 0; padding: ${s(70)}px ${s(80)}px ${s(56)}px; display: flex; flex-direction: column; justify-content: flex-end; align-items: center; }
  .card { max-width: ${s(1600)}px; width: 100%; display: flex; justify-content: center; }
  .titulo-slide { font-size: ${s(52)}px; font-weight: 800; color: #ffffff; text-align: center; text-shadow: 0 2px 6px rgba(0,0,0,0.9), 0 0 2px rgba(0,0,0,0.8); }
  ${cssEfeitosImagem(DURACAO)}
  ${KEYFRAMES_LINHA}
</style>
</head>
<body>
  <div class="bg"><img src="${escapeHtml(imgName)}" /></div>
  ${htmlDip()}
  ${MOSTRAR_LEGENDA
    ? `<div class="legenda">${LINHAS_LEGENDA}</div>`
    : `<div class="content"><div class="card"><h1 class="titulo-slide">${escapeHtml(slide.titulo)}</h1></div></div>`}
</body>
</html>`;
}

function gerarFrameIntro(roteiro, introImgName, durationSec = 8) {
  if (introImgName) {
    // Abertura infantil em dois painéis: a mulher com a Bíblia infantil de um lado
    // e o título/subtítulo do outro (empilha na vertical no formato 9:16).
    const vertical = HEIGHT > WIDTH;
    const imgZone = vertical ? 'width:100%;height:56%' : 'width:56%;height:100%';
    const textZone = vertical ? 'width:100%;height:44%' : 'width:44%;height:100%';
    return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8" />
<title>Intro</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { width: ${WIDTH}px; height: ${HEIGHT}px; overflow: hidden; font-family: 'Segoe UI', system-ui, sans-serif; position: relative; background: #0d1b2a; display: flex; ${vertical ? 'flex-direction: column;' : ''} }
  .img-zone { ${imgZone}; overflow: hidden; }
  .img-zone img { width: 100%; height: 100%; object-fit: cover; }
  .text-zone { ${textZone}; display: flex; flex-direction: column; justify-content: center; align-items: center; text-align: center; padding: ${s(40)}px ${s(56)}px; background: linear-gradient(135deg, #243a5c 0%, #0d1b2a 100%); }
  .kicker { font-size: ${s(26)}px; letter-spacing: ${s(7)}px; text-transform: uppercase; color: #ffd54a; font-weight: 700; margin-bottom: ${s(22)}px; opacity: 0; animation: fadeUp 0.7s ease-out 0.3s forwards; }
  h1 { font-size: ${vertical ? s(64) : s(88)}px; color: #ffffff; font-weight: 800; line-height: 1.1; margin-bottom: ${s(20)}px; opacity: 0; animation: fadeUp 0.8s ease-out 0.8s forwards; }
  .sub { font-size: ${s(28)}px; color: #c9d4e0; opacity: 0; animation: fadeUp 0.8s ease-out 1.4s forwards; }
  @keyframes fadeUp { from { opacity: 0; transform: translateY(${s(30)}px); } to { opacity: 1; transform: translateY(0); } }
  ${cssEfeitosImagem(durationSec)}
</style>
</head>
<body>
  <div class="img-zone"><img src="${escapeHtml(introImgName)}" /></div>
  <div class="text-zone">
    <div class="kicker">História Bíblica Infantil</div>
    <h1>${escapeHtml(roteiro.titulo_aula)}</h1>
    <div class="sub">Uma historinha da Palavra de Deus para você</div>
  </div>
  ${htmlDip()}
</body>
</html>`;
  }
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8" />
<title>Intro</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { width: ${WIDTH}px; height: ${HEIGHT}px; overflow: hidden; font-family: 'Segoe UI', system-ui, sans-serif; position: relative; background: #0d1b2a; }
  .halo { position: absolute; width: ${s(900)}px; height: ${s(900)}px; border-radius: 50%; left: 50%; top: 42%; transform: translate(-50%, -50%); background: radial-gradient(circle, rgba(255,213,74,0.30) 0%, rgba(255,213,74,0.06) 55%, transparent 70%); animation: pulse 4s ease-in-out infinite; }
  @keyframes pulse { 0%,100% { transform: translate(-50%,-50%) scale(1); opacity: 0.7; } 50% { transform: translate(-50%,-50%) scale(1.12); opacity: 1; } }
  .inner { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; padding: 0 ${s(200)}px; }
  .brand { position: absolute; top: ${s(70)}px; left: 0; right: 0; text-align: center; font-size: ${s(40)}px; letter-spacing: ${s(10)}px; text-transform: uppercase; color: #ffd54a; font-weight: 700; opacity: 0; animation: fadeUp 0.7s ease-out 0.2s forwards; }
  .kicker { font-size: ${s(30)}px; letter-spacing: ${s(8)}px; text-transform: uppercase; color: #ffd54a; font-weight: 700; margin-bottom: ${s(30)}px; opacity: 0; animation: fadeUp 0.7s ease-out 0.3s forwards; }
  h1 { font-size: ${s(96)}px; color: #ffffff; font-weight: 700; line-height: 1.1; margin-bottom: ${s(24)}px; opacity: 0; animation: fadeUp 0.8s ease-out 0.8s forwards; }
  .sub { font-size: ${s(34)}px; color: #c9d4e0; opacity: 0; animation: fadeUp 0.8s ease-out 1.4s forwards; }
  @keyframes fadeUp { from { opacity: 0; transform: translateY(${s(30)}px); } to { opacity: 1; transform: translateY(0); } }
  ${cssEfeitosImagem(durationSec)}
</style>
</head>
<body>
  <div class="halo"></div>
  <div class="brand">${escapeHtml(MARCA)}</div>
  <div class="inner">
    <div class="kicker">História Bíblica Infantil</div>
    <h1>${escapeHtml(roteiro.titulo_aula)}</h1>
    <div class="sub">Uma historinha da Palavra de Deus para você</div>
  </div>
  ${htmlDip()}
</body>
</html>`;
}

function gerarFrameOutro(outroImgName, durationSec = 8) {
  if (outroImgName) {
    // Encerramento infantil com a ilustração de fundo combinando com o vídeo.
    return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8" />
<title>Conclusão</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { width: ${WIDTH}px; height: ${HEIGHT}px; overflow: hidden; font-family: 'Segoe UI', system-ui, sans-serif; position: relative; background: #0d1b2a; }
  .bg { position: absolute; inset: 0; }
  .bg img { width: 100%; height: 100%; object-fit: cover; }
  .overlay { position: absolute; inset: 0; background: linear-gradient(to bottom, rgba(13,27,42,0.10) 0%, rgba(13,27,42,0.45) 55%, rgba(13,27,42,0.92) 100%); }
  .content { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; text-align: center; padding: 0 ${s(40)}px ${s(84)}px; }
  .kicker { font-size: ${s(26)}px; letter-spacing: ${s(8)}px; text-transform: uppercase; color: #ffd54a; font-weight: 700; margin-bottom: ${s(16)}px; opacity: 0; animation: fadeUp 0.7s ease-out 0.3s forwards; }
  h1 { font-size: ${s(70)}px; color: #ffffff; font-weight: 800; margin-bottom: ${s(12)}px; opacity: 0; animation: fadeUp 0.8s ease-out 0.8s forwards; }
  .thanks { font-size: ${s(28)}px; color: #e8eef5; opacity: 0; animation: fadeUp 0.8s ease-out 1.4s forwards; }
  .brand { font-size: ${s(34)}px; letter-spacing: ${s(10)}px; text-transform: uppercase; color: #ffd54a; font-weight: 700; margin-top: ${s(36)}px; opacity: 0; animation: fadeUp 0.8s ease-out 1.8s forwards; }
  @keyframes fadeUp { from { opacity: 0; transform: translateY(${s(30)}px); } to { opacity: 1; transform: translateY(0); } }
  ${cssEfeitosImagem(durationSec)}
</style>
</head>
<body>
  <div class="bg"><img src="${escapeHtml(outroImgName)}" /></div>
  <div class="overlay"></div>
  <div class="content">
    <div class="kicker">Fim da história</div>
    <h1>Até a próxima historinha!</h1>
    <div class="thanks">Curta e se inscreva para ouvir mais histórias da Bíblia</div>
    <div class="brand">${escapeHtml(MARCA)}</div>
  </div>
  ${htmlDip()}
</body>
</html>`;
  }
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8" />
<title>Conclusão</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { width: ${WIDTH}px; height: ${HEIGHT}px; overflow: hidden; font-family: 'Segoe UI', system-ui, sans-serif; position: relative; background: #0d1b2a; display: flex; align-items: center; justify-content: center; }
  .card { text-align: center; padding: 0 ${s(40)}px; }
  .kicker { font-size: ${s(30)}px; letter-spacing: ${s(8)}px; text-transform: uppercase; color: #ffd54a; font-weight: 700; margin-bottom: ${s(30)}px; opacity: 0; animation: fadeUp 0.7s ease-out 0.3s forwards; }
  h1 { font-size: ${s(88)}px; color: #ffffff; font-weight: 700; margin-bottom: ${s(20)}px; opacity: 0; animation: fadeUp 0.8s ease-out 0.8s forwards; }
  .thanks { font-size: ${s(32)}px; color: #c9d4e0; opacity: 0; animation: fadeUp 0.8s ease-out 1.4s forwards; }
  .brand { font-size: ${s(40)}px; letter-spacing: ${s(10)}px; text-transform: uppercase; color: #ffd54a; font-weight: 700; margin-top: ${s(48)}px; opacity: 0; animation: fadeUp 0.8s ease-out 1.8s forwards; }
  @keyframes fadeUp { from { opacity: 0; transform: translateY(${s(30)}px); } to { opacity: 1; transform: translateY(0); } }
  ${cssEfeitosImagem(durationSec)}
</style>
</head>
<body>
  <div class="card">
    <div class="kicker">Fim da história</div>
    <h1>Até a próxima historinha!</h1>
    <div class="thanks">Curta e se inscreva para ouvir mais histórias da Bíblia</div>
    <div class="brand">${escapeHtml(MARCA)}</div>
  </div>
  ${htmlDip()}
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Fluxo principal
// ---------------------------------------------------------------------------

async function main() {
  const roteiroPath = process.argv[2];
  if (!roteiroPath) {
    console.error('Uso: node montar_video.mjs <caminho/roteiro.json>');
    process.exit(1);
  }
  const roteiro = JSON.parse(await readFile(roteiroPath, 'utf8'));
  const outDir = dirname(roteiroPath);
  const slug = roteiro.slug || basename(outDir);

  console.error('[4/4] Montando vídeo ...');

  // 1. Medir durações dos áudios de narração (por slide)
  const audios = [];
  const textos = [
    { id: 'intro', texto: roteiro.introducao },
    ...roteiro.slides.map((s) => ({ id: s.id, titulo: s.titulo, texto: s.narracao })),
    { id: 'conclusao', texto: roteiro.conclusao },
  ];
  for (let i = 0; i < textos.length; i++) {
    const totalSlides = roteiro.slides.length;
    const prefix = i === 0
      ? '00-intro'
      : i === totalSlides + 1
        ? `${String(totalSlides + 1).padStart(2, '0')}-conclusao`
        : String(i).padStart(2, '0');
    const path = join(outDir, `${prefix}-narracao.mp3`);
    if (!existsSync(path)) throw new Error(`Narração não encontrada: ${path}`);
    const durationSec = await medirDuracaoMp3(path);
    audios.push({ id: textos[i].id, path, durationSec });
    console.error(`  narração ${i + 1}/${textos.length}: ${durationSec.toFixed(1)}s`);
  }

  // 2. Concatenar narração em um único MP3 (com gaps para os frames)
  const narracaoFull = join(outDir, 'narracao-full.mp3');
  await concatAudios(audios, narracaoFull);

  // 3. Preparar projeto html-video
  const projectRoot = HTML_VIDEO_ROOT;
  const engines = new EngineRegistry();
  engines.register(hfAdapter);
  const templates = new TemplateRegistry();
  const templatesDir = join(projectRoot, 'templates');
  await templates.scan(templatesDir);
  const projects = new ProjectStore(projectRoot);
  const assets = new AssetStore({ projectRoot });
  const orchestrator = new ProjectOrchestrator({ projectRoot, engines, templates, projects, assets });

  const project = await orchestrator.create({
    name: `História: ${roteiro.titulo_aula}`,
    preferences: {
      aspect: WIDTH >= HEIGHT ? '16:9' : '9:16',
      resolution: { width: WIDTH, height: HEIGHT },
      fps: FPS,
      language: 'pt-BR',
    },
  });

  // 4. Content graph: intro + slides + conclusão
  const nodes = [
    { id: 'intro', kind: 'text', label: 'Introdução', durationSec: audios[0].durationSec + SLIDE_PADDING_SEC },
  ];
  const edges = [];
  for (let i = 0; i < roteiro.slides.length; i++) {
    nodes.push({ id: roteiro.slides[i].id, kind: 'text', label: roteiro.slides[i].titulo, durationSec: audios[i + 1].durationSec + SLIDE_PADDING_SEC });
    edges.push({ from: i === 0 ? 'intro' : roteiro.slides[i - 1].id, to: roteiro.slides[i].id, kind: 'sequence' });
  }
  const conclIdx = roteiro.slides.length + 1;
  nodes.push({ id: 'conclusao', kind: 'text', label: 'Conclusão', durationSec: audios[conclIdx].durationSec + SLIDE_PADDING_SEC });
  edges.push({ from: roteiro.slides[roteiro.slides.length - 1].id, to: 'conclusao', kind: 'sequence' });

  const graph = { schemaVersion: 1, intent: 'explainer', synopsis: roteiro.titulo_aula, nodes, edges };
  await orchestrator.writeContentGraph(project.id, graph);

  // 5. Escrever frames HTML
  const total = roteiro.slides.length + 2;
  const projectDir = await projects.ensureDir(project.id);
  // Arte de abertura (00-intro.png) e encerramento (outro.png) geradas a partir
  // dos prompts do roteiro. Obrigatórias: sem elas o vídeo não é montado.
  const introImgPath = join(outDir, '00-intro.png');
  const outroImgPath = join(outDir, 'outro.png');
  const faltantes = [introImgPath, outroImgPath].filter((p) => !existsSync(p));
  if (faltantes.length) {
    throw new Error(`Artes de abertura/encerramento não encontradas: ${faltantes.map((p) => basename(p)).join(', ')}. Gere-as antes de montar o vídeo.`);
  }
  await copyFile(introImgPath, join(projectDir, 'frames', '00-intro.png'));
  const introImgName = '00-intro.png';
  await copyFile(outroImgPath, join(projectDir, 'frames', 'outro.png'));
  const outroImgName = 'outro.png';
  await orchestrator.writeFrameHtml(project.id, 'intro', gerarFrameIntro(roteiro, introImgName, audios[0].durationSec + SLIDE_PADDING_SEC));
  for (let i = 0; i < roteiro.slides.length; i++) {
    const slide = roteiro.slides[i];
    const imgPath = join(outDir, `slide-${String(i + 1).padStart(2, '0')}.png`);
    if (!existsSync(imgPath)) throw new Error(`Imagem do slide não encontrada: ${imgPath}`);
    // Copiar imagem para o diretório do frame para referência relativa funcionar
    // (writeFrameHtml grava em <projectDir>/frames/, mesma pasta do HTML)
    const imgDest = join(projectDir, 'frames', `slide-${String(i + 1).padStart(2, '0')}.png`);
    await copyFile(imgPath, imgDest);
    await orchestrator.writeFrameHtml(
      project.id,
      slide.id,
      gerarFrameHtml(slide, imgDest, audios[i + 1].durationSec + SLIDE_PADDING_SEC),
    );
  }
  await orchestrator.writeFrameHtml(project.id, 'conclusao', gerarFrameOutro(outroImgName, audios[conclIdx].durationSec + SLIDE_PADDING_SEC));

  // 6. Narração como soundtrack do projeto
  const proj = await orchestrator.addFileAsset(project.id, narracaoFull, 'Narração completa');
  const asset = proj.assets[proj.assets.length - 1];
  proj.soundtrack = { narrationAssetId: asset.id, narrationVolumeDb: 0 };
  await projects.save(proj);

  // 7. Renderizar
  console.error('  renderizando frames (Chromium + ffmpeg) ...');
  const outputPath = join(outDir, `${slug}-${WIDTH}x${HEIGHT}.mp4`);
  await orchestrator.exportMp4({
    projectId: project.id,
    outputPath,
    onProgress: (pct, stage) => console.error(`  ${pct.toFixed(0)}% ${stage}`),
  });

  // 8. Mixar trilha sonora de fundo (opcional)
  if (TRILHA && existsSync(TRILHA)) {
    console.error(`  mixando trilha sonora (${basename(TRILHA)}) ...`);
    await mixarTrilha(outputPath, TRILHA);
  }

  console.error(`Vídeo concluído: ${outputPath}`);
  console.log(JSON.stringify({ output_path: outputPath, project_id: project.id }));
}

main().catch((e) => {
  console.error('ERRO:', e.message);
  if (e.stack) console.error(e.stack.split('\n').slice(0, 4).join('\n'));
  process.exit(1);
});
