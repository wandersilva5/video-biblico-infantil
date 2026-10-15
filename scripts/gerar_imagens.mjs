import { readFile, mkdir, writeFile, copyFile, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const COMFY_URL = process.env.COMFY_URL || 'http://127.0.0.1:8188';
const COMFY_OUTPUT_DIR = process.env.COMFY_OUTPUT_DIR || 'D:\\ComfyUI_windows_portable\\ComfyUI\\output';

// Krea 2 Turbo (fp8) — modelo principal de geração de imagem (vencedor do teste
// A/B contra Z-Image + DisneyIZT: mais fidelidade Disney/Pixar, prompts
// respeitados, sem moldura preta). Receita do blueprint oficial
// "Text to Image (Krea-2 Turbo)": UNETLoader fp8 + CLIPLoader tipo krea2
// (qwen3vl_4b) + VAE qwen_image_vae + KSampler 8 passos euler/simple cfg 1.0.
// LoRA "Pure-Pixar 3D | KREA 2 |" (trigger KR2Pix) fixa o estilo — cfg=1.0
// ignora negative, então estilo e blindagens vivem no positivo. Em 8GB de VRAM
// o ComfyUI faz offload automático do UNET (12.5GB fp8) e do TE (4B fp8).
const KREA2_UNET = process.env.KREA2_UNET || 'Krea2\\krea2_turbo_fp8_scaled.safetensors';
const KREA2_CLIP = process.env.KREA2_CLIP || 'qwen\\qwen3vl_4b_fp8_scaled.safetensors';
const KREA2_CLIP_DEVICE = process.env.KREA2_CLIP_DEVICE || 'default';
const KREA2_VAE = process.env.KREA2_VAE || 'qwen_image_vae.safetensors';
// LoRA de estilo Pixar 3D. KREA2_LORA_FORCA=0 desliga.
const LORA_NAME = process.env.KREA2_LORA || 'Krea2\\purePixarStyle3D_v1.safetensors';
const STEPS = Number(process.env.KREA2_STEPS) || 8;
const LORA_STRENGTH =
  process.env.KREA2_LORA_FORCA !== undefined && process.env.KREA2_LORA_FORCA !== ''
    ? Number(process.env.KREA2_LORA_FORCA)
    : 1.0;
// Trigger do LoRA no início do prompt. KREA2_TRIGGER='' desliga.
const TRIGGER = process.env.KREA2_TRIGGER ?? 'KR2Pix';
const SEED_BASE = process.env.KREA2_SEED_BASE !== undefined && process.env.KREA2_SEED_BASE !== '' ? Number(process.env.KREA2_SEED_BASE) : 1000;
// Seed POR SLIDE (variedade de composição) é o padrão — a mesma seed em todas as
// cenas faz o modelo repetir quase a mesma imagem. SEED_POR_SLIDE=0 força seed
// única (só faz sentido se quiser máxima "consistência" entre slides).
const SEED_POR_SLIDE = process.env.SEED_POR_SLIDE !== '0';

// Formato das imagens: derivado de FORMATO (16:9 | 9:16) ou sobrescrito por
// IMAGEM_LARGURA/IMAGEM_ALTURA explícitos. Um formato por vez, nunca os dois.
const FORMATO = (process.env.FORMATO || '16:9').trim();
const IMAGEM_LARGURA = Number(process.env.IMAGEM_LARGURA) || (FORMATO === '9:16' ? 640 : 1152);
const IMAGEM_ALTURA = Number(process.env.IMAGEM_ALTURA) || (FORMATO === '9:16' ? 1152 : 640);

// Qualidade: por padrão gera DIRETO na resolução final (1152x640 / 640x1152 —
// múltiplos de 32), preservando muito mais detalhe no Krea 2. O caminho rápido
// em 2 passos (difusão em ~metade + upscale lanczos) fica opt-in com
// KREA2_UPSCALE=1 (combinável com KREA2_ESCALA_BASE, default 0.5).
const KREA2_UPSCALE = process.env.KREA2_UPSCALE === '1';
const ESCALA_BASE = Math.min(1, Math.max(0.25, Number(process.env.KREA2_ESCALA_BASE) || 0.5));
const LARGURA_BASE = KREA2_UPSCALE ? Math.round(IMAGEM_LARGURA * ESCALA_BASE / 16) * 16 : IMAGEM_LARGURA;
const ALTURA_BASE = KREA2_UPSCALE ? Math.round(IMAGEM_ALTURA * ESCALA_BASE / 16) * 16 : IMAGEM_ALTURA;

// Retry por imagem antes de desistir (uma imagem lenta/falha não derruba as demais).
const TENTATIVAS = Number(process.env.KREA2_TENTATIVAS) || 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function interromperComfyUI() {
  try {
    await fetch(`${COMFY_URL}/interrupt`, { method: 'POST' });
  } catch {
    /* ignora */
  }
}

// ---------------------------------------------------------------------------
// Progresso em tempo real do ComfyUI (websocket)
// ---------------------------------------------------------------------------
// O ComfyUI emite {"type":"progress","data":{value,max,prompt_id,node}} a cada
// passo do sampler — mas SÓ para o socket cujo clientId veio no POST /prompt,
// então a WS precisa usar o mesmo client_id. Sem isso a barra do navegador só
// se moveria a cada imagem (~2 min de intervalo), o que parece travada.
const WS_BASE = `${COMFY_URL.replace(/^http/i, 'ws')}/ws?clientId=`;

function criarMonitorProgresso() {
  const clientId = randomUUID();
  const ouvintes = new Set();
  let ws = null;
  let aberto = false;
  try {
    ws = new WebSocket(WS_BASE + clientId);
    ws.addEventListener('open', () => { aberto = true; });
    ws.addEventListener('message', (ev) => {
      if (typeof ev.data !== 'string') return; // previews são binários
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg?.type !== 'progress') return;
      const d = msg.data || {};
      if (!Number.isFinite(d.value) || !Number.isFinite(d.max) || d.max <= 0) return;
      for (const fn of ouvintes) fn(d);
    });
    ws.addEventListener('error', () => { /* sem WS cai no fallback por tempo */ });
  } catch {
    ws = null;
  }
  return {
    clientId,
    async aguardarAbertura(ms = 2000) {
      if (!ws) return false;
      const t0 = Date.now();
      while (!aberto && Date.now() - t0 < ms) await sleep(50);
      return aberto;
    },
    aoProgresso(fn) { ouvintes.add(fn); },
    fechar() {
      ouvintes.clear();
      try { ws?.close(); } catch { /* ignora */ }
    },
  };
}

// Imprime linhas de progresso para o servidor web (SSE). Retorna a função parar().
// baseIdx/total = posição da imagem no conjunto geral (intro, slides, outro),
// para o percentual global da barra. Entre um passo e outro do sampler estima o
// avanço pelo tempo decorrido, então a barra anda continuamente.
function acompanharComfyUI(monitor, { cabecalho, detalhe, baseIdx, total, inicio }) {
  let anterior = null;
  let atual = null;
  let ultimoPct = null;
  let ultimaAtualizacao = 0;

  const pctDe = (frac) =>
    Math.min(100, Math.max(0, Math.round(((baseIdx + frac) / total) * 1000) / 10));

  monitor.aoProgresso((d) => {
    anterior = atual;
    atual = { value: d.value, max: d.max, t: Date.now() };
    ultimaAtualizacao = atual.t;
  });

  console.error(`  [${cabecalho}] ${detalhe} · enviando ao ComfyUI (${pctDe(0)}%)`);

  const tick = setInterval(() => {
    if (!atual) return;
    const dur = anterior ? Math.max(500, atual.t - anterior.t) : 1500;
    const frac = Math.min(1, (atual.value + (Date.now() - atual.t) / dur) / atual.max);
    const pct = pctDe(frac);
    if (pct === ultimoPct) return;
    ultimoPct = pct;
    console.error(`  [${cabecalho}] ${detalhe} · passo ${atual.value}/${atual.max} (${pct}%)`);
  }, 1500);

  const hb = setInterval(() => {
    if (Date.now() - ultimaAtualizacao < 6000) return;
    const seg = Math.round((Date.now() - inicio) / 1000);
    console.error(`  [${cabecalho}] ${detalhe} ... aguardando ComfyUI (${seg}s) (${pctDe(0)}%)`);
  }, 15000);

  return () => {
    clearInterval(tick);
    clearInterval(hb);
  };
}

// Sufixo global de estilo — Disney/Pixar 3D (testado no A/B: LoRA purePixarStyle3D
// + Krea 2 Turbo). O estilo entra NO INÍCIO do prompt final (ver
// gerarImagemSlide), logo após o trigger do LoRA — no fim de um prompt longo o
// modelo o ignora. ESTILO_SUFIXO env sobrescreve completamente.
const ESTILO_SUFIXO =
  process.env.ESTILO_SUFIXO ||
  "children's animated film still in Disney-Pixar 3D animation style, soft rounded character design, big expressive eyes, warm vibrant colors, cinematic lighting, detailed stylized 3D render, family-friendly animated movie look";

// Prompts das artes de abertura (00-intro.png) e encerramento (outro.png).
// SEMPRE uma professora ensinando para crianças — mas composições DIFERENTES
// (intro: círculo de leitura; outro: aula encerrando, todo mundo acenando).
// O estilo global é pré-apendado automaticamente pelo gerarImagemSlide.
const PROMPT_INTRO =
  process.env.PROMPT_INTRO ||
  "a kind young woman teacher sitting in a cozy reading corner holding an open storybook, teaching a small group of happy children sitting cross-legged on a colorful rug, children listening with curious bright eyes, warm and welcoming scene";
const PROMPT_OUTRO =
  process.env.PROMPT_OUTRO ||
  "a kind young woman teacher standing beside a small chalkboard waving goodbye with a warm smile, a small group of happy children waving back and cheering with hands raised, joyful end-of-lesson scene with little stars and hearts floating";

// Prompt de uma arte de abertura/encerramento: vem do roteiro (introducao_imagem_prompt
// / conclusao_imagem_prompt). NÃO recebe o elenco bíblico (roteiro.personagens) —
// as artes mostram a professora com as crianças, e prependar o cast da história
// fazia o modelo desenhar Noé/Moisés/faraó junto da professora.
// Só cai nos PROMPT_INTRO/PROMPT_OUTRO fixos se o roteiro for antigo (sem o campo).
export function buildPromptArte(cenaBruta, fallback) {
  return limparCenaDoPrompt(cenaBruta) || fallback;
}

// Remove do imagem_prompt do roteiro o prefixo de estilo antigo (chibi/kawaii),
// frases 3D embutidas ("3D animation style" etc. — o estilo global governa) e o
// sufixo "no text...", deixando apenas a DESCRIÇÃO DA CENA. O estilo global e o
// sufixo anti-texto são apensados automaticamente no prompt final.
function limparCenaDoPrompt(bruto) {
  if (!bruto) return '';
  return bruto
    .replace(/^chibi style, kawaii, cute, adorable, big sparkling eyes, soft pastel colors, children's storybook illustration, simple clean background\.?\s*/i, '')
    .replace(/(?:,\s*)?(?:pixar\s+)?3d\s+(?:animation|animated|render(?:ing)?|style)(?:\s+style)?(?:,|\b(?=\s*(?:,|\.|$)))/gi, ',')
    .replace(/,\s*(?=,)/g, ',')
    .replace(/\.?\s*no text, no letters, no words, no captions, no speech bubbles\.?\s*$/i, '')
    .replace(/^,\s*|,\s*$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// Âncora de consistência: o roteiro descreve os personagens UMA vez
// (roteiro.personagens) e essa descrição entra no início de TODOS os prompts,
// para que o mesmo personagem apareça com a mesma aparência em todas as cenas.
// Single-image-safe: a âncora antiga ("identical characters, same faces ... in
// every scene") pedia VÁRIOS personagens idênticos — dentro de UMA imagem o
// modelo desenhava clones do mesmo personagem na mesma cena.
const PERSONAGENS_ANCORA =
  'each character appears exactly once, consistent character design, no duplicate characters, no clones, no copies of the same character';

// Prompt da imagem: descreve a CENA da história (estilo Disney/Pixar 3D é
// aplicado depois, via trigger + ESTILO_SUFIXO), a partir do imagem_prompt do
// roteiro. Fallback: título + narração quando não houver descrição.
// O bloco Characters declara a aparência UMA vez e a cena cita os personagens
// APENAS pelo nome (regra do gerar_roteiro) — descrever a mesma pessoa com
// palavras diferentes em dois blocos fazia o modelo desenhar um clone na cena.
export function buildPromptImagem(slide, roteiro) {
  const cena = limparCenaDoPrompt(slide.imagem_prompt);
  const personagens = limparCenaDoPrompt(slide.personagens || roteiro?.personagens || '');
  if (!personagens) return cena || `children's storybook scene of ${slide.titulo}. ${slide.narracao}`.slice(0, 300);
  const partes = [`Characters in this scene — the ONLY people in the image, each appearing exactly once (the scene below refers to these same individuals, not additional copies): ${personagens}`, cena || `scene: ${slide.titulo}. ${slide.narracao}`];
  partes.push(PERSONAGENS_ANCORA);
  return partes.filter(Boolean).join('; ');
}

// Workflow Krea 2 Turbo como API (blueprint oficial "Text to Image (Krea-2 Turbo)").
// Fluxo: [1] UNETLoader → [4] LoraLoader → [8] KSampler
// [2] CLIPLoader tipo krea2 → [4]
// [3] VAELoader (qwen_image_vae) → [9]
// [5] CLIPTextEncode (positivo) → [6] ConditioningZeroOut (negativo zerado:
//     cfg=1.0 ignora o negative, então estilo e blindagens estão no positivo)
// [7] EmptyLatentImage → [8]
// [8] KSampler euler/simple → [9] VAEDecode → [10] ImageScale → [11] SaveImage
// ATENÇÃO: o VAE do Krea 2 é qwen_image_vae — NÃO ae.safetensors (FLUX), que
// decodifica os latents do Krea2 como ruído cinzento.
const WORKFLOW_TEMPLATE = {
  "1": { class_type: "UNETLoader", inputs: { unet_name: "__UNET__", weight_dtype: "default" } },
  "2": { class_type: "CLIPLoader", inputs: { clip_name: "__CLIP__", type: "krea2", device: "__CLIP_DEVICE__" } },
  "3": { class_type: "VAELoader", inputs: { vae_name: "__VAE__" } },
  "4": { class_type: "LoraLoader", inputs: { model: ["1", 0], clip: ["2", 0], lora_name: "__LORA__", strength_model: "__LORA_STRENGTH__", strength_clip: "__LORA_STRENGTH__" } },
  "5": { class_type: "CLIPTextEncode", inputs: { clip: ["4", 1], text: "__POSITIVE__" } },
  "6": { class_type: "ConditioningZeroOut", inputs: { conditioning: ["5", 0] } },
  "7": { class_type: "EmptyLatentImage", inputs: { width: "__LARGURA_BASE__", height: "__ALTURA_BASE__", batch_size: 1 } },
  "8": { class_type: "KSampler", inputs: { model: ["4", 0], positive: ["5", 0], negative: ["6", 0], latent_image: ["7", 0], seed: "__SEED__", steps: "__STEPS__", cfg: 1.0, sampler_name: "euler", scheduler: "simple", denoise: 1.0 } },
  "9": { class_type: "VAEDecode", inputs: { samples: ["8", 0], vae: ["3", 0] } },
  "10": { class_type: "ImageScale", inputs: { image: ["9", 0], upscale_method: "lanczos", width: "__LARGURA__", height: "__ALTURA__", crop: "disabled" } },
  "11": { class_type: "SaveImage", inputs: { images: ["10", 0], filename_prefix: "historinha_slide" } },
};

async function submeterPrompt(workflow, clientId) {
  const corpo = { prompt: workflow };
  if (clientId) corpo.client_id = clientId;
  const resp = await fetch(`${COMFY_URL}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(corpo),
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`ComfyUI erro ${resp.status}: ${err.slice(0, 500)}`);
  }
  return (await resp.json()).prompt_id;
}

// Tempo máximo de espera por imagem. O Krea 2 Turbo (fp8, com offload em 8GB
// de VRAM) leva ~1–2 min por imagem, então o default é generoso (COMFY_TIMEOUT).
const COMFY_TIMEOUT = Number(process.env.COMFY_TIMEOUT) || 900000;

async function aguardarExecucao(promptId, timeoutMs = COMFY_TIMEOUT) {
  const inicio = Date.now();
  while (Date.now() - inicio < timeoutMs) {
    await new Promise((r) => setTimeout(r, 3000));
    const resp = await fetch(`${COMFY_URL}/history/${promptId}`);
    const hist = await resp.json();
    const entry = hist[promptId];
    if (!entry) continue;
    const status = entry.status?.status_str;
    if (status === 'error') {
      const msgs = entry.status?.messages || [];
      const err = msgs.find((m) => m[0] === 'execution_error');
      throw new Error('ComfyUI execução falhou: ' + JSON.stringify(err?.[1]?.exception_message || msgs).slice(0, 500));
    }
    if (status === 'success') {
      const outputs = entry.outputs || {};
      const files = [];
      for (const node of Object.values(outputs)) {
        for (const out of node.images || []) files.push(out.filename);
        for (const out of node.gifs || []) files.push(out.filename);
      }
      return files;
    }
  }
  throw new Error('Timeout aguardando ComfyUI');
}

export async function gerarImagemSlide(prompt, seed = 42, monitor = null) {
  const workflow = structuredClone(WORKFLOW_TEMPLATE);
  // Resolução base (difusão) e final (upscale lanczos)
  workflow['1'].inputs.unet_name = KREA2_UNET;
  workflow['2'].inputs.clip_name = KREA2_CLIP;
  workflow['2'].inputs.device = KREA2_CLIP_DEVICE;
  workflow['3'].inputs.vae_name = KREA2_VAE;
  workflow['4'].inputs.lora_name = LORA_NAME;
  workflow['4'].inputs.strength_model = LORA_STRENGTH;
  workflow['4'].inputs.strength_clip = LORA_STRENGTH;
  workflow['7'].inputs.width = LARGURA_BASE;
  workflow['7'].inputs.height = ALTURA_BASE;
  workflow['10'].inputs.width = IMAGEM_LARGURA;
  workflow['10'].inputs.height = IMAGEM_ALTURA;
  workflow['8'].inputs.steps = STEPS;
  workflow['8'].inputs.seed = seed;
  // Trigger do LoRA + estilo PRIMEIRO (no fim de prompt longo o modelo ignora);
  // depois a cena + personagens; blindagem anti-grade ("character sheet"),
  // anti-duplicação (cfg=1.0 zera o negativo, então os vetos são todos positivos)
  // e sufixo anti-texto por último.
  const prefixo = TRIGGER ? `${TRIGGER}, ` : '';
  workflow['5'].inputs.text = `${prefixo}${ESTILO_SUFIXO}. Scene: ${prompt}, single continuous scene, no panel layout, no comic grid, no multiple views, no character sheet, no duplicate characters, no clones, no copies of the same character, no text, no letters, no words, no captions, no speech bubbles`;
  const promptId = await submeterPrompt(workflow, monitor?.clientId);
  const files = await aguardarExecucao(promptId);
  const file = files[0];
  if (!file) throw new Error('ComfyUI não retornou arquivos');
  return join(COMFY_OUTPUT_DIR, file);
}

// opts.apenas = id de UM slide: só essa imagem é gerada (nenhuma outra, nem as
// artes) — é o caminho do botão "🖼 gerar"/"↻ refazer" da tela do projeto. Sem
// opts, gera todas as que faltarem. O rótulo "imagem X/Y" e a seed continuam
// usando o índice GLOBAL do slide; o percentual da barra cobre só o job atual
// quando for `apenas`.
export async function gerarImagensSlides(slides, outDir, roteiro, opts = {}) {
  const apenas = opts.apenas || null;
  const imagens = [];
  const falhas = [];
  const n = slides.length;
  const totalItens = n + 2; // intro + slides + conclusão
  const alvos = slides
    .map((slide, i) => ({ slide, i }))
    .filter(({ slide }) => !apenas || slide.id === apenas);
  if (apenas && !alvos.length) throw new Error(`Slide "${apenas}" não encontrado no roteiro`);
  for (const { slide, i } of alvos) {
    const dest = join(outDir, `slide-${String(i + 1).padStart(2, '0')}.png`);
    if (existsSync(dest)) {
      console.error(`  [imagem ${i + 1}/${n}] ${slide.titulo} (já existe, pulando)`);
      imagens.push({ id: slide.id, path: dest });
      continue;
    }
    // Seed própria por slide (SEED_POR_SLIDE, padrão) — a mesma seed em todas as
    // cenas faz o modelo repetir quase a mesma imagem. SEED_POR_SLIDE=0 usa a
    // mesma seed no conjunto inteiro.
    const seed = SEED_POR_SLIDE ? SEED_BASE + i * 137 : SEED_BASE;
    const inicioImg = Date.now();
    let feito = false;
    for (let t = 1; t <= TENTATIVAS && !feito; t++) {
      const monitor = criarMonitorProgresso();
      const parar = acompanharComfyUI(monitor, {
        cabecalho: `imagem ${i + 1}/${n}`,
        detalhe: slide.titulo,
        baseIdx: apenas ? 0 : i + 1,
        total: apenas ? 1 : totalItens,
        inicio: inicioImg,
      });
      try {
        await monitor.aguardarAbertura();
        const src = await gerarImagemSlide(buildPromptImagem(slide, roteiro), seed, monitor);
        await copyFile(src, dest);
        imagens.push({ id: slide.id, path: dest });
        console.error(`  OK: ${dest}`);
        feito = true;
      } catch (e) {
        console.error(`  [imagem ${i + 1}/${n}] tentativa ${t}/${TENTATIVAS} falhou: ${e.message}`);
        await interromperComfyUI();
        if (t < TENTATIVAS) {
          console.error(`  [imagem ${i + 1}/${n}] aguardando 5s e tentando de novo ...`);
          await sleep(5000);
        }
      } finally {
        parar();
        monitor.fechar();
      }
    }
    if (!feito) falhas.push({ id: slide.id, titulo: slide.titulo });
  }
  if (falhas.length) {
    const resumo = falhas.map((f) => `${f.id} (${f.titulo})`).join(', ');
    throw new Error(`Falha ao gerar ${falhas.length} imagem(ns) após ${TENTATIVAS} tentativas: ${resumo}`);
  }
  return imagens;
}

// Gera UMA imagem de arte (abertura/encerramento) com o mesmo fluxo dos slides:
// pula se já existe, tenta até TENTATIVAS, interrompe o ComfyUI antes de retry.
// Falha aqui NÃO derruba a etapa — vira aviso (o montar_video tem fallback).
// pos/total = posição da arte no conjunto geral, para o percentual global.
async function gerarImagemArte(prompt, dest, seed, rotulo, pos, total) {
  if (existsSync(dest)) {
    console.error(`  [arte] ${rotulo} (já existe, pulando)`);
    return dest;
  }
  const inicioImg = Date.now();
  let feito = false;
  for (let t = 1; t <= TENTATIVAS && !feito; t++) {
    const monitor = criarMonitorProgresso();
    const parar = acompanharComfyUI(monitor, {
      cabecalho: `arte ${pos + 1}/${total}`,
      detalhe: rotulo,
      baseIdx: pos,
      total,
      inicio: inicioImg,
    });
    try {
      await monitor.aguardarAbertura();
      const src = await gerarImagemSlide(prompt, seed, monitor);
      await copyFile(src, dest);
      console.error(`  OK: ${dest}`);
      feito = true;
    } catch (e) {
      console.error(`  [arte] ${rotulo} tentativa ${t}/${TENTATIVAS} falhou: ${e.message}`);
      await interromperComfyUI();
      if (t < TENTATIVAS) {
        console.error(`  [arte] ${rotulo} aguardando 5s e tentando de novo ...`);
        await sleep(5000);
      }
    } finally {
      parar();
      monitor.fechar();
    }
  }
  if (!feito) console.error(`  [arte] ATENÇÃO: não foi possível gerar ${rotulo} (usará fallback no vídeo)`);
  return dest;
}

async function main() {
  const roteiroPath = process.argv[2];
  if (!roteiroPath) {
    console.error('Uso: node gerar_imagens.mjs <caminho/roteiro.json> [--arte <intro|conclusao>] [--apenas <slideId>]');
    process.exit(1);
  }
  const roteiro = JSON.parse(await readFile(roteiroPath, 'utf8'));
  const outDir = dirname(roteiroPath);
  const totalItens = roteiro.slides.length + 2;

  // --arte <intro|conclusao>: regenera só uma arte de abertura/encerramento
  const iArte = process.argv.indexOf('--arte');
  const arteSolo = iArte !== -1 ? process.argv[iArte + 1] : null;
  if (arteSolo) {
    const ehIntro = arteSolo === 'intro';
    const dest = join(outDir, ehIntro ? '00-intro.png' : 'outro.png');
    if (existsSync(dest)) await unlink(dest); // regerar: apaga o PNG antes
    console.error(`[2/4] Gerando arte de ${ehIntro ? 'abertura' : 'encerramento'} ...`);
    await gerarImagemArte(
      buildPromptArte(ehIntro ? roteiro.introducao_imagem_prompt : roteiro.conclusao_imagem_prompt, ehIntro ? PROMPT_INTRO : PROMPT_OUTRO),
      dest, SEED_BASE + (ehIntro ? 900001 : 900002), ehIntro ? 'abertura' : 'encerramento',
      ehIntro ? 0 : totalItens - 1, totalItens,
    );
    console.log(JSON.stringify([]));
    return;
  }

  // --apenas <slideId>: gera SÓ essa imagem (nenhum outro slide pendente, nem as
  // artes). O servidor web usa isso no botão "🖼 gerar"/"↻ refazer" de um bloco;
  // sem a flag o script continua gerando tudo que faltar.
  const iApenas = process.argv.indexOf('--apenas');
  const apenasId = iApenas !== -1 ? process.argv[iApenas + 1] : null;
  if (apenasId) {
    if (!roteiro.slides.some((s) => s.id === apenasId)) {
      console.error(`ERRO: slide "${apenasId}" não encontrado no roteiro`);
      process.exit(1);
    }
    console.error(`[2/4] Gerando imagem do slide ${apenasId} ...`);
    const imagens = await gerarImagensSlides(roteiro.slides, outDir, roteiro, { apenas: apenasId });
    console.log(JSON.stringify(imagens));
    return;
  }

  console.error(`[2/4] Gerando ${roteiro.slides.length} imagens ...`);
  const imagens = await gerarImagensSlides(roteiro.slides, outDir, roteiro);
  console.error('  Gerando imagem de abertura (a partir do roteiro) ...');
  await gerarImagemArte(
    buildPromptArte(roteiro.introducao_imagem_prompt, PROMPT_INTRO),
    join(outDir, '00-intro.png'), SEED_BASE + 900001, 'abertura', 0, totalItens,
  );
  console.error('  Gerando imagem de encerramento (a partir do roteiro) ...');
  await gerarImagemArte(
    buildPromptArte(roteiro.conclusao_imagem_prompt, PROMPT_OUTRO),
    join(outDir, 'outro.png'), SEED_BASE + 900002, 'encerramento', totalItens - 1, totalItens,
  );
  console.log(JSON.stringify(imagens));
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
