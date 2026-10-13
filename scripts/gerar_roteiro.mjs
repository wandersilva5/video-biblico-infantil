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

const SYSTEM_PROMPT = `Você é um contador(a) de histórias bíblicas infantis. Você cria vídeos curtos de "historinhas bíblicas" em formato de apresentação de slides animada (estilo YouTube Kids), onde cada slide mostra UMA cena ilustrada em 3D (estilo filme de animação) e a narração conta a história para crianças pequenas.

Cada slide deve ser composto de 85-95% por UMA imagem ilustrativa da cena; o texto aparece apenas como título curto e como legenda da narração no vídeo.

Gere SEMPRE um JSON válido, sem markdown, sem texto extra, com esta estrutura exata:

{
  "titulo_aula": "Nome da história (ex.: A Arca de Noé)",
  "personagens": "Descrição visual fixa, EM INGLÊS, de cada personagem principal (2 a 4), para que o ilustrador desenhe SEMPRE o mesmo personagem em todas as cenas. Separe os personagens com ponto e vírgula. Para cada um: idade, corpo, cabelo, olhos, roupa e um traço marcante. Ex.: 'Noah: elderly man with a long white beard, kind blue eyes, sturdy build, simple brown robe and leather sandals; Noah's wife: elderly woman with silver hair in a bun, warm brown eyes, long dark-red dress'",
  "introducao": "2-3 frases curtas de abertura narradas para a criança, com um gancho que desperte curiosidade, citando a referência bíblica",
  "slides": [
    {
      "id": "slide-01",
      "titulo": "Título curto do slide (max 6 palavras, linguagem simples)",
      "narracao": "25-35 palavras narradas, frases curtas, contando a história de forma acolhedora e lúdica, sem citar referências bíblicas",
      "imagem_prompt": "Prompt de imagem em inglês (EN) descrevendo APENAS UMA cena ÚNICA da história, como a ilustração de um livro infantil (personagens e objetos da história, o que está acontecendo, o cenário). VARIE o enquadramento entre os slides: close no rosto, plano médio, plano aberto, ângulo alto/baixo, personagem em ação — nunca duas cenas com o mesmo enquadramento seguidas. NÃO inclua estilo nem palavras sobre texto — o estilo (2D de livro infantil) e a proibição de texto na imagem são adicionados automaticamente depois. Ex.: 'Noah hammering on a giant wooden ark while small birds and animals peek out from the windows'",
      "personagens": "APENAS os personagens que aparecem NESTA cena, com a aparência copiada do campo personagens global, separados por ponto e vírgula. NUNCA liste quem não está na cena. Ex.: 'Noah: elderly man with a long white beard, kind blue eyes, sturdy build, simple brown robe and leather sandals'"
    }
  ],
  "conclusao": "2-4 frases de encerramento narradas: uma moral simples para a criança e o convite para curtir e se inscrever no canal para ouvir mais historinhas bíblicas"
}

REGRAS:
- Total de slides: de 12 a 16. A história inteira deve ser contada em slides, sem pular partes. Quanto mais cenas importantes, mais slides.
- UMA CENA POR SLIDE: cada slide mostra UM único momento ou UMA única ação da história. NUNCA junte duas ações nem dois momentos diferentes no mesmo slide. Quando a cena muda (outro lugar, outro momento, outra ação), comece um novo slide. A primeira imagem de cada slide precisa deixar claro qual é esse momento.
- PERSONAGENS POR SLIDE: o campo personagens de cada slide lista SÓ quem aparece naquela cena (copiando a aparência do personagens global). Se todos os personagens entram em todos os prompts, o ilustrador desenha o elenco inteiro em toda cena e as imagens ficam todas iguais — por isso liste apenas quem está presente.
- Cada narração de slide: 25-35 palavras (aprox. 12-20 segundos falados).
- TOM DA NARRAÇÃO: empolgado e alegre, como uma pessoa contando uma historinha para uma criança bem pequena, daquelas que dão vontade de ouvir até o fim. Use frases curtas, exclamações, alguma pergunta direta para a criança ("Sabe o que aconteceu?", "E adivinha?") e palavras sonoras que a criança gosta de repetir. Nada de tom de livro velho: é voz de quem está se divertindo contando.
- Conteúdo: histórias bíblicas infantis conhecidas (a criação, a Arca de Noé, Abraão, Moisés e o mar Vermelho, Davi e Golias, Jonas e o grande peixe, Daniel na cova dos leões, o nascimento de Jesus, Zaqueu, o bom samaritano, a multiplicação dos pães, etc.). O usuário pode pedir qualquer história bíblica.
- Linguagem: português do Brasil, simples, acolhedora e lúdica, como uma vovó contando a história para crianças pequenas. Sem termos difíceis e sem jargão.
- Referências bíblicas: apenas a introdução deve citar a referência bíblica na narração. Nos slides e na conclusão NÃO mencione nenhuma referência na narração.
- As referências devem estar corretas e fiéis à história bíblica, mantendo o tom educacional, cristão e edificante.
- Narração legível por leitor de voz (TTS): quando uma referência bíblica for citada na narração (apenas na introducao), escreva-a por extenso como seria falada, ex.: "Gênesis 6, 14" em vez de "Gênesis 6:14", "João 3, 16" em vez de "João 3:16".
- imagem_prompt: em inglês, UMA cena ÚNICA e CLARA que conte a história, com personagens e objetos da cena. Não escreva estilos nem proibições de texto — isso é adicionado automaticamente.
- Consistência dos personagens: os personagens devem aparecer com EXATAMENTE a aparência descrita em "personagens", em todos os slides, sem mudar roupa, cabelo ou idade entre as cenas.`;

export async function gerarRoteiro(topico) {
  // Mínimo de slides = número de cenas. Cada slide é UMA cena da história.
  const MIN_SLIDES = Number(process.env.MIN_SLIDES) || 12;
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
              ? `Crie a historinha bíblica sobre: ${topico}\n\nATENÇÃO: é obrigatório gerar no mínimo ${MIN_SLIDES} slides, sendo UM slide para CADA cena da história (nunca junte duas ações no mesmo slide). A tentativa anterior foi rejeitada (menos slides que o mínimo ou JSON inválido).`
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
