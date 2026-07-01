'use strict';

const SITE_LABELS = {
  youtube: 'YouTube',
  x: 'X',
  instagram: 'Instagram'
};

const CONDITION_LABELS = {
  A: '条件A：称賛のみ',
  B: '条件B：称賛＋学習導線'
};

const settingsForm = document.getElementById('settings-form');
const taskUrlInput = document.getElementById('task-url');
const settingsStatus = document.getElementById('settings-status');
const conditionStatus = document.getElementById('condition-status');
const conditionBadge = document.getElementById('current-condition-badge');
const currentBehavior = document.getElementById('current-behavior');
const summary = document.getElementById('summary');
const conditionResults = document.getElementById('condition-results');
const siteResults = document.getElementById('site-results');
const resultsEmpty = document.getElementById('results-empty');
const resultsStatus = document.getElementById('results-status');
const deleteLogsButton = document.getElementById('delete-logs');

initialize().catch((error) => {
  setStatus(resultsStatus, `読み込みに失敗しました: ${error.message}`, 'error');
});

document.querySelectorAll('input[name="experiment-condition"]').forEach((radio) => {
  radio.addEventListener('change', async () => {
    if (!radio.checked) {
      return;
    }

    const condition = normalizeCondition(radio.value);
    await chrome.storage.local.set({
      experimentCondition: condition,
      conditionChangedAt: new Date().toISOString()
    });
    renderCurrentCondition(condition);
    setStatus(conditionStatus, `${CONDITION_LABELS[condition]}に切り替えました。次に開くSNSから適用されます。`, 'success');
  });
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
  if (areaName !== 'local') {
    return;
  }

  if (changes.logs) {
    renderResults(Array.isArray(changes.logs.newValue) ? changes.logs.newValue : []);
  }

  if (changes.experimentCondition) {
    renderCurrentCondition(normalizeCondition(changes.experimentCondition.newValue));
  }
});

async function initialize() {
  const {
    taskUrl = '',
    logs = [],
    experimentCondition = 'B'
  } = await chrome.storage.local.get(['taskUrl', 'logs', 'experimentCondition']);

  const condition = normalizeCondition(experimentCondition);
  taskUrlInput.value = typeof taskUrl === 'string' ? taskUrl : '';
  document.querySelector(`input[name="experiment-condition"][value="${condition}"]`).checked = true;
  renderCurrentCondition(condition);
  renderResults(Array.isArray(logs) ? logs : []);
}

function renderCurrentCondition(condition) {
  const normalized = normalizeCondition(condition);
  conditionBadge.textContent = normalized === 'A' ? '条件A' : '条件B';
  currentBehavior.textContent = normalized === 'A'
    ? '現在は条件Aです。「やめる」を選ぶと「流石です！」だけを表示して終了します。'
    : '現在は条件Bです。「流石です！」の後に、課題ページへの小さな導線を表示します。';

  const radio = document.querySelector(`input[name="experiment-condition"][value="${normalized}"]`);
  if (radio) {
    radio.checked = true;
  }
}

function renderResults(logs) {
  const validLogs = logs.filter(isValidLog).map(normalizeLegacyLog);
  const overall = calculateStats(validLogs);

  summary.innerHTML = [
    metricCard('介入後に選択した', overall.total, '条件A・Bの合計'),
    metricCard('SNSを開かずにやめた', overall.dismissCount, formatPercent(overall.dismissRate)),
    metricCard('学習導線を表示した', overall.promptCount, '条件Bで表示された回数'),
    metricCard('課題ページを開いた', overall.taskCount, '条件Bで発生した学習着手')
  ].join('');

  conditionResults.innerHTML = ['A', 'B']
    .map((condition) => conditionCard(condition, calculateStats(validLogs.filter((log) => log.condition === condition))))
    .join('');

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
    dismissRate: safeDivide(dismissCount, total),
    taskRate: safeDivide(taskCount, dismissCount)
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

function conditionCard(condition, stats) {
  const isA = condition === 'A';
  return `
    <article class="condition-result-card">
      <h4>${escapeHtml(CONDITION_LABELS[condition])}</h4>
      <p class="condition-result-description">${isA ? '成功後に学習導線を出さない' : '成功後に課題ページへの導線を出す'}</p>
      <dl class="site-stats">
        ${siteStat('選択合計', `${stats.total}回`)}
        ${siteStat('SNS停止率', `${formatPercent(stats.dismissRate)}（${stats.dismissCount}回）`)}
        ${isA ? '' : siteStat('課題ページを開いた', `${stats.taskCount}回（着手率 ${formatPercent(stats.taskRate)}）`)}
      </dl>
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
    condition: normalizeCondition(log.condition),
    studyPromptShown: log.studyPromptShown === true,
    openedTask: log.openedTask === true || log.startedTask === true
  };
}

function normalizeCondition(value) {
  return value === 'A' ? 'A' : 'B';
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
