import { supabase, isConfigured, SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase-config.js';
import { DAY_LABELS } from './business-hours.js';
import { anoteaiMarkSvg } from './branding.js';
import { normalizeBrazilPhone, PHONE_FORMAT_HINT } from './phone.js';
import { getStoreId } from './store.js';
import { loadCatalog } from './catalog.js';
import { currency } from './pricing.js';
import { esc } from './escape.js';

// Loja deste painel (sai do endereço — ver store.js). Todo dado lido/gravado
// aqui é filtrado por ela; a RLS garante o mesmo no banco.
const STORE_ID = await getStoreId();

const adminBrandMark = document.getElementById('adminBrandMark');
if (adminBrandMark) adminBrandMark.innerHTML = anoteaiMarkSvg(28);

const loginView = document.getElementById('loginView');
const panelView = document.getElementById('panelView');
const logoutBtn = document.getElementById('logoutBtn');

function showMessage(el, text, isError = false) {
  el.textContent = text;
  el.classList.toggle('error', isError);
}

const numOrNull = (v) => (v === '' || v === null || v === undefined ? null : Number(v));

// ---------------- Tabs ----------------
// As outras telas (pedidos, caixa) escutam 'admin:tab' pra carregar só quando abrem.
document.querySelectorAll('.admin-tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    document.querySelectorAll('.admin-tab-btn').forEach((b) => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.admin-tab-panel').forEach((p) => {
      p.hidden = p.id !== `tab${tab.charAt(0).toUpperCase()}${tab.slice(1)}`;
    });
    if (tab === 'settings') startPrintStatusPolling();
    window.dispatchEvent(new CustomEvent('admin:tab', { detail: tab }));
  });
});

// ---------------- Auth ----------------
// Cada loja tem UM admin, criado pelo próprio lojista com e-mail/senha + a
// chave de configuração da loja (acai_store_secrets). O Supabase Auth é o
// mesmo do Anotei Aí; o que dá acesso é o vínculo em acai_admins.
const loginForm = document.getElementById('loginForm');
const loginMessage = document.getElementById('loginMessage');
const signupForm = document.getElementById('signupForm');
const signupMessage = document.getElementById('signupMessage');
const forgotForm = document.getElementById('forgotForm');
const forgotMessage = document.getElementById('forgotMessage');
const resetForm = document.getElementById('resetForm');
const resetMessage = document.getElementById('resetMessage');
const claimForm = document.getElementById('claimForm');
const claimMessage = document.getElementById('claimMessage');

const authViews = {
  login: document.getElementById('authLogin'),
  signup: document.getElementById('authSignup'),
  forgot: document.getElementById('authForgot'),
  reset: document.getElementById('authReset'),
  claimPending: document.getElementById('authClaimPending'),
  denied: document.getElementById('authDenied'),
};

function showAuthView(name) {
  for (const key in authViews) authViews[key].hidden = key !== name;
}

// Guarda a chave quando o cadastro exige confirmar o e-mail (sem sessão
// imediata) — usada sozinha assim que a pessoa entrar depois de confirmar.
const PENDING_SETUP_KEY_STORAGE = 'acai_pending_admin_setup_key';

const CLAIM_ERRORS = {
  not_authenticated: 'Sessão inválida. Tente entrar de novo.',
  admin_already_claimed: 'Essa loja já tem uma conta configurada. Se você é o dono, use "Esqueci minha senha".',
  invalid_setup_key: 'Chave de configuração incorreta.',
};

function friendlyClaimError(rawMessage) {
  const key = Object.keys(CLAIM_ERRORS).find((k) => (rawMessage || '').includes(k));
  return key ? CLAIM_ERRORS[key] : 'Não foi possível liberar o acesso. Tente novamente.';
}

async function attemptClaim(setupKey) {
  const { error } = await supabase.rpc('claim_acai_admin', { p_store_id: STORE_ID, p_setup_key: setupKey });
  return error;
}

async function isAdminAlreadyClaimed() {
  const { data, error } = await supabase.rpc('acai_admin_claimed', { p_store_id: STORE_ID });
  return error ? true : data === true;
}

async function handleLogin(e) {
  e.preventDefault();
  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;
  showMessage(loginMessage, 'Entrando...');
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    showMessage(loginMessage, 'E-mail ou senha incorretos.', true);
    return;
  }
  loginForm.reset();
}

async function handleSignup(e) {
  e.preventDefault();
  const email = document.getElementById('signupEmail').value.trim();
  const password = document.getElementById('signupPassword').value;
  const passwordConfirm = document.getElementById('signupPasswordConfirm').value;
  const setupKey = document.getElementById('signupSetupKey').value.trim();

  if (password !== passwordConfirm) {
    showMessage(signupMessage, 'As senhas não são iguais.', true);
    return;
  }

  showMessage(signupMessage, 'Criando conta...');
  const emailRedirectTo = window.location.href.split('#')[0];
  const { data, error } = await supabase.auth.signUp({ email, password, options: { emailRedirectTo } });
  if (error) {
    showMessage(
      signupMessage,
      error.message.includes('already registered') ? 'Já existe uma conta com esse e-mail.' : `Não foi possível criar a conta: ${error.message}`,
      true
    );
    return;
  }

  if (data.session) {
    const claimError = await attemptClaim(setupKey);
    if (claimError) {
      showMessage(signupMessage, friendlyClaimError(claimError.message), true);
      return;
    }
    signupForm.reset();
    await renderForSession(data.session);
  } else {
    localStorage.setItem(PENDING_SETUP_KEY_STORAGE, setupKey);
    showMessage(signupMessage, 'Conta criada! Confirme seu e-mail (chegou um link na caixa de entrada) e depois entre por aqui.');
    signupForm.reset();
  }
}

async function handleForgot(e) {
  e.preventDefault();
  const email = document.getElementById('forgotEmail').value.trim();
  showMessage(forgotMessage, 'Enviando...');
  const redirectTo = window.location.href.split('#')[0];
  const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo });
  if (error) {
    showMessage(forgotMessage, 'Não foi possível enviar o link agora. Tente novamente.', true);
    return;
  }
  showMessage(forgotMessage, 'Se esse e-mail tiver uma conta, chegou um link de recuperação nele.');
  forgotForm.reset();
}

let inRecoveryMode = false;

async function handleReset(e) {
  e.preventDefault();
  const password = document.getElementById('resetPassword').value;
  const passwordConfirm = document.getElementById('resetPasswordConfirm').value;
  if (password !== passwordConfirm) {
    showMessage(resetMessage, 'As senhas não são iguais.', true);
    return;
  }
  showMessage(resetMessage, 'Salvando...');
  const { error } = await supabase.auth.updateUser({ password });
  if (error) {
    showMessage(resetMessage, 'Não foi possível salvar a nova senha. Peça um novo link e tente de novo.', true);
    return;
  }
  showMessage(resetMessage, 'Senha atualizada!');
  resetForm.reset();
  inRecoveryMode = false;
  const { data } = await supabase.auth.getSession();
  await renderForSession(data.session);
}

async function handleClaim(e) {
  e.preventDefault();
  const setupKey = document.getElementById('claimSetupKey').value.trim();
  showMessage(claimMessage, 'Verificando...');
  const claimError = await attemptClaim(setupKey);
  if (claimError) {
    showMessage(claimMessage, friendlyClaimError(claimError.message), true);
    return;
  }
  claimForm.reset();
  const { data } = await supabase.auth.getSession();
  await renderForSession(data.session);
}

async function handleLogout() {
  await supabase.auth.signOut();
}

let panelLoaded = false;

async function renderForSession(session) {
  if (inRecoveryMode) return;

  if (!session) {
    panelLoaded = false;
    loginView.hidden = false;
    panelView.hidden = true;
    showAuthView('login');
    document.getElementById('showSignupBtn').hidden = await isAdminAlreadyClaimed();
    return;
  }

  const { data: adminRow } = await supabase
    .from('acai_admins')
    .select('user_id')
    .eq('user_id', session.user.id)
    .eq('store_id', STORE_ID)
    .maybeSingle();

  if (adminRow) {
    loginView.hidden = true;
    panelView.hidden = false;
    if (!panelLoaded) {
      panelLoaded = true;
      await Promise.all([loadCatalogAdmin(), loadSettings(), loadBusinessHours()]);
      window.dispatchEvent(new CustomEvent('admin:ready'));
    }
    return;
  }

  // Autenticado, mas ainda não é o admin desta loja.
  loginView.hidden = false;
  panelView.hidden = true;

  const pendingKey = localStorage.getItem(PENDING_SETUP_KEY_STORAGE);
  if (pendingKey) {
    localStorage.removeItem(PENDING_SETUP_KEY_STORAGE);
    const claimError = await attemptClaim(pendingKey);
    if (!claimError) {
      await renderForSession(session);
      return;
    }
  }

  showAuthView((await isAdminAlreadyClaimed()) ? 'denied' : 'claimPending');
}

// =====================================================================
// Cardápio
// =====================================================================
const catalogMessage = document.getElementById('catalogMessage');
let cat = null; // resultado de loadCatalog (tudo, inclusive indisponível)

async function loadCatalogAdmin() {
  try {
    cat = await loadCatalog(STORE_ID, { onlyAvailable: false });
  } catch (err) {
    console.error(err);
    showMessage(catalogMessage, 'Não foi possível carregar o cardápio.', true);
    return;
  }
  renderCategoryList();
  renderSizeList();
  renderProductCategoryOptions();
  renderProductList();
  renderGroupList();
  if (!productEditor.hidden) {
    const id = editingProductId.value;
    renderProductSizesEditor(id ? cat.sizesByProduct.get(id) || [] : []);
    renderProductGroupsEditor(id ? cat.linksByProduct.get(id) || [] : []);
  }
}

function saved(text = 'Salvo!') {
  showMessage(catalogMessage, text);
  clearTimeout(saved.t);
  saved.t = setTimeout(() => showMessage(catalogMessage, ''), 2500);
}

function failed(prefix, error) {
  console.error(prefix, error);
  showMessage(catalogMessage, `${prefix}: ${error?.message || 'erro desconhecido'}`, true);
}

// ---------------- Categorias ----------------
const categoryForm = document.getElementById('categoryForm');
const categoryList = document.getElementById('categoryList');
const editingCategoryId = document.getElementById('editingCategoryId');
const categoryFormSubmit = document.getElementById('categoryFormSubmit');
const cancelCategoryEditBtn = document.getElementById('cancelCategoryEditBtn');
const productCategorySelect = document.getElementById('productCategory');

function renderCategoryList() {
  if (cat.categories.length === 0) {
    categoryList.innerHTML = '<p class="admin-list-empty">Nenhuma categoria cadastrada.</p>';
    return;
  }
  categoryList.innerHTML = cat.categories
    .map(
      (c) => `
      <div class="admin-list-item admin-list-item-compact">
        <span class="admin-list-name" style="flex:1">${esc(c.name)}</span>
        <button class="toggle-pill ${c.is_active ? 'on' : 'off'}" data-toggle-category="${esc(c.id)}">${c.is_active ? 'Ativa' : 'Oculta'}</button>
        <div class="admin-list-item-actions">
          <button class="admin-list-edit" data-edit-category="${esc(c.id)}">Editar</button>
          <button class="admin-list-delete" data-delete-category="${esc(c.id)}">Remover</button>
        </div>
      </div>`
    )
    .join('');
}

function renderProductCategoryOptions() {
  const current = productCategorySelect.value;
  productCategorySelect.innerHTML =
    '<option value="">Sem categoria</option>' + cat.categories.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
  productCategorySelect.value = current;
}

function exitCategoryEdit() {
  editingCategoryId.value = '';
  categoryForm.reset();
  categoryFormSubmit.textContent = 'Adicionar';
  cancelCategoryEditBtn.hidden = true;
}

categoryForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = editingCategoryId.value;
  const name = document.getElementById('categoryName').value.trim();
  if (!name) return;
  const { error } = id
    ? await supabase.from('acai_categories').update({ name }).eq('id', id)
    : await supabase.from('acai_categories').insert({ store_id: STORE_ID, name, sort_order: cat.categories.length });
  if (error) return failed('Não foi possível salvar a categoria', error);
  exitCategoryEdit();
  saved('Categoria salva!');
  loadCatalogAdmin();
});

cancelCategoryEditBtn.addEventListener('click', exitCategoryEdit);

categoryList.addEventListener('click', async (e) => {
  const editBtn = e.target.closest('[data-edit-category]');
  const deleteBtn = e.target.closest('[data-delete-category]');
  const toggleBtn = e.target.closest('[data-toggle-category]');
  if (editBtn) {
    const c = cat.categories.find((x) => x.id === editBtn.dataset.editCategory);
    if (!c) return;
    editingCategoryId.value = c.id;
    document.getElementById('categoryName').value = c.name;
    categoryFormSubmit.textContent = 'Salvar';
    cancelCategoryEditBtn.hidden = false;
  } else if (toggleBtn) {
    const c = cat.categories.find((x) => x.id === toggleBtn.dataset.toggleCategory);
    const { error } = await supabase.from('acai_categories').update({ is_active: !c.is_active }).eq('id', c.id);
    if (error) return failed('Não foi possível alterar a categoria', error);
    loadCatalogAdmin();
  } else if (deleteBtn) {
    if (!confirm('Remover esta categoria? Os produtos dela ficam sem categoria.')) return;
    const { error } = await supabase.from('acai_categories').delete().eq('id', deleteBtn.dataset.deleteCategory);
    if (error) return failed('Não foi possível remover a categoria', error);
    loadCatalogAdmin();
  }
});

// ---------------- Tamanhos ----------------
const sizeForm = document.getElementById('sizeForm');
const sizeList = document.getElementById('sizeList');
const editingSizeId = document.getElementById('editingSizeId');
const sizeFormSubmit = document.getElementById('sizeFormSubmit');
const cancelSizeEditBtn = document.getElementById('cancelSizeEditBtn');

function renderSizeList() {
  if (cat.sizes.length === 0) {
    sizeList.innerHTML = '<p class="admin-list-empty">Nenhum tamanho cadastrado.</p>';
    return;
  }
  sizeList.innerHTML = cat.sizes
    .map(
      (s) => `
      <div class="admin-list-item admin-list-item-compact">
        <span class="admin-list-name" style="flex:1">${esc(s.name)}</span>
        <div class="admin-list-item-actions">
          <button class="admin-list-edit" data-edit-size="${esc(s.id)}">Editar</button>
          <button class="admin-list-delete" data-delete-size="${esc(s.id)}">Remover</button>
        </div>
      </div>`
    )
    .join('');
}

function exitSizeEdit() {
  editingSizeId.value = '';
  sizeForm.reset();
  sizeFormSubmit.textContent = 'Adicionar';
  cancelSizeEditBtn.hidden = true;
}

sizeForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = editingSizeId.value;
  const name = document.getElementById('sizeName').value.trim();
  if (!name) return;
  const { error } = id
    ? await supabase.from('acai_sizes').update({ name }).eq('id', id)
    : await supabase.from('acai_sizes').insert({ store_id: STORE_ID, name, sort_order: cat.sizes.length });
  if (error) return failed('Não foi possível salvar o tamanho', error);
  exitSizeEdit();
  saved('Tamanho salvo!');
  loadCatalogAdmin();
});

cancelSizeEditBtn.addEventListener('click', exitSizeEdit);

sizeList.addEventListener('click', async (e) => {
  const editBtn = e.target.closest('[data-edit-size]');
  const deleteBtn = e.target.closest('[data-delete-size]');
  if (editBtn) {
    const s = cat.sizes.find((x) => x.id === editBtn.dataset.editSize);
    editingSizeId.value = s.id;
    document.getElementById('sizeName').value = s.name;
    sizeFormSubmit.textContent = 'Salvar';
    cancelSizeEditBtn.hidden = false;
  } else if (deleteBtn) {
    if (!confirm('Remover este tamanho? Ele sai de TODOS os produtos que usam ele.')) return;
    const { error } = await supabase.from('acai_sizes').delete().eq('id', deleteBtn.dataset.deleteSize);
    if (error) return failed('Não foi possível remover o tamanho', error);
    loadCatalogAdmin();
  }
});

// ---------------- Produtos ----------------
const productList = document.getElementById('productList');
const productEditor = document.getElementById('productEditor');
const productForm = document.getElementById('productForm');
const editingProductId = document.getElementById('editingProductId');
const productFormTitle = document.getElementById('productFormTitle');
const mediaPreview = document.getElementById('mediaPreview');
const productSizesEditor = document.getElementById('productSizesEditor');
const productGroupsEditor = document.getElementById('productGroupsEditor');
const productSinglePriceRow = document.getElementById('productSinglePriceRow');

let editingImageUrl = null;

function productPriceSummary(p) {
  const sizes = cat.sizesByProduct.get(p.id) || [];
  if (!sizes.length) return currency(p.price);
  return sizes.map((s) => `${esc(s.name)} ${currency(s.price)}${s.is_available ? '' : ' (indisp.)'}`).join(' · ');
}

function renderProductList() {
  if (cat.products.length === 0) {
    productList.innerHTML = '<p class="admin-list-empty">Nenhum produto cadastrado ainda.</p>';
    return;
  }
  const catName = new Map(cat.categories.map((c) => [c.id, c.name]));
  productList.innerHTML = cat.products
    .map(
      (p) => `
      <div class="admin-list-item" data-id="${esc(p.id)}">
        ${p.image_url ? `<img class="admin-list-thumb" src="${esc(p.image_url)}" alt="" />` : '<span class="admin-list-thumb">🍇</span>'}
        <div class="admin-list-info">
          <div class="admin-list-name">${esc(p.name)}${p.is_new ? ' <small>· NOVO</small>' : ''}</div>
          <div class="admin-list-meta">${p.category_id ? esc(catName.get(p.category_id) || '') + ' · ' : ''}${productPriceSummary(p)}</div>
        </div>
        <button class="toggle-pill ${p.is_available ? 'on' : 'off'}" data-toggle-product="${esc(p.id)}">${p.is_available ? 'No cardápio' : 'Indisponível'}</button>
        <button class="admin-list-delete" data-delete-product="${esc(p.id)}">Remover</button>
      </div>`
    )
    .join('');
}

function renderProductSizesEditor(productSizes) {
  const bySize = new Map(productSizes.map((s) => [s.size_id, s]));
  if (cat.sizes.length === 0) {
    productSizesEditor.innerHTML = '<p class="admin-list-empty">Cadastre tamanhos (lá embaixo) pra usar preço por tamanho.</p>';
  } else {
    productSizesEditor.innerHTML = cat.sizes
      .map((s) => {
        const ps = bySize.get(s.id);
        return `
        <div class="size-price-row">
          <label><input type="checkbox" data-size-on="${esc(s.id)}" ${ps ? 'checked' : ''} /> ${esc(s.name)}
            ${ps && !ps.is_available ? '<small>(indisponível)</small>' : ''}</label>
          <input type="number" min="0" step="0.01" inputmode="decimal" placeholder="R$" data-size-price="${esc(s.id)}" value="${ps ? esc(ps.price) : ''}" ${ps ? '' : 'disabled'} />
        </div>`;
      })
      .join('');
  }
  updateSinglePriceVisibility();
}

function updateSinglePriceVisibility() {
  const anySize = productSizesEditor.querySelector('[data-size-on]:checked');
  productSinglePriceRow.hidden = !!anySize;
}

productSizesEditor.addEventListener('change', (e) => {
  const sizeId = e.target.dataset.sizeOn;
  if (!sizeId) return;
  const priceInput = productSizesEditor.querySelector(`[data-size-price="${sizeId}"]`);
  priceInput.disabled = !e.target.checked;
  if (e.target.checked) priceInput.focus();
  updateSinglePriceVisibility();
});

function renderProductGroupsEditor(links) {
  const byGroup = new Map(links.map((l) => [l.group_id, l]));
  if (cat.groups.length === 0) {
    productGroupsEditor.innerHTML = '<p class="admin-list-empty">Crie grupos de adicionais (abaixo) pra ligar a este produto.</p>';
    return;
  }
  productGroupsEditor.innerHTML = cat.groups
    .map((g) => {
      const l = byGroup.get(g.id);
      const on = !!l;
      const count = (cat.addonsByGroup.get(g.id) || []).length;
      const overrides = (l && l.size_overrides) || {};
      return `
      <div class="group-link ${on ? 'is-on' : ''}" data-group-link="${esc(g.id)}">
        <label class="group-link-head">
          <input type="checkbox" data-link-on ${on ? 'checked' : ''} />
          ${esc(g.name)} <small>(${count} ${count === 1 ? 'item' : 'itens'})</small>
        </label>
        <div class="group-link-rules" ${on ? '' : 'hidden'}>
          <label>Grátis<input type="number" min="0" step="1" data-link-free value="${esc(l?.free_quantity ?? 0)}" /></label>
          <label>Mín.<input type="number" min="0" step="1" data-link-min value="${esc(l?.min_select ?? 0)}" /></label>
          <label>Máx.<input type="number" min="0" step="1" data-link-max placeholder="sem limite" value="${esc(l?.max_select ?? '')}" /></label>
          <label>Ordem<input type="number" step="1" data-link-sort value="${esc(l?.sort_order ?? g.sort_order)}" /></label>
        </div>
        ${
          cat.sizes.length
            ? `<details class="group-link-overrides" ${on ? '' : 'hidden'} ${Object.keys(overrides).length ? 'open' : ''}>
                <summary>Grátis/máximo diferente por tamanho (opcional)</summary>
                ${cat.sizes
                  .map(
                    (s) => `
                  <div class="override-row" data-override-size="${esc(s.id)}">
                    <span>${esc(s.name)}</span>
                    <input type="number" min="0" step="1" placeholder="grátis: padrão" data-ov-free value="${esc(overrides[s.id]?.free_quantity ?? '')}" />
                    <input type="number" min="0" step="1" placeholder="máx.: padrão" data-ov-max value="${esc(overrides[s.id]?.max_select ?? '')}" />
                  </div>`
                  )
                  .join('')}
              </details>`
            : ''
        }
      </div>`;
    })
    .join('');
}

productGroupsEditor.addEventListener('change', (e) => {
  if (!e.target.matches('[data-link-on]')) return;
  const box = e.target.closest('[data-group-link]');
  box.classList.toggle('is-on', e.target.checked);
  box.querySelector('.group-link-rules').hidden = !e.target.checked;
  const ov = box.querySelector('.group-link-overrides');
  if (ov) ov.hidden = !e.target.checked;
});

function openProductEditor(product) {
  productEditor.hidden = false;
  productForm.reset();
  editingProductId.value = product?.id || '';
  editingImageUrl = product?.image_url || null;
  productFormTitle.textContent = product ? `Editar: ${product.name}` : 'Novo produto';
  document.getElementById('productName').value = product?.name || '';
  document.getElementById('productDescription').value = product?.description || '';
  document.getElementById('productCategory').value = product?.category_id || '';
  document.getElementById('productPrice').value = product ? product.price : '';
  document.getElementById('productAvailable').checked = product ? product.is_available : true;
  document.getElementById('productIsNew').checked = product ? product.is_new : false;
  mediaPreview.hidden = !editingImageUrl;
  mediaPreview.innerHTML = editingImageUrl ? `<img src="${esc(editingImageUrl)}" alt="" />` : '';
  renderProductSizesEditor(product ? cat.sizesByProduct.get(product.id) || [] : []);
  renderProductGroupsEditor(product ? cat.linksByProduct.get(product.id) || [] : []);
  productEditor.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function closeProductEditor() {
  productEditor.hidden = true;
  editingProductId.value = '';
  editingImageUrl = null;
}

document.getElementById('newProductBtn').addEventListener('click', () => openProductEditor(null));
document.getElementById('cancelProductEditBtn').addEventListener('click', closeProductEditor);

function readSizeRows() {
  const rows = [];
  for (const box of productSizesEditor.querySelectorAll('[data-size-on]:checked')) {
    const sizeId = box.dataset.sizeOn;
    const price = parseFloat(productSizesEditor.querySelector(`[data-size-price="${sizeId}"]`).value);
    rows.push({ size_id: sizeId, price });
  }
  return rows;
}

function readLinkRows() {
  const rows = [];
  for (const box of productGroupsEditor.querySelectorAll('[data-group-link]')) {
    if (!box.querySelector('[data-link-on]').checked) continue;
    const size_overrides = {};
    for (const row of box.querySelectorAll('[data-override-size]')) {
      const free = row.querySelector('[data-ov-free]').value;
      const max = row.querySelector('[data-ov-max]').value;
      if (free === '' && max === '') continue;
      size_overrides[row.dataset.overrideSize] = {
        ...(free !== '' ? { free_quantity: Number(free) } : {}),
        ...(max !== '' ? { max_select: Number(max) } : {}),
      };
    }
    rows.push({
      group_id: box.dataset.groupLink,
      free_quantity: Number(box.querySelector('[data-link-free]').value) || 0,
      min_select: Number(box.querySelector('[data-link-min]').value) || 0,
      max_select: numOrNull(box.querySelector('[data-link-max]').value),
      sort_order: Number(box.querySelector('[data-link-sort]').value) || 0,
      size_overrides,
    });
  }
  return rows;
}

productForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = editingProductId.value;
  const sizeRows = readSizeRows();
  const linkRows = readLinkRows();

  if (sizeRows.some((r) => isNaN(r.price) || r.price < 0)) {
    showMessage(catalogMessage, 'Preencha o preço de todos os tamanhos marcados.', true);
    return;
  }
  const singlePrice = parseFloat(document.getElementById('productPrice').value);
  if (!sizeRows.length && (isNaN(singlePrice) || singlePrice < 0)) {
    showMessage(catalogMessage, 'Informe o preço único ou marque pelo menos um tamanho.', true);
    return;
  }
  const badLink = linkRows.find((l) => l.max_select !== null && l.max_select < l.min_select);
  if (badLink) {
    showMessage(catalogMessage, 'Em algum grupo o máximo ficou menor que o mínimo.', true);
    return;
  }

  showMessage(catalogMessage, 'Salvando...');

  let image_url = editingImageUrl;
  const file = document.getElementById('productImage').files[0];
  if (file) {
    const ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
    const path = `${STORE_ID}/${crypto.randomUUID()}.${ext}`;
    const { error: uploadError } = await supabase.storage.from('acai-products').upload(path, file);
    if (uploadError) return failed('Não foi possível enviar a foto', uploadError);
    image_url = supabase.storage.from('acai-products').getPublicUrl(path).data.publicUrl;
  }

  const payload = {
    name: document.getElementById('productName').value.trim(),
    description: document.getElementById('productDescription').value.trim() || null,
    category_id: document.getElementById('productCategory').value || null,
    price: sizeRows.length ? (isNaN(singlePrice) ? 0 : singlePrice) : singlePrice,
    is_available: document.getElementById('productAvailable').checked,
    is_new: document.getElementById('productIsNew').checked,
    image_url,
  };

  const { data: product, error } = id
    ? await supabase.from('acai_products').update(payload).eq('id', id).select().single()
    : await supabase.from('acai_products').insert({ ...payload, store_id: STORE_ID, sort_order: cat.products.length }).select().single();
  if (error) return failed('Não foi possível salvar o produto', error);

  // Tamanhos e grupos: troca a lista inteira (o que foi desmarcado sai).
  // Mantém o "indisponível" de tamanhos que continuam marcados.
  const prevSizes = new Map((cat.sizesByProduct.get(product.id) || []).map((s) => [s.size_id, s]));
  const { error: delSizesError } = await supabase.from('acai_product_sizes').delete().eq('product_id', product.id);
  if (delSizesError) return failed('Não foi possível salvar os tamanhos', delSizesError);
  if (sizeRows.length) {
    const { error: sizesError } = await supabase.from('acai_product_sizes').insert(
      sizeRows.map((r) => ({
        product_id: product.id,
        size_id: r.size_id,
        store_id: STORE_ID,
        price: r.price,
        is_available: prevSizes.get(r.size_id)?.is_available ?? true,
      }))
    );
    if (sizesError) return failed('Não foi possível salvar os tamanhos', sizesError);
  }

  const { error: delLinksError } = await supabase.from('acai_product_addon_groups').delete().eq('product_id', product.id);
  if (delLinksError) return failed('Não foi possível salvar os adicionais', delLinksError);
  if (linkRows.length) {
    const { error: linksError } = await supabase
      .from('acai_product_addon_groups')
      .insert(linkRows.map((r) => ({ ...r, product_id: product.id, store_id: STORE_ID })));
    if (linksError) return failed('Não foi possível salvar os adicionais', linksError);
  }

  saved(id ? 'Produto atualizado!' : 'Produto criado!');
  editingProductId.value = product.id;
  editingImageUrl = product.image_url;
  productFormTitle.textContent = `Editar: ${product.name}`;
  await loadCatalogAdmin();
});

productList.addEventListener('click', async (e) => {
  const deleteBtn = e.target.closest('[data-delete-product]');
  const toggleBtn = e.target.closest('[data-toggle-product]');
  if (deleteBtn) {
    if (!confirm('Remover este produto do cardápio? (Pra só esconder, use "Indisponível".)')) return;
    const { error } = await supabase.from('acai_products').delete().eq('id', deleteBtn.dataset.deleteProduct);
    if (error) return failed('Não foi possível remover o produto', error);
    if (editingProductId.value === deleteBtn.dataset.deleteProduct) closeProductEditor();
    loadCatalogAdmin();
    return;
  }
  if (toggleBtn) {
    const p = cat.products.find((x) => x.id === toggleBtn.dataset.toggleProduct);
    const { error } = await supabase.from('acai_products').update({ is_available: !p.is_available }).eq('id', p.id);
    if (error) return failed('Não foi possível alterar o produto', error);
    saved(p.is_available ? 'Produto escondido do cardápio.' : 'Produto de volta no cardápio!');
    loadCatalogAdmin();
    return;
  }
  const item = e.target.closest('.admin-list-item');
  const product = item && cat.products.find((p) => p.id === item.dataset.id);
  if (product) openProductEditor(product);
});

// ---------------- Grupos de adicionais ----------------
const groupForm = document.getElementById('groupForm');
const groupList = document.getElementById('groupList');

function usageCount(groupId) {
  let n = 0;
  for (const links of cat.linksByProduct.values()) if (links.some((l) => l.group_id === groupId)) n++;
  return n;
}

function renderGroupList() {
  if (cat.groups.length === 0) {
    groupList.innerHTML = '<p class="admin-list-empty">Nenhum grupo ainda.</p>';
    return;
  }
  groupList.innerHTML = cat.groups
    .map((g) => {
      const addons = cat.addonsByGroup.get(g.id) || [];
      const used = usageCount(g.id);
      return `
      <div class="addon-group-card" data-group="${esc(g.id)}">
        <div class="addon-group-header">
          <h3>${esc(g.name)} <small class="admin-list-meta">· usado em ${used} produto${used === 1 ? '' : 's'}</small></h3>
          <button type="button" class="link-btn" data-rename-group>Renomear</button>
          <button type="button" class="link-btn danger" data-delete-group>Excluir grupo</button>
        </div>
        ${addons
          .map(
            (a) => `
          <div class="addon-row ${a.is_available ? '' : 'is-off'}" data-addon="${esc(a.id)}">
            <span class="addon-name">${esc(a.name)}</span>
            <input class="addon-price" type="number" min="0" step="0.01" inputmode="decimal" value="${esc(a.price)}" data-addon-price aria-label="Preço de ${esc(a.name)}" />
            <button type="button" class="toggle-pill ${a.is_available ? 'on' : 'off'}" data-toggle-addon>${a.is_available ? 'Disponível' : 'Em falta'}</button>
            ${cat.sizes.length ? '<button type="button" class="link-btn" data-show-size-prices>Preço por tamanho</button>' : ''}
            <button type="button" class="link-btn" data-rename-addon>Renomear</button>
            <button type="button" class="link-btn danger" data-delete-addon>Excluir</button>
            <div class="addon-size-prices" ${Object.keys(a.size_prices).length ? '' : 'hidden'}>
              ${cat.sizes
                .map(
                  (s) => `<label>${esc(s.name)} <input type="number" min="0" step="0.01" placeholder="padrão" data-addon-size-price="${esc(s.id)}" value="${esc(a.size_prices[s.id] ?? '')}" /></label>`
                )
                .join('')}
            </div>
          </div>`
          )
          .join('')}
        <form class="addon-add-form" data-add-addon>
          <input type="text" placeholder="Novo item (ex: Morango)" required data-new-addon-name />
          <input type="number" min="0" step="0.01" placeholder="R$" required data-new-addon-price />
          <button type="submit" class="btn btn-outline btn-sm">Adicionar item</button>
        </form>
      </div>`;
    })
    .join('');
}

groupForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = document.getElementById('groupName').value.trim();
  if (!name) return;
  const { error } = await supabase.from('acai_addon_groups').insert({ store_id: STORE_ID, name, sort_order: cat.groups.length });
  if (error) return failed('Não foi possível criar o grupo', error);
  groupForm.reset();
  saved('Grupo criado! Agora adicione os itens dele.');
  loadCatalogAdmin();
});

groupList.addEventListener('submit', async (e) => {
  const form = e.target.closest('[data-add-addon]');
  if (!form) return;
  e.preventDefault();
  const groupId = form.closest('[data-group]').dataset.group;
  const name = form.querySelector('[data-new-addon-name]').value.trim();
  const price = parseFloat(form.querySelector('[data-new-addon-price]').value);
  if (!name || isNaN(price)) return;
  const { error } = await supabase.from('acai_addons').insert({
    group_id: groupId,
    store_id: STORE_ID,
    name,
    price,
    sort_order: (cat.addonsByGroup.get(groupId) || []).length,
  });
  if (error) return failed('Não foi possível adicionar o item', error);
  saved('Item adicionado!');
  loadCatalogAdmin();
});

groupList.addEventListener('click', async (e) => {
  const groupEl = e.target.closest('[data-group]');
  if (!groupEl) return;
  const groupId = groupEl.dataset.group;
  const group = cat.groups.find((g) => g.id === groupId);
  const addonEl = e.target.closest('[data-addon]');
  const addon = addonEl && (cat.addonsByGroup.get(groupId) || []).find((a) => a.id === addonEl.dataset.addon);

  if (e.target.closest('[data-rename-group]')) {
    const name = prompt('Novo nome do grupo:', group.name);
    if (!name || !name.trim()) return;
    const { error } = await supabase.from('acai_addon_groups').update({ name: name.trim() }).eq('id', groupId);
    if (error) return failed('Não foi possível renomear', error);
    loadCatalogAdmin();
  } else if (e.target.closest('[data-delete-group]')) {
    const used = usageCount(groupId);
    if (!confirm(`Excluir o grupo "${group.name}" e todos os itens dele?${used ? ` Ele sai de ${used} produto(s).` : ''}`)) return;
    const { error } = await supabase.from('acai_addon_groups').delete().eq('id', groupId);
    if (error) return failed('Não foi possível excluir o grupo', error);
    loadCatalogAdmin();
  } else if (addon && e.target.closest('[data-toggle-addon]')) {
    const { error } = await supabase.from('acai_addons').update({ is_available: !addon.is_available }).eq('id', addon.id);
    if (error) return failed('Não foi possível alterar o item', error);
    saved(addon.is_available ? `"${addon.name}" marcado como em falta.` : `"${addon.name}" disponível de novo.`);
    loadCatalogAdmin();
  } else if (addon && e.target.closest('[data-rename-addon]')) {
    const name = prompt('Novo nome do item:', addon.name);
    if (!name || !name.trim()) return;
    const { error } = await supabase.from('acai_addons').update({ name: name.trim() }).eq('id', addon.id);
    if (error) return failed('Não foi possível renomear', error);
    loadCatalogAdmin();
  } else if (addon && e.target.closest('[data-delete-addon]')) {
    if (!confirm(`Excluir "${addon.name}"? (Pra só esconder hoje, use "Em falta".)`)) return;
    const { error } = await supabase.from('acai_addons').delete().eq('id', addon.id);
    if (error) return failed('Não foi possível excluir', error);
    loadCatalogAdmin();
  } else if (addonEl && e.target.closest('[data-show-size-prices]')) {
    const box = addonEl.querySelector('.addon-size-prices');
    box.hidden = !box.hidden;
  }
});

// Preço salva sozinho ao sair do campo.
groupList.addEventListener('change', async (e) => {
  const addonEl = e.target.closest('[data-addon]');
  if (!addonEl) return;
  const addonId = addonEl.dataset.addon;

  if (e.target.matches('[data-addon-price]')) {
    const price = parseFloat(e.target.value);
    if (isNaN(price) || price < 0) return;
    const { error } = await supabase.from('acai_addons').update({ price }).eq('id', addonId);
    if (error) return failed('Não foi possível salvar o preço', error);
    saved('Preço salvo!');
    loadCatalogAdmin();
  } else if (e.target.matches('[data-addon-size-price]')) {
    const sizeId = e.target.dataset.addonSizePrice;
    const raw = e.target.value;
    const { error } =
      raw === ''
        ? await supabase.from('acai_addon_size_prices').delete().eq('addon_id', addonId).eq('size_id', sizeId)
        : await supabase
            .from('acai_addon_size_prices')
            .upsert({ addon_id: addonId, size_id: sizeId, store_id: STORE_ID, price: parseFloat(raw) }, { onConflict: 'addon_id,size_id' });
    if (error) return failed('Não foi possível salvar o preço por tamanho', error);
    saved('Preço por tamanho salvo!');
    loadCatalogAdmin();
  }
});

// =====================================================================
// Configurações
// =====================================================================
const settingsForm = document.getElementById('settingsForm');
const settingsMessage = document.getElementById('settingsMessage');
const deliveryModeSelect = document.getElementById('settingDeliveryMode');
const deliveryFixedFeeField = document.getElementById('deliveryFixedFeeField');

let currentStoreLogoUrl = null;

function updateDeliveryModeUI() {
  deliveryFixedFeeField.hidden = deliveryModeSelect.value !== 'fixo';
}
deliveryModeSelect.addEventListener('change', updateDeliveryModeUI);

async function loadSettings() {
  const { data, error } = await supabase.from('acai_settings').select('key, value').eq('store_id', STORE_ID);
  if (error) return;
  const map = Object.fromEntries((data || []).map((r) => [r.key, r.value]));

  document.getElementById('panelStoreLabel').textContent = map.store_name || '';
  document.getElementById('settingStoreOpen').checked = map.store_open !== false;
  document.getElementById('settingStoreName').value = map.store_name ?? '';
  currentStoreLogoUrl = map.store_logo_url || null;
  const logoPreview = document.getElementById('storeLogoPreview');
  logoPreview.hidden = !currentStoreLogoUrl;
  logoPreview.innerHTML = currentStoreLogoUrl ? `<img src="${esc(currentStoreLogoUrl)}" alt="" />` : '';
  document.getElementById('settingWhatsapp').value = map.whatsapp_number ?? '';
  deliveryModeSelect.value = map.delivery_fee_mode === 'fixo' ? 'fixo' : 'gratis';
  document.getElementById('settingDeliveryFixedFee').value = map.delivery_fixed_fee ?? 0;
  document.getElementById('settingDeliveryCity').value = map.delivery_city ?? '';
  document.getElementById('settingDeliveryNote').value = map.delivery_note ?? '';
  document.getElementById('settingPickupEnabled').checked = map.pickup_enabled !== false;
  document.getElementById('settingPickupAddress').value = map.pickup_address ?? '';
  updateDeliveryModeUI();
}

settingsForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  const rawWhatsapp = document.getElementById('settingWhatsapp').value.trim();
  const whatsappNumber = rawWhatsapp ? normalizeBrazilPhone(rawWhatsapp) : '';
  if (rawWhatsapp && !whatsappNumber) {
    showMessage(settingsMessage, `WhatsApp inválido. ${PHONE_FORMAT_HINT}`, true);
    return;
  }

  showMessage(settingsMessage, 'Salvando...');

  let storeLogoUrl = currentStoreLogoUrl;
  const logoFile = document.getElementById('settingStoreLogo').files[0];
  if (logoFile) {
    const ext = (logoFile.name.split('.').pop() || 'png').toLowerCase();
    const path = `${STORE_ID}/branding/${crypto.randomUUID()}.${ext}`;
    const { error: uploadError } = await supabase.storage.from('acai-products').upload(path, logoFile);
    if (uploadError) {
      showMessage(settingsMessage, `Não foi possível enviar a logo: ${uploadError.message}`, true);
      return;
    }
    storeLogoUrl = supabase.storage.from('acai-products').getPublicUrl(path).data.publicUrl;
  }

  const updates = [
    { key: 'store_open', value: document.getElementById('settingStoreOpen').checked },
    { key: 'store_name', value: document.getElementById('settingStoreName').value.trim() },
    { key: 'store_logo_url', value: storeLogoUrl },
    { key: 'whatsapp_number', value: whatsappNumber },
    { key: 'delivery_fee_mode', value: deliveryModeSelect.value },
    { key: 'delivery_fixed_fee', value: Math.max(parseFloat(document.getElementById('settingDeliveryFixedFee').value) || 0, 0) },
    { key: 'delivery_city', value: document.getElementById('settingDeliveryCity').value.trim() },
    { key: 'delivery_note', value: document.getElementById('settingDeliveryNote').value.trim() },
    { key: 'pickup_enabled', value: document.getElementById('settingPickupEnabled').checked },
    { key: 'pickup_address', value: document.getElementById('settingPickupAddress').value.trim() },
  ];
  const updatedAt = new Date().toISOString();
  const { error } = await supabase
    .from('acai_settings')
    .upsert(updates.map((u) => ({ store_id: STORE_ID, key: u.key, value: u.value, updated_at: updatedAt })), { onConflict: 'store_id,key' });
  if (error) {
    showMessage(settingsMessage, `Não foi possível salvar: ${error.message}`, true);
    return;
  }
  document.getElementById('settingStoreLogo').value = '';
  showMessage(settingsMessage, 'Configurações salvas!');
  loadSettings();
});

// ---------------- Horário de funcionamento ----------------
const businessHoursForm = document.getElementById('businessHoursForm');
const businessHoursList = document.getElementById('businessHoursList');
const businessHoursMessage = document.getElementById('businessHoursMessage');

function hoursRowHtml(day, row) {
  const opens = (row?.opens_at || '14:00:00').slice(0, 5);
  const closes = (row?.closes_at || '22:00:00').slice(0, 5);
  const isClosed = row?.is_closed ?? false;
  return `
    <div class="hours-row" data-day="${esc(day)}">
      <span class="hours-day-label">${DAY_LABELS[day]}</span>
      <input type="time" class="hours-open" value="${esc(opens)}" ${isClosed ? 'disabled' : ''} />
      <span>às</span>
      <input type="time" class="hours-close" value="${esc(closes)}" ${isClosed ? 'disabled' : ''} />
      <label class="checkbox-row-sm">
        <input type="checkbox" class="hours-closed" ${isClosed ? 'checked' : ''} />
        <span>Fechado</span>
      </label>
    </div>`;
}

async function loadBusinessHours() {
  const { data, error } = await supabase.from('acai_business_hours').select('*').eq('store_id', STORE_ID).order('day_of_week');
  if (error) {
    showMessage(businessHoursMessage, 'Não foi possível carregar o horário de funcionamento.', true);
    return;
  }
  const byDay = new Map((data || []).map((r) => [r.day_of_week, r]));
  businessHoursList.innerHTML = DAY_LABELS.map((_, day) => hoursRowHtml(day, byDay.get(day))).join('');
}

businessHoursList.addEventListener('change', (e) => {
  if (!e.target.classList.contains('hours-closed')) return;
  const row = e.target.closest('.hours-row');
  row.querySelector('.hours-open').disabled = e.target.checked;
  row.querySelector('.hours-close').disabled = e.target.checked;
});

businessHoursForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  showMessage(businessHoursMessage, 'Salvando...');

  const rows = [...businessHoursList.querySelectorAll('.hours-row')].map((row) => ({
    store_id: STORE_ID,
    day_of_week: Number(row.dataset.day),
    is_closed: row.querySelector('.hours-closed').checked,
    opens_at: `${row.querySelector('.hours-open').value || '00:00'}:00`,
    closes_at: `${row.querySelector('.hours-close').value || '00:00'}:00`,
  }));

  const invalidDay = rows.find((r) => !r.is_closed && r.closes_at <= r.opens_at);
  if (invalidDay) {
    showMessage(businessHoursMessage, `Em "${DAY_LABELS[invalidDay.day_of_week]}", o fechamento precisa ser depois da abertura.`, true);
    return;
  }

  const { error } = await supabase.from('acai_business_hours').upsert(rows, { onConflict: 'store_id,day_of_week' });
  if (error) {
    showMessage(businessHoursMessage, `Não foi possível salvar: ${error.message}`, true);
    return;
  }
  showMessage(businessHoursMessage, 'Horário salvo!');
});

// ---------------- Impressão automática ----------------
// Gera no navegador um .zip pronto: arquivos genéricos do agente + um
// config.json com a chave desta loja.
const downloadAgentConfigBtn = document.getElementById('downloadAgentConfigBtn');
const printAgentMessage = document.getElementById('printAgentMessage');

function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

downloadAgentConfigBtn.addEventListener('click', async () => {
  showMessage(printAgentMessage, 'Gerando o pacote...');
  downloadAgentConfigBtn.disabled = true;
  try {
    const { data, error } = await supabase.rpc('get_acai_print_agent_config', { p_store_id: STORE_ID });
    const row = data?.[0];
    if (error || !row?.print_agent_key) {
      showMessage(printAgentMessage, 'Não consegui gerar o pacote agora. Tente de novo em instantes.', true);
      return;
    }
    const config = {
      storeName: row.store_name,
      supabaseUrl: SUPABASE_URL,
      supabaseAnonKey: SUPABASE_ANON_KEY,
      agentKey: row.print_agent_key,
      printerName: '',
      pollIntervalMs: 5000,
    };

    const names = ['agent.js', 'package.json', 'iniciar.bat', 'testar-impressao.bat', 'iniciar-oculto.vbs'];
    const texts = await Promise.all(names.map((n) => fetch(`downloads/print-agent-src/${n}`).then((r) => r.text())));
    const files = Object.fromEntries(names.map((n, i) => [n, fflate.strToU8(texts[i])]));
    files['config.json'] = fflate.strToU8(JSON.stringify(config, null, 2));

    downloadBlob('impressao-automatica.zip', new Blob([fflate.zipSync(files)], { type: 'application/zip' }));
    showMessage(printAgentMessage, 'Baixado! Extraia o zip e dê 2 cliques em iniciar.bat.');
  } catch (err) {
    console.error('print agent config error', err);
    showMessage(printAgentMessage, 'Não consegui gerar o pacote agora. Tente de novo em instantes.', true);
  } finally {
    downloadAgentConfigBtn.disabled = false;
  }
});

const printAgentDot = document.getElementById('printAgentDot');
const printAgentStatusText = document.getElementById('printAgentStatusText');
const printAgentPrinterNameInput = document.getElementById('printAgentPrinterName');
const savePrinterNameBtn = document.getElementById('savePrinterNameBtn');
const printAgentTestBtn = document.getElementById('printAgentTestBtn');

function timeAgo(date) {
  const s = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
  if (s < 60) return 'há ' + s + 's';
  if (s < 3600) return 'há ' + Math.round(s / 60) + ' min';
  if (s < 86400) return 'há ' + Math.round(s / 3600) + ' h';
  return 'há ' + Math.round(s / 86400) + ' dia(s)';
}

function renderPrintAgentStatus(row) {
  const seen = row?.agent_last_seen ? new Date(row.agent_last_seen) : null;
  const online = seen && Date.now() - seen.getTime() < 60 * 1000;
  printAgentDot.className = 'print-agent-dot ' + (online ? 'online' : seen ? 'offline' : 'never');
  if (online) {
    printAgentStatusText.textContent = 'Agente conectado' + (row.agent_info ? ' (' + row.agent_info.split(' | ')[0] + ')' : '') + ' — visto ' + timeAgo(seen);
  } else if (seen) {
    printAgentStatusText.textContent = 'Agente desconectado — visto pela última vez ' + timeAgo(seen) + '. Confira se o computador está ligado.';
  } else {
    printAgentStatusText.textContent = 'O agente ainda não se conectou. Siga os passos abaixo no computador da impressora.';
  }
}

let printStatusTimer = null;

async function loadPrintStatus(testId = null) {
  const { data, error } = await supabase.rpc('get_acai_print_status', { p_store_id: STORE_ID, p_test_id: testId });
  if (error || !data?.[0]) return null;
  const row = data[0];
  renderPrintAgentStatus(row);
  if (document.activeElement !== printAgentPrinterNameInput && testId === null) {
    printAgentPrinterNameInput.value = row.printer_name || '';
  }
  return row;
}

function startPrintStatusPolling() {
  loadPrintStatus();
  clearInterval(printStatusTimer);
  printStatusTimer = setInterval(() => {
    if (document.getElementById('tabSettings').hidden) return;
    loadPrintStatus();
  }, 15000);
}

savePrinterNameBtn.addEventListener('click', async () => {
  savePrinterNameBtn.disabled = true;
  showMessage(printAgentMessage, 'Salvando...');
  const { error } = await supabase.rpc('set_acai_printer_name', { p_store_id: STORE_ID, p_printer_name: printAgentPrinterNameInput.value });
  savePrinterNameBtn.disabled = false;
  if (error) {
    showMessage(printAgentMessage, 'Não consegui salvar o nome da impressora agora.', true);
    return;
  }
  showMessage(printAgentMessage, 'Nome da impressora salvo! O agente passa a usar na hora.');
});

printAgentTestBtn.addEventListener('click', async () => {
  printAgentTestBtn.disabled = true;
  showMessage(printAgentMessage, 'Pedindo a comanda de teste...');
  try {
    const { data: testId, error } = await supabase.rpc('request_acai_print_test', { p_store_id: STORE_ID });
    if (error || !testId) {
      showMessage(printAgentMessage, 'Não consegui pedir o teste agora. Tente de novo em instantes.', true);
      return;
    }
    showMessage(printAgentMessage, 'Teste enviado — aguardando o agente imprimir...');
    const deadline = Date.now() + 40 * 1000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      const row = await loadPrintStatus(testId);
      if (row?.test_printed_at) {
        showMessage(printAgentMessage, 'Comanda de teste impressa ✓ — confira o papel na impressora.');
        return;
      }
      if (row?.test_error) {
        showMessage(printAgentMessage, 'O agente tentou imprimir e deu erro: ' + row.test_error, true);
        return;
      }
    }
    showMessage(printAgentMessage, 'O agente não respondeu em 40 segundos. Confira se o computador da impressora está ligado e com internet.', true);
  } finally {
    printAgentTestBtn.disabled = false;
  }
});

// ---------------- Init ----------------
loginForm.addEventListener('submit', handleLogin);
signupForm.addEventListener('submit', handleSignup);
forgotForm.addEventListener('submit', handleForgot);
resetForm.addEventListener('submit', handleReset);
claimForm.addEventListener('submit', handleClaim);
logoutBtn.addEventListener('click', handleLogout);
document.getElementById('deniedLogoutBtn').addEventListener('click', handleLogout);

document.getElementById('showForgotBtn').addEventListener('click', () => showAuthView('forgot'));
document.getElementById('showSignupBtn').addEventListener('click', () => showAuthView('signup'));
document.getElementById('backToLoginFromSignupBtn').addEventListener('click', () => showAuthView('login'));
document.getElementById('backToLoginFromForgotBtn').addEventListener('click', () => showAuthView('login'));

if (isConfigured) {
  // onAuthStateChange já dispara uma vez com a sessão atual (INITIAL_SESSION).
  supabase.auth.onAuthStateChange((event, session) => {
    if (event === 'PASSWORD_RECOVERY') {
      inRecoveryMode = true;
      loginView.hidden = false;
      panelView.hidden = true;
      showAuthView('reset');
      return;
    }
    // Sem await aqui: chamar o Supabase dentro do callback trava o client.
    setTimeout(() => renderForSession(session), 0);
  });
} else {
  showMessage(loginMessage, 'O painel ainda não foi configurado (falta ligar ao Supabase).', true);
  loginView.hidden = false;
  showAuthView('login');
}
