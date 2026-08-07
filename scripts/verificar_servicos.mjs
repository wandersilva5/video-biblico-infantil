import { spawn } from 'node:child_process';

function rodaComando(cmd, args, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let done = false;
    const proc = spawn(cmd, args, { stdio: 'ignore' });
    const t = setTimeout(() => {
      done = true;
      proc.kill();
      resolve(false);
    }, timeoutMs);
    proc.on('error', () => {
      if (!done) {
        done = true;
        clearTimeout(t);
        resolve(false);
      }
    });
    proc.on('exit', (code) => {
      if (!done) {
        done = true;
        clearTimeout(t);
        resolve(code === 0);
      }
    });
  });
}

async function checarHttp(url, timeoutMs = 5000) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const r = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    return r.ok;
  } catch {
    return false;
  }
}

export async function verificarServico(nome, cfg = {}) {
  const LLAMA_URL = cfg.LLAMA_URL || 'http://127.0.0.1:8091';
  const COMFY_URL = cfg.COMFY_URL || 'http://127.0.0.1:8188';
  switch (nome) {
    case 'llama':
      return checarHttp(`${LLAMA_URL}/health`).then((ok) => ({
        ok,
        msg: ok ? `llama-server OK (${LLAMA_URL})` : `llama-server fora do ar em ${LLAMA_URL}. Rode iniciar.bat ou inicie o llama-server.`,
      }));
    case 'comfy':
      return checarHttp(`${COMFY_URL}/system_stats`).then((ok) => ({
        ok,
        msg: ok ? `ComfyUI OK (${COMFY_URL})` : `ComfyUI fora do ar em ${COMFY_URL}. Rode iniciar.bat ou inicie o ComfyUI.`,
      }));
    case 'edge-tts':
      return rodaComando('edge-tts', ['--version']).then((ok) => ({
        ok,
        msg: ok ? 'edge-tts OK' : 'edge-tts não encontrado no PATH (necessário para a narração).',
      }));
    case 'ffmpeg':
      return Promise.all([rodaComando('ffmpeg', ['-version']), rodaComando('ffprobe', ['-version'])]).then(
        ([a, b]) => ({
          ok: a && b,
          msg: a && b ? 'ffmpeg/ffprobe OK' : 'ffmpeg/ffprobe não encontrados no PATH (necessário para o vídeo).',
        }),
      );
    case 'qwen-tts':
      return (async () => {
        const { join } = await import('node:path');
        const { existsSync } = await import('node:fs');
        const root = cfg.QWEN_ROOT || 'E:/llama.cpp/qwen3-tts-gguf';
        const modelo = join(root, cfg.QWEN_MODEL || 'model-base');
        const ref = cfg.QWEN_REF || join(process.cwd(), 'voz-base', 'Bia-Pascoa.wav');
        const py = await rodaComando(cfg.QWEN_PYTHON || 'python', ['--version']);
        const ok = py && existsSync(modelo) && existsSync(ref);
        return {
          ok,
          msg: ok
            ? `Qwen3-TTS OK (modelo em ${modelo})`
            : `Qwen3-TTS não está pronto: python=${py ? 'OK' : 'FALTA'}, modelo=${existsSync(modelo) ? 'OK' : 'FALTA'}, ref=${existsSync(ref) ? 'OK' : 'FALTA'}`,
        };
      })();
    default:
      return { ok: false, msg: `Serviço desconhecido: ${nome}` };
  }
}

/** Serviço exigido por cada etapa do pipeline. */
export function servicoDaEtapa(etapa, cfg = {}) {
  if (etapa === 'narracao') return cfg.TTS === 'qwen' ? 'qwen-tts' : 'edge-tts';
  return etapa === 'roteiro' ? 'llama' : etapa === 'imagens' ? 'comfy' : 'ffmpeg';
}

export async function verificarEtapa(etapa, cfg = {}) {
  return verificarServico(servicoDaEtapa(etapa, cfg), cfg);
}
