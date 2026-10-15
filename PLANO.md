# Plano — Estúdio de Histórinhas Bíblicas Infantis

> Plano aprovado. O objetivo é adaptar o pipeline `F:\codigos\videoaulas-teologia`
> (videoaulas de teologia narradas) em um novo projeto em `F:\codigos\002`
> focado em **vídeos de histórias bíblicas infantis**.

## Decisões confirmadas

- **Destino:** novo projeto em `F:\codigos\002`; original permanece intacto.
- **Voz feminina pt-BR:** `pt-BR-FranciscaNeural` (default do `edge-tts`).
- **Duração:** curta — ~8 a 10 slides (3–6 min); narrações de ~35–50 palavras.
- **Formatos:** 16:9 e 9:16, **um formato por vez** (ao trocar, regenerar as imagens na proporção do outro formato).
- **Regra de formato:** ao gerar o vídeo, **sempre e somente o formato escolhido — nunca os dois**. O formato escolhido (`FORMATO`) define a proporção das imagens E a resolução padrão do vídeo; o nome do MP4 embute a resolução, mas cada história é gerada em um único formato por vez.
- **Marca:** "Histórias Bíblicas Infantis" (intro, rodapé dos slides, outro).
- **Interface web:** mantida como está (apenas defaults/knobs novos no servidor).

## Como o projeto-fonte funciona

Pipeline local de 4 etapas encadeadas, cada uma consumindo a anterior:

1. `gerar_roteiro.mjs` — llama-server (OpenAI-compatible, `LLAMA_URL`) com um
   `SYSTEM_PROMPT`; gera o `roteiro.json` (≥15 slides).
2. `gerar_imagens.mjs` — ComfyUI (workflow Krea 2 Turbo + LoRA Pixar 3D, estilo Disney/Pixar 3D, personagens consistentes, uma cena por slide) salva
   `slide-NN.png`; pula imagens existentes.
3. `gerar_narracao.mjs` — CLI `edge-tts` gera os MP3s (voz default masculina).
4. `montar_video.mjs` — html-video core (Chromium + ffmpeg) renderiza o MP4,
   com frames HTML (título + legenda da narração + marca "Histórias Bíblicas Infantis").

Contrato compartilhado `roteiro.json`: `titulo_aula, introducao, conclusao` +
`slides[]: { id, titulo, narracao, imagem_prompt }`.

Interface web opcional: `servidor.mjs` (Node zero-dep, HTTP + SSE) + SPA `web/`.
Orquestra as 4 etapas em loop. `node_modules/` é snapshot vendored (17,6 MB) —
**não** reinstalar via npm.

## Escopo de trabalho

### 1) Cópia dos arquivos necessários

Copiar de `videoaulas-teologia` → `002`:

- `scripts/` (todos), `web/`, `node_modules/`, `docs/`, `iniciar.bat`,
  `README.md`, `AGENTS.md`, `.gitignore`.

**Não copiar:** `output/` (artefatos gerados), `.html-video/` (cache de render),
`.git`, `.iniciar.log`, `.wd.log`, `.config.json`.

### 2) Arquivos reescritos

| Arquivo | Mudança |
|---|---|
| `scripts/gerar_roteiro.mjs` | `SYSTEM_PROMPT` reescrito para persona de contador(a) de histórias bíblicas infantis; `MIN_SLIDES` 15 → 8 (env); narrações 35–50 palavras; `imagem_prompt` em estilo chibi fofo sem texto |
| `scripts/gerar_imagens.mjs` | Sufixo de estilo chibi global (env `ESTILO_SUFIXO`); prompt com "no text/no captions"; reforço do `NEGATIVE_PROMPT`; proporção via env `FORMATO` (16:9 → 1152x640; 9:16 → 640x1152) ou `IMAGEM_LARGURA`/`IMAGEM_ALTURA` explícitos |
| `scripts/gerar_narracao.mjs` | Default `VOZ` → `pt-BR-FranciscaNeural`; (opcional) env `VOZ_RATE` |
| `scripts/montar_video.mjs` | Marca "Histórias Bíblicas Infantis" nos frames; slide mostra **legenda em destaque** (texto da narração em faixa translúcida escura, texto grosso com contorno, fonte adaptativa); env `LEGENDA` (default 1); resolução default derivada do `FORMATO` (16:9 → 1920x1080; 9:16 → 1080x1920) |
| `scripts/servidor.mjs` | `DEFAULTS`: `VOZ` feminina + `FORMATO` (propagados ao env dos jobs) |
| `web/index.html` | (opcional) inputs `IMAGEM_LARGURA/ALTURA` no modal Configurações |

### 3) Mantidos sem alteração

- Contrato do `roteiro.json`.
- Fluxo das 4 etapas e regras de idempotência.
- Interface web (lógica `app.js`, `style.css`).
- Requisitos externos (llama-server, ComfyUI/Krea 2 Turbo, edge-tts, ffmpeg, playwright).

## Como gerar cada formato (CLI)

Escolha o formato via env `FORMATO` — **um por vez, nunca os dois**:

- **16:9 (default):**
  `node scripts/pipeline.mjs "A Arca de Noé"`
  → `output/a-arca-de-noe/a-arca-de-noe-1920x1080.mp4`
- **9:16:**
  `FORMATO=9:16 node scripts/pipeline.mjs "A Arca de Noé"`
  → `output/a-arca-de-noe/a-arca-de-noe-1080x1920.mp4`

O `FORMATO` controla a proporção das imagens (`1152x640`/`640x1152`) e a
resolução padrão do vídeo (`1920x1080`/`1080x1920`). Para uma história gerada
em 9:16, as imagens também são geradas em 9:16 — nunca um formato misturado.

## Verificação

1. `node --check` em todos os scripts (`scripts/*.mjs`).
2. Gerar um vídeo 16:9 e um 9:16 (comandos acima) e conferir:
   - voz feminina pt-BR na narração;
   - imagens estilo chibi, sem texto;
   - legenda em destaque no vídeo;
   - marca "Histórias Bíblicas Infantis" na intro/rodapé/outro.
3. Abrir a interface web (`node scripts/servidor.mjs`) e testar o fluxo completo.

## Fora de escopo / riscos

- `node_modules/` é vendored — atualizar recopiando de `F:\codigos\html-video\packages\{core,content-graph,adapter-hyperframes}\dist`; nunca via npm.
- Gotchas herdados: porta `5173` pode colidir em IPv6 (usar `http://127.0.0.1:5173/`); arquivos UTF-8; `montar_video.mjs` roda `main()` incondicionalmente (importá-lo executaria). (Workflow de imagem hoje: **Krea 2 Turbo + LoRA purePixarStyle3D** — ver AGENTS.md; os gotchas antigos de `UnetLoaderGGUF`/Z-Image/Qwen-image 2.1 não se aplicam mais.)
- Binários do Playwright não são vendored (cache em `%LOCALAPPDATA%\ms-playwright`).
