import { readFile, mkdir, writeFile, copyFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const COMFY_URL = process.env.COMFY_URL || 'http://127.0.0.1:8188';
const COMFY_OUTPUT_DIR = process.env.COMFY_OUTPUT_DIR || 'D:\\ComfyUI_windows_portable\\ComfyUI\\output';

// Qwen-image 2.1 (GGUF) — modelo principal de geração de imagem.
// O text encoder oficial (qwen3vl_8b_int8_convrot, ~8.9GB) NÃO cabe junto com o
// UNET (5.1GB) na VRAM de 8GB da RTX 3060 Ti: carregar os dois na GPU derruba o
// ComfyUI. Por isso o CLIP roda na CPU por padrão (QWEN_CLIP_DEVICE=cpu) — o
// encode é uma vez por imagem e o custo é pequeno. Use 'default' só se tiver
// VRAM de sobra.
const QWEN_UNET = process.env.ZIMAGE_UNET || 'qwen\\qwen-image-2.1-Q5_K_M.gguf';
const QWEN_CLIP = process.env.ZIMAGE_CLIP || 'qwen3vl_8b_int8_convrot.safetensors';
const QWEN_CLIP_DEVICE = process.env.QWEN_CLIP_DEVICE || 'cpu';
const QWEN_VAE = process.env.ZIMAGE_VAE || 'qwen_image_2.1_vae_bf16.safetensors';
// LoRA de velocidade: 8 passos para o Qwen-image 2.1. ZIMAGE_LORA_STRENGTH=0 desliga.
const LORA_NAME = process.env.ZIMAGE_LORA || 'qwen\\p_qwen_image_2.1_8step_v0.1.safetensors';
const STEPS = Number(process.env.ZIMAGE_STEPS) || 8;
const LORA_STRENGTH = Number(process.env.ZIMAGE_LORA_STRENGTH) !== 0 ? (Number(process.env.ZIMAGE_LORA_STRENGTH) || 1.0) : 0;
const SEED_BASE = process.env.KREA2_SEED_BASE !== undefined && process.env.KREA2_SEED_BASE !== '' ? Number(process.env.KREA2_SEED_BASE) : 1000;
// Seed única para todas as cenas (consistência) ou uma por slide.
const SEED_POR_SLIDE = process.env.SEED_POR_SLIDE === '1';

// Formato das imagens: derivado de FORMATO (16:9 | 9:16) ou sobrescrito por
// IMAGEM_LARGURA/IMAGEM_ALTURA explícitos. Um formato por vez, nunca os dois.
const FORMATO = (process.env.FORMATO || '16:9').trim();
const IMAGEM_LARGURA = Number(process.env.IMAGEM_LARGURA) || (FORMATO === '9:16' ? 640 : 1152);
const IMAGEM_ALTURA = Number(process.env.IMAGEM_ALTURA) || (FORMATO === '9:16' ? 1152 : 640);

// Upscale em 2 passos para acelerar: difusão numa resolução base menor
// (ZIMAGE_ESCALA_BASE da final, default metade) e depois upscale lanczos para a
// resolução final. O Qwen-image 2.1 aguenta resolução nativa e 1152x640/640x1152
// já são múltiplos de 32 — se sua aguentar o tempo, ZIMAGE_ESCALA_BASE=1 (ou
// ZIMAGE_UPSCALE=0) gera direto na resolução final e preserva muito mais detalhe.
// ZIMAGE_UPSCALE=0 continua valendo como atalho para "gerar na resolução final".
const ZIMAGE_UPSCALE = process.env.ZIMAGE_UPSCALE !== '0';
const ESCALA_BASE = Math.min(1, Math.max(0.25, Number(process.env.ZIMAGE_ESCALA_BASE) || 0.5));
const LARGURA_BASE = ZIMAGE_UPSCALE ? Math.round(IMAGEM_LARGURA * ESCALA_BASE / 16) * 16 : IMAGEM_LARGURA;
const ALTURA_BASE = ZIMAGE_UPSCALE ? Math.round(IMAGEM_ALTURA * ESCALA_BASE / 16) * 16 : IMAGEM_ALTURA;

// Retry por imagem antes de desistir (uma imagem lenta/falha não derruba as demais).
const ZIMAGE_TENTATIVAS = Number(process.env.ZIMAGE_TENTATIVAS) || 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function interromperComfyUI() {
  try {
    await fetch(`${COMFY_URL}/interrupt`, { method: 'POST' });
  } catch {
    /* ignora */
  }
}

// Sufixo global de estilo — Pixar 3D com personagens consistentes.
// ESTILO_SUFIXO env sobrescreve completamente.
const ESTILO_SUFIXO =
  process.env.ESTILO_SUFIXO ||
  'Pixar 3D animation style, high quality 3D render, vibrant colors, expressive cartoon characters with big eyes, soft studio lighting, cinematic composition, friendly and warm atmosphere, children animated movie aesthetic, consistent character design';

// Prompts das artes de abertura (00-intro.png) e encerramento (outro.png).
const PROMPT_INTRO =
  process.env.PROMPT_INTRO ||
  'A warm and friendly 3D animated storyteller woman with a gentle smile, holding an open colorful children Bible storybook, Pixar 3D animation style, two happy little children sitting nearby listening with big curious eyes, soft studio lighting, vibrant warm colors, cozy and welcoming scene';
const PROMPT_OUTRO =
  process.env.PROMPT_OUTRO ||
  'A cute happy 3D animated child hugging a colorful children Bible storybook, Pixar animation style, joyful ending scene with little sparkling stars and glowing hearts floating around, warm golden light, vibrant colors, soft bokeh background';

// Remove do imagem_prompt do roteiro o prefixo de estilo antigo (chibi/kawaii) e o
// sufixo "no text...", deixando apenas a DESCRIÇÃO DA CENA. O estilo global e o
// sufixo anti-texto são apensados automaticamente no prompt final.
function limparCenaDoPrompt(bruto) {
  if (!bruto) return '';
  return bruto
    .replace(/^chibi style, kawaii, cute, adorable, big sparkling eyes, soft pastel colors, children's storybook illustration, simple clean background\.?\s*/i, '')
    .replace(/\.?\s*no text, no letters, no words, no captions, no speech bubbles\.?\s*$/i, '')
    .trim();
}

// Âncora de consistência: o roteiro descreve os personagens UMA vez
// (roteiro.personagens) e essa descrição entra no início de TODOS os prompts,
// para que o mesmo personagem apareça com a mesma aparência em todas as cenas.
const PERSONAGENS_ANCORA =
  'identical characters, same faces, same hairstyles, same outfits, same character designs in every scene';

// Prompt da imagem: descreve a CENA da história (estilo Pixar 3D), a partir do
// imagem_prompt do roteiro. Fallback: título + narração quando não houver descrição.
export function buildPromptImagem(slide, roteiro) {
  const cena = limparCenaDoPrompt(slide.imagem_prompt);
  const personagens = limparCenaDoPrompt(slide.personagens || roteiro?.personagens || '');
  if (!personagens) return cena || `3D animated movie scene of ${slide.titulo}. ${slide.narracao}`.slice(0, 300);
  const partes = [`Characters: ${personagens}`, cena || `scene: ${slide.titulo}. ${slide.narracao}`];
  partes.push(PERSONAGENS_ANCORA);
  return partes.filter(Boolean).join('; ');
}

// Workflow Qwen-image 2.1 (GGUF):
// UnetLoaderGGUF (GGUF quantizado) + CLIPLoader tipo qwen_image + LoraLoader
// + TextEncodeQwenImage21 (node específico com negative embutido) + KSampler 8 passos.
// O TextEncodeQwenImage21 aceita prompt, negative_prompt e resolution num único node;
// retorna positive + negative condicionings e latent opcional (não usado aqui).
const NEGATIVE_PROMPT = 'low quality, low resolution, blurry, jpeg artifacts, text, letters, words, captions, speech bubble, logo, watermark, signature, bad anatomy, bad hands, extra fingers, missing fingers, deformed, ugly, distorted face, inconsistent style, multiple styles, flat 2D illustration, anime flat, sketch, pencil drawing';

// Workflow Qwen-image 2.1 como API (sem UI nodes). Fluxo:
// [1] UnetLoaderGGUF → [2] LoraLoader (model+clip) → [3] KSampler
// [4] CLIPLoader → [2]
// [5] TextEncodeQwenImage21 → positive/negative em [3]
// [6] EmptyLatentImage → [3]
// [7] VAELoader → [8] VAEDecode → [9] ImageScale → [10] SaveImage
const WORKFLOW_TEMPLATE = {
  "1": { class_type: "UnetLoaderGGUF", inputs: { unet_name: "__UNET__" } },
  "4": { class_type: "CLIPLoader", inputs: { clip_name: "__CLIP__", type: "qwen_image", device: "__CLIP_DEVICE__" } },
  "2": { class_type: "LoraLoader", inputs: { model: ["1", 0], clip: ["4", 0], lora_name: "__LORA__", strength_model: "__LORA_STRENGTH__", strength_clip: "__LORA_STRENGTH__" } },
  "5": { class_type: "TextEncodeQwenImage21", inputs: { clip: ["2", 1], vae: ["7", 0], prompt: "__POSITIVE__", negative_prompt: "__NEGATIVE__", resolution: "__RESOLUCAO__" } },
  "6": { class_type: "EmptyLatentImage", inputs: { width: "__LARGURA_BASE__", height: "__ALTURA_BASE__", batch_size: 1 } },
  "3": { class_type: "KSampler", inputs: { model: ["2", 0], positive: ["5", 0], negative: ["5", 1], latent_image: ["6", 0], seed: "__SEED__", steps: "__STEPS__", cfg: 1.0, sampler_name: "euler", scheduler: "simple", denoise: 1.0 } },
  "7": { class_type: "VAELoader", inputs: { vae_name: "__VAE__" } },
  "8": { class_type: "VAEDecode", inputs: { samples: ["3", 0], vae: ["7", 0] } },
  "9": { class_type: "ImageScale", inputs: { image: ["8", 0], upscale_method: "lanczos", width: "__LARGURA__", height: "__ALTURA__", crop: "disabled" } },
  "10": { class_type: "SaveImage", inputs: { images: ["9", 0], filename_prefix: "historinha_slide" } },
};

async function submeterPrompt(workflow) {
  const resp = await fetch(`${COMFY_URL}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: workflow }),
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`ComfyUI erro ${resp.status}: ${err.slice(0, 500)}`);
  }
  return (await resp.json()).prompt_id;
}

// Tempo máximo de espera por imagem. O Qwen-image 2.1 (GGUF) pode levar alguns
// minutos por imagem em placas de 8GB, então o default é generoso (COMFY_TIMEOUT).
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

export async function gerarImagemSlide(prompt, seed = 42) {
  const workflow = structuredClone(WORKFLOW_TEMPLATE);
  // Resolução base (difusão) e final (upscale lanczos)
  const resolucaoBase = Math.max(LARGURA_BASE, ALTURA_BASE);
  workflow['1'].inputs.unet_name = QWEN_UNET;
  workflow['4'].inputs.clip_name = QWEN_CLIP;
  workflow['4'].inputs.device = QWEN_CLIP_DEVICE;
  workflow['2'].inputs.lora_name = LORA_NAME;
  workflow['2'].inputs.strength_model = LORA_STRENGTH;
  workflow['2'].inputs.strength_clip = LORA_STRENGTH;
  workflow['7'].inputs.vae_name = QWEN_VAE;
  workflow['6'].inputs.width = LARGURA_BASE;
  workflow['6'].inputs.height = ALTURA_BASE;
  workflow['9'].inputs.width = IMAGEM_LARGURA;
  workflow['9'].inputs.height = IMAGEM_ALTURA;
  workflow['3'].inputs.steps = STEPS;
  workflow['3'].inputs.seed = seed;
  // TextEncodeQwenImage21: prompt completo com estilo, negativo e resolução base
  workflow['5'].inputs.prompt = `${prompt}, ${ESTILO_SUFIXO}, no text, no letters, no words, no captions, no speech bubbles`;
  workflow['5'].inputs.negative_prompt = NEGATIVE_PROMPT;
  workflow['5'].inputs.resolution = resolucaoBase;
  const promptId = await submeterPrompt(workflow);
  const files = await aguardarExecucao(promptId);
  const file = files[0];
  if (!file) throw new Error('ComfyUI não retornou arquivos');
  return join(COMFY_OUTPUT_DIR, file);
}

export async function gerarImagensSlides(slides, outDir, roteiro) {
  const imagens = [];
  const falhas = [];
  for (let i = 0; i < slides.length; i++) {
    const slide = slides[i];
    const dest = join(outDir, `slide-${String(i + 1).padStart(2, '0')}.png`);
    if (existsSync(dest)) {
      console.error(`  [imagem ${i + 1}/${slides.length}] ${slide.titulo} (já existe, pulando)`);
      imagens.push({ id: slide.id, path: dest });
      continue;
    }
    // Seed: por padrão a MESMA em todas as cenas — seed fixa ajuda o modelo a
    // manter o mesmo "desenho" entre os slides (personagens consistentes).
    // SEED_POR_SLIDE=1 volta ao comportamento antigo (uma seed por slide).
    const seed = SEED_POR_SLIDE ? SEED_BASE + i * 137 : SEED_BASE;
    console.error(`  [imagem ${i + 1}/${slides.length}] ${slide.titulo} ...`);
    const inicioImg = Date.now();
    const hb = setInterval(() => {
      console.error(`  [imagem ${i + 1}/${slides.length}] ${slide.titulo} ... aguardando ComfyUI (${Math.round((Date.now() - inicioImg) / 1000)}s)`);
    }, 15000);
    let feito = false;
    for (let t = 1; t <= ZIMAGE_TENTATIVAS && !feito; t++) {
      try {
        const src = await gerarImagemSlide(buildPromptImagem(slide, roteiro), seed);
        await copyFile(src, dest);
        imagens.push({ id: slide.id, path: dest });
        console.error(`  OK: ${dest}`);
        feito = true;
      } catch (e) {
        console.error(`  [imagem ${i + 1}/${slides.length}] tentativa ${t}/${ZIMAGE_TENTATIVAS} falhou: ${e.message}`);
        await interromperComfyUI();
        if (t < ZIMAGE_TENTATIVAS) {
          console.error(`  [imagem ${i + 1}/${slides.length}] aguardando 5s e tentando de novo ...`);
          await sleep(5000);
        }
      }
    }
    clearInterval(hb);
    if (!feito) falhas.push({ id: slide.id, titulo: slide.titulo });
  }
  if (falhas.length) {
    const resumo = falhas.map((f) => `${f.id} (${f.titulo})`).join(', ');
    throw new Error(`Falha ao gerar ${falhas.length} imagem(ns) após ${ZIMAGE_TENTATIVAS} tentativas: ${resumo}`);
  }
  return imagens;
}

// Gera UMA imagem de arte (abertura/encerramento) com o mesmo fluxo dos slides:
// pula se já existe, tenta até ZIMAGE_TENTATIVAS, interrompe o ComfyUI antes de retry.
// Falha aqui NÃO derruba a etapa — vira aviso (o montar_video tem fallback).
async function gerarImagemArte(prompt, dest, seed, rotulo) {
  if (existsSync(dest)) {
    console.error(`  [imagem] ${rotulo} (já existe, pulando)`);
    return dest;
  }
  console.error(`  [imagem] ${rotulo} ...`);
  const inicioImg = Date.now();
  const hb = setInterval(() => {
    console.error(`  [imagem] ${rotulo} ... aguardando ComfyUI (${Math.round((Date.now() - inicioImg) / 1000)}s)`);
  }, 15000);
  let feito = false;
  for (let t = 1; t <= ZIMAGE_TENTATIVAS && !feito; t++) {
    try {
      const src = await gerarImagemSlide(prompt, seed);
      await copyFile(src, dest);
      console.error(`  OK: ${dest}`);
      feito = true;
    } catch (e) {
      console.error(`  [imagem] ${rotulo} tentativa ${t}/${ZIMAGE_TENTATIVAS} falhou: ${e.message}`);
      await interromperComfyUI();
      if (t < ZIMAGE_TENTATIVAS) {
        console.error(`  [imagem] ${rotulo} aguardando 5s e tentando de novo ...`);
        await sleep(5000);
      }
    }
  }
  clearInterval(hb);
  if (!feito) console.error(`  [imagem] ATENÇÃO: não foi possível gerar ${rotulo} (usará fallback no vídeo)`);
  return dest;
}

async function main() {
  const roteiroPath = process.argv[2];
  if (!roteiroPath) {
    console.error('Uso: node gerar_imagens.mjs <caminho/roteiro.json>');
    process.exit(1);
  }
  const roteiro = JSON.parse(await readFile(roteiroPath, 'utf8'));
  const outDir = dirname(roteiroPath);
  console.error(`[2/4] Gerando ${roteiro.slides.length} imagens ...`);
  const imagens = await gerarImagensSlides(roteiro.slides, outDir, roteiro);
  console.error('  Gerando imagem de abertura (mulher com a Bíblia infantil) ...');
  await gerarImagemArte(PROMPT_INTRO, join(outDir, '00-intro.png'), SEED_BASE + 900001, 'abertura');
  console.error('  Gerando imagem de encerramento ...');
  await gerarImagemArte(PROMPT_OUTRO, join(outDir, 'outro.png'), SEED_BASE + 900002, 'encerramento');
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
