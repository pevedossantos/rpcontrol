-- =====================================================================
--  Exército de Solano · Controle de Efetivo
--  Script do banco (Supabase / Postgres)
--
--  Como usar: Supabase → SQL Editor → New query → cole TODO este arquivo → Run.
--  Pode rodar de novo sempre que o arquivo for atualizado: os dados não se perdem.
--
--  Modelo de segurança:
--   • Cada login (conta) é ligado a uma ficha do efetivo. O nível de acesso vem
--     da PATENTE da ficha: Major General para cima usa a tabela de limites;
--     abaixo disso, só visualiza. Ficha exonerada perde o acesso.
--   • O ADM Geral não tem ficha e não tem limites.
--   • Ninguém escreve direto nas tabelas: toda alteração passa por uma função
--     que confere permissão e patente no servidor e grava o histórico.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- Tabelas
-- ---------------------------------------------------------------------

-- Conta criada no painel (preenchida automaticamente no cadastro)
create table if not exists public.perfis (
  user_id   uuid primary key references auth.users on delete cascade,
  nome_jogo text,
  usuario   text,
  criado_em timestamptz not null default now()
);
do $$ begin
  if exists (select 1 from information_schema.columns where table_schema='public' and table_name='perfis' and column_name='discord_nome') then
    alter table public.perfis rename column discord_nome to nome_jogo;
  end if;
end $$;
alter table public.perfis add column if not exists usuario text;
alter table public.perfis drop column if exists avatar_url;
create unique index if not exists perfis_usuario_uk on public.perfis (usuario);

-- Setores da base
create table if not exists public.setores (
  id        uuid primary key default gen_random_uuid(),
  nome      text not null check (length(nome) between 1 and 40),
  ordem     int  not null default 0,
  criado_em timestamptz not null default now()
);
create unique index if not exists setores_nome_uk on public.setores (lower(trim(nome)));
insert into public.setores (nome, ordem)
select n, o from (values ('Sul',1),('Norte',2),('Centro',3),('Leste',4),('Especiais',5)) v(n,o)
where not exists (select 1 from public.setores);

-- Militares (fichas)
create table if not exists public.membros (
  id             uuid primary key default gen_random_uuid(),
  nome           text not null check (length(nome) between 1 and 60),
  discord        text not null default '',
  patente        int  not null default 0 check (patente between 0 and 13),
  status         text not null default 'ativo' check (status in ('ativo','exonerado')),
  setor_id       uuid references public.setores on delete set null,
  funcao         text check (funcao in ('1CMD','2CMD','1AUX','2AUX')),
  ingresso       date not null default current_date,
  obs            text not null default '',
  total_ms       bigint not null default 0,
  servico_inicio timestamptz,
  servico_sessao uuid,
  criado_em      timestamptz not null default now(),
  criado_por     uuid
);
-- Migração: setor e função
alter table public.membros add column if not exists setor_id uuid references public.setores on delete set null;
alter table public.membros add column if not exists funcao text check (funcao in ('1CMD','2CMD','1AUX','2AUX'));
create unique index if not exists membros_funcao_uk on public.membros (setor_id, funcao) where funcao is not null;
-- Migração: o ID (passaporte) saiu do cadastro; a coluna antiga fica guardada, sem obrigação
do $$ begin
  if exists (select 1 from information_schema.columns where table_schema='public' and table_name='membros' and column_name='passaporte') then
    alter table public.membros alter column passaporte drop not null;
    alter table public.membros drop constraint if exists membros_passaporte_check;
  end if;
end $$;
drop index if exists public.membros_passaporte_uk;
-- Discord único (ignorando maiúsculas); se já houver repetidos, o índice fica para depois
do $$ begin
  create unique index if not exists membros_discord_uk on public.membros (lower(trim(discord))) where trim(discord) <> '';
exception when unique_violation then
  raise notice 'Há Discords repetidos no efetivo. Corrija e rode o script de novo para ativar a verificação.';
end $$;

-- Contas com acesso ao painel
create table if not exists public.staff (
  user_id   uuid primary key references auth.users on delete cascade,
  cargo     text not null,
  nome      text not null,
  membro_id uuid references public.membros on delete set null,
  criado_em timestamptz not null default now()
);
alter table public.staff add column if not exists membro_id uuid references public.membros on delete set null;

-- Limites de cada cargo (editáveis pelo ADM Geral na aba Acessos)
create table if not exists public.cargo_perms (
  cargo         text primary key check (cargo in ('federal','genadj','celgen','tengen','majgen')),
  cadastrar     boolean not null default false,
  editar        boolean not null default false,
  promover      boolean not null default false,
  punir         boolean not null default false,
  revogar       boolean not null default false,
  exonerar      boolean not null default false,
  ponto         boolean not null default false,
  ajustar_ponto boolean not null default false,
  max_patente   int     not null default 0 check (max_patente between 0 and 13)
);
insert into public.cargo_perms
  (cargo,     cadastrar, editar, promover, punir, revogar, exonerar, ponto, ajustar_ponto, max_patente) values
  ('federal', true,  true,  true, true, true,  true,  true, true,  12),
  ('genadj',  true,  true,  true, true, true,  true,  true, true,  11),
  ('celgen',  true,  true,  true, true, false, true,  true, false, 10),
  ('tengen',  true,  true,  true, true, false, false, true, false,  9),
  ('majgen',  true,  false, true, true, false, false, true, false,  8)
on conflict (cargo) do nothing;
do $$ begin
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='cargo_perms' and column_name='setores') then
    alter table public.cargo_perms add column setores boolean not null default false;
    update public.cargo_perms set setores = true where cargo in ('federal','genadj','celgen');
  end if;
end $$;

-- Punições
create table if not exists public.punicoes (
  id              uuid primary key default gen_random_uuid(),
  membro_id       uuid not null references public.membros on delete cascade,
  tipo            text not null,
  dias            int  not null default 0,
  motivo          text not null,
  ativa           boolean not null default true,
  por             uuid,
  por_label       text,
  em              timestamptz not null default now(),
  revogada_em     timestamptz,
  revogada_por    uuid,
  revogada_motivo text
);
create index if not exists punicoes_membro_idx on public.punicoes (membro_id);

-- Bate-ponto (um registro por turno)
create table if not exists public.ponto (
  id          uuid primary key default gen_random_uuid(),
  membro_id   uuid references public.membros on delete set null,
  membro_nome text not null default '',
  inicio      timestamptz not null default now(),
  fim         timestamptz,
  por         uuid,
  por_label   text,
  fechado_por uuid
);
create index if not exists ponto_inicio_idx on public.ponto (inicio desc);

-- Histórico (sem chave estrangeira: continua existindo se o cadastro for apagado)
create table if not exists public.historico (
  id          uuid primary key default gen_random_uuid(),
  tipo        text not null,
  membro_id   uuid,
  membro_nome text not null default '',
  texto       text not null default '',
  motivo      text not null default '',
  por         uuid,
  por_label   text,
  em          timestamptz not null default now()
);
create index if not exists historico_em_idx on public.historico (em desc);

-- Tipos de evento (editáveis). "treinamento" mostra os campos de relatório (instrutor e conteúdo).
create table if not exists public.tipos_evento (
  id          uuid primary key default gen_random_uuid(),
  nome        text not null check (length(nome) between 1 and 40),
  treinamento boolean not null default false,
  ordem       int not null default 0,
  criado_em   timestamptz not null default now()
);
create unique index if not exists tipos_evento_nome_uk on public.tipos_evento (lower(trim(nome)));
insert into public.tipos_evento (nome, treinamento, ordem)
select n, t, o from (values ('Roubo do Arsenal', false, 1), ('Treinamento', true, 2)) v(n,t,o)
where not exists (select 1 from public.tipos_evento);

-- Eventos (lista de presença e relatórios de treinamento)
create table if not exists public.eventos (
  id               uuid primary key default gen_random_uuid(),
  tipo_id          uuid references public.tipos_evento on delete set null,
  tipo_nome        text not null default '',
  treinamento      boolean not null default false,
  titulo           text not null default '',
  data_hora        timestamptz not null,
  instrutor_id     uuid references public.membros on delete set null,
  instrutor_nome   text not null default '',
  descricao        text not null default '',
  fotos            text[] not null default '{}',
  criado_por       uuid,
  criado_por_label text,
  criado_em        timestamptz not null default now(),
  atualizado_em    timestamptz not null default now()
);
create index if not exists eventos_data_idx on public.eventos (data_hora desc);

-- Quem esteve presente em cada evento
create table if not exists public.presencas (
  evento_id   uuid not null references public.eventos on delete cascade,
  membro_id   uuid not null references public.membros on delete cascade,
  membro_nome text not null default '',
  primary key (evento_id, membro_id)
);
create index if not exists presencas_membro_idx on public.presencas (membro_id);

-- Roubo do Arsenal: uma lista por dia, horário (11, 13, 15, 17, 19) e setor
create table if not exists public.arsenal (
  id               uuid primary key default gen_random_uuid(),
  data             date not null,
  hora             int  not null check (hora in (11, 13, 15, 17, 19)),
  setor_id         uuid not null references public.setores on delete cascade,
  atualizado_por   uuid,
  atualizado_label text,
  atualizado_em    timestamptz not null default now(),
  unique (data, hora, setor_id)
);
create index if not exists arsenal_data_idx on public.arsenal (data desc);
create table if not exists public.arsenal_presencas (
  arsenal_id  uuid not null references public.arsenal on delete cascade,
  membro_id   uuid not null references public.membros on delete cascade,
  membro_nome text not null default '',
  primary key (arsenal_id, membro_id)
);
create index if not exists arsenal_presencas_membro_idx on public.arsenal_presencas (membro_id);
-- Situação de cada militar no horário: ativo (participou), justificado ou inativo
alter table public.arsenal_presencas add column if not exists status text not null default 'ativo'
  check (status in ('ativo','justificado','inativo'));

-- O Roubo do Arsenal saiu da aba Eventos (tem lista própria). O tipo só é apagado se nenhum evento usar.
delete from public.tipos_evento t
 where lower(trim(t.nome)) = 'roubo do arsenal'
   and not exists (select 1 from public.eventos e where e.tipo_id = t.id);

-- Permissões de eventos (substituem as de ponto na tela)
do $$ begin
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='cargo_perms' and column_name='presenca') then
    alter table public.cargo_perms add column presenca boolean not null default false;
    update public.cargo_perms set presenca = true;
  end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='cargo_perms' and column_name='ajustar_presenca') then
    alter table public.cargo_perms add column ajustar_presenca boolean not null default false;
    update public.cargo_perms set ajustar_presenca = true where cargo in ('federal','genadj');
  end if;
end $$;

-- ---------------------------------------------------------------------
-- Migração das contas: o cargo passa a vir da patente da ficha
-- ---------------------------------------------------------------------
alter table public.staff drop constraint if exists staff_cargo_check;
do $$
declare s record; mid uuid;
begin
  for s in select * from public.staff where cargo not in ('adm','membro') loop
    insert into public.membros (nome, discord, patente)
    values (s.nome, '', case s.cargo when 'federal' then 13 when 'genadj' then 12 when 'celgen' then 11
                                     when 'tengen' then 10 when 'majgen' then 9 else 0 end)
    returning id into mid;
    update public.staff set cargo = 'membro', membro_id = mid where user_id = s.user_id;
  end loop;
end $$;
alter table public.staff add constraint staff_cargo_check check (cargo in ('adm','membro'));

-- ---------------------------------------------------------------------
-- Funções auxiliares
-- ---------------------------------------------------------------------

-- Versões antigas (assinaturas que mudaram)
drop function if exists public.cadastrar_membro(text, text, text, int, date, text);
drop function if exists public.editar_membro(uuid, text, text, text, date, text);
drop function if exists public.definir_staff(uuid, text, text);
drop function if exists public.remover_staff(uuid);

create or replace function public.patente_sigla(i int) returns text
language sql immutable as $$
  select (array['REC','SLD','SGT','1 SGT','SGT MOR','TEN','CAP','MAJ','CEL','MAJ GEN','TEN GEN','CEL GEN','GEN ADJ','FEDERAL'])[i+1]
$$;

create or replace function public.patente_nome(i int) returns text
language sql immutable as $$
  select (array['Recruta','Soldado','Sargento','1º Sargento','Sargento Mor','Tenente','Capitão','Major','Coronel',
                'Major General','Tenente General','Coronel General','General Adjunto','Federal'])[i+1]
$$;

create or replace function public.funcao_sigla(f text) returns text
language sql immutable as $$
  select case f when '1CMD' then '1 CMD' when '2CMD' then '2 CMD' when '1AUX' then '1 AUX' when '2AUX' then '2 AUX' end
$$;

create or replace function public.nivel_cargo(c text) returns int
language sql immutable as $$
  select case c when 'adm' then 99 when 'federal' then 13 when 'genadj' then 12
                when 'celgen' then 11 when 'tengen' then 10 when 'majgen' then 9 else -1 end
$$;

create or replace function public.nome_cargo(c text) returns text
language sql immutable as $$
  select case c when 'adm' then 'ADM Geral' when 'federal' then 'Federal' when 'genadj' then 'General Adjunto'
                when 'celgen' then 'Coronel General' when 'tengen' then 'Tenente General'
                when 'majgen' then 'Major General' when 'leitor' then 'Visualização' else 'Sem acesso' end
$$;

-- Cargo efetivo de quem está logado: 'adm', um dos cargos de general, 'leitor' ou null (sem acesso)
create or replace function public.meu_cargo() returns text
language sql stable security definer set search_path = public as $$
  select case
    when s.cargo = 'adm' then 'adm'
    when m.id is null or m.status <> 'ativo' then null
    when m.patente >= 9 then (array['majgen','tengen','celgen','genadj','federal'])[m.patente - 8]
    else 'leitor' end
  from staff s left join membros m on m.id = s.membro_id
  where s.user_id = auth.uid()
$$;

create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select meu_cargo() is not null
$$;

create or replace function public.is_adm() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(meu_cargo() = 'adm', false)
$$;

create or replace function public.meu_nivel() returns int
language sql stable security definer set search_path = public as $$
  select nivel_cargo(meu_cargo())
$$;

create or replace function public.meu_rotulo() returns text
language sql stable security definer set search_path = public as $$
  select case when s.cargo = 'adm' then s.nome || ' · ADM Geral'
              when m.id is not null then patente_sigla(m.patente) || ' ' || m.nome
              else s.nome end
  from staff s left join membros m on m.id = s.membro_id
  where s.user_id = auth.uid()
$$;

create or replace function public.tem_perm(p text) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare c text := meu_cargo(); r cargo_perms;
begin
  if c is null then return false; end if;
  if c = 'adm' then return true; end if;
  select * into r from cargo_perms where cargo = c;
  if not found then return false; end if;
  return case p
    when 'cadastrar' then r.cadastrar  when 'editar'   then r.editar
    when 'promover'  then r.promover   when 'punir'    then r.punir
    when 'revogar'   then r.revogar    when 'exonerar' then r.exonerar
    when 'ponto'     then r.ponto      when 'ajustar_ponto' then r.ajustar_ponto
    when 'setores'   then r.setores
    when 'presenca'  then r.presenca   when 'ajustar_presenca' then r.ajustar_presenca
    else false end;
end $$;

create or replace function public.minha_max_patente() returns int
language plpgsql stable security definer set search_path = public as $$
declare c text := meu_cargo(); r cargo_perms;
begin
  if c is null then return -1; end if;
  if c = 'adm' then return 13; end if;
  select * into r from cargo_perms where cargo = c;
  if not found or not r.promover then return 0; end if;
  return least(r.max_patente, nivel_cargo(c) - 1);
end $$;

-- Guardas internas (não ficam expostas para o site)
create or replace function public._exigir(p text) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Faça login para continuar.'; end if;
  if not tem_perm(p) then raise exception 'Seu cargo não tem permissão para esta ação.'; end if;
end $$;

create or replace function public._pode_agir(m membros) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_adm() and m.patente >= meu_nivel() then
    raise exception 'Você só pode agir sobre militares de patente abaixo da sua.';
  end if;
end $$;

create or replace function public._carregar(p_id uuid) returns membros
language plpgsql security definer set search_path = public as $$
declare v membros;
begin
  select * into v from membros where id = p_id for update;
  if not found then raise exception 'Militar não encontrado.'; end if;
  return v;
end $$;

create or replace function public._log(p_tipo text, m membros, p_texto text, p_motivo text) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into historico (tipo, membro_id, membro_nome, texto, motivo, por, por_label)
  values (p_tipo, m.id, case when m.id is null then '' else patente_sigla(m.patente) || ' ' || m.nome end,
          coalesce(p_texto, ''), coalesce(p_motivo, ''), auth.uid(), meu_rotulo());
end $$;

create or replace function public._exigir_motivo(p text) returns text
language plpgsql immutable as $$
begin
  if p is null or length(trim(p)) = 0 then raise exception 'Informe o motivo.'; end if;
  if length(p) > 300 then raise exception 'O motivo pode ter no máximo 300 caracteres.'; end if;
  return trim(p);
end $$;

create or replace function public._validar_nome(p text) returns text
language plpgsql immutable as $$
begin
  if p is null or length(trim(p)) = 0 then raise exception 'Informe o nome no RP.'; end if;
  if length(trim(p)) > 60 then raise exception 'O nome pode ter no máximo 60 caracteres.'; end if;
  return trim(p);
end $$;

create or replace function public._validar_discord(p text, p_ignorar uuid) returns text
language plpgsql stable security definer set search_path = public as $$
declare d text := trim(coalesce(p, ''));
begin
  if d = '' then raise exception 'Informe o Discord do militar.'; end if;
  if length(d) > 40 then raise exception 'O Discord pode ter no máximo 40 caracteres.'; end if;
  if exists (select 1 from membros where lower(trim(discord)) = lower(d) and id is distinct from p_ignorar) then
    raise exception 'Já existe um militar com esse Discord.';
  end if;
  return d;
end $$;

create or replace function public._validar_setor(p uuid) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if p is not null and not exists (select 1 from setores where id = p) then
    raise exception 'Setor não encontrado.';
  end if;
end $$;

create or replace function public._fechar_ponto(m membros) returns void
language plpgsql security definer set search_path = public as $$
begin
  if m.servico_inicio is null then return; end if;
  update ponto set fim = now(), fechado_por = auth.uid() where id = m.servico_sessao and fim is null;
  update membros
     set total_ms = total_ms + greatest(0, (extract(epoch from now() - m.servico_inicio) * 1000)::bigint),
         servico_inicio = null, servico_sessao = null
   where id = m.id;
end $$;

-- ---------------------------------------------------------------------
-- Ações do efetivo (RPC)
-- ---------------------------------------------------------------------

create or replace function public.cadastrar_membro(p_nome text, p_discord text, p_patente int, p_setor uuid,
                                                   p_ingresso date, p_obs text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v membros; mx int; n text; d text;
begin
  perform _exigir('cadastrar');
  n := _validar_nome(p_nome);
  d := _validar_discord(p_discord, null);
  perform _validar_setor(p_setor);
  mx := greatest(minha_max_patente(), 0);
  if p_patente is null or p_patente < 0 or p_patente > mx then
    raise exception 'Você só pode cadastrar até a patente %.', patente_nome(mx);
  end if;
  insert into membros (nome, discord, patente, setor_id, ingresso, obs, criado_por)
  values (n, d, p_patente, p_setor, coalesce(p_ingresso, current_date), coalesce(trim(p_obs), ''), auth.uid())
  returning * into v;
  perform _log('cadastro', v, 'Cadastrado como ' || patente_nome(v.patente)
               || coalesce(' no Setor ' || (select nome from setores where id = p_setor), ''), '');
  return v.id;
end $$;

create or replace function public.editar_membro(p_id uuid, p_nome text, p_discord text, p_ingresso date, p_obs text)
returns void language plpgsql security definer set search_path = public as $$
declare v membros; n text; d text;
begin
  perform _exigir('editar');
  v := _carregar(p_id);
  perform _pode_agir(v);
  n := _validar_nome(p_nome);
  d := _validar_discord(p_discord, p_id);
  update membros set nome = n, discord = d, ingresso = coalesce(p_ingresso, ingresso), obs = coalesce(trim(p_obs), '')
   where id = p_id returning * into v;
  perform _log('edicao', v, 'Dados atualizados', '');
end $$;

create or replace function public.alterar_patente(p_id uuid, p_nova int, p_motivo text)
returns void language plpgsql security definer set search_path = public as $$
declare v membros; antiga int; mot text := _exigir_motivo(p_motivo);
begin
  perform _exigir('promover');
  v := _carregar(p_id);
  perform _pode_agir(v);
  if v.status <> 'ativo' then raise exception 'Militar exonerado. Readmita antes de alterar a patente.'; end if;
  if p_nova is null or p_nova < 0 or p_nova = v.patente then raise exception 'Escolha uma patente diferente da atual.'; end if;
  if p_nova > minha_max_patente() then
    raise exception 'Você só pode conceder até a patente %.', patente_nome(minha_max_patente());
  end if;
  antiga := v.patente;
  update membros set patente = p_nova where id = p_id returning * into v;
  perform _log(case when p_nova > antiga then 'promocao' else 'rebaixamento' end, v,
               patente_sigla(antiga) || ' → ' || patente_sigla(p_nova), mot);
end $$;

create or replace function public.aplicar_punicao(p_id uuid, p_tipo text, p_dias int, p_motivo text)
returns void language plpgsql security definer set search_path = public as $$
declare v membros; mot text := _exigir_motivo(p_motivo); d int := greatest(0, least(coalesce(p_dias, 0), 365));
begin
  perform _exigir('punir');
  v := _carregar(p_id);
  perform _pode_agir(v);
  if v.status <> 'ativo' then raise exception 'Militar exonerado.'; end if;
  if p_tipo not in ('Advertência verbal','Advertência escrita','Suspensão','Detenção') then
    raise exception 'Tipo de punição inválido.';
  end if;
  insert into punicoes (membro_id, tipo, dias, motivo, por, por_label)
  values (p_id, p_tipo, d, mot, auth.uid(), meu_rotulo());
  perform _log('punicao', v, p_tipo || case when d > 0 then ' (' || d || ' dia' || case when d > 1 then 's' else '' end || ')' else '' end, mot);
end $$;

create or replace function public.revogar_punicao(p_punicao uuid, p_motivo text)
returns void language plpgsql security definer set search_path = public as $$
declare p punicoes; v membros; mot text := _exigir_motivo(p_motivo);
begin
  perform _exigir('revogar');
  select * into p from punicoes where id = p_punicao for update;
  if not found then raise exception 'Punição não encontrada.'; end if;
  if not p.ativa then raise exception 'Essa punição já foi revogada.'; end if;
  v := _carregar(p.membro_id);
  perform _pode_agir(v);
  update punicoes set ativa = false, revogada_em = now(), revogada_por = auth.uid(), revogada_motivo = mot
   where id = p_punicao;
  perform _log('revogacao', v, p.tipo, mot);
end $$;

create or replace function public.exonerar(p_id uuid, p_motivo text)
returns void language plpgsql security definer set search_path = public as $$
declare v membros; mot text := _exigir_motivo(p_motivo);
begin
  perform _exigir('exonerar');
  v := _carregar(p_id);
  perform _pode_agir(v);
  if v.status = 'exonerado' then raise exception 'Militar já está exonerado.'; end if;
  perform _fechar_ponto(v);
  update membros set status = 'exonerado', setor_id = null, funcao = null where id = p_id returning * into v;
  perform _log('exoneracao', v, '', mot);
end $$;

create or replace function public.readmitir(p_id uuid, p_patente int, p_motivo text)
returns void language plpgsql security definer set search_path = public as $$
declare v membros; mot text := _exigir_motivo(p_motivo); mx int;
begin
  perform _exigir('exonerar');
  v := _carregar(p_id);
  perform _pode_agir(v);
  if v.status <> 'exonerado' then raise exception 'Militar já está ativo.'; end if;
  mx := greatest(minha_max_patente(), 0);
  if p_patente is null or p_patente < 0 or p_patente > mx then
    raise exception 'Você só pode readmitir até a patente %.', patente_nome(mx);
  end if;
  update membros set status = 'ativo', patente = p_patente where id = p_id returning * into v;
  perform _log('readmissao', v, 'Readmitido como ' || patente_nome(p_patente), mot);
end $$;

create or replace function public.ponto_entrada(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v membros; sid uuid;
begin
  perform _exigir('ponto');
  v := _carregar(p_id);
  if v.status <> 'ativo' then raise exception 'Militar exonerado não pode bater ponto.'; end if;
  if v.servico_inicio is not null then raise exception 'Esse militar já está em serviço.'; end if;
  insert into ponto (membro_id, membro_nome, por, por_label)
  values (v.id, patente_sigla(v.patente) || ' ' || v.nome, auth.uid(), meu_rotulo())
  returning id into sid;
  update membros set servico_inicio = now(), servico_sessao = sid where id = p_id;
end $$;

create or replace function public.ponto_saida(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v membros;
begin
  perform _exigir('ponto');
  v := _carregar(p_id);
  if v.servico_inicio is null then raise exception 'Esse militar não está em serviço.'; end if;
  perform _fechar_ponto(v);
end $$;

create or replace function public.ajustar_horas(p_id uuid, p_horas numeric, p_motivo text)
returns void language plpgsql security definer set search_path = public as $$
declare v membros; mot text := _exigir_motivo(p_motivo); antes numeric;
begin
  perform _exigir('ajustar_ponto');
  v := _carregar(p_id);
  perform _pode_agir(v);
  if p_horas is null or p_horas < 0 or p_horas > 100000 then raise exception 'Número de horas inválido.'; end if;
  antes := round(v.total_ms / 3600000.0, 1);
  update membros set total_ms = round(p_horas * 3600000)::bigint where id = p_id;
  perform _log('ajuste_ponto', v, antes || 'h → ' || round(p_horas, 1) || 'h', mot);
end $$;

create or replace function public.apagar_ponto(p_ponto uuid)
returns void language plpgsql security definer set search_path = public as $$
declare pt ponto; v membros; dur bigint;
begin
  perform _exigir('ajustar_ponto');
  select * into pt from ponto where id = p_ponto for update;
  if not found then raise exception 'Registro de ponto não encontrado.'; end if;
  if pt.fim is null then raise exception 'Registre a saída antes de apagar este turno.'; end if;
  dur := (extract(epoch from pt.fim - pt.inicio) * 1000)::bigint;
  if pt.membro_id is not null then
    v := _carregar(pt.membro_id);
    perform _pode_agir(v);
    update membros set total_ms = greatest(0, total_ms - dur) where id = v.id;
  end if;
  delete from ponto where id = p_ponto;
  insert into historico (tipo, membro_id, membro_nome, texto, motivo, por, por_label)
  values ('ajuste_ponto', pt.membro_id, pt.membro_nome,
          'Turno de ' || to_char(pt.inicio at time zone 'America/Sao_Paulo', 'DD/MM HH24:MI') || ' apagado', '',
          auth.uid(), meu_rotulo());
end $$;

create or replace function public.apagar_membro(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v membros;
begin
  if not is_adm() then raise exception 'Só o ADM Geral pode apagar cadastros.'; end if;
  v := _carregar(p_id);
  if exists (select 1 from staff where membro_id = p_id) then
    raise exception 'Essa ficha está ligada a uma conta. Remova o acesso da conta antes de apagar.';
  end if;
  perform _log('remocao', v, 'Cadastro apagado', '');
  delete from membros where id = p_id;
end $$;

-- ---------------------------------------------------------------------
-- Setores e funções
-- ---------------------------------------------------------------------

create or replace function public.criar_setor(p_nome text)
returns uuid language plpgsql security definer set search_path = public as $$
declare n text := trim(coalesce(p_nome, '')); sid uuid;
begin
  perform _exigir('setores');
  if n = '' or length(n) > 40 then raise exception 'Informe um nome de setor com até 40 caracteres.'; end if;
  insert into setores (nome, ordem) values (n, coalesce((select max(ordem) from setores), 0) + 1) returning id into sid;
  perform _log('setor', null::membros, 'Setor ' || n || ' criado', '');
  return sid;
exception when unique_violation then
  raise exception 'Já existe um setor com esse nome.';
end $$;

create or replace function public.renomear_setor(p_id uuid, p_nome text)
returns void language plpgsql security definer set search_path = public as $$
declare n text := trim(coalesce(p_nome, '')); antigo text;
begin
  perform _exigir('setores');
  if n = '' or length(n) > 40 then raise exception 'Informe um nome de setor com até 40 caracteres.'; end if;
  select nome into antigo from setores where id = p_id for update;
  if not found then raise exception 'Setor não encontrado.'; end if;
  update setores set nome = n where id = p_id;
  perform _log('setor', null::membros, 'Setor ' || antigo || ' renomeado para ' || n, '');
exception when unique_violation then
  raise exception 'Já existe um setor com esse nome.';
end $$;

create or replace function public.apagar_setor(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare n text; qtd int;
begin
  perform _exigir('setores');
  select nome into n from setores where id = p_id for update;
  if not found then raise exception 'Setor não encontrado.'; end if;
  update membros set setor_id = null, funcao = null where setor_id = p_id;
  get diagnostics qtd = row_count;
  delete from setores where id = p_id;
  perform _log('setor', null::membros, 'Setor ' || n || ' apagado' ||
               case when qtd > 0 then ' (' || qtd || ' militar' || case when qtd > 1 then 'es' else '' end || ' ficaram sem setor)' else '' end, '');
end $$;

-- Coloca o militar num setor (ou tira, com p_setor nulo) e define a função (ou nenhuma).
-- Se a função já estiver ocupada no setor, quem ocupava perde a função.
create or replace function public.definir_setor(p_id uuid, p_setor uuid, p_funcao text)
returns void language plpgsql security definer set search_path = public as $$
declare v membros; h membros; f text := nullif(trim(coalesce(p_funcao, '')), ''); sn text; antes text;
begin
  perform _exigir('setores');
  v := _carregar(p_id);
  perform _pode_agir(v);
  if v.status <> 'ativo' then raise exception 'Militar exonerado não pode ser colocado em setor.'; end if;
  perform _validar_setor(p_setor);
  if f is not null and f not in ('1CMD','2CMD','1AUX','2AUX') then raise exception 'Função inválida.'; end if;
  if p_setor is null then f := null; end if;
  if v.setor_id is not distinct from p_setor and v.funcao is not distinct from f then return; end if;

  antes := coalesce('Setor ' || (select nome from setores where id = v.setor_id), 'sem setor')
           || coalesce(' · ' || funcao_sigla(v.funcao), '');
  sn := (select nome from setores where id = p_setor);

  if f is not null then
    select * into h from membros where setor_id = p_setor and funcao = f and id <> p_id for update;
    if found then
      perform _pode_agir(h);
      update membros set funcao = null where id = h.id;
      perform _log('setor', h, 'Deixou de ser ' || funcao_sigla(f) || ' do Setor ' || sn, '');
    end if;
  end if;

  update membros set setor_id = p_setor, funcao = f where id = p_id returning * into v;
  perform _log('setor', v, antes || ' → ' || coalesce('Setor ' || sn, 'sem setor') || coalesce(' · ' || funcao_sigla(f), ''), '');
end $$;

-- ---------------------------------------------------------------------
-- Eventos e lista de presença
-- ---------------------------------------------------------------------

-- Pode registrar eventos: cargos com "presenca" na tabela de limites, ou quem tem função em algum setor (1 CMD, 2 CMD, 1 AUX, 2 AUX)
create or replace function public.pode_registrar() returns boolean
language sql stable security definer set search_path = public as $$
  select tem_perm('presenca') or exists (
    select 1 from staff s join membros m on m.id = s.membro_id
    where s.user_id = auth.uid() and m.status = 'ativo' and m.setor_id is not null and m.funcao in ('1CMD','2CMD','1AUX','2AUX'))
$$;

-- Pode editar/apagar eventos de outros e gerenciar tipos de evento
create or replace function public.pode_ajustar_eventos() returns boolean
language sql stable security definer set search_path = public as $$
  select tem_perm('ajustar_presenca')
$$;

create or replace function public._pode_editar_evento(e eventos) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if pode_ajustar_eventos() then return; end if;
  if e.criado_por = auth.uid() and pode_registrar() then return; end if;
  raise exception 'Só quem registrou o evento (ou um cargo com permissão de ajustar eventos) pode alterar.';
end $$;

-- Cria (p_id novo) ou atualiza (p_id existente) um evento com a lista completa de presentes.
-- O site gera o p_id antes para poder enviar as fotos para a pasta do evento.
create or replace function public.salvar_evento(p_id uuid, p_tipo uuid, p_titulo text, p_data timestamptz,
                                                p_instrutor uuid, p_descricao text, p_presentes uuid[], p_fotos text[])
returns uuid language plpgsql security definer set search_path = public as $$
declare e eventos; t tipos_evento; novo boolean; inst membros; qtd int; ausentes int; f text;
begin
  if p_id is null then raise exception 'Evento sem identificador.'; end if;
  select * into e from eventos where id = p_id for update;
  novo := not found;
  if novo then
    if not pode_registrar() then raise exception 'Você não tem permissão para registrar eventos.'; end if;
  else
    perform _pode_editar_evento(e);
  end if;

  select * into t from tipos_evento where id = p_tipo;
  if not found then raise exception 'Escolha o tipo do evento.'; end if;
  if p_data is null then raise exception 'Informe a data e o horário do evento.'; end if;
  if p_data > now() + interval '1 day' then raise exception 'A data do evento não pode estar no futuro.'; end if;
  if length(coalesce(p_titulo, '')) > 80 then raise exception 'O título pode ter no máximo 80 caracteres.'; end if;
  if length(coalesce(p_descricao, '')) > 4000 then raise exception 'O relatório pode ter no máximo 4000 caracteres.'; end if;

  if p_instrutor is not null then
    select * into inst from membros where id = p_instrutor;
    if not found then raise exception 'Instrutor não encontrado.'; end if;
  elsif t.treinamento then
    raise exception 'Informe o instrutor responsável pelo treinamento.';
  end if;

  qtd := coalesce(array_length(p_presentes, 1), 0);
  if qtd = 0 then raise exception 'Marque pelo menos um militar presente.'; end if;
  if qtd > 300 then raise exception 'Máximo de 300 presentes por evento.'; end if;
  select count(*) into ausentes from unnest(p_presentes) x(id)
   where not exists (select 1 from membros m where m.id = x.id
                     and (m.status = 'ativo' or exists (select 1 from presencas pr where pr.evento_id = p_id and pr.membro_id = m.id)));
  if ausentes > 0 then raise exception 'Há militares na lista que não existem ou estão exonerados.'; end if;

  if coalesce(array_length(p_fotos, 1), 0) > 6 then raise exception 'Máximo de 6 fotos por evento.'; end if;
  foreach f in array coalesce(p_fotos, '{}') loop
    if f not like p_id::text || '/%' then raise exception 'Foto inválida.'; end if;
  end loop;

  if novo then
    insert into eventos (id, tipo_id, tipo_nome, treinamento, titulo, data_hora, instrutor_id, instrutor_nome,
                         descricao, fotos, criado_por, criado_por_label)
    values (p_id, t.id, t.nome, t.treinamento, trim(coalesce(p_titulo, '')), p_data, p_instrutor,
            case when inst.id is null then '' else patente_sigla(inst.patente) || ' ' || inst.nome end,
            trim(coalesce(p_descricao, '')), coalesce(p_fotos, '{}'), auth.uid(), meu_rotulo());
  else
    update eventos set tipo_id = t.id, tipo_nome = t.nome, treinamento = t.treinamento, titulo = trim(coalesce(p_titulo, '')),
           data_hora = p_data, instrutor_id = p_instrutor,
           instrutor_nome = case when inst.id is null then '' else patente_sigla(inst.patente) || ' ' || inst.nome end,
           descricao = trim(coalesce(p_descricao, '')), fotos = coalesce(p_fotos, '{}'), atualizado_em = now()
     where id = p_id;
  end if;

  delete from presencas where evento_id = p_id and membro_id <> all (p_presentes);
  insert into presencas (evento_id, membro_id, membro_nome)
  select p_id, m.id, patente_sigla(m.patente) || ' ' || m.nome from membros m where m.id = any (p_presentes)
  on conflict (evento_id, membro_id) do nothing;

  perform _log('evento', null::membros,
    t.nome || coalesce(nullif(' · ' || trim(coalesce(p_titulo, '')), ' · '), '') || ' de ' ||
    to_char(p_data at time zone 'America/Sao_Paulo', 'DD/MM HH24:MI') ||
    case when novo then ' registrado' else ' alterado' end || ' com ' || qtd || ' presente' || case when qtd > 1 then 's' else '' end, '');
  return p_id;
end $$;

create or replace function public.apagar_evento(p_id uuid)
returns text[] language plpgsql security definer set search_path = public as $$
declare e eventos;
begin
  select * into e from eventos where id = p_id for update;
  if not found then raise exception 'Evento não encontrado.'; end if;
  perform _pode_editar_evento(e);
  delete from eventos where id = p_id;
  perform _log('evento', null::membros, e.tipo_nome || coalesce(nullif(' · ' || e.titulo, ' · '), '') || ' de ' ||
               to_char(e.data_hora at time zone 'America/Sao_Paulo', 'DD/MM HH24:MI') || ' apagado', '');
  return e.fotos;  -- o site apaga as fotos do armazenamento
end $$;

-- Total de presenças por militar: eventos + Roubo do Arsenal (só "ativo" conta como presença)
drop function if exists public.presencas_por_membro();
create or replace function public.presencas_por_membro()
returns table (membro_id uuid, total bigint, eventos bigint, arsenal bigint, justificados bigint)
language sql stable security definer set search_path = public as $$
  select x.membro_id,
         count(*) filter (where x.origem in ('e','a')),
         count(*) filter (where x.origem = 'e'),
         count(*) filter (where x.origem = 'a'),
         count(*) filter (where x.origem = 'j')
  from (select p.membro_id, 'e' as origem from presencas p
        union all
        select ap.membro_id, case ap.status when 'ativo' then 'a' when 'justificado' then 'j' else 'i' end from arsenal_presencas ap) x
  where is_staff()
  group by x.membro_id
$$;

create or replace function public.criar_tipo_evento(p_nome text, p_treinamento boolean)
returns uuid language plpgsql security definer set search_path = public as $$
declare n text := trim(coalesce(p_nome, '')); tid uuid;
begin
  if not pode_ajustar_eventos() then raise exception 'Seu cargo não pode gerenciar tipos de evento.'; end if;
  if n = '' or length(n) > 40 then raise exception 'Informe um nome com até 40 caracteres.'; end if;
  insert into tipos_evento (nome, treinamento, ordem)
  values (n, coalesce(p_treinamento, false), coalesce((select max(ordem) from tipos_evento), 0) + 1) returning id into tid;
  return tid;
exception when unique_violation then raise exception 'Já existe um tipo de evento com esse nome.';
end $$;

create or replace function public.editar_tipo_evento(p_id uuid, p_nome text, p_treinamento boolean)
returns void language plpgsql security definer set search_path = public as $$
declare n text := trim(coalesce(p_nome, ''));
begin
  if not pode_ajustar_eventos() then raise exception 'Seu cargo não pode gerenciar tipos de evento.'; end if;
  if n = '' or length(n) > 40 then raise exception 'Informe um nome com até 40 caracteres.'; end if;
  update tipos_evento set nome = n, treinamento = coalesce(p_treinamento, treinamento) where id = p_id;
  if not found then raise exception 'Tipo de evento não encontrado.'; end if;
exception when unique_violation then raise exception 'Já existe um tipo de evento com esse nome.';
end $$;

create or replace function public.apagar_tipo_evento(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not pode_ajustar_eventos() then raise exception 'Seu cargo não pode gerenciar tipos de evento.'; end if;
  delete from tipos_evento where id = p_id;  -- eventos antigos guardam o nome do tipo
end $$;

-- ---------------------------------------------------------------------
-- Lista de presença do Roubo do Arsenal
-- ---------------------------------------------------------------------

-- Pode marcar a lista deste setor: ADM e generais (Major General ou acima) marcam qualquer setor;
-- 1 CMD, 2 CMD, 1 AUX e 2 AUX marcam só o próprio setor.
create or replace function public.pode_marcar_arsenal(p_setor uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select is_adm()
      or meu_cargo() in ('majgen','tengen','celgen','genadj','federal')
      or exists (select 1 from staff s join membros m on m.id = s.membro_id
                 where s.user_id = auth.uid() and m.status = 'ativo' and m.funcao is not null and m.setor_id = p_setor)
$$;

-- Quem vê a lista de um setor: ADM e generais veem todos; os demais, só a do próprio setor
create or replace function public.pode_ver_arsenal(p_setor uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select is_adm()
      or meu_cargo() in ('majgen','tengen','celgen','genadj','federal')
      or exists (select 1 from staff s join membros m on m.id = s.membro_id
                 where s.user_id = auth.uid() and m.status = 'ativo' and m.setor_id = p_setor)
$$;

-- Resumo do dia (todos os setores): só Tenente General para cima e ADM
create or replace function public.pode_resumo_arsenal() returns boolean
language sql stable security definer set search_path = public as $$
  select is_adm() or meu_cargo() in ('tengen','celgen','genadj','federal')
$$;

-- Salva a situação de cada militar do setor num dia/horário: ativo, justificado ou inativo.
drop function if exists public.salvar_arsenal(date, int, uuid, uuid[]);
create or replace function public.salvar_arsenal(p_data date, p_hora int, p_setor uuid,
                                                 p_ativos uuid[], p_justificados uuid[], p_inativos uuid[])
returns void language plpgsql security definer set search_path = public as $$
declare a arsenal; sn text; todos uuid[]; na int; nj int; ni int; fora int;
begin
  p_ativos := coalesce(p_ativos, '{}'); p_justificados := coalesce(p_justificados, '{}'); p_inativos := coalesce(p_inativos, '{}');
  na := coalesce(array_length(p_ativos, 1), 0); nj := coalesce(array_length(p_justificados, 1), 0); ni := coalesce(array_length(p_inativos, 1), 0);
  todos := p_ativos || p_justificados || p_inativos;
  if p_data is null then raise exception 'Escolha o dia.'; end if;
  if p_hora is null or p_hora not in (11, 13, 15, 17, 19) then raise exception 'Escolha um horário válido (11h, 13h, 15h, 17h ou 19h).'; end if;
  if p_data > (now() at time zone 'America/Sao_Paulo')::date then raise exception 'Não dá para marcar presença em um dia que ainda não chegou.'; end if;
  select nome into sn from setores where id = p_setor;
  if not found then raise exception 'Escolha o setor.'; end if;
  if not pode_marcar_arsenal(p_setor) then raise exception 'Você só pode marcar a lista do seu próprio setor.'; end if;
  if na + nj + ni = 0 then raise exception 'Não há militares na lista.'; end if;
  if na + nj + ni > 300 then raise exception 'Máximo de 300 militares por lista.'; end if;
  if (select count(distinct x) from unnest(todos) x) <> na + nj + ni then raise exception 'Um militar aparece com mais de uma situação.'; end if;

  select * into a from arsenal where data = p_data and hora = p_hora and setor_id = p_setor for update;

  select count(*) into fora from unnest(todos) x(id)
   where not exists (select 1 from membros m where m.id = x.id and
           ((m.status = 'ativo' and m.setor_id = p_setor)
            or (a.id is not null and exists (select 1 from arsenal_presencas ap where ap.arsenal_id = a.id and ap.membro_id = m.id))));
  if fora > 0 then raise exception 'Só é possível marcar militares ativos do Setor %.', sn; end if;

  if a.id is null then
    insert into arsenal (data, hora, setor_id, atualizado_por, atualizado_label)
    values (p_data, p_hora, p_setor, auth.uid(), meu_rotulo()) returning * into a;
  else
    update arsenal set atualizado_por = auth.uid(), atualizado_label = meu_rotulo(), atualizado_em = now() where id = a.id;
  end if;

  delete from arsenal_presencas where arsenal_id = a.id and membro_id <> all (todos);
  insert into arsenal_presencas (arsenal_id, membro_id, membro_nome, status)
  select a.id, m.id, patente_sigla(m.patente) || ' ' || m.nome,
         case when m.id = any (p_ativos) then 'ativo' when m.id = any (p_justificados) then 'justificado' else 'inativo' end
  from membros m where m.id = any (todos)
  on conflict (arsenal_id, membro_id) do update set status = excluded.status;

  perform _log('arsenal', null::membros, 'Roubo do Arsenal ' || to_char(p_data, 'DD/MM') || ' ' || p_hora || 'h · Setor ' || sn || ': '
               || na || ' ativo' || case when na <> 1 then 's' else '' end || ', '
               || nj || ' justificado' || case when nj <> 1 then 's' else '' end || ', '
               || ni || ' inativo' || case when ni <> 1 then 's' else '' end, '');
end $$;

-- ---------------------------------------------------------------------
-- Contas e acessos (ADM Geral)
-- ---------------------------------------------------------------------

create or replace function public.existe_adm() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from staff where cargo = 'adm')
$$;

-- Primeiro acesso: quem chamar primeiro vira ADM Geral. Depois disso fica travado.
create or replace function public.assumir_adm() returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Faça login para continuar.'; end if;
  lock table staff in exclusive mode;
  if exists (select 1 from staff where cargo = 'adm') then
    raise exception 'O ADM Geral já foi definido.';
  end if;
  insert into staff (user_id, cargo, nome)
  values (auth.uid(), 'adm', coalesce((select nome_jogo from perfis where user_id = auth.uid()), 'ADM Geral'))
  on conflict (user_id) do update set cargo = 'adm', membro_id = null;
end $$;

-- Libera uma conta: liga a uma ficha existente (p_membro) ou cria uma ficha nova.
create or replace function public.liberar_conta(p_user uuid, p_membro uuid, p_nome text, p_discord text,
                                                p_patente int, p_setor uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v membros; login text;
begin
  if not is_adm() then raise exception 'Só o ADM Geral libera contas.'; end if;
  if p_user = auth.uid() then raise exception 'Essa é a sua própria conta.'; end if;
  select nome_jogo into login from perfis where user_id = p_user;
  if not found then raise exception 'Conta não encontrada.'; end if;
  if exists (select 1 from staff where user_id = p_user) then raise exception 'Essa conta já tem acesso.'; end if;

  if p_membro is not null then
    v := _carregar(p_membro);
    if v.status <> 'ativo' then raise exception 'Essa ficha está exonerada. Readmita antes de ligar a uma conta.'; end if;
    if exists (select 1 from staff where membro_id = p_membro) then raise exception 'Essa ficha já está ligada a outra conta.'; end if;
  else
    if p_patente is null or p_patente < 0 or p_patente > 13 then raise exception 'Escolha a patente.'; end if;
    perform _validar_setor(p_setor);
    insert into membros (nome, discord, patente, setor_id, criado_por)
    values (_validar_nome(p_nome), _validar_discord(p_discord, null), p_patente, p_setor, auth.uid())
    returning * into v;
    perform _log('cadastro', v, 'Cadastrado como ' || patente_nome(v.patente) || ' ao liberar a conta', '');
  end if;

  insert into staff (user_id, cargo, nome, membro_id) values (p_user, 'membro', v.nome, v.id);
  perform _log('acesso', v, 'Conta liberada (login: ' || coalesce(login, '?') || ')', '');
end $$;

create or replace function public.remover_acesso(p_user uuid)
returns void language plpgsql security definer set search_path = public as $$
declare s staff; v membros;
begin
  if not is_adm() then raise exception 'Só o ADM Geral gerencia acessos.'; end if;
  if p_user = auth.uid() then raise exception 'Você não pode remover o seu próprio acesso.'; end if;
  select * into s from staff where user_id = p_user for update;
  if not found then raise exception 'Conta não encontrada.'; end if;
  if s.membro_id is not null then select * into v from membros where id = s.membro_id; end if;
  delete from staff where user_id = p_user;
  perform _log('acesso', v, 'Acesso ao painel removido (a ficha continua no efetivo)', '');
end $$;

create or replace function public.salvar_permissoes(p jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare k text; v jsonb;
begin
  if not is_adm() then raise exception 'Só o ADM Geral altera os limites.'; end if;
  for k, v in select * from jsonb_each(p) loop
    continue when k not in ('federal','genadj','celgen','tengen','majgen');
    update cargo_perms set
      cadastrar     = coalesce((v->>'cadastrar')::boolean, cadastrar),
      editar        = coalesce((v->>'editar')::boolean, editar),
      promover      = coalesce((v->>'promover')::boolean, promover),
      punir         = coalesce((v->>'punir')::boolean, punir),
      revogar       = coalesce((v->>'revogar')::boolean, revogar),
      exonerar      = coalesce((v->>'exonerar')::boolean, exonerar),
      ponto         = coalesce((v->>'ponto')::boolean, ponto),
      ajustar_ponto = coalesce((v->>'ajustar_ponto')::boolean, ajustar_ponto),
      setores       = coalesce((v->>'setores')::boolean, setores),
      presenca      = coalesce((v->>'presenca')::boolean, presenca),
      ajustar_presenca = coalesce((v->>'ajustar_presenca')::boolean, ajustar_presenca),
      max_patente   = least(greatest(coalesce((v->>'max_patente')::int, max_patente), 0), nivel_cargo(k) - 1)
    where cargo = k;
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- Perfil automático no cadastro de conta (nome no jogo + usuário de login)
-- ---------------------------------------------------------------------
create or replace function public._sync_perfil() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into perfis (user_id, nome_jogo, usuario)
  values (new.id,
          coalesce(new.raw_user_meta_data->>'nome_jogo', split_part(new.email, '@', 1)),
          coalesce(new.raw_user_meta_data->>'usuario', split_part(new.email, '@', 1)))
  on conflict (user_id) do update set nome_jogo = excluded.nome_jogo, usuario = excluded.usuario;
  return new;
end $$;

drop trigger if exists on_auth_user_sync on auth.users;
create trigger on_auth_user_sync
  after insert or update of raw_user_meta_data on auth.users
  for each row execute function public._sync_perfil();

insert into public.perfis (user_id, nome_jogo, usuario)
select id, coalesce(raw_user_meta_data->>'nome_jogo', split_part(email, '@', 1)),
           coalesce(raw_user_meta_data->>'usuario', split_part(email, '@', 1))
from auth.users
on conflict (user_id) do nothing;

-- ADM Geral redefine a senha de quem esqueceu (não há e-mail de recuperação)
create or replace function public.redefinir_senha(p_user uuid, p_senha text)
returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  if not is_adm() then raise exception 'Só o ADM Geral redefine senhas.'; end if;
  if p_senha is null or length(p_senha) < 6 then raise exception 'A senha precisa ter pelo menos 6 caracteres.'; end if;
  if not exists (select 1 from perfis where user_id = p_user) then raise exception 'Usuário não encontrado.'; end if;
  update auth.users set encrypted_password = crypt(p_senha, gen_salt('bf')), updated_at = now() where id = p_user;
end $$;

-- ---------------------------------------------------------------------
-- Segurança: leitura só para quem tem acesso, escrita só pelas funções
-- ---------------------------------------------------------------------
alter table public.perfis      enable row level security;
alter table public.staff       enable row level security;
alter table public.cargo_perms enable row level security;
alter table public.setores     enable row level security;
alter table public.membros     enable row level security;
alter table public.punicoes    enable row level security;
alter table public.ponto       enable row level security;
alter table public.historico   enable row level security;
alter table public.tipos_evento enable row level security;
alter table public.eventos      enable row level security;
alter table public.presencas    enable row level security;
alter table public.arsenal      enable row level security;
alter table public.arsenal_presencas enable row level security;

drop policy if exists leitura on public.perfis;
create policy leitura on public.perfis      for select to authenticated using (user_id = auth.uid() or is_adm());
drop policy if exists leitura on public.staff;
create policy leitura on public.staff       for select to authenticated using (user_id = auth.uid() or is_staff());
drop policy if exists leitura on public.cargo_perms;
create policy leitura on public.cargo_perms for select to authenticated using (is_staff());
drop policy if exists leitura on public.setores;
create policy leitura on public.setores     for select to authenticated using (is_staff());
drop policy if exists leitura on public.membros;
create policy leitura on public.membros     for select to authenticated using (is_staff());
drop policy if exists leitura on public.punicoes;
create policy leitura on public.punicoes    for select to authenticated using (is_staff());
drop policy if exists leitura on public.ponto;
create policy leitura on public.ponto       for select to authenticated using (is_staff());
drop policy if exists leitura on public.historico;
create policy leitura on public.historico   for select to authenticated using (is_staff());
drop policy if exists leitura on public.tipos_evento;
create policy leitura on public.tipos_evento for select to authenticated using (is_staff());
drop policy if exists leitura on public.eventos;
create policy leitura on public.eventos      for select to authenticated using (is_staff());
drop policy if exists leitura on public.presencas;
create policy leitura on public.presencas    for select to authenticated using (is_staff());
drop policy if exists leitura on public.arsenal;
create policy leitura on public.arsenal      for select to authenticated using (is_staff() and pode_ver_arsenal(setor_id));
drop policy if exists leitura on public.arsenal_presencas;
create policy leitura on public.arsenal_presencas for select to authenticated
  using (is_staff() and exists (select 1 from public.arsenal a where a.id = arsenal_id and pode_ver_arsenal(a.setor_id)));

revoke insert, update, delete, truncate on
  public.perfis, public.staff, public.cargo_perms, public.setores, public.membros, public.punicoes, public.ponto, public.historico,
  public.tipos_evento, public.eventos, public.presencas, public.arsenal, public.arsenal_presencas
  from anon, authenticated;
revoke select on
  public.perfis, public.staff, public.cargo_perms, public.setores, public.membros, public.punicoes, public.ponto, public.historico,
  public.tipos_evento, public.eventos, public.presencas, public.arsenal, public.arsenal_presencas
  from anon;

-- Funções: só usuários logados chamam; as internas (_) ninguém chama de fora
revoke execute on all functions in schema public from public, anon;
grant  execute on all functions in schema public to authenticated;
revoke execute on function public._exigir(text)                    from authenticated;
revoke execute on function public._pode_agir(membros)              from authenticated;
revoke execute on function public._carregar(uuid)                  from authenticated;
revoke execute on function public._log(text, membros, text, text)  from authenticated;
revoke execute on function public._exigir_motivo(text)             from authenticated;
revoke execute on function public._validar_nome(text)              from authenticated;
revoke execute on function public._validar_discord(text, uuid)     from authenticated;
revoke execute on function public._validar_setor(uuid)             from authenticated;
revoke execute on function public._fechar_ponto(membros)           from authenticated;
revoke execute on function public._sync_perfil()                   from authenticated;
revoke execute on function public._pode_editar_evento(eventos)     from authenticated;

-- ---------------------------------------------------------------------
-- Tempo real: o painel atualiza sozinho quando alguém altera algo
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['perfis','staff','cargo_perms','setores','membros','punicoes','ponto','historico','tipos_evento','eventos','presencas','arsenal','arsenal_presencas'] loop
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- Fotos dos eventos (Supabase Storage, pasta privada "eventos")
-- Só quem tem acesso ao painel vê; só quem registra eventos envia.
-- ---------------------------------------------------------------------
do $$
begin
  insert into storage.buckets (id, name, public) values ('eventos', 'eventos', false) on conflict (id) do nothing;
  begin
    update storage.buckets set file_size_limit = 5242880,
           allowed_mime_types = array['image/jpeg','image/png','image/webp'] where id = 'eventos';
  exception when others then null;
  end;
  execute 'drop policy if exists "eventos_fotos_ler" on storage.objects';
  execute $p$create policy "eventos_fotos_ler" on storage.objects for select to authenticated
             using (bucket_id = 'eventos' and public.is_staff())$p$;
  execute 'drop policy if exists "eventos_fotos_enviar" on storage.objects';
  execute $p$create policy "eventos_fotos_enviar" on storage.objects for insert to authenticated
             with check (bucket_id = 'eventos' and public.pode_registrar())$p$;
  execute 'drop policy if exists "eventos_fotos_apagar" on storage.objects';
  execute $p$create policy "eventos_fotos_apagar" on storage.objects for delete to authenticated
             using (bucket_id = 'eventos' and (public.pode_ajustar_eventos() or owner = auth.uid()))$p$;
exception when others then
  raise notice 'Fotos: não foi possível configurar o armazenamento automaticamente (%). Veja o README.', sqlerrm;
end $$;
