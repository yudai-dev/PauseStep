'use strict';

const SITE_LABELS = {
  youtube: 'YouTube',
  x: 'X',
  instagram: 'Instagram'
};

const settingsForm = document.getElementById('settings-form');
const taskUrlInput = document.getElementById('task-url');
const settingsStatus = document.getElementById('settings-status');
const summary = document.getElementById('summary');
const siteResults = document.getElementById('site-results');
const resultsEmpty = document.getElementById('results-empty');
const resultsStatus = document.getElementById('results-status');
const deleteLogsButton = document.getElementById('delete-logs');

initialize().catch((error) => {
  setStatus(resultsStatus, `読み込みに失敗しました: ${error.message}`, 'error');
});

settingsForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearStatus(settingsStatus);

  const rawValue = taskUrlInput.value.trim();
  const normalizedUrl = normalizeHttpUrl(rawValue);

  if (!normalizedUrl) {
    setStatus(settingsStatus, 'http:// または https:// から始まる正しいURLを入力してください。', 'error');
    taskUrlInput.focus();
    return;
  }

  await chrome.storage.local.set({ taskUrl: normalizedUrl });
  taskUrlInput.value = normalizedUrl;
  setStatus(settingsStatus, '課題URLを保存しました。', 'success');
});

deleteLogsButton.addEventListener('click', async () => {
  const confirmed = window.confirm('保存されている選択結果をすべて削除しますか？');
  if (!confirmed) {
    return;
  }

  await chrome.storage.local.set({ logs: [] });
  setStatus(resultsStatus, '選択結果を削除しました。', 'success');
  renderResults([]);
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes.logs) {
    renderResults(Array.isArray(changes.logs.newValue) ? changes.logs.newValue : []);
  }
});

async function initialize() {
  const { taskUrl = '', logs = [] } = await chrome.storage.local.get(['taskUrl', 'logs']);
  taskUrlInput.value = typeof taskUrl === 'string' ? taskUrl : '';
  renderResults(Array.isArray(logs) ? logs : []);
}

function renderResults(logs) {
  const validLogs = logs.filter(isValidLog).map(normalizeLegacyLog);
  const overall = calculateStats(validLogs);

  summary.innerHTML = [
    metricCard('介入後に選択した', overall.total, '最初の選択が完了した回数'),
    metricCard('SNSを開かずにやめた', overall.dismissCount, formatPercent(overall.dismissRate)),
    metricCard('学習導線を表示した', overall.promptCount, '成功後、通常ページの右上に表示'),
    metricCard('課題ページを開いた', overall.taskCount, '追加でできた小さな一歩')
  ].join('');

  siteResults.innerHTML = Object.entries(SITE_LABELS)
    .map(([siteId, label]) => {
      const stats = calculateStats(validLogs.filter((log) => log.site === siteId));
      return siteCard(label, stats);
    })
    .join('');

  resultsEmpty.hidden = validLogs.length !== 0;
  deleteLogsButton.disabled = validLogs.length === 0;
}

function calculateStats(logs) {
  const total = logs.length;
  const openCount = logs.filter((log) => log.firstChoice === 'open_site').length;
  const dismissCount = logs.filter((log) => log.firstChoice === 'dismiss_site').length;
  const promptCount = logs.filter((log) => log.studyPromptShown === true).length;
  const taskCount = logs.filter((log) => log.openedTask === true).length;

  return {
    total,
    openCount,
    dismissCount,
    promptCount,
    taskCount,
    openRate: safeDivide(openCount, total),
    dismissRate: safeDivide(dismissCount, total)
  };
}

function metricCard(label, value, detail) {
  return `
    <article class="metric-card">
      <p class="metric-label">${escapeHtml(label)}</p>
      <p class="metric-value">${value}回</p>
      <p class="metric-detail">${escapeHtml(detail)}</p>
    </article>
  `;
}

function siteCard(label, stats) {
  return `
    <article class="site-card">
      <h4>${escapeHtml(label)}</h4>
      <dl class="site-stats">
        ${siteStat('選択合計', `${stats.total}回`)}
        ${siteStat('サイトを開いた', `${stats.openCount}回（${formatPercent(stats.openRate)}）`)}
        ${siteStat('開くのをやめた', `${stats.dismissCount}回（${formatPercent(stats.dismissRate)}）`)}
        ${siteStat('課題ページを開いた', `${stats.taskCount}回`)}
      </dl>
    </article>
  `;
}

function siteStat(label, value) {
  return `
    <div class="site-stat">
      <dt>${escapeHtml(label)}</dt>
      <dd>${escapeHtml(value)}</dd>
    </div>
  `;
}

function isValidLog(log) {
  return Boolean(
    log &&
    typeof log === 'object' &&
    typeof log.site === 'string' &&
    (log.firstChoice === 'open_site' || log.firstChoice === 'dismiss_site')
  );
}

function normalizeLegacyLog(log) {
  return {
    ...log,
    studyPromptShown: log.studyPromptShown === true,
    openedTask: log.openedTask === true || log.startedTask === true
  };
}

function normalizeHttpUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    return null;
  }

  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

function safeDivide(numerator, denominator) {
  return denominator === 0 ? 0 : numerator / denominator;
}

function formatPercent(value) {
  return `${Math.round(value * 100)}%`;
}

function setStatus(element, message, kind) {
  element.textContent = message;
  element.dataset.kind = kind;
}

function clearStatus(element) {
  element.textContent = '';
  delete element.dataset.kind;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
