// src/options/options.ts — preferences page logic.
export {};

function $<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

const enableClaude    = $<HTMLInputElement>('enable-claude');
const enableChatGPT   = $<HTMLInputElement>('enable-chatgpt');
const btnPosition     = $<HTMLSelectElement>('btn-position');
const theme           = $<HTMLSelectElement>('theme');
const augmentationMode = $<HTMLSelectElement>('augmentation-mode');
const saveBtn         = $('save-btn');
const savedMsg        = $('saved-msg');

// augmentationMode is stored as a top-level key so augmenter.ts can read it
// directly via chrome.storage.local.get('augmentationMode', ...).
chrome.storage.local.get(['options', 'augmentationMode'], result => {
  const opts = result['options'] ?? {};
  enableClaude.checked  = opts.enableClaude  ?? true;
  enableChatGPT.checked = opts.enableChatGPT ?? true;
  btnPosition.value     = opts.btnPosition   ?? 'above';
  theme.value           = opts.theme         ?? 'dark';
  augmentationMode.value = (result['augmentationMode'] as string) ?? 'append';
});

saveBtn.addEventListener('click', () => {
  const opts = {
    enableClaude:  enableClaude.checked,
    enableChatGPT: enableChatGPT.checked,
    btnPosition:   btnPosition.value,
    theme:         theme.value,
  };
  chrome.storage.local.set(
    { options: opts, augmentationMode: augmentationMode.value },
    () => {
      savedMsg.style.display = 'block';
      setTimeout(() => { savedMsg.style.display = 'none'; }, 2000);
    },
  );
});
