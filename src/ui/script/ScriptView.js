import { html, css, LitElement } from '../assets/lit-core-2.7.4.min.js';
import { loadScript, flatTimeline, formatClock, DEFAULT_WPM } from './scriptTimeline.js';

const STORAGE_KEY = 'glass.script';
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const FONT_SCALES = [0.7, 0.85, 1, 1.25, 1.5, 1.75];
const TICK_MS = 200;
// Where the line being read sits, as a fraction of the prompter's height.
const READING_LINE = 0.35;
const DASH = '—';

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

/** Script text with its `backticked` file names shown as code. */
const rich = text =>
    String(text)
        .split('`')
        .map((part, i) => (i % 2 ? html`<code>${part}</code>` : part));

/** Narration in one pair of quotes, whether or not the script already quoted it. */
const quoted = text => rich(`“${String(text).replace(/^["“”]+|["“”]+$/g, '')}”`);

export class ScriptView extends LitElement {
    static styles = css`
        :host {
            display: block;
            width: 100%;
            height: 100%;
            color: white;
        }

        * {
            font-family:
                'Helvetica Neue',
                -apple-system,
                BlinkMacSystemFont,
                'Segoe UI',
                Roboto,
                sans-serif;
            cursor: default;
            user-select: none;
            box-sizing: border-box;
        }

        .script-container {
            display: flex;
            flex-direction: column;
            height: 100%;
            width: 100%;
            background: rgba(0, 0, 0, 0.6);
            border-radius: 12px;
            outline: 0.5px rgba(255, 255, 255, 0.3) solid;
            outline-offset: -1px;
            position: relative;
            overflow: hidden;
        }

        /* ── Title bar (drag handle) ── */

        .title-bar {
            display: flex;
            align-items: center;
            gap: 8px;
            height: 36px;
            padding: 0 8px 0 14px;
            flex-shrink: 0;
            border-bottom: 1px solid rgba(255, 255, 255, 0.1);
            -webkit-app-region: drag;
        }

        .title {
            flex: 1;
            min-width: 0;
            font-size: 12px;
            font-weight: 500;
            color: rgba(255, 255, 255, 0.8);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .title-bar button,
        .title-bar select {
            -webkit-app-region: no-drag;
        }

        .btn {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            height: 24px;
            padding: 0 9px;
            border-radius: 6px;
            border: 1px solid rgba(255, 255, 255, 0.15);
            background: rgba(255, 255, 255, 0.07);
            color: white;
            font-size: 11px;
            font-weight: 500;
            cursor: pointer;
            white-space: nowrap;
            transition: background 0.15s ease;
        }

        .btn:hover:not(:disabled) {
            background: rgba(255, 255, 255, 0.15);
        }

        .btn:disabled {
            opacity: 0.4;
            cursor: default;
        }

        .btn.primary {
            background: rgba(0, 122, 255, 0.85);
            border-color: transparent;
        }

        .btn.primary:hover:not(:disabled) {
            background: #007aff;
        }

        .btn.icon {
            width: 24px;
            padding: 0;
            font-size: 13px;
        }

        select.mini {
            height: 24px;
            border-radius: 6px;
            border: 1px solid rgba(255, 255, 255, 0.15);
            background: rgba(255, 255, 255, 0.07);
            color: white;
            font-size: 11px;
            padding: 0 4px;
            cursor: pointer;
        }

        select.mini option {
            background: #1c1c1e;
        }

        .clock {
            font-family: 'SF Mono', Menlo, Monaco, monospace;
            font-size: 11px;
            color: rgba(255, 255, 255, 0.9);
            white-space: nowrap;
        }

        .clock .total {
            color: rgba(255, 255, 255, 0.45);
        }

        /* ── Library (loading a script) ── */

        .library {
            flex: 1;
            min-height: 0;
            overflow-y: auto;
            padding: 12px 14px 14px;
            display: flex;
            flex-direction: column;
            gap: 10px;
        }

        .note {
            font-size: 11px;
            line-height: 1.45;
            color: rgba(255, 255, 255, 0.6);
        }

        .note code,
        .drop-zone code {
            font-family: 'SF Mono', Menlo, Monaco, monospace;
            font-size: 10px;
            color: white;
        }

        .drop-zone {
            border: 1px dashed rgba(255, 255, 255, 0.25);
            border-radius: 8px;
            padding: 14px;
            text-align: center;
            font-size: 12px;
            color: rgba(255, 255, 255, 0.7);
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 8px;
            transition:
                border-color 0.15s ease,
                background 0.15s ease;
        }

        .drop-zone.dragging {
            border-color: #007aff;
            background: rgba(0, 122, 255, 0.1);
        }

        input[type='file'] {
            display: none;
        }

        textarea {
            width: 100%;
            min-height: 90px;
            resize: vertical;
            border-radius: 8px;
            border: 1px solid rgba(255, 255, 255, 0.15);
            background: rgba(0, 0, 0, 0.3);
            color: white;
            font-family: 'SF Mono', Menlo, Monaco, monospace;
            font-size: 11px;
            line-height: 1.45;
            padding: 8px 10px;
            user-select: text;
            cursor: text;
        }

        textarea:focus,
        input.wpm:focus {
            outline: none;
            border-color: #007aff;
        }

        .row {
            display: flex;
            align-items: center;
            gap: 8px;
            flex-wrap: wrap;
        }

        .spacer {
            flex: 1;
        }

        input.wpm {
            width: 56px;
            height: 24px;
            border-radius: 6px;
            border: 1px solid rgba(255, 255, 255, 0.15);
            background: rgba(0, 0, 0, 0.3);
            color: white;
            font-size: 11px;
            padding: 0 6px;
            user-select: text;
            cursor: text;
        }

        .loaded {
            border-radius: 8px;
            border: 1px solid rgba(255, 255, 255, 0.12);
            background: rgba(255, 255, 255, 0.04);
            padding: 10px 12px;
            display: flex;
            flex-direction: column;
            gap: 8px;
        }

        .loaded-title {
            font-size: 13px;
            font-weight: 600;
        }

        .pills {
            display: flex;
            gap: 6px;
            flex-wrap: wrap;
        }

        .pill {
            border: 1px solid rgba(255, 255, 255, 0.15);
            border-radius: 999px;
            padding: 1px 8px;
            font-size: 10px;
            color: rgba(255, 255, 255, 0.65);
        }

        .warning {
            font-size: 10px;
            line-height: 1.4;
            color: #ffd60a;
        }

        .outline {
            list-style: none;
            margin: 0;
            padding: 0;
            font-size: 11px;
            color: rgba(255, 255, 255, 0.75);
        }

        .outline li {
            display: flex;
            gap: 8px;
            padding: 3px 0;
            border-bottom: 1px solid rgba(255, 255, 255, 0.06);
        }

        .outline .at {
            font-family: 'SF Mono', Menlo, Monaco, monospace;
            font-size: 10px;
            color: rgba(255, 255, 255, 0.45);
            min-width: 38px;
        }

        /* ── Player (heads-up teleprompter) ── */

        .seek {
            margin: 6px 14px 0;
            height: 3px;
            accent-color: #007aff;
            cursor: pointer;
            flex-shrink: 0;
        }

        .prompter {
            position: relative;
            flex: 1;
            min-height: 0;
            overflow: hidden;
            -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 18%, #000 72%, transparent 100%);
            mask-image: linear-gradient(to bottom, transparent 0, #000 18%, #000 72%, transparent 100%);
        }

        .reading-line {
            position: absolute;
            left: 0;
            right: 0;
            top: 35%; /* READING_LINE */
            border-top: 1px dashed rgba(0, 122, 255, 0.45);
            pointer-events: none;
        }

        .reading-line::before {
            content: '';
            position: absolute;
            left: 4px;
            top: -5px;
            border: 5px solid transparent;
            border-left: 7px solid #007aff;
        }

        .scroll {
            position: relative;
            height: 100%;
            overflow: hidden;
        }

        .script-text {
            list-style: none;
            margin: 0;
            padding: 40vh 22px 70vh;
        }

        .line {
            padding: calc(8px * var(--script-scale, 1)) 0;
            font-size: calc(22px * var(--script-scale, 1));
            line-height: 1.4;
            font-weight: 500;
            color: rgba(255, 255, 255, 0.75);
            opacity: 0.55;
            cursor: pointer;
            transition:
                opacity 300ms ease,
                color 300ms ease;
        }

        .line.past {
            opacity: 0.25;
        }

        .line.current {
            opacity: 1;
            color: white;
        }

        .scene-label {
            display: block;
            margin-bottom: 4px;
            font-size: 10px;
            font-weight: 600;
            color: #4da3ff;
            text-transform: uppercase;
            letter-spacing: 0.06em;
        }

        .narration {
            margin-top: 3px;
            font-size: 0.85em;
            color: #9ecbff;
            font-style: italic;
        }

        .line code {
            font-family: 'SF Mono', Menlo, Monaco, monospace;
            font-size: 0.75em;
        }

        .empty {
            flex: 1;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 12px;
            color: rgba(255, 255, 255, 0.5);
        }

        ::-webkit-scrollbar {
            width: 6px;
        }

        ::-webkit-scrollbar-thumb {
            background: rgba(255, 255, 255, 0.2);
            border-radius: 3px;
        }

        /* macOS liquid glass draws the material itself; drop our tint. */
        :host-context(body.has-glass) .script-container {
            background: transparent;
            outline: none;
        }
    `;

    static properties = {
        _mode: { state: true },
        _dragging: { state: true },
        _draft: { state: true },
        _tick: { state: true },
    };

    constructor() {
        super();
        this.name = '';
        this.text = '';
        this.wpm = DEFAULT_WPM;
        this.fontScale = 1;
        this.speed = 1;
        this.parsed = null;
        this.flat = [];
        this.time = 0;
        this.playing = false;
        this.lastStamp = 0;
        this._interval = null;
        this._raf = 0;
        this._dragging = false;
        this._draft = '';
        this._tick = 0;
        this._readSaved();
        if (this.text) this._apply(this.name, this.text);
        this._mode = this.parsed && this.total ? 'player' : 'library';
        this._onKeydown = e => this._handleKeydown(e);
    }

    connectedCallback() {
        super.connectedCallback();
        window.addEventListener('keydown', this._onKeydown);
        this._startScroller();
    }

    disconnectedCallback() {
        super.disconnectedCallback();
        window.removeEventListener('keydown', this._onKeydown);
        this._stopTicker();
        this._stopScroller();
    }

    // ── Storage (per-viewer convenience; the script itself is the user's file) ──

    _readSaved() {
        try {
            const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
            if (saved && typeof saved.text === 'string') {
                this.name = typeof saved.name === 'string' ? saved.name : '';
                this.text = saved.text;
                if (Number(saved.wpm) > 0) this.wpm = Number(saved.wpm);
                if (FONT_SCALES.includes(Number(saved.fontScale))) this.fontScale = Number(saved.fontScale);
            }
        } catch (e) {
            // storage unavailable or corrupt; start empty
        }
    }

    _writeSaved() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify({ name: this.name, text: this.text, wpm: this.wpm, fontScale: this.fontScale }));
        } catch (e) {
            // ignore quota/storage errors; the script still plays this session
        }
    }

    // ── Loading ──

    get total() {
        return this.parsed ? this.parsed.totalSeconds : 0;
    }

    _apply(name, text) {
        this.name = name;
        this.text = text;
        this.parsed = text.trim() ? loadScript(text, { wpm: this.wpm }) : null;
        this.flat = this.parsed ? flatTimeline(this.parsed) : [];
        this.time = 0;
        this.pause();
    }

    _load(name, text) {
        this._apply(name, text);
        this._writeSaved();
        this._draft = '';
        this._refresh();
    }

    async _loadFile(file) {
        if (!file) return;
        try {
            this._load(file.name, await file.text());
        } catch (e) {
            console.error('[ScriptView] Could not read script file:', e);
        }
    }

    _handleDrop(e) {
        e.preventDefault();
        this._dragging = false;
        const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (file) this._loadFile(file);
    }

    _handleWpmChange(e) {
        const wpm = Number(e.target.value);
        if (!(wpm > 0)) return;
        this.wpm = wpm;
        this._writeSaved();
        // Only plain scripts are timed by reading speed; a play-by-play keeps its own clock.
        if (this.parsed && this.parsed.mode === 'plain') this._apply(this.name, this.text);
        this._refresh();
    }

    _clear() {
        this._apply('', '');
        this._writeSaved();
        this._refresh();
    }

    _show(mode) {
        if (mode === 'library') this.pause();
        this._mode = mode;
    }

    _close() {
        this.pause();
        if (window.api) window.api.scriptView.closeScriptWindow();
    }

    // ── Playback ──

    _refresh() {
        this._tick++;
    }

    _startTicker() {
        this._stopTicker();
        this.lastStamp = Date.now();
        this._interval = setInterval(() => {
            const now = Date.now();
            this.time = Math.min(this.total, this.time + ((now - this.lastStamp) / 1000) * this.speed);
            this.lastStamp = now;
            if (this.time >= this.total) this.pause();
            this._refresh();
        }, TICK_MS);
    }

    _stopTicker() {
        if (this._interval) {
            clearInterval(this._interval);
            this._interval = null;
        }
    }

    play() {
        if (!this.total) return;
        if (this.time >= this.total) this.time = 0;
        this.playing = true;
        this._startTicker();
        this._refresh();
    }

    pause() {
        this.playing = false;
        this._stopTicker();
        this._refresh();
    }

    togglePlay() {
        if (this.playing) this.pause();
        else this.play();
    }

    seekTo(seconds) {
        this.time = clamp(Number(seconds) || 0, 0, this.total);
        this.lastStamp = Date.now();
        this._refresh();
    }

    /** Jump to the previous/next beat on the flat timeline. */
    stepBeat(direction) {
        if (!this.flat.length) return;
        const idx = this._currentFlatIndex();
        if (direction > 0) {
            const next = this.flat[idx + 1];
            if (next) this.seekTo(next.atSeconds);
        } else {
            // Like a media player: first go back to the start of the current beat.
            const cur = this.flat[idx];
            if (cur && this.time - cur.atSeconds > 1.5) this.seekTo(cur.atSeconds);
            else this.seekTo(idx > 0 ? this.flat[idx - 1].atSeconds : 0);
        }
    }

    _scaleFont(direction) {
        const i = FONT_SCALES.indexOf(this.fontScale);
        this.fontScale = FONT_SCALES[clamp(i + direction, 0, FONT_SCALES.length - 1)];
        this._writeSaved();
        this._refresh();
    }

    _handleKeydown(e) {
        if (this._mode !== 'player') return;
        const tag = e.composedPath()[0] && e.composedPath()[0].tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        if (e.key === ' ') {
            e.preventDefault();
            this.togglePlay();
        } else if (e.key === 'ArrowRight') {
            e.preventDefault();
            if (e.shiftKey) this.seekTo(this.time + 10);
            else this.stepBeat(1);
        } else if (e.key === 'ArrowLeft') {
            e.preventDefault();
            if (e.shiftKey) this.seekTo(this.time - 10);
            else this.stepBeat(-1);
        } else if (e.key === 'Home') {
            e.preventDefault();
            this.seekTo(0);
        } else if (e.key === '+' || e.key === '=') {
            this._scaleFont(1);
        } else if (e.key === '-') {
            this._scaleFont(-1);
        }
    }

    // ── Position ──

    /** The last scene whose start the clock has reached. */
    _currentScene() {
        const scenes = this.parsed ? this.parsed.scenes : [];
        let cur = null;
        for (const sc of scenes) {
            if (this.time >= sc.startSeconds) cur = sc;
            else break;
        }
        return cur || scenes[0] || null;
    }

    /** Index into the flat timeline of the last beat the clock has passed, or -1. */
    _currentFlatIndex() {
        let idx = -1;
        for (let i = 0; i < this.flat.length; i++) {
            if (this.time >= this.flat[i].atSeconds) idx = i;
            else break;
        }
        return idx;
    }

    // ── Scrolling ──

    /** The clock between ticks, so the scroll moves every frame rather than every tick. */
    _liveTime() {
        if (!this.playing) return this.time;
        return Math.min(this.total, this.time + ((Date.now() - this.lastStamp) / 1000) * this.speed);
    }

    /** The scroll offset of every beat line, paired with the time it starts. */
    _anchors() {
        const lines = this.shadowRoot ? this.shadowRoot.querySelectorAll('.line') : [];
        return Array.from(lines, (el, i) => ({ y: el.offsetTop, t: this.flat[i] ? this.flat[i].atSeconds : 0 }));
    }

    /** Time -> scroll offset: a beat glides up past the reading line while it runs, reaching it as the next beat starts. */
    _yAt(time, anchors) {
        if (!anchors.length) return 0;
        if (time <= anchors[0].t) return anchors[0].y;
        for (let i = 0; i < anchors.length - 1; i++) {
            const a = anchors[i];
            const b = anchors[i + 1];
            if (time < b.t) return b.t > a.t ? a.y + ((time - a.t) / (b.t - a.t)) * (b.y - a.y) : a.y;
        }
        return anchors[anchors.length - 1].y;
    }

    /** Scroll offset -> time, the inverse of `_yAt`, so a wheel scroll scrubs the clock. */
    _timeAt(y, anchors) {
        if (!anchors.length) return 0;
        if (y <= anchors[0].y) return anchors[0].t;
        for (let i = 0; i < anchors.length - 1; i++) {
            const a = anchors[i];
            const b = anchors[i + 1];
            if (y < b.y) return a.t + ((y - a.y) / (b.y - a.y)) * (b.t - a.t);
        }
        return anchors[anchors.length - 1].t;
    }

    _startScroller() {
        this._stopScroller();
        const frame = () => {
            const scroll = this.shadowRoot && this.shadowRoot.querySelector('.scroll');
            if (scroll) {
                const top = this._yAt(this._liveTime(), this._anchors()) - scroll.clientHeight * READING_LINE;
                if (Math.abs(scroll.scrollTop - top) > 0.5) scroll.scrollTop = top;
            }
            this._raf = requestAnimationFrame(frame);
        };
        this._raf = requestAnimationFrame(frame);
    }

    _stopScroller() {
        if (this._raf) cancelAnimationFrame(this._raf);
        this._raf = 0;
    }

    _handleWheel(e) {
        e.preventDefault();
        const anchors = this._anchors();
        this.seekTo(this._timeAt(this._yAt(this._liveTime(), anchors) + e.deltaY, anchors));
    }

    // ── Render ──

    render() {
        return html`<div class="script-container">${this._mode === 'player' ? this.renderPlayer() : this.renderLibrary()}</div>`;
    }

    renderLibrary() {
        const parsed = this.parsed;
        const beats = this.flat.length;
        return html`
            <div class="title-bar">
                <span class="title">Script</span>
                ${parsed && this.total ? html`<button class="btn" @click=${() => this._show('player')}>Back to player</button>` : ''}
                <button class="btn icon" title="Close" @click=${() => this._close()}>×</button>
            </div>
            <div class="library">
                <div class="note">
                    Load a script to play on screen. A tasksbaby <code>play_by_play_*.md</code> runs on its own clock (scenes, beats and narration);
                    any other text plays one paragraph at a time, timed by reading speed. Glass windows are hidden from screen capture, so it works as
                    a private teleprompter.
                </div>
                <div
                    class="drop-zone ${this._dragging ? 'dragging' : ''}"
                    @dragover=${e => {
                        e.preventDefault();
                        this._dragging = true;
                    }}
                    @dragleave=${() => (this._dragging = false)}
                    @drop=${e => this._handleDrop(e)}
                >
                    <span>Drop a <code>.md</code> or <code>.txt</code> script here</span>
                    <button class="btn" @click=${() => this.shadowRoot.querySelector('#script-file').click()}>Choose file…</button>
                    <input
                        id="script-file"
                        type="file"
                        accept=".md,.markdown,.txt,text/markdown,text/plain"
                        @change=${e => {
                            this._loadFile(e.target.files[0]);
                            e.target.value = '';
                        }}
                    />
                </div>
                <textarea placeholder="…or paste a script here" .value=${this._draft} @input=${e => (this._draft = e.target.value)}></textarea>
                <div class="row">
                    <button class="btn" ?disabled=${!this._draft.trim()} @click=${() => this._load('Pasted script', this._draft)}>
                        Use pasted text
                    </button>
                    <span class="spacer"></span>
                    <span class="note">Reading speed</span>
                    <input
                        class="wpm"
                        type="number"
                        min="60"
                        max="400"
                        step="10"
                        .value=${String(this.wpm)}
                        @change=${e => this._handleWpmChange(e)}
                    />
                    <span class="note">wpm</span>
                </div>
                ${parsed
                    ? html`
                          <div class="loaded">
                              <div class="loaded-title">${parsed.title || this.name || 'Script'}</div>
                              <div class="pills">
                                  <span class="pill">${parsed.mode === 'timed' ? 'play-by-play' : 'plain text'}</span>
                                  <span class="pill">${parsed.scenes.length} scene${parsed.scenes.length === 1 ? '' : 's'}</span>
                                  <span class="pill">${beats} beat${beats === 1 ? '' : 's'}</span>
                                  <span class="pill">${formatClock(parsed.totalSeconds)} total</span>
                              </div>
                              ${parsed.warnings.map(w => html`<div class="warning">⚠ ${w}</div>`)}
                              <ol class="outline">
                                  ${parsed.scenes.map(
                                      sc => html`
                                          <li>
                                              <span class="at">${formatClock(sc.startSeconds)}</span>
                                              <span>
                                                  ${parsed.mode === 'timed' ? `Scene ${sc.n} — ` : ''}${sc.app || DASH}${sc.contribution
                                                      ? `: ${sc.contribution}`
                                                      : ''}
                                              </span>
                                          </li>
                                      `
                                  )}
                              </ol>
                              <div class="row">
                                  <button class="btn primary" ?disabled=${!this.total} @click=${() => this._show('player')}>Play on screen</button>
                                  <button class="btn" @click=${() => this._clear()}>Clear</button>
                              </div>
                              <div class="note">In the player: Space play/pause · ←/→ beat · Shift+←/→ 10s · scroll to scrub · +/− text size</div>
                          </div>
                      `
                    : ''}
            </div>
        `;
    }

    renderPlayer() {
        const parsed = this.parsed;
        if (!parsed || !this.total) {
            return html`
                <div class="title-bar">
                    <span class="title">Script</span>
                    <button class="btn" @click=${() => this._show('library')}>Load</button>
                    <button class="btn icon" title="Close" @click=${() => this._close()}>×</button>
                </div>
                <div class="empty">No script to play.</div>
            `;
        }

        const t = this.time;
        const sc = this._currentScene();
        const idx = this._currentFlatIndex();
        const timed = parsed.mode === 'timed';
        const sceneLabel = n => {
            const scene = parsed.scenes[n - 1];
            if (!scene) return '';
            return timed ? `Scene ${scene.n} — ${scene.app || DASH}` : scene.app;
        };

        let lastScene = null;
        return html`
            <div class="title-bar">
                <button class="btn primary" @click=${() => this.togglePlay()}>${this.playing ? 'Pause' : 'Play'}</button>
                <button class="btn icon" title="Previous beat (←)" @click=${() => this.stepBeat(-1)}>‹</button>
                <button class="btn icon" title="Next beat (→)" @click=${() => this.stepBeat(1)}>›</button>
                <button class="btn" title="Back to scene start" @click=${() => this.seekTo(sc ? sc.startSeconds : 0)}>Scene</button>
                <span class="clock">${formatClock(t)} <span class="total">/ ${formatClock(this.total)}</span></span>
                <span class="title"></span>
                <select
                    class="mini"
                    title="Scroll speed"
                    @change=${e => {
                        this.speed = Number(e.target.value) || 1;
                    }}
                >
                    ${SPEEDS.map(s => html`<option value=${s} ?selected=${s === this.speed}>${s}×</option>`)}
                </select>
                <button class="btn icon" title="Smaller text (−)" @click=${() => this._scaleFont(-1)}>A</button>
                <button class="btn icon" title="Larger text (+)" style="font-size:15px" @click=${() => this._scaleFont(1)}>A</button>
                <button class="btn" title="Load another script" @click=${() => this._show('library')}>Load</button>
                <button class="btn icon" title="Close" @click=${() => this._close()}>×</button>
            </div>
            <input
                class="seek"
                type="range"
                min="0"
                max=${this.total}
                step="1"
                .value=${String(Math.floor(t))}
                @input=${e => this.seekTo(e.target.value)}
                aria-label="Seek within the script"
            />
            <div class="prompter" style="--script-scale:${this.fontScale}" @wheel=${e => this._handleWheel(e)}>
                <div class="scroll">
                    <ol class="script-text">
                        ${this.flat.map((entry, i) => {
                            const label = entry.sceneN !== lastScene && parsed.scenes.length > 1 ? sceneLabel(entry.sceneN) : '';
                            lastScene = entry.sceneN;
                            return html`
                                <li class="line ${i === idx ? 'current' : i < idx ? 'past' : ''}" @click=${() => this.seekTo(entry.atSeconds)}>
                                    ${label ? html`<span class="scene-label">${label}</span>` : ''} ${rich(entry.action || DASH)}
                                    ${entry.narration ? html`<div class="narration">${quoted(entry.narration)}</div>` : ''}
                                </li>
                            `;
                        })}
                    </ol>
                </div>
                <div class="reading-line"></div>
            </div>
        `;
    }
}

customElements.define('script-view', ScriptView);
