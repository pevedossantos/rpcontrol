// Exército de Solano · Controle de Efetivo
// Front-end estático (GitHub Pages / Vercel) + Supabase (banco, login, tempo real).
// Login: nome usado no jogo + senha. Por baixo, o Supabase usa um e-mail interno
// (nome-normalizado@DOMINIO_LOGIN) que ninguém precisa conhecer.
// Toda alteração passa por funções do banco (supabase/schema.sql) que validam cargo e patente.
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.4/+esm";

/* ===== Tabelas fixas (espelham o banco) ===== */
const PAT = [["Recruta","REC"],["Soldado","SLD"],["Sargento","SGT"],["1º Sargento","1 SGT"],["Sargento Mor","SGT MOR"],["Tenente","TEN"],["Capitão","CAP"],["Major","MAJ"],["Coronel","CEL"],["Major General","MAJ GEN"],["Tenente General","TEN GEN"],["Coronel General","CEL GEN"],["General Adjunto","GEN ADJ"],["Federal","FEDERAL"]];
const CARGOS = [{k:"federal",n:"Federal",lv:13},{k:"genadj",n:"General Adjunto",lv:12},{k:"celgen",n:"Coronel General",lv:11},{k:"tengen",n:"Tenente General",lv:10},{k:"majgen",n:"Major General",lv:9}];
const PERMS = [["cadastrar","Cadastrar membros"],["editar","Editar dados dos membros"],["promover","Promover e rebaixar"],["punir","Aplicar punições"],["revogar","Revogar punições"],["exonerar","Exonerar e readmitir"],["presenca","Registrar eventos e lista de presença"],["ajustar_presenca","Editar e apagar eventos de outros e gerenciar tipos de evento"],["setores","Gerenciar setores e funções"]];
const DEF = {
  federal:{cadastrar:true,editar:true,promover:true,punir:true,revogar:true,exonerar:true,presenca:true,ajustar_presenca:true,setores:true,max_patente:12},
  genadj:{cadastrar:true,editar:true,promover:true,punir:true,revogar:true,exonerar:true,presenca:true,ajustar_presenca:true,setores:true,max_patente:11},
  celgen:{cadastrar:true,editar:true,promover:true,punir:true,revogar:false,exonerar:true,presenca:true,ajustar_presenca:false,setores:true,max_patente:10},
  tengen:{cadastrar:true,editar:true,promover:true,punir:true,revogar:false,exonerar:false,presenca:true,ajustar_presenca:false,setores:false,max_patente:9},
  majgen:{cadastrar:true,editar:false,promover:true,punir:true,revogar:false,exonerar:false,presenca:true,ajustar_presenca:false,setores:false,max_patente:8}
};
const PUN_TIPOS = ["Advertência verbal","Advertência escrita","Suspensão","Detenção"];
const HIST_TIPOS = {cadastro:"Cadastro",promocao:"Promoção",rebaixamento:"Rebaixamento",punicao:"Punição",revogacao:"Revogação de punição",exoneracao:"Exoneração",readmissao:"Readmissão",edicao:"Edição de dados",ajuste_ponto:"Ajuste de ponto",remocao:"Registro apagado",setor:"Setores e funções",acesso:"Acesso ao painel",evento:"Eventos",arsenal:"Roubo do Arsenal"};
const HORAS_ARSENAL = [11, 13, 15, 17, 19];
const FUNCOES = [["1CMD","1º Comando","1 CMD"],["2CMD","2º Comando","2 CMD"],["1AUX","1º Auxiliar","1 AUX"],["2AUX","2º Auxiliar","2 AUX"]];
const fnSigla = f => FUNCOES.find(x => x[0] === f)?.[2] || "";
const fnNome = f => FUNCOES.find(x => x[0] === f)?.[1] || "";

/* ===== Estado ===== */
const CFG = window.SOLANO_CONFIG || {};
const DOMINIO_LOGIN = "solano-efetivo.com";
function slugUsuario(nome){
  return String(nome || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim()
    .replace(/\s+/g, ".").replace(/[^a-z0-9._-]/g, "").replace(/\.{2,}/g, ".").replace(/^[.\-_]+|[.\-_]+$/g, "");
}
const emailDe = nome => slugUsuario(nome) + "@" + DOMINIO_LOGIN;
let sb = null;
const S = {
  fase:"carregando", err:null, session:null, uid:null, nomeJogo:"", authModo:"entrar",
  me:null, meuCargo:null, podeRegistrar:false, membros:[], setores:[], punicoes:[], eventos:[], tipos:[], presTot:{}, arsenal:[], hist:[], staff:[], perms:{}, perfis:[],
  resData:"", resFiltro:"todos", arsData:"", arsHora:null, arsSetor:"", arsSel:new Map(), arsChave:"", arsSujo:false,
  selEv:null, fTipo:"", fDe:"", fAte:"", qEv:"", fotoUrl:{},
  tab:"geral", sel:null, q:"", fPat:"", fStatus:"ativo", fSetor:"", fHist:"", permDraft:null, busy:false, entrando:false
};

/* ===== Utilidades ===== */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const cargoInfo = k => CARGOS.find(c => c.k === k);
// O nível de acesso vem da patente da ficha ligada à conta (calculado pelo banco em meu_cargo()).
const isAdm = () => S.meuCargo === "adm";
const myLevel = () => isAdm() ? 99 : (cargoInfo(S.meuCargo)?.lv ?? -1);
const perms = () => cargoInfo(S.meuCargo) ? (S.perms[S.meuCargo] || DEF[S.meuCargo]) : null;
const can = p => isAdm() || !!perms()?.[p];
const canActOn = m => isAdm() || Number(m.patente) < myLevel();
function maxPromo(){ if (isAdm()) return PAT.length - 1; const P = perms(); if (!P || !P.promover) return 0; return Math.min(Number(P.max_patente ?? 0), myLevel() - 1); }
function nivelLabel(c){ return c === "adm" ? "ADM Geral" : c === "leitor" ? "Visualização" : cargoInfo(c)?.n || "Sem acesso"; }
function meLabel(){
  const mm = S.me?.membro_id && S.membros.find(m => m.id === S.me.membro_id);
  if (S.meuCargo === "leitor" && mm?.funcao && mm.setorId) return `${fnSigla(mm.funcao)} · ${S.setores.find(x => x.id === mm.setorId)?.nome || ""}`;
  return nivelLabel(S.meuCargo);
}
// Mesmo cálculo do banco, para mostrar o nível de cada conta na aba Acessos
function cargoDaFicha(m){ if (!m || m.status !== "ativo") return null; return Number(m.patente) >= 9 ? CARGOS.find(c => c.lv === Number(m.patente))?.k : "leitor"; }
const setorById = id => S.setores.find(x => x.id === id);
const setorNome = id => setorById(id)?.nome || "";
const contaDe = membroId => S.staff.find(x => x.membro_id === membroId);
function fnChip(f){ return f ? `<span class="fn" title="${esc(fnNome(f))}">${esc(fnSigla(f))}</span>` : ""; }
function setorOptions(sel, vazio = "Sem setor"){ return `<option value="">${esc(vazio)}</option>` + S.setores.map(x => `<option value="${x.id}" ${x.id === sel ? "selected" : ""}>${esc(x.nome)}</option>`).join(""); }
const patAbbr = i => PAT[i]?.[1] ?? "?";
const patName = i => PAT[i]?.[0] ?? "?";
function chip(i){ i = Number(i); const cls = i === 13 ? "fed" : i >= 9 ? "gen" : i >= 5 ? "of" : ""; return `<span class="chip ${cls}" title="${esc(patName(i))}">${esc(patAbbr(i))}</span>`; }
function fmtDur(ms){ ms = Math.max(0, ms || 0); const h = Math.floor(ms / 36e5), m = Math.floor(ms % 36e5 / 6e4); return h ? `${h}h ${String(m).padStart(2,"0")}min` : `${m}min`; }
function fmtTs(t){ if (!t) return "—"; const d = new Date(t); return d.toLocaleDateString("pt-BR",{day:"2-digit",month:"2-digit",year:"2-digit"}) + " " + d.toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"}); }
function fmtDate(s){ if (!s) return "—"; const [y,m,d] = String(s).split("-"); return d ? `${d}/${m}/${y}` : esc(s); }
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; };
const mById = id => S.membros.find(m => m.id === id);
const mLabel = m => m ? `${patAbbr(m.patente)} ${m.nome}` : "";
const ms = t => t ? Date.parse(t) : null;
function toast(msg, kind){ const r = $("#toast-root"); r.innerHTML = `<div class="toast ${kind === "err" ? "err" : ""}">${esc(msg)}</div>`; clearTimeout(toast.t); toast.t = setTimeout(() => r.innerHTML = "", kind === "err" ? 6000 : 2800); }

/* ===== Mapeamento banco → tela ===== */
const mapM = r => ({id:r.id,nome:r.nome,discord:r.discord,setorId:r.setor_id,funcao:r.funcao,patente:r.patente,status:r.status,ingresso:r.ingresso,obs:r.obs,totalMs:Number(r.total_ms)||0,servico:r.servico_inicio?{inicio:ms(r.servico_inicio),sessao:r.servico_sessao}:null});
const mapP = r => ({id:r.id,membroId:r.membro_id,tipo:r.tipo,dias:r.dias,motivo:r.motivo,ativa:r.ativa,porLabel:r.por_label,em:ms(r.em),revogadaEm:ms(r.revogada_em)});
const mapPt = r => ({id:r.id,membroId:r.membro_id,membroNome:r.membro_nome,inicio:ms(r.inicio),fim:ms(r.fim),porLabel:r.por_label});
const mapEv = r => ({id:r.id,tipoId:r.tipo_id,tipo:r.tipo_nome,treino:r.treinamento,titulo:r.titulo,data:ms(r.data_hora),instrutorId:r.instrutor_id,instrutor:r.instrutor_nome,descricao:r.descricao,fotos:r.fotos||[],criadoPor:r.criado_por,porLabel:r.criado_por_label,
  presentes:(r.presencas||[]).map(p => ({id:p.membro_id, nome:p.membro_nome}))});
const mapArs = r => ({id:r.id,data:r.data,hora:r.hora,setorId:r.setor_id,ts:new Date(r.data + "T" + String(r.hora).padStart(2,"0") + ":00:00").getTime(),porLabel:r.atualizado_label,em:ms(r.atualizado_em),
  presentes:(r.arsenal_presencas||[]).filter(p => (p.status || "ativo") === "ativo").map(p => ({id:p.membro_id, nome:p.membro_nome})),
  justificados:(r.arsenal_presencas||[]).filter(p => p.status === "justificado").map(p => ({id:p.membro_id, nome:p.membro_nome})),
  inativos:(r.arsenal_presencas||[]).filter(p => p.status === "inativo").map(p => ({id:p.membro_id, nome:p.membro_nome}))});
const mapH = r => ({id:r.id,tipo:r.tipo,membroId:r.membro_id,membroNome:r.membro_nome,texto:r.texto,motivo:r.motivo,porLabel:r.por_label,em:ms(r.em)});

/* ===== Carregamento ===== */
async function q(promise){ const { data, error } = await promise; if (error) throw error; return data; }
const LOADERS = {
  membros:     async () => { S.membros  = (await q(sb.from("membros").select("*").limit(2000))).map(mapM); },
  punicoes:    async () => { S.punicoes = (await q(sb.from("punicoes").select("*").order("em",{ascending:false}).limit(2000))).map(mapP); },
  eventos:     async () => { S.eventos  = (await q(sb.from("eventos").select("*, presencas(membro_id, membro_nome)").order("data_hora",{ascending:false}).limit(500))).map(mapEv); },
  presencas:   async () => { const rows = await q(sb.rpc("presencas_por_membro")); S.presTot = Object.fromEntries(rows.map(r => [r.membro_id, {total:Number(r.total), eventos:Number(r.eventos), arsenal:Number(r.arsenal), justificados:Number(r.justificados || 0)}])); },
  arsenal:     async () => { S.arsenal  = (await q(sb.from("arsenal").select("*, arsenal_presencas(membro_id, membro_nome, status)").order("data",{ascending:false}).limit(1000))).map(mapArs); },
  tipos_evento: async () => { S.tipos   = await q(sb.from("tipos_evento").select("*").order("ordem").order("nome")); },
  historico:   async () => { S.hist     = (await q(sb.from("historico").select("*").order("em",{ascending:false}).limit(500))).map(mapH); },
  setores:     async () => { S.setores  = await q(sb.from("setores").select("*").order("ordem").order("nome")); },
  staff:       async () => { S.staff    = await q(sb.from("staff").select("*")); },
  cargo_perms: async () => { const rows = await q(sb.from("cargo_perms").select("*")); S.perms = Object.fromEntries(rows.map(r => [r.cargo, r])); },
  perfis:      async () => { S.perfis   = isAdm() ? await q(sb.from("perfis").select("user_id,nome_jogo,usuario,criado_em").order("criado_em",{ascending:false})) : []; }
};
// Cada parte carrega sozinha: se uma falhar, as outras continuam aparecendo
async function carregar(nomes){
  const res = await Promise.allSettled(nomes.map(n => LOADERS[n]()));
  const falhas = res.map((r, i) => r.status === "rejected" ? { parte: nomes[i], e: r.reason } : null).filter(Boolean);
  if (!falhas.length) return;
  const msg = falhas.map(f => String(f.e?.message || f.e || "")).join(" ");
  if (/schema cache|does not exist|could not find the (table|function)/i.test(msg)) {
    toast("O banco do Supabase está desatualizado em relação ao site. Rode o supabase/schema.sql mais recente no SQL Editor e recarregue a página.", "err");
  } else {
    toast("Não foi possível carregar " + falhas.map(f => f.parte).join(", ") + ": " + msg, "err");
  }
}
const pendentes = new Set(); let tRefetch = null;
function agendar(tabela){
  if (tabela === "staff" || tabela === "membros") verificarCargo();
  if (tabela === "staff") { recarregarMeuCargo(); return; }
  if (tabela === "presencas") { pendentes.add("eventos"); }
  if (tabela === "arsenal_presencas") { tabela = "arsenal"; }
  if (tabela === "arsenal") { pendentes.add("presencas"); }
  if (tabela === "eventos") { pendentes.add("presencas"); }
  if (!LOADERS[tabela]) return;
  pendentes.add(tabela); clearTimeout(tRefetch);
  tRefetch = setTimeout(async () => { const n = [...pendentes]; pendentes.clear(); await carregar(n); render(); }, 250);
}

/* ===== Login e acesso ===== */
async function boot(){
  if (!CFG.SUPABASE_URL || CFG.SUPABASE_URL.includes("SEU-PROJETO") || !CFG.SUPABASE_ANON_KEY || CFG.SUPABASE_ANON_KEY.includes("COLE-AQUI")) {
    S.fase = "config"; render(); return;
  }
  // Aceita a URL colada com sobras (/rest/v1/, barra final, espaços): usa só https://ID.supabase.co
  let url = String(CFG.SUPABASE_URL).trim();
  const m = url.match(/^https?:\/\/[^\/\s]+/);
  url = m ? m[0] : url;
  if (/supabase\.com$/.test(url)) {
    const ref = String(CFG.SUPABASE_URL).match(/project\/([a-z0-9]+)/i);
    if (ref) url = `https://${ref[1]}.supabase.co`;
  }
  sb = createClient(url, String(CFG.SUPABASE_ANON_KEY).trim());
  sb.auth.onAuthStateChange((ev, sess) => {
    if (ev === "SIGNED_OUT") { location.reload(); return; }
    if (sess && !S.session) { S.session = sess; entrar(); }
  });
  const { data: { session } } = await sb.auth.getSession();
  if (session && !S.session) { S.session = session; await entrar(); }
  else if (!session) { S.fase = "login"; render(); }
}
function erroAuth(e){
  const m = String(e?.message || e || "");
  if (/invalid login credentials/i.test(m)) return "Nome ou senha incorretos.";
  if (/already registered|already exists/i.test(m)) return "Já existe uma conta com esse nome. Use Entrar, ou fale com o ADM Geral se esqueceu a senha.";
  if (/password/i.test(m) && /6|short|least/i.test(m)) return "A senha precisa ter pelo menos 6 caracteres.";
  if (/email not confirmed/i.test(m)) return "Conta criada, mas o Supabase está exigindo confirmação de e-mail. O ADM precisa desligar \"Confirm email\" (veja o README).";
  if (/rate limit|too many/i.test(m)) return "Muitas tentativas seguidas. Aguarde alguns minutos.";
  if (/signups? (not allowed|disabled)/i.test(m)) return "O cadastro de contas está desativado no Supabase.";
  return m || "Não foi possível concluir. Tente de novo.";
}
async function autenticar(d){
  const nome = String(d.nome || "").trim().replace(/\s+/g, " ");
  const usuario = slugUsuario(nome);
  if (usuario.length < 3) return "Informe o nome usado no jogo (pelo menos 3 letras ou números).";
  if (!d.senha || d.senha.length < 6) return "A senha precisa ter pelo menos 6 caracteres.";
  if (S.authModo === "criar") {
    if (nome.length > 40) return "O nome pode ter no máximo 40 caracteres.";
    if (d.senha !== d.senha2) return "As senhas não são iguais.";
    const { data, error } = await sb.auth.signUp({ email: emailDe(nome), password: d.senha, options: { data: { nome_jogo: nome, usuario } } });
    if (error) return erroAuth(error);
    if (!data.session) return erroAuth("email not confirmed");
    return true;
  }
  const { error } = await sb.auth.signInWithPassword({ email: emailDe(nome), password: d.senha });
  return error ? erroAuth(error) : true;
}
async function entrar(){
  if (S.entrando) return; S.entrando = true;
  const u = S.session.user; const meta = u.user_metadata || {};
  S.uid = u.id;
  S.nomeJogo = meta.nome_jogo || String(u.email || "").split("@")[0] || "Você";
  sb.channel("solano").on("postgres_changes", { event: "*", schema: "public" }, p => agendar(p.table)).subscribe();
  await recarregarMeuCargo();
}
async function recarregarMeuCargo(){
  try {
    const { data, error } = await sb.from("staff").select("*").eq("user_id", S.uid).maybeSingle();
    if (error) throw error;
    S.me = data || null;
    const antes = S.meuCargo;
    if (!S.me) {
      const { data: existe, error: e2 } = await sb.rpc("existe_adm");
      if (e2) throw e2;
      S.meuCargo = null; S.fase = existe ? "pendente" : "sem-adm";
      S.membros = []; S.setores = []; S.punicoes = []; S.eventos = []; S.arsenal = []; S.presTot = {}; S.hist = []; S.staff = []; S.perfis = [];
    } else {
      const { data: c, error: e3 } = await sb.rpc("meu_cargo");
      if (e3) throw e3;
      S.meuCargo = c || null;
      const { data: pr } = await sb.rpc("pode_registrar"); S.podeRegistrar = !!pr;
      if (!S.meuCargo) { S.fase = "suspenso"; render(); return; }
      if (S.fase !== "app" || antes !== S.meuCargo) { await carregar(Object.keys(LOADERS)); S.permDraft = null; }
      else { await carregar(["staff", "perfis"]); }
      if (!isAdm() && S.tab === "acessos") S.tab = "geral";
      S.fase = "app";
    }
  } catch (e) { S.fase = "erro"; S.err = "Não foi possível ler seu acesso: " + (e.message || e) + ". Confira se o script do banco foi executado."; }
  render();
}
// Promoção, rebaixamento ou exoneração da própria ficha muda o acesso na hora
let tCargo = null;
function verificarCargo(){
  clearTimeout(tCargo);
  tCargo = setTimeout(async () => {
    if (!S.me) return;
    const { data: c, error } = await sb.rpc("meu_cargo");
    const { data: pr } = await sb.rpc("pode_registrar");
    if (!error && (c || null) === S.meuCargo && !!pr !== S.podeRegistrar) { S.podeRegistrar = !!pr; render(); }
    if (!error && (c || null) !== S.meuCargo) {
      recarregarMeuCargo();
      if (S.meuCargo && c) toast("Seu nível de acesso mudou para: " + nivelLabel(c) + ".");
    }
  }, 400);
}

/* ===== Escrita via funções do banco ===== */
async function rpc(fn, args, ok){
  if (S.busy) return false; S.busy = true;
  try {
    const { error } = await sb.rpc(fn, args);
    if (error) throw error;
    if (ok) toast(ok);
    await carregar(["membros","setores","punicoes","eventos","arsenal","presencas","tipos_evento","historico","staff"]); render();
    return true;
  } catch (e) { toast(e.message || "Não foi possível salvar. Tente de novo.", "err"); return false; }
  finally { S.busy = false; }
}

/* ===== Render ===== */
function render(){
  renderWho();
  const tabs = [["geral","Visão geral"],["efetivo","Efetivo"],["setores","Setores"],["arsenal","Lista de presença"],["eventos","Eventos"],["historico","Histórico"]];
  if (isAdm()) tabs.push(["acessos","Acessos"]);
  $("#tabs").innerHTML = S.fase === "app" ? tabs.map(([k,n]) => `<button class="tab" role="tab" data-a="tab" data-id="${k}" aria-selected="${S.tab === k}">${n}</button>`).join("") : "";
  const app = $("#app");
  const f = document.activeElement; const fid = f && f.id && app.contains(f) ? f.id : null; let ss = null, se = null;
  if (fid) { try { ss = f.selectionStart; se = f.selectionEnd; } catch {} }
  app.innerHTML = ({config:vConfig, login:vLogin, pendente:vPendente, suspenso:vSuspenso, "sem-adm":vSemAdm, erro:vErro, carregando:() => `<div class="loading">Carregando…</div>`}[S.fase]
    || (() => ({geral:vGeral, efetivo:vEfetivo, setores:vSetores, arsenal:vArsenal, eventos:vEventos, historico:vHist, acessos:vAcessos}[S.tab] || vGeral)()))();
  if (fid) { const n = document.getElementById(fid); if (n) { n.focus(); try { if (ss != null) n.setSelectionRange(ss, se); } catch {} } }
  renderDrawer();
}
function renderWho(){
  const w = $("#who");
  if (!S.session) { w.innerHTML = ""; return; }
  const mf = S.me?.membro_id && mById(S.me.membro_id);
  w.innerHTML = `${mf ? chip(mf.patente) : ""}<span class="nm">${esc(mf ? mf.nome : (S.me?.nome || S.nomeJogo))}</span><span class="pill ${S.meuCargo ? "ok" : "mut"}">${esc(meLabel())}</span><button class="btn sm" data-a="trocarSenha">Trocar senha</button><button class="btn sm" data-a="sair">Sair</button>`;
}
function vConfig(){ return `<div class="gate"><h2>Falta configurar</h2><p>Preencha <b>SUPABASE_URL</b> e <b>SUPABASE_ANON_KEY</b> no arquivo <span class="mono">config.js</span>. O passo a passo está no README do repositório.</p></div>`; }
function vLogin(){
  const criar = S.authModo === "criar";
  return `<div class="gate"><h2>${criar ? "Criar conta" : "Acesso restrito"}</h2>
  <p>${criar ? "Use o mesmo nome do seu personagem no jogo. Depois de criar, o ADM Geral libera o seu cargo." : "Painel de controle de efetivo do Exército de Solano."}</p>
  <form id="authform" class="authform" novalidate>
    <div class="field"><label for="a-nome">Nome no jogo</label><input class="input" id="a-nome" name="nome" autocomplete="username" maxlength="40" required></div>
    <div class="field"><label for="a-senha">Senha</label><input class="input" id="a-senha" name="senha" type="password" autocomplete="${criar ? "new-password" : "current-password"}" minlength="6" required></div>
    ${criar ? `<div class="field"><label for="a-senha2">Confirmar senha</label><input class="input" id="a-senha2" name="senha2" type="password" autocomplete="new-password" minlength="6" required></div>` : ""}
    <button type="submit" class="btn pri">${criar ? "Criar conta" : "Entrar"}</button>
  </form>
  <p style="font-size:14px">${criar ? `Já tem conta? <a href="#" data-a="modoEntrar">Entrar</a>` : `Primeira vez aqui? <a href="#" data-a="modoCriar">Criar conta</a>`}</p>
  ${criar ? "" : `<p style="font-size:13px">Esqueceu a senha? Peça ao ADM Geral para redefinir.</p>`}</div>`;
}
function vPendente(){ return `<div class="gate"><h2>Aguardando liberação</h2><p>Você entrou como <b>${esc(S.nomeJogo)}</b>, mas sua conta ainda não foi liberada. Avise o ADM Geral: seu nome já aparece para ele na aba Acessos.</p><p style="font-size:13px">Esta tela abre sozinha quando o acesso for liberado.</p><button class="btn" data-a="verificar">Verificar de novo</button></div>`; }
function vSuspenso(){ return `<div class="gate"><h2>Acesso suspenso</h2><p>Sua conta <b>${esc(S.nomeJogo)}</b> não está ligada a uma ficha ativa do efetivo (exonerada ou desligada). Fale com o ADM Geral.</p><button class="btn" data-a="verificar">Verificar de novo</button></div>`; }
function vSemAdm(){ return `<div class="gate"><h2>Primeiro acesso</h2><p>Ainda não existe um ADM Geral neste painel. Se você é o responsável pela base, assuma agora. Depois disso a opção some para todo mundo.</p><button class="btn pri" data-a="assumirAdm">Assumir como ADM Geral</button></div>`; }
function vErro(){ return `<div class="gate"><h2>Erro</h2><p>${esc(S.err)}</p><button class="btn" data-a="verificar">Tentar de novo</button></div>`; }


function vGeral(){
  const ativos = S.membros.filter(m => m.status !== "exonerado");
  const ev7 = S.eventos.filter(e => e.data >= Date.now() - 7*864e5);
  const ars7 = S.arsenal.filter(a => a.ts >= Date.now() - 7*864e5);
  const roubos7 = new Set(ars7.map(a => a.data + "|" + a.hora)).size;
  const pres7 = ev7.reduce((n, e) => n + e.presentes.length, 0) + ars7.reduce((n, a) => n + a.presentes.length, 0);
  const punAt = S.punicoes.filter(p => p.ativa);
  const cont = PAT.map((_, i) => ativos.filter(m => Number(m.patente) === i).length);
  const mx = Math.max(1, ...cont);
  let dist = ""; for (let i = PAT.length - 1; i >= 0; i--) dist += `<div class="dist-row"><span>${chip(i)}</span><div class="bar"><i class="${i >= 9 ? "gen" : ""}" style="width:${cont[i]/mx*100}%"></i></div><span class="num" style="text-align:right">${cont[i]}</span></div>`;
  return `
  <section class="kpis">
    <div class="kpi"><div class="v num">${ativos.length}</div><div class="k">Efetivo ativo</div></div>
    <div class="kpi"><div class="v num" style="color:var(--ok)">${roubos7}</div><div class="k">Roubos do Arsenal em 7 dias</div></div>
    <div class="kpi"><div class="v num">${pres7}</div><div class="k">Presenças em 7 dias</div></div>
    <div class="kpi"><div class="v num">${ev7.length}</div><div class="k">Treinos e eventos em 7 dias</div></div>
    <div class="kpi"><div class="v num" style="color:${punAt.length ? "var(--bad)" : "inherit"}">${punAt.length}</div><div class="k">Punições ativas</div></div>

  </section>
  ${painelResumoArsenal()}
  <div class="grid2">
    <section class="panel"><div class="panel-h"><h2>Efetivo por patente</h2></div><div class="panel-b dist">${dist}</div></section>
    ${painelSetores(ativos)}
  </div>
  <div class="grid2">
    <section class="panel"><div class="panel-h"><h2>Últimos eventos</h2><span class="sp"><button class="btn sm" data-a="tab" data-id="eventos">Abrir eventos</button></span></div>
      ${S.eventos.length ? `<div class="list">${S.eventos.slice(0, 6).map(e => `<div class="li click-li" data-a="abrirEv" data-id="${e.id}" tabindex="0"><span class="tipo-tag ${e.treino ? "treino" : ""}">${esc(e.tipo || "Evento")}</span><span class="grow"><b>${esc(e.titulo || e.tipo)}</b><div class="muted" style="font-size:12px">${fmtTs(e.data)} · ${esc(e.porLabel || "")}</div></span><span class="pill mut num">${e.presentes.length} presente${e.presentes.length === 1 ? "" : "s"}</span></div>`).join("")}</div>` : `<div class="empty">Nenhum evento registrado ainda.</div>`}
    </section>
    <section class="panel"><div class="panel-h"><h2>Últimos registros</h2><span class="sp"><button class="btn sm" data-a="tab" data-id="historico">Ver histórico</button></span></div>${feed(S.hist.slice(0, 6))}</section>
  </div>`;
}
function painelSetores(ativos){
  const linhas = S.setores.map(st => ({ st, n: ativos.filter(m => m.setorId === st.id).length, cmd: ativos.find(m => m.setorId === st.id && m.funcao === "1CMD") }));
  const sem = ativos.filter(m => !m.setorId || !setorById(m.setorId)).length;
  const mx = Math.max(1, sem, ...linhas.map(l => l.n));
  return `<section class="panel"><div class="panel-h"><h2>Efetivo por setor</h2><span class="sp"><button class="btn sm" data-a="tab" data-id="setores">Abrir setores</button></span></div>
    <div class="panel-b dist">${linhas.map(l => `<div class="dist-row setor-row"><span class="setor-nm" title="${esc(l.st.nome)}">${esc(l.st.nome)}</span><div><div class="bar"><i style="width:${l.n/mx*100}%"></i></div><div class="muted cmd-line">1 CMD: ${l.cmd ? esc(mLabel(l.cmd)) : "vago"}</div></div><span class="num" style="text-align:right">${l.n}</span></div>`).join("")}
    ${sem ? `<div class="dist-row setor-row"><span class="setor-nm muted">Sem setor</span><div><div class="bar"><i style="width:${sem/mx*100}%;background:var(--muted)"></i></div></div><span class="num" style="text-align:right">${sem}</span></div>` : ""}
    ${!S.setores.length && !sem ? `<div class="muted">Nenhum setor cadastrado.</div>` : ""}</div></section>`;
}
function feed(items){
  if (!items.length) return `<div class="empty">Nenhum registro ainda. Promoções, punições, cadastros e exonerações aparecem aqui.</div>`;
  return `<div class="feed">${items.map(h => `<div class="ev ${esc(h.tipo)}"><span class="s"></span><div>
    <div class="t"><b>${esc(HIST_TIPOS[h.tipo] || h.tipo)}</b>${h.membroNome ? ` · ${h.membroId && mById(h.membroId) ? `<a href="#" data-a="abrir" data-id="${esc(h.membroId)}" style="color:inherit">${esc(h.membroNome)}</a>` : esc(h.membroNome)}` : ""}${h.texto ? ` · ${esc(h.texto)}` : ""}</div>
    ${h.motivo ? `<div class="why">Motivo: ${esc(h.motivo)}</div>` : ""}
    <div class="m">${esc(h.porLabel || "—")} · ${fmtTs(h.em)}</div></div></div>`).join("")}</div>`;
}

function vEfetivo(){
  const qq = S.q.trim().toLowerCase();
  const punCount = {}; S.punicoes.forEach(p => { if (p.ativa) punCount[p.membroId] = (punCount[p.membroId] || 0) + 1; });
  const list = S.membros.filter(m => (S.fStatus === "todos" || (S.fStatus === "exonerado" ? m.status === "exonerado" : m.status !== "exonerado"))
    && (S.fPat === "" || Number(m.patente) === Number(S.fPat))
    && (S.fSetor === "" || (S.fSetor === "-" ? !m.setorId : m.setorId === S.fSetor))
    && (!qq || String(m.nome).toLowerCase().includes(qq) || String(m.discord || "").toLowerCase().includes(qq)))
    .sort((a,b) => b.patente - a.patente || String(a.nome).localeCompare(String(b.nome), "pt-BR"));
  return `<section class="panel">
    <div class="panel-h"><h2>Efetivo</h2><span class="muted num">${list.length} ${list.length === 1 ? "militar" : "militares"}</span>
      <span class="sp">${can("cadastrar") ? `<button class="btn pri" data-a="novo">+ Cadastrar militar</button>` : ""}</span></div>
    <div class="panel-b toolbar">
      <input class="input search" id="q" type="search" placeholder="Buscar por nome ou Discord" value="${esc(S.q)}" aria-label="Buscar">
      <select class="input" id="fPat" aria-label="Filtrar por patente"><option value="">Todas as patentes</option>${PAT.map((p,i) => `<option value="${i}" ${String(S.fPat) === String(i) ? "selected" : ""}>${esc(p[0])}</option>`).reverse().join("")}</select>
      <select class="input" id="fSetor" aria-label="Filtrar por setor"><option value="">Todos os setores</option>${S.setores.map(x => `<option value="${x.id}" ${S.fSetor === x.id ? "selected" : ""}>${esc(x.nome)}</option>`).join("")}<option value="-" ${S.fSetor === "-" ? "selected" : ""}>Sem setor</option></select>
      <select class="input" id="fStatus" aria-label="Filtrar por situação"><option value="ativo" ${S.fStatus === "ativo" ? "selected" : ""}>Ativos</option><option value="exonerado" ${S.fStatus === "exonerado" ? "selected" : ""}>Exonerados</option><option value="todos" ${S.fStatus === "todos" ? "selected" : ""}>Todos</option></select>
    </div>
    ${list.length ? `<div class="tablewrap"><table><thead><tr><th>Patente</th><th>Nome</th><th>Discord</th><th>Setor</th><th>Presenças</th><th>Punições</th><th>Situação</th></tr></thead><tbody>
    ${list.map(m => { const pc = punCount[m.id] || 0; const ex = m.status === "exonerado"; const pt = S.presTot[m.id]?.total || 0; const p30 = pres30(m.id);
      return `<tr class="click ${ex ? "dim" : ""}" tabindex="0" data-a="abrir" data-id="${m.id}"><td>${chip(m.patente)}</td>
      <td><b>${esc(m.nome)}</b>${contaDe(m.id) ? ` <span class="pill mut" title="Tem login no painel">conta</span>` : ""}</td>
      <td>${m.discord ? esc(m.discord) : `<span class="pill warn">sem Discord</span>`}</td>
      <td>${m.setorId && setorById(m.setorId) ? `${esc(setorNome(m.setorId))} ${fnChip(m.funcao)}` : `<span class="muted">—</span>`}</td>
      <td class="num">${pt}${p30 ? ` <span class="muted" style="font-size:12px">(${p30} em 30d)</span>` : ""}</td>
      <td>${pc ? `<span class="pill bad">${pc} ativa${pc > 1 ? "s" : ""}</span>` : `<span class="muted">—</span>`}</td>
      <td>${ex ? `<span class="pill mut">Exonerado</span>` : `<span class="pill ok">Ativo</span>`}</td></tr>`; }).join("")}
    </tbody></table></div>` : `<div class="empty">${S.membros.length ? "Nenhum militar com esses filtros." : "Nenhum militar cadastrado ainda." + (can("cadastrar") ? " Use “Cadastrar militar” para começar." : "")}</div>`}
  </section>`;
}

function vSetores(){
  const ativos = S.membros.filter(m => m.status !== "exonerado");
  const ed = can("setores");
  const card = (st) => {
    const mem = ativos.filter(m => m.setorId === st.id).sort((a,b) => b.patente - a.patente || String(a.nome).localeCompare(String(b.nome), "pt-BR"));
    const slots = FUNCOES.map(([k, n, sg]) => { const h = mem.find(m => m.funcao === k);
      return `<div class="slot"><span class="fn">${sg}</span><span class="grow">${h ? `<a href="#" data-a="abrir" data-id="${h.id}">${chip(h.patente)} ${esc(h.nome)}</a>` : `<span class="muted">Vago</span>`}</span>
        ${ed ? `<button class="btn sm" data-a="atribuirFuncao" data-id="${st.id}" data-fn="${k}">${h ? "Trocar" : "Atribuir"}</button>` : ""}</div>`; }).join("");
    const resto = mem.filter(m => !m.funcao);
    return `<section class="panel setor-card"><div class="panel-h"><h2>${esc(st.nome)}</h2><span class="muted num">${mem.length} ${mem.length === 1 ? "militar" : "militares"}</span>
      ${ed ? `<span class="sp" style="display:flex;gap:6px"><button class="btn sm" data-a="renomearSetor" data-id="${st.id}">Renomear</button><button class="btn sm danger" data-a="apagarSetor" data-id="${st.id}">Apagar</button></span>` : ""}</div>
      <div class="slots">${slots}</div>
      <div class="list">${resto.map(m => `<div class="li">${chip(m.patente)}<span class="grow"><a href="#" data-a="abrir" data-id="${m.id}" style="color:inherit">${esc(m.nome)}</a></span>${ed && canActOn(m) ? `<button class="btn sm" data-a="setorMembro" data-id="${m.id}">Mover</button>` : ""}</div>`).join("") || `<div class="empty">${mem.length ? "Todos os militares do setor têm função." : "Nenhum militar neste setor."}</div>`}</div>
      ${ed ? `<div class="panel-b"><button class="btn sm" data-a="addAoSetor" data-id="${st.id}">+ Adicionar militar</button></div>` : ""}
    </section>`;
  };
  const sem = ativos.filter(m => !m.setorId || !setorById(m.setorId)).sort((a,b) => b.patente - a.patente);
  return `<div class="toolbar"><h2 style="font-size:22px;text-transform:uppercase">Setores</h2><span class="muted">${S.setores.length} setores</span>
      <span style="margin-left:auto">${ed ? `<button class="btn pri" data-a="novoSetor">+ Novo setor</button>` : ""}</span></div>
    ${S.setores.length ? `<div class="setores-grid">${S.setores.map(card).join("")}</div>` : `<div class="panel empty">Nenhum setor cadastrado.${ed ? " Use “Novo setor”." : ""}</div>`}
    <section class="panel"><div class="panel-h"><h2>Sem setor</h2><span class="muted num">${sem.length}</span></div>
      ${sem.length ? `<div class="list">${sem.map(m => `<div class="li">${chip(m.patente)}<span class="grow"><a href="#" data-a="abrir" data-id="${m.id}" style="color:inherit">${esc(m.nome)}</a></span>${ed && canActOn(m) ? `<button class="btn sm" data-a="setorMembro" data-id="${m.id}">Colocar em setor</button>` : ""}</div>`).join("")}</div>` : `<div class="empty">Todo o efetivo ativo está em algum setor.</div>`}
    </section>`;
}


/* ===== Lista de presença · Roubo do Arsenal ===== */
const hojeISO = () => today();
function horaPadrao(){ const h = new Date().getHours(); const passadas = HORAS_ARSENAL.filter(x => x <= h); return passadas.length ? passadas[passadas.length - 1] : HORAS_ARSENAL[0]; }
const meuMembro = () => S.me?.membro_id ? mById(S.me.membro_id) : null;
// Setores que posso marcar: ADM e generais todos; quem tem função, só o próprio
function setoresMarcaveis(){
  if (isAdm() || cargoInfo(S.meuCargo)) return S.setores.map(x => x.id);
  const mm = meuMembro();
  return mm && mm.status === "ativo" && mm.funcao && mm.setorId && setorById(mm.setorId) ? [mm.setorId] : [];
}
// Setores que posso ver: ADM e generais todos; os demais, só o próprio setor
function setoresVisiveis(){
  if (isAdm() || cargoInfo(S.meuCargo)) return S.setores.map(x => x.id);
  const mm = meuMembro();
  return mm && mm.status === "ativo" && mm.setorId && setorById(mm.setorId) ? [mm.setorId] : [];
}
// Resumo do dia de todos os setores: Tenente General para cima e ADM
const podeResumo = () => isAdm() || ["tengen","celgen","genadj","federal"].includes(S.meuCargo);
const listaArsenal = (data, hora, setor) => S.arsenal.find(a => a.data === data && a.hora === hora && a.setorId === setor);
function garantirArsenal(){
  if (!S.arsData) S.arsData = hojeISO();
  if (!S.arsHora) S.arsHora = horaPadrao();
  const vis = setoresVisiveis();
  if (!S.arsSetor || !vis.includes(S.arsSetor)) { const mm = meuMembro(); S.arsSetor = (setoresMarcaveis().length === 1 ? setoresMarcaveis()[0] : (mm?.setorId && vis.includes(mm.setorId) ? mm.setorId : vis[0])) || ""; }
  const chave = `${S.arsData}|${S.arsHora}|${S.arsSetor}`;
  if (chave !== S.arsChave || !S.arsSujo) {
    const l = listaArsenal(S.arsData, S.arsHora, S.arsSetor);
    S.arsSel = new Map();
    (l?.presentes || []).forEach(p => S.arsSel.set(p.id, "ativo"));
    (l?.justificados || []).forEach(p => S.arsSel.set(p.id, "justificado"));
    (l?.inativos || []).forEach(p => S.arsSel.set(p.id, "inativo"));
    S.arsChave = chave; S.arsSujo = false;
  }
}
function trocarArsenal(campo, valor){
  const aplicar = () => { S.arsSujo = false; S[campo] = valor; render(); };
  if (S.arsSujo && S[campo] !== valor) mConfirm("Descartar alterações?", "A lista atual tem marcações que não foram salvas. Trocar agora descarta essas marcações.", "Descartar e trocar", () => { aplicar(); return true; });
  else aplicar();
}
function vArsenal(){
  if (!S.setores.length) return `<div class="panel empty">Cadastre os setores antes de usar a lista de presença.</div>`;
  const vis = setoresVisiveis();
  if (!vis.length) return `<div class="panel empty">Você ainda não está em nenhum setor. A lista de presença mostra só o setor de cada militar; fale com o comando para ser colocado em um setor.</div>`;
  garantirArsenal();
  const marcaveis = setoresMarcaveis();
  const pode = marcaveis.includes(S.arsSetor);
  const lista = listaArsenal(S.arsData, S.arsHora, S.arsSetor);
  const ids = new Set([...(lista?.presentes || []), ...(lista?.justificados || []), ...(lista?.inativos || [])].map(p => p.id));
  const cand = S.membros.filter(m => (m.status === "ativo" && m.setorId === S.arsSetor) || ids.has(m.id))
    .sort((a,b) => b.patente - a.patente || String(a.nome).localeCompare(String(b.nome), "pt-BR"));
  const nHora = h => listaArsenal(S.arsData, h, S.arsSetor)?.presentes.length || 0;
  const st = id => S.arsSel.get(id) || "inativo";
  const cont = { ativo: 0, justificado: 0, inativo: 0 }; cand.forEach(m => cont[st(m.id)]++);
  const dataTxt = new Date(S.arsData + "T12:00:00").toLocaleDateString("pt-BR", {weekday:"long", day:"2-digit", month:"2-digit", year:"numeric"});
  const setorCampo = vis.length > 1
    ? `<select class="input" id="arsSetor">${S.setores.filter(x => vis.includes(x.id)).map(x => `<option value="${x.id}" ${x.id === S.arsSetor ? "selected" : ""}>${esc(x.nome)}${marcaveis.includes(x.id) ? "" : " (só ver)"}</option>`).join("")}</select>`
    : `<div class="input setor-fixo">${esc(setorNome(S.arsSetor))}</div>`;
  return `<section class="panel">
    <div class="panel-h"><h2>Lista de presença · Roubo do Arsenal</h2></div>
    <div class="panel-b ars-ctrl">
      <div class="field"><label for="arsData">Dia</label><div class="toolbar"><input class="input" type="date" id="arsData" value="${esc(S.arsData)}" max="${hojeISO()}">
        <button class="btn sm" data-a="arsDia" data-id="0">Hoje</button><button class="btn sm" data-a="arsDia" data-id="1">Ontem</button></div>
        <span class="hint" style="text-transform:capitalize">${esc(dataTxt)}</span></div>
      <div class="field"><label>Horário</label><div class="horas">${HORAS_ARSENAL.map(h => `<button class="hora ${h === S.arsHora ? "on" : ""}" data-a="arsHora" data-id="${h}" aria-pressed="${h === S.arsHora}"><b>${h}h</b><span>${nHora(h)} ativo${nHora(h) === 1 ? "" : "s"}</span></button>`).join("")}</div></div>
      <div class="field"><label for="arsSetor">Setor</label>${setorCampo}</div>
    </div>
  </section>
  <section class="panel"><div class="panel-h"><h2>Setor ${esc(setorNome(S.arsSetor))} · ${S.arsHora}h</h2><span class="ars-cont" id="ars-cont">${contHTML(cont)}</span>
      ${pode ? `<span class="sp" style="display:flex;gap:6px"><button class="btn sm" data-a="arsTodos">Todos ativos</button><button class="btn sm" data-a="arsNenhum">Todos inativos</button></span>` : ""}</div>
    ${!pode ? `<div class="panel-b"><div class="note">Só generais e quem tem função no setor (1 CMD, 2 CMD, 1 AUX, 2 AUX) marcam a lista. Aqui é só visualização.</div></div>` : ""}
    ${cand.length ? `<div class="ars-lista">${cand.map(m => `<div class="ars-li">${chip(m.patente)}<span class="nm">${esc(m.nome)}</span>${m.funcao ? fnChip(m.funcao) : ""}${m.status !== "ativo" || m.setorId !== S.arsSetor ? `<span class="muted" style="font-size:12px">fora do setor</span>` : ""}
        <select class="input st-sel st-${st(m.id)}" data-a="arsStatus" data-id="${m.id}" ${pode ? "" : "disabled"} aria-label="Situação de ${esc(m.nome)}">
          <option value="ativo" ${st(m.id) === "ativo" ? "selected" : ""}>Ativo</option><option value="justificado" ${st(m.id) === "justificado" ? "selected" : ""}>Justificado</option><option value="inativo" ${st(m.id) === "inativo" ? "selected" : ""}>Inativo</option></select></div>`).join("")}</div>`
      : `<div class="empty">Nenhum militar ativo no Setor ${esc(setorNome(S.arsSetor))}.</div>`}
    <div class="panel-b toolbar">
      ${pode ? `<button class="btn pri" data-a="arsSalvar" ${S.arsSujo || !lista ? "" : "disabled"}>${S.arsSujo || !lista ? "Salvar lista" : "Lista salva"}</button>` : ""}
      <span class="muted" style="font-size:13px">${lista ? `Última alteração: ${esc(lista.porLabel || "—")} · ${fmtTs(lista.em)}` : "Nenhuma lista salva neste horário ainda."}</span>
    </div>
  </section>`;
}
// Painel da Visão geral (só Tenente General para cima)
// Filtro do resumo: "todos" mostra ativos / justificados / inativos; ou só ativos; ou só justificados
const RES_FILTROS = [["todos","Todos"],["ativos","Ativos"],["justificados","Justificados"]];
function celResumo(c){
  const f = S.resFiltro || "todos";
  if (f === "ativos") return `${c.a}`;
  if (f === "justificados") return `${c.j}`;
  return `<span class="n-a" title="Ativos">${c.a}</span><span class="n-j" title="Justificados">${c.j}</span><span class="n-i" title="Inativos">${c.i}</span>`;
}
const contaLista = l => ({ a: l?.presentes.length || 0, j: l?.justificados.length || 0, i: l?.inativos.length || 0 });
const somaC = cs => cs.reduce((t, c) => ({ a: t.a + c.a, j: t.j + c.j, i: t.i + c.i }), { a: 0, j: 0, i: 0 });
// Painel da Visão geral (só Tenente General para cima)
function painelResumoArsenal(){
  if (!podeResumo() || !S.setores.length) return "";
  if (!S.resData) S.resData = hojeISO();
  if (!S.resFiltro) S.resFiltro = "todos";
  const d = S.resData;
  const doDia = S.arsenal.filter(a => a.data === d);
  const porHora = h => somaC(doDia.filter(a => a.hora === h).map(contaLista));
  const legenda = S.resFiltro === "todos" ? `<span class="n-a">ativos</span> <span class="n-j">justificados</span> <span class="n-i">inativos</span>` : S.resFiltro === "ativos" ? "Números = ativos." : "Números = justificados.";
  return `<section class="panel"><div class="panel-h"><h2>Roubo do Arsenal · resumo do dia</h2>
      <span class="sp toolbar"><input class="input" type="date" id="resData" value="${esc(d)}" max="${hojeISO()}" aria-label="Dia do resumo">
      <button class="btn sm" data-a="resDia" data-id="0">Hoje</button><button class="btn sm" data-a="resDia" data-id="1">Ontem</button>
      <span class="seg" role="group" aria-label="Mostrar">${RES_FILTROS.map(([k, n]) => `<button class="${S.resFiltro === k ? "on" : ""}" data-a="resFiltro" data-id="${k}" aria-pressed="${S.resFiltro === k}">${n}</button>`).join("")}</span>
      <button class="btn sm" data-a="arsCopiar" ${doDia.length ? "" : "disabled"}>Copiar resumo</button></span></div>
    <div class="tablewrap"><table class="resumo res-${S.resFiltro}"><thead><tr><th>Setor</th>${HORAS_ARSENAL.map(h => `<th>${h}h</th>`).join("")}<th>Total</th></tr></thead><tbody>
    ${S.setores.map(st => { const linha = HORAS_ARSENAL.map(h => listaArsenal(d, h, st.id)); const tot = somaC(linha.map(contaLista));
      return `<tr><td>${esc(st.nome)}</td>${linha.map((l, i) => `<td><button class="cel ${l ? "tem" : ""}" data-a="abrirArs" data-id="${d}|${HORAS_ARSENAL[i]}|${st.id}" title="${l ? `${l.presentes.length} ativos, ${l.justificados.length} justificados, ${l.inativos.length} inativos` : "Abrir a lista"}">${l ? celResumo(contaLista(l)) : "—"}</button></td>`).join("")}<td class="num"><b>${celResumo(tot)}</b></td></tr>`; }).join("")}
    <tr class="tot"><td>Total</td>${HORAS_ARSENAL.map(h => `<td class="num">${celResumo(porHora(h))}</td>`).join("")}<td class="num">${celResumo(somaC(doDia.map(contaLista)))}</td></tr>
    </tbody></table></div><div class="panel-b muted" style="font-size:12px">${legenda}</div></section>`;
}

function contHTML(c){ return `<span class="pill ok">${c.ativo} ativo${c.ativo === 1 ? "" : "s"}</span> <span class="pill warn">${c.justificado} justificado${c.justificado === 1 ? "" : "s"}</span> <span class="pill bad">${c.inativo} inativo${c.inativo === 1 ? "" : "s"}</span>`; }
function textoResumoArsenal(){
  const d = S.resData || hojeISO(), f = S.resFiltro || "todos";
  const pl = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const L = [`**Roubo do Arsenal · ${new Date(d + "T12:00:00").toLocaleDateString("pt-BR")}**${f === "ativos" ? " · só ativos" : f === "justificados" ? " · só justificados" : ""}`];
  const nome = p => mById(p.id) ? mLabel(mById(p.id)) : p.nome;
  for (const h of HORAS_ARSENAL) {
    const ls = S.arsenal.filter(a => a.data === d && a.hora === h);
    if (!ls.length) continue;
    const c = somaC(ls.map(contaLista));
    if ((f === "justificados" && !c.j) || (f === "ativos" && !c.a)) continue;
    L.push(""); L.push(`**${h}h** · ` + (f === "ativos" ? pl(c.a, "ativo") : f === "justificados" ? pl(c.j, "justificado") : `${pl(c.a, "ativo")}, ${pl(c.j, "justificado")}, ${pl(c.i, "inativo")}`));
    for (const a of ls) {
      const sn = `Setor ${setorNome(a.setorId) || "?"}`;
      if (f === "ativos") L.push(`${sn} · ${pl(a.presentes.length, "ativo")}: ` + (a.presentes.map(nome).join(", ") || "—"));
      else if (f === "justificados") { if (a.justificados.length) L.push(`${sn} · ${pl(a.justificados.length, "justificado")}: ` + a.justificados.map(nome).join(", ")); }
      else {
        L.push(`${sn}`);
        L.push(`  Ativos (${a.presentes.length}): ` + (a.presentes.map(nome).join(", ") || "—"));
        if (a.justificados.length) L.push(`  Justificados (${a.justificados.length}): ` + a.justificados.map(nome).join(", "));
        if (a.inativos.length) L.push(`  Inativos (${a.inativos.length}): ` + a.inativos.map(nome).join(", "));
      }
    }
  }
  return L.join("\n");
}

/* ===== Eventos e lista de presença ===== */
function pres30(id){ const lim = Date.now() - 30*864e5; let n = 0;
  for (const e of S.eventos) { if (e.data < lim) break; if (e.presentes.some(p => p.id === id)) n++; }
  for (const a of S.arsenal) { if (a.ts >= lim && a.presentes.some(p => p.id === id)) n++; }
  return n; }
const podeEditarEv = e => isAdm() || can("ajustar_presenca") || (e.criadoPor === S.uid && S.podeRegistrar);
const podeTipos = () => isAdm() || can("ajustar_presenca");
const tipoById = id => S.tipos.find(t => t.id === id);
function toLocalInput(t){ const d = new Date(t); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); }
function fromLocalInput(v){ return v ? new Date(v).getTime() : null; }
function eventosFiltrados(){
  const de = fromLocalInput(S.fDe), ate = fromLocalInput(S.fAte), qq = S.qEv.trim().toLowerCase();
  return S.eventos.filter(e => (!S.fTipo || e.tipoId === S.fTipo || (S.fTipo === "-" && !tipoById(e.tipoId)))
    && (de == null || e.data >= de) && (ate == null || e.data <= ate)
    && (!qq || (e.titulo + " " + e.tipo + " " + e.instrutor + " " + e.presentes.map(p => (mById(p.id)?.nome || p.nome)).join(" ")).toLowerCase().includes(qq)));
}
function periodoTexto(){
  const f = v => v ? new Date(v).toLocaleString("pt-BR", {day:"2-digit", month:"2-digit", year:"2-digit", hour:"2-digit", minute:"2-digit"}) : null;
  const a = f(S.fDe), b = f(S.fAte);
  return a && b ? `${a} até ${b}` : a ? `a partir de ${a}` : b ? `até ${b}` : "todas as datas";
}
function rankingPresenca(lista){
  const c = {};
  for (const e of lista) for (const p of e.presentes) c[p.id] = (c[p.id] || 0) + 1;
  return Object.entries(c).map(([id, n]) => ({ id, n, m: mById(id), nome: lista.flatMap(e => e.presentes).find(p => p.id === id)?.nome }))
    .sort((a,b) => b.n - a.n || (b.m?.patente ?? 0) - (a.m?.patente ?? 0));
}
function vEventos(){
  const lista = eventosFiltrados();
  const totPres = lista.reduce((n, e) => n + e.presentes.length, 0);
  const rank = rankingPresenca(lista);
  const rmax = Math.max(1, ...rank.map(r => r.n));
  return `<section class="panel">
    <div class="panel-h"><h2>Eventos</h2><span class="muted num">${S.eventos.length} registrados</span>
      <span class="sp" style="display:flex;gap:8px">${podeTipos() ? `<button class="btn" data-a="tiposEv">Tipos de evento</button>` : ""}${S.podeRegistrar ? `<button class="btn pri" data-a="novoEv">+ Registrar evento</button>` : ""}</span></div>
    <div class="panel-b toolbar">
      <select class="input" id="fTipo" aria-label="Filtrar por tipo"><option value="">Todos os tipos</option>${S.tipos.map(t => `<option value="${t.id}" ${S.fTipo === t.id ? "selected" : ""}>${esc(t.nome)}</option>`).join("")}</select>
      <label class="dt"><span>De</span><input class="input" type="datetime-local" id="fDe" value="${esc(S.fDe)}"></label>
      <label class="dt"><span>Até</span><input class="input" type="datetime-local" id="fAte" value="${esc(S.fAte)}"></label>
      <input class="input search" id="qEv" type="search" placeholder="Buscar por título, instrutor ou participante" value="${esc(S.qEv)}" aria-label="Buscar eventos">
    </div>
    <div class="panel-b toolbar" style="padding-top:0">
      <span class="muted" style="font-size:13px">Período rápido:</span>
      <button class="btn sm" data-a="periodo" data-id="hoje">Hoje</button><button class="btn sm" data-a="periodo" data-id="7">7 dias</button><button class="btn sm" data-a="periodo" data-id="30">30 dias</button><button class="btn sm" data-a="periodo" data-id="limpar">Limpar filtros</button>
    </div>
  </section>
  <section class="kpis">
    <div class="kpi"><div class="v num">${lista.length}</div><div class="k">Eventos no filtro</div></div>
    <div class="kpi"><div class="v num">${totPres}</div><div class="k">Presenças</div></div>
    <div class="kpi"><div class="v num">${rank.length}</div><div class="k">Militares diferentes</div></div>
    <div class="kpi" style="display:flex;flex-direction:column;justify-content:center;gap:6px"><div class="k" style="margin:0">${esc(periodoTexto())}</div><button class="btn sm" data-a="copiarRel" ${lista.length ? "" : "disabled"}>Copiar relatório</button></div>
  </section>
  <div class="grid2 ev-grid">
    <section class="panel"><div class="panel-h"><h2>Lista de eventos</h2></div>
      ${lista.length ? `<div class="tablewrap"><table><thead><tr><th>Data e hora</th><th>Tipo</th><th>Título</th><th>Presentes</th><th>Registrado por</th></tr></thead><tbody>
      ${lista.map(e => `<tr class="click" tabindex="0" data-a="abrirEv" data-id="${e.id}"><td class="num" style="white-space:nowrap">${fmtTs(e.data)}</td><td><span class="tipo-tag ${e.treino ? "treino" : ""}">${esc(e.tipo || "Evento")}</span></td>
        <td><b>${esc(e.titulo || "—")}</b>${e.treino && e.instrutor ? `<div class="muted" style="font-size:12px">Instrutor: ${esc(e.instrutor)}</div>` : ""}${e.fotos.length ? `<div class="muted" style="font-size:12px">${e.fotos.length} foto${e.fotos.length > 1 ? "s" : ""}</div>` : ""}</td>
        <td class="num">${e.presentes.length}</td><td class="muted" style="font-size:13px">${esc(e.porLabel || "—")}</td></tr>`).join("")}
      </tbody></table></div>` : `<div class="empty">${S.eventos.length ? "Nenhum evento com esses filtros." : "Nenhum evento registrado ainda." + (S.podeRegistrar ? " Use “Registrar evento” para começar." : "")}</div>`}
    </section>
    <section class="panel"><div class="panel-h"><h2>Presença no período</h2></div>
      ${rank.length ? `<div class="panel-b dist">${rank.slice(0, 40).map(r => `<div class="dist-row" style="grid-template-columns:minmax(120px,1.3fr) 1fr 30px"><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${r.m ? `<a href="#" data-a="abrir" data-id="${r.id}" style="color:inherit">${esc(mLabel(r.m))}</a>` : esc(r.nome || "Removido")}</span><div class="bar"><i style="width:${r.n/rmax*100}%"></i></div><span class="num" style="text-align:right">${r.n}</span></div>`).join("")}</div>` : `<div class="empty">Sem presenças no período.</div>`}
    </section>
  </div>`;
}
function textoRelatorio(){
  const lista = eventosFiltrados().slice().sort((a,b) => a.data - b.data);
  const tipo = S.fTipo ? (tipoById(S.fTipo)?.nome || "—") : "Todos";
  const rank = rankingPresenca(lista);
  const L = [];
  L.push("**Relatório de eventos · Exército de Solano**");
  L.push(`Período: ${periodoTexto()} · Tipo: ${tipo}`);
  L.push(`${lista.length} evento${lista.length === 1 ? "" : "s"} · ${lista.reduce((n, e) => n + e.presentes.length, 0)} presenças · ${rank.length} militares`);
  L.push("");
  for (const e of lista) {
    L.push(`• ${fmtTs(e.data)} · ${e.tipo}${e.titulo ? " · " + e.titulo : ""} (${e.presentes.length} presente${e.presentes.length === 1 ? "" : "s"})${e.treino && e.instrutor ? " · Instrutor: " + e.instrutor : ""}`);
    L.push("  " + e.presentes.map(p => mById(p.id) ? mLabel(mById(p.id)) : p.nome).join(", "));
  }
  L.push(""); L.push("**Presença por militar**");
  for (const r of rank) L.push(`${r.m ? mLabel(r.m) : r.nome}: ${r.n}`);
  return L.join("\n");
}
async function carregarFotos(e){
  const falta = e.fotos.filter(f => !S.fotoUrl[f]);
  if (!falta.length) return;
  const { data, error } = await sb.storage.from("eventos").createSignedUrls(falta, 3600);
  if (error) { toast("Não foi possível carregar as fotos: " + error.message, "err"); return; }
  for (const r of data || []) if (r.signedUrl) S.fotoUrl[r.path] = r.signedUrl;
  if (S.selEv === e.id) renderDrawer();
}
function drawerEvento(e){
  const pres = e.presentes.map(p => ({ ...p, m: mById(p.id) })).sort((a,b) => (b.m?.patente ?? -1) - (a.m?.patente ?? -1) || String(a.m?.nome || a.nome).localeCompare(String(b.m?.nome || b.nome), "pt-BR"));
  const ed = podeEditarEv(e);
  if (e.fotos.some(f => !S.fotoUrl[f])) carregarFotos(e);
  return `<div class="scrim" data-a="fechar"></div>
  <aside class="drawer" role="dialog" aria-label="Evento">
    <div class="dr-h"><div style="flex:1"><div style="display:flex;gap:8px;align-items:center;margin-bottom:6px"><span class="tipo-tag ${e.treino ? "treino" : ""}">${esc(e.tipo || "Evento")}</span><span class="muted num" style="font-size:13px">${fmtTs(e.data)}</span></div>
      <h2>${esc(e.titulo || e.tipo || "Evento")}</h2>
      <div class="muted" style="font-size:13px;margin-top:6px">Registrado por ${esc(e.porLabel || "—")}</div></div>
      <button class="btn sm" data-a="fechar" aria-label="Fechar">Fechar</button></div>
    <div class="dr-b">
      ${ed ? `<div class="actions"><button class="btn" data-a="editarEv" data-id="${e.id}">Editar</button><button class="btn danger" data-a="apagarEv" data-id="${e.id}">Apagar evento</button></div>` : ""}
      ${e.treino ? `<dl class="facts"><div><dt>Instrutor responsável</dt><dd>${e.instrutorId && mById(e.instrutorId) ? `<a href="#" data-a="abrir" data-id="${e.instrutorId}" style="color:inherit">${esc(e.instrutor)}</a>` : esc(e.instrutor || "—")}</dd></div><div><dt>Presentes</dt><dd class="num">${pres.length}</dd></div></dl>` : ""}
      ${e.descricao ? `<div class="sec"><h3>${e.treino ? "Conteúdo / relatório" : "Observações"}</h3><div class="relato">${esc(e.descricao)}</div></div>` : ""}
      ${e.fotos.length ? `<div class="sec"><h3>Fotos</h3><div class="fotos">${e.fotos.map(f => S.fotoUrl[f] ? `<a href="${esc(S.fotoUrl[f])}" target="_blank" rel="noopener"><img src="${esc(S.fotoUrl[f])}" alt="Foto do evento" loading="lazy"></a>` : `<span class="foto-ph">Carregando…</span>`).join("")}</div></div>` : ""}
      <div class="sec"><h3>Lista de presença · ${pres.length}</h3><div class="list" style="border:1px solid var(--line);border-radius:6px">${pres.map(p => `<div class="li">${p.m ? chip(p.m.patente) : ""}<span class="grow">${p.m ? `<a href="#" data-a="abrir" data-id="${p.id}" style="color:inherit">${esc(p.m.nome)}</a>${p.m.setorId ? ` <span class="muted" style="font-size:12px">· ${esc(setorNome(p.m.setorId))}</span>` : ""}` : esc(p.nome)}</span></div>`).join("")}</div></div>
    </div></aside>`;
}

function vHist(){
  const items = S.hist.filter(h => !S.fHist || h.tipo === S.fHist);
  return `<section class="panel"><div class="panel-h"><h2>Histórico</h2><span class="sp"><select class="input" id="fHist" aria-label="Filtrar por tipo"><option value="">Todos os tipos</option>${Object.entries(HIST_TIPOS).map(([k,n]) => `<option value="${k}" ${S.fHist === k ? "selected" : ""}>${n}</option>`).join("")}</select></span></div>${feed(items)}</section>`;
}

function vAcessos(){
  if (!isAdm()) return `<div class="empty">Só o ADM Geral gerencia acessos.</div>`;
  if (!S.permDraft) { const d = {}; CARGOS.forEach(c => d[c.k] = {...DEF[c.k], ...(S.perms[c.k] || {})}); S.permDraft = d; }
  const D = S.permDraft;
  const perfilDe = id => S.perfis.find(p => p.user_id === id);
  const comAcesso = new Set(S.staff.map(s => s.user_id));
  const aguardando = S.perfis.filter(p => !comAcesso.has(p.user_id));
  const contas = S.staff.map(s => ({ s, p: perfilDe(s.user_id), m: s.membro_id ? mById(s.membro_id) : null }))
    .sort((a,b) => (b.s.cargo === "adm") - (a.s.cargo === "adm") || (b.m?.patente ?? -1) - (a.m?.patente ?? -1));
  return `<section class="panel"><div class="panel-h"><h2>Aguardando liberação</h2><span class="muted num">${aguardando.length}</span></div>
    <div class="panel-b"><div class="note">Contas criadas no painel que ainda não foram liberadas. Ao liberar, você liga a conta a uma ficha do efetivo (nova ou existente). Confirme no jogo que a conta é mesmo da pessoa: qualquer um pode criar uma conta com qualquer nome.</div></div>
    ${aguardando.length ? `<div class="list">${aguardando.map(p => `<div class="li"><span class="grow"><b>${esc(p.nome_jogo || "Sem nome")}</b><div class="muted" style="font-size:12px">Conta criada em ${fmtTs(ms(p.criado_em))}</div></span>
      <button class="btn pri sm" data-a="liberar" data-id="${esc(p.user_id)}">Liberar</button></div>`).join("")}</div>` : `<div class="empty">Ninguém aguardando. Peça para os militares abrirem o painel e clicarem em Criar conta.</div>`}
  </section>
  <section class="panel"><div class="panel-h"><h2>Contas com acesso</h2><span class="muted num">${contas.length}</span></div>
    <div class="panel-b"><div class="note">O nível de acesso vem da patente da ficha: Major General para cima segue a tabela de limites abaixo; patentes menores só visualizam. Promoção, rebaixamento ou exoneração mudam o acesso na hora.</div></div>
    <div class="list">${contas.map(({s, p, m}) => { const eu = s.user_id === S.uid; const c = s.cargo === "adm" ? "adm" : cargoDaFicha(m);
      return `<div class="li">${m ? chip(m.patente) : ""}<span class="grow"><b>${esc(m ? m.nome : s.nome)}</b><div class="muted" style="font-size:12px">Login: ${esc(p?.nome_jogo || "—")}${eu ? " · você" : ""}${m && m.setorId ? " · " + esc(setorNome(m.setorId)) : ""}</div></span>
      <span class="pill ${c === "adm" || cargoInfo(c) ? "ok" : c === "leitor" ? "mut" : "bad"}">${esc(c ? nivelLabel(c) : "Suspenso")}</span>
      ${s.cargo === "adm" ? "" : `${m ? `<button class="btn sm" data-a="abrir" data-id="${m.id}">Ficha</button>` : ""}
      <button class="btn sm" data-a="resetSenha" data-id="${esc(s.user_id)}">Redefinir senha</button>
      <button class="btn sm danger" data-a="rmAcesso" data-id="${esc(s.user_id)}">Remover acesso</button>`}</div>`; }).join("")}</div>
  </section>
  <section class="panel"><div class="panel-h"><h2>Limites de cada cargo</h2><span class="sp" style="display:flex;gap:8px"><button class="btn" data-a="resetPerm">Restaurar padrão</button><button class="btn pri" data-a="savePerm">Salvar limites</button></span></div>
    <div class="panel-b"><div class="note">Regra fixa para todos: o oficial só promove, pune, edita, exonera ou move de setor militares de patente abaixo da dele. O ADM Geral não tem limites. Esses limites são conferidos pelo banco de dados, não só pela tela.</div></div>
    <div class="tablewrap"><table class="matrix"><thead><tr><th>Permissão</th>${CARGOS.map(c => `<th>${c.n}</th>`).join("")}</tr></thead><tbody>
    ${PERMS.map(([k,n]) => `<tr><td>${n}</td>${CARGOS.map(c => `<td><input type="checkbox" data-a="perm" data-c="${c.k}" data-p="${k}" ${D[c.k][k] ? "checked" : ""} aria-label="${n} para ${c.n}"></td>`).join("")}</tr>`).join("")}
    <tr><td>Patente máxima que pode conceder</td>${CARGOS.map(c => `<td><select class="input" data-a="permMax" data-c="${c.k}" aria-label="Patente máxima para ${c.n}">${PAT.slice(0, c.lv).map((p,i) => `<option value="${i}" ${Number(D[c.k].max_patente) === i ? "selected" : ""}>${esc(p[1])}</option>`).join("")}</select></td>`).join("")}</tr>
    </tbody></table></div>
  </section>`;
}

/* ===== Ficha do militar ===== */
function renderDrawer(){
  const root = $("#drawer-root");
  const ev = S.fase === "app" && !S.sel && S.selEv && S.eventos.find(x => x.id === S.selEv);
  if (ev) { root.innerHTML = drawerEvento(ev); return; }
  const m = S.fase === "app" && S.sel && mById(S.sel);
  if (!m) { root.innerHTML = ""; return; }
  const ex = m.status === "exonerado", act = canActOn(m);
  const pun = S.punicoes.filter(p => p.membroId === m.id), pAt = pun.filter(p => p.ativa), pOld = pun.filter(p => !p.ativa);
  const evs = S.eventos.filter(e => e.presentes.some(p => p.id === m.id)).map(e => ({...e, ars:false}))
    .concat(S.arsenal.filter(a => a.presentes.some(p => p.id === m.id)).map(a => ({id:a.id, ars:true, tipo:"Roubo do Arsenal", titulo:`${a.hora}h · Setor ${setorNome(a.setorId) || "?"}`, data:a.ts, a})))
    .sort((x, y) => y.data - x.data);
  const hist = S.hist.filter(h => h.membroId === m.id).slice(0, 15);
  const b = [];
  if (act && !ex && can("promover")) b.push(`<button class="btn" data-a="promover" data-id="${m.id}">Promover / rebaixar</button>`);
  if (act && !ex && can("setores")) b.push(`<button class="btn" data-a="setorMembro" data-id="${m.id}">Setor e função</button>`);
  if (act && !ex && can("punir")) b.push(`<button class="btn" data-a="punir" data-id="${m.id}">Aplicar punição</button>`);
  if (act && can("editar")) b.push(`<button class="btn" data-a="editar" data-id="${m.id}">Editar dados</button>`);
  if (act && can("exonerar")) b.push(ex ? `<button class="btn" data-a="readmitir" data-id="${m.id}">Readmitir</button>` : `<button class="btn danger" data-a="exonerar" data-id="${m.id}">Exonerar</button>`);
  if (isAdm()) b.push(`<button class="btn danger" data-a="apagarMembro" data-id="${m.id}">Apagar cadastro</button>`);
  root.innerHTML = `<div class="scrim" data-a="fechar"></div>
  <aside class="drawer" role="dialog" aria-label="Ficha de ${esc(m.nome)}">
    <div class="dr-h"><div style="flex:1"><div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:6px">${chip(m.patente)}<span class="muted" style="font-size:13px">${esc(patName(m.patente))}</span>${m.funcao && m.setorId ? fnChip(m.funcao) : ""}</div>
      <h2>${esc(m.nome)}</h2>
      <div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap">${ex ? `<span class="pill mut">Exonerado</span>` : `<span class="pill ok">Ativo</span>`}${pAt.length ? `<span class="pill bad">${pAt.length} punição${pAt.length > 1 ? "ões" : ""} ativa${pAt.length > 1 ? "s" : ""}</span>` : ""}</div></div>
      <button class="btn sm" data-a="fechar" aria-label="Fechar ficha">Fechar</button></div>
    <div class="dr-b">
      <dl class="facts"><div><dt>Discord</dt><dd>${esc(m.discord || "—")}</dd></div>
        <div><dt>Setor</dt><dd>${m.setorId && setorById(m.setorId) ? `${esc(setorNome(m.setorId))}${m.funcao ? ` · ${esc(fnNome(m.funcao))}` : ""}` : "Sem setor"}</dd></div>
        <div><dt>Ingresso</dt><dd class="num">${fmtDate(m.ingresso)}</dd></div><div><dt>Presenças</dt><dd class="num">${S.presTot[m.id]?.total || 0} no total · ${pres30(m.id)} em 30 dias<div class="muted" style="font-size:12px;font-weight:400">${S.presTot[m.id]?.arsenal || 0} no Roubo do Arsenal${S.presTot[m.id]?.justificados ? ` (+${S.presTot[m.id].justificados} justificada${S.presTot[m.id].justificados > 1 ? "s" : ""})` : ""} · ${S.presTot[m.id]?.eventos || 0} em eventos</div></dd></div>
        ${(() => { const c = contaDe(m.id); return c ? `<div><dt>Conta no painel</dt><dd>${esc(nivelLabel(cargoDaFicha(m)) )}</dd></div>` : ""; })()}
        ${m.obs ? `<div style="grid-column:1/-1"><dt>Observações</dt><dd style="font-weight:400;white-space:pre-wrap">${esc(m.obs)}</dd></div>` : ""}</dl>
      ${b.length ? `<div class="actions">${b.join("")}</div>` : ""}
      ${!act ? `<div class="note">Patente igual ou superior à sua: você só pode visualizar este militar.</div>` : ""}
      <div class="sec"><h3>Punições ativas</h3>${pAt.length ? `<div class="list" style="border:1px solid var(--line);border-radius:6px">${pAt.map(p => punRow(p, act)).join("")}</div>` : `<div class="muted" style="font-size:14px">Nenhuma.</div>`}
        ${pOld.length ? `<details style="margin-top:8px"><summary class="muted" style="cursor:pointer;font-size:13px">${pOld.length} revogada${pOld.length > 1 ? "s" : ""}</summary><div class="list" style="border:1px solid var(--line);border-radius:6px;margin-top:6px">${pOld.map(p => punRow(p, false)).join("")}</div></details>` : ""}</div>
      <div class="sec"><h3>Últimas presenças</h3>${evs.length ? `<div class="list" style="border:1px solid var(--line);border-radius:6px">${evs.slice(0, 8).map(e => `<div class="li click-li" ${e.ars ? `data-a="abrirArs" data-id="${e.a.data}|${e.a.hora}|${e.a.setorId}"` : `data-a="abrirEv" data-id="${e.id}"`} tabindex="0"><span class="tipo-tag ${e.treino ? "treino" : e.ars ? "ars" : ""}">${esc(e.tipo || "Evento")}</span><span class="grow">${esc(e.titulo || "")}</span><span class="muted num" style="font-size:13px">${fmtTs(e.data)}</span></div>`).join("")}</div>` : `<div class="muted" style="font-size:14px">Nenhuma presença registrada.</div>`}</div>
      <div class="sec"><h3>Histórico</h3><div style="border:1px solid var(--line);border-radius:6px">${feed(hist)}</div></div>
    </div></aside>`;
}
function punRow(p, act){ return `<div class="li"><span class="grow"><b>${esc(p.tipo)}</b>${p.dias ? ` · ${esc(p.dias)} dia${Number(p.dias) > 1 ? "s" : ""}` : ""}<div style="font-size:13px">${esc(p.motivo)}</div><div class="muted" style="font-size:12px">${esc(p.porLabel || "")} · ${fmtTs(p.em)}${!p.ativa && p.revogadaEm ? ` · revogada ${fmtTs(p.revogadaEm)}` : ""}</div></span>${p.ativa && act && can("revogar") ? `<button class="btn sm" data-a="revogar" data-id="${p.id}">Revogar</button>` : ""}</div>`; }

/* ===== Modais ===== */
let modalSubmit = null;
function openModal(title, body, submitLabel, onSubmit, danger, wide){
  modalSubmit = onSubmit;
  $("#modal-root").innerHTML = `<div class="modal" data-a="mscrim"><form id="mform" class="${wide ? "wide" : ""}" novalidate><h2>${esc(title)}</h2>${body}<div class="mfoot"><button type="button" class="btn" data-a="mclose">Cancelar</button><button type="submit" class="btn ${danger ? "danger" : "pri"}">${esc(submitLabel)}</button></div></form></div>`;
  const first = $("#mform").querySelector("input,select,textarea"); if (first) first.focus();
}
function closeModal(){ $("#modal-root").innerHTML = ""; modalSubmit = null; if (evForm) { evForm.novas.forEach(f => URL.revokeObjectURL(f.url)); evForm = null; } }
function patOptions(max, sel, exclude){ let o = ""; for (let i = max; i >= 0; i--) { if (i === exclude) continue; o += `<option value="${i}" ${i === sel ? "selected" : ""}>${esc(PAT[i][0])} (${esc(PAT[i][1])})</option>`; } return o; }
const motivoField = (ph = "") => `<div class="field"><label for="f-mot">Motivo</label><textarea class="input" id="f-mot" name="motivo" required maxlength="300" placeholder="${esc(ph)}"></textarea></div>`;

function mNovo(){
  const mx = maxPromo();
  openModal("Cadastrar militar", `
    <div class="field"><label for="f-nome">Nome no RP</label><input class="input" id="f-nome" name="nome" required maxlength="60"></div>
    <div class="field"><label for="f-disc">Discord</label><input class="input" id="f-disc" name="discord" required maxlength="40" placeholder="ex.: zezo#0001 ou zezo_rp"></div>
    <div class="row2"><div class="field"><label for="f-pat">Patente inicial</label><select class="input" id="f-pat" name="patente">${patOptions(mx, 0)}</select></div>
    <div class="field"><label for="f-set">Setor</label><select class="input" id="f-set" name="setor">${setorOptions("")}</select></div></div>
    <div class="field"><label for="f-ing">Data de ingresso</label><input class="input" type="date" id="f-ing" name="ingresso" value="${today()}"></div>
    <div class="field"><label for="f-obs">Observações</label><textarea class="input" id="f-obs" name="obs" maxlength="500" placeholder="opcional"></textarea></div>`,
    "Cadastrar", d => {
      if (!d.nome.trim()) return "Informe o nome no RP.";
      if (!d.discord.trim()) return "Informe o Discord do militar.";
      return rpc("cadastrar_membro", {p_nome:d.nome, p_discord:d.discord, p_patente:Number(d.patente)||0, p_setor:d.setor || null, p_ingresso:d.ingresso || null, p_obs:d.obs}, "Militar cadastrado.");
    });
}
function mEditar(m){
  openModal("Editar dados", `
    <div class="field"><label for="f-nome">Nome no RP</label><input class="input" id="f-nome" name="nome" required maxlength="60" value="${esc(m.nome)}"></div>
    <div class="field"><label for="f-disc">Discord</label><input class="input" id="f-disc" name="discord" required maxlength="40" value="${esc(m.discord)}"></div>
    <div class="field"><label for="f-ing">Data de ingresso</label><input class="input" type="date" id="f-ing" name="ingresso" value="${esc(m.ingresso)}"></div>
    <div class="field"><label for="f-obs">Observações</label><textarea class="input" id="f-obs" name="obs" maxlength="500">${esc(m.obs)}</textarea></div>`,
    "Salvar", d => {
      if (!d.nome.trim()) return "Informe o nome no RP.";
      if (!d.discord.trim()) return "Informe o Discord do militar.";
      return rpc("editar_membro", {p_id:m.id, p_nome:d.nome, p_discord:d.discord, p_ingresso:d.ingresso || null, p_obs:d.obs}, "Dados salvos.");
    });
}
// Setor e função de um militar
let modalMembro = null;
function mSetor(m, setorPre, fnPre){
  modalMembro = m.id;
  const setorIni = setorPre !== undefined ? setorPre : (m.setorId || "");
  const fnIni = fnPre !== undefined ? fnPre : (m.funcao || "");
  openModal(`Setor e função · ${mLabel(m)}`, `
    <div class="row2"><div class="field"><label for="f-set">Setor</label><select class="input" id="f-set" name="setor">${setorOptions(setorIni)}</select></div>
    <div class="field"><label for="f-fn">Função no setor</label><select class="input" id="f-fn" name="funcao"><option value="">Nenhuma</option>${FUNCOES.map(([k,n,sg]) => `<option value="${k}" ${k === fnIni ? "selected" : ""}>${sg} · ${n}</option>`).join("")}</select></div></div>
    <div class="note" id="fn-aviso">Se a função já estiver ocupada no setor, quem ocupa perde a função.</div>`,
    "Salvar", d => rpc("definir_setor", {p_id:m.id, p_setor:d.setor || null, p_funcao:d.setor ? (d.funcao || null) : null}, "Setor atualizado."));
  atualizarAvisoFuncao(m.id);
}
function atualizarAvisoFuncao(idAtual){
  const st = $("#f-set")?.value, fn = $("#f-fn")?.value, av = $("#fn-aviso"); if (!av) return;
  if (!st) { av.textContent = "Sem setor: o militar fica fora de qualquer setor e sem função."; return; }
  if (!fn) { av.textContent = "O militar fica no setor sem função."; return; }
  const h = S.membros.find(x => x.setorId === st && x.funcao === fn && x.id !== idAtual && x.status === "ativo");
  av.innerHTML = h ? `<b>${esc(fnSigla(fn))}</b> do Setor ${esc(setorNome(st))} hoje é <b>${esc(mLabel(h))}</b>. Ao salvar, ele perde a função e continua no setor.` : `${esc(fnSigla(fn))} do Setor ${esc(setorNome(st))} está vago.`;
}
// Escolher militar para uma função ou para entrar num setor
function mEscolherMilitar(setorId, fn){
  const st = setorById(setorId); if (!st) return;
  const atual = fn ? S.membros.find(x => x.setorId === setorId && x.funcao === fn && x.status === "ativo") : null;
  const op = S.membros.filter(m => m.status === "ativo" && canActOn(m) && m.id !== atual?.id && (fn || m.setorId !== setorId))
    .sort((a,b) => (b.setorId === setorId) - (a.setorId === setorId) || b.patente - a.patente || String(a.nome).localeCompare(String(b.nome), "pt-BR"));
  openModal(fn ? `${fnSigla(fn)} · Setor ${st.nome}` : `Adicionar ao Setor ${st.nome}`, `
    ${atual ? `<div class="note">Hoje: <b>${esc(mLabel(atual))}</b>. Ao trocar, ele perde a função e continua no setor.</div>` : ""}
    <div class="field"><label for="f-mil">Militar</label><select class="input" id="f-mil" name="mil" required><option value="">Selecione…</option>${op.map(m => `<option value="${m.id}">${esc(mLabel(m))}${m.setorId ? (m.setorId === setorId ? " · já está no setor" : " · " + esc(setorNome(m.setorId))) : " · sem setor"}</option>`).join("")}</select>
    <span class="hint">Se o militar estiver em outro setor, ele é transferido para o Setor ${esc(st.nome)}.</span></div>
    ${atual && can("setores") ? `<label style="display:flex;gap:8px;align-items:center;font-size:14px"><input type="checkbox" name="vagar" id="f-vagar"> Só deixar a função vaga</label>` : ""}`,
    fn ? (atual ? "Trocar" : "Atribuir") : "Adicionar", d => {
      if (d.vagar && atual) return rpc("definir_setor", {p_id:atual.id, p_setor:setorId, p_funcao:null}, "Função vaga.");
      if (!d.mil) return "Selecione um militar.";
      return rpc("definir_setor", {p_id:d.mil, p_setor:setorId, p_funcao:fn || null}, fn ? "Função atribuída." : "Militar adicionado ao setor.");
    });
}
function mNomeSetor(st){
  openModal(st ? `Renomear Setor ${st.nome}` : "Novo setor", `<div class="field"><label for="f-sn">Nome do setor</label><input class="input" id="f-sn" name="nome" maxlength="40" required value="${esc(st?.nome || "")}" placeholder="ex.: Oeste"></div>`,
    st ? "Salvar" : "Criar", d => {
      if (!d.nome.trim()) return "Informe o nome do setor.";
      return st ? rpc("renomear_setor", {p_id:st.id, p_nome:d.nome}, "Setor renomeado.") : rpc("criar_setor", {p_nome:d.nome}, "Setor criado.");
    });
}
// Liberar conta: ficha nova ou ficha existente
function mLiberar(p){
  const livres = S.membros.filter(m => m.status === "ativo" && !contaDe(m.id)).sort((a,b) => String(a.nome).localeCompare(String(b.nome), "pt-BR"));
  const parecido = livres.find(m => m.nome.toLowerCase().trim() === String(p.nome_jogo || "").toLowerCase().trim());
  openModal(`Liberar conta · ${p.nome_jogo || ""}`, `
    <div class="field"><label>Ficha do efetivo</label>
      <label style="display:flex;gap:8px;align-items:center;font-size:14px"><input type="radio" name="modo" value="nova" ${parecido ? "" : "checked"}> Criar uma ficha nova</label>
      <label style="display:flex;gap:8px;align-items:center;font-size:14px"><input type="radio" name="modo" value="existente" ${parecido ? "checked" : ""} ${livres.length ? "" : "disabled"}> Ligar a uma ficha que já existe${livres.length ? "" : " (nenhuma disponível)"}</label></div>
    <div id="lib-nova" ${parecido ? "hidden" : ""}>
      <div class="field"><label for="f-nome">Nome no RP</label><input class="input" id="f-nome" name="nome" maxlength="60" value="${esc(p.nome_jogo || "")}"></div>
      <div class="field"><label for="f-disc">Discord</label><input class="input" id="f-disc" name="discord" maxlength="40"></div>
      <div class="row2"><div class="field"><label for="f-pat">Patente</label><select class="input" id="f-pat" name="patente">${patOptions(PAT.length - 1, 0)}</select></div>
      <div class="field"><label for="f-set">Setor</label><select class="input" id="f-set" name="setor">${setorOptions("")}</select></div></div>
    </div>
    <div id="lib-exist" ${parecido ? "" : "hidden"}>
      <div class="field"><label for="f-mem">Ficha</label><select class="input" id="f-mem" name="membro"><option value="">Selecione…</option>${livres.map(m => `<option value="${m.id}" ${m === parecido ? "selected" : ""}>${esc(mLabel(m))}${m.setorId ? " · " + esc(setorNome(m.setorId)) : ""}</option>`).join("")}</select></div>
    </div>
    <div class="note">A patente da ficha define o acesso: Major General para cima segue a tabela de limites; abaixo disso, só visualiza.</div>`,
    "Liberar", async d => {
      let args;
      if (d.modo === "existente") { if (!d.membro) return "Selecione a ficha."; args = {p_user:p.user_id, p_membro:d.membro, p_nome:null, p_discord:null, p_patente:null, p_setor:null}; }
      else { if (!d.nome.trim()) return "Informe o nome no RP."; if (!d.discord.trim()) return "Informe o Discord."; args = {p_user:p.user_id, p_membro:null, p_nome:d.nome, p_discord:d.discord, p_patente:Number(d.patente)||0, p_setor:d.setor || null}; }
      const ok = await rpc("liberar_conta", args, "Conta liberada.");
      if (ok) await carregar(["staff","perfis"]), render();
      return ok;
    });
}

function mPromover(m){
  const mx = maxPromo(), cur = Number(m.patente);
  openModal(`Promover / rebaixar ${m.nome}`, `
    <div class="note">Patente atual: <b>${esc(patName(cur))}</b>. Você pode conceder até <b>${esc(patName(mx))}</b>.</div>
    <div class="field"><label for="f-np">Nova patente</label><select class="input" id="f-np" name="np">${patOptions(mx, Math.min(cur + 1, mx), cur)}</select></div>
    ${motivoField("Ex.: concluiu o curso de sargento, mérito em operação")}`,
    "Confirmar", d => {
      if (!d.motivo.trim()) return "Informe o motivo.";
      const np = Number(d.np);
      return rpc("alterar_patente", {p_id:m.id, p_nova:np, p_motivo:d.motivo}, np > cur ? "Promoção registrada." : "Rebaixamento registrado.");
    });
}
function mPunir(m){
  openModal(`Aplicar punição a ${m.nome}`, `
    <div class="row2"><div class="field"><label for="f-tp">Tipo</label><select class="input" id="f-tp" name="tipo">${PUN_TIPOS.map(t => `<option>${esc(t)}</option>`).join("")}</select></div>
    <div class="field"><label for="f-dias">Duração em dias</label><input class="input" type="number" min="0" max="365" id="f-dias" name="dias" placeholder="opcional"></div></div>
    ${motivoField()}`,
    "Aplicar punição", d => {
      if (!d.motivo.trim()) return "Informe o motivo.";
      return rpc("aplicar_punicao", {p_id:m.id, p_tipo:d.tipo, p_dias:Number(d.dias)||0, p_motivo:d.motivo}, "Punição aplicada.");
    }, true);
}
function mRevogar(p){
  const m = mById(p.membroId);
  openModal("Revogar punição", `<div class="note">${esc(p.tipo)} de <b>${esc(mLabel(m))}</b>: ${esc(p.motivo)}</div>${motivoField()}`,
    "Revogar", d => d.motivo.trim() ? rpc("revogar_punicao", {p_punicao:p.id, p_motivo:d.motivo}, "Punição revogada.") : "Informe o motivo.");
}
function mExonerar(m){
  openModal(`Exonerar ${m.nome}`, `<div class="note">O militar sai do efetivo ativo. O histórico e as horas ficam guardados e ele pode ser readmitido depois.</div>${motivoField()}`,
    "Exonerar", d => d.motivo.trim() ? rpc("exonerar", {p_id:m.id, p_motivo:d.motivo}, "Militar exonerado.") : "Informe o motivo.", true);
}
function mReadmitir(m){
  const mx = Math.max(maxPromo(), 0);
  openModal(`Readmitir ${m.nome}`, `<div class="field"><label for="f-np">Patente na readmissão</label><select class="input" id="f-np" name="np">${patOptions(mx, Math.min(Number(m.patente), mx))}</select></div>${motivoField()}`,
    "Readmitir", d => d.motivo.trim() ? rpc("readmitir", {p_id:m.id, p_patente:Number(d.np)||0, p_motivo:d.motivo}, "Militar readmitido.") : "Informe o motivo.");
}
// Reduz a foto antes de enviar (máx. 1600 px, JPEG) para economizar o armazenamento gratuito
async function comprimir(file){
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas"); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  return await new Promise((ok, falha) => c.toBlob(b => b ? ok(b) : falha(new Error("Não foi possível ler a imagem.")), "image/jpeg", 0.82));
}
let evForm = null; // { ev, manter:Set(fotos existentes), novas:[File] }
function mEvento(ev){
  if (!S.tipos.length) { toast("Cadastre um tipo de evento antes.", "err"); return; }
  evForm = { ev, manter: new Set(ev?.fotos || []), novas: [] };
  const presentes = new Set((ev?.presentes || []).map(p => p.id));
  const cand = S.membros.filter(m => m.status === "ativo" || presentes.has(m.id))
    .sort((a,b) => b.patente - a.patente || String(a.nome).localeCompare(String(b.nome), "pt-BR"));
  const tipoIni = ev?.tipoId && tipoById(ev.tipoId) ? ev.tipoId : S.tipos[0].id;
  const treinoIni = !!tipoById(tipoIni)?.treinamento;
  openModal(ev ? "Editar evento" : "Registrar evento", `
    <div class="row2"><div class="field"><label for="e-tipo">Tipo</label><select class="input" id="e-tipo" name="tipo">${S.tipos.map(t => `<option value="${t.id}" ${t.id === tipoIni ? "selected" : ""}>${esc(t.nome)}</option>`).join("")}</select></div>
    <div class="field"><label for="e-data">Data e horário</label><input class="input" type="datetime-local" id="e-data" name="data" required value="${toLocalInput(ev?.data || Date.now())}"></div></div>
    <div class="field"><label for="e-tit">Título <span class="muted" style="font-weight:400">(opcional)</span></label><input class="input" id="e-tit" name="titulo" maxlength="80" value="${esc(ev?.titulo || "")}" placeholder="ex.: Arsenal da zona norte, Treino de tiro"></div>
    <div class="field" id="e-inst-box" ${treinoIni ? "" : "hidden"}><label for="e-inst">Instrutor responsável</label><select class="input" id="e-inst" name="instrutor"><option value="">Selecione…</option>${S.membros.filter(m => m.status === "ativo" || m.id === ev?.instrutorId).sort((a,b) => b.patente - a.patente).map(m => `<option value="${m.id}" ${m.id === ev?.instrutorId ? "selected" : ""}>${esc(mLabel(m))}</option>`).join("")}</select></div>
    <div class="field"><label for="e-desc" id="e-desc-lbl">${treinoIni ? "Conteúdo / relatório do treinamento" : "Observações"}</label><textarea class="input" id="e-desc" name="descricao" maxlength="4000" placeholder="${treinoIni ? "O que foi treinado, como foi, destaques…" : "opcional"}">${esc(ev?.descricao || "")}</textarea></div>
    <div class="field"><label>Lista de presença · <span id="e-cont">${presentes.size}</span> marcados</label>
      <div class="toolbar"><input class="input" id="e-busca" type="search" placeholder="Filtrar nome" style="flex:1 1 140px" aria-label="Filtrar militares">
        <select class="input" id="e-setor" aria-label="Filtrar por setor"><option value="">Todos os setores</option>${S.setores.map(x => `<option value="${x.id}">${esc(x.nome)}</option>`).join("")}<option value="-">Sem setor</option></select></div>
      <div class="toolbar"><button type="button" class="btn sm" data-a="marcarVis">Marcar visíveis</button><button type="button" class="btn sm" data-a="desmarcarVis">Desmarcar visíveis</button></div>
      <div class="checklist" id="e-lista">${cand.map(m => `<label class="ck" data-nome="${esc(m.nome.toLowerCase())}" data-setor="${m.setorId || "-"}"><input type="checkbox" name="presente" value="${m.id}" ${presentes.has(m.id) ? "checked" : ""}> ${chip(m.patente)} <span>${esc(m.nome)}</span>${m.setorId ? `<span class="muted" style="font-size:12px;margin-left:auto">${esc(setorNome(m.setorId))}</span>` : ""}</label>`).join("") || `<div class="muted">Nenhum militar ativo.</div>`}</div></div>
    <div class="field"><label>Fotos <span class="muted" style="font-weight:400">(até 6)</span></label>
      <div class="fotos" id="e-fotos"></div>
      <input type="file" id="e-arq" accept="image/jpeg,image/png,image/webp" multiple class="input"></div>`,
    ev ? "Salvar alterações" : "Registrar evento", salvarEventoForm, false, true);
  desenharFotosForm();
}
function desenharFotosForm(){
  const box = $("#e-fotos"); if (!box || !evForm) return;
  const ex = [...evForm.manter].map(f => `<span class="foto-mini">${S.fotoUrl[f] ? `<img src="${esc(S.fotoUrl[f])}" alt="">` : `<span class="foto-ph">foto</span>`}<button type="button" data-a="rmFotoEx" data-id="${esc(f)}" aria-label="Remover foto">×</button></span>`);
  const nv = evForm.novas.map((f, i) => `<span class="foto-mini"><img src="${esc(f.url)}" alt=""><button type="button" data-a="rmFotoNova" data-id="${i}" aria-label="Remover foto">×</button></span>`);
  box.innerHTML = ex.concat(nv).join("");
  if (evForm.ev) { const falta = [...evForm.manter].filter(f => !S.fotoUrl[f]); if (falta.length) carregarFotos({ id: null, fotos: falta }).then(desenharFotosForm); }
}
async function salvarEventoForm(){
  const form = $("#mform");
  const tipo = form.tipo.value, data = fromLocalInput(form.data.value);
  const presentes = [...form.querySelectorAll('input[name="presente"]:checked')].map(i => i.value);
  const treino = !!tipoById(tipo)?.treinamento;
  if (!data) return "Informe a data e o horário.";
  if (data > Date.now() + 864e5) return "A data do evento não pode estar no futuro.";
  if (treino && !form.instrutor.value) return "Informe o instrutor responsável.";
  if (!presentes.length) return "Marque pelo menos um militar presente.";
  if (evForm.manter.size + evForm.novas.length > 6) return "Máximo de 6 fotos por evento.";
  const id = evForm.ev?.id || crypto.randomUUID();
  const btn = form.querySelector('button[type="submit"]');
  const enviadas = [];
  try {
    for (let i = 0; i < evForm.novas.length; i++) {
      btn.textContent = `Enviando foto ${i + 1} de ${evForm.novas.length}…`;
      const blob = await comprimir(evForm.novas[i].file);
      const path = `${id}/${Date.now()}-${i}.jpg`;
      const { error } = await sb.storage.from("eventos").upload(path, blob, { contentType: "image/jpeg" });
      if (error) throw new Error("Falha ao enviar foto: " + error.message);
      enviadas.push(path);
    }
  } catch (e) {
    if (enviadas.length) sb.storage.from("eventos").remove(enviadas);
    btn.textContent = evForm.ev ? "Salvar alterações" : "Registrar evento";
    return e.message || "Falha ao enviar as fotos.";
  }
  btn.textContent = "Salvando…";
  const removidas = (evForm.ev?.fotos || []).filter(f => !evForm.manter.has(f));
  const ok = await rpc("salvar_evento", { p_id:id, p_tipo:tipo, p_titulo:form.titulo.value, p_data:new Date(data).toISOString(),
    p_instrutor: treino ? (form.instrutor.value || null) : null, p_descricao:form.descricao.value, p_presentes:presentes, p_fotos:[...evForm.manter, ...enviadas] },
    evForm.ev ? "Evento atualizado." : "Evento registrado.");
  if (!ok) { if (enviadas.length) sb.storage.from("eventos").remove(enviadas); btn.textContent = evForm.ev ? "Salvar alterações" : "Registrar evento"; return false; }
  if (removidas.length) sb.storage.from("eventos").remove(removidas);
  evForm.novas.forEach(f => URL.revokeObjectURL(f.url));
  if (!evForm.ev) { S.selEv = id; S.sel = null; setTimeout(renderDrawer, 0); }
  evForm = null;
  return true;
}
function filtrarChecklist(){
  const qq = ($("#e-busca")?.value || "").trim().toLowerCase(), st = $("#e-setor")?.value || "";
  document.querySelectorAll("#e-lista .ck").forEach(el => { el.hidden = !((!qq || el.dataset.nome.includes(qq)) && (!st || el.dataset.setor === st)); });
}
function contarChecklist(){ const c = $("#e-cont"); if (c) c.textContent = document.querySelectorAll('#e-lista input[name="presente"]:checked').length; }
function mTipos(){
  openModal("Tipos de evento", `
    <div class="note">Tipos marcados como <b>treinamento</b> pedem instrutor e relatório. Apagar um tipo não apaga os eventos antigos, que guardam o nome.</div>
    <div class="list" style="border:1px solid var(--line);border-radius:6px">${S.tipos.map(t => `<div class="li"><input class="input" id="tn-${t.id}" value="${esc(t.nome)}" maxlength="40" style="flex:1 1 140px" aria-label="Nome do tipo">
      <label style="display:flex;gap:6px;align-items:center;font-size:13px"><input type="checkbox" id="tt-${t.id}" ${t.treinamento ? "checked" : ""}> treinamento</label>
      <button type="button" class="btn sm" data-a="tipoSalvar" data-id="${t.id}">Salvar</button><button type="button" class="btn sm danger" data-a="tipoApagar" data-id="${t.id}">Apagar</button></div>`).join("")}</div>
    <div class="field"><label for="tn-novo">Novo tipo</label><div class="toolbar"><input class="input" id="tn-novo" maxlength="40" placeholder="ex.: Patrulha, Escolta, Operação" style="flex:1 1 160px">
      <label style="display:flex;gap:6px;align-items:center;font-size:13px"><input type="checkbox" id="tt-novo"> treinamento</label>
      <button type="button" class="btn sm pri" data-a="tipoNovo">Adicionar</button></div></div>`,
    "Concluído", () => true);
}
async function acaoTipo(fn, args, ok){
  const { error } = await sb.rpc(fn, args);
  if (error) { toast(error.message, "err"); return; }
  toast(ok); await carregar(["tipos_evento"]); render(); if ($("#modal-root").innerHTML) mTipos();
}

function mTrocarSenha(){
  openModal("Trocar senha", `
    <div class="field"><label for="f-s1">Nova senha</label><input class="input" type="password" id="f-s1" name="s1" minlength="6" autocomplete="new-password" required></div>
    <div class="field"><label for="f-s2">Confirmar nova senha</label><input class="input" type="password" id="f-s2" name="s2" minlength="6" autocomplete="new-password" required></div>`,
    "Salvar", async d => {
      if (!d.s1 || d.s1.length < 6) return "A senha precisa ter pelo menos 6 caracteres.";
      if (d.s1 !== d.s2) return "As senhas não são iguais.";
      const { error } = await sb.auth.updateUser({ password: d.s1 });
      if (error) return erroAuth(error);
      toast("Senha alterada."); return true;
    });
}
function mResetSenha(s){
  openModal(`Redefinir senha de ${s.nome}`, `
    <div class="note">Use quando o oficial esquecer a senha. Passe a senha nova para ele em particular e peça para trocar em "Trocar senha" depois de entrar.</div>
    <div class="field"><label for="f-s1">Senha nova</label><input class="input" id="f-s1" name="s1" minlength="6" autocomplete="off" required></div>`,
    "Redefinir", async d => {
      if (!d.s1 || d.s1.length < 6) return "A senha precisa ter pelo menos 6 caracteres.";
      const { error } = await sb.rpc("redefinir_senha", { p_user: s.user_id, p_senha: d.s1 });
      if (error) return error.message;
      toast("Senha redefinida."); return true;
    });
}
function mConfirm(title, html, label, fn){ openModal(title, `<div class="note">${html}</div>`, label, fn, true); }

/* ===== Eventos ===== */
document.addEventListener("click", e => {
  const t = e.target.closest("[data-a]"); if (!t) return;
  const a = t.dataset.a, id = t.dataset.id;
  if (a === "mscrim" && e.target !== t) return;
  if (t.tagName === "A" || a === "abrir") e.preventDefault();
  if (t.tagName === "SELECT" || t.type === "radio") return;
  if (t.type === "checkbox") return;
  const m = id ? mById(id) : null;
  switch (a) {
    case "modoCriar": S.authModo = "criar"; render(); break;
    case "modoEntrar": S.authModo = "entrar"; render(); break;
    case "trocarSenha": mTrocarSenha(); break;
    case "resetSenha": { const s2 = S.staff.find(x => x.user_id === id); s2 && mResetSenha(s2); break; }
    case "sair": sb.auth.signOut(); break;
    case "verificar": recarregarMeuCargo(); break;
    case "assumirAdm": (async () => { const { error } = await sb.rpc("assumir_adm"); if (error) toast(error.message, "err"); else { toast("Você agora é o ADM Geral."); recarregarMeuCargo(); } })(); break;
    case "tab": S.tab = id; S.sel = null; S.selEv = null; if (id !== "acessos") S.permDraft = null; render(); window.scrollTo(0, 0); break;
    case "abrir": S.sel = id; renderDrawer(); break;
    case "fechar": if (S.sel && S.selEv) S.sel = null; else { S.sel = null; S.selEv = null; } renderDrawer(); break;
    case "novo": if (can("cadastrar")) mNovo(); break;
    case "editar": m && mEditar(m); break;
    case "promover": m && mPromover(m); break;
    case "punir": m && mPunir(m); break;
    case "revogar": { const p = S.punicoes.find(x => x.id === id); p && mRevogar(p); break; }
    case "exonerar": m && mExonerar(m); break;
    case "readmitir": m && mReadmitir(m); break;
    case "horas": m && mHoras(m); break;
    case "apagarMembro": m && mConfirm("Apagar cadastro", `Apagar de vez o cadastro de <b>${esc(mLabel(m))}</b>? O histórico continua, mas a ficha, as punições e as presenças dele somem. Para tirar alguém do efetivo, prefira Exonerar.`, "Apagar", async () => { const ok = await rpc("apagar_membro", {p_id:m.id}, "Cadastro apagado."); if (ok) S.sel = null; return ok; }); break;
    case "abrirEv": S.selEv = id; S.sel = null; renderDrawer(); break;
    case "abrirArs": { const [d, h, st] = id.split("|"); S.sel = null; S.selEv = null; S.tab = "arsenal"; S.arsSujo = false; S.arsData = d; S.arsHora = Number(h); S.arsSetor = st; render(); window.scrollTo(0, 0); break; }
    case "arsHora": trocarArsenal("arsHora", Number(id)); break;
    case "arsDia": { const d = new Date(); d.setDate(d.getDate() - Number(id)); trocarArsenal("arsData", `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`); break; }
    case "resFiltro": S.resFiltro = id; render(); break;
    case "resDia": { const d = new Date(); d.setDate(d.getDate() - Number(id)); S.resData = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; render(); break; }
    case "arsCel": { const [h, st] = id.split("|"); const ir = () => { S.arsSujo = false; S.arsHora = Number(h); S.arsSetor = st; render(); };
      if (S.arsSujo && (Number(h) !== S.arsHora || st !== S.arsSetor)) mConfirm("Descartar alterações?", "A lista atual tem marcações que não foram salvas. Trocar agora descarta essas marcações.", "Descartar e trocar", () => { ir(); return true; }); else ir(); break; }
    case "arsTodos": case "arsNenhum": document.querySelectorAll(".ars-lista select[data-a='arsStatus']").forEach(i => { if (!i.disabled) S.arsSel.set(i.dataset.id, a === "arsTodos" ? "ativo" : "inativo"); }); S.arsSujo = true; render(); break;
    case "arsSalvar": (async () => {
      const g = { ativo: [], justificado: [], inativo: [] };
      document.querySelectorAll(".ars-lista select[data-a='arsStatus']").forEach(i => g[S.arsSel.get(i.dataset.id) || "inativo"].push(i.dataset.id));
      const ok = await rpc("salvar_arsenal", { p_data:S.arsData, p_hora:S.arsHora, p_setor:S.arsSetor, p_ativos:g.ativo, p_justificados:g.justificado, p_inativos:g.inativo }, "Lista salva.");
      if (ok) { S.arsSujo = false; render(); } })(); break;
    case "arsCopiar": if (!podeResumo()) break; navigator.clipboard.writeText(textoResumoArsenal()).then(() => toast("Resumo copiado. Cole no Discord ou onde quiser."), () => toast("Não foi possível copiar automaticamente.", "err")); break;
    case "novoEv": if (S.podeRegistrar) mEvento(null); break;
    case "editarEv": { const ev = S.eventos.find(x => x.id === id); ev && mEvento(ev); break; }
    case "apagarEv": { const ev = S.eventos.find(x => x.id === id); if (!ev) break;
      mConfirm("Apagar evento", `Apagar <b>${esc(ev.tipo)}${ev.titulo ? " · " + esc(ev.titulo) : ""}</b> de ${fmtTs(ev.data)}? A lista de presença (${ev.presentes.length}) e as fotos também serão apagadas.`, "Apagar", async () => {
        const { data, error } = await sb.rpc("apagar_evento", { p_id: ev.id });
        if (error) return error.message;
        if (data && data.length) sb.storage.from("eventos").remove(data);
        toast("Evento apagado."); S.selEv = null; await carregar(["eventos","presencas","historico"]); render(); return true; }); break; }
    case "periodo": { const agora = new Date();
      if (id === "limpar") { S.fDe = ""; S.fAte = ""; S.fTipo = ""; S.qEv = ""; }
      else { const ini = new Date(agora); if (id === "hoje") ini.setHours(0, 0, 0, 0); else { ini.setDate(ini.getDate() - Number(id)); ini.setHours(0, 0, 0, 0); }
        S.fDe = toLocalInput(ini.getTime()); S.fAte = ""; }
      render(); break; }
    case "copiarRel": { const txt = textoRelatorio();
      navigator.clipboard.writeText(txt).then(() => toast("Relatório copiado. Cole no Discord ou onde quiser."), () => toast("Não foi possível copiar automaticamente.", "err")); break; }
    case "tiposEv": mTipos(); break;
    case "tipoSalvar": acaoTipo("editar_tipo_evento", { p_id:id, p_nome:$("#tn-" + id).value, p_treinamento:$("#tt-" + id).checked }, "Tipo salvo."); break;
    case "tipoApagar": { const t = tipoById(id); if (t) acaoTipo("apagar_tipo_evento", { p_id:id }, `Tipo ${t.nome} apagado.`); break; }
    case "tipoNovo": acaoTipo("criar_tipo_evento", { p_nome:$("#tn-novo").value, p_treinamento:$("#tt-novo").checked }, "Tipo criado."); break;
    case "marcarVis": case "desmarcarVis": document.querySelectorAll("#e-lista .ck").forEach(el => { if (!el.hidden) el.querySelector("input").checked = a === "marcarVis"; }); contarChecklist(); break;
    case "rmFotoEx": evForm?.manter.delete(id); desenharFotosForm(); break;
    case "rmFotoNova": if (evForm) { const f = evForm.novas.splice(Number(id), 1)[0]; if (f) URL.revokeObjectURL(f.url); desenharFotosForm(); } break;
    case "liberar": { const p = S.perfis.find(x => x.user_id === id); p && mLiberar(p); break; }
    case "rmAcesso": { const s2 = S.staff.find(x => x.user_id === id); const mm = s2?.membro_id && mById(s2.membro_id);
      s2 && mConfirm("Remover acesso", `Remover o acesso ao painel de <b>${esc(mm ? mLabel(mm) : s2.nome)}</b>? A ficha continua no efetivo; só o login deixa de funcionar até ser liberado de novo.`, "Remover acesso",
        async () => { const ok = await rpc("remover_acesso", {p_user:id}, "Acesso removido."); if (ok) { await carregar(["staff","perfis"]); render(); } return ok; }); break; }
    case "setorMembro": m && mSetor(m); break;
    case "novoSetor": mNomeSetor(null); break;
    case "renomearSetor": { const st = setorById(id); st && mNomeSetor(st); break; }
    case "apagarSetor": { const st = setorById(id); if (!st) break; const n = S.membros.filter(x => x.setorId === id && x.status === "ativo").length;
      mConfirm("Apagar setor", `Apagar o Setor <b>${esc(st.nome)}</b>?${n ? ` Os ${n} militar${n > 1 ? "es" : ""} dele ficam sem setor e sem função.` : ""}`, "Apagar", () => rpc("apagar_setor", {p_id:id}, "Setor apagado.")); break; }
    case "atribuirFuncao": mEscolherMilitar(id, t.dataset.fn); break;
    case "addAoSetor": mEscolherMilitar(id, null); break;
    case "savePerm": (async () => { const { error } = await sb.rpc("salvar_permissoes", {p:S.permDraft}); if (error) toast(error.message, "err"); else { toast("Limites salvos."); await carregar(["cargo_perms"]); S.permDraft = null; render(); } })(); break;
    case "resetPerm": S.permDraft = JSON.parse(JSON.stringify(DEF)); render(); toast("Padrão restaurado. Clique em Salvar limites para aplicar."); break;
    case "mclose": case "mscrim": closeModal(); break;
  }
});
document.addEventListener("submit", async e => {
  if (e.target.id === "authform") {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]'); btn.disabled = true;
    const r = await autenticar(Object.fromEntries(new FormData(e.target).entries()));
    if (typeof r === "string") { btn.disabled = false; toast(r, "err"); }
    return;
  }
  if (e.target.id !== "mform") return; e.preventDefault(); if (!modalSubmit) return;
  const d = Object.fromEntries(new FormData(e.target).entries());
  const btn = e.target.querySelector('button[type="submit"]'); btn.disabled = true;
  const r = await modalSubmit(d);
  if (typeof r === "string") { btn.disabled = false; toast(r, "err"); return; }
  if (r) closeModal(); else btn.disabled = false;
});
document.addEventListener("input", e => {
  if (e.target.id === "q") { S.q = e.target.value; render(); }
  else if (e.target.id === "qEv") { S.qEv = e.target.value; render(); }
  else if (e.target.id === "e-busca") filtrarChecklist();
});
document.addEventListener("change", e => {
  const t = e.target;
  if (t.id === "fPat") { S.fPat = t.value; render(); }
  else if (t.id === "fSetor") { S.fSetor = t.value; render(); }
  else if (t.id === "fTipo") { S.fTipo = t.value; render(); }
  else if (t.id === "resData") { if (t.value) { S.resData = t.value > today() ? today() : t.value; render(); } }
  else if (t.id === "arsData") { if (t.value) trocarArsenal("arsData", t.value > today() ? today() : t.value); }
  else if (t.id === "arsSetor") { const v = t.value; t.value = S.arsSetor; trocarArsenal("arsSetor", v); }
  else if (t.dataset.a === "arsStatus") { S.arsSel.set(t.dataset.id, t.value); S.arsSujo = true;
    t.className = `input st-sel st-${t.value}`;
    const c = { ativo: 0, justificado: 0, inativo: 0 }; document.querySelectorAll(".ars-lista select[data-a='arsStatus']").forEach(i => c[S.arsSel.get(i.dataset.id) || "inativo"]++);
    const el = $("#ars-cont"); if (el) el.innerHTML = contHTML(c);
    const b = document.querySelector("[data-a='arsSalvar']"); if (b) { b.disabled = false; b.textContent = "Salvar lista"; } }
  else if (t.id === "fDe") { S.fDe = t.value; render(); }
  else if (t.id === "fAte") { S.fAte = t.value; render(); }
  else if (t.id === "e-setor") filtrarChecklist();
  else if (t.name === "presente") contarChecklist();
  else if (t.id === "e-tipo") { const tr = !!tipoById(t.value)?.treinamento; $("#e-inst-box").hidden = !tr; $("#e-desc-lbl").textContent = tr ? "Conteúdo / relatório do treinamento" : "Observações"; }
  else if (t.id === "e-arq" && evForm) {
    const novos = [...t.files].filter(f => /^image\//.test(f.type));
    const livres = 6 - evForm.manter.size - evForm.novas.length;
    if (novos.length > livres) toast(`Máximo de 6 fotos. ${livres > 0 ? "Só as " + livres + " primeiras foram adicionadas." : ""}`, "err");
    novos.slice(0, Math.max(0, livres)).forEach(f => evForm.novas.push({ file: f, url: URL.createObjectURL(f) }));
    t.value = ""; desenharFotosForm();
  }
  else if (t.name === "modo" && t.type === "radio") { $("#lib-nova").hidden = t.value !== "nova"; $("#lib-exist").hidden = t.value !== "existente"; }
  else if ((t.id === "f-set" || t.id === "f-fn") && $("#fn-aviso")) atualizarAvisoFuncao(modalMembro);
  else if (t.id === "fStatus") { S.fStatus = t.value; render(); }
  else if (t.id === "fHist") { S.fHist = t.value; render(); }
  else if (t.dataset.a === "perm") S.permDraft[t.dataset.c][t.dataset.p] = t.checked;
  else if (t.dataset.a === "permMax") S.permDraft[t.dataset.c].max_patente = Number(t.value);
});
document.addEventListener("keydown", e => {
  if (e.key === "Escape") { if ($("#modal-root").innerHTML) closeModal(); else if (S.sel || S.selEv) { if (S.sel && S.selEv) S.sel = null; else { S.sel = null; S.selEv = null; } renderDrawer(); } }
  if (e.key === "Enter" && e.target.matches("tr[data-a='abrir']")) { S.sel = e.target.dataset.id; renderDrawer(); }
  if (e.key === "Enter" && e.target.matches("[data-a='abrirEv']")) { S.selEv = e.target.dataset.id; S.sel = null; renderDrawer(); }
});

window.addEventListener("beforeunload", e => { if (S.arsSujo) { e.preventDefault(); e.returnValue = ""; } });
boot().catch(e => { S.fase = "erro"; S.err = "Não foi possível iniciar o painel: " + (e.message || e); render(); });
