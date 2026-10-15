const fs = require('fs');
const path = 'F:/codigos/video-biblico-infantil/web/app.js';
let s = fs.readFileSync(path, 'utf8');

function replaceOnce(haystack, old, rep) {
  if (!haystack.includes(old)) { console.log('NOT FOUND:\n' + old.slice(0, 80)); process.exit(1); }
  return haystack.replace(old, rep);
}

// 1) salvarTextoBloco: aceitar prompt e persistir no slide correspondente
const oldSalva = `async function salvarTextoBloco(itemId, titulo, texto) {
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
    await api(\`/api/roteiro/\${state.slug}\`, { method: 'PUT', body: JSON.stringify(novo) });
    setState({ roteiro: novo });
    await recarregarArtefatos();
    toast('Texto salvo. Áudios com texto alterado ficam marcados para regenerar.');
  } catch (e) { toast(e.message, true); }
}`;
const newSalva = `async function salvarTextoBloco(itemId, titulo, texto, prompt) {
  const r = state.roteiro;
  if (!r) return;
  const novo = { ...r };
  if (itemId === 'intro') {
    novo.titulo_aula = titulo || r.titulo_aula;
    novo.introducao = texto;
  } else if (itemId === 'conclusao') {
    novo.conclusao = texto;
  } else {
    novo.slides = r.slides.map((sl) =>
      sl.id === itemId ? { ...sl, titulo, narracao: texto, imagem_prompt: prompt } : sl
    );
  }
  try {
    await api(\`/api/roteiro/\${state.slug}\`, { method: 'PUT', body: JSON.stringify(novo) });
    setState({ roteiro: novo });
    await recarregarArtefatos();
    toast('Texto e prompt salvos. Áudios/imagens com conteúdo alterado ficam marcados para regenerar.');
  } catch (e) { toast(e.message, true); }
}`;
s = replaceOnce(s, oldSalva, newSalva);

// 2) Bloco: adicionar estado do prompt e editor
const oldBlocoInit = `  // rascunho editável do texto/título (salva por bloco)
  const [tituloDraft, setTituloDraft] = useState(item.titulo || '');
  const [textoDraft, setTextoDraft] = useState(item.texto || '');
  useEffect(() => {
    setTituloDraft(item.titulo || '');
    setTextoDraft(item.texto || '');
  }, [item.texto, item.titulo]);
  const sujo = textoDraft !== (item.texto || '') || (isSlide && tituloDraft !== (item.titulo || ''));
  const palavras = (textoDraft.trim().match(/\\S+/g) || []).length;`;
const newBlocoInit = `  // rascunho editável do texto/título/prompt (salva por bloco)
  const [tituloDraft, setTituloDraft] = useState(item.titulo || '');
  const [textoDraft, setTextoDraft] = useState(item.texto || '');
  const [promptDraft, setPromptDraft] = useState(item.prompt || '');
  useEffect(() => {
    setTituloDraft(item.titulo || '');
    setTextoDraft(item.texto || '');
    setPromptDraft(item.prompt || '');
  }, [item.texto, item.titulo, item.prompt]);
  const sujo = textoDraft !== (item.texto || '') || (isSlide && tituloDraft !== (item.titulo || ''));
  const sujoPrompt = isSlide && promptDraft !== (item.prompt || '');
  const sujoGeral = sujo || sujoPrompt;
  const palavras = (textoDraft.trim().match(/\\S+/g) || []).length;`;
s = replaceOnce(s, oldBlocoInit, newBlocoInit);

// 3) Editor de prompt na coluna de texto (antes do rodapé)
const oldEditor = `          <textarea
            className="edit-texto"
            rows="6"
            placeholder="Texto da narração…"
            value=${textoDraft}
            disabled=${s.jobAtivo}
            onInput=${(e) => setTextoDraft(e.target.value)}
          ></textarea>
          <div className="edit-rodape">`;
const newEditor = `          <textarea
            className="edit-texto"
            rows="6"
            placeholder="Texto da narração…"
            value=${textoDraft}
            disabled=${s.jobAtivo}
            onInput=${(e) => setTextoDraft(e.target.value)}
          ></textarea>
          ${isSlide
            ? html`
              <details className="prompt-editor">
                <summary>${sujoPrompt ? html`<span className="badge alerta pulse">prompt alterado — salve</span>` : null} ▸ Prompt da imagem (como será desenhada esta cena)</summary>
                <textarea
                  className="edit-prompt"
                  rows="4"
                  placeholder="Descrição em inglês da cena para a imagem…"
                  value=${promptDraft}
                  disabled=${s.jobAtivo}
                  onInput=${(e) => setPromptDraft(e.target.value)}
                ></textarea>
              </details>`
            : null}
          <div className="edit-rodape">`;
s = replaceOnce(s, oldEditor, newEditor);

// 4) Botão salvar: desabilitado quando sujoGeral e chama salvarTextoBloco com prompt
const oldBtn = `            <button
              className="btn btn-mini btn-primario"
              disabled=${!sujo || s.jobAtivo}
              title="Salvar este texto no roteiro"
              onClick=${() => salvarTextoBloco(item.id, tituloDraft, textoDraft)}
            >💾 Salvar texto</button>`;
const newBtn = `            <button
              className="btn btn-mini btn-primario"
              disabled=${!sujoGeral || s.jobAtivo}
              title="Salvar texto e prompt deste bloco no roteiro"
              onClick=${() => salvarTextoBloco(item.id, tituloDraft, textoDraft, promptDraft)}
            >💾 Salvar</button>`;
s = replaceOnce(s, oldBtn, newBtn);

// 5) Badge "texto alterado" no cabeçalho: manter, mas também refletir prompt
const oldBadge = `${sujo ? html\`<span className="badge alerta pulse">texto alterado — salve</span>\` : null}`;
const newBadge = `${sujoGeral ? html\`<span className="badge alerta pulse">texto/prompt alterado — salve</span>\` : null}`;
s = replaceOnce(s, oldBadge, newBadge);

fs.writeFileSync(path, s);
console.log('OK app.js patched');