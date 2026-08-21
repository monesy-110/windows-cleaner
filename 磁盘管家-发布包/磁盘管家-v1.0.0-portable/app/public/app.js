const state = {
  drives: [],
  selectedDrive: null,
  categories: [],
  selected: new Set(),
  scanId: null,
  scannedAt: null,
  filter: "all",
  search: "",
  loading: false,
  systemStatus: null,
};

const riskInfo = {
  safe: { label: "推荐", icon: "ph-check-circle" },
  review: { label: "需注意", icon: "ph-warning-circle" },
  destructive: { label: "永久删除", icon: "ph-trash" },
  analysis: { label: "只分析", icon: "ph-eye" },
};

const groupIcons = {
  system: "ph-windows-logo",
  diagnostics: "ph-bug",
  graphics: "ph-cube",
  browser: "ph-browser",
  apps: "ph-app-window",
  development: "ph-terminal-window",
  gaming: "ph-game-controller",
  drive: "ph-hard-drive",
};

const elements = Object.fromEntries([
  "appFrame", "cleanup", "safetyView", "impactPanel", "shortcutButton", "downloadLauncher", "themeToggle", "appFavicon", "brandIcon", "scanButton", "scanNote", "searchInput", "driveTabs", "driveLetter", "driveLabel",
  "driveFileSystem", "capacityFill", "usedSpace", "freeSpace", "totalReclaimable", "inventorySummary",
  "statusUpdated", "diskHealthList", "recommendationList",
  "riskFilters", "cleanupList", "planTitle", "planDrive", "planState", "selectedSize", "selectedCount",
  "riskSummary", "planItems", "openConfirm", "confirmDialog", "confirmForm", "confirmSummary", "safetyCheckButton", "safetyOverviewState", "safetyAuditStatus", "safetyAuditGrid",
  "confirmImpacts", "confirmationInput", "dialogError", "cancelConfirm", "confirmClean", "mobilePlanCount",
  "mobilePlanSize", "mobilePlanBar", "mobileConfirm", "toast",
].map((id) => [id, document.querySelector(`#${id}`)]));

const skinOptions = [...document.querySelectorAll(".skin-option")];
const ruleToggles = [...document.querySelectorAll("[data-rule-toggle]")];

const themeMedia = window.matchMedia?.("(prefers-color-scheme: dark)");

function setTheme(theme, persist = true) {
  const next = theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = next;
  if (persist) window.localStorage.setItem("c-drive-steward-theme", next);
  const lightMode = next === "light";
  elements.themeToggle.querySelector("i").className = `ph ${lightMode ? "ph-moon" : "ph-sun"}`;
  elements.themeToggle.querySelector("span").textContent = lightMode ? "切换夜间模式" : "切换日间模式";
  elements.themeToggle.title = lightMode ? "切换夜间模式" : "切换日间模式";
  elements.themeToggle.setAttribute("aria-label", elements.themeToggle.title);
  const iconPath = lightMode ? "/app-icon-light.png" : "/app-icon.png";
  elements.appFavicon.href = `${iconPath}?v=20260821.5`;
  elements.brandIcon.src = `${iconPath}?v=20260821.5`;
}

function initializeTheme() {
  const saved = window.localStorage.getItem("c-drive-steward-theme");
  setTheme(saved || (themeMedia?.matches ? "dark" : "light"), false);
}

function setSkin(skin, persist = true) {
  const next = ["green", "blue", "red", "violet"].includes(skin) ? skin : "green";
  document.documentElement.dataset.skin = next;
  if (persist) window.localStorage.setItem("c-drive-steward-skin", next);
  skinOptions.forEach((option) => {
    const active = option.dataset.skin === next;
    option.classList.toggle("is-active", active);
    option.setAttribute("aria-selected", String(active));
  });
}

function initializeSkin() {
  setSkin(window.localStorage.getItem("c-drive-steward-skin") || "green", false);
}

function formatBytes(bytes) {
  const value = Math.max(0, Number(bytes) || 0);
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length);
  const amount = value / (1024 ** index);
  return `${amount.toLocaleString("zh-CN", { maximumFractionDigits: amount >= 10 ? 0 : 1 })} ${units[index - 1]}`;
}

function formatTime(value) {
  return value ? new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(new Date(value)) : "尚未扫描";
}

function selectedCategories() {
  return state.categories.filter((category) => state.selected.has(category.id));
}

function totalEligible(categories = state.categories) {
  return categories.reduce((sum, category) => sum + (category.analysisOnly ? 0 : category.eligibleBytes), 0);
}

function categoryEnabled(category) {
  return category.available && !category.analysisOnly && !category.blocked && category.eligibleBytes > 0;
}

function visibleCategories() {
  const query = state.search.trim().toLocaleLowerCase("zh-CN");
  return state.categories.filter((category) => {
    const matchesRisk = state.filter === "all" || category.risk === state.filter;
    const haystack = `${category.name} ${category.detail} ${category.impact} ${category.groupLabel}`.toLocaleLowerCase("zh-CN");
    return matchesRisk && (!query || haystack.includes(query));
  });
}

function applyFilter(filter) {
  state.filter = filter;
  elements.riskFilters.querySelectorAll("[data-filter]").forEach((item) => item.classList.toggle("is-active", item.dataset.filter === filter));
  renderCategories();
}

function renderDrives() {
  elements.driveTabs.innerHTML = state.drives.map((drive) => {
    const active = drive.letter === state.selectedDrive?.letter;
    return `<button class="drive-tab ${active ? "is-active" : ""}" type="button" role="tab" aria-selected="${active}" data-drive="${drive.letter}">
      <i class="ph ${drive.system ? "ph-windows-logo" : "ph-hard-drive"}" aria-hidden="true"></i>
      <strong>${drive.letter}:</strong><small>${formatBytes(drive.free)} 可用</small>
    </button>`;
  }).join("");

  elements.driveTabs.querySelectorAll("[data-drive]").forEach((button) => {
    button.addEventListener("click", () => {
      if (!state.loading && button.dataset.drive !== state.selectedDrive?.letter) scan(button.dataset.drive);
    });
  });
}

function renderDriveSummary() {
  const drive = state.selectedDrive;
  if (!drive) return;
  const ratio = drive.total > 0 ? Math.min(1, Math.max(0, drive.used / drive.total)) : 0;
  elements.driveLetter.textContent = `${drive.letter}:`;
  elements.driveLabel.textContent = drive.system ? `${drive.label}（系统盘）` : drive.label;
  elements.driveFileSystem.textContent = drive.filesystem || "文件系统未知";
  elements.capacityFill.style.setProperty("--used-ratio", String(ratio));
  elements.usedSpace.textContent = `已使用 ${formatBytes(drive.used)}`;
  elements.freeSpace.textContent = `可用 ${formatBytes(drive.free)}`;
  elements.totalReclaimable.textContent = formatBytes(totalEligible());
  elements.planDrive.textContent = `${drive.letter}: ${drive.label}`;
}

function renderSystemStatus(data) {
  state.systemStatus = data;
  elements.statusUpdated.textContent = data.observedAt ? `更新于 ${formatTime(data.observedAt)}` : "状态未知";

  elements.diskHealthList.innerHTML = (data.drives || []).length === 0
    ? '<div class="status-placeholder">没有读取到固定磁盘状态。</div>'
    : data.drives.map((drive) => `<article class="disk-health-row">
        <div class="disk-health-drive"><i class="ph ${drive.system ? "ph-windows-logo" : "ph-hard-drive"}" aria-hidden="true"></i><strong>${drive.letter}:</strong><span>${drive.label || "本地磁盘"}</span></div>
        <div class="disk-health-meter"><span style="--disk-ratio:${Math.max(0, Math.min(1, Number(drive.total) ? drive.used / drive.total : 0))}"></span></div>
        <div class="disk-health-copy"><span>${formatBytes(drive.free)} 可用</span><small>${drive.healthStatus || "未知卷健康"}</small></div>
        <span class="disk-status-badge ${drive.status || "check"}"><i class="ph ${drive.status === "good" ? "ph-check-circle" : drive.status === "pressure" ? "ph-warning-circle" : "ph-warning"}" aria-hidden="true"></i>${drive.label === "" ? "状态未知" : (drive.statusLabel || (drive.status === "good" ? "状态良好" : drive.status === "pressure" ? "空间紧张" : "需要检查"))}</span>
      </article>`).join("");

  elements.recommendationList.innerHTML = (data.recommendations || []).map((item) => `<article class="recommendation-row">
    <i class="ph ${item.icon || "ph-info"}" aria-hidden="true"></i><div><strong>${item.title}</strong><p>${item.detail}</p><small><b>潜在影响：</b>${item.risk}</small></div>
  </article>`).join("") || '<div class="status-placeholder">暂时没有建议。</div>';
}

async function loadSystemStatus() {
  try {
    const response = await fetch("/api/system-status", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "无法读取磁盘状态。");
    renderSystemStatus(data);
  } catch (error) {
    elements.statusUpdated.textContent = "状态读取失败";
    elements.diskHealthList.innerHTML = `<div class="status-placeholder is-error"><i class="ph ph-warning-circle"></i>${error.message || "无法连接到本地服务。"}</div>`;
    elements.recommendationList.innerHTML = '<div class="status-placeholder">请先启动本地服务，再重新扫描。</div>';
  }
}

function groupByCategory(categories) {
  return categories.reduce((groups, category) => {
    const current = groups.get(category.group) ?? [];
    current.push(category);
    groups.set(category.group, current);
    return groups;
  }, new Map());
}

function categoryStatus(category) {
  if (!category.available) return "未发现";
  if (category.analysisOnly) return "仅显示大小";
  if (category.blocked) return `先关闭 ${category.blockers.join(" / ")}`;
  if (category.partial) return "至少可清理";
  if (category.failed > 0) return "部分目录受限";
  if (category.recentProtected > 0) return `已保护 ${category.recentProtected} 个近期文件`;
  return `${category.eligibleFiles.toLocaleString("zh-CN")} 个文件`;
}

function renderCategories() {
  if (state.loading && state.categories.length === 0) {
    elements.cleanupList.innerHTML = '<div class="skeleton-group" aria-label="正在扫描清理项目"></div>';
    return;
  }

  const visible = visibleCategories();
  if (visible.length === 0) {
    elements.cleanupList.innerHTML = '<div class="empty-state"><i class="ph ph-magnifying-glass"></i><p>没有匹配的清理项目。</p></div>';
    return;
  }

  elements.cleanupList.innerHTML = [...groupByCategory(visible).entries()].map(([group, categories]) => `
    <section class="category-group" aria-labelledby="group-${group}">
      <header class="group-heading">
        <div><i class="ph ${groupIcons[group] || "ph-folder"}" aria-hidden="true"></i><h3 id="group-${group}">${categories[0].groupLabel}</h3></div>
        <span>${categories.length} 项</span>
      </header>
      ${categories.map((category) => {
        const selected = state.selected.has(category.id);
        const enabled = categoryEnabled(category);
        const info = riskInfo[category.risk];
        const size = category.partial ? `至少 ${formatBytes(category.eligibleBytes)}` : formatBytes(category.eligibleBytes);
        return `<article class="category-row ${selected ? "is-selected" : ""} ${enabled ? "" : "is-disabled"}">
          <input id="category-${category.id}" type="checkbox" data-category-id="${category.id}" ${selected ? "checked" : ""} ${enabled ? "" : "disabled"} />
          <label class="category-check" for="category-${category.id}" aria-hidden="true"><i class="ph ph-check"></i></label>
          <label class="category-name" for="category-${category.id}"><strong>${category.name}</strong><span>${category.detail}</span></label>
          <div class="category-impact"><i class="ph ph-arrow-bend-down-right"></i><span>${category.impact}</span></div>
          <div class="category-meta"><strong class="category-size">${category.analysisOnly ? formatBytes(category.bytes) : size}</strong><span class="risk-label ${category.risk}"><i class="ph ${info.icon}"></i>${info.label}</span><span class="category-sub">${categoryStatus(category)}</span></div>
        </article>`;
      }).join("")}
    </section>`).join("");

  elements.cleanupList.querySelectorAll("input[data-category-id]").forEach((input) => {
    input.addEventListener("change", () => {
      if (input.checked) state.selected.add(input.dataset.categoryId);
      else state.selected.delete(input.dataset.categoryId);
      renderCategories();
      renderPlan();
    });
  });
}

function renderRiskSummary(selected) {
  const counts = selected.reduce((value, category) => {
    value[category.risk] = (value[category.risk] || 0) + 1;
    return value;
  }, {});
  elements.riskSummary.innerHTML = ["safe", "review", "destructive"].map((risk) => `
    <div class="risk-cell"><span>${riskInfo[risk].label}</span><strong>${counts[risk] || 0}</strong></div>`).join("");
}

function renderPlan() {
  const selected = selectedCategories();
  const size = totalEligible(selected);
  elements.selectedCount.textContent = `${selected.length} 项`;
  elements.selectedSize.textContent = formatBytes(size);
  elements.openConfirm.disabled = selected.length === 0 || state.loading || !state.scanId;
  elements.mobileConfirm.disabled = elements.openConfirm.disabled;
  elements.mobilePlanCount.textContent = `${selected.length} 项`;
  elements.mobilePlanSize.textContent = formatBytes(size);
  elements.planState.textContent = selected.length > 0 ? "可核对" : "未选择";
  elements.planState.classList.toggle("is-ready", selected.length > 0);
  renderRiskSummary(selected);

  if (selected.length === 0) {
    elements.planItems.innerHTML = '<li class="empty-impact">选择清理项目后，这里会逐项列出实际影响。</li>';
    return;
  }
  elements.planItems.innerHTML = selected.map((category) => `<li><span>${category.impact}</span><strong>${formatBytes(category.eligibleBytes)}</strong></li>`).join("");
}

function setLoading(loading, label = "正在扫描") {
  state.loading = loading;
  elements.scanButton.disabled = loading;
  elements.scanButton.classList.toggle("is-loading", loading);
  elements.scanNote.textContent = loading ? label : `扫描于 ${formatTime(state.scannedAt)}`;
  renderPlan();
}

let toastTimer;
function showToast(message, error = false) {
  window.clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.toggle("is-error", error);
  elements.toast.classList.add("is-visible");
  toastTimer = window.setTimeout(() => elements.toast.classList.remove("is-visible"), 4600);
}

function viewFromLocation() {
  const hash = window.location.hash;
  if (hash === "#safety") return "safety";
  if (hash === "#dashboard") return "dashboard";
  if (hash === "#quick-clean") return "quick-clean";
  return "cleanup";
}

function setView(view) {
  const safetyOpen = view === "safety";
  const cleanupView = ["cleanup", "dashboard", "quick-clean"].includes(view) ? view : "cleanup";
  elements.appFrame.classList.toggle("is-safety-view", safetyOpen);
  elements.appFrame.classList.toggle("is-dashboard-view", cleanupView === "dashboard");
  elements.appFrame.classList.toggle("is-quick-clean-view", cleanupView === "quick-clean");
  elements.cleanup.hidden = safetyOpen;
  elements.safetyView.hidden = !safetyOpen;
  elements.impactPanel.hidden = safetyOpen;
  elements.mobilePlanBar.hidden = safetyOpen;
  document.querySelectorAll("[data-view]").forEach((item) => {
    const active = item.dataset.view === cleanupView || item.dataset.view === view;
    item.classList.toggle("is-active", active);
    if (active) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
  });
  document.title = safetyOpen ? "安全规则 | 磁盘管家" : cleanupView === "dashboard" ? "磁盘仪表盘 | 磁盘管家" : cleanupView === "quick-clean" ? "小白清理 | 磁盘管家" : "磁盘管家 | 本地安全清理";
  if (!safetyOpen && !state.loading && !state.scannedAt) {
    scan();
    loadSystemStatus();
  }
  if (!safetyOpen) {
    window.requestAnimationFrame(() => {
      const target = cleanupView === "dashboard" ? document.querySelector(".system-status") : cleanupView === "quick-clean" ? document.querySelector(".inventory") : null;
      if (!target) return;
      if (cleanupView === "quick-clean") {
        applyFilter("safe");
      }
      target.scrollIntoView({ behavior: "auto", block: "start" });
      showToast(cleanupView === "dashboard" ? "已打开磁盘仪表盘：查看各个磁盘容量状态。" : "小白清理已筛选推荐项目，确认影响后再清理。", false);
    });
  } else {
    window.requestAnimationFrame(() => {
      const previousBehavior = document.documentElement.style.scrollBehavior;
      document.documentElement.style.scrollBehavior = "auto";
      window.scrollTo(0, 0);
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;
      document.documentElement.style.scrollBehavior = previousBehavior;
      window.setTimeout(() => {
        const delayedBehavior = document.documentElement.style.scrollBehavior;
        document.documentElement.style.scrollBehavior = "auto";
        window.scrollTo(0, 0);
        document.documentElement.scrollTop = 0;
        document.body.scrollTop = 0;
        document.documentElement.style.scrollBehavior = delayedBehavior;
      }, 80);
    });
  }
}

async function scan(driveLetter = state.selectedDrive?.letter) {
  setLoading(true, driveLetter ? `正在扫描 ${driveLetter}:` : "正在发现磁盘");
  if (state.categories.length === 0) renderCategories();
  try {
    const url = new URL("/api/scan", window.location.origin);
    if (driveLetter) url.searchParams.set("drive", driveLetter);
    const response = await fetch(url, { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "扫描未完成。");
    state.drives = data.drives;
    state.selectedDrive = data.selectedDrive;
    state.categories = data.categories;
    state.scanId = data.scanId;
    state.scannedAt = data.scannedAt;
    state.selected = new Set(data.categories.filter((category) => category.defaultChecked && categoryEnabled(category)).map((category) => category.id));
    renderDrives();
    renderDriveSummary();
    if (viewFromLocation() === "quick-clean") applyFilter("safe");
    renderCategories();
    renderPlan();
    const found = data.categories.filter((category) => category.available).length;
    elements.inventorySummary.textContent = `发现 ${found} 个有数据的项目。最近 24 小时文件按分类自动保护。`;
    loadSystemStatus();
  } catch (error) {
    state.scanId = null;
    elements.scanNote.textContent = "扫描失败";
    elements.cleanupList.innerHTML = `<div class="empty-state"><i class="ph ph-warning-circle"></i><p>${error.message || "无法连接到本地服务。"}</p></div>`;
    showToast(error.message || "无法连接到本地服务。", true);
  } finally {
    setLoading(false);
  }
}

function openConfirmation() {
  const selected = selectedCategories();
  if (selected.length === 0) return;
  const destructive = selected.some((category) => category.risk === "destructive");
  elements.confirmSummary.innerHTML = `<div><strong>${state.selectedDrive.letter}: ${state.selectedDrive.label}</strong><span>${selected.length} 个清理项目</span></div><div><strong>${formatBytes(totalEligible(selected))}</strong><span>预计最多释放</span></div>`;
  elements.confirmImpacts.innerHTML = selected.map((category) => `<div class="confirm-impact"><i class="ph ${category.risk === "destructive" ? "ph-warning" : "ph-info"}"></i><span><strong>${category.name}：</strong>${category.impact}</span></div>`).join("");
  elements.confirmationInput.value = "";
  elements.dialogError.textContent = destructive ? "计划包含永久删除项目，请确认你不再需要回收站中的文件。" : "";
  elements.confirmClean.disabled = true;
  elements.confirmDialog.showModal();
  elements.confirmationInput.focus();
}

async function runCleanup(event) {
  event.preventDefault();
  if (elements.confirmationInput.value !== "确认清理") return;
  elements.confirmClean.disabled = true;
  elements.confirmClean.querySelector("span").textContent = "正在清理";
  elements.dialogError.textContent = "";
  try {
    const response = await fetch("/api/clean", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Local-Action": "c-drive-steward" },
      body: JSON.stringify({ scanId: state.scanId, categories: selectedCategories().map((category) => category.id), confirmation: elements.confirmationInput.value }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "清理未完成。");
    const failed = data.results.reduce((sum, result) => sum + result.failed, 0);
    const protectedCount = data.results.reduce((sum, result) => sum + result.recentProtected, 0);
    elements.confirmDialog.close();
    showToast(`已释放 ${formatBytes(data.bytesRemoved)}。保留 ${failed + protectedCount} 个占用、受限或近期文件。`);
    await scan(state.selectedDrive.letter);
  } catch (error) {
    elements.dialogError.textContent = error.message || "无法执行清理。";
  } finally {
    elements.confirmClean.querySelector("span").textContent = "执行清理";
    elements.confirmClean.disabled = elements.confirmationInput.value !== "确认清理";
  }
}

async function createShortcut() {
  elements.shortcutButton.disabled = true;
  try {
    const response = await fetch("/api/shortcut", { method: "POST", headers: { "X-Local-Action": "c-drive-steward" } });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "快捷方式创建失败。");
    showToast(`桌面启动文件已创建：${data.name}`);
  } catch (error) {
    showToast(error.message || "快捷方式创建失败。", true);
  } finally {
    elements.shortcutButton.disabled = false;
  }
}

async function downloadDesktopLauncher() {
  elements.downloadLauncher.disabled = true;
  const label = elements.downloadLauncher.querySelector("span");
  const originalLabel = label.textContent;
  label.textContent = "准备下载";
  try {
    const response = await fetch("/api/desktop-launcher", { cache: "no-store" });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || "桌面启动器下载失败。");
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "磁盘管家-桌面启动器.cmd";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast("桌面启动器已下载，可双击运行或放到桌面。");
  } catch (error) {
    showToast(error.message || "桌面启动器下载失败。", true);
  } finally {
    label.textContent = originalLabel;
    elements.downloadLauncher.disabled = false;
  }
}

function renderSafetyAudit(checks, statusText = "已完成") {
  elements.safetyAuditStatus.textContent = statusText;
  elements.safetyAuditGrid.innerHTML = checks.map((check) => `
    <div class="safety-audit-item ${check.ok ? "is-pass" : "is-warn"}">
      <i class="ph ${check.ok ? "ph-check-circle" : "ph-warning-circle"}" aria-hidden="true"></i>
      <div><strong>${check.title}</strong><span>${check.detail}</span></div>
      <b>${check.ok ? "通过" : "需留意"}</b>
    </div>`).join("");
}

async function runSafetyCheck() {
  elements.safetyCheckButton.disabled = true;
  elements.safetyOverviewState.innerHTML = '<i class="ph ph-circle-notch ph-spin" aria-hidden="true"></i>检查中';
  elements.safetyAuditStatus.textContent = "正在检查";
  elements.safetyAuditGrid.innerHTML = '<div class="safety-audit-empty is-loading"><i class="ph ph-circle-notch ph-spin" aria-hidden="true"></i><span>正在读取本机保护状态，不会修改文件或系统设置。</span></div>';
  try {
    const response = await fetch("/api/safety-status", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "安全自检未完成。");
    renderSafetyAudit(data.checks, `检查于 ${formatTime(data.observedAt)}`);
    elements.safetyOverviewState.innerHTML = '<i class="ph ph-check-circle" aria-hidden="true"></i>本机受控';
    showToast("安全自检完成：保护边界仍然有效。");
  } catch (error) {
    elements.safetyOverviewState.innerHTML = '<i class="ph ph-warning-circle" aria-hidden="true"></i>需要检查';
    renderSafetyAudit([{ ok: false, title: "本地服务响应", detail: error.message || "无法读取安全状态，请确认服务仍在运行。" }], "检查失败");
    showToast(error.message || "安全自检未完成。", true);
  } finally {
    elements.safetyCheckButton.disabled = false;
  }
}

elements.scanButton.addEventListener("click", () => scan());
elements.shortcutButton.addEventListener("click", createShortcut);
elements.downloadLauncher.addEventListener("click", downloadDesktopLauncher);
elements.safetyCheckButton.addEventListener("click", runSafetyCheck);
document.querySelectorAll("[data-view]").forEach((item) => item.addEventListener("click", (event) => {
  event.preventDefault();
  const nextView = item.dataset.view;
  const nextHash = item.getAttribute("href");
  if (nextHash && window.location.hash !== nextHash) window.history.pushState({}, "", nextHash);
  setView(nextView);
}));
elements.themeToggle.addEventListener("click", () => setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"));
skinOptions.forEach((option) => option.addEventListener("click", () => {
  setSkin(option.dataset.skin);
  showToast(`已切换到${option.textContent.trim()}皮肤。`);
}));
elements.searchInput.addEventListener("input", () => { state.search = elements.searchInput.value; renderCategories(); });
elements.riskFilters.addEventListener("click", (event) => {
  const button = event.target.closest("[data-filter]");
  if (!button) return;
  state.filter = button.dataset.filter;
  elements.riskFilters.querySelectorAll("[data-filter]").forEach((item) => item.classList.toggle("is-active", item === button));
  renderCategories();
});
elements.openConfirm.addEventListener("click", openConfirmation);
elements.mobileConfirm.addEventListener("click", openConfirmation);
elements.cancelConfirm.addEventListener("click", () => elements.confirmDialog.close());
elements.confirmationInput.addEventListener("input", () => {
  elements.confirmClean.disabled = elements.confirmationInput.value !== "确认清理";
  if (elements.confirmationInput.value === "确认清理") elements.dialogError.textContent = "";
});
elements.confirmForm.addEventListener("submit", runCleanup);

ruleToggles.forEach((toggle) => toggle.addEventListener("click", () => {
  const enabled = toggle.classList.toggle("is-on");
  toggle.setAttribute("aria-pressed", String(enabled));
  const block = toggle.closest(".safety-block");
  block?.setAttribute("data-rule-state", enabled ? "protected" : "review");
  const label = toggle.querySelector("span");
  const icon = toggle.querySelector("i");
  if (label) label.textContent = enabled ? (toggle.dataset.ruleToggle === "limits" ? "限制开启" : "保护开启") : "再次确认";
  if (icon) icon.className = `ph ${enabled ? "ph-lock-key-open" : "ph-eye"}`;
  showToast(enabled ? "保护状态已恢复：服务端边界始终有效。" : "已标记为需再次确认，清理执行仍会继续强制保护。", !enabled);
}));

// A short, localized ripple plus a springy press acknowledges a deliberate
// action without turning the maintenance console into a constantly moving UI.
function addTactileFeedback(event) {
  if (!(event.target instanceof Element)) return;
  const target = event.target.closest("button, .nav-item, .drive-tab, .filter, .category-row, .category-check, .scope-note > summary, .safety-disclosure > summary");
  if (!target || target.matches(":disabled") || target.getAttribute("aria-disabled") === "true") return;
  target.classList.add("is-pressed");
  window.setTimeout(() => target.classList.remove("is-pressed"), 220);

  const rect = target.getBoundingClientRect();
  const ripple = document.createElement("span");
  ripple.className = "ripple";
  ripple.style.left = `${event.clientX - rect.left}px`;
  ripple.style.top = `${event.clientY - rect.top}px`;
  target.append(ripple);
  ripple.addEventListener("animationend", () => ripple.remove(), { once: true });
}

document.addEventListener("pointerdown", addTactileFeedback, { passive: true });
document.addEventListener("pointermove", (event) => {
  if (!(event.target instanceof Element)) return;
  const row = event.target.closest(".category-row");
  if (!row) return;
  const rect = row.getBoundingClientRect();
  row.style.setProperty("--pointer-x", `${event.clientX - rect.left}px`);
  row.style.setProperty("--pointer-y", `${event.clientY - rect.top}px`);
}, { passive: true });

renderRiskSummary([]);
renderPlan();
initializeSkin();
initializeTheme();
window.addEventListener("hashchange", () => setView(viewFromLocation()));
window.addEventListener("popstate", () => setView(viewFromLocation()));
setView(viewFromLocation());
