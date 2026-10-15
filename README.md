# Estúdio de Historinhas Bíblicas Infantis

Pipeline local que transforma uma **história bíblica** em um **vídeo curto narrado** (MP4): `roteiro.json` → imagens dos slides → narração (MP3) → vídeo final. Sem `package.json`, sem npm, sem build, sem testes. Scripts Node ESM puros executados com `node`; dependências de terceiros são vendored em `node_modules/`.

Produz **16:9 (YouTube)** ou **9:16 (Reels/Shorts/TikTok)**, sempre **um formato por vez** — nunca os dois.

## Índice

- [Como funciona](#como-funciona)
- [Pré-requisitos (serviços externos)](#pré-requisitos-serviços-externos)
- [Início rápido](#início-rápido)
- [Formatos 16:9 e 9:16](#formatos-169-e-916)
- [Interface web (recomendada)](#interface-web-recomendada)
- [Pipeline por linha de comando](#pipeline-por-linha-de-comando)
- [Estrutura do projeto](#estrutura-do-projeto)
- [Contrato do `roteiro.json`](#contrato-do-roteirojson)
- [Layout de saída e idempotência](#layout-de-saída-e-idempotência)
- [Renderizador de vídeo (local)](#renderizador-de-vídeo-local)
- [Variáveis de ambiente / configuração](#variáveis-de-ambiente--configuração)
- [Pontos de atenção (gotchas)](#pontos-de-atenção-gotchas)

## Como funciona

Quatro etapas encadeadas, cada uma consumindo o resultado da anterior:

1. **`gerar_roteiro.mjs`** — chama o **llama-server** (OpenAI-compatible) com um prompt de **contador(a) de histórias bíblicas infantis** e gera o `roteiro.json` (título, introdução com a referência bíblica, **`personagens`** (descrição visual fixa, em inglês, dos personagens), 12–16 slides com título/narração curta/prompt de imagem, conclusão). A regra é **uma cena por slide**: cada slide mostra um único momento da ação, sem juntar duas cenas.
2. **`gerar_imagens.mjs`** — monta para cada slide um prompt que **conta a cena da história** em estilo **Disney/Pixar 3D** (via `buildPromptImagem`, a partir do `imagem_prompt` + da âncora de personagens do roteiro), envia ao **ComfyUI** (workflow **Krea 2 Turbo (fp8)** + LoRA Pixar 3D, difusão na resolução final por padrão) e salva `slide-NN.png`. Também gera as artes `00-intro.png` (professora com a Bíblia infantil) e `outro.png` (encerramento infantil). **Sem texto** nas imagens (blindagens anti-texto no próprio prompt positivo — cfg=1.0 zera o negativo). Falhas são **retentadas** automaticamente e não abortam as demais. Proporção definida pelo `FORMATO`.
3. **`gerar_narracao.mjs`** — usa o CLI **edge-tts** para gerar os MP3s de narração com **voz feminina pt-BR** (`pt-BR-FranciscaNeural`), em ritmo levemente acelerado (`VOZ_RATE=+8%`) para o tom de historinha. **Reutiliza o MP3** quando o texto não mudou (hash no `manifesto.json`).
4. **`montar_video.mjs`** — consome o `roteiro.json` + PNGs + MP3s e renderiza o MP4 final via **html-video** (Chromium headless + ffmpeg), com frames animados, **legenda em destaque** (texto da narração em faixa com contorno e fade), marca "Histórias Bíblicas Infantis" e áudio mixado (com **trilha sonora opcional** via `TRILHA`).

Cada etapa imprime seu resultado JSON no stdout; linhas de progresso/log vão para o stderr.

## Pré-requisitos (serviços externos)

O pipeline depende de quatro serviços, todos locais e específicos da máquina:

| Serviço | Endereço | Função |
|---|---|---|
| **llama-server** (llama.cpp, OpenAI-compatible) | `http://127.0.0.1:8091` | Gera o roteiro (env `LLAMA_URL`) |
| **ComfyUI** | `http://127.0.0.1:8188` | Gera as imagens dos slides (env `COMFY_URL`) |
| **edge-tts** (CLI no PATH) | — | Narração em MP3, voz `pt-BR-FranciscaNeural` (env `VOZ`) |
| **ffmpeg / ffprobe** (no PATH) | — | Usados pelo `montar_video.mjs` |

### Workflow Krea 2 Turbo (ComfyUI)

As imagens usam o workflow **Krea 2 Turbo (fp8)**, receita do blueprint oficial `blueprints/Text to Image (Krea-2 Turbo).json`:

- `UNETLoader` com `Krea2\krea2_turbo_fp8_scaled.safetensors`
- `CLIPLoader` tipo `krea2` com `qwen\qwen3vl_4b_fp8_scaled.safetensors`
- `LoraLoader` com `Krea2\purePixarStyle3D_v1.safetensors` (trigger `KR2Pix` no início do prompt; strength 1.0 — `KREA2_LORA_FORCA=0` desliga o LoRA)
- `CLIPTextEncode` + `ConditioningZeroOut` (cfg=1.0 ignora o negative: estilo e blindagens vivem no prompt positivo)
- VAE `qwen_image_vae.safetensors` — **nunca `ae.safetensors`** (FLUX): decodifica os latents do Krea2 como ruído cinzento
- `KSampler`: 8 passos (`KREA2_STEPS`), cfg 1.0, euler/simple

**Resolução (qualidade):** por padrão a difusão roda **direto na resolução final** (1152x640 / 640x1152 — múltiplos de 32, muito mais detalhe; ~1–2 min por imagem). O caminho rápido em 2 passos é opt-in: `KREA2_UPSCALE=1` faz a difusão em `KREA2_ESCALA_BASE` da final (default 0.5 → ~576x320 em 16:9) e um nó `ImageScale` (`lanczos`) upscale para a final dentro do próprio workflow.

**VRAM (RTX 3060 Ti, 8GB):** o UNET fp8 (12.5GB) e o text encoder 4B fp8 não cabem juntos na GPU — o ComfyUI faz **offload automático** e roda bem (~1–2 min por imagem), com `KREA2_CLIP_DEVICE` (`default`) controlando onde carregar o text encoder.

O diretório de saída do ComfyUI é fixo em `D:\ComfyUI_windows_portable\ComfyUI\output` (env `COMFY_OUTPUT_DIR`). Cada imagem é tentada até `KREA2_TENTATIVAS` vezes (default 3); antes de cada nova tentativa o pipeline manda `POST /interrupt` no ComfyUI.

### Personagens consistentes

O `personagens` do `roteiro.json` descreve, **em inglês e uma única vez**, a aparência de cada personagem (idade, corpo, cabelo, olhos, roupa, traço marcante). `buildPromptImagem(slide, roteiro)` repete essa descrição no início de **todos** os prompts, seguida da âncora `each character appears exactly once, consistent character design, no duplicate characters, no clones, no copies of the same character` — e o `imagem_prompt` de cada slide cita os personagens **só pelo nome** (repetir a aparência em palavras diferentes duplicava o personagem na mesma cena). Cada imagem usa **seed própria por slide** (`KREA2_SEED_BASE` + índice×137) — a mesma seed em todas as cenas faz o modelo repetir quase a mesma imagem; `SEED_POR_SLIDE=0` força seed única.

## Início rápido

Se você tem todos os serviços de pé, basta:

```sh
node scripts/pipeline.mjs "A Arca de Noé"
```

O vídeo sai em `output/<slug>/<slug>-1920x1080.mp4`.

Para iniciar os serviços (llama-server, ComfyUI e servidor web) com um único comando, use o controlador:

```sh
iniciar.bat
```

Ele verifica/sobe os 3 serviços, mostra o status, abre a interface no navegador e encerra tudo ao fechar a janela. Os caminhos dos executáveis estão fixos dentro do script (`E:\llama.cpp\llama-server.exe`, `D:\ComfyUI_windows_portable`).

## Formatos 16:9 e 9:16

**Um formato por vez — nunca os dois.** O env `FORMATO` (16:9 ou 9:16) controla a proporção das imagens **e** a resolução padrão do vídeo:

- **16:9 (default):** imagens `1152x640`, vídeo `1920x1080`.
- **9:16:** imagens `640x1152`, vídeo `1080x1920`.

```sh
# 16:9
node scripts/pipeline.mjs "A Arca de Noé"

# 9:16
FORMATO=9:16 node scripts/pipeline.mjs "A Arca de Noé"
```

Como o nome do MP4 embute a resolução, um arquivo não sobrescreve o outro — mas para cada história gere **apenas** o formato escolhido (as imagens são geradas na proporção dele).

## Interface web (recomendada)

Orquestra as 4 etapas em **loop** (editar/regenerar qualquer etapa a qualquer momento), com progresso ao vivo:

```sh
node scripts/servidor.mjs
# abra http://localhost:5173  (neste repo, o .config.json define a porta 5174)
```

- **Backend** Node zero-dependência (`node:http` + SSE) em `scripts/servidor.mjs`; **frontend** é uma SPA pura em `web/` (`index.html`, `style.css`, `app.js`). Sem npm/build.
- Porta padrão `5173` — o env `PORTA` tem precedência sobre `.config.json` (persistido pela UI em "Configurações"; neste repositório o `.config.json` usa `5174`).
- Em **Configurações**: `VOZ` (padrão feminina `pt-BR-FranciscaNeural`) e `FORMATO` (16:9 / 9:16) — o seletor de resolução da etapa Vídeo já abre no formato escolhido.
- As etapas rodam via `child_process.spawn` reutilizando os mesmos scripts; o progresso (stderr) chega ao navegador por SSE em `/api/progresso`. Só **um job ativo por vez** (evita escrita concorrente).
- Antes de cada etapa, a web e o `pipeline.mjs` fazem **health-check** do serviço exigido (`verificar_servicos.mjs`) e abortam com diagnóstico claro se ele estiver fora do ar.
- O job ativo pode ser **cancelado** (botão ⏹ → `POST /api/cancel` mata a árvore do processo + `POST /interrupt` no ComfyUI). Cada job grava um **log** em `output/<slug>/logs/<jobId>.log`.
- `GET/PUT /api/roteiro/:slug` edita o roteiro; `POST /api/imagens|narracao|video/:slug` regenera tudo ou um item (`{slideId}` apaga só o PNG/MP3 e roda a etapa **restrita àquele item** via `--apenas` — nenhum outro slide/artes pendente é tocado; sem `slideId`, gera tudo que faltar; `FORCAR=1` força a regeneração da narração). Vídeo exige imagem + áudio de todos os slides (retorna 400 com diagnóstico).
- `manifesto.json` (em `output/<slug>/`) guarda hashes do texto/prompt por item para marcar itens "desatualizados" na UI.
- `/media/<slug>/...` serve PNGs/MP3s/MP4s da saída.

## Pipeline por linha de comando

Cada etapa pode rodar isolada contra um `roteiro.json` existente:

```sh
node scripts/gerar_imagens.mjs output/<slug>/roteiro.json
node scripts/gerar_imagens.mjs output/<slug>/roteiro.json --apenas slide-03   # só esse slide
node scripts/gerar_imagens.mjs output/<slug>/roteiro.json --arte intro        # só a arte de abertura
node scripts/gerar_narracao.mjs output/<slug>/roteiro.json
node scripts/gerar_narracao.mjs output/<slug>/roteiro.json --apenas slide-03
node scripts/montar_video.mjs output/<slug>/roteiro.json
```

## Estrutura do projeto

```
002/
├─ scripts/
│  ├─ pipeline.mjs          # orquestra as 4 etapas em sequência (CLI)
│  ├─ gerar_roteiro.mjs     # [1/4] roteiro via llama-server (historinha infantil)
│  ├─ gerar_imagens.mjs     # [2/4] slides via ComfyUI (prompts tranquilos + upscale)
│  ├─ gerar_narracao.mjs    # [3/4] MP3s via edge-tts (voz feminina pt-BR)
│  ├─ montar_video.mjs      # [4/4] MP4 via html-video (Chromium + ffmpeg) + legenda
│  ├─ servidor.mjs          # backend web (HTTP + SSE) da interface
│  ├─ verificar_servicos.mjs# health-check dos pré-requisitos (llama/comfy/tts/ffmpeg)
│  └─ comfy_test.json       # workflow de teste com outros modelos (não usado no pipeline)
├─ web/
│  ├─ index.html            # SPA (estrutura)
│  ├─ style.css             # tema escuro navy/gold
│  └─ app.js                # lógica da UI (fetch + EventSource)
├─ node_modules/            # deps vendored (html-video core, yaml, playwright)
├─ output/<slug>/           # artefatos por história (roteiro, PNGs, MP3s, MP4)
├─ .html-video/             # cache de render (seguro apagar)
├─ .config.json             # config persistida pela UI
├─ iniciar.bat              # sobe/encerra llama-server + ComfyUI + web
├─ AGENTS.md                # instruções para agentes de IA (dev)
├─ PLANO.md                 # plano de adaptação do projeto (documentação)
└─ README.md
```

## Contrato do `roteiro.json`

Modelo de dados compartilhado — escrito pelo `gerar_roteiro.mjs` e consumido por todas as etapas seguintes:

```
titulo_aula, introducao, conclusao    (strings de narração)
personagens                           (descrição visual fixa em inglês,
                                      repetida em todos os prompts de imagem)
slides[]: {
  id,                                (ex.: "slide-01")
  titulo,                            (≤ 6 palavras, linguagem simples)
  narracao,                          (25–35 palavras, tom empolgado)
  imagem_prompt                      (descrição de UMA CENA em inglês)
}
slug, topico                         (adicionados pelo script)
```

## Layout de saída e idempotência

Tudo sai em `output/<slug>/`, onde `slug` = título em minúsculas, sem acentos, não-alfanuméricos → `-`. Arquivos:

- `roteiro.json`
- `slide-01.png` … `slide-NN.png`
- `00-intro.png` (arte de abertura: mulher com a Bíblia infantil) e `outro.png` (arte de encerramento)
- `00-intro-narracao.mp3`, `01-narracao.mp3` …, `NN-conclusao-narracao.mp3`
- `narracao-full.mp3` (narração concatenada)
- `<slug>-<LARGURA>x<ALTURA>.mp4` (ex.: `a-arca-de-noe-1920x1080.mp4`; o formato vai no nome para 16:9 e 9:16 coexistirem)

Regras de idempotência:

- Imagens dos slides são **puladas** se `slide-NN.png` já existe; uma imagem que falha não aborta as demais (a etapa só falha no final, listando as que falharam).
- As artes `00-intro.png`/`outro.png` também são puladas se existem; se falharem, a etapa **não** falha (aviso) e o `montar_video.mjs` usa o layout de intro/outro sem imagem como fallback. Prompts via `PROMPT_INTRO`/`PROMPT_OUTRO`.
- O roteiro só é pulado se `PULAR_ROTEIRO=1` e `roteiro.json` existe.
- A narração **reutiliza o MP3** quando o texto não mudou (hash do texto no `manifesto.json`); `FORCAR=1` ou `--apenas <id>` forçam a regeneração (re-rodar custa TTS).

## Renderizador de vídeo (local)

`scripts/montar_video.mjs` é local (copiado do projeto html-video). Ele consome o contrato `roteiro.json`, lê `slide-NN.png` + `NN-narracao.mp3` do diretório de saída e renderiza com o núcleo do html-video vendored. A intro usa a arte `00-intro.png` (mulher com a Bíblia infantil de um lado e título/subtítulo do outro; empilha na vertical no 9:16) e o outro usa `outro.png` como fundo — com fallback sem imagem. As imagens ganham **efeito Ken Burns** (zoom/pan suave, `KENBURNS=0` desliga) e as trocas de slide fazem **fade para preto** (`TRANSICAO=corte` volta aos cortes secos). Nos frames dos slides, o título fica no topo e a **narração vira legenda em destaque** no rodapé (faixa escura translúcida, borda dourada, texto grosso com contorno, fonte adaptativa, **fade-in/out** e quebra de linha por palavras). A marca padrão é "Histórias Bíblicas Infantis" (env `MARCA`).

Uma **trilha sonora de fundo** pode ser mixada ao vídeo com `TRILHA=/caminho/musica.mp3` (volume em `TRILHA_VOLUME`, default 0.08), com fade-in/out no áudio.

- `@html-video/{core,content-graph,adapter-hyperframes}` — dist compilado + `package.json` (copiado de `F:\codigos\html-video\packages\*`; sem fonte, sem build).
- `yaml` — usado pelo `TemplateRegistry` do core.
- `playwright` + `playwright-core` — gravação via Chromium headless. Os binários do navegador **não** são vendored; precisam estar no cache padrão do Playwright (`%LOCALAPPDATA%\ms-playwright`).
- `montar_video.mjs` define `HTML_VIDEO_ROOT` apontando para a raiz deste repositório, então o estado do render vai para `.html-video/` (cache, seguro apagar).

**Não reinstale/altere `node_modules/` via npm** — é um snapshot do output compilado do monorepo html-video. Atualize recopiando de `F:\codigos\html-video\packages\{core,content-graph,adapter-hyperframes}\dist` e do seu `.pnpm`.

Se uma máquina nova não tiver os binários do navegador:

```sh
npx playwright-core install chromium   # a partir de node_modules/playwright-core
```

## Variáveis de ambiente / configuração

| Variável | Uso | Padrão |
|---|---|---|
| `LLAMA_URL` | URL do llama-server | `http://127.0.0.1:8091` |
| `COMFY_URL` | URL do ComfyUI | `http://127.0.0.1:8188` |
| `COMFY_OUTPUT_DIR` | Saída de imagens do ComfyUI | `D:\ComfyUI_windows_portable\ComfyUI\output` |
| `COMFY_TIMEOUT` | Aguardo por imagem no ComfyUI (ms) | `900000` (15 min) |
| `KREA2_UNET` | UNet do Krea 2 Turbo (fp8) | `Krea2\krea2_turbo_fp8_scaled.safetensors` |
| `KREA2_CLIP` | Text encoder (Qwen3-VL 4B fp8) | `qwen\qwen3vl_4b_fp8_scaled.safetensors` |
| `KREA2_CLIP_DEVICE` | Onde carregar o text encoder (`default`, `cpu`) | `default` |
| `KREA2_VAE` | VAE (Krea 2 usa o VAE do Qwen; `ae.safetensors` gera ruído) | `qwen_image_vae.safetensors` |
| `KREA2_LORA` | LoRA de estilo Pixar 3D | `Krea2\purePixarStyle3D_v1.safetensors` |
| `KREA2_LORA_FORCA` | Força do LoRA (`0` desliga) | `1.0` |
| `KREA2_TRIGGER` | Trigger do LoRA no início do prompt (`''` desliga) | `KR2Pix` |
| `KREA2_STEPS` | Passos do KSampler (benchmark) | `8` |
| `KREA2_ESCALA_BASE` | Fração da resolução final usada na difusão (`0.25`–`1`; só com `KREA2_UPSCALE=1`) | `0.5` |
| `KREA2_UPSCALE` | `1` ativa o caminho rápido 2 passos (default: difusão na resolução final) | — |
| `SEED_POR_SLIDE` | `0` força seed única em todas as cenas (default: seed própria por slide) | — |
| `KREA2_TENTATIVAS` | Tentativas por imagem antes de falhar | `3` |
| `FORMATO` | Formato do vídeo/imagens: `16:9` ou `9:16` | `16:9` |
| `IMAGEM_LARGURA` / `IMAGEM_ALTURA` | Proporção das imagens (sobrepõe `FORMATO`) | derivada do `FORMATO` (`1152x640` / `640x1152`) |
| `ESTILO_SUFIXO` | Sufixo de estilo apensado ao prompt da cena (início do prompt, após o trigger) | Disney-Pixar 3D (animated film still, cinematic lighting)… |
| `PROMPT_INTRO` | Prompt da arte de abertura (`00-intro.png`) | professora lendo com crianças no canto de leitura |
| `PROMPT_OUTRO` | Prompt da arte de encerramento (`outro.png`) | professora e crianças acenando goodbye na aula |
| `MIN_SLIDES` | Mínimo de slides (cenas) no roteiro | `12` |
| `VOZ` | Voz do edge-tts (feminina pt-BR) | `pt-BR-FranciscaNeural` |
| `VOZ_RATE` | Ritmo de leitura do edge-tts | `+8%` |
| `VOZ_PITCH` | Tom da voz do edge-tts | `+0Hz` |
| `MARCA` | Marca exibida na intro/rodapé/outro | `Histórias Bíblicas Infantis` |
| `LEGENDA` | `0` mostra só o título do slide em vez da legenda | `1` |
| `LEGENDA_FADE` | `0` desliga o fade-in/out da legenda | `1` |
| `KENBURNS` | `0` desliga o efeito Ken Burns (imagem parada) | `1` |
| `TRANSICAO` | `corte` desliga o fade para preto entre slides | `fade` |
| `TRILHA` | Caminho do MP3/WAV de música de fundo (mix no ffmpeg) | — |
| `TRILHA_VOLUME` | Volume da trilha de fundo (0–1) | `0.08` |
| `PULAR_ROTEIRO` | `1` pula a geração do roteiro | — |
| `PORTA` | Porta do servidor web (precede `.config.json`) | `5173` |
| `KREA2_SEED_BASE` | Seed base das imagens (regeneração usa seed aleatório) | `1000` |
| `VIDEO_FPS` | FPS do vídeo | `30` |
| `VIDEO_WIDTH` | Largura do vídeo (sobrepõe `FORMATO`) | derivada do `FORMATO` |
| `VIDEO_HEIGHT` | Altura do vídeo (sobrepõe `FORMATO`) | derivada do `FORMATO` |
| `VIDEO_PADDING` | Pausa (s) entre slides/frames | `0.3` |

## Pontos de atenção (gotchas)

- Não renomeie `.mjs` nem adicione `"type": "module"` — os scripts são ESM puros rodados direto. Os três `gerar_*.mjs` guardam `main()` para permitir import, mas `montar_video.mjs` roda `main()` incondicionalmente (importá-lo o executaria).
- Conteúdo em pt-BR; prompts para o LLM em português; `imagem_prompt` em inglês. As imagens **contam a cena da história** (personagens e objetos da narrativa) em estilo **Disney/Pixar 3D** (LoRA `purePixarStyle3D`, trigger `KR2Pix` + `ESTILO_SUFIXO`, escolhido no A/B contra Z-Image + DisneyIZT), sempre **sem texto** (o sufixo `no text, no letters, no words, no captions, no speech bubbles` fecha o prompt positivo — cfg=1.0 zera o negativo via `ConditioningZeroOut`).
- **Uma cena por slide**: o roteiro é instruído a gerar 12–16 slides, um por momento da ação. Se a história precisar de mais cenas, suba `MIN_SLIDES`.
- **Krea 2 Turbo em 8GB de VRAM**: UNET fp8 (12.5GB) + TE 4B fp8 não cabem juntos — o ComfyUI faz offload automático e roda bem (~1–2 min por imagem); não carregue manualmente os dois.
- **VAE certo é `qwen_image_vae.safetensors`**: usar `ae.safetensors` (FLUX) decodifica os latents do Krea2 como ruído cinzento (buga silenciosamente o pipeline).
- `FORMATO` controla imagens **e** vídeo; gere **um formato por vez**, nunca os dois.
- O servidor web reutiliza os scripts via spawn; `montar_video.mjs` **sempre** via spawn.
- A porta `5173` pode colidir com outros projetos escutando em `::1` (IPv6). Se o navegador abrir o servidor errado, use outra porta (neste repo: `5174`) ou `http://127.0.0.1:<porta>/`.
- Leitura de JSON via PowerShell pode distorcer acentos; os arquivos são UTF-8.
