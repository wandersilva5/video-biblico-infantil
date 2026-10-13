/* eslint-disable */
// Frontend React (UMD vendored) + htm — sem build step.
// Rotas por hash: #/ (dashboard) · #/aula/:slug (página do projeto).
const { useState, useEffect, useRef, useSyncExternalStore, useCallback } = React;
const html = htm.bind(React.createElement);

// ---------------------------------------------------------------------------
// Store (estado imutável + hook)
// ---------------------------------------------------------------------------
let state = {
  route: parseHash(),
  config: null,
  aulas: [],
  aulasCarregadas: false,
  slug: null,
  roteiro: null,
  artefatos: null,
  carregandoAula: false,
  job: null,
  jobAtivo: false,
  cancelado: false,
  jobAlvo: null, // slideId quando a ação é de um item específico
  logs: [],
  modalSlide: null, // índice em artefatos.slides
  modalConfig: false,
  toast: null,
};
const listeners = new Set();
function setState(patch) {
  state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
  listeners.forEach((l) => l());
}
function subscribe(l) {
  listeners.add(l);
  return () => listeners.delete(l);
}
function useAppState() {
  return useSyncExternalStore(subscribe, () => state);
}

// ---------------------------------------------------------------------------
// Rotas (hash) — o refresh mantém a página do projeto
// ---------------------------------------------------------------------------
function parseHash() {
  const h = location.hash.replace(/^#/, '') || '/';
  const m = h.match(/^\/aula\/([^/]+)$/);
  if (m) return { tela: 'aula', slug: decodeURIComponent(m[1]) };
  return { tela: 'dashboard', slug: null };
}
function navegarPara(path) {
  location.hash = path;
}

// ---------------------------------------------------------------------------
// API / utilidades
// ---------------------------------------------------------------------------
async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  let data = null;
  try { data = await res.json(); } catch { /* sem corpo */ }
  if (!res.ok) throw new Error(data?.erro || `Erro HTTP ${res.status}`);
  return data;
}
function slugDe(topico) {
  return String(topico).toLowerCase().normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
function toast(msg, erro = false) {
  setState({ toast: { msg, erro, id: Date.now() } });
  setTimeout(() => {
    if (state.toast?.msg === msg) setState({ toast: null });
  }, 4500);
}
function formatarMin(s) {
  if (!s || s <= 0) return '';
  return s >= 60 ? `~${Math.round(s / 60)} min` : `~${Math.max(1, s)} s`;
}

// ---------------------------------------------------------------------------
// Unificação: roteiro + artefatos em uma lista de blocos
// ---------------------------------------------------------------------------
function unificar(roteiro, artefatos) {
  if (!roteiro || !artefatos) return [];
  const r = roteiro;
  const st = artefatos;
  const lista = [];
  const totalSlides = st.slides.length;
  const totalNarra = totalSlides + 2;
  lista.push({
    id: 'intro', tipo: 'abertura', rotulo: 'Abertura',
    titulo: r.titulo_aula, texto: r.introducao,
    prefix: '00-intro', imagem: null, audio: st.intro,
    narraIdx: 1, narraTotal: totalNarra,
  });
  st.slides.forEach((s) => {
    const rs = r.slides.find((x) => x.id === s.id) || {};
    lista.push({
      id: s.id, tipo: 'slide', rotulo: `Slide ${String(s.idx).padStart(2, '0')}`,
      idx: s.idx, titulo: s.titulo, texto: rs.narracao || '',
      prefix: String(s.idx).padStart(2, '0'),
      imagem: s.imagem.existe
        ? { existe: true, desatualizado: !!s.imagem.desatualizado, mtime: s.imagem.mtime }
        : { existe: false, desatualizado: false, mtime: null },
      audio: s.audio,
      narraIdx: s.idx + 1, narraTotal: totalNarra,
    });
  });
  lista.push({
    id: 'conclusao', tipo: 'conclusao', rotulo: 'Conclusão',
    titulo: '', texto: r.conclusao,
    prefix: `${String(totalNarra).padStart(2, '0')}-conclusao`,
    imagem: null, audio: st.conclusao,
    narraIdx: totalNarra, narraTotal: totalNarra,
  });
  return lista;
}

// Item que o job está processando agora (a partir da linha de progresso SSE)
function itemAtivoDoJob(s) {
  if (!s.job || s.job.status !== 'rodando' || !s.job.msg) return null;
  const msg = s.job.msg;
  let m = /imagem\s+(\d+)\/(\d+)/.exec(msg);
  if (m) return { tipo: 'imagem', idx: Number(m[1]), pct: s.job.pct };
  m = /narra[çc][ãa]o\s+(\d+)\/(\d+)/.exec(msg);
  if (m) return { tipo: 'audio', idx: Number(m[1]), pct: s.job.pct };
  // regeneração de um item único (sem contador no log)
  if (s.job.etapa === 'narracao' && s.jobAlvo) return { tipo: 'audio', id: s.jobAlvo, pct: s.job.pct };
  if (s.job.etapa === 'imagens' && s.jobAlvo) return { tipo: 'imagem', id: s.jobAlvo, pct: s.job.pct };
  return null;
}

// ---------------------------------------------------------------------------
// Carregamento de dados
// ---------------------------------------------------------------------------
async function carregarAulas() {
  try {
    const aulas = await api('/api/aulas');
    setState({ aulas, aulasCarregadas: true });
  } catch (e) {
    toast(e.message, true);
    setState({ aulasCarregadas: true });
  }
}
async function abrirAula(slug) {
  setState({ slug, roteiro: null, artefatos: null, carregandoAula: true, modalSlide: null });
  try {
    const [roteiro, artefatos] = await Promise.all([
      api(`/api/roteiro/${slug}`),
      api(`/api/artefatos/${slug}`).catch(() => null),
    ]);
    setState({ roteiro, artefatos, carregandoAula: false });
  } catch (e) {
    setState({ carregandoAula: false });
    // roteiro pode ainda não existir (job de roteiro em andamento)
    if (!state.jobAtivo) {
      toast(e.message, true);
      navegarPara('#/');
    }
  }
}
async function recarregarArtefatos() {
  if (!state.slug) return;
  try {
    const artefatos = await api(`/api/artefatos/${state.slug}`);
    setState({ artefatos });
  } catch { /* pode 404 durante job de roteiro */ }
}

// ---------------------------------------------------------------------------
// Ações
// ---------------------------------------------------------------------------
async function rodarJob(promise, mensagemOk, alvo = null) {
  setState({ jobAtivo: true, cancelado: false, jobAlvo: alvo });
  try {
    await promise;
    toast(mensagemOk);
    await recarregarArtefatos();
  } catch (e) {
    if (state.cancelado) toast('Job cancelado.');
    else toast(e.message, true);
  } finally {
    setState({ jobAtivo: false, cancelado: false, jobAlvo: null });
  }
}
async function cancelarJob() {
  setState({ cancelado: true });
  try {
    await api('/api/cancel', { method: 'POST' });
  } catch (e) {
    toast(e.message, true);
    setState({ cancelado: false });
  }
}
async function salvarRoteiro() {
  try {
    await api(`/api/roteiro/${state.slug}`, { method: 'PUT', body: JSON.stringify(state.roteiro) });
    await recarregarArtefatos();
    toast('Roteiro salvo.');
  } catch (e) { toast(e.message, true); }
}
// Salva o texto (e título) de UM bloco do roteiro — intro, slide ou conclusão.
async function salvarTextoBloco(itemId, titulo, texto) {
  const r = state.roteiro;
  if (!r) return;
  const novo = { ...r };
  if (itemId === 'intro') {
    novo.titulo_aula = titulo || r.titulo_aula;
    novo.introducao = texto;
  } else if (itemId === 'conclusao') {
    novo.conclusao = texto;
  } else {
    novo.slides = r.slides.map((sl) => (sl.id === itemId ? { ...sl, titulo, narracao: texto } : sl));
  }
  try {
    await api(`/api/roteiro/${state.slug}`, { method: 'PUT', body: JSON.stringify(novo) });
    setState({ roteiro: novo });
    await recarregarArtefatos();
    toast('Texto salvo. Áudios com texto alterado ficam marcados para regenerar.');
  } catch (e) { toast(e.message, true); }
}
async function regenerarRoteiro() {
  if (!state.roteiro?.topico) return toast('Sem tópico para regenerar.', true);
  setState({ jobAtivo: true });
  try {
    const res = await api('/api/roteiro', { method: 'POST', body: JSON.stringify({ topico: state.roteiro.topico }) });
    setState({ roteiro: res.roteiro });
    await recarregarArtefatos();
    toast('Roteiro regenerado.');
  } catch (e) { toast(e.message, true); }
  finally { setState({ jobAtivo: false }); }
}
async function criarAula(topico) {
  const slug = slugDe(topico);
  try {
    const aulas = await api('/api/aulas');
    if (aulas.some((a) => a.slug === slug)) {
      return toast(`Já existe uma historinha com este tópico.`, true);
    }
  } catch { /* segue mesmo assim */ }
  // navega já (a URL persiste no refresh); o POST gera o roteiro
  navegarPara(`#/aula/${slug}`);
  setState({ slug, roteiro: null, artefatos: null, carregandoAula: true });
  try {
    const res = await api('/api/roteiro', { method: 'POST', body: JSON.stringify({ topico }) });
    setState({ roteiro: res.roteiro, carregandoAula: false });
    await recarregarArtefatos();
    toast('Roteiro gerado! Revise o texto na tela única.');
  } catch (e) {
    setState({ carregandoAula: false });
    toast(e.message, true);
    navegarPara('#/');
  }
}

// ---------------------------------------------------------------------------
// SSE + polling (imagens/narração aparecem assim que prontas)
// ---------------------------------------------------------------------------
let pollT = null;
function iniciarPolling() {
  if (pollT) return;
  pollT = setInterval(async () => {
    if (!state.jobAtivo || !state.slug) { pararPolling(); return; }
    const etapa = state.job?.etapa;
    if (etapa !== 'imagens' && etapa !== 'narracao') return;
    await recarregarArtefatos();
  }, 4000);
}
function pararPolling() {
  clearInterval(pollT);
  pollT = null;
}

function conectarSSE() {
  const sse = new EventSource('/api/progresso');
  sse.addEventListener('progresso', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    // log
    setState((s) => ({ logs: [...s.logs.slice(-399), msg] }));
    if (msg.tipo === 'inicio') {
      clearTimeout(conectarSSE._clearT);
      setState({
        jobAtivo: true,
        job: { etapa: msg.etapa, status: 'rodando', msg: 'Preparando…', inicioMs: Date.now(), eta: null, pct: null },
      });
      if (msg.etapa === 'imagens' || msg.etapa === 'narracao') iniciarPolling();
    }
    if ((msg.tipo === 'progress' || msg.tipo === 'log' || msg.tipo === 'ok') && state.job?.etapa === msg.etapa) {
      const job = { ...state.job, status: 'rodando', msg: msg.linha };
      const m = /\((\d+)%\)$/.exec(msg.linha || '');
      if (m) job.pct = Number(m[1]);
      if (msg.etapa === 'imagens') {
        const mi = /imagem\s+(\d+)\/(\d+)/.exec(msg.linha || '');
        if (mi && job.inicioMs) {
          const atual = Number(mi[1]);
          const total = Number(mi[2]);
          const porImg = (Date.now() - job.inicioMs) / 1000 / Math.max(1, atual);
          job.eta = Math.round(porImg * Math.max(0, total - atual));
        }
      }
      setState({ job });
    }
    if (msg.tipo === 'erro' && state.job?.etapa === msg.etapa) {
      setState({ job: { ...state.job, status: 'erro', msg: msg.linha } });
    }
    if (msg.tipo === 'fim') {
      setState({ jobAtivo: false, jobAlvo: null });
      pararPolling();
      if (state.route.tela === 'aula') recarregarArtefatos();
      setState({
        job: {
          etapa: msg.etapa,
          status: msg.ok ? 'ok' : 'erro',
          cancelado: !!msg.cancelado,
          msg: msg.ok ? 'Concluído com sucesso.' : (msg.cancelado ? 'Cancelado pelo usuário.' : 'Falha na execução — veja o log.'),
        },
      });
      clearTimeout(conectarSSE._clearT);
      conectarSSE._clearT = setTimeout(() => setState({ job: null }), 8000);
    }
  });
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------
function Topo() {
  const s = useAppState();
  return html`
    <header className="topo">
      <div className="topo-inner">
        <button className="brand" onClick=${() => navegarPara('#/')} title="Início">
          <span className="logo">✦</span>
          <span>Historinhas Bíblicas Infantis</span>
        </button>
        <div className="topo-acoes">
          <button className="btn btn-ghost" onClick=${() => setState({ modalConfig: true })} title="Configurações">⚙</button>
        </div>
      </div>
    </header>`;
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------
function Dashboard() {
  const s = useAppState();
  const [topico, setTopico] = useState('');
  useEffect(() => { carregarAulas(); }, []);
  const submeter = () => {
    const t = topico.trim();
    if (!t) return toast('Digite um tópico.', true);
    setTopico('');
    criarAula(t);
  };
  return html`
    <section className="tela ativa">
      <div className="container">
        <h1 className="titulo-pagina">Historinhas</h1>
        <div className="nova-aula">
          <input
            type="text"
            placeholder='Ex.: "A Arca de Noé"'
            value=${topico}
            onInput=${(e) => setTopico(e.target.value)}
            onKeyDown=${(e) => { if (e.key === 'Enter') submeter(); }}
          />
          <button className="btn btn-primario" onClick=${submeter} disabled=${s.jobAtivo}>Criar nova historinha</button>
        </div>
        ${!s.aulasCarregadas
          ? html`<p style=${{ color: 'var(--texto-3)' }}>Carregando…</p>`
          : !s.aulas.length
            ? html`<p style=${{ color: 'var(--texto-3)' }}>Nenhuma historinha ainda — crie uma acima.</p>`
            : html`<div className="grid-aulas">
                ${s.aulas.map((a) => html`<${CardAula} key=${a.slug} aula=${a} />`)}
              </div>`}
      </div>
    </section>`;
}
function CardAula({ aula }) {
  return html`
    <div className="card-aula" onClick=${() => navegarPara(`#/aula/${aula.slug}`)}>
      <h3>${aula.titulo_aula}</h3>
      <div className="meta">${aula.slides} slides</div>
      <div className="badges">
        ${aula.imagensCompletas ? html`<span className="badge ok">✓ imagens</span>` : html`<span className="badge alerta">imagens</span>`}
        ${aula.audioCompleto ? html`<span className="badge ok">✓ áudio</span>` : html`<span className="badge alerta">áudio</span>`}
        ${aula.videoPronto ? html`<span className="badge ok">✓ vídeo</span>` : null}
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Página do projeto (tela única)
// ---------------------------------------------------------------------------
function AulaPage() {
  const s = useAppState();
  const slug = s.route.slug;

  useEffect(() => {
    if (slug && slug !== state.slug) abrirAula(slug);
  }, [slug]);

  if (s.carregandoAula && !s.roteiro) {
    return html`
      <section className="tela ativa">
        <div className="conteudo-full">
          <div className="caminho">
            <button className="btn btn-ghost" onClick=${() => navegarPara('#/')}>← Historinhas</button>
            <h2>${slug}</h2>
          </div>
          <${StatusJob} />
          <div className="cartao">
            <p className="msg-progresso">⏳ Carregando…</p>
          </div>
        </div>
      </section>`;
  }
  if (!s.roteiro) {
    // sem roteiro e sem carga — job de roteiro em andamento ou erro
    return html`
      <section className="tela ativa">
        <div className="conteudo-full">
          <div className="caminho">
            <button className="btn btn-ghost" onClick=${() => navegarPara('#/')}>← Historinhas</button>
            <h2>${slug}</h2>
          </div>
          <${StatusJob} />
          <div className="cartao">
            <p className="msg-progresso">
              ${s.jobAtivo ? '⏳ Gerando roteiro… o progresso aparece no banner.' : 'Roteiro não encontrado.'}
            </p>
            ${!s.jobAtivo ? html`<button className="btn" onClick=${() => navegarPara('#/')}>Voltar</button>` : null}
          </div>
        </div>
      </section>`;
  }

  const itens = unificar(s.roteiro, s.artefatos);
  const ativo = itemAtivoDoJob(s);
  const st = s.artefatos;
  const podeVideo = st?.imagensCompletas && st?.audioCompleto;
  const problemas = [];
  if (st && !st.imagensCompletas) problemas.push('faltam imagens');
  if (st && !st.audioCompleto) problemas.push('faltam narrações');

  return html`
    <section className="tela ativa">
      <div className="conteudo-full">
        <div className="caminho">
          <button className="btn btn-ghost" onClick=${() => navegarPara('#/')}>← Historinhas</button>
          <h2>${s.roteiro.titulo_aula}</h2>
          <button className="btn btn-ghost btn-mini" title="Recarregar" onClick=${() => { recarregarArtefatos(); api(`/api/roteiro/${slug}`).then((r) => setState({ roteiro: r })).catch(() => {}); }}>↻</button>
          <div className="spacer"></div>
        </div>
        <${StatusJob} />
        <div className="etapa-topo">
          <h3>Roteiro, imagens, áudio e vídeo</h3>
          <div className="etapa-acoes">
            <button className="btn btn-primario" disabled=${!podeVideo || s.jobAtivo} onClick=${montarVideo}>🎬 Montar vídeo</button>
            <button className="btn" disabled=${s.jobAtivo} onClick=${() => rodarJob(api(`/api/imagens/${slug}`, { method: 'POST', body: JSON.stringify({}) }), 'Imagens atualizadas.')}>🖼 Gerar imagens</button>
            <button className="btn" disabled=${s.jobAtivo} onClick=${() => rodarJob(api(`/api/narracao/${slug}`, { method: 'POST', body: JSON.stringify({}) }), 'Narrações atualizadas.')}>🔊 Gerar áudio</button>
            <button className="btn btn-perigo" disabled=${s.jobAtivo} onClick=${regenerarRoteiro}>↺ Regenerar roteiro</button>
            <button className="btn btn-primario" disabled=${s.jobAtivo} onClick=${salvarRoteiro}>💾 Salvar</button>
          </div>
        </div>
        ${podeVideo ? null : html`<p className="msg-progresso alerta-texto">⚠ ${problemas.join(' · ') || 'aguardando artefatos…'}</p>`}
        <div className="bloco-unificado">
          ${itens.map((item) => html`<${Bloco} key=${item.id} item=${item} ativo=${ativo} />`)}
        </div>
        <${SecaoVideo} />
        <${PainelLog} />
      </div>
    </section>`;
}

function montarVideo() {
  const s = state;
  const fps = document.getElementById('cfg-fps')?.value || '30';
  const res = document.getElementById('cfg-res')?.value || '1920,1080';
  const padding = document.getElementById('cfg-padding')?.value || '0.3';
  const [w, h] = res === 'custom'
    ? [document.getElementById('cfg-width')?.value, document.getElementById('cfg-height')?.value]
    : res.split(',');
  rodarJob(
    api(`/api/video/${s.slug}`, { method: 'POST', body: JSON.stringify({ fps: Number(fps), width: Number(w), height: Number(h), padding: Number(padding) }) }),
    'Vídeo montado com sucesso!',
  );
}

// ---------------------------------------------------------------------------
// Bloco (intro / slide / conclusão)
// ---------------------------------------------------------------------------
function Bloco({ item, ativo }) {
  const s = useAppState();
  const isSlide = item.tipo === 'slide';
  const gerandoImagem = isSlide && ativo?.tipo === 'imagem' && (ativo.idx === item.idx || ativo.id === item.id);
  const gerandoAudio = ativo?.tipo === 'audio' && (ativo.idx === item.narraIdx || ativo.id === item.id);
  const temImagem = item.imagem?.existe;
  const temAudio = item.audio?.existe;

  // rascunho editável do texto/título (salva por bloco)
  const [tituloDraft, setTituloDraft] = useState(item.titulo || '');
  const [textoDraft, setTextoDraft] = useState(item.texto || '');
  useEffect(() => {
    setTituloDraft(item.titulo || '');
    setTextoDraft(item.texto || '');
  }, [item.texto, item.titulo]);
  const sujo = textoDraft !== (item.texto || '') || (isSlide && tituloDraft !== (item.titulo || ''));
  const palavras = (textoDraft.trim().match(/\S+/g) || []).length;

  const regenImagem = () => rodarJob(
    api(`/api/imagens/${s.slug}`, { method: 'POST', body: JSON.stringify({ slideId: item.id, variar: true }) }),
    'Imagem regenerada.', item.id);
  const gerarImagem = () => rodarJob(
    api(`/api/imagens/${s.slug}`, { method: 'POST', body: JSON.stringify({ slideId: item.id }) }),
    'Imagem gerada.', item.id);
  const delImagem = () => {
    if (confirm(`Excluir a imagem do slide ${item.id}?`)) {
      rodarJob(api(`/api/imagens/${s.slug}`, { method: 'DELETE', body: JSON.stringify({ slideId: item.id }) }), 'Imagem excluída.', item.id);
    }
  };
  const regenAudio = () => rodarJob(
    api(`/api/narracao/${s.slug}`, { method: 'POST', body: JSON.stringify({ slideId: item.id }) }),
    'Narração regenerada.', item.id);
  const delAudio = () => {
    if (confirm(`Excluir a narração "${item.rotulo}"?`)) {
      rodarJob(api(`/api/narracao/${s.slug}`, { method: 'DELETE', body: JSON.stringify({ slideId: item.id }) }), 'Narração excluída.', item.id);
    }
  };

  return html`
    <div className="bloco" data-id=${item.id}>
      <div className="bloco-cab">
        <span className="bloco-tipo">${item.rotulo}</span>
        ${sujo ? html`<span className="badge alerta pulse">texto alterado — salve</span>` : null}
      </div>
      <div className=${`bloco-grid ${isSlide ? '' : 'sem-img'}`}>
        <div className="bloco-col bloco-col-texto">
          ${item.tipo !== 'conclusao'
            ? html`<input
                className="edit-titulo"
                type="text"
                placeholder="Título do bloco"
                value=${tituloDraft}
                disabled=${s.jobAtivo}
                onInput=${(e) => setTituloDraft(e.target.value)}
              />`
            : null}
          <textarea
            className="edit-texto"
            rows="6"
            placeholder="Texto da narração…"
            value=${textoDraft}
            disabled=${s.jobAtivo}
            onInput=${(e) => setTextoDraft(e.target.value)}
          ></textarea>
          <div className="edit-rodape">
            <span className=${`contador ${palavras >= 20 && palavras <= 45 ? 'dentro' : 'fora'}`}>${palavras} palavras</span>
            <button
              className="btn btn-mini btn-primario"
              disabled=${!sujo || s.jobAtivo}
              title="Salvar este texto no roteiro"
              onClick=${() => salvarTextoBloco(item.id, tituloDraft, textoDraft)}
            >💾 Salvar texto</button>
          </div>
        </div>
        ${isSlide
          ? html`
            <div className="bloco-col bloco-col-img">
              ${temImagem
                ? html`
                  <div className="thumb-wrap" title="Clique para ver em tela cheia" onClick=${() => abrirModalSlidePara(item.id)}>
                    <img
                      src=${`/media/${s.slug}/slide-${String(item.idx).padStart(2, '0')}.png?v=${item.imagem.mtime ?? item.idx}`}
                      alt=${item.titulo}
                      loading="lazy"
                    />
                    <span className="thumb-zoom">🔍</span>
                    ${item.imagem.desatualizado ? html`<div className="sobreposto-desatualizado">prompt alterado</div>` : null}
                    ${gerandoImagem ? html`<div className="overlay-regen">↻ regenerando…</div>` : null}
                  </div>`
                : html`
                  <div className="thumb-wrap vazio ${gerandoImagem ? 'gerando' : ''}">
                    ${gerandoImagem
                      ? html`<${ProgressoItem} pct=${ativo.pct} rotulo="gerando imagem…" />`
                      : html`<span className="msg-progresso">imagem pendente</span>`}
                  </div>`}
              <div className="bloco-acao">
                ${temImagem
                  ? html`
                    <button className="btn btn-mini regen" disabled=${s.jobAtivo} title="Regenerar esta imagem (seed nova)" onClick=${regenImagem}>↻ refazer</button>
                    <button className="btn btn-mini btn-perigo" disabled=${s.jobAtivo} title="Excluir esta imagem" onClick=${delImagem}>🗑</button>`
                  : html`
                    <button className="btn btn-mini regen" disabled=${s.jobAtivo || gerandoImagem} title="Gerar esta imagem" onClick=${gerarImagem}>🖼 gerar</button>`}
              </div>
            </div>`
          : null}
        <div className="bloco-col bloco-col-audio">
          <div className="audio-area">
            ${temAudio
              ? html`
                <audio controls preload="none" src=${`/media/${s.slug}/${item.prefix}-narracao.mp3?v=${item.audio.mtime ?? 0}`}></audio>
                <div className="audio-badges">
                  ${item.audio.desatualizado ? html`<span className="badge alerta">texto alterado</span>` : html`<span className="badge ok">ok</span>`}
                  ${gerandoAudio ? html`<span className="badge alerta pulse">↻ regenerando</span>` : null}
                </div>`
              : gerandoAudio
                ? html`<${ProgressoItem} pct=${ativo.pct} rotulo="gerando áudio…" />`
                : html`<span className="msg-progresso">sem áudio ainda</span>`}
          </div>
          <div className="bloco-acao">
            <button className="btn btn-mini regen" disabled=${s.jobAtivo || gerandoAudio} title="Regenerar o áudio deste bloco" onClick=${regenAudio}>↻ refazer áudio</button>
            ${temAudio
              ? html`<button className="btn btn-mini btn-perigo" disabled=${s.jobAtivo} title="Excluir este áudio" onClick=${delAudio}>🗑</button>`
              : null}
          </div>
        </div>
      </div>
    </div>`;
}

function abrirModalSlidePara(slideId) {
  const slides = state.artefatos?.slides || [];
  const i = slides.findIndex((x) => x.id === slideId);
  if (i >= 0) setState({ modalSlide: i });
}

function ProgressoItem({ pct, rotulo }) {
  const p = Math.max(4, Math.min(100, pct ?? 8));
  return html`
    <div className="prog-item">
      <div className="prog-item-rotulo">${rotulo}</div>
      <div className="barra-progresso"><div style=${{ width: `${p}%` }}></div></div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Seção de vídeo
// ---------------------------------------------------------------------------
function SecaoVideo() {
  const s = useAppState();
  const st = s.artefatos;
  if (!st) return null;
  const podeVideo = st.imagensCompletas && st.audioCompleto;
  const formato = (s.config?.FORMATO || '16:9').trim();
  const resPadrao = formato === '9:16' ? '1080,1920' : '1920,1080';
  const [wPadrao, hPadrao] = resPadrao.split(',');
  const videos = (st.videos || []).map((v) => html`
    <div className="video-item" key=${v.arquivo}>
      <div className="video-rotulo">
        <span>${v.arquivo}${v.existe === false ? ' · inexistente' : ''}</span>
        <button className="btn btn-mini btn-perigo" disabled=${s.jobAtivo}
          onClick=${() => { if (confirm(`Excluir o vídeo "${v.arquivo}"?`)) rodarJob(api(`/api/video/${s.slug}`, { method: 'DELETE', body: JSON.stringify({ arquivo: v.arquivo }) }), 'Vídeo excluído.'); }}>🗑 excluir</button>
      </div>
      <video className="player-video" controls src=${`/media/${s.slug}/${v.arquivo}`}></video>
    </div>`);

  return html`
    <section className="bloco-video">
      <div className="etapa-topo">
        <h3>Vídeo final</h3>
        <div className="etapa-acoes">
          ${st.video?.existe
            ? html`<span className="badge ok">pronto</span> <span className="msg-progresso">• ${st.video.arquivo}</span>`
            : html`<span className="msg-progresso alerta-texto">sem vídeo ainda</span>`}
        </div>
      </div>
      ${!podeVideo
        ? html`
          <div className="cartao">
            <div className="video-config">
              <label>FPS
                <select id="cfg-fps"><option>24</option><option selected>30</option><option>60</option></select>
              </label>
              <label>Resolução (formato: ${formato})
                <select id="cfg-res">
                  <optgroup label="Horizontal 16:9">
                    <option value="3840,2160">3840×2160 · 4K</option>
                    <option value="1920,1080" selected=${resPadrao === '1920,1080'}>1920×1080 · Full HD</option>
                    <option value="1280,720">1280×720 · HD</option>
                  </optgroup>
                  <optgroup label="Vertical 9:16 (Reels/TikTok)">
                    <option value="2160,3840">2160×3840 · 4K vertical</option>
                    <option value="1080,1920" selected=${resPadrao === '1080,1920'}>1080×1920 · Full HD vertical</option>
                    <option value="720,1280">720×1280 · HD vertical</option>
                  </optgroup>
                  <option value="custom">Personalizado…</option>
                </select>
              </label>
              <label>Largura (custom) <input id="cfg-width" type="number" value=${wPadrao} min="320" step="16" /></label>
              <label>Altura (custom) <input id="cfg-height" type="number" value=${hPadrao} min="240" step="16" /></label>
              <label>Margem/slide (s) <input id="cfg-padding" type="number" value="0.3" min="0" step="0.1" /></label>
            </div>
            <p className="msg-progresso">Gere um formato por vez (Configurações &gt; FORMATO).</p>
          </div>`
        : null}
      <div id="area-progresso-video">
        ${s.job?.etapa === 'video' && s.job.status === 'rodando'
          ? html`
              <div className="msg-progresso">${s.job.msg}</div>
              <div className="barra-progresso"><div style=${{ width: `${Math.max(0, Math.min(100, s.job.pct ?? 0))}%` }}></div></div>`
          : null}
      </div>
      ${videos}
      ${podeVideo && st.video?.arquivo && s.roteiro
        ? html`
          <div className="video-descricao">
            <h4>Descrição do texto</h4>
            <p>${s.roteiro.introducao} ${s.roteiro.slides.map((x) => x.narracao).join(' ')} ${s.roteiro.conclusao}</p>
          </div>`
        : null}
    </section>`;
}

// ---------------------------------------------------------------------------
// Status do job (banner)
// ---------------------------------------------------------------------------
function StatusJob() {
  const s = useAppState();
  if (!s.job) return null;
  const NOME = { roteiro: 'Roteiro', imagens: 'Imagens', narracao: 'Narração', video: 'Vídeo' };
  const rotulo = NOME[s.job.etapa] || s.job.etapa;
  const icone = s.job.status === 'ok' ? '✓' : s.job.status === 'erro' ? '✕' : '🔍';
  const statusTexto = s.job.status === 'ok' ? `${rotulo} concluída` :
    s.job.status === 'erro' ? (s.job.cancelado ? `${rotulo} cancelado` : `${rotulo} falhou`) : `${rotulo} em andamento`;
  return html`
    <div className=${`status-job ${s.job.status}`}>
      <span className="status-icone">${icone}</span>
      <div className="status-texto">
        <strong>${statusTexto}</strong>
        <span>${s.job.msg || ''}</span>
        ${s.job.eta != null ? html`<span className="msg-eta">restante ${formatarMin(s.job.eta)}</span>` : null}
        ${s.job.pct != null && s.job.status === 'rodando'
          ? html`<div className="barra-progresso status-barra"><div style=${{ width: `${Math.max(0, Math.min(100, s.job.pct))}%` }}></div></div>`
          : null}
      </div>
      ${s.job.status === 'rodando'
        ? html`<button className="btn btn-mini btn-perigo" id="btn-cancelar-job" onClick=${cancelarJob}>⏹ Cancelar</button>`
        : null}
    </div>`;
}

// ---------------------------------------------------------------------------
// Log
// ---------------------------------------------------------------------------
function PainelLog() {
  const s = useAppState();
  const [aberto, setAberto] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (aberto && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [aberto, s.logs.length]);
  return html`
    <section className="painel-log">
      <div className="painel-log-topo">
        <button className="btn btn-ghost" onClick=${() => setAberto(!aberto)}>${aberto ? '▴' : '▾'} Log das etapas</button>
        <button className="btn btn-ghost btn-mini" onClick=${() => setState({ logs: [] })}>Limpar</button>
      </div>
      <div ref=${ref} className=${`log-linhas ${aberto ? 'aberto' : ''}`}>
        ${s.logs.map((m, i) => html`
          <div key=${i} className=${`log-linha ${m.tipo || 'log'}`}>
            <span className="hora">${new Date(m.ts).toLocaleTimeString('pt-BR')}</span>${m.linha || m.tipo}
          </div>`)}
      </div>
    </section>`;
}

// ---------------------------------------------------------------------------
// Modal de configurações
// ---------------------------------------------------------------------------
const CAMPOS_CONFIG = [
  ['LLAMA_URL', 'LLAMA_URL'],
  ['COMFY_URL', 'COMFY_URL'],
  ['COMFY_OUTPUT_DIR', 'COMFY_OUTPUT_DIR'],
  ['ZIMAGE_UNET', 'ZIMAGE_UNET'],
  ['ZIMAGE_CLIP', 'ZIMAGE_CLIP'],
  ['ZIMAGE_VAE', 'ZIMAGE_VAE'],
  ['ZIMAGE_LORA', 'ZIMAGE_LORA'],
  ['ZIMAGE_STEPS', 'ZIMAGE_STEPS'],
  ['ZIMAGE_LORA_STRENGTH', 'ZIMAGE_LORA_STRENGTH'],
];
function ModalConfig() {
  const s = useAppState();
  const [form, setForm] = useState(null);
  useEffect(() => {
    if (s.modalConfig && !form) {
      api('/api/config').then((cfg) => setForm({ ...cfg })).catch((e) => { toast(e.message, true); setState({ modalConfig: false }); });
    }
  }, [s.modalConfig]);
  if (!s.modalConfig || !form) return null;
  const set = (k, v) => setForm({ ...form, [k]: v });
  const salvar = async () => {
    try {
      await api('/api/config', { method: 'PUT', body: JSON.stringify(form) });
      setState({ config: form, modalConfig: false });
      toast('Configurações salvas.');
    } catch (e) { toast(e.message, true); }
  };
  return html`
    <div className="modal" onClick=${(e) => { if (e.target === e.currentTarget) setState({ modalConfig: false }); }}>
      <div className="modal-janela">
        <h3>Configurações</h3>
        ${CAMPOS_CONFIG.map(([k, label]) => html`
          <label key=${k}>${label}
            <input type="text" value=${form[k] ?? ''} onInput=${(e) => set(k, e.target.value)} />
          </label>`)}
        <label>CLIP na RAM ou GPU (QWEN_CLIP_DEVICE)
          <select value=${form.QWEN_CLIP_DEVICE || 'cpu'} onChange=${(e) => set('QWEN_CLIP_DEVICE', e.target.value)}>
            <option value="cpu">cpu (RAM — recomendado em 8GB de VRAM)</option>
            <option value="default">default (GPU)</option>
          </select>
        </label>
        <label>MIN_SLIDES (cenas por história)
          <input type="number" min="4" max="30" value=${form.MIN_SLIDES ?? ''} onInput=${(e) => set('MIN_SLIDES', e.target.value)} />
        </label>
        <label>VOZ_RATE (ritmo) <input type="text" value=${form.VOZ_RATE ?? ''} onInput=${(e) => set('VOZ_RATE', e.target.value)} /></label>
        <label>VOZ_PITCH (tom) <input type="text" value=${form.VOZ_PITCH ?? ''} onInput=${(e) => set('VOZ_PITCH', e.target.value)} /></label>
        <label>Motor de TTS
          <select value=${form.TTS || 'edge-tts'} onChange=${(e) => set('TTS', e.target.value)}>
            <option value="edge-tts">edge-tts</option>
            <option value="qwen">qwen (clone da Bia)</option>
          </select>
        </label>
        <label>VOZ (edge-tts) <input type="text" value=${form.VOZ ?? ''} onInput=${(e) => set('VOZ', e.target.value)} /></label>
        <label>FORMATO (16:9 ou 9:16)
          <select value=${form.FORMATO || '16:9'} onChange=${(e) => set('FORMATO', e.target.value)}>
            <option value="16:9">16:9 (YouTube)</option>
            <option value="9:16">9:16 (Reels/TikTok/Shorts)</option>
          </select>
        </label>
        <label>PORTA <input type="number" value=${form.PORTA ?? ''} onInput=${(e) => set('PORTA', e.target.value)} /></label>
        <div className="modal-acoes">
          <button className="btn btn-ghost" onClick=${() => setState({ modalConfig: false })}>Fechar</button>
          <button className="btn btn-primario" onClick=${salvar}>Salvar</button>
        </div>
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Modal fullscreen de slides
// ---------------------------------------------------------------------------
function ModalSlide() {
  const s = useAppState();
  const slides = s.artefatos?.slides || [];
  const idx = s.modalSlide;
  useEffect(() => {
    if (idx == null) { document.body.style.overflow = ''; return; }
    document.body.style.overflow = 'hidden';
    const onKey = (e) => {
      if (e.key === 'Escape') setState({ modalSlide: null });
      else if (e.key === 'ArrowLeft') setState({ modalSlide: (state.modalSlide - 1 + slides.length) % slides.length });
      else if (e.key === 'ArrowRight') setState({ modalSlide: (state.modalSlide + 1) % slides.length });
    };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = ''; };
  }, [idx != null, slides.length]);
  if (idx == null || !slides[idx]) return null;
  const sl = slides[idx];
  const nav = (d) => setState({ modalSlide: (idx + d + slides.length) % slides.length });
  return html`
    <div className="modal modal-slide" onClick=${(e) => { if (e.target === e.currentTarget) setState({ modalSlide: null }); }}>
      <button className="slide-fechar" onClick=${() => setState({ modalSlide: null })} title="Fechar (Esc)">✕</button>
      <button className="slide-nav nav-anterior" onClick=${() => nav(-1)} title="Anterior (←)">‹</button>
      <figure className="modal-slide-fig">
        <img src=${`/media/${s.slug}/slide-${String(sl.idx).padStart(2, '0')}.png`} alt=${sl.titulo || ''} />
        <figcaption>
          <span className="slide-contador">${sl.idx} / ${slides.length}</span>
          <span className="slide-titulo">${sl.titulo || ''}</span>
        </figcaption>
      </figure>
      <button className="slide-nav nav-proximo" onClick=${() => nav(1)} title="Próximo (→)">›</button>
    </div>`;
}

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------
function Toast() {
  const s = useAppState();
  if (!s.toast) return null;
  return html`<div className=${`toast ${s.toast.erro ? 'erro' : ''}`}>${s.toast.msg}</div>`;
}

// ---------------------------------------------------------------------------
// App + init
// ---------------------------------------------------------------------------
function App() {
  const s = useAppState();
  useEffect(() => {
    conectarSSE();
    api('/api/config').then((c) => setState({ config: c })).catch(() => {});
    const onHash = () => {
      const r = parseHash();
      setState({ route: r });
      if (r.tela === 'aula' && r.slug !== state.slug) abrirAula(r.slug);
      if (r.tela === 'dashboard') carregarAulas();
    };
    window.addEventListener('hashchange', onHash);
    // rota inicial
    onHash();
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return html`
    <${Topo} />
    <main id="app">
      ${s.route.tela === 'aula' ? html`<${AulaPage} />` : html`<${Dashboard} />`}
    </main>
    <${ModalConfig} />
    <${ModalSlide} />
    <${Toast} />`;
}

ReactDOM.createRoot(document.getElementById('root')).render(html`<${App} />`);
