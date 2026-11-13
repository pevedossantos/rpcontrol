# Exército de Solano · Controle de Efetivo

Painel web de controle de efetivo da base militar **Exército de Solano** (One State RP).

- **Efetivo:** cadastro com nome no RP, Discord (obrigatório), patente, setor, ingresso e observações
- **Setores:** Sul, Norte, Centro, Leste e Especiais (editáveis), com as funções 1 CMD, 2 CMD, 1 AUX e 2 AUX
- **Promoções e punições:** histórico completo, com motivo e autor
- **Lista de presença do Roubo do Arsenal:** dia, horário (11h, 13h, 15h, 17h, 19h) e setor; marca quem participou
- **Eventos:** treinamentos e outros eventos, com relatório, instrutor, fotos e filtros por data e horário
- **Acessos pela patente:** login com o nome do jogo e senha; cada conta é ligada a uma ficha e a patente define o que pode fazer
- **Tempo real:** o que um oficial altera aparece na tela dos outros na hora

Tecnologia: HTML + JavaScript puro (sem build), hospedado no GitHub Pages, com banco, login e tempo real no [Supabase](https://supabase.com).

```
index.html           página
style.css            visual
app.js               lógica do painel
config.js            URL e chave pública do Supabase  ← você edita
supabase/schema.sql  banco: tabelas, regras de permissão e funções
```

---

## Configuração (uma vez só, ~15 minutos)

### 1. Banco de dados no Supabase

1. Crie um projeto no Supabase (região **South America (São Paulo)**, se tiver).
2. No menu lateral, abra **SQL Editor** → **New query**.
3. Cole **todo** o conteúdo de `supabase/schema.sql` e clique em **Run**.
   Deve terminar com "Success". Pode rodar de novo quando o arquivo for atualizado: os dados não se perdem.

### 2. Login com nome e senha

O painel usa o login por e-mail do Supabase por baixo dos panos: o nome do jogo vira um endereço interno
(`joao.silva@solano-efetivo.com`) que ninguém precisa saber. Nenhum e-mail é enviado.

1. Supabase → **Authentication** → **Sign In / Providers** (ou **Providers**) → **Email**.
2. Deixe **Enable Email provider** (ou **Enable email signups**) **ligado**.
3. **Desligue "Confirm email"** e salve. Sem isso, as contas novas ficam travadas esperando um e-mail que nunca chega.
4. Em **Authentication** → **Settings** (se existir), deixe **Allow new users to sign up** ligado.

### 3. Publicar no GitHub Pages

1. Crie um repositório (pode ser `solano-efetivo`) e envie estes arquivos.
2. Repositório → **Settings** → **Pages** → **Source: Deploy from a branch** → branch `main`, pasta `/ (root)` → **Save**.
3. Em 1 ou 2 minutos o site fica em `https://SEU-USUARIO.github.io/solano-efetivo/`.

### 4. Ligar o site ao Supabase

1. Supabase → **Project Settings** → **API** (ou **API Keys**).
2. Copie a **Project URL** e a chave **anon** / **publishable**.
3. Cole em `config.js` e envie para o GitHub.

> A chave anon/publishable é pública e pode ficar no repositório: quem protege os dados são as regras do banco.
> **Nunca** coloque a chave `service_role` / `secret` no site.

### 5. Primeiro acesso

1. Abra o site, clique em **Criar conta**, use o seu nome do jogo e uma senha.
2. Clique em **Assumir como ADM Geral**. Essa opção aparece só uma vez: depois que existe um ADM, ela some para todos.
   Faça isso logo depois de publicar, antes de divulgar o link.
3. Peça para os militares criarem conta. Eles aparecem na aba **Acessos → Aguardando liberação**.
   Confirme no jogo que a conta é mesmo da pessoa e clique em **Liberar**: crie uma ficha nova ou ligue a uma ficha que já existe.

### Senhas

- Cada um troca a própria senha em **Trocar senha**, no topo do painel.
- Esqueceu? O ADM Geral usa **Redefinir senha** na aba Acessos e passa a senha nova em particular.
- Nomes com acento ou maiúsculas viram o mesmo login: "João Silva" e "joao silva" são a mesma conta.

---

## No celular

O painel foi feito para ser usado principalmente no celular:
- Barra de navegação embaixo (**Início, Efetivo, Presença, Eventos, Mais**). Em **Mais** ficam Setores, Histórico,
  Acessos, Trocar senha e Sair.
- Listas viram cartões, formulários abrem em tela cheia e os campos não dão zoom no iPhone.
- **Instalar como app:** no iPhone, abra o site no Safari → Compartilhar → **Adicionar à Tela de Início**.
  No Android, Chrome → menu ⋮ → **Instalar app** (ou Adicionar à tela inicial).

## Acessos e permissões

Cada conta é ligada a uma ficha do efetivo, e **a patente da ficha define o acesso**:

| Patente da ficha | Acesso | Padrão |
|---|---|---|
| — | ADM Geral | Tudo, sem limites; gerencia contas. Não entra na contagem do efetivo |
| Federal | Federal | Tudo, concede até GEN ADJ |
| General Adjunto | General Adjunto | Tudo, concede até CEL GEN |
| Coronel General | Coronel General | Sem revogar punição e ajustar eventos de outros, concede até TEN GEN |
| Tenente General | Tenente General | Sem revogar, exonerar, ajustar eventos de outros e setores, concede até MAJ GEN |
| Major General | Major General | Sem editar, revogar, exonerar, ajustar eventos de outros e setores, concede até CEL |
| Recruta a Coronel | Visualização | Vê o painel, não altera nada (exceto quem tem função no setor, que registra eventos) |

- Os limites dos generais são editáveis pelo ADM Geral na aba **Acessos**.
- Promoção, rebaixamento ou exoneração mudam o acesso na hora. Ficha exonerada = acesso suspenso.
- Regra fixa: ninguém promove, pune, edita, exonera ou move de setor militar de patente igual ou maior que a própria.
- Conta ainda não liberada não vê nenhum dado.

## Setores e funções

- Aba **Setores**: cada setor mostra as funções 1 CMD, 2 CMD, 1 AUX e 2 AUX e os militares dele.
- Cada função é única no setor: ao atribuir a outro militar, quem ocupava perde a função e continua no setor.
- Um militar fica em um setor por vez. Exonerado sai do setor automaticamente.
- Quem pode mexer: ADM Geral e os cargos com **Gerenciar setores e funções** ligado.

## Lista de presença · Roubo do Arsenal

- Aba **Lista de presença**: escolha o dia, o horário (11h, 13h, 15h, 17h ou 19h) e o setor. Cada militar do setor aparece numa linha
  com a situação **Ativo**, **Justificado** ou **Inativo** (padrão). Ajuste e clique em **Salvar lista**.
- Só **Ativo** conta como presença na ficha; **Justificado** aparece contado à parte.
- Cada setor tem a sua lista em cada horário.
- Quem marca: ADM Geral e generais (Major General ou acima) em qualquer setor;
  **1 CMD, 2 CMD, 1 AUX e 2 AUX** só no próprio setor.
- Quem vê: ADM e generais veem todos os setores; os demais veem **só a lista do próprio setor** (bloqueado no banco).
- **Resumo do dia** (todos os setores × horários, com **Copiar resumo** para o Discord) fica na **Visão geral**
  e só aparece para **Tenente General ou acima** e o ADM Geral.
- As presenças do Roubo do Arsenal entram na contagem da ficha de cada militar, junto com as dos eventos.

## Eventos (treinamentos e outros)

- Aba **Eventos**: para treinamentos e eventos que não são o Roubo do Arsenal. Cada evento tem tipo, data e horário, título opcional, observações e a lista de quem participou.
- Tipos marcados como **treinamento** viram relatório de treinamento: pedem instrutor responsável e conteúdo.
- Até 6 fotos por evento (reduzidas automaticamente antes do envio). Só quem tem acesso ao painel vê as fotos.
- Filtros por tipo, data e horário (De / Até), busca por participante e atalhos Hoje / 7 dias / 30 dias.
  O botão **Copiar relatório** gera um texto pronto para colar no Discord com os eventos e a presença por militar.
- Quem registra: cargos com **Registrar eventos e lista de presença** ligado e quem tem função num setor (**1 CMD, 2 CMD, 1 AUX ou 2 AUX**).
  Quem registrou edita o próprio evento; cargos com **Editar e apagar eventos de outros** mexem em qualquer um e nos tipos.
- O antigo bate-ponto saiu da tela. Os registros antigos continuam guardados no banco.

**Fotos não carregam ou dão erro ao enviar?** O script cria sozinho a pasta privada `eventos` no Storage do Supabase.
Se aparecer um aviso sobre "armazenamento" ao rodar o script, crie em **Storage → New bucket**, nome `eventos`, **privado**,
e rode o script de novo para aplicar as regras de acesso.

### Como a segurança funciona

O site só lê dados. Toda alteração chama uma função no banco (`cadastrar_membro`, `alterar_patente`, `aplicar_punicao`…) que confere no servidor o cargo, a permissão e a patente antes de gravar, e registra o histórico na mesma operação. Mesmo alguém mexendo no código do navegador não consegue passar dos limites do próprio cargo.

---

## Testar no seu computador

Com o [VS Code](https://code.visualstudio.com) e a extensão **Live Server**: abra a pasta, clique com o botão direito em `index.html` → **Open with Live Server** (abre em `http://localhost:5500`).

## Patentes

REC · SLD · SGT · 1 SGT · SGT MOR · TEN · CAP · MAJ · CEL · MAJ GEN · TEN GEN · CEL GEN · GEN ADJ · FEDERAL

Para mudar a lista, altere `PAT` em `app.js` **e** as funções `patente_sigla` / `patente_nome` em `supabase/schema.sql` (e o limite `13` das verificações).
