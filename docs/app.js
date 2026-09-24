(async () => {
  const $ = (id) => document.getElementById(id);
  let catalog;
  const iconRequest = fetch("icons/brands/manifest.json", { cache: "no-cache" }).then(async (response) => {
    if (!response.ok) throw new Error(`icons/brands/manifest.json → ${response.status} ${response.statusText}`);
    const icons = await response.json();
    if (typeof icons !== "object" || icons === null || Array.isArray(icons)
      || !Object.values(icons).every((file) => typeof file === "string" && /^[a-z0-9._-]+\.svg$/.test(file))) {
      throw new Error("brand icon manifest has an invalid shape");
    }
    return icons;
  }).catch((error) => {
    console.error("Could not load brand icons", error);
    return {};
  });
  let icons;
  try {
    const [catalogResponse, availableIcons] = await Promise.all([
      fetch("models.json", { cache: "no-cache" }),
      iconRequest,
    ]);
    if (!catalogResponse.ok) throw new Error(`models.json → ${catalogResponse.status} ${catalogResponse.statusText}`);
    catalog = await catalogResponse.json();
    icons = availableIcons;
    if (!Array.isArray(catalog.models) || !Array.isArray(catalog.providers) || typeof catalog.makers !== "object" || catalog.makers === null || Array.isArray(catalog.makers)) {
      throw new Error("models.json has an invalid catalog shape");
    }
  } catch (error) {
    console.error("Could not load the model catalog", error);
    $("grid").innerHTML = '<div class="empty" style="grid-column:1/-1">Could not load the model catalog. Please try again later.</div>';
    return;
  }
  const CAPABILITY_COLUMNS = [["tools", "Tools"], ["imageInput", "Vision"], ["reasoning", "Reasoning"]];
  const MODEL_TYPES = new Set(["text", "image", "embedding", "rerank", "transcription", "decision"]);
  const modelType = (m) => m.capabilities.embedding ? "embedding"
    : m.capabilities.imageGeneration ? "image"
    : m.capabilities.rerank ? "rerank"
    : m.capabilities.transcription ? "transcription"
    : m.capabilities.decision ? "decision"
    : "text";
  const typeLabel = (type) => type.charAt(0).toUpperCase() + type.slice(1);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const makerLabel = (id) => catalog.makers[id] ?? id;
  const makerInitials = (id) => {
    const words = makerLabel(id).replace(/([a-z])([A-Z])/g, "$1 $2").match(/[a-z0-9]+/gi) ?? [];
    return (words.length > 1 ? `${words[0][0]}${words[1][0]}` : (words[0] ?? "?").slice(0, 2)).toUpperCase();
  };

  // The console's own formatting, kept to the letter: `formatUsd`,
  // `modelPriceLabel`, `contextWindowLabel`, `otherRoutes`.
  const formatUsd = (v, digits) => {
    const d = digits ?? (v !== 0 && Math.abs(v) < 0.01 ? 4 : 2);
    return `$${v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })}`;
  };
  const modelPriceLabel = (m) => {
    const p = m.pricing;
    const { inputPer1M, outputPer1M, imageOutputPer1M, perImage, perSearch, perAudioMinute } = p;
    if (m.capabilities.embedding || m.capabilities.decision) return `${formatUsd(inputPer1M)} in per 1M`;
    if (m.capabilities.rerank) return perSearch !== undefined ? `${formatUsd(perSearch)} / search` : `${formatUsd(inputPer1M)} in per 1M`;
    if (m.capabilities.transcription && perAudioMinute !== undefined) return `${formatUsd(perAudioMinute)} / audio minute`;
    if (imageOutputPer1M === undefined && perImage === undefined) return `${formatUsd(inputPer1M)} in · ${formatUsd(outputPer1M)} out per 1M`;
    const image = perImage !== undefined ? `${imageOutputPer1M ? "≈" : ""}${formatUsd(perImage)} / image` : `${formatUsd(imageOutputPer1M ?? 0)} image out per 1M`;
    return inputPer1M > 0 ? `${image} · ${formatUsd(inputPer1M)} in per 1M` : image;
  };
  const roundTokens = (n) => n >= 1e6 ? `${Math.round(n / 1e4) / 100}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : `${n}`;
  const contextWindowLabel = (m) => m.capabilities.embedding || m.capabilities.rerank
    ? `Context ${roundTokens(m.contextWindow)}`
    : m.capabilities.transcription && m.contextWindow === 0
      ? "Audio input · token limits not published"
    : `Context ${roundTokens(m.contextWindow)} · max out ${roundTokens(m.maxTokens)}`;
  const routesByFamily = new Map();
  for (const model of catalog.models) {
    if (model.hidden) continue;
    const routes = routesByFamily.get(model.family) ?? [];
    routes.push(model.provider);
    routesByFamily.set(model.family, routes);
  }
  const otherRoutes = (m) => (routesByFamily.get(m.family) ?? []).filter((provider) => provider !== m.provider);
  const primaryPrice = (m) => m.pricing.perSearch ?? m.pricing.perAudioMinute
    ?? (m.capabilities.embedding || m.capabilities.rerank || m.capabilities.decision ? m.pricing.inputPer1M
      : m.pricing.perImage ?? m.pricing.imageOutputPer1M ?? m.pricing.outputPer1M);

  // ---- header ----
  const live = catalog.models.filter((m) => !m.hidden);
  $("n-models").textContent = new Set(live.map((m) => m.family)).size;
  $("n-routes").textContent = live.length;
  $("n-makers").textContent = new Set(live.map((m) => m.maker)).size;
  $("updated").textContent = new Date(catalog.updatedAt).toLocaleDateString("en-CA", { timeZone: "UTC" });
  $("updated").title = catalog.updatedAt;
  $("copy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText("https://models.opspresso.com/models.json");
      $("copy").classList.add("light"); setTimeout(() => $("copy").classList.remove("light"), 1200);
    } catch {}
  });
  for (const p of catalog.providers) {
    const o = document.createElement("option"); o.value = p; o.textContent = p; $("provider").append(o);
  }

  // ---- state: the console's ModelTableState, kept in localStorage the same
  // way (`useLocalStorage`), so the page opens the way it was left. The search
  // text is deliberately not kept — the console does not keep it either.
  const STORAGE_KEY = "agent-models.viewer-state.v1";
  const CAPS = new Set(CAPABILITY_COLUMNS.map(([k]) => k));
  const SORT_KEYS = new Set(["provider", "name", "price"]);
  const state = { provider: "", type: "", capabilities: new Set(), sortKey: "provider", direction: "asc", filter: "", retired: false };
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (stored && typeof stored === "object") {
      if (typeof stored.provider === "string" && catalog.providers.includes(stored.provider)) state.provider = stored.provider;
      if (typeof stored.type === "string" && MODEL_TYPES.has(stored.type)) state.type = stored.type;
      if (Array.isArray(stored.capabilities)) for (const c of stored.capabilities) if (CAPS.has(c)) state.capabilities.add(c);
      if (SORT_KEYS.has(stored.sortKey)) state.sortKey = stored.sortKey;
      if (stored.direction === "desc") state.direction = "desc";
      if (stored.retired === true) state.retired = true;
    }
  } catch {}
  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        provider: state.provider, type: state.type, capabilities: [...state.capabilities], sortKey: state.sortKey, direction: state.direction, retired: state.retired,
      }));
    } catch {}
  }
  // Reflect the restored state in the controls.
  $("provider").value = state.provider;
  $("type").value = state.type;
  $("retired").checked = state.retired;
  for (const c of document.querySelectorAll("input[data-cap]")) c.checked = state.capabilities.has(c.dataset.cap);
  const sortButtons = [...$("sort").querySelectorAll("button")];
  const CHEVRON = { asc: "↑", desc: "↓" };
  function paintSort() {
    for (const b of sortButtons) {
      const active = b.dataset.key === state.sortKey;
      b.classList.toggle("light", active);
      b.setAttribute("aria-pressed", String(active));
      b.textContent = `${b.dataset.key === "provider" ? "Provider" : b.dataset.key === "name" ? "Model" : "Price"}${active ? ` ${CHEVRON[state.direction]}` : ""}`;
    }
  }
  for (const b of sortButtons) b.addEventListener("click", () => {
    const key = b.dataset.key;
    state.direction = state.sortKey === key && state.direction === "asc" ? "desc" : "asc";
    state.sortKey = key;
    paintSort(); persist(); render();
  });

  // ---- render ----
  function visibleRows() {
    const needle = state.filter.trim().toLowerCase();
    const rows = catalog.models.filter((m) =>
      (state.retired || !m.hidden) &&
      (state.provider === "" || m.provider === state.provider) &&
      (state.type === "" || modelType(m) === state.type) &&
      [...state.capabilities].every((c) => m.capabilities[c] === true) &&
      (needle === "" || [m.id, m.displayName, m.provider, makerLabel(m.maker), m.wireId ?? ""].some((f) => f.toLowerCase().includes(needle))),
    );
    const dir = state.direction === "asc" ? 1 : -1;
    return rows.sort((a, b) => {
      const c = state.sortKey === "provider" ? a.provider.localeCompare(b.provider)
        : state.sortKey === "name" ? a.displayName.localeCompare(b.displayName)
        : primaryPrice(a) - primaryPrice(b);
      return c !== 0 ? c * dir : a.id.localeCompare(b.id);
    });
  }

  function card(m) {
    // A maker without a listed SVG gets initials; the delegated listener
    // uses the same fallback if a listed image fails to load.
    const mark = Object.hasOwn(icons, m.maker)
      ? `<span class="mark" title="${esc(makerLabel(m.maker))}"><img src="icons/brands/${esc(icons[m.maker])}" alt="${esc(makerLabel(m.maker))} logo" width="24" height="24" data-initials="${esc(makerInitials(m.maker))}"></span>`
      : `<span class="mark initials" title="${esc(makerLabel(m.maker))}">${esc(makerInitials(m.maker))}</span>`;
    // The route is a gateway when its provider is not the model's maker.
    const routed = m.provider !== m.maker;
    const providerBadge = m.hidden
      ? `<span class="badge neutral">${esc(m.provider)} · retired</span>`
      : `<span class="badge ${routed ? "router" : "on"}">${esc(m.provider)}${routed ? " · router" : ""}</span>`;
    const type = modelType(m);
    const typeBadge = `<span class="badge type-${type}">${typeLabel(type)}</span>`;
    const caps = CAPABILITY_COLUMNS.filter(([k]) => m.capabilities[k]).map(([, l]) => `<span class="badge outline">${l}</span>`).join("");
    const d = m.pricing.discount;
    const listDivisor = 1 - (d ?? 0);
    const promoList = m.pricing.perSearch !== undefined
      ? `${formatUsd(m.pricing.perSearch / listDivisor)} / search`
      : m.pricing.perAudioMinute !== undefined
        ? `${formatUsd(m.pricing.perAudioMinute / listDivisor)} / audio minute`
      : m.capabilities.embedding || m.capabilities.rerank || m.capabilities.decision
      ? `${formatUsd(m.pricing.inputPer1M / listDivisor)} in per 1M`
      : `${formatUsd(m.pricing.inputPer1M / listDivisor)} in · ${formatUsd((m.pricing.imageOutputPer1M ?? m.pricing.outputPer1M) / listDivisor)} out per 1M`;
    const promo = d ? `<span class="badge promo" title="Promotional rate at the route's default endpoint: ${Math.round(d * 100)}% off — list ${promoList}">−${Math.round(d * 100)}%</span>` : "";
    const routes = otherRoutes(m);
    const cached = m.pricing.cachedInputPer1M !== undefined && !m.capabilities.imageGeneration ? `cached ${formatUsd(m.pricing.cachedInputPer1M)}` : "";
    const wire = m.wireId ? `<code title="Sent to ${esc(m.provider)} as ${esc(m.wireId)}">${esc(m.wireId)}</code>` : "<span></span>";
    return `<article class="card${m.hidden ? " retired" : ""}">
      <div>
        <div class="top">
          ${mark}
          <div class="name">
            <div class="dn" title="${esc(m.displayName)}">${esc(m.displayName)}</div>
            <div class="id" title="${esc(m.id)}">${esc(m.id)}</div>
          </div>
        </div>
        <div class="badges">${providerBadge}${typeBadge}${caps}</div>
        <div class="price"><span>${esc(modelPriceLabel(m))}</span>${promo}</div>
        <div class="ctx">${esc(contextWindowLabel(m))}${cached ? ` · ${cached}` : ""}</div>
        ${routes.length ? `<div class="also">also via ${routes.map(esc).join(", ")}</div>` : ""}
      </div>
      <div class="foot">${wire}<span>${esc(makerLabel(m.maker))}</span></div>
    </article>`;
  }

  // `error` does not bubble, so the grid listens in the capture phase; one
  // listener outlives every innerHTML rewrite below.
  $("grid").addEventListener("error", (e) => {
    const img = e.target;
    if (img instanceof HTMLImageElement && img.parentElement?.classList.contains("mark") && img.dataset.initials !== undefined) {
      img.parentElement.classList.add("initials");
      img.replaceWith(document.createTextNode(img.dataset.initials));
    }
  }, true);

  function render() {
    const rows = visibleRows();
    $("grid").innerHTML = rows.length ? rows.map(card).join("") : `<div class="empty" style="grid-column:1/-1">No model matches — clear the filters or widen the selection.</div>`;
    $("count").textContent = `${rows.length} ${rows.length === 1 ? "model" : "models"}`;
  }

  $("q").addEventListener("input", (e) => { state.filter = e.target.value; render(); });
  $("provider").addEventListener("change", (e) => { state.provider = e.target.value; persist(); render(); });
  $("type").addEventListener("change", (e) => { state.type = e.target.value; persist(); render(); });
  $("retired").addEventListener("change", (e) => { state.retired = e.target.checked; persist(); render(); });
  for (const c of document.querySelectorAll("input[data-cap]")) c.addEventListener("change", (e) => {
    if (e.target.checked) state.capabilities.add(e.target.dataset.cap); else state.capabilities.delete(e.target.dataset.cap);
    persist(); render();
  });
  paintSort();
  render();
})();
