import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { verificarEtapa } from './verificar_servicos.mjs';

const execFileAsync = promisify(execFile);
const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const MONTA_VIDEO = join(SCRIPTS_DIR, 'montar_video.mjs');

async function checar(etapa) {
  const { ok, msg } = await verificarEtapa(etapa);
  if (!ok) {
    console.error(`ERRO [pré-requisito ${etapa}]: ${msg}`);
    process.exit(1);
  }
  console.log(`[ok] ${msg}`);
}

async function rodarNode(script, args) {
  const { stdout, stderr } = await execFileAsync(process.execPath, [join(SCRIPTS_DIR, script), ...args], {
    maxBuffer: 1024 * 1024 * 32,
  });
  return stdout.trim();
}

async function rodarNodeAbs(script, args) {
  const { stdout, stderr } = await execFileAsync(process.execPath, [script, ...args], {
    maxBuffer: 1024 * 1024 * 32,
    cwd: SCRIPTS_DIR,
  });
  return stdout.trim();
}

async function main() {
  const topico = process.argv[2];
  if (!topico) {
    console.error('Uso: node pipeline.mjs "Nome da história bíblica"');
    console.error('');
    console.error('Variáveis opcionais:');
    console.error('  LLAMA_URL  - URL do llama-server (default http://127.0.0.1:8091)');
    console.error('  VOZ        - voz do edge-tts (default pt-BR-FranciscaNeural)');
    console.error('  FORMATO    - formato do vídeo/imagens: 16:9 (default) ou 9:16');
    console.error('  PULAR_ROTEIRO=1  - pula a geração do roteiro (usa roteiro.json existente)');
    process.exit(1);
  }

  const slug = topico
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  const outDir = join(SCRIPTS_DIR, '..', 'output', slug);
  const roteiroPath = join(outDir, 'roteiro.json');

  // Etapa 1: Roteiro
  await checar('roteiro');
  if (process.env.PULAR_ROTEIRO === '1' && existsSync(roteiroPath)) {
    console.log('[1/4] Roteiro já existe, pulando.');
  } else {
    console.log(`[1/4] Gerando roteiro para: ${topico}`);
    await rodarNode('gerar_roteiro.mjs', [topico]);
  }

  // Etapa 2: Imagens (ComfyUI)
  await checar('imagens');
  const imagensOk = await rodarNode('gerar_imagens.mjs', [roteiroPath]);
  console.log(`[2/4] ${JSON.parse(imagensOk).length} imagens geradas.`);

  // Etapa 3: Narração (edge-tts)
  await checar('narracao');
  const narracaoOk = await rodarNode('gerar_narracao.mjs', [roteiroPath]);
  console.log(`[3/4] ${JSON.parse(narracaoOk).length} arquivos de narração gerados.`);

  // Etapa 4: Vídeo (html-video)
  await checar('video');
  console.log('[4/4] Montando vídeo ...');
  const result = await rodarNodeAbs(MONTA_VIDEO, [roteiroPath]);
  const parsed = JSON.parse(result);
  console.log(`\n=== CONCLUÍDO ===`);
  console.log(`História: ${topico}`);
  console.log(`Vídeo: ${parsed.output_path}`);
}

main().catch((e) => {
  console.error('ERRO:', e.message);
  process.exit(1);
});
