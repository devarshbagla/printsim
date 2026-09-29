// Records the timelapse preview into a video you can post. The WebGL canvas is
// copied into a 2D canvas right after each render (the WebGL buffer is only
// valid until the frame is presented, so it has to happen in the same task),
// cropped to the part of the screen the model is framed in, with a small
// caption and progress bar drawn on top. MediaRecorder encodes that canvas.
//
// Container: MP4 (H.264) where the browser can (Safari, recent Chrome), else
// WebM (Chrome, Firefox). Browsers that can't record never see the button.

const TYPES = [
  'video/mp4;codecs=avc1.640028', 'video/mp4;codecs=avc1.42E01F', 'video/mp4;codecs=avc1', 'video/mp4',
  'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm',
];

export function recordingType() {
  if (typeof window === 'undefined' || !window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) return null;
  for (const t of TYPES) {
    try { if (MediaRecorder.isTypeSupported(t)) return t; } catch (e) { /* ignore */ }
  }
  return null;
}

const even = (n) => Math.max(2, Math.floor(n / 2) * 2);

export class TimelapseRecorder {
  /**
   * @param {HTMLCanvasElement} src  the WebGL canvas
   * @param {{x:number,y:number,w:number,h:number}} crop  in drawing-buffer pixels
   */
  constructor(src, crop, { title = '', accent = '#ff7a1a', maxSide = 1920 } = {}) {
    this.src = src;
    this.type = recordingType();
    this.crop = crop;
    const s = Math.min(1, maxSide / Math.max(crop.w, crop.h));
    this.out = document.createElement('canvas');
    this.out.width = even(crop.w * s);
    this.out.height = even(crop.h * s);
    // some browsers only emit frames for canvases that are in the document
    Object.assign(this.out.style, { position: 'fixed', left: '-10000px', top: '0', width: '2px', height: '2px', pointerEvents: 'none' });
    document.body.appendChild(this.out);
    this.ctx = this.out.getContext('2d');
    this.title = title;
    this.accent = accent;
    this.chunks = [];
    this.info = { pct: 0, line: '' };
  }

  start() {
    const stream = this.out.captureStream(30);
    this.stream = stream;
    const px = this.out.width * this.out.height;
    this.rec = new MediaRecorder(stream, { mimeType: this.type, videoBitsPerSecond: Math.round(Math.min(12e6, Math.max(3e6, px * 30 * 0.12))) });
    this.rec.ondataavailable = (e) => { if (e.data && e.data.size) this.chunks.push(e.data); };
    // no draw here: outside a render the WebGL buffer is already cleared, and a
    // black first frame would become the video's thumbnail. The next render draws.
    this.rec.start(1000); // 1 s chunks: nothing is lost if onstop never fires
  }

  /** Call right after the WebGL canvas was rendered. */
  draw() {
    const { ctx, out, crop } = this;
    const W = out.width, H = out.height;
    ctx.drawImage(this.src, crop.x, crop.y, crop.w, crop.h, 0, 0, W, H);
    // caption strip
    const u = Math.max(W, H) / 100;
    const g = ctx.createLinearGradient(0, H - u * 14, 0, H);
    g.addColorStop(0, 'rgba(15,17,20,0)');
    g.addColorStop(1, 'rgba(15,17,20,0.85)');
    ctx.fillStyle = g;
    ctx.fillRect(0, H - u * 14, W, u * 14);
    const pad = u * 3;
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#f2f3f5';
    ctx.font = `600 ${Math.round(u * 2.4)}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    const title = this.title.length > 40 ? `${this.title.slice(0, 38)}…` : this.title;
    ctx.fillText(title, pad, H - pad - u * 2.6);
    ctx.fillStyle = 'rgba(242,243,245,0.7)';
    ctx.font = `500 ${Math.round(u * 1.8)}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    ctx.fillText(this.info.line, pad, H - pad - u * 0.2);
    ctx.textAlign = 'right';
    ctx.fillStyle = '#f2f3f5';
    ctx.font = `700 ${Math.round(u * 4)}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    ctx.fillText(`${Math.floor(this.info.pct)}%`, W - pad, H - pad - u * 0.2);
    ctx.fillStyle = 'rgba(242,243,245,0.55)';
    ctx.font = `600 ${Math.round(u * 1.6)}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    ctx.fillText('printsim', W - pad, pad + u * 1.2);
    ctx.textAlign = 'left';
    // progress bar
    const bh = Math.max(3, u * 0.5);
    ctx.fillStyle = 'rgba(255,255,255,0.15)';
    ctx.fillRect(0, H - bh, W, bh);
    ctx.fillStyle = this.accent;
    ctx.fillRect(0, H - bh, W * Math.min(1, this.info.pct / 100), bh);
  }

  /** @returns {Promise<Blob>} */
  stop() {
    return new Promise((resolve, reject) => {
      let fin = false;
      const done = () => {
        if (fin) return;
        fin = true;
        clearTimeout(this._t);
        this._cleanup();
        if (!this.chunks.length) return reject(new Error('The browser recorded no frames.'));
        resolve(new Blob(this.chunks, { type: this.type.split(';')[0] }));
      };
      this.rec.onstop = done;
      // older iOS sometimes never fires onstop; the 1 s chunks are enough
      this._t = setTimeout(done, 2500);
      try { this.rec.requestData(); } catch (e) { /* ignore */ }
      try { this.rec.stop(); } catch (e) { done(); }
    });
  }

  cancel() {
    try { this.rec && this.rec.state !== 'inactive' && this.rec.stop(); } catch (e) { /* ignore */ }
    this.chunks = [];
    this._cleanup();
  }

  _cleanup() {
    if (this._cleaned) return;
    this._cleaned = true;
    if (this.stream) for (const t of this.stream.getTracks()) t.stop();
    this.out.remove();
  }

  get extension() { return this.type.startsWith('video/mp4') ? 'mp4' : 'webm'; }
}
