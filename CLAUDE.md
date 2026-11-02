# Mix Açaiteria — contexto do projeto

Cardápio digital + pedidos pelo WhatsApp + painel da loja + controle de caixa para a **Mix Açaiteria**
(Shirley, Mara Rosa-GO). Feito no molde do "Anotei Aí" da Cypri Burguer, mas com projeto Supabase e deploy
**próprios** — não depende de nada da Cypri. Status, implantação e passo a passo da loja: `NOVO_CLIENTE.md`.

## Onde está cada coisa (produção)

- Site: https://mix-acaiteria.vercel.app (painel em `/admin.html`) — projeto Vercel `mix-acaiteria`, conta `brayam777`.
- **Deploy automático**: `git push` na `main` de https://github.com/brayam777/mix-acaiteria publica sozinho.
- Banco: Supabase **`lezmpssydxuhxoqlwtoc`** (conta "brayamfelipe02 mix"). NUNCA o projeto da Cypri/Anotei Aí
  (`xuwkyxxyxnbsdnsjbkze`). URL e chave **pública** em `js/supabase-config.js`.
- Mudança de banco NÃO vai com o push. Criar `supabase/migrations/<timestamp>_nome.sql` e aplicar:
  `supabase link --project-ref lezmpssydxuhxoqlwtoc` (uma vez por máquina) e
  `supabase db query --linked -f supabase/migrations/<arquivo>.sql`. Não usar `supabase db push`
  (o histórico de migrações do projeto não foi gravado pela CLI). Rodar os testes antes.

## Stack e convenções

- HTML + ES modules puros, sem build, sem npm no site. Supabase via `https://esm.sh/@supabase/supabase-js@2`.
- Comentários e textos em português. HTML montado com template string **sempre** passando por `esc()` (`js/escape.js`).
- Tabelas/funções prefixadas `acai_`, multi-loja por `store_id` (loja atual = slug: `?loja=mix`, padrão `mix`; ver `js/store.js`).
- RLS: público só lê catálogo/config; escrita só `acai_is_store_admin(store_id)`. Pedido só entra por
  `create_acai_order` (security definer), que **recalcula tudo** no servidor.
- Funções internas têm `revoke ... from public, anon, authenticated` no fim da migração — manter isso em funções novas.

## Regras de negócio (importantes)

- **Preço** (`acai_price_item` no SQL = `js/pricing.js` no navegador — mudar os DOIS juntos): preço do tamanho +
  adicionais; em cada grupo ligado ao produto (`acai_product_addon_groups`) os N mais caros escolhidos saem grátis
  (N = `free_quantity`, pode variar por tamanho em `size_overrides`); o resto cobra. Preço do adicional pode variar
  por tamanho (`acai_addon_size_prices`).
- **Pedido pelo WhatsApp** (igual ao projeto Descascaê): checkout registra o pedido (número do dia #1, #2... via
  trigger) e abre `wa.me` do cliente com a mensagem pronta pro WhatsApp da loja (`js/whatsapp.js`). Sem emoji fora
  do básico nas mensagens — o redirecionamento do wa.me troca por "�".
- **Aceite antes da venda**: pedido nasce `received`; só conta no Caixa depois que a loja toca **Aceitar**
  (`preparing`). `received` esquecido vira `cancelled` de madrugada (`acai_close_stale_orders`, pg_cron).
  Comanda da impressora só sai depois do aceite.
- WhatsApp automático pela uazapi existe no banco mas está **desligado** (tabela `acai_integrations` vazia).
- Frete: `delivery_fee_mode` = `gratis` (Mix: entrega grátis em Mara Rosa) ou `fixo`.

## Testes (rodar antes de aplicar migração ou mexer em preço/pedido/caixa)

```
cd tests
npm install
npm test          # banco em memória (PGlite) + stubs do Supabase: preço SQL x JS, pedido, aceite, caixa, permissões
npm run mock      # site com Supabase falso em http://localhost:8099/?loja=mix (painel: shirley@teste.com, qualquer senha)
```

`npm test` aplica TODAS as migrações de `supabase/migrations/` em ordem + `supabase/seed_mix.sql`.
`node serve.cjs` (raiz) roda o site local contra o banco REAL em http://localhost:8087/?loja=mix.

## Pendências (ver `NOVO_CLIENTE.md`)

- Supabase → Authentication → URL Configuration com a URL do site; "Confirm email" desligado.
- Dono do painel hoje é `brayamfelipe02@gmail.com` → trocar pra Shirley na entrega (`acai_admins`).
- Shirley preencher: horário (veio 14h–22h), endereço de retirada, preço do "Monte do seu jeito" (indisponível), fotos
  (só 4 produtos têm foto, recortadas das artes em `referencias/`, servidas de `img/produtos/`).
- Domínio próprio (opcional): `CUSTOM_DOMAINS` em `js/store.js` + Vercel + URL no Supabase Auth.
