import { readFile, mkdir, writeFile, copyFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const COMFY_URL = process.env.COMFY_URL || 'http://127.0.0.1:8188';
const COMFY_OUTPUT_DIR = process.env.COMFY_OUTPUT_DIR || 'D:\\ComfyUI_windows_portable\\ComfyUI\\output';

const ZIMAGE_UNET = process.env.ZIMAGE_UNET || 'z-image\\z_image_turbo-Q4_K_M.gguf';
const ZIMAGE_CLIP = process.env.ZIMAGE_CLIP || 'qwen\\qwen3_4b_fp8_scaled.safetensors';
const ZIMAGE_VAE = process.env.ZIMAGE_VAE || 'FLUX-Anime-VAE-B2.safetensors';
const LORA_NAME = process.env.ZIMAGE_LORA || 'z-image\\z-image-anime-01.safetensors';
// Steps e força do LoRA configuráveis para benchmark (ZIMAGE_LORA_STRENGTH=0 desliga o LoRA).
const STEPS = Number(process.env.ZIMAGE_STEPS) || 9;
const LORA_STRENGTH = Number(process.env.ZIMAGE_LORA_STRENGTH) || 0.8;
const SEED_BASE = process.env.KREA2_SEED_BASE !== undefined && process.env.KREA2_SEED_BASE !== '' ? Number(process.env.KREA2_SEED_BASE) : 1000;

// Formato das imagens: derivado de FORMATO (16:9 | 9:16) ou sobrescrito por
// IMAGEM_LARGURA/IMAGEM_ALTURA explícitos. Um formato por vez, nunca os dois.
const FORMATO = (process.env.FORMATO || '16:9').trim();
const IMAGEM_LARGURA = Number(process.env.IMAGEM_LARGURA) || (FORMATO === '9:16' ? 640 : 1152);
const IMAGEM_ALTURA = Number(process.env.IMAGEM_ALTURA) || (FORMATO === '9:16' ? 1152 : 640);

// Upscale em 2 passos para acelerar: difusão numa resolução base menor (¼ dos pixels)
// e depois upscale lanczos para a resolução final. Z-Image Turbo renderiza rápido em
// 512–768px; gerar direto em 1152x640/640x1152 é o que tornava cada imagem ~4–5min na
// RTX 3060 Ti. Desligue com ZIMAGE_UPSCALE=0 (gera direto na resolução final).
const ZIMAGE_UPSCALE = process.env.ZIMAGE_UPSCALE !== '0';
const LARGURA_BASE = ZIMAGE_UPSCALE ? Math.round(IMAGEM_LARGURA / 2 / 16) * 16 : IMAGEM_LARGURA;
const ALTURA_BASE = ZIMAGE_UPSCALE ? Math.round(IMAGEM_ALTURA / 2 / 16) * 16 : IMAGEM_ALTURA;

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

// Sufixo global de estilo — sempre apensado ao prompt (estilo bíblia infantil).
const ESTILO_SUFIXO =
  process.env.ESTILO_SUFIXO ||
  'children\'s Bible storybook illustration, warm soft colors, gentle light, cute friendly characters, simple clean composition';

// Prompts das artes de abertura (00-intro.png) e encerramento (outro.png).
// São ilustrações infantis que combinam com o estilo das imagens dos slides.
const PROMPT_INTRO =
  process.env.PROMPT_INTRO ||
  'A sweet kind woman storyteller with a warm smile holding an open children\'s Bible storybook in her hands, cute and friendly, a couple of happy little children listening nearby, she stands on one side of the frame and the other side has a simple soft colorful background with plenty of empty space';
const PROMPT_OUTRO =
  process.env.PROMPT_OUTRO ||
  'A cute happy child hugging a children\'s Bible storybook, joyful cozy ending scene, a couple of little stars and hearts floating around, warm soft colors, gentle light, simple clean composition';

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

// Prompt da imagem: descreve a CENA da história (estilo bíblia infantil), a partir do
// imagem_prompt do roteiro. Fallback: título + narração quando não houver descrição.
export function buildPromptImagem(slide) {
  const cena = limparCenaDoPrompt(slide.imagem_prompt);
  if (cena) return cena;
  return `illustration of ${slide.titulo}. ${slide.narracao}`.slice(0, 300);
}

// Replica o workflow "Z-Image Turbo.json" do usuário:
// UnetLoaderGGUFAdvanced (z_image_turbo-Q4_K_M) + CLIPLoader lumina2 (Qwen3-4B)
// + LoRA z-image-anime + ModelSamplingAuraFlow + VAE FLUX-Anime + 9 passos.
// Obs.: usa UnetLoaderGGUFAdvanced/CLIPLoader (safetensors) porque o custom node
// ComfyUI-GGUF-FantasyTalking sobrescreve UnetLoaderGGUF/CLIPLoaderGGUF com
// retornos quebrados (WANVIDEOMODEL e lista de arquiteturas antiga).
const NEGATIVE_PROMPT = 'low resolution, bad anatomy, bad hands, text, letters, words, captions, speech bubble, logo, error, missing fingers, extra digit, fewer digits, worst quality, low quality, normal quality, jpeg artifacts, signature, watermark, username, blurry, artist name, cropped, out of frame, long neck, deformed, lowres';

const WORKFLOW_TEMPLATE = {
  "1": { class_type: "UnetLoaderGGUFAdvanced", inputs: { unet_name: "__UNET__", dequant_dtype: "default", patch_dtype: "default", patch_on_device: true } },
  "2": { class_type: "LoraLoaderModelOnly", inputs: { model: ["1", 0], lora_name: "__LORA__", strength_model: "__LORA_STRENGTH__" } },
  "3": { class_type: "ModelSamplingAuraFlow", inputs: { model: ["2", 0], shift: 7 } },
  "4": { class_type: "CLIPLoader", inputs: { clip_name: "__CLIP__", type: "lumina2" } },
  "5": { class_type: "CLIPTextEncode", inputs: { clip: ["4", 0], text: "__POSITIVE__" } },
  "6": { class_type: "CLIPTextEncode", inputs: { clip: ["4", 0], text: NEGATIVE_PROMPT } },
  "7": { class_type: "EmptySD3LatentImage", inputs: { width: "__LARGURA_BASE__", height: "__ALTURA_BASE__", batch_size: 1 } },
  "8": { class_type: "KSampler", inputs: { model: ["3", 0], positive: ["5", 0], negative: ["6", 0], latent_image: ["7", 0], seed: "__SEED__", steps: "__STEPS__", cfg: 1.0, sampler_name: "euler", scheduler: "normal", denoise: 1.0 } },
  "9": { class_type: "VAELoader", inputs: { vae_name: "__VAE__" } },
  "10": { class_type: "VAEDecode", inputs: { samples: ["8", 0], vae: ["9", 0] } },
  "12": { class_type: "ImageScale", inputs: { image: ["10", 0], upscale_method: "lanczos", width: "__LARGURA__", height: "__ALTURA__", crop: "disabled" } },
  "11": { class_type: "SaveImage", inputs: { images: ["12", 0], filename_prefix: "historinha_slide" } },
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

const COMFY_TIMEOUT = Number(process.env.COMFY_TIMEOUT) || 600000;

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
  workflow['1'].inputs.unet_name = ZIMAGE_UNET;
  workflow['2'].inputs.lora_name = LORA_NAME;
  workflow['2'].inputs.strength_model = LORA_STRENGTH;
  workflow['4'].inputs.clip_name = ZIMAGE_CLIP;
  workflow['9'].inputs.vae_name = ZIMAGE_VAE;
  workflow['7'].inputs.width = LARGURA_BASE;
  workflow['7'].inputs.height = ALTURA_BASE;
  workflow['12'].inputs.width = IMAGEM_LARGURA;
  workflow['12'].inputs.height = IMAGEM_ALTURA;
  workflow['8'].inputs.steps = STEPS;
  workflow['5'].inputs.text = `${prompt}, ${ESTILO_SUFIXO}, no text, no letters, no words, no captions, no speech bubbles`;
  workflow['8'].inputs.seed = seed;
  const promptId = await submeterPrompt(workflow);
  const files = await aguardarExecucao(promptId);
  const file = files[0];
  if (!file) throw new Error('ComfyUI não retornou arquivos');
  return join(COMFY_OUTPUT_DIR, file);
}

export async function gerarImagensSlides(slides, outDir) {
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
    const seed = SEED_BASE + i * 137;
    console.error(`  [imagem ${i + 1}/${slides.length}] ${slide.titulo} ...`);
    const inicioImg = Date.now();
    const hb = setInterval(() => {
      console.error(`  [imagem ${i + 1}/${slides.length}] ${slide.titulo} ... aguardando ComfyUI (${Math.round((Date.now() - inicioImg) / 1000)}s)`);
    }, 15000);
    let feito = false;
    for (let t = 1; t <= ZIMAGE_TENTATIVAS && !feito; t++) {
      try {
        const src = await gerarImagemSlide(buildPromptImagem(slide), seed);
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
  const imagens = await gerarImagensSlides(roteiro.slides, outDir);
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
