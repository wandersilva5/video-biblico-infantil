"""
Bridge Qwen3-TTS (clone de voz) para o pipeline video-bibico-infantil.

Uso (via node gerar_narracao.mjs com TTS=qwen):

    QWEN_ROOT=E:/llama.cpp/qwen3-tts-gguf \
    QWEN_REF=T:/caminho/voz-base/Bia-Pascoa.wav \
    QWEN_REF_TEXTO="Olá Amiguinhos! Hoje iremos contar..." \
    python scripts/qwen_tts_bridge.py --texto "..." --saida out.wav

Recebe o texto por --texto (ou env TEXTO), gera o WAV 24kHz mono normalizado
e finaliza o processo de forma limpa (termina os workers do decoder).
"""

import argparse
import os
import sys
import time
import numpy as np
import wave

QWEN_ROOT = os.environ.get("QWEN_ROOT", r"E:\llama.cpp\qwen3-tts-gguf")
sys.path.insert(0, QWEN_ROOT)

from qwen3_tts_gguf.inference import TTSEngine, TTSConfig

SAMPLE_RATE = 24000


def save_wav_normalized(path, audio, sample_rate=SAMPLE_RATE, target_peak=0.9):
    peak = np.max(np.abs(audio)) if len(audio) else 0.0
    if peak > 1e-6:
        audio = audio * (target_peak / peak)
    pcm = np.clip(audio * 32767.0, -32768, 32767).astype(np.int16)
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(pcm.tobytes())


def cortar_trecho(wav_path, inicio_s, fim_s):
    """Corta um trecho [inicio_s, fim_s] do WAV de referência (sem alterar o original)."""
    w = wave.open(wav_path, "rb")
    sr = w.getframerate()
    frames = w.readframes(w.getnframes())
    ch = w.getnchannels()
    sw = w.getsampwidth()
    w.close()
    n = len(frames) // (ch * sw)
    start = max(0, int(inicio_s * sr))
    end = min(n, int(fim_s * sr))
    b0 = start * ch * sw
    b1 = end * ch * sw
    seg = frames[b0:b1]
    out_path = os.path.join(os.environ.get("TEMP", "."), "qwen_ref_tmp.wav")
    out = wave.open(out_path, "wb")
    out.setnchannels(ch)
    out.setsampwidth(sw)
    out.setframerate(sr)
    out.writeframes(seg)
    out.close()
    return out_path


def hard_shutdown(engine):
    d = engine.decoder
    for p in (d.decoder_proc, d.play_proc):
        try:
            if p and p.is_alive():
                p.terminate()
        except Exception:
            pass
    try:
        d.stop_listener = True
    except Exception:
        pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--texto", default=os.environ.get("TEXTO", ""))
    ap.add_argument("--saida", default=os.environ.get("SAIDA", ""))
    args = ap.parse_args()

    texto = args.texto
    saida = args.saida
    if not texto or not saida:
        print("ERRO: --texto e --saida são obrigatórios", flush=True)
        sys.exit(1)

    ref_wav = os.environ.get("QWEN_REF", "")
    ref_texto = os.environ.get("QWEN_REF_TEXTO", "")
    model_dir = os.path.join(QWEN_ROOT, os.environ.get("QWEN_MODEL", "model-base"))
    inicio = float(os.environ.get("QWEN_REF_START", "2.9"))
    fim = float(os.environ.get("QWEN_REF_END", "17.9"))
    max_steps = int(os.environ.get("QWEN_MAX_STEPS", "300"))
    temperatura = float(os.environ.get("QWEN_TEMP", "0.6"))
    zero_shot = os.environ.get("QWEN_ZERO_SHOT", "0") == "1"

    if not ref_wav or not ref_texto:
        print("ERRO: QWEN_REF e QWEN_REF_TEXTO são obrigatórios", flush=True)
        sys.exit(1)

    ref = cortar_trecho(ref_wav, inicio, fim) if os.path.exists(ref_wav) else ref_wav
    print(f"[qwen] engine model_dir={model_dir}", flush=True)
    engine = TTSEngine(model_dir=model_dir, onnx_provider=os.environ.get("QWEN_ONNX_PROVIDER", "CUDA"))
    if not engine.ready:
        print("ERRO: engine não inicializou", flush=True)
        sys.exit(1)
    stream = engine.create_stream()

    ok = stream.set_voice(ref, ref_texto)
    print(f"[qwen] set_voice ok={bool(ok)}", flush=True)
    if not ok:
        hard_shutdown(engine)
        print("ERRO: set_voice falhou", flush=True)
        sys.exit(1)

    config = TTSConfig(
        max_steps=max_steps,
        temperature=temperatura,
        sub_temperature=temperatura,
        seed=int(os.environ.get("QWEN_SEED", "42")),
        sub_seed=int(os.environ.get("QWEN_SUB_SEED", "45")),
        streaming=False,
    )
    t0 = time.time()
    result = stream.clone(text=texto, language="portuguese", zero_shot=zero_shot, config=config)
    print(f"[qwen] clone {time.time() - t0:.1f}s | audio None={result is None or result.audio is None}", flush=True)
    if result is None or result.audio is None:
        hard_shutdown(engine)
        print("ERRO: síntese falhou (sem áudio)", flush=True)
        sys.exit(1)

    save_wav_normalized(saida, result.audio)
    print(f"[qwen] WAV salvo: {saida} ({len(result.audio) / SAMPLE_RATE:.1f}s)", flush=True)

    hard_shutdown(engine)
    print("[qwen] encerrado", flush=True)
    os._exit(0)


if __name__ == "__main__":
    main()
