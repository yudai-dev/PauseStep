'use strict';

const TAB_STATE_PREFIX = 'intervenedTab:';

chrome.runtime.onInstalled.addListener(async () => {
  const {
    taskUrl,
    logs,
    experimentCondition
  } = await chrome.storage.local.get(['taskUrl', 'logs', 'experimentCondition']);
  const defaults = {};

  if (typeof taskUrl !== 'string') {
    defaults.taskUrl = '';
  }

  if (!Array.isArray(logs)) {
    defaults.logs = [];
  }

  if (experimentCondition !== 'A' && experimentCondition !== 'B') {
    defaults.experimentCondition = 'B';
  }

  if (Object.keys(defaults).length > 0) {
    await chrome.storage.local.set(defaults);
  }
});

chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(`${TAB_STATE_PREFIX}${tabId}`).catch(() => {
    // 一時状態の削除失敗は、行動記録には影響しない。
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') {
    return false;
  }

  const handlers = {
    SHOULD_INTERVENE: () => handleShouldIntervene(sender),
    MARK_STUDY_PROMPT_SHOWN: () => handleMarkStudyPromptShown(message),
    OPEN_TASK_FROM_SUCCESS: () => handleOpenTaskFromSuccess(message, sender),
    EXIT_DISMISSED_SITE: () => handleExitDismissedSite(sender),
    CLOSE_CURRENT_TAB: () => handleCloseCurrentTab(sender)
  };

  const handler = handlers[message.type];
  if (!handler) {
    return false;
  }

  handler()
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

async function handleShouldIntervene(sender) {
  const tabId = sender.tab?.id;

  if (!Number.isInteger(tabId)) {
    throw new Error('タブを特定できませんでした。');
  }

  const key = `${TAB_STATE_PREFIX}${tabId}`;
  const state = await chrome.storage.session.get(key);
  const { experimentCondition = 'B' } = await chrome.storage.local.get('experimentCondition');
  const condition = experimentCondition === 'A' ? 'A' : 'B';

  if (state[key] === true) {
    return { ok: true, shouldIntervene: false, condition };
  }

  await chrome.storage.session.set({ [key]: true });
  return { ok: true, shouldIntervene: true, condition };
}

async function handleMarkStudyPromptShown(message) {
  await updateLog(message.logId, (log) => ({
    ...log,
    studyPromptShown: true,
    studyPromptShownAt: log.studyPromptShownAt ?? new Date().toISOString()
  }));

  return { ok: true };
}

async function handleOpenTaskFromSuccess(message, sender) {
  const tabId = sender.tab?.id;
  const { taskUrl = '' } = await chrome.storage.local.get('taskUrl');
  const normalizedUrl = normalizeHttpUrl(taskUrl);

  if (!normalizedUrl) {
    await chrome.runtime.openOptionsPage();
    return {
      ok: false,
      reason: 'TASK_URL_NOT_SET',
      message: '課題URLが未設定です。開いた設定画面でURLを登録してください。'
    };
  }

  await updateLog(message.logId, (log) => ({
    ...log,
    openedTask: true,
    taskOpenedAt: new Date().toISOString()
  }));

  if (!Number.isInteger(tabId) || !Number.isInteger(sender.tab?.windowId)) {
    throw new Error('課題ページを開くタブを特定できませんでした。');
  }

  await chrome.tabs.create({
    url: normalizedUrl,
    active: true,
    windowId: sender.tab.windowId,
    index: sender.tab.index + 1
  });
  await chrome.tabs.remove(tabId);
  return { ok: true };
}

async function handleExitDismissedSite(sender) {
  const currentTab = sender.tab;

  if (!Number.isInteger(currentTab?.id) || !Number.isInteger(currentTab.windowId)) {
    throw new Error('終了するタブを特定できませんでした。');
  }

  const tabsInWindow = await chrome.tabs.query({ windowId: currentTab.windowId });
  const fallbackTab = tabsInWindow.find((tab) => Number.isInteger(tab.id) && tab.id !== currentTab.id);

  if (fallbackTab?.id) {
    await chrome.tabs.update(fallbackTab.id, { active: true });
  } else {
    await chrome.tabs.create({
      url: 'about:blank',
      active: true,
      windowId: currentTab.windowId,
      index: Math.max(0, currentTab.index)
    });
  }

  await chrome.tabs.remove(currentTab.id);
  return { ok: true };
}

async function handleCloseCurrentTab(sender) {
  const tabId = sender.tab?.id;

  if (!Number.isInteger(tabId)) {
    throw new Error('閉じるタブを特定できませんでした。');
  }

  await chrome.tabs.remove(tabId);
  return { ok: true };
}

async function updateLog(logId, updater) {
  if (typeof logId !== 'string' || logId === '') {
    throw new Error('更新する記録を特定できませんでした。');
  }

  const result = await chrome.storage.local.get('logs');
  const logs = Array.isArray(result.logs) ? result.logs : [];
  const index = logs.findIndex((log) => log?.id === logId);

  if (index === -1) {
    throw new Error('更新する記録が見つかりませんでした。');
  }

  logs[index] = updater(logs[index]);
  await chrome.storage.local.set({ logs });
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
