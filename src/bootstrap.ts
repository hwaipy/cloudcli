// This entry stays dependency-free so the HTML logo appears before the app's
// React, styles and provider modules start loading.
export {};

const screen = document.getElementById('boot-screen');
const progress = document.getElementById('boot-progress');
const track = document.getElementById('boot-track');
const bar = document.getElementById('boot-bar');
const status = document.getElementById('boot-status');
const retry = document.getElementById('boot-retry');
const root = document.getElementById('root');

if (!screen || !progress || !track || !bar || !status || !retry || !root) {
  throw new Error('Unable to start CloudCLI: boot elements are missing');
}

const isChinese = navigator.language.toLowerCase().startsWith('zh');
const labels = isChinese
  ? { loading: '正在加载应用…', downloading: '正在加载应用', starting: '正在启动界面…', ready: '界面就绪', failed: '加载失败，请重试', retry: '重试' }
  : { loading: 'Loading application…', downloading: 'Loading application', starting: 'Starting interface…', ready: 'Interface ready', failed: 'Loading failed. Please retry.', retry: 'Retry' };

type BootAsset = { file: string; bytes: number };
type BootManifest = { assets: BootAsset[] };

const formatBytes = (bytes: number) => bytes < 1024 * 1024
  ? `${Math.round(bytes / 1024)} KB`
  : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

const setIndeterminate = (label: string) => {
  progress.hidden = false;
  bar.style.width = '';
  track.dataset.indeterminate = '';
  track.removeAttribute('aria-valuenow');
  status.textContent = label;
};

const setPercent = (percent: number, label: string) => {
  progress.hidden = false;
  delete track.dataset.indeterminate;
  track.setAttribute('aria-valuenow', String(percent));
  bar.style.width = `${percent}%`;
  status.textContent = label;
};

retry.textContent = labels.retry;
retry.addEventListener('click', () => window.location.reload());
track.setAttribute('aria-label', isChinese ? 'CloudCLI 加载进度' : 'CloudCLI loading progress');
setIndeterminate(labels.loading);

const mounted = new Promise<void>((resolve) => {
  if (root.childElementCount > 0) {
    resolve();
    return;
  }
  const observer = new MutationObserver(() => {
    if (root.childElementCount === 0) return;
    observer.disconnect();
    resolve();
  });
  observer.observe(root, { childList: true });
});

// Vite development has no fixed asset graph, so show bytes from completed
// same-origin module requests while the bar keeps moving.
const watchDevelopmentBytes = () => {
  if (!import.meta.env.DEV || !('PerformanceObserver' in window)) return () => {};
  let loaded = 0;
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (!entry.name.startsWith(window.location.origin)) continue;
      loaded += (entry as PerformanceResourceTiming).decodedBodySize;
    }
    if (loaded > 0) setIndeterminate(`${labels.loading} ${formatBytes(loaded)}`);
  });
  try {
    observer.observe({ type: 'resource', buffered: true });
  } catch {
    return () => {};
  }
  return () => observer.disconnect();
};

// The small manifest is revalidated on every load so a new deployment is detected.
const fetchBootManifest = async () => {
  const response = await fetch(`${import.meta.env.BASE_URL}boot-assets.json`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Boot manifest: ${response.status}`);
  const manifest = await response.json() as BootManifest;
  if (!Array.isArray(manifest.assets) || manifest.assets.length === 0) {
    throw new Error('Boot manifest has no assets');
  }
  if (manifest.assets.some(asset => typeof asset.file !== 'string' || !Number.isFinite(asset.bytes) || asset.bytes <= 0)) {
    throw new Error('Boot manifest has invalid assets');
  }
  return manifest;
};

// Keep the last successfully mounted asset list. Compare individual hashed
// files instead of treating every deployment as a complete download.
const bootAssetsKey = `cloudcli:boot-assets:${import.meta.env.BASE_URL}`;
const getLoadedAssets = (): BootAsset[] => {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(bootAssetsKey) || 'null');
    if (!Array.isArray(value)) return [];
    return value.filter((asset): asset is BootAsset =>
      typeof asset?.file === 'string' && Number.isFinite(asset?.bytes));
  } catch {
    return [];
  }
};
const rememberLoadedAssets = (assets: BootAsset[]) => {
  try { localStorage.setItem(bootAssetsKey, JSON.stringify(assets)); } catch { /* Storage may be unavailable. */ }
};

const downloadBootAssets = async (assets: BootAsset[]) => {
  const base = import.meta.env.BASE_URL;
  const total = assets.reduce((sum, asset) => sum + asset.bytes, 0);

  let loaded = 0;
  const update = () => {
    const percent = Math.min(95, Math.floor(loaded / total * 95));
    setPercent(percent, `${labels.downloading} ${percent}%`);
  };
  update();

  await Promise.all(assets.map(async (asset) => {
    const assetResponse = await fetch(`${base}${asset.file}`);
    if (!assetResponse.ok) throw new Error(`Boot asset ${asset.file}: ${assetResponse.status}`);
    if (!assetResponse.body) {
      loaded += (await assetResponse.arrayBuffer()).byteLength;
      update();
      return;
    }
    const reader = assetResponse.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      loaded += value.byteLength;
      update();
    }
  }));
};

// Yield so the standalone logo paints before requesting the larger app graph.
setTimeout(async () => {
  const stopWatching = watchDevelopmentBytes();
  let bootAssets: BootAsset[] | null = null;
  try {
    if (import.meta.env.PROD) {
      try {
        const manifest = await fetchBootManifest();
        bootAssets = manifest.assets;
        const previous = new Map(getLoadedAssets().map(asset => [asset.file, asset.bytes]));
        // This bootstrap module has already loaded before the comparison runs.
        const changed = manifest.assets.filter(asset =>
          previous.get(asset.file) !== asset.bytes
          && new URL(`${import.meta.env.BASE_URL}${asset.file}`, window.location.origin).href !== import.meta.url);
        if (changed.length > 0) {
          await downloadBootAssets(changed);
        } else {
          setIndeterminate(labels.starting);
        }
      } catch (error) {
        // A stale or unavailable manifest must not prevent the app from opening.
        console.warn('CloudCLI byte progress unavailable:', error);
        setIndeterminate(labels.loading);
      }
    }
    if (!track.hasAttribute('data-indeterminate')) setPercent(96, labels.starting);
    await import('@/main');
    if (!track.hasAttribute('data-indeterminate')) setPercent(99, labels.starting);
    await mounted;
    if (bootAssets) rememberLoadedAssets(bootAssets);
    stopWatching();
    setPercent(100, labels.ready);
    requestAnimationFrame(() => screen.remove());
  } catch (error) {
    stopWatching();
    console.error('CloudCLI failed to load:', error);
    status.textContent = labels.failed;
    retry.hidden = false;
  }
}, 0);
