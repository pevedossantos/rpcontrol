-- =====================================================================
--  Exército de Solano · Controle de Efetivo
--  Script do banco (Supabase / Postgres)
--
--  Como usar: Supabase → SQL Editor → New query → cole TODO este arquivo → Run.
--  Pode rodar de novo sem perder dados (usa "if not exists" / "or replace").
--
--  Modelo de segurança:
--   • Só quem tem cargo (tabela staff) consegue LER os dados.
--   • Ninguém escreve direto nas tabelas. Toda alteração passa por uma
--     função (RPC) que confere o cargo, as permissões e a patente no servidor
--     e grava o histórico junto.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- Tabelas
-- ---------------------------------------------------------------------

-- Conta de quem se cadastrou no painel (preenchido automaticamente no cadastro)
create table if not exists public.perfis (
  user_id   uuid primary key references auth.users on delete cascade,
  nome_jogo text,
  usuario   text,
  criado_em timestamptz not null default now()
);
-- Migração da versão com login pelo Discord
do $$ begin
  if exists (select 1 from information_schema.columns where table_schema='public' and table_name='perfis' and column_name='discord_nome') then
    alter table public.perfis rename column discord_nome to nome_jogo;
  end if;
end $$;
alter table public.perfis add column if not exists usuario text;
alter table public.perfis drop column if exists avatar_url;
create unique index if not exists perfis_usuario_uk on public.perfis (usuario);

-- Oficiais com acesso ao painel
create table if not exists public.staff (
  user_id   uuid primary key references auth.users on delete cascade,
  cargo     text not null check (cargo in ('adm','federal','genadj','celgen','tengen','majgen')),
  nome      text not null,
  criado_em timestamptz not null default now()
);

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

-- Militares
create table if not exists public.membros (
  id             uuid primary key default gen_random_uuid(),
  nome           text not null check (length(nome) between 1 and 60),
  passaporte     text not null check (length(passaporte) between 1 and 20),
  discord        text not null default '',
  patente        int  not null default 0 check (patente between 0 and 13),
  status         text not null default 'ativo' check (status in ('ativo','exonerado')),
  ingresso       date not null default current_date,
  obs            text not null default '',
  total_ms       bigint not null default 0,
  servico_inicio timestamptz,
  servico_sessao uuid,
  criado_em      timestamptz not null default now(),
  criado_por     uuid
);
create unique index if not exists membros_passaporte_uk on public.membros (lower(trim(passaporte)));

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

-- ---------------------------------------------------------------------
-- Funções auxiliares
-- ---------------------------------------------------------------------

create or replace function public.patente_sigla(i int) returns text
language sql immutable as $$
  select (array['REC','SLD','SGT','1 SGT','SGT MOR','TEN','CAP','MAJ','CEL','MAJ GEN','TEN GEN','CEL GEN','GEN ADJ','FEDERAL'])[i+1]
$$;

create or replace function public.patente_nome(i int) returns text
language sql immutable as $$
  select (array['Recruta','Soldado','Sargento','1º Sargento','Sargento Mor','Tenente','Capitão','Major','Coronel',
                'Major General','Tenente General','Coronel General','General Adjunto','Federal'])[i+1]
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
                when 'majgen' then 'Major General' else 'Sem cargo' end
$$;

create or replace function public.meu_cargo() returns text
language sql stable security definer set search_path = public as $$
  select cargo from staff where user_id = auth.uid()
$$;

create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from staff where user_id = auth.uid())
$$;

create or replace function public.is_adm() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select cargo = 'adm' from staff where user_id = auth.uid()), false)
$$;

create or replace function public.meu_nivel() returns int
language sql stable security definer set search_path = public as $$
  select nivel_cargo(meu_cargo())
$$;

create or replace function public.meu_rotulo() returns text
language sql stable security definer set search_path = public as $$
  select nome || ' · ' || nome_cargo(cargo) from staff where user_id = auth.uid()
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
-- Ações do painel (RPC)
-- ---------------------------------------------------------------------

create or replace function public.cadastrar_membro(p_nome text, p_passaporte text, p_discord text,
                                                   p_patente int, p_ingresso date, p_obs text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v membros; mx int;
begin
  perform _exigir('cadastrar');
  mx := minha_max_patente();
  if p_patente is null or p_patente < 0 or p_patente > greatest(mx, 0) then
    raise exception 'Você só pode cadastrar até a patente %.', patente_nome(greatest(mx, 0));
  end if;
  insert into membros (nome, passaporte, discord, patente, ingresso, obs, criado_por)
  values (trim(p_nome), trim(p_passaporte), coalesce(trim(p_discord), ''), p_patente,
          coalesce(p_ingresso, current_date), coalesce(trim(p_obs), ''), auth.uid())
  returning * into v;
  perform _log('cadastro', v, 'Cadastrado como ' || patente_nome(v.patente), '');
  return v.id;
exception when unique_violation then
  raise exception 'Já existe um militar com esse passaporte.';
end $$;

create or replace function public.editar_membro(p_id uuid, p_nome text, p_passaporte text, p_discord text,
                                                p_ingresso date, p_obs text)
returns void language plpgsql security definer set search_path = public as $$
declare v membros;
begin
  perform _exigir('editar');
  v := _carregar(p_id);
  perform _pode_agir(v);
  update membros set nome = trim(p_nome), passaporte = trim(p_passaporte), discord = coalesce(trim(p_discord), ''),
                     ingresso = coalesce(p_ingresso, ingresso), obs = coalesce(trim(p_obs), '')
   where id = p_id returning * into v;
  perform _log('edicao', v, 'Dados atualizados', '');
exception when unique_violation then
  raise exception 'Já existe outro militar com esse passaporte.';
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
  update membros set status = 'exonerado' where id = p_id returning * into v;
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
  perform _log('remocao', v, 'Cadastro apagado', '');
  delete from membros where id = p_id;
end $$;

-- ---------------------------------------------------------------------
-- Acessos (ADM Geral)
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
  on conflict (user_id) do update set cargo = 'adm';
end $$;

create or replace function public.definir_staff(p_user uuid, p_cargo text, p_nome text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_adm() then raise exception 'Só o ADM Geral gerencia acessos.'; end if;
  if p_user = auth.uid() then raise exception 'Você não pode alterar o seu próprio cargo.'; end if;
  if p_cargo not in ('federal','genadj','celgen','tengen','majgen') then raise exception 'Cargo inválido.'; end if;
  if p_nome is null or length(trim(p_nome)) = 0 then raise exception 'Informe o nome no RP.'; end if;
  if not exists (select 1 from perfis where user_id = p_user) then raise exception 'Usuário não encontrado.'; end if;
  insert into staff (user_id, cargo, nome) values (p_user, p_cargo, trim(p_nome))
  on conflict (user_id) do update set cargo = excluded.cargo, nome = excluded.nome;
end $$;

create or replace function public.remover_staff(p_user uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_adm() then raise exception 'Só o ADM Geral gerencia acessos.'; end if;
  if p_user = auth.uid() then raise exception 'Você não pode remover o seu próprio acesso.'; end if;
  delete from staff where user_id = p_user;
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
      max_patente   = least(greatest(coalesce((v->>'max_patente')::int, max_patente), 0), nivel_cargo(k) - 1)
    where cargo = k;
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- Perfil automático no cadastro (nome no jogo + usuário de login)
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

-- Contas que já existiam antes deste script
insert into public.perfis (user_id, nome_jogo, usuario)
select id, coalesce(raw_user_meta_data->>'nome_jogo', split_part(email, '@', 1)),
           coalesce(raw_user_meta_data->>'usuario', split_part(email, '@', 1))
from auth.users
on conflict (user_id) do nothing;

-- ADM Geral redefine a senha de um oficial que esqueceu (não há e-mail de recuperação)
create or replace function public.redefinir_senha(p_user uuid, p_senha text)
returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  if not is_adm() then raise exception 'Só o ADM Geral redefine senhas.'; end if;
  if p_senha is null or length(p_senha) < 6 then raise exception 'A senha precisa ter pelo menos 6 caracteres.'; end if;
  if not exists (select 1 from perfis where user_id = p_user) then raise exception 'Usuário não encontrado.'; end if;
  update auth.users set encrypted_password = crypt(p_senha, gen_salt('bf')), updated_at = now() where id = p_user;
end $$;

-- ---------------------------------------------------------------------
-- Segurança: leitura só para quem tem cargo, escrita só pelas funções
-- ---------------------------------------------------------------------
alter table public.perfis      enable row level security;
alter table public.staff       enable row level security;
alter table public.cargo_perms enable row level security;
alter table public.membros     enable row level security;
alter table public.punicoes    enable row level security;
alter table public.ponto       enable row level security;
alter table public.historico   enable row level security;

drop policy if exists leitura on public.perfis;
create policy leitura on public.perfis      for select to authenticated using (user_id = auth.uid() or is_staff());
drop policy if exists leitura on public.staff;
create policy leitura on public.staff       for select to authenticated using (user_id = auth.uid() or is_staff());
drop policy if exists leitura on public.cargo_perms;
create policy leitura on public.cargo_perms for select to authenticated using (is_staff());
drop policy if exists leitura on public.membros;
create policy leitura on public.membros     for select to authenticated using (is_staff());
drop policy if exists leitura on public.punicoes;
create policy leitura on public.punicoes    for select to authenticated using (is_staff());
drop policy if exists leitura on public.ponto;
create policy leitura on public.ponto       for select to authenticated using (is_staff());
drop policy if exists leitura on public.historico;
create policy leitura on public.historico   for select to authenticated using (is_staff());

revoke insert, update, delete, truncate on
  public.perfis, public.staff, public.cargo_perms, public.membros, public.punicoes, public.ponto, public.historico
  from anon, authenticated;
revoke select on
  public.perfis, public.staff, public.cargo_perms, public.membros, public.punicoes, public.ponto, public.historico
  from anon;

-- Funções: só usuários logados chamam; as internas (_) ninguém chama de fora
revoke execute on all functions in schema public from public, anon;
grant  execute on all functions in schema public to authenticated;
revoke execute on function public._exigir(text)                    from authenticated;
revoke execute on function public._pode_agir(membros)              from authenticated;
revoke execute on function public._carregar(uuid)                  from authenticated;
revoke execute on function public._log(text, membros, text, text)  from authenticated;
revoke execute on function public._exigir_motivo(text)             from authenticated;
revoke execute on function public._fechar_ponto(membros)           from authenticated;
revoke execute on function public._sync_perfil()                   from authenticated;

-- ---------------------------------------------------------------------
-- Tempo real: o painel atualiza sozinho quando alguém altera algo
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['perfis','staff','cargo_perms','membros','punicoes','ponto','historico'] loop
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
