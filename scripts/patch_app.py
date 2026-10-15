import io, sys

path = 'F:/codigos/video-biblico-infantil/web/app.js'
with io.open(path, 'r', encoding='utf-8') as f:
    s = f.read()

def rep(old, new, label):
    global s
    if old not in s:
        print('NOT FOUND:', label)
        sys.exit(1)
    s = s.replace(old, new, 1)
    print('OK:', label)

# 1) salvarTextoBloco
rep(
"""async function salvarTextoBloco(itemId, titulo, texto) {
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
}""",
"""async function salvarTextoBloco(itemId, titulo, texto, prompt) {
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
    await api(`/api/roteiro/${state.slug}`, { method: 'PUT', body: JSON.stringify(novo) });
    setState({ roteiro: novo });
    await recarregarArtefatos();
    toast('Texto e prompt salvos. Áudios/imagens com conteúdo alterado ficam marcados para regenerar.');
  } catch (e) { toast(e.message, true); }
}""",
'salvarTextoBloco')

# 2) estados do bloco
rep(
"""  // rascunho editável do texto/título (salva por bloco)
  const [tituloDraft, setTitloDraft] = useState(item.titulo || '');
  const [textoDraft, setTextoDraft] = useState(item.texto || '');
  useEffect(() => {
    setTitloDraft(item.titulo || '');
    setTextoDraft(item.texto || '');
  }, [item.texto, item.titulo]);
  const sujo = textoDraft !== (item.texto || '') || (isSlide && tituloDraft !== (item.titulo || ''));
  const palavras = (textoDraft.trim().match(/\\S+/g) || []).length;""",
"""  // rascunho editável do texto/título/prompt (salva por bloco)
  const [tituloDraft, setTitloDraft] = useState(item.titulo || '');
  const [textoDraft, setTextoDraft] = useState(item.texto || '');
  const [promptDraft, setPromptDraft] = useState(item.prompt || '');
  useEffect(() => {
    setTitloDraft(item.titulo || '');
    setTextoDraft(item.texto || '');
    setPromptDraft(item.prompt || '');
  }, [item.texto, item.titulo, item.prompt]);
  const sujo = textoDraft !== (item.texto || '') || (isSlide && tituloDraft !== (item.titulo || ''));
  const sujoPrompt = isSlide && promptDraft !== (item.prompt || '');
  const sujoGeral = sujo || sujoPrompt;
  const palavras = (textoDraft.trim().match(/\\S+/g) || []).length;""",
'estados bloco')

# 3) editor de prompt
rep(
"""          <textarea
            className="edit-texto"
            rows="6"
            placeholder="Texto da narração…"
            value=${textoDraft}
            disabled=${s.jobAtivo}
            onInput=${(e) => setTextoDraft(e.target.value)}
          ></textarea>
          <div className="edit-rodape">""",
"""          <textarea
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
          <div className="edit-rodape">""",
'editor prompt')

# 4) botão salvar
rep(
"""            <button
              className="btn btn-mini btn-primario"
              disabled=${!sujo || s.jobAtivo}
              title="Salvar este texto no roteiro"
              onClick=${() => salvarTextoBloco(item.id, tituloDraft, textoDraft)}
            >💾 Salvar texto</button>""",
"""            <button
              className="btn btn-mini btn-primario"
              disabled=${!sujoGeral || s.jobAtivo}
              title="Salvar texto e prompt deste bloco no roteiro"
              onClick=${() => salvarTextoBloco(item.id, tituloDraft, textoDraft, promptDraft)}
            >💾 Salvar</button>""",
'botao salvar')

# 5) badge no cabeçalho
rep(
"          ${sujo ? html`<span className=\"badge alerta pulse\">texto alterado — salve</span>` : null}",
"          ${sujoGeral ? html`<span className=\"badge alerta pulse\">texto/prompt alterado — salve</span>` : null}",
'badge cabeçalho')

with io.open(path, 'w', encoding='utf-8') as f:
    f.write(s)
print('DONE')