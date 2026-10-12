const $ = (sel) => document.querySelector(sel);

const estado = {
  tela: 'dashboard',
  slug: null,
  roteiro: null,
  artefatos: null,
  unificado: [],        // intro + slides + conclusao (texto + imagem + audio)
  config: null,
  jobAtivo: false,
  job: null,
  cancelado: false,
  modalIndice: null,
  logs: [],
};

const NOME_ETAPA = { roteiro: 'Roteiro', imagens: 'Imagens', narracao: 'Narração', video: 'Vídeo' };

const esc = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function slugDe(topico) {
  return topico
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function toast(msg, erro = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('erro', erro);
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), 4000);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  let data = null;
  try { data = await res.json(); } catch { /* sem corpo */ }
  if (!res.ok) throw new Error(data?.erro || `Erro HTTP ${res.status}`);
  return data;
}

// ---------------------------------------------------------------------------
// Log (SSE)
// ---------------------------------------------------------------------------
function adicionarLog(msg) {
  estado.logs.push(msg);
  if (estado.logs.length > 400) estado.logs.splice(0, estado.logs.length - 400);
  const el = $('#log-linhas');
  if (!el.classList.contains('aberto')) return;
  const div = document.createElement('div');
  div.className = `log-linha ${msg.tipo || 'log'}`;
  const hora = new Date(msg.ts).toLocaleTimeString('pt-BR');
  div.innerHTML = `<span class="hora">${hora}</span>${esc(msg.linha || msg.tipo)}`;
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
}

// ---------------------------------------------------------------------------
// Navegação
// ---------------------------------------------------------------------------
function mostrarTela(nome) {
  estado.tela = nome;
  $('#tela-dashboard').classList.toggle('ativa', nome === 'dashboard');
  $('#tela-aula').classList.toggle('ativa', nome === 'aula');
  if (nome === 'dashboard') carregarAulas();
}

async function abrirAula(slug) {
  estado.slug = slug;
  await Promise.all([carregarRoteiro(), carregarArtefatos()]);
  $('#titulo-aula').textContent = estado.roteiro.titulo_aula;
  mostrarTela('aula');
  renderTelaUnica();
}

async function carregarRoteiro() {
  estado.roteiro = await api(`/api/roteiro/${estado.slug}`);
}

async function carregarArtefatos() {
  estado.artefatos = await api(`/api/artefatos/${estado.slug}`);
}

// ---------------------------------------------------------------------------
// Unificação: roteiro + imagens + áudios em um só array
// ---------------------------------------------------------------------------
function unificar() {
  const r = estado.roteiro;
  const st = estado.artefatos;
  const lista = [];
  // aberttura
  lista.push({
    id: 'intro', tipo: 'abertura', rotulo: 'Abertura',
    titulo: r.titulo_aula,
    texto: r.introducao,
    prefix: '00-intro',
    imagem: null,
    audio: st.intro,
  });
  // slides (o texto da narração vem do roteiro, não dos artefatos)
  st.slides.forEach((s) => {
    const rs = r.slides.find((x) => x.id === s.id) || {};
    lista.push({
      id: s.id, tipo: 'slide', rotulo: `Slide ${String(s.idx).padStart(2, '0')}`,
      idx: s.idx,
      titulo: s.titulo,
      texto: rs.narracao || '',
      prefix: String(s.idx).padStart(2, '0'),
      imagem: s.imagem.existe
        ? { existe: true, desatualizado: !!s.imagem.desatualizado, src: s.imagem }
        : { existe: false, desatualizado: false, src: null },
      audio: s.audio,
    });
  });
  // conclusao
  const totalSlides = st.slides.length;
  const prefixConclusao = totalSlides ? `${String(totalSlides + 1).padStart(2, '0')}-conclusao` : '01-conclusao';
  lista.push({
    id: 'conclusao', tipo: 'conclusao', rotulo: 'Conclusão',
    titulo: '',
    texto: r.conclusao,
    prefix: prefixConclusao,
    imagem: null,
    audio: st.conclusao,
  });
  return lista;
}

// ---------------------------------------------------------------------------
// Renderização em tela única
// ---------------------------------------------------------------------------
function renderBloco(item) {
  const isSlide = item.tipo === 'slide';
  const midia = [];

  if (item.imagem?.existe) {
    midia.push(`
      <div class="bloco-img">
        <img src="/media/${esc(estado.slug)}/slide-${String(item.idx).padStart(2, '0')}.png" alt="${esc(item.titulo)}" loading="lazy" title="Clique para ampliar" />
        ${item.imagem.desatualizado ? '<div class="sobreposto-desatualizado">prompt alterado</div>' : ''}
      </div>`);
  } else if (isSlide) {
    midia.push('<div class="bloco-img vazio">imagem pendente</div>');
  }

  midia.push(`
    <div class="bloco-audio">
      ${item.audio?.existe
        ? `<audio controls preload="none" src="/media/${esc(estado.slug)}/${esc(item.prefix)}-narracao.mp3"></audio>
           ${item.audio.desatualizado ? '<span class="badge alerta">texto alterado</span>' : '<span class="badge ok">ok</span>'}`
        : '<span class="msg-progresso">sem áudio ainda</span>'}
    </div>`);

  // botões de ação: imagem apenas para slides; áudio para todos os itens
  const botoes = [];
  if (isSlide) {
    if (item.imagem?.existe) {
      botoes.push(`<button class="btn btn-mini regen" data-action="regen-imagem" data-slide="${esc(item.id)}" title="Regenerar imagem (seed nova)">↻ imagem</button>`);
      botoes.push(`<button class="btn btn-mini btn-perigo" data-action="del-imagem" data-slide="${esc(item.id)}" title="Excluir imagem">🗑</button>`);
    } else {
      botoes.push(`<button class="btn btn-mini regen" data-action="regen-imagem" data-slide="${esc(item.id)}" title="Gerar imagem">🖼 imagem</button>`);
    }
  }
  if (item.audio?.existe) {
    botoes.push(`<button class="btn btn-mini btn-perigo" data-action="del-narracao" data-slide="${esc(item.id)}" title="Excluir áudio">🗑</button>`);
  }
  botoes.push(`<button class="btn btn-mini regen" data-action="regen-narracao" data-slide="${esc(item.id)}" title="Regenerar áudio">🔊 áudio</button>`);

  return `
    <div class="bloco" data-id="${esc(item.id)}">
      <div class="bloco-cab">
        <span class="bloco-tipo">${esc(item.rotulo)}</span>
        <div class="bloco-acao">${botoes.join('')}</div>
      </div>
      ${item.titulo ? `<div class="bloco-titulo">${esc(item.titulo)}</div>` : ''}
      <div class="bloco-texto">${esc(item.texto)}</div>
      <div class="bloco-media">
        ${midia.join('')}
      </div>
    </div>`;
}

function renderTelaUnica() {
  if (!estado.roteiro || !estado.artefatos) return;
  const st = estado.artefatos;
  estado.unificado = unificar();

  const itensHtml = estado.unificado.map(renderBloco).join('');

  const podeVideo = st?.imagensCompletas && st?.audioCompleto;
  const problemas = [];
  if (!st?.imagensCompletas) problemas.push('faltam imagens (etapa 2)');
  if (!st?.audioCompleto) problemas.push('faltam narrações (etapa 3)');

  const formato = (estado.config?.FORMATO || '16:9').trim();
  const resPadrao = formato === '9:16' ? '1080,1920' : '1920,1080';
  const selRes = (v) => (v === resPadrao ? ' selected' : '');
  const [wPadrao, hPadrao] = resPadrao.split(',');

  const videos = (st?.videos || [])
    .map((v) => `
      <div class="video-item">
        <div class="video-rotulo">
          <span>
            ${esc(v.arquivo)}${v.existe === false ? ' · inexistente' : ''}
          </span>
          <button class="btn btn-mini btn-perigo" data-action="del-video" data-arquivo="${esc(v.arquivo)}">🗑 excluir</button>
        </div>
        <video class="player-video" controls src="/media/${esc(estado.slug)}/${esc(v.arquivo)}"></video>
      </div>`).join('');

  const tituloVideo = st?.video?.existe
    ? `<span class="badge ok">pronto</span> <span class="msg-progresso">• ${esc(st.video.arquivo)}</span>`
    : `<span class="msg-progresso" style="color:var(--alerta)">sem vídeo ainda</span>`;

  $('#etapa-container').innerHTML = `
    <div class="etapa-topo">
      <h3>Roteiro, imagens, áudio e vídeo</h3>
      <div class="etapa-acoes">
        <button class="btn btn-primario" data-action="montar-video" ${podeVideo ? '' : 'disabled'}>🎬 Montar vídeo</button>
        <button class="btn" data-action="gerar-todas-imagens">🖼 Gerar/atualizar imagens</button>
        <button class="btn" data-action="gerar-todas-narracao">🔊 Gerar/atualizar áudio</button>
        <button class="btn btn-perigo" data-action="regenerar-roteiro">↺ Regenerar roteiro</button>
        <button class="btn btn-primario" data-action="salvar-roteiro">💾 Salvar alterações</button>
      </div>
    </div>
    ${podeVideo ? '' : `<p class="msg-progresso" style="color:var(--alerta)">⚠ ${problemas.join(' · ')}</p>`}
    <div class="bloco-unificado">${itensHtml}</div>

    <section class="bloco-video">
      <div class="etapa-topo">
        <h3>Vídeo final</h3>
        <div class="etapa-acoes">${tituloVideo}</div>
      </div>
      ${podeVideo ? '' : `
        <div class="cartao">
          <div class="video-config">
            <label>FPS
              <select name="cfg-fps" id="cfg-fps"><option>24</option><option selected>30</option><option>60</option></select>
            </label>
            <label>Resolução (formato: ${formato})
              <select name="cfg-res" id="cfg-res">
                <optgroup label="Horizontal 16:9">
                  <option value="3840,2160"${selRes('3840,2160')}>3840×2160 · 4K</option>
                  <option value="1920,1080"${selRes('1920,1080')}>1920×1080 · Full HD</option>
                  <option value="1280,720"${selRes('1280,720')}>1280×720 · HD</option>
                </optgroup>
                <optgroup label="Vertical 9:16 (Reels/TikTok)">
                  <option value="2160,3840"${selRes('2160,3840')}>2160×3840 · 4K vertical</option>
                  <option value="1080,1920"${selRes('1080,1920')}>1080×1920 · Full HD vertical</option>
                  <option value="720,1280"${selRes('720,1280')}>720×1280 · HD vertical</option>
                </optgroup>
                <option value="custom">Personalizado…</option>
              </select>
            </label>
            <label>Largura (custom) <input name="cfg-width" id="cfg-width" type="number" value="${wPadrao}" min="320" step="16" /></label>
            <label>Altura (custom) <input name="cfg-height" id="cfg-height" type="number" value="${hPadrao}" min="240" step="16" /></label>
            <label>Segundos de margem/slide <input name="cfg-padding" id="cfg-padding" type="number" value="0.3" min="0" step="0.1" /></label>
          </div>
          <p class="msg-progresso">O vídeo sai como &lt;slug&gt;-&lt;largura&gt;x&lt;altura&gt;.mp4. Gere um formato por vez (Configurações &gt; FORMATO).</p>
          <div id="area-progresso-video" hidden>
            <div class="msg-progresso" id="msg-progresso-video">Preparando…</div>
            <div class="barra-progresso"><div id="barra-progresso-video"></div></div>
          </div>
        </div>`}
      ${videos}
      ${podeVideo && st.video?.arquivo
        ? `<div class="video-descricao">
             <h4>Descrição do texto</h4>
             <p>${esc(rI().introducao)} ${esc(rI().slides.map((s) => s.narracao).join(' '))} ${esc(rI().conclusao)}</p>
           </div>`
        : ''}
    </section>`;

  // reattach listeners via delegação
}

function rI() {
  return estado.roteiro || { introducao: '', conclusao: '', slides: [] };
}

// ---------------------------------------------------------------------------
// Modal fullscreen de slides
// ---------------------------------------------------------------------------
function abrirModalSlide(i) {
  const slides = estado.artefatos?.slides || [];
  if (!slides.length) return;
  estado.modalIndice = ((i % slides.length) + slides.length) % slides.length;
  const s = slides[estado.modalIndice];
  $('#modal-slide-img').src = `/media/${estado.slug}/slide-${String(s.idx).padStart(2, '0')}.png`;
  $('#modal-slide-img').alt = s.titulo || '';
  $('#modal-slide-contador').textContent = `${s.idx} / ${slides.length}`;
  $('#modal-slide-titulo').textContent = s.titulo || '';
  $('#modal-slide').hidden = false;
  document.body.style.overflow = 'hidden';
}

function fecharModalSlide() {
  $('#modal-slide').hidden = true;
  $('#modal-slide-img').src = '';
  estado.modalIndice = null;
  document.body.style.overflow = '';
}

function navegarModalSlide(delta) {
  if (estado.modalIndice == null) return;
  abrirModalSlide(estado.modalIndice + delta);
}

$('#slide-fechar').onclick = fecharModalSlide;
$('#slide-anterior').onclick = () => navegarModalSlide(-1);
$('#slide-proximo').onclick = () => navegarModalSlide(1);
$('#modal-slide').addEventListener('click', (ev) => {
  if (ev.target === $('#modal-slide')) fecharModalSlide();
});
document.addEventListener('keydown', (ev) => {
  if ($('#modal-slide').hidden) return;
  if (ev.key === 'Escape') fecharModalSlide();
  else if (ev.key === 'ArrowLeft') navegarModalSlide(-1);
  else if (ev.key === 'ArrowRight') navegarModalSlide(1);
});

// ---------------------------------------------------------------------------
// Ações
// ---------------------------------------------------------------------------
async function salvarRoteiro() {
  lerRoteiroDoDOM();
  try {
    await api(`/api/roteiro/${estado.slug}`, { method: 'PUT', body: JSON.stringify(estado.roteiro) });
    await carregarArtefatos();
    toast('Roteiro salvo. Áudios de textos alterados ficam marcados como desatualizados.');
    renderTelaUnica();
  } catch (e) {
    toast(e.message, true);
  }
}

async function regenerarRoteiro() {
  estado.jobAtivo = true;
  sincronizarBotoes();
  try {
    const res = await api('/api/roteiro', { method: 'POST', body: JSON.stringify({ topico: estado.roteiro.topico }) });
    estado.slug = res.slug;
    estado.roteiro = res.roteiro;
    await carregarArtefatos();
    $('#titulo-aula').textContent = estado.roteiro.titulo_aula;
    renderTelaUnica();
    toast('Roteiro regenerado.');
  } catch (e) {
    toast(e.message, true);
  } finally {
    estado.jobAtivo = false;
    sincronizarBotoes();
  }
}

async function cancelarJob() {
  estado.cancelado = true;
  try {
    await api('/api/cancel', { method: 'POST' });
  } catch (e) {
    toast(e.message, true);
    estado.cancelado = false;
  }
}

async function rodarJob(promise, mensagemOk) {
  estado.jobAtivo = true;
  sincronizarBotoes();
  try {
    await promise;
    toast(mensagemOk);
    await carregarArtefatos();
    renderTelaUnica();
  } catch (e) {
    if (estado.cancelado) toast('Job cancelado.');
    else toast(e.message, true);
  } finally {
    estado.jobAtivo = false;
    estado.cancelado = false;
    sincronizarBotoes();
  }
}

function setProgressoVideo(pct, linha) {
  const msg = $('#msg-progresso-video');
  const bar = $('#barra-progresso-video');
  if (!msg || !bar) return;
  msg.textContent = linha;
  bar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
}

function lerRoteiroDoDOM() {
  // a tela única não possui inputs editáveis — os textos estão em divs.
  // (Edição de texto do roteiro é feita via regeneração do roteiro.)
}

let _jobClearT = null;

function formatarMin(s) {
  if (!s || s <= 0) return '';
  return s >= 60 ? `~${Math.round(s / 60)} min` : `~${Math.max(1, s)} s`;
}

function renderStatusJob() {
  const el = $('#status-job');
  const job = estado.job;
  if (!job) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.className = `status-job ${job.status}`;
  const rotulo = NOME_ETAPA[job.etapa] || job.etapa;
  const icone =
    job.status === 'ok' ? '✓' :
    job.status === 'erro' ? '✕' : '🔍';
  const statusTexto = job.status === 'ok' ? `${rotulo} concluída com sucesso` :
    job.status === 'erro' ? (job.cancelado ? `${rotulo} cancelado` : `${rotulo} falhou`) : `${rotulo} em andamento`;
  el.innerHTML = `
    <span class="status-icone">${icone}</span>
    <div class="status-texto">
      <strong>${statusTexto}</strong>
      <span>${esc(job.msg || '')}</span>
      ${job.eta != null ? `<span class="msg-eta">restante ${formatarMin(job.eta)}</span>` : ''}
      ${job.pct != null ? `<div class="barra-progresso status-barra"><div style="width:${Math.max(0, Math.min(100, job.pct))}%"></div></div>` : ''}
    </div>
    ${job.status === 'rodando' ? '<button class="btn btn-mini btn-perigo" id="btn-cancelar-job" title="Encerrar o job atual">⏹ Cancelar</button>' : ''}`;
  const b = $('#btn-cancelar-job');
  if (b) b.onclick = cancelarJob;
}

function sincronizarBotoes() {
  document.querySelectorAll('#etapa-container .btn').forEach((b) => (b.disabled = estado.jobAtivo));
}

// ---------------------------------------------------------------------------
// Delegação de eventos (container unificado)
// ---------------------------------------------------------------------------
$('#etapa-container').addEventListener('click', async (ev) => {
  const img = ev.target.closest('.bloco-img img');
  if (img) {
    const bloco = img.closest('.bloco');
    if (bloco?.dataset.id) abrirModalSlide(bloco.dataset.id);
    return;
  }
  const btn = ev.target.closest('button[data-action]');
  if (!btn) return;
  const acao = btn.dataset.action;
  const slideId = btn.dataset.slide;
  const arquivo = btn.dataset.arquivo;

  if (acao === 'salvar-roteiro') return salvarRoteiro();
  if (acao === 'regenerar-roteiro') return regenerarRoteiro();
  if (acao === 'regen-imagem') {
    return rodarJob(api(`/api/imagens/${estado.slug}`, { method: 'POST', body: JSON.stringify({ slideId, variar: true }) }), 'Imagem regenerada.');
  }
  if (acao === 'del-imagem') {
    if (!confirm(`Excluir a imagem do slide ${slideId}?`)) return;
    return rodarJob(api(`/api/imagens/${estado.slug}`, { method: 'DELETE', body: JSON.stringify({ slideId }) }), 'Imagem excluída.');
  }
  if (acao === 'gerar-todas-imagens') {
    return rodarJob(api(`/api/imagens/${estado.slug}`, { method: 'POST', body: JSON.stringify({}) }), 'Imagens atualizadas.');
  }
  if (acao === 'regen-narracao') {
    return rodarJob(api(`/api/narracao/${estado.slug}`, { method: 'POST', body: JSON.stringify({ slideId }) }), 'Narração regenerada.');
  }
  if (acao === 'del-narracao') {
    if (!confirm(`Excluir a narração "${slideId}"?`)) return;
    return rodarJob(api(`/api/narracao/${estado.slug}`, { method: 'DELETE', body: JSON.stringify({ slideId }) }), 'Narração excluída.');
  }
  if (acao === 'gerar-todas-narracao') {
    return rodarJob(api(`/api/narracao/${estado.slug}`, { method: 'POST', body: JSON.stringify({}) }), 'Narrações atualizadas.');
  }
  if (acao === 'montar-video') {
    const fps = $('#cfg-fps').value;
    const [w, h] = $('#cfg-res').value === 'custom' ? [$('#cfg-width').value, $('#cfg-height').value] : $('#cfg-res').value.split(',');
    const padding = $('#cfg-padding').value;
    setProgressoVideo(0, 'Iniciando montagem…');
    return rodarJob(
      api(`/api/video/${estado.slug}`, { method: 'POST', body: JSON.stringify({ fps: Number(fps), width: Number(w), height: Number(h), padding: Number(padding) }) }),
      'Vídeo montado com sucesso!',
    );
  }
  if (acao === 'del-video') {
    if (!confirm(`Excluir o vídeo "${arquivo}"?`)) return;
    return rodarJob(api(`/api/video/${estado.slug}`, { method: 'DELETE', body: JSON.stringify({ arquivo }) }), 'Vídeo excluído.');
  }
});

// Contador de palavras + valores enquanto digita
$('#etapa-container').addEventListener('input', (ev) => {
  const t = ev.target;
  if (t.dataset && t.dataset.field) {
    const i = t.dataset.slide;
    const s = estado.roteiro.slides[Number(i)];
    if (s && t.dataset.field === 'narracao') {
      s.narracao = t.value;
      const n = contarPalavras(t.value);
      const badge = $(`[data-contador="${i}"]`);
      if (badge) {
        badge.textContent = `${n} palavras`;
        badge.className = `contador ${n >= 35 && n <= 55 ? 'dentro' : 'fora'}`;
      }
    }
  }
});

function contarPalavras(texto) {
  return (texto.trim().match(/\S+/g) || []).length;
}

// ---------------------------------------------------------------------------
// Configurações
// ---------------------------------------------------------------------------
async function abrirConfig() {
  estado.config = await api('/api/config');
  document.querySelectorAll('#modal-config [data-cfg]').forEach((inp) => {
    inp.value = estado.config[inp.dataset.cfg] ?? '';
  });
  $('#modal-config').hidden = false;
}

$('#btn-config').onclick = abrirConfig;
$('#btn-fechar-config').onclick = () => ($('#modal-config').hidden = true);
$('#btn-salvar-config').onclick = async () => {
  const novo = {};
  document.querySelectorAll('#modal-config [data-cfg]').forEach((inp) => (novo[inp.dataset.cfg] = inp.value));
  await api('/api/config', { method: 'PUT', body: JSON.stringify(novo) });
  estado.config = novo;
  $('#modal-config').hidden = true;
  toast('Configurações salvas.');
};

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------
async function carregarAulas() {
  const aulas = await api('/api/aulas');
  const el = $('#lista-aulas');
  el.innerHTML = '';
  if (!aulas.length) {
    el.innerHTML = '<p style="color:var(--texto-3)">Nenhuma aula ainda — crie uma acima.</p>';
    return;
  }
  for (const a of aulas) {
    const card = document.createElement('div');
    card.className = 'card-aula';
    card.onclick = () => abrirAula(a.slug);
    const badges = [
      a.imagensCompletas ? '<span class="badge ok">✓ imagens</span>' : '<span class="badge alerta">imagens</span>',
      a.audioCompleto ? '<span class="badge ok">✓ áudio</span>' : '<span class="badge alerta">áudio</span>',
      a.videoPronto ? '<span class="badge ok">✓ vídeo</span>' : '',
    ].join('');
    card.innerHTML = `
      <h3>${esc(a.titulo_aula)}</h3>
      <div class="meta">${a.slides} slides</div>
      <div class="badges">${badges}</div>`;
    el.appendChild(card);
  }
}

$('#btn-nova-aula').onclick = async () => {
  const topico = $('#input-topico').value.trim();
  if (!topico) return toast('Digite um tópico.', true);
  const slug = slugDe(topico);
  try {
    const aulas = await api('/api/aulas');
    if (aulas.some(a => a.slug === slug)) {
      return toast(`Já existe uma aula com este tópico ("${slug}").`, true);
    }
    // entra na tela da aula imediatamente para mostrar o progresso via SSE
    estado.slug = slug;
    $('#titulo-aula').textContent = topico;
    $('#etapa-container').innerHTML =
      '<div class="cartao"><p class="msg-progresso">⏳ Gerando roteiro… o progresso aparece no banner.</p></div>';
    mostrarTela('aula');
    const res = await api('/api/roteiro', { method: 'POST', body: JSON.stringify({ topico }) });
    $('#input-topico').value = '';
    estado.roteiro = res.roteiro;
    await carregarArtefatos();
    $('#titulo-aula').textContent = estado.roteiro.titulo_aula;
    renderTelaUnica();
    toast('Roteiro gerado! Revise o texto na tela única.');
  } catch (e) {
    toast(e.message, true);
    mostrarTela('dashboard');
  }
};
$('#input-topico').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') $('#btn-nova-aula').click();
});

$('#btn-voltar').onclick = () => mostrarTela('dashboard');
$('#btn-inicio').onclick = () => mostrarTela('dashboard');
$('#btn-atualizar').onclick = async () => {
  if (estado.jobAtivo) return toast('Aguarde o job atual terminar.', true);
  try {
    await Promise.all([carregarRoteiro(), carregarArtefatos()]);
    $('#titulo-aula').textContent = estado.roteiro.titulo_aula;
    renderTelaUnica();
    toast('Aula atualizada.');
  } catch (e) {
    toast(e.message, true);
  }
};

// ---------------------------------------------------------------------------
// Log
// ---------------------------------------------------------------------------
$('#btn-toggle-log').onclick = () => {
  const el = $('#log-linhas');
  el.classList.toggle('aberto');
  $('#btn-toggle-log').textContent = el.classList.contains('aberto') ? '▴ Log das etapas' : '▾ Log das etapas';
  if (el.classList.contains('aberto')) {
    el.innerHTML = '';
    for (const m of estado.logs) adicionarLog(m);
    el.scrollTop = el.scrollHeight;
  }
};
$('#btn-limpar-log').onclick = () => {
  estado.logs = [];
  $('#log-linhas').innerHTML = '';
};

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------
const sse = new EventSource('/api/progresso');
sse.addEventListener('progresso', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.tipo === 'inicio') {
    estado.jobAtivo = true;
    sincronizarBotoes();
    clearTimeout(_jobClearT);
    estado.job = { etapa: msg.etapa, status: 'rodando', msg: 'Preparando…', inicioMs: Date.now(), eta: null };
    renderStatusJob();
  }
  if (msg.tipo === 'progress') {
    if (estado.job?.etapa === msg.etapa) {
      estado.job.status = 'rodando';
      estado.job.msg = msg.linha;
      const m = /\((\d+)%\)$/.exec(msg.linha);
      estado.job.pct = m ? Number(m[1]) : estado.job.pct;
      if (estado.job.etapa === 'imagens') {
        const mi = /\[imagem\s+(\d+)\/(\d+)\]/.exec(msg.linha);
        if (mi && estado.job.inicioMs) {
          const atual = Number(mi[1]);
          const total = Number(mi[2]);
          const porImg = (Date.now() - estado.job.inicioMs) / 1000 / Math.max(1, atual);
          estado.job.eta = Math.round(porImg * Math.max(0, total - atual));
        }
      }
      renderStatusJob();
    }
  }
  if (msg.tipo === 'erro') {
    if (estado.job?.etapa === msg.etapa) {
      estado.job.status = 'erro';
      estado.job.msg = msg.linha;
      renderStatusJob();
    }
  }
  if (msg.tipo === 'log') {
    if (estado.job?.etapa === msg.etapa) {
      estado.job.status = 'rodando';
      estado.job.msg = msg.linha;
      renderStatusJob();
    }
  }
  if (msg.tipo === 'fim') {
    estado.jobAtivo = false;
    sincronizarBotoes();
    if (estado.tela === 'aula') renderTelaUnica();
    estado.job = {
      etapa: msg.etapa,
      status: msg.ok ? 'ok' : 'erro',
      cancelado: !!msg.cancelado,
      msg: msg.ok ? 'Processo finalizado com sucesso.' : (msg.cancelado ? 'Cancelado pelo usuário.' : 'Falha na execução — veja o log.'),
    };
    renderStatusJob();
    clearTimeout(_jobClearT);
    _jobClearT = setTimeout(() => {
      estado.job = null;
      renderStatusJob();
    }, 8000);
  }
  if (msg.etapa === 'video' && msg.tipo === 'progress' && estado.tela === 'aula') {
    const m = /\((\d+)%\)/.exec(msg.linha);
    setProgressoVideo(m ? Number(m[1]) : 0, msg.linha);
  }
  adicionarLog(msg);
});

// ---------------------------------------------------------------------------
// Início
// ---------------------------------------------------------------------------
(async function init() {
  estado.config = await api('/api/config');
  mostrarTela('dashboard');
})();
