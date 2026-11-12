// Exército de Solano · Controle de Efetivo
// Front-end estático (GitHub Pages / Vercel) + Supabase (banco, login, tempo real).
// Login: nome usado no jogo + senha. Por baixo, o Supabase usa um e-mail interno
// (nome-normalizado@DOMINIO_LOGIN) que ninguém precisa conhecer.
// Toda alteração passa por funções do banco (supabase/schema.sql) que validam cargo e patente.
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.4/+esm";

/* ===== Tabelas fixas (espelham o banco) ===== */
const PAT = [["Recruta","REC"],["Soldado","SLD"],["Sargento","SGT"],["1º Sargento","1 SGT"],["Sargento Mor","SGT MOR"],["Tenente","TEN"],["Capitão","CAP"],["Major","MAJ"],["Coronel","CEL"],["Major General","MAJ GEN"],["Tenente General","TEN GEN"],["Coronel General","CEL GEN"],["General Adjunto","GEN ADJ"],["Federal","FEDERAL"]];
const CARGOS = [{k:"federal",n:"Federal",lv:13},{k:"genadj",n:"General Adjunto",lv:12},{k:"celgen",n:"Coronel General",lv:11},{k:"tengen",n:"Tenente General",lv:10},{k:"majgen",n:"Major General",lv:9}];
const PERMS = [["cadastrar","Cadastrar membros"],["editar","Editar dados dos membros"],["promover","Promover e rebaixar"],["punir","Aplicar punições"],["revogar","Revogar punições"],["exonerar","Exonerar e readmitir"],["ponto","Bater ponto (entrada e saída)"],["ajustar_ponto","Ajustar horas e apagar registros de ponto"],["setores","Gerenciar setores e funções"]];
const DEF = {
  federal:{cadastrar:true,editar:true,promover:true,punir:true,revogar:true,exonerar:true,ponto:true,ajustar_ponto:true,setores:true,max_patente:12},
  genadj:{cadastrar:true,editar:true,promover:true,punir:true,revogar:true,exonerar:true,ponto:true,ajustar_ponto:true,setores:true,max_patente:11},
  celgen:{cadastrar:true,editar:true,promover:true,punir:true,revogar:false,exonerar:true,ponto:true,ajustar_ponto:false,setores:true,max_patente:10},
  tengen:{cadastrar:true,editar:true,promover:true,punir:true,revogar:false,exonerar:false,ponto:true,ajustar_ponto:false,setores:false,max_patente:9},
  majgen:{cadastrar:true,editar:false,promover:true,punir:true,revogar:false,exonerar:false,ponto:true,ajustar_ponto:false,setores:false,max_patente:8}
};
const PUN_TIPOS = ["Advertência verbal","Advertência escrita","Suspensão","Detenção"];
const HIST_TIPOS = {cadastro:"Cadastro",promocao:"Promoção",rebaixamento:"Rebaixamento",punicao:"Punição",revogacao:"Revogação de punição",exoneracao:"Exoneração",readmissao:"Readmissão",edicao:"Edição de dados",ajuste_ponto:"Ajuste de ponto",remocao:"Registro apagado",setor:"Setores e funções",acesso:"Acesso ao painel"};
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
  me:null, meuCargo:null, membros:[], setores:[], punicoes:[], ponto:[], hist:[], staff:[], perms:{}, perfis:[],
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
function meLabel(){ return nivelLabel(S.meuCargo); }
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
const mapH = r => ({id:r.id,tipo:r.tipo,membroId:r.membro_id,membroNome:r.membro_nome,texto:r.texto,motivo:r.motivo,porLabel:r.por_label,em:ms(r.em)});

/* ===== Carregamento ===== */
async function q(promise){ const { data, error } = await promise; if (error) throw error; return data; }
const LOADERS = {
  membros:     async () => { S.membros  = (await q(sb.from("membros").select("*").limit(2000))).map(mapM); },
  punicoes:    async () => { S.punicoes = (await q(sb.from("punicoes").select("*").order("em",{ascending:false}).limit(2000))).map(mapP); },
  ponto:       async () => { S.ponto    = (await q(sb.from("ponto").select("*").order("inicio",{ascending:false}).limit(1000))).map(mapPt); },
  historico:   async () => { S.hist     = (await q(sb.from("historico").select("*").order("em",{ascending:false}).limit(500))).map(mapH); },
  setores:     async () => { S.setores  = await q(sb.from("setores").select("*").order("ordem").order("nome")); },
  staff:       async () => { S.staff    = await q(sb.from("staff").select("*")); },
  cargo_perms: async () => { const rows = await q(sb.from("cargo_perms").select("*")); S.perms = Object.fromEntries(rows.map(r => [r.cargo, r])); },
  perfis:      async () => { S.perfis   = isAdm() ? await q(sb.from("perfis").select("user_id,nome_jogo,usuario,criado_em").order("criado_em",{ascending:false})) : []; }
};
async function carregar(nomes){
  try { await Promise.all(nomes.map(n => LOADERS[n]())); }
  catch (e) { toast("Erro ao carregar dados: " + (e.message || e), "err"); }
}
const pendentes = new Set(); let tRefetch = null;
function agendar(tabela){
  if (tabela === "staff" || tabela === "membros") verificarCargo();
  if (tabela === "staff") { recarregarMeuCargo(); return; }
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
  setInterval(() => document.querySelectorAll("[data-since]").forEach(el => el.textContent = fmtDur(Date.now() - Number(el.dataset.since))), 30000);
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
      S.membros = []; S.setores = []; S.punicoes = []; S.ponto = []; S.hist = []; S.staff = []; S.perfis = [];
    } else {
      const { data: c, error: e3 } = await sb.rpc("meu_cargo");
      if (e3) throw e3;
      S.meuCargo = c || null;
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
    await carregar(["membros","setores","punicoes","ponto","historico","staff"]); render();
    return true;
  } catch (e) { toast(e.message || "Não foi possível salvar. Tente de novo.", "err"); return false; }
  finally { S.busy = false; }
}

/* ===== Render ===== */
function render(){
  renderWho();
  const tabs = [["geral","Visão geral"],["efetivo","Efetivo"],["setores","Setores"],["ponto","Ponto"],["historico","Histórico"]];
  if (isAdm()) tabs.push(["acessos","Acessos"]);
  $("#tabs").innerHTML = S.fase === "app" ? tabs.map(([k,n]) => `<button class="tab" role="tab" data-a="tab" data-id="${k}" aria-selected="${S.tab === k}">${n}</button>`).join("") : "";
  const app = $("#app");
  const f = document.activeElement; const fid = f && f.id && app.contains(f) ? f.id : null; let ss = null, se = null;
  if (fid) { try { ss = f.selectionStart; se = f.selectionEnd; } catch {} }
  app.innerHTML = ({config:vConfig, login:vLogin, pendente:vPendente, suspenso:vSuspenso, "sem-adm":vSemAdm, erro:vErro, carregando:() => `<div class="loading">Carregando…</div>`}[S.fase]
    || (() => ({geral:vGeral, efetivo:vEfetivo, setores:vSetores, ponto:vPonto, historico:vHist, acessos:vAcessos}[S.tab] || vGeral)()))();
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

function hora7(){ const lim = Date.now() - 7*864e5; const tot = {}; for (const p of S.ponto) { const ini = Math.max(p.inicio, lim); const fim = p.fim || Date.now(); if (fim > ini && p.membroId) tot[p.membroId] = (tot[p.membroId] || 0) + (fim - ini); } return tot; }

function vGeral(){
  const ativos = S.membros.filter(m => m.status !== "exonerado");
  const emServ = ativos.filter(m => m.servico).sort((a,b) => a.servico.inicio - b.servico.inicio);
  const punAt = S.punicoes.filter(p => p.ativa);
  const lim = Date.now() - 7*864e5;
  const promo7 = S.hist.filter(h => h.tipo === "promocao" && h.em >= lim).length;
  const cont = PAT.map((_, i) => ativos.filter(m => Number(m.patente) === i).length);
  const mx = Math.max(1, ...cont);
  let dist = ""; for (let i = PAT.length - 1; i >= 0; i--) dist += `<div class="dist-row"><span>${chip(i)}</span><div class="bar"><i class="${i >= 9 ? "gen" : ""}" style="width:${cont[i]/mx*100}%"></i></div><span class="num" style="text-align:right">${cont[i]}</span></div>`;
  return `
  <section class="kpis">
    <div class="kpi"><div class="v num">${ativos.length}</div><div class="k">Efetivo ativo</div></div>
    <div class="kpi"><div class="v num" style="color:var(--ok)">${emServ.length}</div><div class="k">Em serviço agora</div></div>
    <div class="kpi"><div class="v num" style="color:${punAt.length ? "var(--bad)" : "inherit"}">${punAt.length}</div><div class="k">Punições ativas</div></div>
    <div class="kpi"><div class="v num">${promo7}</div><div class="k">Promoções em 7 dias</div></div>
  </section>
  <div class="grid2">
    <section class="panel"><div class="panel-h"><h2>Efetivo por patente</h2></div><div class="panel-b dist">${dist}</div></section>
    ${painelSetores(ativos)}
  </div>
  <div class="grid2">
    <section class="panel"><div class="panel-h"><h2>Em serviço agora</h2><span class="sp"><button class="btn sm" data-a="tab" data-id="ponto">Abrir ponto</button></span></div>
      ${emServ.length ? `<div class="list">${emServ.map(m => `<div class="li">${chip(m.patente)}<span class="grow"><a href="#" data-a="abrir" data-id="${m.id}" style="color:inherit">${esc(m.nome)}</a></span><span class="pill ok"><span class="dot pulse"></span><span data-since="${m.servico.inicio}">${fmtDur(Date.now() - m.servico.inicio)}</span></span></div>`).join("")}</div>` : `<div class="empty">Ninguém em serviço no momento.</div>`}
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
    ${list.length ? `<div class="tablewrap"><table><thead><tr><th>Patente</th><th>Nome</th><th>Discord</th><th>Setor</th><th>Horas totais</th><th>Punições</th><th>Situação</th></tr></thead><tbody>
    ${list.map(m => { const pc = punCount[m.id] || 0; const ex = m.status === "exonerado"; const tot = m.totalMs + (m.servico ? Date.now() - m.servico.inicio : 0);
      return `<tr class="click ${ex ? "dim" : ""}" tabindex="0" data-a="abrir" data-id="${m.id}"><td>${chip(m.patente)}</td>
      <td><b>${esc(m.nome)}</b>${contaDe(m.id) ? ` <span class="pill mut" title="Tem login no painel">conta</span>` : ""}</td>
      <td>${m.discord ? esc(m.discord) : `<span class="pill warn">sem Discord</span>`}</td>
      <td>${m.setorId && setorById(m.setorId) ? `${esc(setorNome(m.setorId))} ${fnChip(m.funcao)}` : `<span class="muted">—</span>`}</td>
      <td class="num">${fmtDur(tot)}</td>
      <td>${pc ? `<span class="pill bad">${pc} ativa${pc > 1 ? "s" : ""}</span>` : `<span class="muted">—</span>`}</td>
      <td>${ex ? `<span class="pill mut">Exonerado</span>` : m.servico ? `<span class="pill ok"><span class="dot pulse"></span>Em serviço</span>` : `<span class="pill mut">Fora de serviço</span>`}</td></tr>`; }).join("")}
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

function vPonto(){
  const ativos = S.membros.filter(m => m.status !== "exonerado");
  const emServ = ativos.filter(m => m.servico).sort((a,b) => a.servico.inicio - b.servico.inicio);
  const fora = ativos.filter(m => !m.servico).sort((a,b) => b.patente - a.patente || String(a.nome).localeCompare(String(b.nome), "pt-BR"));
  const t7 = hora7();
  const rank = Object.entries(t7).map(([id, v]) => ({m: mById(id), v})).filter(x => x.m).sort((a,b) => b.v - a.v).slice(0, 15);
  const rmax = Math.max(1, ...rank.map(r => r.v));
  return `<div class="grid2">
  <section class="panel"><div class="panel-h"><h2>Em serviço agora</h2><span class="muted num">${emServ.length}</span></div>
    ${can("ponto") ? `<div class="panel-b toolbar"><select class="input" id="pontoSel" style="flex:1 1 220px" aria-label="Militar para registrar entrada"><option value="">Selecione um militar…</option>${fora.map(m => `<option value="${m.id}">${esc(mLabel(m))}${m.setorId ? " · " + esc(setorNome(m.setorId)) : ""}</option>`).join("")}</select><button class="btn pri" data-a="entradaSel">Registrar entrada</button></div>` : ""}
    ${emServ.length ? `<div class="list">${emServ.map(m => `<div class="li">${chip(m.patente)}<span class="grow"><a href="#" data-a="abrir" data-id="${m.id}" style="color:inherit">${esc(m.nome)}</a><div class="muted" style="font-size:12px">Entrou ${fmtTs(m.servico.inicio)}</div></span><span class="pill ok"><span class="dot pulse"></span><span data-since="${m.servico.inicio}">${fmtDur(Date.now() - m.servico.inicio)}</span></span>${can("ponto") ? `<button class="btn sm" data-a="saida" data-id="${m.id}">Registrar saída</button>` : ""}</div>`).join("")}</div>` : `<div class="empty">Ninguém em serviço no momento.</div>`}
  </section>
  <section class="panel"><div class="panel-h"><h2>Horas nos últimos 7 dias</h2></div>
    ${rank.length ? `<div class="panel-b dist">${rank.map(r => `<div class="dist-row" style="grid-template-columns:minmax(120px,1.2fr) 1fr 74px"><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(mLabel(r.m))}</span><div class="bar"><i style="width:${r.v/rmax*100}%"></i></div><span class="num" style="text-align:right">${fmtDur(r.v)}</span></div>`).join("")}</div>` : `<div class="empty">Sem registros de ponto nos últimos 7 dias.</div>`}
  </section></div>
  <section class="panel"><div class="panel-h"><h2>Registros de ponto</h2><span class="muted">últimos ${Math.min(S.ponto.length, 60)}</span></div>
    ${S.ponto.length ? `<div class="tablewrap"><table><thead><tr><th>Militar</th><th>Entrada</th><th>Saída</th><th>Duração</th><th>Registrado por</th>${can("ajustar_ponto") ? "<th></th>" : ""}</tr></thead><tbody>
    ${S.ponto.slice(0, 60).map(p => { const m = mById(p.membroId); return `<tr><td>${m ? `${chip(m.patente)} ${esc(m.nome)}` : `<span class="muted">${esc(p.membroNome || "Removido")}</span>`}</td><td class="num">${fmtTs(p.inicio)}</td><td class="num">${p.fim ? fmtTs(p.fim) : `<span class="pill ok">Em aberto</span>`}</td><td class="num">${fmtDur((p.fim || Date.now()) - p.inicio)}</td><td class="muted">${esc(p.porLabel || "—")}</td>${can("ajustar_ponto") ? `<td>${p.fim ? `<button class="btn sm danger" data-a="apagarPonto" data-id="${p.id}">Apagar</button>` : ""}</td>` : ""}</tr>`; }).join("")}
    </tbody></table></div>` : `<div class="empty">Nenhum registro de ponto ainda.</div>`}
  </section>`;
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
  const m = S.fase === "app" && S.sel && mById(S.sel);
  if (!m) { root.innerHTML = ""; return; }
  const ex = m.status === "exonerado", act = canActOn(m);
  const pun = S.punicoes.filter(p => p.membroId === m.id), pAt = pun.filter(p => p.ativa), pOld = pun.filter(p => !p.ativa);
  const sess = S.ponto.filter(p => p.membroId === m.id).slice(0, 5);
  const hist = S.hist.filter(h => h.membroId === m.id).slice(0, 15);
  const tot = m.totalMs + (m.servico ? Date.now() - m.servico.inicio : 0);
  const b = [];
  if (!ex && can("ponto")) b.push(m.servico ? `<button class="btn" data-a="saida" data-id="${m.id}">Registrar saída</button>` : `<button class="btn pri" data-a="entrada" data-id="${m.id}">Registrar entrada</button>`);
  if (act && !ex && can("promover")) b.push(`<button class="btn" data-a="promover" data-id="${m.id}">Promover / rebaixar</button>`);
  if (act && !ex && can("setores")) b.push(`<button class="btn" data-a="setorMembro" data-id="${m.id}">Setor e função</button>`);
  if (act && !ex && can("punir")) b.push(`<button class="btn" data-a="punir" data-id="${m.id}">Aplicar punição</button>`);
  if (act && can("editar")) b.push(`<button class="btn" data-a="editar" data-id="${m.id}">Editar dados</button>`);
  if (act && can("ajustar_ponto")) b.push(`<button class="btn" data-a="horas" data-id="${m.id}">Ajustar horas</button>`);
  if (act && can("exonerar")) b.push(ex ? `<button class="btn" data-a="readmitir" data-id="${m.id}">Readmitir</button>` : `<button class="btn danger" data-a="exonerar" data-id="${m.id}">Exonerar</button>`);
  if (isAdm()) b.push(`<button class="btn danger" data-a="apagarMembro" data-id="${m.id}">Apagar cadastro</button>`);
  root.innerHTML = `<div class="scrim" data-a="fechar"></div>
  <aside class="drawer" role="dialog" aria-label="Ficha de ${esc(m.nome)}">
    <div class="dr-h"><div style="flex:1"><div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:6px">${chip(m.patente)}<span class="muted" style="font-size:13px">${esc(patName(m.patente))}</span>${m.funcao && m.setorId ? fnChip(m.funcao) : ""}</div>
      <h2>${esc(m.nome)}</h2>
      <div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap">${ex ? `<span class="pill mut">Exonerado</span>` : m.servico ? `<span class="pill ok"><span class="dot pulse"></span>Em serviço há <span data-since="${m.servico.inicio}">${fmtDur(Date.now() - m.servico.inicio)}</span></span>` : `<span class="pill mut">Fora de serviço</span>`}${pAt.length ? `<span class="pill bad">${pAt.length} punição${pAt.length > 1 ? "ões" : ""} ativa${pAt.length > 1 ? "s" : ""}</span>` : ""}</div></div>
      <button class="btn sm" data-a="fechar" aria-label="Fechar ficha">Fechar</button></div>
    <div class="dr-b">
      <dl class="facts"><div><dt>Discord</dt><dd>${esc(m.discord || "—")}</dd></div>
        <div><dt>Setor</dt><dd>${m.setorId && setorById(m.setorId) ? `${esc(setorNome(m.setorId))}${m.funcao ? ` · ${esc(fnNome(m.funcao))}` : ""}` : "Sem setor"}</dd></div>
        <div><dt>Ingresso</dt><dd class="num">${fmtDate(m.ingresso)}</dd></div><div><dt>Horas totais</dt><dd class="num">${fmtDur(tot)}</dd></div>
        ${(() => { const c = contaDe(m.id); return c ? `<div><dt>Conta no painel</dt><dd>${esc(nivelLabel(cargoDaFicha(m)) )}</dd></div>` : ""; })()}
        ${m.obs ? `<div style="grid-column:1/-1"><dt>Observações</dt><dd style="font-weight:400;white-space:pre-wrap">${esc(m.obs)}</dd></div>` : ""}</dl>
      ${b.length ? `<div class="actions">${b.join("")}</div>` : ""}
      ${!act ? `<div class="note">Patente igual ou superior à sua: você só pode visualizar e bater ponto deste militar.</div>` : ""}
      <div class="sec"><h3>Punições ativas</h3>${pAt.length ? `<div class="list" style="border:1px solid var(--line);border-radius:6px">${pAt.map(p => punRow(p, act)).join("")}</div>` : `<div class="muted" style="font-size:14px">Nenhuma.</div>`}
        ${pOld.length ? `<details style="margin-top:8px"><summary class="muted" style="cursor:pointer;font-size:13px">${pOld.length} revogada${pOld.length > 1 ? "s" : ""}</summary><div class="list" style="border:1px solid var(--line);border-radius:6px;margin-top:6px">${pOld.map(p => punRow(p, false)).join("")}</div></details>` : ""}</div>
      <div class="sec"><h3>Últimos pontos</h3>${sess.length ? `<div class="list" style="border:1px solid var(--line);border-radius:6px">${sess.map(p => `<div class="li"><span class="grow num">${fmtTs(p.inicio)} → ${p.fim ? fmtTs(p.fim) : "em aberto"}</span><span class="num">${fmtDur((p.fim || Date.now()) - p.inicio)}</span></div>`).join("")}</div>` : `<div class="muted" style="font-size:14px">Sem registros.</div>`}</div>
      <div class="sec"><h3>Histórico</h3><div style="border:1px solid var(--line);border-radius:6px">${feed(hist)}</div></div>
    </div></aside>`;
}
function punRow(p, act){ return `<div class="li"><span class="grow"><b>${esc(p.tipo)}</b>${p.dias ? ` · ${esc(p.dias)} dia${Number(p.dias) > 1 ? "s" : ""}` : ""}<div style="font-size:13px">${esc(p.motivo)}</div><div class="muted" style="font-size:12px">${esc(p.porLabel || "")} · ${fmtTs(p.em)}${!p.ativa && p.revogadaEm ? ` · revogada ${fmtTs(p.revogadaEm)}` : ""}</div></span>${p.ativa && act && can("revogar") ? `<button class="btn sm" data-a="revogar" data-id="${p.id}">Revogar</button>` : ""}</div>`; }

/* ===== Modais ===== */
let modalSubmit = null;
function openModal(title, body, submitLabel, onSubmit, danger){
  modalSubmit = onSubmit;
  $("#modal-root").innerHTML = `<div class="modal" data-a="mscrim"><form id="mform" novalidate><h2>${esc(title)}</h2>${body}<div class="mfoot"><button type="button" class="btn" data-a="mclose">Cancelar</button><button type="submit" class="btn ${danger ? "danger" : "pri"}">${esc(submitLabel)}</button></div></form></div>`;
  const first = $("#mform").querySelector("input,select,textarea"); if (first) first.focus();
}
function closeModal(){ $("#modal-root").innerHTML = ""; modalSubmit = null; }
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
function mHoras(m){
  const h = (m.totalMs / 36e5).toFixed(1);
  openModal(`Ajustar horas de ${m.nome}`, `<div class="field"><label for="f-h">Total de horas</label><input class="input num" type="number" step="0.1" min="0" id="f-h" name="h" value="${h}"><span class="hint">Não inclui o turno em aberto, se houver.</span></div>${motivoField()}`,
    "Salvar", d => {
      const v = Number(String(d.h).replace(",", ".")); if (!(v >= 0)) return "Informe um número de horas válido."; if (!d.motivo.trim()) return "Informe o motivo.";
      return rpc("ajustar_horas", {p_id:m.id, p_horas:v, p_motivo:d.motivo}, "Horas ajustadas.");
    });
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
  if (t.tagName === "SELECT" || t.type === "checkbox" || t.type === "radio") return;
  const m = id ? mById(id) : null;
  switch (a) {
    case "modoCriar": S.authModo = "criar"; render(); break;
    case "modoEntrar": S.authModo = "entrar"; render(); break;
    case "trocarSenha": mTrocarSenha(); break;
    case "resetSenha": { const s2 = S.staff.find(x => x.user_id === id); s2 && mResetSenha(s2); break; }
    case "sair": sb.auth.signOut(); break;
    case "verificar": recarregarMeuCargo(); break;
    case "assumirAdm": (async () => { const { error } = await sb.rpc("assumir_adm"); if (error) toast(error.message, "err"); else { toast("Você agora é o ADM Geral."); recarregarMeuCargo(); } })(); break;
    case "tab": S.tab = id; S.sel = null; if (id !== "acessos") S.permDraft = null; render(); window.scrollTo(0, 0); break;
    case "abrir": S.sel = id; renderDrawer(); break;
    case "fechar": S.sel = null; renderDrawer(); break;
    case "novo": if (can("cadastrar")) mNovo(); break;
    case "editar": m && mEditar(m); break;
    case "promover": m && mPromover(m); break;
    case "punir": m && mPunir(m); break;
    case "revogar": { const p = S.punicoes.find(x => x.id === id); p && mRevogar(p); break; }
    case "exonerar": m && mExonerar(m); break;
    case "readmitir": m && mReadmitir(m); break;
    case "horas": m && mHoras(m); break;
    case "apagarMembro": m && mConfirm("Apagar cadastro", `Apagar de vez o cadastro de <b>${esc(mLabel(m))}</b>? O histórico continua, mas a ficha, as punições e o vínculo do ponto somem. Para tirar alguém do efetivo, prefira Exonerar.`, "Apagar", async () => { const ok = await rpc("apagar_membro", {p_id:m.id}, "Cadastro apagado."); if (ok) S.sel = null; return ok; }); break;
    case "entrada": if (m && !m.servico) rpc("ponto_entrada", {p_id:m.id}, "Entrada registrada."); break;
    case "entradaSel": { const v = $("#pontoSel")?.value; if (!v) { toast("Selecione um militar.", "err"); break; } rpc("ponto_entrada", {p_id:v}, "Entrada registrada."); break; }
    case "saida": if (m && m.servico) rpc("ponto_saida", {p_id:m.id}, "Saída registrada."); break;
    case "apagarPonto": { const p = S.ponto.find(x => x.id === id); if (!p) break; const mm = mById(p.membroId);
      mConfirm("Apagar registro de ponto", `Apagar o turno de ${fmtTs(p.inicio)} (${fmtDur(p.fim - p.inicio)})${mm ? ` de <b>${esc(mLabel(mm))}</b>? As horas desse turno serão descontadas do total.` : "?"}`, "Apagar", () => rpc("apagar_ponto", {p_ponto:p.id}, "Registro apagado.")); break; }
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
document.addEventListener("input", e => { if (e.target.id === "q") { S.q = e.target.value; render(); } });
document.addEventListener("change", e => {
  const t = e.target;
  if (t.id === "fPat") { S.fPat = t.value; render(); }
  else if (t.id === "fSetor") { S.fSetor = t.value; render(); }
  else if (t.name === "modo" && t.type === "radio") { $("#lib-nova").hidden = t.value !== "nova"; $("#lib-exist").hidden = t.value !== "existente"; }
  else if ((t.id === "f-set" || t.id === "f-fn") && $("#fn-aviso")) atualizarAvisoFuncao(modalMembro);
  else if (t.id === "fStatus") { S.fStatus = t.value; render(); }
  else if (t.id === "fHist") { S.fHist = t.value; render(); }
  else if (t.dataset.a === "perm") S.permDraft[t.dataset.c][t.dataset.p] = t.checked;
  else if (t.dataset.a === "permMax") S.permDraft[t.dataset.c].max_patente = Number(t.value);
});
document.addEventListener("keydown", e => {
  if (e.key === "Escape") { if ($("#modal-root").innerHTML) closeModal(); else if (S.sel) { S.sel = null; renderDrawer(); } }
  if (e.key === "Enter" && e.target.matches("tr[data-a='abrir']")) { S.sel = e.target.dataset.id; renderDrawer(); }
});

boot().catch(e => { S.fase = "erro"; S.err = "Não foi possível iniciar o painel: " + (e.message || e); render(); });
