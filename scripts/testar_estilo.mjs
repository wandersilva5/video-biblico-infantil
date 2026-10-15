// Teste A/B de estilo para o pipeline bíblico infantil:
//   Krea 2 Turbo  + LoRA "Pure-Pixar 3D | KREA 2 |" (trigger KR2Pix)
//   Z-Image Turbo + LoRA "Definitive Disney Studios" (trigger DisneyIZT)
// Gera as MESMAS 3 cenas bíblicas com os dois modelos, mede o tempo e grava
// em output/teste-estilo/{krea2,zimage}/NN-cena.png para comparação visual.
//
// Uso:
//   node scripts/testar_estilo.mjs           # roda os dois modelos
//   node scripts/testar_estilo.mjs krea2     # só Krea 2
//   node scripts/testar_estilo.mjs zimage    # só Z-Image
//
// Pré-requisitos:
//   - ComfyUI em http://127.0.0.1:8188 (env COMFY_URL sobrescreve)
//   - LoRAs baixados do Civitai (login necessário):
//       D:\ComfyUI_windows_portable\ComfyUI\models\loras\Krea2\purePixarStyle3D_v1.safetensors
//         -> https://civitai.com/models/2977241/pure-pixar-3d-krea-2
//       D:\ComfyUI_windows_portable\ComfyUI\models\loras\z-image\Disney_IZT_ATK_V1_000000750.safetensors
//         -> https://civitai.com/models/404277?modelVersionId=2494747

import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const COMFY_URL = process.env.COMFY_URL || 'http://127.0.0.1:8188';
const COMFY_OUTPUT_DIR = process.env.COMFY_OUTPUT_DIR || 'D:\\ComfyUI_windows_portable\\ComfyUI\\output';
const OUT_DIR = process.env.TESTE_DIR || join(process.cwd(), 'output', 'teste-estilo');

const LORA_KREA2 = 'Krea2\\purePixarStyle3D_v1.safetensors';
const LORA_ZIT = 'z-image\\Disney_IZT_ATK_V1_000000750.safetensors';
const LORA_KREA2_PATH = 'D:\\ComfyUI_windows_portable\\ComfyUI\\models\\loras\\Krea2\\purePixarStyle3D_v1.safetensors';
const LORA_ZIT_PATH = 'D:\\ComfyUI_windows_portable\\ComfyUI\\models\\loras\\z-image\\Disney_IZT_ATK_V1_000000750.safetensors';

// Triggers recomendados de cada LoRA (cfg=1.0 ignora negative → estilo no positivo).
const TRIGGER_KREA2 = 'KR2Pix';
const TRIGGER_ZIT = 'DisneyIZT, This image is a Disney-Pixar 3D animation style, featuring a stylized, cartoon character, high detailed, ultra 4k, masterpiece';

// Mesmas 3 cenas bíblicas infantis para os dois modelos (seed fixa = comparação justa).
const CENAS = [
  {
    slug: 'arca-noe',
    prompt:
      'a giant wooden ark floating on turquoise floodwaters, pairs of happy cartoon animals boarding two by two, baby giraffes and smiling elephants, bright sunny sky with fluffy clouds, joyful biblical scene for children',
  },
  {
    slug: 'davi-golias',
    prompt:
      'a young shepherd boy David with a simple sling facing a huge but not scary giant Goliath in shiny armor, green valley with sheep watching, dramatic yet child-friendly composition, warm afternoon light',
  },
  {
    slug: 'pao-e-peixes',
    prompt:
      'a kind gentle man with warm smile sharing five loaves of bread and two fishes with a crowd of happy children on a grassy hill, golden late-afternoon light, baskets overflowing, biblical miracle scene for children',
  },
];

const SEED = Number(process.env.TESTE_SEED) || 424242;
const LARGURA = 1152;
const ALTURA = 640;
const STYLES = 'children\'s animated film still, soft rounded character design, big expressive eyes, warm vibrant colors, cinematic but friendly';

// ---------------------------------------------------------------------------
// Workflows (formato API do ComfyUI)
// ---------------------------------------------------------------------------

// Krea 2 Turbo fp8 + LoRA Pixar: UNETLoader + CLIPLoader tipo krea2 + CLIPTextEncode.
// cfg=1.0 ignora o negative, então o estilo entra no positivo (igual ao pipeline).
// VAE = qwen_image_vae (blueprint oficial "Text to Image (Krea-2 Turbo)") — NÃO ae.safetensors,
// que é da FLUX e decodifica os latents do Krea2 como ruído.
function workflowKrea2(cena) {
  return {
    '1': { class_type: 'UNETLoader', inputs: { unet_name: 'Krea2\\krea2_turbo_fp8_scaled.safetensors', weight_dtype: 'default' } },
    '2': { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen\\qwen3vl_4b_fp8_scaled.safetensors', type: 'krea2' } },
    '3': { class_type: 'VAELoader', inputs: { vae_name: 'qwen_image_vae.safetensors' } },
    '4': {
      class_type: 'LoraLoader',
      inputs: { model: ['1', 0], clip: ['2', 0], lora_name: LORA_KREA2, strength_model: 1.0, strength_clip: 1.0 },
    },
    '5': {
      class_type: 'CLIPTextEncode',
      inputs: { clip: ['4', 1], text: `${TRIGGER_KREA2}, ${STYLES}, ${cena.prompt}, single continuous scene, no panel layout, no comic grid, no character sheet, no text, no letters, no watermark` },
    },
    '6': { class_type: 'CLIPTextEncode', inputs: { clip: ['4', 1], text: 'blurry, low quality, watermark, deformed, extra limbs' } },
    '7': { class_type: 'EmptyLatentImage', inputs: { width: LARGURA, height: ALTURA, batch_size: 1 } },
    '8': {
      class_type: 'KSampler',
      inputs: {
        model: ['4', 0], positive: ['5', 0], negative: ['6', 0], latent_image: ['7', 0],
        seed: SEED, steps: 8, cfg: 1.0, sampler_name: 'euler', scheduler: 'simple', denoise: 1.0,
      },
    },
    '9': { class_type: 'VAEDecode', inputs: { samples: ['8', 0], vae: ['3', 0] } },
    '10': { class_type: 'SaveImage', inputs: { images: ['9', 0], filename_prefix: 'teste_krea2_pixar' } },
  };
}

// Z-Image Turbo (GGUF Q4, cabe em 8GB) + LoRA ZIT. Receita do template oficial
// image_z_image_turbo: TE qwen3_4b_fp8 via CLIPLoader tipo lumina2, ModelSamplingAuraFlow
// shift=3, EmptySD3LatentImage, negative via ConditioningZeroOut (cfg=1).
// Sampler res_multistep/simple conforme blueprint oficial "Text to Image (Z-Image-Turbo)".
function workflowZImage(cena) {
  return {
    '1': { class_type: 'UnetLoaderGGUF', inputs: { unet_name: 'z-image\\z_image_turbo-Q4_K_M.gguf' } },
    '2': { class_type: 'CLIPLoader',       inputs: { clip_name: 'qwen\\qwen3_4b_fp8_scaled.safetensors', type: 'lumina2', device: 'cpu' } },
    '3': { class_type: 'VAELoader', inputs: { vae_name: 'ae.safetensors' } },
    '4': {
      class_type: 'LoraLoader',
      inputs: { model: ['1', 0], clip: ['2', 0], lora_name: LORA_ZIT, strength_model: 1.0, strength_clip: 1.0 },
    },
    '5': { class_type: 'ModelSamplingAuraFlow', inputs: { model: ['4', 0], shift: 3.0 } },
    '6': {
      class_type: 'CLIPTextEncode',
      inputs: { clip: ['4', 1], text: `${TRIGGER_ZIT}, ${STYLES}, ${cena.prompt}, single continuous scene, no panel layout, no comic grid, no character sheet, no text, no letters, no watermark` },
    },
    '7': { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['6', 0] } },
    '8': { class_type: 'EmptySD3LatentImage', inputs: { width: LARGURA, height: ALTURA, batch_size: 1 } },
    '9': {
      class_type: 'KSampler',
      inputs: {
        model: ['5', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['8', 0],
        seed: SEED, steps: 8, cfg: 1.0, sampler_name: 'res_multistep', scheduler: 'simple', denoise: 1.0,
      },
    },
    '10': { class_type: 'VAEDecode', inputs: { samples: ['9', 0], vae: ['3', 0] } },
    '11': { class_type: 'SaveImage', inputs: { images: ['10', 0], filename_prefix: 'teste_zimage_pixar' } },
  };
}

// ---------------------------------------------------------------------------
// Submissão / espera (mesmo contrato do gerar_imagens.mjs)
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function submeter(workflow) {
  const resp = await fetch(`${COMFY_URL}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: workflow }),
  });
  if (!resp.ok) throw new Error(`ComfyUI ${resp.status}: ${(await resp.text()).slice(0, 400)}`);
  return (await resp.json()).prompt_id;
}

async function aguardar(promptId, timeoutMs = 600000) {
  const inicio = Date.now();
  while (Date.now() - inicio < timeoutMs) {
    await sleep(2500);
    const hist = await (await fetch(`${COMFY_URL}/history/${promptId}`)).json();
    const entry = hist[promptId];
    if (!entry) continue;
    const status = entry.status?.status_str;
    if (status === 'error') {
      const msgs = entry.status?.messages || [];
      const err = msgs.find((m) => m[0] === 'execution_error');
      throw new Error('execução falhou: ' + JSON.stringify(err?.[1]?.exception_message || msgs).slice(0, 400));
    }
    if (status === 'success') {
      for (const node of Object.values(entry.outputs || {})) {
        for (const img of node.images || []) return img.filename;
      }
      throw new Error('sucesso sem imagem no output');
    }
  }
  throw new Error('timeout aguardando ComfyUI');
}

async function descarregarModelos() {
  try {
    await fetch(`${COMFY_URL}/free`, { method: 'POST', body: JSON.stringify({ unload_models: true, free_memory: true }) });
  } catch { /* ignora */ }
}

async function rodarModelo(nome, builder, loraPath, loraUrl) {
  if (!existsSync(loraPath)) {
    console.error(`\n[${nome}] LoRA ausente: ${loraPath}`);
    console.error(`  Baixe logado no Civitai: ${loraUrl}`);
    console.error(`  e salve exatamente nesse caminho (mesmo nome do arquivo).`);
    return null;
  }
  const dir = join(OUT_DIR, nome);
  await mkdir(dir, { recursive: true });
  const resultados = [];
  console.error(`\n=== ${nome}: ${CENAS.length} cenas (seed ${SEED}, ${LARGURA}x${ALTURA}) ===`);
  for (const cena of CENAS) {
    const t0 = Date.now();
    process.stderr.write(`  [${nome}] ${cena.slug} ... `);
    try {
      const promptId = await submeter(builder(cena));
      const filename = await aguardar(promptId);
      const src = join(COMFY_OUTPUT_DIR, filename);
      const dest = join(dir, `${cena.slug}.png`);
      await copyFile(src, dest);
      const seg = ((Date.now() - t0) / 1000).toFixed(1);
      console.error(`${seg}s -> ${dest}`);
      resultados.push({ cena: cena.slug, segundos: Number(seg), arquivo: dest });
    } catch (e) {
      console.error(`FALHOU: ${e.message}`);
      resultados.push({ cena: cena.slug, erro: e.message });
    }
  }
  await descarregarModelos();
  return resultados;
}

async function main() {
  const so = (process.argv[2] || '').toLowerCase();
  const rodarKrea2 = !so || so === 'krea2';
  const rodarZimage = !so || so === 'zimage' || so === 'z-image';

  try {
    const stats = await (await fetch(`${COMFY_URL}/system_stats`)).json();
    console.error(`ComfyUI ${stats.system?.comfyui_version || '?'} OK em ${COMFY_URL}`);
  } catch {
    console.error(`ERRO: ComfyUI não responde em ${COMFY_URL}. Inicie o servidor e rode de novo.`);
    process.exit(1);
  }

  await mkdir(OUT_DIR, { recursive: true });
  const relatorio = { inicio: new Date().toISOString(), seed: SEED, resolucao: `${LARGURA}x${ALTURA}` };

  if (rodarKrea2) {
    relatorio.krea2 = await rodarModelo('krea2', workflowKrea2, LORA_KREA2_PATH,
      'https://civitai.com/models/2977241/pure-pixar-3d-krea-2');
  }
  if (rodarZimage) {
    relatorio.zimage = await rodarModelo('zimage', workflowZImage, LORA_ZIT_PATH,
      'https://civitai.com/models/404277?modelVersionId=2494747');
  }

  const relPath = join(OUT_DIR, 'relatorio.json');
  await writeFile(relPath, JSON.stringify(relatorio, null, 2));
  console.error(`\nRelatório: ${relPath}`);
  console.error(`Imagens:   ${OUT_DIR}\\{krea2,zimage}\\`);
}

main().catch((e) => {
  console.error('ERRO:', e.message);
  process.exit(1);
});
