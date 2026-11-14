// Evaluated into a blank page of the headless browser by evals/frames.ts. It defines
// globalThis.__cropaFrames with two functions:
//
//   renderCase(job)  runs one background module in the app's own sandbox (an iframe with
//                    sandbox="allow-scripts" holding the bootstrap document, which starts the code
//                    in a blob Worker) and returns three composed frames as PNG data URLs.
//   sheet(layout)    draws the contact sheet from the thumbnails renderCase kept and returns it as
//                    a PNG data URL.
//
// Everything that comes back is plain data. The page has no network (the browser resolves no
// names) and is thrown away with its profile when the run ends.

(() => {
  const SAMPLES = [0, 1 / 3, 2 / 3];
  const BOOT_TIMEOUT_MS = 5000;
  const LOAD_TIMEOUT_MS = 3000;
  const FIRST_FRAME_TIMEOUT_MS = 3000;
  const FRAME_TIMEOUT_MS = 2000;
  const THUMB_WIDTH = 360;

  // key -> the three thumbnails of one rendered case.
  const thumbnails = new Map();

  const messageOf = (error) => (error instanceof Error ? error.message : String(error));

  /** Waits for messages from one iframe window, in order, whether they came before or after the call. */
  function inboxOf(frameWindow) {
    const queue = [];
    let waiting = null;
    const onMessage = (event) => {
      if (event.source !== frameWindow()) return;
      queue.push(event.data);
      if (waiting) waiting();
    };
    window.addEventListener('message', onMessage);
    return {
      next(match, timeoutMs, what) {
        return new Promise((resolve, reject) => {
          const started = performance.now();
          let timer = null;
          const check = () => {
            while (queue.length > 0) {
              const data = queue.shift();
              if (data && (data.type === 'worker-error' || data.type === 'boot-error')) {
                waiting = null;
                clearTimeout(timer);
                reject(new Error(`The sandbox failed: ${String(data.message)}`));
                return;
              }
              if (match(data)) {
                waiting = null;
                clearTimeout(timer);
                resolve(data);
                return;
              }
            }
            waiting = check;
          };
          timer = setTimeout(() => {
            waiting = null;
            reject(new Error(`Timed out after ${String(Math.round(performance.now() - started))} ms waiting for ${what}.`));
          }, timeoutMs);
          check();
        });
      },
      stop() {
        window.removeEventListener('message', onMessage);
      },
    };
  }

  // A stand-in for the screenshot: a light window with a title bar and a few grey bars.
  function drawCard(ctx, frame) {
    const { x, y, width, height, radius } = frame;
    const r = Math.max(0, Math.min(radius, width / 2, height / 2));
    const blur = Math.max(4, Math.min(width, height) * 0.06);
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.35)';
    ctx.shadowBlur = blur;
    ctx.shadowOffsetY = blur * 0.4;
    ctx.fillStyle = '#f4f5f7';
    ctx.beginPath();
    ctx.roundRect(x, y, width, height, r);
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.beginPath();
    ctx.roundRect(x, y, width, height, r);
    ctx.clip();
    const bar = Math.max(6, height * 0.08);
    ctx.fillStyle = '#e4e6ea';
    ctx.fillRect(x, y, width, bar);
    ctx.fillStyle = '#c3c7ce';
    for (let i = 0; i < 3; i++) {
      ctx.beginPath();
      ctx.arc(x + bar * (0.6 + i * 0.7), y + bar / 2, bar * 0.18, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = '#d3d6dc';
    const pad = Math.max(8, width * 0.04);
    const lines = [0.55, 0.8, 0.4, 0.7, 0.62];
    const lineHeight = Math.max(4, height * 0.035);
    lines.forEach((share, i) => {
      ctx.fillRect(x + pad, y + bar + pad + i * lineHeight * 2.2, (width - pad * 2) * share, lineHeight);
    });
    ctx.fillStyle = '#dfe2e7';
    ctx.fillRect(x + pad, y + bar + pad + lines.length * lineHeight * 2.2 + pad / 2, width - pad * 2, Math.max(0, height * 0.28));
    ctx.restore();
  }

  async function renderCase(job) {
    const { key, html, code, scene } = job;
    const iframe = document.createElement('iframe');
    iframe.setAttribute('sandbox', 'allow-scripts');
    iframe.style.cssText = 'position:fixed;width:0;height:0;border:0;visibility:hidden;pointer-events:none';
    iframe.srcdoc = html;
    const inbox = inboxOf(() => iframe.contentWindow);
    try {
      document.body.append(iframe);
      await inbox.next((m) => m?.type === 'boot-ready', BOOT_TIMEOUT_MS, 'the sandbox to start');
      iframe.contentWindow.postMessage({ type: 'start', code }, '*');
      const loaded = await inbox.next((m) => m?.type === 'loaded', LOAD_TIMEOUT_MS, 'the module to load');
      if (loaded.error) throw new Error(`${String(loaded.error.kind)}: ${String(loaded.error.message)}`);

      const pngs = [];
      const ms = [];
      const thumbs = [];
      for (let i = 0; i < SAMPLES.length; i++) {
        const t = SAMPLES[i];
        const started = performance.now();
        iframe.contentWindow.postMessage({ type: 'frame', id: i, t, scene }, '*');
        const reply = await inbox.next(
          (m) => m?.type === 'frame' && m.id === i,
          i === 0 ? FIRST_FRAME_TIMEOUT_MS : FRAME_TIMEOUT_MS,
          `the frame at t=${t.toFixed(2)}`,
        );
        ms.push(Math.round((performance.now() - started) * 10) / 10);
        if (reply.error) throw new Error(`${String(reply.error.kind)}: ${String(reply.error.message)}`);

        const canvas = document.createElement('canvas');
        canvas.width = scene.width;
        canvas.height = scene.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(reply.back, 0, 0);
        reply.back.close();
        drawCard(ctx, scene.frame);
        if (reply.front) {
          ctx.drawImage(reply.front, 0, 0);
          reply.front.close();
        }
        pngs.push(canvas.toDataURL('image/png'));
        thumbs.push(
          await createImageBitmap(canvas, {
            resizeWidth: THUMB_WIDTH,
            resizeHeight: Math.max(1, Math.round((THUMB_WIDTH * scene.height) / scene.width)),
            resizeQuality: 'high',
          }),
        );
      }
      for (const old of thumbnails.get(key) ?? []) old.close();
      thumbnails.set(key, thumbs);
      return { ok: true, pngs, ms };
    } catch (error) {
      return { ok: false, error: messageOf(error) };
    } finally {
      inbox.stop();
      iframe.contentWindow?.postMessage({ type: 'terminate' }, '*');
      iframe.remove();
    }
  }

  function wrapText(ctx, text, maxWidth, maxLines) {
    const words = text.split(/\s+/);
    const lines = [];
    let line = '';
    for (const word of words) {
      const trial = line === '' ? word : `${line} ${word}`;
      if (line !== '' && ctx.measureText(trial).width > maxWidth) {
        lines.push(line);
        line = word;
      } else {
        line = trial;
      }
    }
    if (line !== '') lines.push(line);
    return lines.slice(0, maxLines);
  }

  // layout: { groups: [{ label }], rows: [{ id, description, width, height, cells: [{ key, status, fallback }] }] }
  function sheet(layout) {
    const { groups, rows } = layout;
    const labelWidth = 260;
    const pad = 12;
    const gap = 6;
    const groupGap = 28;
    const headerHeight = 40;
    const statusHeight = 24;
    const groupWidth = SAMPLES.length * THUMB_WIDTH + (SAMPLES.length - 1) * gap;
    const rowHeights = rows.map((row) => Math.round((THUMB_WIDTH * row.height) / row.width) + statusHeight + pad * 2);
    const width = labelWidth + groups.length * (groupWidth + groupGap) + pad;
    const height = headerHeight + rowHeights.reduce((sum, h) => sum + h, 0) + pad;

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#14161a';
    ctx.fillRect(0, 0, width, height);
    ctx.textBaseline = 'alphabetic';

    ctx.fillStyle = '#ffffff';
    ctx.font = '600 15px sans-serif';
    groups.forEach((group, g) => {
      ctx.fillText(group.label, labelWidth + g * (groupWidth + groupGap), headerHeight - 14);
    });

    let top = headerHeight;
    rows.forEach((row, r) => {
      const rowHeight = rowHeights[r];
      const thumbHeight = rowHeight - statusHeight - pad * 2;
      ctx.fillStyle = '#ffffff';
      ctx.font = '600 13px sans-serif';
      ctx.fillText(row.id, pad, top + pad + 13);
      ctx.fillStyle = '#9aa0aa';
      ctx.font = '12px sans-serif';
      const description = row.description.length > 80 ? `${row.description.slice(0, 79)}…` : row.description;
      wrapText(ctx, description, labelWidth - pad * 2, 6).forEach((line, i) => {
        ctx.fillText(line, pad, top + pad + 34 + i * 16);
      });

      row.cells.forEach((cell, g) => {
        const left = labelWidth + g * (groupWidth + groupGap);
        const frames = cell.key === null ? undefined : thumbnails.get(cell.key);
        for (let i = 0; i < SAMPLES.length; i++) {
          const x = left + i * (THUMB_WIDTH + gap);
          const frame = frames?.[i];
          if (frame) {
            ctx.drawImage(frame, x, top + pad, THUMB_WIDTH, thumbHeight);
          } else {
            ctx.fillStyle = '#1d2026';
            ctx.fillRect(x, top + pad, THUMB_WIDTH, thumbHeight);
            ctx.strokeStyle = '#2c3038';
            ctx.strokeRect(x + 0.5, top + pad + 0.5, THUMB_WIDTH - 1, thumbHeight - 1);
          }
        }
        ctx.fillStyle = cell.fallback ? '#e0a040' : '#9aa0aa';
        ctx.font = '12px sans-serif';
        const status = cell.status.length > 90 ? `${cell.status.slice(0, 89)}…` : cell.status;
        ctx.fillText(status, left, top + pad + thumbHeight + 17);
      });
      top += rowHeight;
    });
    return canvas.toDataURL('image/png');
  }

  globalThis.__cropaFrames = { renderCase, sheet };
  return 'ready';
})()
