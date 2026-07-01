'use strict';

const TAB_STATE_PREFIX = 'pauseStepTabState:';
const ACTIVE_TAB_PREFIX = 'pauseStepActiveTab:';
const YOUTUBE_ALARM_PREFIX = 'pauseStepYoutube30m:';
const YOUTUBE_INTERVAL_MS = 30 * 60 * 1000;

chrome.runtime.onInstalled.addListener(async () => {
  await ensureDefaults();
  await initializeActiveTabs();
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureDefaults();
  await initializeActiveTabs();
});

chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  handleTabActivated(activeInfo).catch((error) => {
    console.error('[PauseStep] タブ切り替えの処理に失敗しました。', error);
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  handleTabUpdated(tabId, changeInfo, tab).catch((error) => {
    console.error('[PauseStep] タブ更新の処理に失敗しました。', error);
  });
});

chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  cleanupRemovedTab(tabId, removeInfo.windowId).catch(() => {
    // 一時状態の削除失敗は行動ログには影響しない。
  });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  handleYoutubeAlarm(alarm).catch((error) => {
    console.error('[PauseStep] YouTubeの30分介入に失敗しました。', error);
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') {
    return false;
  }

  const handlers = {
    SHOULD_INTERVENE: () => handleShouldIntervene(sender),
    INTERVENTION_RESOLVED: () => handleInterventionResolved(message, sender),
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

async function ensureDefaults() {
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
}

async function initializeActiveTabs() {
  const activeTabs = await chrome.tabs.query({ active: true });
  const values = {};

  for (const tab of activeTabs) {
    if (Number.isInteger(tab.id) && Number.isInteger(tab.windowId)) {
      values[`${ACTIVE_TAB_PREFIX}${tab.windowId}`] = tab.id;
    }
  }

  if (Object.keys(values).length > 0) {
    await chrome.storage.session.set(values);
  }
}

async function handleShouldIntervene(sender) {
  const tab = sender.tab;
  const tabId = tab?.id;
  const siteId = getSupportedSiteId(sender.url ?? tab?.url ?? '');

  if (!Number.isInteger(tabId) || !siteId) {
    throw new Error('対象タブを特定できませんでした。');
  }

  const state = await getTabState(tabId);
  const condition = await getExperimentCondition();

  if (state.periodicInterventionActive && siteId === 'youtube') {
    return {
      ok: true,
      shouldIntervene: true,
      condition,
      trigger: 'periodic_30m'
    };
  }

  if (state.intervened && state.siteId === siteId) {
    return {
      ok: true,
      shouldIntervene: false,
      condition,
      trigger: 'existing_session'
    };
  }

  await setTabState(tabId, {
    intervened: true,
    siteId,
    youtubeAccumulatedMs: 0,
    youtubeActiveSince: null,
    periodicInterventionActive: false,
    lastInterventionAt: Date.now()
  });

  if (tab.active && Number.isInteger(tab.windowId)) {
    await chrome.storage.session.set({
      [`${ACTIVE_TAB_PREFIX}${tab.windowId}`]: tabId
    });
  }

  return {
    ok: true,
    shouldIntervene: true,
    condition,
    trigger: 'initial_open'
  };
}

async function handleInterventionResolved(message, sender) {
  const tab = sender.tab;
  const tabId = tab?.id;
  const siteId = getSupportedSiteId(sender.url ?? tab?.url ?? '');

  if (!Number.isInteger(tabId) || !siteId) {
    throw new Error('介入を終了したタブを特定できませんでした。');
  }

  if (message.action !== 'open_site') {
    return { ok: true };
  }

  const state = await getTabState(tabId);
  const nextState = {
    ...state,
    intervened: true,
    siteId,
    periodicInterventionActive: false,
    lastInterventionAt: Date.now()
  };

  if (siteId === 'youtube') {
    nextState.youtubeAccumulatedMs = 0;
    nextState.youtubeActiveSince = tab.active ? Date.now() : null;
    await clearYoutubeAlarm(tabId);

    if (tab.active) {
      await scheduleYoutubeAlarm(tabId, YOUTUBE_INTERVAL_MS);
    }
  }

  await setTabState(tabId, nextState);
  return { ok: true };
}

async function handleTabActivated({ tabId, windowId }) {
  const activeKey = `${ACTIVE_TAB_PREFIX}${windowId}`;
  const stored = await chrome.storage.session.get(activeKey);
  const previousTabId = stored[activeKey];
  const now = Date.now();

  if (Number.isInteger(previousTabId) && previousTabId !== tabId) {
    await pauseYoutubeUsage(previousTabId, now);
  }

  await chrome.storage.session.set({ [activeKey]: tabId });
  await resumeYoutubeUsage(tabId, now);
}

async function handleTabUpdated(tabId, changeInfo, tab) {
  if (typeof changeInfo.url === 'string') {
    const siteId = getSupportedSiteId(changeInfo.url);
    if (!siteId) {
      await clearYoutubeAlarm(tabId);
      await chrome.storage.session.remove(tabStateKey(tabId));
      return;
    }
  }

  if (changeInfo.status !== 'complete' || tab.active !== true) {
    return;
  }

  const state = await getTabState(tabId);
  if (state.siteId === 'youtube' && state.periodicInterventionActive) {
    await deliverPeriodicIntervention(tabId, state);
  }
}

async function pauseYoutubeUsage(tabId, now) {
  const state = await getTabState(tabId);
  if (state.siteId !== 'youtube' || state.periodicInterventionActive) {
    return;
  }

  if (typeof state.youtubeActiveSince !== 'number') {
    return;
  }

  const elapsed = Math.max(0, now - state.youtubeActiveSince);
  await setTabState(tabId, {
    ...state,
    youtubeAccumulatedMs: Math.min(
      YOUTUBE_INTERVAL_MS,
      state.youtubeAccumulatedMs + elapsed
    ),
    youtubeActiveSince: null
  });
  await clearYoutubeAlarm(tabId);
}

async function resumeYoutubeUsage(tabId, now) {
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return;
  }

  if (getSupportedSiteId(tab.url ?? '') !== 'youtube') {
    return;
  }

  const state = await getTabState(tabId);
  if (!state.intervened || state.siteId !== 'youtube' || state.periodicInterventionActive) {
    return;
  }

  const remaining = Math.max(0, YOUTUBE_INTERVAL_MS - state.youtubeAccumulatedMs);
  if (remaining === 0) {
    await markAndDeliverPeriodicIntervention(tabId, state);
    return;
  }

  await setTabState(tabId, {
    ...state,
    youtubeActiveSince: now
  });
  await scheduleYoutubeAlarm(tabId, remaining);
}

async function handleYoutubeAlarm(alarm) {
  const tabId = parseYoutubeAlarmTabId(alarm.name);
  if (!Number.isInteger(tabId)) {
    return;
  }

  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    await clearYoutubeAlarm(tabId);
    return;
  }

  if (!tab.active || getSupportedSiteId(tab.url ?? '') !== 'youtube') {
    await pauseYoutubeUsage(tabId, Date.now());
    return;
  }

  const state = await getTabState(tabId);
  if (state.siteId !== 'youtube' || state.periodicInterventionActive) {
    return;
  }

  await markAndDeliverPeriodicIntervention(tabId, state);
}

async function markAndDeliverPeriodicIntervention(tabId, state) {
  await clearYoutubeAlarm(tabId);

  const pendingState = {
    ...state,
    youtubeAccumulatedMs: YOUTUBE_INTERVAL_MS,
    youtubeActiveSince: null,
    periodicInterventionActive: true
  };
  await setTabState(tabId, pendingState);
  await deliverPeriodicIntervention(tabId, pendingState);
}

async function deliverPeriodicIntervention(tabId, state) {
  const condition = await getExperimentCondition();

  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      type: 'RESTART_INTERVENTION',
      condition,
      trigger: 'periodic_30m'
    });

    if (!response?.ok) {
      throw new Error(response?.error ?? '30分後の介入を開始できませんでした。');
    }
  } catch (error) {
    if (!isMissingReceiverError(error)) {
      await setTabState(tabId, {
        ...state,
        periodicInterventionActive: false
      });
      throw error;
    }
    // ページ読み込み中はonUpdatedまたはSHOULD_INTERVENEで再開する。
  }
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

  await clearYoutubeAlarm(tabId);
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

  await clearYoutubeAlarm(currentTab.id);

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

  await clearYoutubeAlarm(tabId);
  await chrome.tabs.remove(tabId);
  return { ok: true };
}

async function cleanupRemovedTab(tabId, windowId) {
  await clearYoutubeAlarm(tabId);
  await chrome.storage.session.remove(tabStateKey(tabId));

  if (!Number.isInteger(windowId)) {
    return;
  }

  const activeKey = `${ACTIVE_TAB_PREFIX}${windowId}`;
  const stored = await chrome.storage.session.get(activeKey);
  if (stored[activeKey] === tabId) {
    await chrome.storage.session.remove(activeKey);
  }
}

async function scheduleYoutubeAlarm(tabId, delayMs) {
  await chrome.alarms.clear(youtubeAlarmName(tabId));
  chrome.alarms.create(youtubeAlarmName(tabId), {
    when: Date.now() + Math.max(1000, delayMs)
  });
}

async function clearYoutubeAlarm(tabId) {
  await chrome.alarms.clear(youtubeAlarmName(tabId));
}

function youtubeAlarmName(tabId) {
  return `${YOUTUBE_ALARM_PREFIX}${tabId}`;
}

function parseYoutubeAlarmTabId(name) {
  if (typeof name !== 'string' || !name.startsWith(YOUTUBE_ALARM_PREFIX)) {
    return null;
  }

  const value = Number(name.slice(YOUTUBE_ALARM_PREFIX.length));
  return Number.isInteger(value) ? value : null;
}

async function getExperimentCondition() {
  const { experimentCondition = 'B' } = await chrome.storage.local.get('experimentCondition');
  return experimentCondition === 'A' ? 'A' : 'B';
}

async function getTabState(tabId) {
  const key = tabStateKey(tabId);
  const stored = await chrome.storage.session.get(key);
  return normalizeTabState(stored[key]);
}

async function setTabState(tabId, state) {
  await chrome.storage.session.set({
    [tabStateKey(tabId)]: normalizeTabState(state)
  });
}

function normalizeTabState(value) {
  if (!value || typeof value !== 'object') {
    return {
      intervened: false,
      siteId: null,
      youtubeAccumulatedMs: 0,
      youtubeActiveSince: null,
      periodicInterventionActive: false,
      lastInterventionAt: null
    };
  }

  return {
    intervened: value.intervened === true,
    siteId: typeof value.siteId === 'string' ? value.siteId : null,
    youtubeAccumulatedMs: Number.isFinite(value.youtubeAccumulatedMs)
      ? Math.max(0, value.youtubeAccumulatedMs)
      : 0,
    youtubeActiveSince: typeof value.youtubeActiveSince === 'number'
      ? value.youtubeActiveSince
      : null,
    periodicInterventionActive: value.periodicInterventionActive === true,
    lastInterventionAt: typeof value.lastInterventionAt === 'number'
      ? value.lastInterventionAt
      : null
  };
}

function tabStateKey(tabId) {
  return `${TAB_STATE_PREFIX}${tabId}`;
}

function getSupportedSiteId(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl === '') {
    return null;
  }

  try {
    const host = new URL(rawUrl).hostname.toLowerCase();

    if (host === 'youtube.com' || host.endsWith('.youtube.com')) {
      return 'youtube';
    }

    if (host === 'x.com' || host.endsWith('.x.com')) {
      return 'x';
    }

    if (host === 'instagram.com' || host.endsWith('.instagram.com')) {
      return 'instagram';
    }
  } catch {
    return null;
  }

  return null;
}

function isMissingReceiverError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('Receiving end does not exist') ||
    message.includes('Could not establish connection');
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
