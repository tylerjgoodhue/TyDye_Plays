/* Public Fourthwall storefront. Only the public storefront token belongs in the config. */
(() => {
  'use strict';
  const base = new URL('./', document.currentScript.src);
  const API = 'https://storefront-api.fourthwall.com/v1';
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const https = value => { try { const u = new URL(value); return u.protocol === 'https:' ? u.href : ''; } catch { return ''; } };
  const imageUrl = image => https(image?.url) || https(image?.transformedUrl);
  const inStock = variant => variant?.stock?.type === 'UNLIMITED' || (variant?.stock?.type === 'LIMITED' && variant.stock.inStock > 0);
  const maxQuantity = variant => variant?.stock?.type === 'LIMITED' ? Math.min(1000, Math.max(0, Number(variant.stock.inStock) || 0)) : 1000;
  const money = value => {
    const amount = Number(value?.value);
    if (!Number.isFinite(amount)) return '';
    try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: value.currency || 'USD' }).format(amount); } catch { return `${amount.toFixed(2)} USD`; }
  };
  const textOnly = value => {
    const doc = new DOMParser().parseFromString(String(value || ''), 'text/html');
    doc.querySelectorAll('script,style,iframe,object').forEach(node => node.remove());
    return doc.body.textContent || '';
  };
  // Copy only basic formatting into a new document; no styles, scripts, embeds, or event handlers.
  function richText(value) {
    const parsed = new DOMParser().parseFromString(String(value || ''), 'text/html');
    const target = document.createElement('div');
    const tags = new Set(['P', 'BR', 'UL', 'OL', 'LI', 'STRONG', 'B', 'EM', 'I', 'H3', 'H4', 'H5', 'H6', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD']);
    function copy(node, parent) {
      if (node.nodeType === 3) { parent.append(document.createTextNode(node.textContent)); return; }
      if (node.nodeType !== 1 || ['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'SVG', 'MATH', 'FORM'].includes(node.tagName)) return;
      const child = tags.has(node.tagName) ? document.createElement(node.tagName.toLowerCase()) : parent;
      if (child !== parent) parent.append(child);
      [...node.childNodes].forEach(item => copy(item, child));
    }
    [...parsed.body.childNodes].forEach(node => copy(node, target));
    return target.innerHTML;
  }
  const errorText = error => {
    const code = String(error.code || '');
    if (/QUANTITY_TOO_HIGH/.test(code)) return 'That quantity is not available. Please choose fewer items.';
    if (/NOT_AVAILABLE|NOT_PURCHASABLE|VARIANT_NOT_FOUND|OFFER_NOT_FOUND/.test(code)) return 'An item is no longer available. Review your selections and try again.';
    if (error.status === 429) return 'The shop is busy. Please wait a moment and try again.';
    if (error.status === 404) return 'This item is no longer available.';
    return 'We could not reach the shop. Please try again. Your cart has not been cleared.';
  };
  class StoreError extends Error {
    constructor(status, code) { super(code || `Store request failed (${status})`); this.status = status; this.code = code; }
  }
  function create({ profile }) {
    const name = String(profile.name || 'Creator');
    const accent = /^#[0-9a-f]{6}$/i.test(profile.buttonColor || '') ? profile.buttonColor : '#c6f36b';
    const channels = [1, 3, 5].map(index => parseInt(accent.slice(index, index + 2), 16) / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
    const luminance = channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
    document.documentElement.style.setProperty('--fw-button-text', luminance > .179 ? '#111111' : '#ffffff');
    const preview = new URLSearchParams(location.search).has('preview');
    const route = (file, params = {}) => {
      const u = new URL(file, base);
      Object.entries(params).forEach(([key, value]) => u.searchParams.set(key, value));
      if (preview) { u.searchParams.set('preview', '1'); u.hash = location.hash; }
      return u.href;
    };
    let configPromise;
    let config;
    let cart = null;
    let cartId = '';
    let storageKey = '';
    let busy = false;
    const storage = {
      get: key => { try { return localStorage.getItem(key); } catch { return null; } },
      set: (key, value) => { try { localStorage.setItem(key, value); } catch {} },
      remove: key => { try { localStorage.removeItem(key); } catch {} }
    };
    async function configure() {
      if (!configPromise) configPromise = (async () => {
        const response = await fetch(new URL('storefront-config.json', base), { cache: 'no-store', signal: AbortSignal.timeout(12000) });
        if (!response.ok) throw new StoreError(response.status, 'CONFIG_UNAVAILABLE');
        const data = await response.json();
        if (!/^ptkn_[a-zA-Z0-9_-]+$/.test(data.storefrontToken || '') || !https(data.checkoutDomain)) throw new StoreError(503, 'CONFIG_UNAVAILABLE');
        config = { ...data, checkoutDomain: new URL(data.checkoutDomain).origin, currency: 'USD' };
        storageKey = `fourthwall-cart-v1:${config.checkoutDomain}:${config.currency}${preview ? ':preview' : ''}`;
        const saved = storage.get(storageKey);
        cartId = /^[a-zA-Z0-9_-]{1,160}$/.test(saved || '') ? saved : '';
        return config;
      })().catch(error => { configPromise = null; throw error; });
      return configPromise;
    }
    async function request(path, { method = 'GET', body, query = {} } = {}) {
      await configure();
      const url = new URL(API + path);
      url.searchParams.set('storefront_token', config.storefrontToken);
      url.searchParams.set('currency', config.currency);
      Object.entries(query).forEach(([key, value]) => url.searchParams.set(key, String(value)));
      const response = await fetch(url, {
        method, cache: 'no-store', signal: AbortSignal.timeout(15000),
        ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new StoreError(response.status, data.code);
      return data;
    }
    async function pages(path) {
      const results = [];
      for (let page = 0; page < 100; page++) {
        const data = await request(path, { query: { page, size: 100 } });
        results.push(...(data.results || []));
        if (!data.paging?.hasNextPage) return results;
      }
      throw new StoreError(503, 'CATALOG_TOO_LARGE');
    }
    function saveCart(next) {
      if (!next || typeof next.id !== 'string' || !Array.isArray(next.items)) throw new StoreError(502, 'INVALID_CART');
      cart = next;
      cartId = next.id;
      storage.set(storageKey, cartId);
      updateBadge();
      return next;
    }
    async function readCart() {
      await configure();
      if (!cartId) { cart = null; updateBadge(); return null; }
      try { return saveCart(await request(`/carts/${encodeURIComponent(cartId)}`)); }
      catch (error) {
        if (error.status !== 404) throw error;
        storage.remove(storageKey);
        cartId = ''; cart = null; updateBadge(); return null;
      }
    }
    function updateBadge() {
      const count = (cart?.items || []).reduce((sum, item) => sum + item.quantity, 0);
      document.querySelectorAll('[data-fw-cart-count]').forEach(el => { el.textContent = String(count); });
    }
    async function changeCart(action, items) {
      if (busy) return null;
      busy = true;
      try {
        // Re-read before a mutation to reconcile changes from another tab or an expired cart.
        await readCart();
        if (!cartId) {
          if (action !== 'add') throw new StoreError(404, 'CART_NOT_FOUND');
          return saveCart(await request('/carts', { method: 'POST', body: { items } }));
        }
        return saveCart(await request(`/carts/${encodeURIComponent(cartId)}/${action}`, { method: 'POST', body: { items } }));
      } finally { busy = false; }
    }
    function cartLink() {
      return `<a class="fw-cart-link" href="${escape(route('cart.html'))}" aria-label="Shopping cart">Cart <span data-fw-cart-count>0</span></a>`;
    }
    function header() {
      return `<header class="site-nav fw-nav"><a class="site-wordmark" href="${escape(route('profile.html'))}">${escape(name)}</a><nav aria-label="Shop navigation"><a href="${escape(route('shop.html'))}">Shop</a>${cartLink()}</nav></header>`;
    }
    function footer() {
      return `<footer class="fw-footer"><span>${escape(name)}</span><a href="${escape(route('shop.html'))}">Continue shopping</a><span>Secure checkout & fulfillment by Fourthwall</span></footer>`;
    }
    function message(host, text, retry) {
      host.innerHTML = `<div class="fw-message" role="status"><p>${escape(text)}</p>${retry ? '<button type="button" class="fw-button fw-secondary" data-fw-retry>Try again</button>' : ''}</div>`;
      host.querySelector('[data-fw-retry]')?.addEventListener('click', retry);
    }
    function attachNav() {
      const nav = document.querySelector('.site-nav');
      if (nav && !nav.querySelector('.fw-cart-link')) nav.insertAdjacentHTML('beforeend', cartLink());
      readCart().catch(() => {});
    }
    function productLink(product, variantId) { return route('product.html', { product: product.slug || product.id, ...(variantId ? { variant: variantId } : {}) }); }
    function available(product) { return product.access?.type === 'PUBLIC' && product.state?.type === 'AVAILABLE'; }
    function card(product) {
      const variants = product.variants || [];
      const prices = variants.map(v => v.unitPrice).filter(p => Number.isFinite(Number(p?.value)));
      const lowest = prices.sort((a, b) => a.value - b.value)[0];
      const from = prices.some(p => p.value !== lowest?.value) ? 'From ' : '';
      const photo = product.images?.find(imageUrl);
      const soldOut = !available(product) || !variants.some(inStock);
      return `<article class="site-product"><a class="site-product-link" href="${escape(productLink(product))}"><div class="site-product-image-wrap fw-card-photo">${photo ? `<img src="${escape(imageUrl(photo))}" alt="${escape(product.name)}" loading="lazy" decoding="async">` : '<span>No photo yet</span>'}${soldOut ? '<span class="fw-sold-out">Sold out</span>' : ''}</div><div class="site-product-info"><h3>${escape(product.name)}</h3><span class="site-product-price">${escape(from + money(lowest))}</span><span class="site-product-view">View product →</span></div></a></article>`;
    }
    async function mountCollection(host, full = false) {
      const load = async () => {
        message(host, 'Loading the collection…');
        try {
          await configure();
          const collectionSlug = config.collection || 'all';
          const products = (await pages(`/collections/${encodeURIComponent(collectionSlug)}/products`)).filter(p => p.access?.type === 'PUBLIC' && p.type !== 'BUNDLE');
          host.innerHTML = `<div class="site-shop-heading"><div class="site-section-head"><p class="site-kicker">${escape(name)} merch</p><h${full ? '1' : '2'}>${full ? 'The collection' : 'Shop the collection'}</h${full ? '1' : '2'}><p class="site-shop-intro">Made for the community. Find your next favorite.</p></div>${full ? '' : `<a class="fw-text-link" href="${escape(route('shop.html'))}">Browse the shop →</a>`}</div>${full ? `<div class="fw-shop-tools"><label>Search the shop<input type="search" data-fw-search placeholder="Find a product…"></label><label>Sort by<select data-fw-sort><option value="featured">Featured</option><option value="price-low">Price: low to high</option><option value="price-high">Price: high to low</option><option value="name">Name</option></select></label></div>` : ''}<p class="fw-result-count" aria-live="polite" data-fw-result-count></p><div class="site-shop-grid" data-fw-grid></div>`;
          const render = () => {
            const query = host.querySelector('[data-fw-search]')?.value.trim().toLowerCase() || '';
            const sort = host.querySelector('[data-fw-sort]')?.value || 'featured';
            const filtered = products.filter(p => `${p.name} ${textOnly(p.description)}`.toLowerCase().includes(query));
            const price = p => Math.min(...(p.variants || []).map(v => Number(v.unitPrice?.value)).filter(Number.isFinite));
            if (sort === 'price-low') filtered.sort((a, b) => price(a) - price(b));
            if (sort === 'price-high') filtered.sort((a, b) => price(b) - price(a));
            if (sort === 'name') filtered.sort((a, b) => a.name.localeCompare(b.name));
            host.querySelector('[data-fw-result-count]').textContent = `${filtered.length} ${filtered.length === 1 ? 'product' : 'products'}`;
            host.querySelector('[data-fw-grid]').innerHTML = filtered.length ? filtered.map(card).join('') : '<p class="fw-message">No products found. Try a different search or check back soon.</p>';
          };
          host.querySelector('[data-fw-search]')?.addEventListener('input', render);
          host.querySelector('[data-fw-sort]')?.addEventListener('change', render);
          render();
        } catch { message(host, 'The collection could not be loaded.', load); }
      };
      await load();
    }
    async function renderProduct(host) {
      const load = async () => {
        message(host, 'Loading product details…');
        try {
          const key = new URLSearchParams(location.search).get('product');
          if (!key) throw new StoreError(404, 'PRODUCT_NOT_FOUND');
          // Keep older links using the published product ID working.
          const published = (profile.website?.products || []).find(p => p.id === key || p.fourthwallId === key);
          const product = await request(`/products/${encodeURIComponent(published?.slug || key)}`);
          if (product.access?.type !== 'PUBLIC' || product.type === 'BUNDLE') throw new StoreError(404, 'PRODUCT_NOT_FOUND');
          document.title = `${product.name} · ${name}`;
          document.querySelector('meta[name="description"]').content = textOnly(product.description).slice(0, 240);
          document.querySelector('meta[property="og:title"]').content = document.title;
          document.querySelector('meta[property="og:description"]').content = textOnly(product.description).slice(0, 240);
          document.querySelector('meta[property="og:image"]').content = imageUrl(product.images?.[0]);
          drawProduct(host, product);
        } catch (error) { message(host, error.status === 404 ? 'This product is no longer available. Browse the shop to find something else.' : 'Product details could not be loaded.', error.status === 404 ? null : load); }
      };
      await load();
    }
    function drawProduct(host, product) {
      const variants = product.variants || [];
      const linkedVariant = variants.find(v => v.id === new URLSearchParams(location.search).get('variant') && inStock(v));
      const initial = linkedVariant || variants.find(inStock) || variants[0];
      const colors = [...new Set(variants.map(v => v.attributes?.color?.name).filter(Boolean))];
      const sizes = [...new Set(variants.map(v => v.attributes?.size?.name).filter(Boolean))];
      const structured = variants.every(v => v.attributes?.color?.name || v.attributes?.size?.name);
      let color = initial?.attributes?.color?.name || '';
      let size = linkedVariant?.attributes?.size?.name || (sizes.length === 1 ? sizes[0] : '');
      let selectedId = linkedVariant?.id || (structured ? '' : variants.length === 1 ? variants[0].id : '');
      let currentPhoto = '';
      let gallery = [];
      let adding = false;
      const selected = () => structured ? variants.find(v => (!colors.length || v.attributes?.color?.name === color) && (!sizes.length || v.attributes?.size?.name === size)) : variants.find(v => v.id === selectedId);
      const detailInfo = (product.additionalInformation || []).map(info => `<details class="fw-detail"><summary>${escape(info.title)}</summary><div class="fw-rich">${richText(info.bodyHtml)}</div></details>`).join('');
      const guide = product.sizeGuide;
      host.innerHTML = `<a class="product-back" href="${escape(route('shop.html'))}">← Back to the collection</a><div class="fw-product-layout"><section class="fw-gallery" aria-label="Product photos"><button class="fw-main-photo" type="button" data-fw-zoom aria-label="Enlarge product photo"><img data-fw-main-photo alt="${escape(product.name)}" fetchpriority="high"><span>Click to enlarge</span></button><div class="fw-thumbnails" data-fw-thumbnails aria-label="Choose a product photo"></div></section><section class="fw-product-details"><p class="site-kicker">${escape(name)} collection</p><h1>${escape(product.name)}</h1><p class="fw-price" data-fw-price aria-live="polite"></p><p class="fw-stock" data-fw-stock aria-live="polite"></p><form data-fw-product-form><div data-fw-options></div><label class="fw-quantity">Quantity<input type="number" min="1" max="1000" step="1" value="1" inputmode="numeric" data-fw-quantity required></label><button type="submit" class="fw-button fw-add" data-fw-add disabled>Add to cart</button><p class="fw-feedback" data-fw-feedback role="status" aria-live="polite"></p></form><p class="fw-checkout-note">Shipping and taxes are calculated at checkout.</p><div class="fw-description fw-rich">${richText(product.description)}</div>${guide ? `<details class="fw-detail"><summary>Size & fit guide</summary><div class="fw-rich">${https(guide.previewUrl) ? `<img class="fw-size-guide" src="${escape(https(guide.previewUrl))}" alt="Product measurement guide" loading="lazy">` : ''}${richText(guide.description)}${richText(guide.fitGuideDescription)}${https(guide.fileUrl) ? `<a href="${escape(https(guide.fileUrl))}" target="_blank" rel="noopener noreferrer">Open size chart ↗</a>` : ''}</div></details>` : ''}${detailInfo}</section></div><dialog class="fw-zoom-dialog" data-fw-zoom-dialog><button class="fw-button fw-secondary" type="button" data-fw-close-zoom aria-label="Close enlarged photo">Close ×</button><img alt="${escape(product.name)}" data-fw-zoom-photo></dialog>`;
      const options = host.querySelector('[data-fw-options]');
      const quantity = host.querySelector('[data-fw-quantity]');
      const add = host.querySelector('[data-fw-add]');
      const feedback = host.querySelector('[data-fw-feedback]');
      function showPhoto(url) {
        currentPhoto = url;
        const photo = host.querySelector('[data-fw-main-photo]');
        if (url) photo.src = url; else photo.removeAttribute('src');
        photo.hidden = !url;
        host.querySelector('[data-fw-zoom]').disabled = !url;
        host.querySelectorAll('[data-fw-photo]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.fwPhoto === url)));
      }
      function updateGallery(variant) {
        const images = variant?.images?.length ? variant.images : product.images || [];
        const next = [...new Set(images.map(imageUrl).filter(Boolean))];
        if (next.join('|') === gallery.join('|')) return;
        gallery = next;
        host.querySelector('[data-fw-thumbnails]').innerHTML = gallery.map((url, i) => `<button type="button" data-fw-photo="${escape(url)}" aria-label="View photo ${i + 1}" aria-pressed="false"><img src="${escape(url)}" alt="" loading="lazy" decoding="async"></button>`).join('');
        showPhoto(gallery.includes(currentPhoto) ? currentPhoto : gallery[0] || '');
      }
      function update() {
        const variant = selected();
        const representative = variant || variants.find(v => !colors.length || v.attributes?.color?.name === color) || initial;
        if (structured) {
          options.innerHTML = `${colors.length ? `<fieldset><legend>Color: <strong>${escape(color)}</strong></legend><div class="fw-choices">${colors.map(value => {
            const colorVariants = variants.filter(v => v.attributes?.color?.name === value);
            const availableColor = colorVariants.some(inStock) && available(product);
            const swatch = colorVariants[0]?.attributes?.color?.swatch;
            return `<button type="button" class="fw-choice" data-fw-color="${escape(value)}" aria-pressed="${value === color}" ${availableColor ? '' : 'disabled'}>${/^#[0-9a-f]{6}$/i.test(swatch || '') ? `<span class="fw-swatch" style="background:${swatch}"></span>` : ''}${escape(value)}${availableColor ? '' : ' · Sold out'}</button>`;
          }).join('')}</div></fieldset>` : ''}${sizes.length ? `<fieldset><legend>Size${size ? `: <strong>${escape(size)}</strong>` : ': choose your size'}</legend><div class="fw-choices">${sizes.map(value => {
            const match = variants.find(v => v.attributes?.size?.name === value && (!colors.length || v.attributes?.color?.name === color));
            const enabled = match && inStock(match) && available(product);
            return `<button type="button" class="fw-choice fw-size" data-fw-size="${escape(value)}" aria-pressed="${value === size}" ${enabled ? '' : 'disabled'} aria-label="${escape(value)}${enabled ? '' : ', unavailable'}">${escape(value)}</button>`;
          }).join('')}</div></fieldset>` : ''}`;
        } else {
          options.innerHTML = `<label class="fw-variant-label">Choose an option<select data-fw-variant required><option value="">Select an option</option>${variants.map(v => `<option value="${escape(v.id)}" ${selectedId === v.id ? 'selected' : ''} ${inStock(v) && available(product) ? '' : 'disabled'}>${escape(v.attributes?.description || v.name)}${inStock(v) ? '' : ' — Sold out'}</option>`).join('')}</select></label>`;
        }
        host.querySelector('[data-fw-price]').textContent = money(representative?.unitPrice);
        const canBuy = !!variant && inStock(variant) && available(product);
        host.querySelector('[data-fw-stock]').textContent = !available(product) || !variants.some(inStock) ? 'Currently sold out' : !variant ? 'Choose your options to check availability' : canBuy ? 'Available to order' : 'This option is sold out';
        quantity.max = String(variant ? maxQuantity(variant) : 1000);
        if (Number(quantity.value) > Number(quantity.max) && Number(quantity.max) > 0) quantity.value = quantity.max;
        add.disabled = adding || !canBuy;
        updateGallery(representative);
      }
      options.addEventListener('click', event => {
        const colorButton = event.target.closest('[data-fw-color]');
        const sizeButton = event.target.closest('[data-fw-size]');
        if (colorButton && !colorButton.disabled) {
          color = colorButton.dataset.fwColor;
          const match = selected();
          if (!match || !inStock(match)) size = sizes.length === 1 ? sizes[0] : '';
          update();
          options.querySelectorAll('[data-fw-color]').forEach(el => { if (el.dataset.fwColor === color) el.focus(); });
        }
        if (sizeButton && !sizeButton.disabled) {
          size = sizeButton.dataset.fwSize; update();
          options.querySelectorAll('[data-fw-size]').forEach(el => { if (el.dataset.fwSize === size) el.focus(); });
        }
        feedback.textContent = '';
      });
      options.addEventListener('change', event => { if (event.target.matches('[data-fw-variant]')) { selectedId = event.target.value; update(); options.querySelector('select').focus(); } });
      host.querySelector('[data-fw-thumbnails]').addEventListener('click', event => { const button = event.target.closest('[data-fw-photo]'); if (button) showPhoto(button.dataset.fwPhoto); });
      const dialog = host.querySelector('[data-fw-zoom-dialog]');
      host.querySelector('[data-fw-zoom]').addEventListener('click', () => { host.querySelector('[data-fw-zoom-photo]').src = currentPhoto; dialog.showModal(); });
      host.querySelector('[data-fw-close-zoom]').addEventListener('click', () => dialog.close());
      dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
      host.querySelector('[data-fw-product-form]').addEventListener('submit', async event => {
        event.preventDefault();
        const variant = selected();
        const count = Number(quantity.value);
        if (adding || !variant || !inStock(variant) || !available(product) || !Number.isInteger(count) || count < 1 || count > maxQuantity(variant)) return;
        adding = true; add.disabled = true; add.textContent = 'Adding…'; feedback.textContent = '';
        try {
          const result = await changeCart('add', [{ variantId: variant.id, quantity: count }]);
          if (!result) return;
          feedback.innerHTML = `Added to your cart. <a href="${escape(route('cart.html'))}">View cart & checkout →</a>`;
        } catch (error) { feedback.textContent = errorText(error); }
        finally { adding = false; add.textContent = 'Add to cart'; update(); }
      });
      update();
    }
    async function renderCart(host) {
      const load = async () => {
        message(host, 'Loading your cart…');
        try { await readCart(); drawCart(); } catch (error) { message(host, errorText(error), load); }
      };
      function drawCart() {
        const items = cart?.items || [];
        document.title = `Your cart · ${name}`;
        if (!items.length) {
          host.innerHTML = `<div class="fw-empty"><p class="site-kicker">Your cart</p><h1>A little empty in here.</h1><p>Find something you love from the collection.</p><a class="fw-button" href="${escape(route('shop.html'))}">Explore the shop</a></div>`;
          return;
        }
        const subtotal = items.reduce((sum, item) => sum + Math.round(Number(item.variant.unitPrice.value) * 100) * item.quantity, 0) / 100;
        host.innerHTML = `<p class="site-kicker">Your selection</p><h1>Your cart</h1><div class="fw-cart-layout"><div class="fw-cart-items">${items.map(item => {
          const variant = item.variant;
          const photo = variant.images?.find(imageUrl);
          const product = variant.product || {};
          return `<article class="fw-cart-item"><a href="${escape(productLink(product, variant.id))}" class="fw-cart-photo">${photo ? `<img src="${escape(imageUrl(photo))}" alt="${escape(product.name)}">` : ''}</a><div><a class="fw-cart-name" href="${escape(productLink(product, variant.id))}">${escape(product.name)}</a><p>${escape(variant.attributes?.description || variant.name)}</p><p>${escape(money(variant.unitPrice))} each</p><div class="fw-cart-controls"><label>Quantity<input type="number" inputmode="numeric" min="1" max="${maxQuantity(variant)}" step="1" value="${item.quantity}" data-fw-cart-quantity="${escape(variant.id)}" aria-label="Quantity for ${escape(product.name)}, ${escape(variant.attributes?.description || variant.name)}"></label><button class="fw-remove" type="button" data-fw-remove="${escape(variant.id)}">Remove</button></div>${!inStock(variant) ? '<p class="fw-error">This option is no longer in stock. Remove it to continue.</p>' : ''}</div><strong>${escape(money({ value: Math.round(variant.unitPrice.value * 100) * item.quantity / 100, currency: variant.unitPrice.currency }))}</strong></article>`;
        }).join('')}</div><aside class="fw-cart-summary"><h2>Order summary</h2><div class="fw-subtotal"><span>Subtotal</span><strong>${escape(money({ value: subtotal, currency: config.currency }))}</strong></div><p>Shipping, taxes, and any discounts are calculated at checkout.</p><button class="fw-button" data-fw-checkout type="button" ${items.some(item => !inStock(item.variant)) ? 'disabled' : ''}>Continue to checkout →</button><p class="fw-checkout-note">Secure payment and delivery details are handled by Fourthwall.</p><a href="${escape(route('shop.html'))}">Continue shopping</a></aside></div><p class="fw-feedback" data-fw-cart-feedback role="status" aria-live="polite"></p>`;
        const feedback = host.querySelector('[data-fw-cart-feedback]');
        function disable(disabled) { host.querySelectorAll('input,button').forEach(el => { el.disabled = disabled; }); }
        async function mutate(action, id, count) {
          if (busy) return;
          disable(true); feedback.textContent = 'Updating your cart…';
          try {
            await changeCart(action, [{ variantId: id, quantity: count }]);
            drawCart();
          } catch (error) {
            // A failed response is ambiguous. Reconcile without replaying the mutation.
            try { await readCart(); } catch {}
            drawCart();
            const status = host.querySelector('[data-fw-cart-feedback]');
            if (status) status.textContent = errorText(error);
          }
        }
        host.querySelectorAll('[data-fw-cart-quantity]').forEach(input => input.addEventListener('change', () => {
          const count = Number(input.value);
          if (!Number.isInteger(count) || count < 1 || count > Number(input.max)) { input.reportValidity(); feedback.textContent = 'Enter a valid quantity before continuing.'; return; }
          mutate('change', input.dataset.fwCartQuantity, count);
        }));
        host.querySelectorAll('[data-fw-remove]').forEach(button => button.addEventListener('click', () => mutate('remove', button.dataset.fwRemove, 0)));
        host.querySelector('[data-fw-checkout]').addEventListener('click', async () => {
          if (busy) return;
          if ([...host.querySelectorAll('input')].some(input => !input.reportValidity())) return;
          busy = true; disable(true); feedback.textContent = 'Checking your cart…';
          try {
            await readCart();
            if (!cart?.items.length) { drawCart(); return; }
            if (cart.items.some(item => !inStock(item.variant) || item.quantity > maxQuantity(item.variant))) { drawCart(); throw new StoreError(400, 'CART_OFFER_NOT_AVAILABLE'); }
            const checkout = new URL('/checkout/', config.checkoutDomain);
            checkout.searchParams.set('cartId', cart.id);
            checkout.searchParams.set('cartCurrency', config.currency);
            location.assign(checkout.href);
          } catch (error) {
            drawCart();
            host.querySelector('[data-fw-cart-feedback]')?.append(document.createTextNode(errorText(error)));
          } finally { busy = false; }
        });
      }
      await load();
    }
    async function renderPage(root) {
      root.innerHTML = `${header()}<main class="fw-page" data-fw-page></main>${footer()}`;
      const host = root.querySelector('[data-fw-page]');
      attachNav();
      if (location.pathname.endsWith('/cart.html')) await renderCart(host);
      else if (location.pathname.endsWith('/shop.html')) { document.title = `Shop · ${name}`; await mountCollection(host, true); }
      else await renderProduct(host);
    }
    window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
    window.addEventListener('storage', event => {
      if (storageKey && event.key === storageKey) {
        cartId = /^[a-zA-Z0-9_-]{1,160}$/.test(event.newValue || '') ? event.newValue : '';
        readCart().catch(() => {});
      }
    });
    return { renderPage, mountCollection, attachNav };
  }
  window.CreatorStorefront = { create };
})();
