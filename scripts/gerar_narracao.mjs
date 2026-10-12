import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const TTS = process.env.TTS || 'edge-tts';
const VOZ = process.env.VOZ || 'pt-BR-FranciscaNeural';
// Padrão mais rápido e levemente mais agudo: dá o tom empolgado de historinha.
// Volte ao neutro com VOZ_RATE=+0% (e VOZ_PITCH=+0Hz).
const VOZ_RATE = process.env.VOZ_RATE || '+8%';
const VOZ_PITCH = process.env.VOZ_PITCH || '+0Hz';

// Qwen3-TTS (clone de voz local). Padrões apontam para a voz-base do projeto.
const QWEN_ROOT = process.env.QWEN_ROOT || 'E:/llama.cpp/qwen3-tts-gguf';
const QWEN_PYTHON = process.env.QWEN_PYTHON || 'python';
const QWEN_REF = process.env.QWEN_REF || join(process.cwd(), 'voz-base', 'Bia-Pascoa.wav');
const QWEN_REF_START = process.env.QWEN_REF_START || '0';
const QWEN_REF_END = process.env.QWEN_REF_END || '16.5';
const QWEN_REF_TEXTO =
  process.env.QWEN_REF_TEXTO ||
  'Olá Amiguinhos! Hoje iremos contar a história de Bia, que estava muito animada, porque a Páscoa estava chegando. ' +
    'Bia não parava de pensar nos chocolates que iria ganhar. Ela imaginava ovos grandes, coloridos e cheios de doce.';
const QWEN_MAX_STEPS = process.env.QWEN_MAX_STEPS || '300';
const QWEN_TEMP = process.env.QWEN_TEMP || '0.6';

const hashDe = (t) => createHash('sha1').update(t ?? '').digest('hex');

async function lerManifesto(outDir) {
  try {
    return JSON.parse(await readFile(join(outDir, 'manifesto.json'), 'utf8'));
  } catch {
    return { audio: {}, imagem: {} };
  }
}

async function salvarManifesto(outDir, manifest) {
  await writeFile(join(outDir, 'manifesto.json'), JSON.stringify(manifest, null, 2), 'utf8');
}

const ORDINAIS_LIVROS = { '1': 'Primeira', '2': 'Segunda', '3': 'Terceira' };

/**
 * Normaliza o texto para o leitor de voz (edge-tts) pronunciar referências
 * bíblicas corretamente:
 *   - "1 Timóteo 3:1"  -> "Primeira Timóteo 3, 1"
 *   - "João 3:16"      -> "João 3, 16"
 *   - "1 Cor 13:4-7"   -> "Primeira Coríntios 13, 4 a 7"
 * Sem isso o TTS lê "1 Timóteo 3 horas e 1 minuto".
 */
export function normalizarReferenciasParaTts(texto) {
  return String(texto ?? '')
    // Numeral do livro -> ordinal (somente antes de nome de livro bíblico)
    .replace(
      /\b([123])\s+(Timóteo|Coríntios|Tessalonicenses|Pedro|João|Joao|Reis|Crônicas|Cronicas|Samuel|Esdras|Macabeus)\b/gi,
      (_, n, livro) => `${ORDINAIS_LIVROS[n]} ${livro}`,
    )
    // capítulo:versículo (com faixa opcional) -> capítulo, versículo
    .replace(/\b(\d{1,3}):(\d{1,3})(?:\s*-\s*(\d{1,3}))?\b/g, (_, c, v, f) =>
      f ? `${c}, ${v} a ${f}` : `${c}, ${v}`,
    );
}

function tts(texto, outPath) {
  return new Promise((resolve, reject) => {
    const args = ['--voice', VOZ, '--rate', VOZ_RATE];
    if (VOZ_PITCH) args.push('--pitch', VOZ_PITCH);
    args.push('--text', texto, '--write-media', outPath);
    const proc = spawn('edge-tts', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let err = '';
    proc.stderr.on('data', (d) => (err += d.toString()));
    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (code === 0) resolve(outPath);
      else reject(new Error(`edge-tts exit ${code}: ${err.slice(0, 300)}`));
    });
  });
}

/** Roda o bridge Python do Qwen3-TTS (gera WAV 24kHz) e converte para MP3. */
function ttsQwen(texto, outMp3) {
  return new Promise(async (resolve, reject) => {
    const wavTmp = outMp3.replace(/\.mp3$/, '.tmp.wav');
    const args = [
      join(dirname(fileURLToPath(import.meta.url)), 'qwen_tts_bridge.py'),
      '--texto', texto,
      '--saida', wavTmp,
    ];
    const env = { ...process.env, QWEN_ROOT, QWEN_REF, QWEN_REF_START, QWEN_REF_END, QWEN_REF_TEXTO, QWEN_MAX_STEPS, QWEN_TEMP };
    const proc = spawn(QWEN_PYTHON, args, { stdio: ['ignore', 'pipe', 'pipe'], env });
    let log = '';
    proc.stdout.on('data', (d) => (log += d.toString()));
    proc.stderr.on('data', (d) => (log += d.toString()));
    proc.on('error', reject);
    proc.on('exit', async (code) => {
      try {
        if (code !== 0) throw new Error(`qwen bridge exit ${code}: ${log.slice(0, 500)}`);
        await new Promise((res, rej) => {
          const ff = spawn('ffmpeg', ['-y', '-i', wavTmp, '-codec:a', 'libmp3lame', '-b:a', '128k', outMp3], {
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          let ferr = '';
          ff.stderr.on('data', (d) => (ferr += d.toString()));
          ff.on('error', rej);
          ff.on('exit', (c) => (c === 0 ? res() : rej(new Error(`ffmpeg exit ${c}: ${ferr.slice(0, 300)}`))));
        });
        resolve(outMp3);
      } catch (e) {
        reject(e);
      }
    });
  });
}

/** Nomes de arquivo esperados pelo montar_video.mjs. */
export function prefixoNarracao(index, total) {
  if (index === 0) return '00-intro';
  if (index === total - 1) return `${String(total - 1).padStart(2, '0')}-conclusao`;
  return String(index).padStart(2, '0');
}

/** Gera o MP3 de um único item (intro, slide ou conclusão). */
export async function gerarNarracaoItem(item, outDir) {
  const outPath = join(outDir, `${item.prefix}-narracao.mp3`);
  console.error(`  [narração] ${item.titulo} ...`);
  const texto = normalizarReferenciasParaTts(item.texto);
  if (TTS === 'qwen') {
    await ttsQwen(texto, outPath);
  } else {
    await tts(texto, outPath);
  }
  console.error(`  OK: ${outPath}`);
  return { id: item.id, titulo: item.titulo, path: outPath };
}

export async function gerarNarracao(roteiro, outDir) {
  const narracao = [];
  const textos = [
    { id: 'intro', titulo: 'Introdução', texto: roteiro.introducao },
    ...roteiro.slides.map((s) => ({ id: s.id, titulo: s.titulo, texto: s.narracao })),
    { id: 'conclusao', titulo: 'Conclusão', texto: roteiro.conclusao },
  ];
  const total = textos.length;
  for (let i = 0; i < textos.length; i++) {
    const item = { ...textos[i], prefix: prefixoNarracao(i, total) };
    console.error(`  [narração ${i + 1}/${total}] ${item.titulo} ...`);
    narracao.push(await gerarNarracaoItem(item, outDir));
  }
  return narracao;
}

async function main() {
  const roteiroPath = process.argv[2];
  if (!roteiroPath) {
    console.error('Uso: node gerar_narracao.mjs <caminho/roteiro.json> [--apenas <id>]');
    console.error('  --apenas <id>  regenera forçado só um item: intro, slide-01..., conclusao');
    console.error('  FORCAR=1        regenera todos, ignorando o manifesto (default: pula texto inalterado)');
    process.exit(1);
  }
  const apenasIdx = process.argv.indexOf('--apenas');
  const apenas = apenasIdx !== -1 ? process.argv[apenasIdx + 1] : null;
  const roteiro = JSON.parse(await readFile(roteiroPath, 'utf8'));
  const outDir = dirname(roteiroPath);
  const textos = [
    { id: 'intro', titulo: 'Introdução', texto: roteiro.introducao },
    ...roteiro.slides.map((s) => ({ id: s.id, titulo: s.titulo, texto: s.narracao })),
    { id: 'conclusao', titulo: 'Conclusão', texto: roteiro.conclusao },
  ];
  const total = textos.length;
  let items = textos.map((t, i) => ({ ...t, prefix: prefixoNarracao(i, total) }));
  if (apenas) {
    items = items.filter((t) => t.id === apenas);
    if (items.length === 0) {
      console.error(`ERRO: item "${apenas}" não encontrado (use: intro, slide-XX ou conclusao)`);
      process.exit(1);
    }
  }
  // Skip por manifesto: MP3 é reutilizado quando o texto não mudou. --apenas e
  // FORCAR=1 forçam a regeneração (custo TTS) mesmo sem alteração de texto.
  const forcar = apenas !== null || process.env.FORCAR === '1';
  const manifest = await lerManifesto(outDir);
  console.error(`[3/4] Gerando ${items.length} arquivo(s) de narração ...`);
  const narracao = [];
  for (const item of items) {
    const hash = hashDe(item.texto);
    const mp3 = join(outDir, `${item.prefix}-narracao.mp3`);
    if (!forcar && manifest.audio?.[item.id] === hash && existsSync(mp3)) {
      console.error(`  [narração] ${item.titulo} (texto inalterado, mantendo MP3)`);
      narracao.push({ id: item.id, titulo: item.titulo, path: mp3, pulado: true });
      continue;
    }
    const res = await gerarNarracaoItem(item, outDir);
    manifest.audio[item.id] = hash;
    narracao.push(res);
  }
  await salvarManifesto(outDir, manifest);
  console.log(JSON.stringify(narracao));
}

if (process.argv[1]) {
  const scriptPath = fileURLToPath(import.meta.url).replace(/\\/g, '/');
  const argPath = process.argv[1].replace(/\\/g, '/');
  if (scriptPath === argPath) {
    main().catch((e) => {
      console.error('ERRO:', e.message);
      process.exit(1);
    });
  }
}
