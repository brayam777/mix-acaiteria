# Mix Açaiteria — implantação

Cardápio + pedidos + caixa. HTML + JS puro (sem build), igual à hamburgueria, mas num **projeto Supabase
próprio da Mix**: `lezmpssydxuhxoqlwtoc` (conta brayamfelipe02 mix). Nada aqui depende do banco do Anotei Aí/Cypri.

## Status (08/10/2026)

- [x] Migração `supabase/migrations/20261008000000_acai_init.sql` aplicada
- [x] Seed `supabase/seed_mix.sql` aplicado (loja `mix`, 16 produtos, 48 adicionais)
- [x] `js/supabase-config.js` apontando pro projeto da Mix (chave pública)
- [x] Pedido pelo WhatsApp do cliente (link wa.me, igual Descascaê) + número do dia — migração `20261008100000_order_number.sql` aplicada
- [ ] (Opcional) WhatsApp automático via uazapi — desligado, ver abaixo
- [x] Deploy na Vercel: projeto `mix-acaiteria` → https://mix-acaiteria.vercel.app (domínio próprio: pendente)
- [x] Deploy automático: todo `git push` na `main` de https://github.com/brayam777/mix-acaiteria publica sozinho na Vercel
- [ ] URL do site em Supabase → Authentication → URL Configuration
- [ ] Shirley criar a conta do painel com a chave de configuração

## Como o pedido chega no WhatsApp

O cliente finaliza o carrinho → o pedido é registrado (aparece no painel e no caixa, com número do dia #1, #2...) → o WhatsApp do cliente abre com a mensagem pronta pro número da loja (Configurações → "WhatsApp que recebe os pedidos"). Ele só toca em enviar. Se voltar sem enviar, a página do pedido tem o botão "Enviar pedido pelo WhatsApp".
O pedido entra como **"Novo pedido"** (o cliente pode desistir no WhatsApp). Quando a mensagem chega, a loja toca em **Aceitar** — só aí conta como venda no Caixa. Se não chegou, **"Não chegou"** (vira cancelado). Não aceitos até o dia seguinte são cancelados sozinhos de madrugada, e a impressora só imprime depois do aceite (migração `20261008200000_accept_before_sale.sql`).
No painel, cada pedido tem "💬 Avisar cliente": abre o WhatsApp da loja com a mensagem do status pronta.
As mensagens não usam emoji (o wa.me estraga emoji tipo 🛵 e vira "�").

## (Opcional) WhatsApp automático pela uazapi

Sem configurar, os pedidos funcionam normal, só não sai mensagem. Para ligar, no SQL Editor do projeto da Mix:

```sql
update acai_integrations set value = 'https://SUA-INSTANCIA.uazapi.com' where key = 'uazapi_base_url';
update acai_integrations set value = 'TOKEN-DA-INSTANCIA' where key = 'uazapi_token';
```

Pode ser a mesma instância do Anotei Aí ou uma da própria Mix. O número que recebe os pedidos é o
"WhatsApp que recebe os pedidos" no painel (já vem 62 98129-5475).

## Deploy e domínio

1. Suba a pasta num projeto Vercel novo (o `.vercelignore` já tira `supabase/`, `referencias/` etc.).
2. Domínio — escolha um:
   - **Domínio próprio** (ex.: `mixacaiteria.com.br`): adicione no Vercel e em `js/store.js` →
     `CUSTOM_DOMAINS = { 'mixacaiteria.com.br': 'mix', 'www.mixacaiteria.com.br': 'mix' }`.
   - **Sem domínio**: `https://<projeto>.vercel.app/?loja=mix` (o `?loja=mix` fica lembrado no aparelho;
     e se faltar, a loja padrão já é `mix`).
   - Subdomínio do Anotei Aí (`mix.acai.anoteiai.com.br`) só se você quiser — o wildcard
     `*.anoteiai.com.br` é do projeto da Cypri, então precisaria cadastrar o subdomínio exato no Vercel da Mix.
3. Supabase → Authentication → URL Configuration: coloque a URL final em **Site URL** e em
   **Redirect URLs** (`https://SEU-DOMINIO/admin.html`) — senão o e-mail de confirmação/recuperação de
   senha volta pro lugar errado.

## Entregar pra loja

- Link do painel: `https://SEU-DOMINIO/admin.html` → **Criar conta** → e-mail/senha dela + a chave de
  configuração. Pegar a chave no SQL Editor:
  ```sql
  select admin_setup_key from acai_store_secrets s join acai_stores st on st.id = s.store_id where st.slug = 'mix';
  ```
- Pedir pra ela conferir: **horário de funcionamento** (veio 14h–22h todo dia), endereço de retirada e o
  preço do **Monte do seu jeito** (entra indisponível, com preço provisório).

## Outra açaiteria no mesmo banco (se um dia quiser)

```sql
select * from create_acai_store('slug-da-loja', 'Nome da Açaiteria');
```

## Como o preço funciona (pra explicar pro lojista)

- Produto tem preço por **tamanho**. Adicionais ficam em **grupos** (Frutas, Adicionais, Caldas...) ligados a
  cada produto, com **quantos saem grátis**, mínimo e máximo. Passou da cota, cobra o preço do adicional.
  Cota/máximo e preço do adicional podem variar por tamanho.
- O servidor recalcula tudo (`create_acai_order`) — o navegador só mostra.

## Rodar local

```
node serve.cjs
```

Abre `http://localhost:8087/?loja=mix` (usa o banco real da Mix).

## Continuar em outro computador

Precisa de: Git, Node.js 18+, [Supabase CLI](https://supabase.com/docs/guides/cli) e (opcional) GitHub CLI.

```
git clone https://github.com/brayam777/mix-acaiteria.git
cd mix-acaiteria
supabase login
supabase link --project-ref lezmpssydxuhxoqlwtoc
cd tests && npm install && npm test
```

- Publicar: `git push` (a Vercel publica sozinha). Não precisa da Vercel CLI.
- Mudança no banco: nova migração em `supabase/migrations/` → `npm test` → `supabase db query --linked -f <arquivo>`.
- Contexto completo pro Claude Code: `CLAUDE.md` (ele lê sozinho ao abrir a pasta).
