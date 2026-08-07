import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request as httpRequest } from 'node:http';

const LLAMA_URL = process.env.LLAMA_URL || 'http://127.0.0.1:8091';

function postJson(url, body, { timeoutMs = 30 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = JSON.stringify(body);
    const req = httpRequest(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    req.on('timeout', () => req.destroy(new Error(`llama-server não respondeu em ${timeoutMs}ms`)));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

const SYSTEM_PROMPT = `Você é um contador(a) de histórias bíblicas infantis. Você cria vídeos curtos de "historinhas bíblicas" em formato de apresentação de slides animada (estilo YouTube Kids), onde cada slide mostra UMA cena ilustrada e a narração conta a história para crianças pequenas.

Cada slide deve ser composto de 85-95% por UMA imagem ilustrativa da cena; o texto aparece apenas como título curto e como legenda da narração no vídeo.

Gere SEMPRE um JSON válido, sem markdown, sem texto extra, com esta estrutura exata:

{
  "titulo_aula": "Nome da história (ex.: A Arca de Noé)",
  "introducao": "2-3 frases curtas de abertura narradas para a criança, com um gancho que desperta curiosidade, citando a referência bíblica",
  "slides": [
    {
      "id": "slide-01",
      "titulo": "Título curto do slide (max 6 palavras, linguagem simples)",
      "narracao": "35-50 palavras narradas, frases curtas, contando a história de forma acolhedora e lúdica, sem citar referências bíblicas",
      "imagem_prompt": "Prompt de imagem em inglês (EN) descrevendo APENAS a cena da história como em um livro de bíblia infantil (personagens e objetos da história, o que está acontecendo, o cenário). NÃO inclua estilo nem palavras sobre texto — o estilo (children's Bible storybook illustration) e a proibição de texto na imagem são adicionados automaticamente depois. Ex.: 'Noah hammering on a giant wooden ark while small birds and animals peek out from the windows'"
    }
  ],
  "conclusao": "2-4 frases de encerramento narradas: uma moral simples para a criança e o convite para curtir e se inscrever no canal para ouvir mais historinhas bíblicas"
}

REGRAS:
- Total de slides: de 8 a 10 (vídeo curto de 3-6 minutos); gere no mínimo 8 slides.
- Cada narração de slide: 35-50 palavras (aprox. 15-25 segundos falados).
- Conteúdo: histórias bíblicas infantis conhecidas (a criação, a Arca de Noé, Abraão, Moisés e o mar Vermelho, Davi e Golias, Jonas e o grande peixe, Daniel na cova dos leões, o nascimento de Jesus, Zaqueu, o bom samaritano, a multiplicação dos pães, etc.). O usuário pode pedir qualquer história bíblica.
- Linguagem: português do Brasil, simples, acolhedora e lúdica, como uma vovó contando a história para crianças pequenas. Sem termos difíceis e sem jargão.
- Referências bíblicas: apenas a introdução deve citar a referência bíblica na narração. Nos slides e na conclusão NÃO mencione nenhuma referência na narração.
- As referências devem estar corretas e fiéis à história bíblica, mantendo o tom educacional, cristão e edificante.
- Narração legível por leitor de voz (TTS): quando uma referência bíblica for citada na narração (apenas na introducao), escreva-a por extenso como seria falada, ex.: "Gênesis 6, 14" em vez de "Gênesis 6:14", "João 3, 16" em vez de "João 3:16".
- imagem_prompt: em inglês, uma cena ÚNICA e CLARA que conte a história (como num livro de bíblia infantil), com personagens e objetos da cena. Não escreva estilos nem proibições de texto — isso é adicionado automaticamente.`;

export async function gerarRoteiro(topico) {
  const MIN_SLIDES = Number(process.env.MIN_SLIDES) || 8;
  const maxTentativas = 3;
  let ultimaRota = null;
  let ultimoErro = null;

  for (let tentativa = 1; tentativa <= maxTentativas; tentativa++) {
    if (tentativa > 1) console.error(`  Tentativa ${tentativa}/${maxTentativas}: regerando roteiro ...`);
    const body = {
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content:
            tentativa > 1
              ? `Crie a historinha bíblica sobre: ${topico}\n\nATENÇÃO: é obrigatório gerar no mínimo ${MIN_SLIDES} slides. A tentativa anterior foi rejeitada (menos slides que o mínimo ou JSON inválido).`
              : `Crie a historinha bíblica sobre: ${topico}`,
        },
      ],
      temperature: 0.7,
      max_tokens: 16384,
      stream: false,
    };

    const resp = await postJson(`${LLAMA_URL}/v1/chat/completions`, body);

    if (resp.status !== 200) {
      throw new Error(`llama-server erro ${resp.status}: ${resp.text.slice(0, 500)}`);
    }

    let data;
    try {
      data = JSON.parse(resp.text);
    } catch {
      throw new Error(`llama-server retornou JSON inválido: ${resp.text.slice(0, 500)}`);
    }
    const content = data.choices?.[0]?.message?.content ?? '';
    let roteiro;
    try {
      roteiro = extrairJson(content);
    } catch (e) {
      ultimoErro = e;
      console.error(`  Resposta do modelo sem JSON válido (tentativa ${tentativa}/${maxTentativas}): ${e.message}`);
      continue;
    }

    if (Array.isArray(roteiro.slides) && roteiro.slides.length >= MIN_SLIDES) {
      return roteiro;
    }
    ultimaRota = roteiro;
  }

  throw new Error(
    `Modelo não gerou o mínimo de ${MIN_SLIDES} slides após ${maxTentativas} tentativas (recebidos: ${ultimaRota?.slides?.length ?? 0}).${ultimoErro ? ` Último erro de parse: ${ultimoErro.message}` : ''}`,
  );
}

/** Encontra o primeiro objeto JSON balanceado dentro do texto (ignora lixo ao redor). */
function extrairObjeto(s) {
  const inicio = s.indexOf('{');
  if (inicio === -1) return null;
  let profundidade = 0;
  let emString = false;
  let escapado = false;
  for (let i = inicio; i < s.length; i++) {
    const c = s[i];
    if (emString) {
      if (escapado) escapado = false;
      else if (c === '\\') escapado = true;
      else if (c === '"') emString = false;
      continue;
    }
    if (c === '"') {
      emString = true;
      continue;
    }
    if (c === '{') profundidade++;
    else if (c === '}') {
      profundidade--;
      if (profundidade === 0) return s.slice(inicio, i + 1);
    }
  }
  return null;
}

export function extrairJson(content) {
  const texto = String(content ?? '').trim();
  try {
    return JSON.parse(texto);
  } catch {
    /* segue para a limpeza */
  }
  const semFence = texto.replace(/```json/gi, '').replace(/```/g, '').trim();
  const candidato = extrairObjeto(semFence);
  if (candidato) {
    try {
      return JSON.parse(candidato);
    } catch {
      // Reparo de vírgulas finais antes de } ou ] (comum em saída de LLM)
      const reparado = candidato.replace(/,\s*([}\]])/g, '$1');
      try {
        return JSON.parse(reparado);
      } catch (e) {
        throw new Error(`${e.message}. Trecho: ${candidato.slice(0, 500)}`);
      }
    }
  }
  throw new Error('Resposta do modelo não contém JSON válido. Resposta: ' + texto.slice(0, 400));
}

async function main() {
  const topico = process.argv[2];
  if (!topico) {
    console.error('Uso: node gerar_roteiro.mjs "Nome da história bíblica"');
    process.exit(1);
  }

  const slug = topico
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'output', slug);
  await mkdir(outDir, { recursive: true });

  console.error(`[1/4] Gerando roteiro para: ${topico} ...`);
  const roteiro = await gerarRoteiro(topico);
  roteiro.slug = slug;
  roteiro.topico = topico;

  const roteiroPath = join(outDir, 'roteiro.json');
  await writeFile(roteiroPath, JSON.stringify(roteiro, null, 2), 'utf8');
  console.error(`Roteiro salvo: ${roteiroPath}`);
  console.log(JSON.stringify({ slug, slides: roteiro.slides.length, roteiroPath }));
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
