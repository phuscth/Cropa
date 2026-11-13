/**
 * The only script that runs in the sandbox iframe document. It never evaluates what it receives:
 * the AI code is started as a blob Worker, and the worker's messages are relayed to the parent.
 */
export const BOOTSTRAP_SCRIPT = `(function () {
  var worker = null;
  function fail(message) {
    parent.postMessage({ type: 'worker-error', message: message }, '*');
  }
  function start(code) {
    try {
      var url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
      worker = new Worker(url);
      URL.revokeObjectURL(url);
    } catch (error) {
      parent.postMessage({ type: 'boot-error', message: String(error) }, '*');
      return;
    }
    worker.onmessage = function (event) {
      var data = event.data;
      var transfer = [];
      if (data && data.back instanceof ImageBitmap) transfer.push(data.back);
      if (data && data.front instanceof ImageBitmap) transfer.push(data.front);
      parent.postMessage(data, '*', transfer);
    };
    worker.onerror = function (event) {
      event.preventDefault();
      fail(event.message);
    };
  }
  addEventListener('message', function (event) {
    if (event.source !== parent) return;
    var data = event.data;
    if (data && data.type === 'start') {
      if (!worker) start(data.code);
    } else if (data && data.type === 'terminate') {
      if (worker) worker.terminate();
    } else if (worker) {
      worker.postMessage(data);
    }
  });
  parent.postMessage({ type: 'boot-ready' }, '*');
})();`;

export const BOOTSTRAP_CSP_HASH = "'sha256-FlmtLichB+BieDbMr/v8zKBj2d9eJW6RRLKc5IMzqoA='";

export const SANDBOX_CSP = `default-src 'none'; script-src ${BOOTSTRAP_CSP_HASH}; worker-src blob:`;

export function sandboxDocument(): string {
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${SANDBOX_CSP}"><script>${BOOTSTRAP_SCRIPT}</script>`;
}
