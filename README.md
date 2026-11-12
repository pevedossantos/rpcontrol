# Exército de Solano · Controle de Efetivo

Painel web de controle de efetivo da base militar **Exército de Solano** (One State RP).

- **Efetivo:** cadastro com nome no RP, passaporte, Discord, patente, ingresso e observações
- **Promoções e punições:** histórico completo, com motivo e autor
- **Bate-ponto:** entrada e saída de serviço, horas acumuladas, ranking semanal
- **Acessos por cargo:** login com o nome do jogo e senha; limites de cada cargo conferidos pelo banco de dados
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
3. Peça para os oficiais criarem conta. Eles aparecem na aba **Acessos → Aguardando liberação**.
   Confirme no jogo que a conta é mesmo da pessoa e defina o nome no RP e o cargo.

### Senhas

- Cada um troca a própria senha em **Trocar senha**, no topo do painel.
- Esqueceu? O ADM Geral usa **Redefinir senha** na aba Acessos e passa a senha nova em particular.
- Nomes com acento ou maiúsculas viram o mesmo login: "João Silva" e "joao silva" são a mesma conta.

---

## Cargos e permissões

| Cargo | Padrão |
|---|---|
| ADM Geral | Tudo, sem limite de patente, gerencia acessos |
| Federal | Tudo, concede até GEN ADJ |
| General Adjunto | Tudo, concede até CEL GEN |
| Coronel General | Sem revogar punição e sem ajustar ponto, concede até TEN GEN |
| Tenente General | Sem revogar, exonerar e ajustar ponto, concede até MAJ GEN |
| Major General | Sem editar, revogar, exonerar e ajustar ponto, concede até CEL |

- Tudo isso é editável pelo ADM Geral na aba **Acessos**.
- Regra fixa: ninguém promove, pune, edita ou exonera militar de patente igual ou maior que a própria.
- Quem criou conta mas não tem cargo não vê nenhum dado.

### Como a segurança funciona

O site só lê dados. Toda alteração chama uma função no banco (`cadastrar_membro`, `alterar_patente`, `aplicar_punicao`…) que confere no servidor o cargo, a permissão e a patente antes de gravar, e registra o histórico na mesma operação. Mesmo alguém mexendo no código do navegador não consegue passar dos limites do próprio cargo.

---

## Testar no seu computador

Com o [VS Code](https://code.visualstudio.com) e a extensão **Live Server**: abra a pasta, clique com o botão direito em `index.html` → **Open with Live Server** (abre em `http://localhost:5500`).

## Patentes

REC · SLD · SGT · 1 SGT · SGT MOR · TEN · CAP · MAJ · CEL · MAJ GEN · TEN GEN · CEL GEN · GEN ADJ · FEDERAL

Para mudar a lista, altere `PAT` em `app.js` **e** as funções `patente_sigla` / `patente_nome` em `supabase/schema.sql` (e o limite `13` das verificações).
