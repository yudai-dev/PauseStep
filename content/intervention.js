'use strict';

(() => {
  const OVERLAY_ID = 'study-start-overlay';
  const WAIT_SECONDS = 10;
  const CONDITION_A_SUCCESS_MS = 2200;
  const SUCCESS_PROMPT_DELAY_MS = 550;
  const SUCCESS_AUTO_CLOSE_MS = 6500;
  const STAGE_TRANSITION_MS = 220;
  let pageLocked = false;
  let waitingTimer = null;
  let experimentCondition = 'B';
  let interventionTrigger = 'initial_open';

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== 'RESTART_INTERVENTION') {
      return false;
    }

    restartIntervention(message)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  });

  initialize().catch((error) => {
    console.error('[PauseStep] 初期化に失敗しました。', error);
    unlockPage();
  });

  async function initialize() {
    if (document.getElementById(OVERLAY_ID)) {
      return;
    }

    const response = await chrome.runtime.sendMessage({ type: 'SHOULD_INTERVENE' });
    if (!response?.ok || !response.shouldIntervene) {
      return;
    }

    await beginIntervention(
      response.condition,
      response.trigger ?? 'initial_open'
    );
  }

  async function restartIntervention(message) {
    if (pageLocked || document.getElementById(OVERLAY_ID)) {
      return { alreadyActive: true };
    }

    await beginIntervention(
      message.condition,
      message.trigger ?? 'return_after_30m'
    );
    return { alreadyActive: false };
  }

  async function beginIntervention(condition, trigger) {
    const site = detectSite(location.hostname);
    if (!site) {
      throw new Error('対象サイトを特定できませんでした。');
    }

    experimentCondition = condition === 'A' ? 'A' : 'B';
    interventionTrigger = trigger === 'return_after_30m'
      ? 'return_after_30m'
      : 'initial_open';

    lockPage();
    await waitForDocumentElement();
    attachOverlay(createOverlay());
    showWaitingStage(site);
  }

  function lockPage() {
    pageLocked = true;
    document.documentElement?.classList.add('study-start-locked');
  }

  function unlockPage() {
    pageLocked = false;
    clearWaitingTimer();
    document.documentElement?.classList.remove('study-start-locked');
    document.getElementById(OVERLAY_ID)?.remove();
  }

  function waitForDocumentElement() {
    if (document.documentElement) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      const observer = new MutationObserver(() => {
        if (document.documentElement) {
          observer.disconnect();
          resolve();
        }
      });
      observer.observe(document, { childList: true });
    });
  }

  function showWaitingStage(site) {
    renderStage(`
      <main class="study-start-card study-start-card--breathing" role="dialog" aria-modal="true" aria-labelledby="study-start-title">
        <h1 id="study-start-title" class="study-start-title">ひと呼吸おきましょう</h1>
        <div class="study-start-breathing-wrap" aria-hidden="true">
          <div class="study-start-breathing-blob"></div>
        </div>
      </main>
    `);

    startWaitingTimer(site);
  }

  function startWaitingTimer(site) {
    clearWaitingTimer();
    waitingTimer = window.setTimeout(() => {
      waitingTimer = null;
      transitionTo(() => showFirstChoiceStage(site));
    }, WAIT_SECONDS * 1000);
  }

  function showFirstChoiceStage(site) {
    renderStage(`
      <main class="study-start-card study-start-card--choice" role="dialog" aria-modal="true" aria-labelledby="study-start-title">
        <h1 id="study-start-title" class="study-start-title">${escapeHtml(site.label)}を開きますか？</h1>
        <div class="study-start-actions">
          <button id="study-start-open-site" class="study-start-button study-start-button--secondary" type="button">開く</button>
          <button id="study-start-dismiss-site" class="study-start-button study-start-button--primary" type="button">やめる</button>
        </div>
        <p id="study-start-status" class="study-start-status" role="status" aria-live="polite"></p>
      </main>
    `);

    document.getElementById('study-start-open-site')?.addEventListener('click', async () => {
      disableButtons();
      try {
        await createLog(site.id, 'open_site');
        unlockPage();
      } catch (error) {
        showStatus(`記録に失敗しました: ${error.message}`);
        enableButtons();
      }
    });

    document.getElementById('study-start-dismiss-site')?.addEventListener('click', async () => {
      disableButtons();

      try {
        const logId = await createLog(site.id, 'dismiss_site');
        transitionTo(() => showSuccessStage(logId));
      } catch (error) {
        showStatus(`記録に失敗しました: ${error.message}`);
        enableButtons();
      }
    });
  }

  function showSuccessStage(logId) {
    if (experimentCondition === 'A') {
      showConditionASuccess();
      return;
    }

    showConditionBSuccess(logId);
  }

  function showConditionASuccess() {
    renderStage(`
      <main class="study-start-card study-start-card--success" role="status" aria-live="polite">
        <div class="study-start-success-mark" aria-hidden="true">✓</div>
        <h1 class="study-start-title">流石です！</h1>
      </main>
    `);

    window.setTimeout(exitDismissedSite, CONDITION_A_SUCCESS_MS);
  }

  function showConditionBSuccess(logId) {
    renderStage(`
      <main class="study-start-card study-start-card--success" role="status" aria-live="polite">
        <div class="study-start-success-mark" aria-hidden="true">✓</div>
        <h1 class="study-start-title">流石です！</h1>
      </main>
      <aside id="study-start-inline-prompt" class="study-start-inline-prompt" aria-label="学習への小さな提案" hidden>
        <button id="study-start-close-prompt" class="study-start-inline-close" type="button" aria-label="閉じる">×</button>
        <p class="study-start-inline-message">少し進めたいときは</p>
        <button id="study-start-open-task" class="study-start-inline-open" type="button">課題ページを開く</button>
        <p id="study-start-inline-status" class="study-start-inline-status" role="status" aria-live="polite"></p>
      </aside>
    `);

    const autoCloseTimer = window.setTimeout(exitDismissedSite, SUCCESS_AUTO_CLOSE_MS);

    window.setTimeout(async () => {
      const prompt = document.getElementById('study-start-inline-prompt');
      if (!prompt) {
        return;
      }

      prompt.hidden = false;
      window.requestAnimationFrame(() => prompt.classList.add('is-visible'));

      try {
        const response = await chrome.runtime.sendMessage({
          type: 'MARK_STUDY_PROMPT_SHOWN',
          logId
        });
        if (!response?.ok) {
          throw new Error(response?.error ?? '表示記録を保存できませんでした。');
        }
      } catch (error) {
        console.error('[PauseStep] 学習導線の表示記録に失敗しました。', error);
      }
    }, SUCCESS_PROMPT_DELAY_MS);

    document.getElementById('study-start-close-prompt')?.addEventListener('click', () => {
      window.clearTimeout(autoCloseTimer);
      exitDismissedSite();
    });

    document.getElementById('study-start-open-task')?.addEventListener('click', async () => {
      window.clearTimeout(autoCloseTimer);
      const button = document.getElementById('study-start-open-task');
      const status = document.getElementById('study-start-inline-status');
      if (button) {
        button.disabled = true;
      }
      if (status) {
        status.textContent = '';
      }

      try {
        const response = await chrome.runtime.sendMessage({
          type: 'OPEN_TASK_FROM_SUCCESS',
          logId
        });

        if (!response?.ok) {
          throw new Error(response?.message ?? response?.error ?? '課題ページを開けませんでした。');
        }
      } catch (error) {
        if (status) {
          status.textContent = error.message;
        }
        if (button) {
          button.disabled = false;
        }
      }
    });
  }

  function exitDismissedSite() {
    chrome.runtime.sendMessage({ type: 'EXIT_DISMISSED_SITE' }).catch((error) => {
      console.error('[PauseStep] タブ終了要求の送信に失敗しました。', error);
    });
  }

  function renderStage(markup) {
    const overlay = document.getElementById(OVERLAY_ID);
    if (!overlay) {
      return;
    }

    overlay.innerHTML = markup;
    const stage = overlay.firstElementChild;
    if (!stage) {
      return;
    }

    stage.classList.add('study-start-card--enter');
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        stage.classList.remove('study-start-card--enter');
      });
    });
  }

  function transitionTo(nextStage) {
    const overlay = document.getElementById(OVERLAY_ID);
    const stage = overlay?.firstElementChild;

    if (!stage) {
      nextStage();
      return;
    }

    stage.classList.add('study-start-card--exit');
    window.setTimeout(nextStage, STAGE_TRANSITION_MS);
  }

  function clearWaitingTimer() {
    if (waitingTimer !== null) {
      window.clearTimeout(waitingTimer);
      waitingTimer = null;
    }
  }

  async function createLog(site, firstChoice) {
    const result = await chrome.storage.local.get('logs');
    const logs = Array.isArray(result.logs) ? result.logs : [];
    const id = crypto.randomUUID();

    logs.push({
      id,
      timestamp: new Date().toISOString(),
      site,
      condition: experimentCondition,
      trigger: interventionTrigger,
      firstChoice,
      studyPromptShown: false,
      studyPromptShownAt: null,
      openedTask: false,
      taskOpenedAt: null
    });

    await chrome.storage.local.set({ logs });
    return id;
  }

  function detectSite(hostname) {
    const host = hostname.toLowerCase();

    if (host === 'youtube.com' || host.endsWith('.youtube.com')) {
      return { id: 'youtube', label: 'YouTube' };
    }

    if (host === 'x.com' || host.endsWith('.x.com')) {
      return { id: 'x', label: 'X' };
    }

    if (host === 'instagram.com' || host.endsWith('.instagram.com')) {
      return { id: 'instagram', label: 'Instagram' };
    }

    return null;
  }

  function createOverlay() {
    const overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    return overlay;
  }

  function attachOverlay(overlay) {
    if (!pageLocked) {
      return;
    }

    const target = document.body ?? document.documentElement;
    target.appendChild(overlay);
  }

  function disableButtons() {
    document.querySelectorAll(`#${OVERLAY_ID} button`).forEach((button) => {
      button.disabled = true;
    });
  }

  function enableButtons() {
    document.querySelectorAll(`#${OVERLAY_ID} button`).forEach((button) => {
      button.disabled = false;
    });
  }

  function showStatus(message) {
    const status = document.getElementById('study-start-status');
    if (status) {
      status.textContent = message;
    }
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }
})();
