import { html, css, LitElement } from '../assets/lit-core-2.7.4.min.js';
import {
    loadScript,
    flatTimeline,
    formatClock,
    sceneSlides,
    scenePace,
    sceneAutoAdvanceDue,
    beatSteps,
    beatCode,
    beatExpects,
    formatCode,
    highlightCode,
    shortFile,
    DEFAULT_WPM,
} from './scriptTimeline.js';

/*
 * The Script window: the tasksbaby rehearsal player's model in a Glass window.
 *
 *   time   — the SCRIPT position: where the current beat starts. Only a step,
 *            a seek, a click, "Jump to now" or Auto moves it.
 *   watch  — the STOPWATCH: real seconds since Start. It never moves the beat.
 *
 * Two views over that position: the Slide (one slide per scene, with Steps and
 * Reference cards, as in the viewer) and Scroll (a teleprompter). Auto means
 * "slides change when a scene's time is up" on the Slide and "the text follows
 * the stopwatch" on Scroll. All script maths lives in scriptTimeline.js.
 */

const STORAGE_KEY = 'glass.script';
const FONT_SCALES = [0.7, 0.85, 1, 1.25, 1.5, 1.75];
const TICK_MS = 200;
// Where the line being read sits on Scroll, as a fraction of the prompter's height.
// The user drags it; these bound the drag so the line stays on screen.
const DEFAULT_READING_LINE = 0.35;
const MIN_READING_LINE = 0.08;
const MAX_READING_LINE = 0.85;
// How quickly Scroll glides to a beat it was stepped to (fraction of the gap per frame).
const GLIDE = 0.18;
const DASH = '—';

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

/** A script line's inline markdown as Lit parts: `code`, **bold** and *italic*. */
const rich = text =>
    String(text == null ? '' : text)
        .split(/(`[^`]+`|\*\*[^*]+\*\*|\*[^*\s][^*]*\*)/)
        .filter(Boolean)
        .map(part => {
            if (/^`[^`]+`$/.test(part)) return html`<code>${part.slice(1, -1)}</code>`;
            if (/^\*\*[^*]+\*\*$/.test(part)) return html`<strong>${part.slice(2, -2)}</strong>`;
            if (/^\*[^*\s][^*]*\*$/.test(part)) return html`<em>${part.slice(1, -1)}</em>`;
            return part;
        });

/** Narration comes from the script already wrapped in quotes; wrap it exactly once. */
const quote = text => {
    const t = String(text == null ? '' : text).replace(/^[\s"“”]+|[\s"“”]+$/g, '');
    return t ? `“${t}”` : '';
};

/** One-line form of a beat's text (backticks dropped). */
const plain = text => String(text == null ? '' : text).replace(/`/g, '');

/** Copy text, falling back to a hidden textarea where the async clipboard is unavailable. */
async function copyText(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch (e) {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        let ok = false;
        try {
            ok = document.execCommand('copy');
        } catch (err) {
            ok = false;
        }
        ta.remove();
        return ok;
    }
}

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

        code,
        pre {
            font-family: 'SF Mono', Menlo, Monaco, monospace;
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

        /* ── Bars ── */

        .title-bar {
            display: flex;
            align-items: center;
            gap: 6px;
            min-height: 36px;
            padding: 5px 8px 5px 12px;
            flex-shrink: 0;
            flex-wrap: nowrap;
            overflow: hidden;
            border-bottom: 1px solid rgba(255, 255, 255, 0.1);
            -webkit-app-region: drag;
        }

        .toolbar {
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 5px 8px 5px 12px;
            flex-shrink: 0;
            flex-wrap: wrap;
            border-bottom: 1px solid rgba(255, 255, 255, 0.08);
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
        .title-bar select,
        .title-bar input {
            -webkit-app-region: no-drag;
        }

        .spacer {
            flex: 1;
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
            opacity: 0.35;
            cursor: default;
        }

        .btn.primary {
            background: rgba(0, 122, 255, 0.85);
            border-color: transparent;
        }

        .btn.primary:hover:not(:disabled) {
            background: #007aff;
        }

        .btn.on {
            background: rgba(0, 122, 255, 0.3);
            border-color: rgba(0, 122, 255, 0.7);
        }

        .btn.icon {
            width: 24px;
            padding: 0;
            font-size: 13px;
        }

        .segmented {
            display: inline-flex;
        }

        .segmented .btn {
            border-radius: 0;
        }

        .segmented .btn:first-child {
            border-radius: 6px 0 0 6px;
        }

        .segmented .btn:last-child {
            border-radius: 0 6px 6px 0;
            border-left: none;
        }

        .clocks {
            display: inline-flex;
            align-items: baseline;
            gap: 10px;
            margin: 0 4px;
            white-space: nowrap;
        }

        .clock-cell {
            display: inline-flex;
            align-items: baseline;
            gap: 4px;
        }

        .clock-label {
            font-size: 9px;
            font-weight: 700;
            letter-spacing: 0.06em;
            text-transform: uppercase;
            color: rgba(255, 255, 255, 0.45);
        }

        .clock {
            font-family: 'SF Mono', Menlo, Monaco, monospace;
            font-size: 12px;
            color: white;
            font-variant-numeric: tabular-nums;
        }

        .clock .total {
            color: rgba(255, 255, 255, 0.45);
        }

        .drift {
            font-size: 10px;
            font-weight: 600;
            padding: 1px 7px;
            border-radius: 999px;
            white-space: nowrap;
        }

        .drift.ok {
            color: #30d158;
            background: rgba(48, 209, 88, 0.14);
        }

        .drift.behind {
            color: #ff9f0a;
            background: rgba(255, 159, 10, 0.16);
        }

        .drift.ahead {
            color: #64d2ff;
            background: rgba(100, 210, 255, 0.14);
        }

        .seek {
            display: block;
            width: calc(100% - 24px);
            margin: 6px 12px 2px;
            height: 3px;
            accent-color: #007aff;
            cursor: pointer;
            flex-shrink: 0;
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

        /* ── Slide ── */

        .stage {
            flex: 1;
            min-height: 0;
            display: flex;
            flex-direction: column;
            /* The side gutters hold the back / forward zones, so slide text never sits under them. */
            padding: 12px 52px 0;
            position: relative;
            font-size: calc(14px * var(--script-scale, 1));
        }

        /* Back / forward, like a slideshow: the whole edge is the button, the chevron shows on hover. */
        .st-zone {
            position: absolute;
            top: 0;
            bottom: 34px;
            width: 48px;
            z-index: 2;
            display: flex;
            align-items: center;
            justify-content: center;
            border: none;
            padding: 0;
            background: transparent;
            color: white;
            font-size: 34px;
            line-height: 1;
            cursor: pointer;
            opacity: 0.35;
            transition:
                opacity 0.15s ease,
                background 0.15s ease;
        }

        .st-zone.prev {
            left: 0;
        }

        .st-zone.next {
            right: 0;
        }

        .st-zone:hover {
            opacity: 1;
            background: linear-gradient(to var(--edge), transparent, rgba(255, 255, 255, 0.08));
        }

        .st-zone.prev:hover {
            --edge: left;
        }

        .st-zone.next:hover {
            --edge: right;
        }

        .st-zone span {
            display: flex;
            align-items: center;
            justify-content: center;
            width: 34px;
            height: 34px;
            border-radius: 50%;
            background: rgba(255, 255, 255, 0.08);
            padding-bottom: 4px;
        }

        .st-zone:hover span {
            background: rgba(0, 122, 255, 0.85);
        }

        .st-head {
            flex-shrink: 0;
        }

        .st-title {
            margin: 0;
            font-size: 1.7em;
            font-weight: 800;
            line-height: 1.15;
            overflow-wrap: anywhere;
        }

        .st-meta {
            display: flex;
            align-items: center;
            flex-wrap: wrap;
            gap: 4px 10px;
            margin-top: 6px;
            font-size: 11px;
            color: rgba(255, 255, 255, 0.55);
        }

        .st-dots {
            display: flex;
            gap: 5px;
        }

        .st-dot {
            width: 10px;
            height: 10px;
            padding: 0;
            border-radius: 50%;
            border: 2px solid rgba(255, 255, 255, 0.3);
            background: transparent;
            cursor: pointer;
        }

        .st-dot.done {
            background: rgba(255, 255, 255, 0.35);
            border-color: transparent;
        }

        .st-dot.current {
            background: #007aff;
            border-color: #007aff;
            transform: scale(1.25);
        }

        .st-flag {
            color: #ff6961;
            font-weight: 700;
        }

        .st-body {
            flex: 1;
            min-height: 0;
            overflow-y: auto;
            display: flex;
            flex-direction: column;
            justify-content: center;
            gap: 0.8em;
            padding: 10px 0;
        }

        .st-objective {
            margin: 0;
            font-size: 1.15em;
            line-height: 1.3;
            font-weight: 600;
            color: #4da3ff;
        }

        .st-points {
            margin: 0;
            padding-left: 1.3em;
            font-size: 1.2em;
            line-height: 1.35;
        }

        .st-points li {
            margin-bottom: 0.45em;
        }

        .st-points li::marker {
            color: #4da3ff;
            font-weight: 700;
        }

        .st-files {
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            gap: 5px 7px;
            font-size: 11px;
        }

        .st-chip {
            padding: 2px 8px;
            border-radius: 999px;
            background: rgba(0, 122, 255, 0.18);
            color: #9ecbff;
            font-family: 'SF Mono', Menlo, Monaco, monospace;
            overflow-wrap: anywhere;
        }

        .st-chip.makes {
            background: rgba(48, 209, 88, 0.18);
            color: #30d158;
            font-weight: 700;
        }

        .now {
            flex-shrink: 0;
            border-top: 1px solid rgba(255, 255, 255, 0.1);
            padding: 8px 0 10px;
            display: flex;
            flex-direction: column;
            gap: 3px;
        }

        .now-line {
            margin: 0;
            font-size: 11px;
            line-height: 1.35;
            color: rgba(255, 255, 255, 0.45);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .now-cur {
            font-size: 1em;
            font-weight: 600;
            color: white;
            white-space: normal;
        }

        .now-cur .scene {
            color: #4da3ff;
            font-weight: 700;
        }

        .now-quote {
            font-size: 0.95em;
            font-style: italic;
            color: #9ecbff;
            white-space: normal;
        }

        .st-foot {
            display: flex;
            align-items: center;
            gap: 8px;
            padding-bottom: 12px;
            font-size: 11px;
            color: rgba(255, 255, 255, 0.5);
        }

        .st-bar {
            position: absolute;
            left: 0;
            right: 0;
            bottom: 0;
            height: 4px;
            background: rgba(255, 255, 255, 0.1);
        }

        .st-fill {
            height: 100%;
            background: rgba(255, 255, 255, 0.4);
            transition: width 0.3s linear;
        }

        .st-bar.pace-ok .st-fill {
            background: #30d158;
        }

        .st-bar.pace-warn .st-fill {
            background: #ff9f0a;
        }

        .st-bar.pace-over .st-fill {
            background: #ff453a;
        }

        /* ── Steps and Reference cards (replace the slide body) ── */

        .card {
            flex: 1;
            min-height: 0;
            overflow-y: auto;
            display: flex;
            flex-direction: column;
            gap: 0.7em;
            padding: 10px 0 14px;
        }

        .card > * {
            flex-shrink: 0;
        }

        .sp-head {
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            gap: 4px 10px;
            font-size: 11px;
            color: rgba(255, 255, 255, 0.55);
        }

        .sp-kind {
            padding: 1px 8px;
            border-radius: 999px;
            background: rgba(0, 122, 255, 0.2);
            color: #9ecbff;
            font-weight: 600;
        }

        .sp-kind.explanation,
        .sp-kind.none {
            background: rgba(255, 255, 255, 0.1);
            color: rgba(255, 255, 255, 0.6);
        }

        .sp-action {
            margin: 0;
            font-size: 1.15em;
            line-height: 1.3;
            color: #4da3ff;
        }

        .sp-say {
            margin: 0;
            font-style: italic;
            color: #9ecbff;
            line-height: 1.4;
        }

        .sp-list {
            margin: 0;
            padding-left: 1.5em;
            font-size: 1.05em;
            line-height: 1.4;
        }

        .sp-list li {
            margin-bottom: 0.5em;
        }

        .sp-list li::marker {
            color: #4da3ff;
            font-weight: 800;
        }

        .sp-list li.buried {
            color: #ffb4a8;
            background: rgba(255, 69, 58, 0.12);
            border-radius: 6px;
            padding: 2px 6px;
        }

        .sp-label {
            margin: 0;
            font-size: 11px;
            color: #ff6961;
            font-weight: 700;
        }

        .sp-check {
            margin: 0;
            padding: 6px 10px;
            border-radius: 8px;
            background: rgba(48, 209, 88, 0.14);
            color: #30d158;
            line-height: 1.4;
        }

        .sp-fix,
        .sp-expect,
        .sp-notes {
            margin: 0;
            padding-left: 1.1em;
            line-height: 1.4;
        }

        .sp-fix {
            color: #ffd60a;
        }

        .sp-expect {
            color: #30d158;
        }

        .sp-notes {
            color: rgba(255, 255, 255, 0.6);
            font-size: 0.9em;
        }

        details.sp-why summary {
            cursor: pointer;
            font-size: 11px;
            color: rgba(255, 255, 255, 0.6);
        }

        details.sp-why p {
            margin: 6px 0 0;
            line-height: 1.45;
            color: rgba(255, 255, 255, 0.75);
        }

        .code-block {
            border-radius: 8px;
            border: 1px solid rgba(255, 255, 255, 0.12);
            background: rgba(0, 0, 0, 0.35);
            overflow: hidden;
        }

        .code-head {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 4px 6px 4px 10px;
            font-size: 11px;
            font-weight: 600;
            color: rgba(255, 255, 255, 0.7);
            border-bottom: 1px solid rgba(255, 255, 255, 0.08);
        }

        .code-block pre {
            margin: 0;
            padding: 8px 10px;
            font-size: 11px;
            line-height: 1.5;
            overflow-x: auto;
            user-select: text;
            cursor: text;
        }

        .tk-str {
            color: #ffa07a;
        }

        .tk-num {
            color: #b5e48c;
        }

        .tk-op {
            color: #ff7ab2;
        }

        .tk-key {
            color: #64d2ff;
        }

        .tk-kw {
            color: #ff7ab2;
            font-weight: 600;
        }

        .tk-com {
            color: rgba(255, 255, 255, 0.4);
            font-style: italic;
        }

        .ref-block h4 {
            margin: 0 0 6px;
            font-size: 11px;
            font-weight: 700;
            letter-spacing: 0.05em;
            text-transform: uppercase;
            color: rgba(255, 255, 255, 0.55);
        }

        .ref-block ol,
        .ref-block dl {
            margin: 0;
            padding-left: 1.2em;
            line-height: 1.45;
        }

        .ref-block dt {
            font-weight: 700;
            margin-top: 4px;
        }

        .ref-block dd {
            margin: 0 0 4px;
            color: rgba(255, 255, 255, 0.75);
        }

        table.facts {
            width: 100%;
            border-collapse: collapse;
            font-size: 0.95em;
        }

        table.facts td {
            padding: 4px 6px;
            border-bottom: 1px solid rgba(255, 255, 255, 0.08);
            vertical-align: top;
            line-height: 1.35;
        }

        table.facts td.value {
            font-family: 'SF Mono', Menlo, Monaco, monospace;
            font-weight: 700;
            color: #30d158;
            text-align: right;
            white-space: nowrap;
        }

        .card-nav {
            display: flex;
            gap: 6px;
            padding: 0 0 10px;
            flex-shrink: 0;
        }

        .card-nav .btn {
            flex: 1;
            height: 28px;
        }

        /* ── Scroll (teleprompter) ── */

        .prompter {
            position: relative;
            flex: 1;
            min-height: 0;
            overflow: hidden;
            /* The fades follow the reading line so the line being read is never faded. */
            -webkit-mask-image: linear-gradient(
                to bottom,
                transparent 0,
                #000 calc(var(--reading-line) * 0.6),
                #000 max(72%, calc(var(--reading-line) + 15%)),
                transparent 100%
            );
            mask-image: linear-gradient(
                to bottom,
                transparent 0,
                #000 calc(var(--reading-line) * 0.6),
                #000 max(72%, calc(var(--reading-line) + 15%)),
                transparent 100%
            );
        }

        /* A 14px grab strip centred on the line; drag it to move where you read. */
        .reading-line {
            position: absolute;
            left: 0;
            right: 0;
            top: var(--reading-line);
            height: 14px;
            transform: translateY(-50%);
            cursor: ns-resize;
            touch-action: none;
        }

        .reading-line::after {
            content: '';
            position: absolute;
            left: 0;
            right: 0;
            top: 50%;
            border-top: 1px dashed rgba(0, 122, 255, 0.45);
            transition: border-color 0.15s ease;
        }

        .reading-line:hover::after,
        .reading-line.dragging::after {
            border-top: 1px solid rgba(0, 122, 255, 0.9);
        }

        .reading-line::before {
            content: '';
            position: absolute;
            left: 4px;
            top: 50%;
            transform: translateY(-50%);
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
            padding: 95vh 22px 95vh;
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
            height: 6px;
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
        this.readingLine = DEFAULT_READING_LINE;
        this.view = 'slide'; // 'slide' | 'scroll'
        this.auto = true;
        this.parsed = null;
        this.flat = [];
        this.slides = [];
        this.time = 0;
        this.watch = 0;
        this.playing = false;
        this.lastStamp = 0;
        this.sceneEnteredAt = 0;
        this.beatStartedAt = 0;
        this.stepsOpen = false;
        this.refOpen = false;
        this.copied = '';
        this._interval = null;
        this._raf = 0;
        this._glideY = null;
        this._lineDragging = false;
        this._dragging = false;
        this._draft = '';
        this._tick = 0;
        this._readSaved();
        if (this.text) this._apply(this.name, this.text);
        this._mode = this.parsed && this.total ? 'player' : 'library';
        this._onKeydown = e => this._handleKeydown(e);
        this._onShortcut = (_event, shortcut) => this._handleShortcut(shortcut);
    }

    connectedCallback() {
        super.connectedCallback();
        window.addEventListener('keydown', this._onKeydown);
        if (window.api) window.api.scriptView.onShortcut(this._onShortcut);
        this._startScroller();
    }

    disconnectedCallback() {
        super.disconnectedCallback();
        window.removeEventListener('keydown', this._onKeydown);
        if (window.api) window.api.scriptView.removeOnShortcut(this._onShortcut);
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
                if (Number(saved.readingLine) > 0) this.readingLine = clamp(Number(saved.readingLine), MIN_READING_LINE, MAX_READING_LINE);
                if (saved.view === 'scroll') this.view = 'scroll';
                if (saved.auto === false) this.auto = false;
            }
        } catch (e) {
            // storage unavailable or corrupt; start empty
        }
    }

    _writeSaved() {
        try {
            localStorage.setItem(
                STORAGE_KEY,
                JSON.stringify({
                    name: this.name,
                    text: this.text,
                    wpm: this.wpm,
                    fontScale: this.fontScale,
                    readingLine: this.readingLine,
                    view: this.view,
                    auto: this.auto,
                })
            );
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
        this.slides = this.parsed ? sceneSlides(this.parsed) : [];
        this.time = 0;
        this.stepsOpen = false;
        this.refOpen = false;
        this.pause();
        this.resetWatch();
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

    // ── Stopwatch ──

    _refresh() {
        this._tick++;
    }

    _startTicker() {
        this._stopTicker();
        this.lastStamp = Date.now();
        this._interval = setInterval(() => {
            const now = Date.now();
            this.watch += (now - this.lastStamp) / 1000; // the stopwatch only counts; it never selects a beat
            this.lastStamp = now;
            this._autoStep();
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

    /** Stopwatch back to 0:00. The beat stays where it is. */
    resetWatch() {
        this.watch = 0;
        this.beatStartedAt = 0;
        this.sceneEnteredAt = 0;
        this.lastStamp = Date.now();
        this._refresh();
    }

    /** The stopwatch between ticks, so Scroll can move every frame. */
    _liveWatch() {
        if (!this.playing) return this.watch;
        return this.watch + (Date.now() - this.lastStamp) / 1000;
    }

    /**
     * Auto. On the Slide: once the stopwatch has spent the current scene's budget,
     * step to the next scene (never while Steps or Reference is open, never past the
     * last scene). On Scroll: the position follows the stopwatch.
     */
    _autoStep() {
        if (!this.auto || !this.parsed) return;
        if (this.view === 'scroll') {
            const due = clamp(this.watch, 0, this.total);
            if (due !== this.time) this.seekTo(due, { quiet: true });
            return;
        }
        if (this.stepsOpen || this.refOpen) return;
        const scenes = this.parsed.scenes;
        const at = scenes.indexOf(this._currentScene(this.time));
        if (at < 0 || at >= scenes.length - 1) return;
        const slide = this.slides[at];
        if (slide && sceneAutoAdvanceDue({ budget: slide.seconds, enteredAt: this.sceneEnteredAt, watch: this.watch })) this.stepScene(1);
    }

    // ── Position ──

    seekTo(seconds, { quiet = false } = {}) {
        const beforeBeat = this._currentFlatIndex(this.time);
        const beforeScene = this._currentScene(this.time);
        this.time = clamp(Number(seconds) || 0, 0, this.total);
        // On Scroll with Auto the text follows the stopwatch, so a deliberate move
        // (a step, a click, the slider, the wheel) moves the stopwatch with it.
        if (!quiet && this.auto && this.view === 'scroll') {
            this.watch = this.time;
            this.lastStamp = Date.now();
        }
        if (this._currentFlatIndex(this.time) !== beforeBeat) this.beatStartedAt = this.watch;
        if (this._currentScene(this.time) !== beforeScene) this.sceneEnteredAt = this.watch;
        if (!quiet) this._refresh();
    }

    /** Move the current beat by `delta`. The only thing besides Auto that advances the script. */
    stepBeat(delta) {
        if (!this.flat.length) return;
        const at = this._currentFlatIndex(this.time);
        const to = clamp((at < 0 ? (delta > 0 ? -1 : 0) : at) + delta, 0, this.flat.length - 1);
        this.seekTo(this.flat[to].atSeconds);
    }

    /** The previous / next scene's planned start. */
    stepScene(delta) {
        const scenes = this.parsed ? this.parsed.scenes : [];
        if (!scenes.length) return;
        const at = Math.max(0, scenes.indexOf(this._currentScene(this.time)));
        this.seekTo(scenes[clamp(at + delta, 0, scenes.length - 1)].startSeconds || 0);
    }

    /** "Jump to now": the scene (Slide) or beat (Scroll) the suggested times put you on. */
    jumpToNow() {
        const due = clamp(this.watch, 0, this.total);
        if (this.view === 'slide') {
            const sc = this._currentScene(due);
            this.seekTo(sc ? sc.startSeconds || 0 : 0);
        } else {
            const idx = this._currentFlatIndex(due);
            this.seekTo(idx >= 0 ? this.flat[idx].atSeconds : 0);
        }
    }

    /** The last scene whose start the clock has reached. */
    _currentScene(t) {
        const scenes = this.parsed ? this.parsed.scenes : [];
        let cur = null;
        for (const sc of scenes) {
            if (t >= sc.startSeconds) cur = sc;
            else break;
        }
        return cur || scenes[0] || null;
    }

    /** Index into the flat timeline of the last beat the clock has passed, or -1. */
    _currentFlatIndex(t) {
        let idx = -1;
        for (let i = 0; i < this.flat.length; i++) {
            if (t >= this.flat[i].atSeconds) idx = i;
            else break;
        }
        return idx;
    }

    /** The current beat inside a scene, or -1 before its first beat. */
    _currentBeatIndex(sc, t) {
        if (!sc) return -1;
        let idx = -1;
        for (let i = 0; i < sc.beats.length; i++) {
            if (t >= sc.beats[i].atSeconds) idx = i;
            else break;
        }
        return idx;
    }

    // ── Views and cards ──

    setView(view) {
        this.view = view === 'scroll' ? 'scroll' : 'slide';
        if (this.view === 'scroll') {
            this.stepsOpen = false;
            this.refOpen = false;
        }
        this._glideY = null;
        this._writeSaved();
        this._refresh();
    }

    setAuto(on) {
        this.auto = Boolean(on);
        this._writeSaved();
        this._refresh();
    }

    setStepsOpen(open) {
        if (open) this.view = 'slide';
        this.stepsOpen = Boolean(open) && Boolean(this.parsed);
        if (this.stepsOpen) this.refOpen = false;
        this._refresh();
    }

    setRefOpen(open) {
        if (open) this.view = 'slide';
        this.refOpen = Boolean(open) && Boolean(this.parsed);
        if (this.refOpen) this.stepsOpen = false;
        this._refresh();
    }

    _scaleFont(direction) {
        const i = FONT_SCALES.indexOf(this.fontScale);
        this.fontScale = FONT_SCALES[clamp(i + direction, 0, FONT_SCALES.length - 1)];
        this._writeSaved();
        this._refresh();
    }

    async _copy(label, text) {
        if (await copyText(text)) {
            this.copied = label;
            this._refresh();
            setTimeout(() => {
                if (this.copied === label) {
                    this.copied = '';
                    this._refresh();
                }
            }, 1200);
        }
    }

    /**
     * Back / forward, as the edge buttons, ←/→ and the global Script shortcuts all do it:
     * a scene on the slide, a beat while Steps is open or on Scroll.
     */
    go(delta) {
        if (this.view === 'slide' && !this.stepsOpen) this.stepScene(delta);
        else this.stepBeat(delta);
    }

    /** A global Script shortcut from Glass's shortcut settings (works while another app has focus). */
    _handleShortcut(shortcut) {
        if (this._mode !== 'player' || !this.total) return;
        if (shortcut === 'previous') this.go(-1);
        else if (shortcut === 'next') this.go(1);
        else if (shortcut === 'toggleSteps') this.setStepsOpen(!this.stepsOpen);
    }

    /** The viewer's keys: Space, ←/→, ↑/↓ (Steps), S, R, Esc, N, A, O, +/−. */
    _handleKeydown(e) {
        if (this._mode !== 'player') return;
        const target = e.composedPath()[0];
        const tag = target && target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        const key = e.key;
        const handled = () => e.preventDefault();
        if (key === ' ' && tag !== 'BUTTON') {
            handled();
            this.togglePlay();
        } else if (key === 'ArrowRight' || key === 'ArrowLeft') {
            handled();
            this.go(key === 'ArrowRight' ? 1 : -1);
        } else if ((key === 'ArrowDown' || key === 'ArrowUp') && (this.stepsOpen || this.view === 'scroll')) {
            handled();
            this.stepBeat(key === 'ArrowDown' ? 1 : -1);
        } else if (key === 's' || key === 'S') {
            handled();
            this.setStepsOpen(!this.stepsOpen);
        } else if (key === 'r' || key === 'R') {
            handled();
            this.setRefOpen(!this.refOpen);
        } else if (key === 'Escape' && (this.stepsOpen || this.refOpen)) {
            handled();
            this.stepsOpen = false;
            this.refOpen = false;
            this._refresh();
        } else if (key === 'n' || key === 'N') {
            handled();
            this.jumpToNow();
        } else if (key === 'a' || key === 'A') {
            handled();
            this.setAuto(!this.auto);
        } else if (key === 'o' || key === 'O') {
            handled();
            this.setView(this.view === 'slide' ? 'scroll' : 'slide');
        } else if (key === '+' || key === '=') {
            this._scaleFont(1);
        } else if (key === '-') {
            this._scaleFont(-1);
        }
    }

    // ── Scroll: the teleprompter ──

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

    /** Scroll offset -> time, the inverse of `_yAt`, so a wheel scroll scrubs. */
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

    /**
     * Where Scroll should be. With Auto the text follows the stopwatch continuously;
     * without it, it sits on the current beat (glided to, so a step reads as motion).
     */
    _scrollTarget(anchors) {
        if (this.auto) return this._yAt(clamp(this._liveWatch(), 0, this.total), anchors);
        return this._yAt(this.time, anchors);
    }

    _startScroller() {
        this._stopScroller();
        const frame = () => {
            const scroll = this.shadowRoot && this.shadowRoot.querySelector('.scroll');
            if (scroll && this.view === 'scroll') {
                const anchors = this._anchors();
                const target = this._scrollTarget(anchors);
                if (this.auto || this._glideY === null) this._glideY = target;
                else this._glideY += (target - this._glideY) * GLIDE;
                const top = this._glideY - scroll.clientHeight * this.readingLine;
                if (Math.abs(scroll.scrollTop - top) > 0.5) scroll.scrollTop = top;
            } else {
                this._glideY = null;
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
        this.seekTo(this._timeAt(this._scrollTarget(anchors) + e.deltaY, anchors));
    }

    // Moving the reading line

    _startLineDrag(e) {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        this._lineDragging = true;
        this._refresh();
    }

    _dragLine(e) {
        if (!this._lineDragging) return;
        const rect = this.shadowRoot.querySelector('.prompter').getBoundingClientRect();
        this.readingLine = clamp((e.clientY - rect.top) / rect.height, MIN_READING_LINE, MAX_READING_LINE);
        this._refresh();
    }

    _endLineDrag() {
        if (!this._lineDragging) return;
        this._lineDragging = false;
        this._writeSaved();
        this._refresh();
    }

    _resetLine() {
        this.readingLine = DEFAULT_READING_LINE;
        this._writeSaved();
        this._refresh();
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
                    Load a script to rehearse on screen. A tasksbaby <code>play_by_play_*.md</code> plays like the tasksbaby viewer: a slide per
                    scene, Steps and Reference cards, and a stopwatch against the script's suggested times. Any other text plays one paragraph at a
                    time, timed by reading speed. Glass windows are hidden from screen capture.
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
                                  <span class="pill">${formatClock(parsed.totalSeconds)} suggested</span>
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
                                  <button class="btn primary" ?disabled=${!this.total} @click=${() => this._show('player')}>
                                      Rehearse on screen
                                  </button>
                                  <button class="btn" @click=${() => this._clear()}>Clear</button>
                              </div>
                              <div class="note">
                                  Space start/pause · ←/→ scene (beat on Scroll and in Steps) · S steps · R reference · N jump to now · A auto · O
                                  slide/scroll · +/− text size
                              </div>
                              <div class="note">
                                  From any app while this window is open: ⌘⌥← previous · ⌘⌥→ next · ⌘⌥S steps (Ctrl+Alt on Windows). Change them in
                                  Settings → Edit Shortcuts.
                              </div>
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

        const slideView = this.view === 'slide';
        const stepsWhat = slideView && !this.stepsOpen ? 'scene' : 'beat';
        return html`
            <div class="title-bar">
                <button class="btn primary" title="Start or pause the stopwatch (Space). It never moves the beat." @click=${() => this.togglePlay()}>
                    ${this.playing ? 'Pause' : 'Start'}
                </button>
                <button class="btn" title="Set the stopwatch back to 0:00 (the beat stays)" @click=${() => this.resetWatch()}>Reset</button>
                <button
                    class="btn icon"
                    title="Previous ${stepsWhat} (←)"
                    @click=${() => (stepsWhat === 'scene' ? this.stepScene(-1) : this.stepBeat(-1))}
                >
                    ‹
                </button>
                <button class="btn icon" title="Next ${stepsWhat} (→)" @click=${() => (stepsWhat === 'scene' ? this.stepScene(1) : this.stepBeat(1))}>
                    ›
                </button>
                ${this.renderClocks()}
                <span class="title"></span>
                <button class="btn" title="Load another script" @click=${() => this._show('library')}>Load</button>
                <button class="btn icon" title="Close" @click=${() => this._close()}>×</button>
            </div>
            <div class="toolbar">
                <span class="segmented">
                    <button class="btn ${slideView ? 'on' : ''}" title="A slide per scene (O)" @click=${() => this.setView('slide')}>Slide</button>
                    <button class="btn ${slideView ? '' : 'on'}" title="Scrolling teleprompter (O)" @click=${() => this.setView('scroll')}>
                        Scroll
                    </button>
                </span>
                <button
                    class="btn ${this.stepsOpen ? 'on' : ''}"
                    title="Click-through steps for the current beat (S)"
                    @click=${() => this.setStepsOpen(!this.stepsOpen)}
                >
                    Steps
                </button>
                <button
                    class="btn ${this.refOpen ? 'on' : ''}"
                    title="Prep, definitions and facts (R)"
                    @click=${() => this.setRefOpen(!this.refOpen)}
                >
                    Reference
                </button>
                <button
                    class="btn ${this.auto ? 'on' : ''}"
                    title=${slideView
                        ? "Slides change by themselves when a scene's time is up (A)"
                        : 'The text follows the stopwatch; off, it stays on the beat you step to (A)'}
                    @click=${() => this.setAuto(!this.auto)}
                >
                    Auto: ${this.auto ? 'on' : 'off'}
                </button>
                ${this.renderDrift()}
                <span class="spacer"></span>
                <button class="btn icon" title="Smaller text (−)" @click=${() => this._scaleFont(-1)}>A</button>
                <button class="btn icon" title="Larger text (+)" style="font-size:15px" @click=${() => this._scaleFont(1)}>A</button>
            </div>
            <input
                class="seek"
                type="range"
                min="0"
                max=${this.total}
                step="1"
                .value=${String(Math.floor(this.time))}
                @input=${e => this.seekTo(e.target.value)}
                aria-label="Move within the script"
            />
            ${slideView ? this.renderSlide() : this.renderScroll()}
        `;
    }

    /** Elapsed (the stopwatch), Should be (where the suggested times put you) and You're at (your beat). */
    renderClocks() {
        const due = clamp(this.watch, 0, this.total);
        return html`
            <span class="clocks">
                <span class="clock-cell" title="Stopwatch: real time since Start"
                    ><span class="clock-label">Elapsed</span><span class="clock elapsed">${formatClock(this.watch)}</span></span
                >
                <span class="clock-cell" title="Where the script's suggested times put you at this elapsed time"
                    ><span class="clock-label">Should be</span><span class="clock due">${formatClock(due)}</span></span
                >
                <span class="clock-cell" title="The beat you are on (moved only by steps, clicks and seeks)"
                    ><span class="clock-label">You're at</span
                    ><span class="clock at">${formatClock(this.time)} <span class="total">/ ${formatClock(this.total)}</span></span></span
                >
            </span>
        `;
    }

    /** How far your beat is from where the stopwatch says you should be, and "Jump to now". */
    renderDrift() {
        const due = clamp(this.watch, 0, this.total);
        const dueIdx = this._currentFlatIndex(due);
        const atIdx = this._currentFlatIndex(this.time);
        const behind = dueIdx - atIdx;
        let drift = '';
        if (this.flat.length && (this.watch > 0 || this.playing)) {
            if (behind === 0) drift = html`<span class="drift ok">on time</span>`;
            else {
                const n = Math.abs(behind);
                drift = html`<span class="drift ${behind > 0 ? 'behind' : 'ahead'}">
                    ${n} beat${n === 1 ? '' : 's'} ${behind > 0 ? 'behind' : 'ahead'} · ${formatClock(Math.abs(due - this.time))}
                </span>`;
            }
        }
        const nowDisabled = this.view === 'slide' ? this._currentScene(due) === this._currentScene(this.time) : !this.flat.length || behind === 0;
        return html`
            ${drift}
            <button
                class="btn"
                title="Move to the ${this.view === 'slide' ? 'scene' : 'beat'} you should be on at this elapsed time (N)"
                ?disabled=${nowDisabled}
                @click=${() => this.jumpToNow()}
            >
                Now
            </button>
        `;
    }

    renderSlide() {
        const parsed = this.parsed;
        const scenes = parsed.scenes;
        const sc = this._currentScene(this.time);
        const at = scenes.indexOf(sc);
        const slide = this.slides[at];
        if (!sc || !slide) return html`<div class="empty">No scenes to show.</div>`;

        const flagged = (sc.beats || []).filter(b => b.plain && beatSteps(b.plain).hidden.length).length;
        const pace = scenePace({ budget: slide.seconds, plannedStart: slide.startSeconds, enteredAt: this.sceneEnteredAt, watch: this.watch });
        const level = ['idle', 'ok', 'warn', 'over'].includes(pace.level) ? pace.level : 'idle';
        const ratio = Number.isFinite(pace.ratio) ? clamp(pace.ratio, 0, 1) : 0;
        const nextSlide = this.slides[at + 1];
        const chip = (name, makes) =>
            html`<span class="st-chip ${makes ? 'makes' : ''}" title=${name}>${shortFile(name, parsed.baseSlug) || name}</span>`;

        let body;
        if (this.stepsOpen) body = this.renderSteps(sc);
        else if (this.refOpen) body = this.renderRef();
        else
            body = html`
                <div class="st-body">
                    ${slide.objective ? html`<p class="st-objective">${rich(slide.objective)}</p>` : ''}
                    ${slide.points.length
                        ? html`<ol class="st-points">
                              ${slide.points.map(p => html`<li>${rich(p)}</li>`)}
                          </ol>`
                        : ''}
                    ${slide.uses.length || slide.makes
                        ? html`<div class="st-files">
                              ${slide.uses.map(f => chip(f, false))} ${slide.uses.length && slide.makes ? html`<span>→</span>` : ''}
                              ${slide.makes ? chip(slide.makes, true) : ''}
                          </div>`
                        : ''}
                </div>
                ${this.renderNow(sc)}
            `;

        return html`
            <div class="stage" style="--script-scale:${this.fontScale}">
                ${this.renderZones(at, scenes.length)}
                <div class="st-head">
                    <h2 class="st-title">${parsed.mode === 'timed' ? `Scene ${slide.n} · ` : ''}${slide.app || DASH}</h2>
                    <div class="st-meta">
                        <span>${at + 1} / ${scenes.length}</span>
                        <span class="st-dots">
                            ${scenes.map(
                                (s, i) =>
                                    html`<button
                                        class="st-dot ${i === at ? 'current' : i < at ? 'done' : ''}"
                                        title="Scene ${s.n} — ${s.app || DASH}"
                                        @click=${() => this.seekTo(s.startSeconds || 0)}
                                    ></button>`
                            )}
                        </span>
                        <span>suggested ${formatClock(slide.startSeconds)}–${formatClock(slide.endSeconds)}</span>
                        ${flagged
                            ? html`<span
                                  class="st-flag"
                                  title="Some beats in this scene hide a click inside their explanation — press S to see the steps"
                                  >⚑ ${flagged}</span
                              >`
                            : ''}
                    </div>
                </div>
                ${body}
                <div class="st-foot">
                    <span>${nextSlide && nextSlide.app ? `Next: ${nextSlide.app}` : 'Last scene'}</span>
                    <span class="spacer"></span>
                    <span title="Time spent in this scene against its suggested length"
                        >${formatClock(pace.spent)} of ${formatClock(slide.seconds)} in this scene</span
                    >
                </div>
                <div class="st-bar pace-${level}"><div class="st-fill" style="width:${ratio * 100}%"></div></div>
            </div>
        `;
    }

    /**
     * The slide's back / forward zones on the left and right edges. They do what ←/→ do:
     * move a scene on the slide, or a beat while the Steps card is open. Hidden at the ends.
     */
    renderZones(sceneAt, sceneCount) {
        const byBeat = this.stepsOpen;
        const at = byBeat ? this._currentFlatIndex(this.time) : sceneAt;
        const last = byBeat ? this.flat.length - 1 : sceneCount - 1;
        const what = byBeat ? 'beat' : 'scene';
        const go = d => this.go(d);
        return html`
            ${at > 0
                ? html`<button class="st-zone prev" title="Previous ${what} (←)" aria-label="Previous ${what}" @click=${() => go(-1)}>
                      <span>‹</span>
                  </button>`
                : ''}
            ${at < last
                ? html`<button class="st-zone next" title="Next ${what} (→)" aria-label="Next ${what}" @click=${() => go(1)}>
                      <span>›</span>
                  </button>`
                : ''}
        `;
    }

    /** The beat that just played, the one on now (with its narration), and the one coming. */
    renderNow(sc) {
        const i = this._currentFlatIndex(this.time);
        const prev = i > 0 ? this.flat[i - 1] : null;
        const cur = i >= 0 ? this.flat[i] : null;
        const next = i + 1 < this.flat.length ? this.flat[i + 1] : i < 0 ? this.flat[0] : null;
        const timed = this.parsed.mode === 'timed';
        return html`
            <div class="now">
                ${prev ? html`<p class="now-line">↑ ${plain(prev.action)}</p>` : ''}
                <p class="now-line now-cur">
                    ${cur
                        ? html`<span class="scene">${timed ? `Scene ${cur.sceneN}` : ''}</span> ${rich(cur.action || DASH)}`
                        : sc && sc.beats[0]
                          ? `Scene ${sc.n} starts — the first beat is at ${sc.beats[0].at}.`
                          : 'Nothing is playing yet.'}
                </p>
                ${cur && cur.narration ? html`<p class="now-line now-quote">${quote(cur.narration)}</p>` : ''}
                <p class="now-line">${next ? `↓ next (suggested ${formatClock(next.atSeconds)}) ${plain(next.action)}` : '↓ end of script'}</p>
            </div>
        `;
    }

    /** The Steps card: the current beat's "In plain words" as numbered steps, as the viewer builds it. */
    renderSteps(sc) {
        const beats = sc.beats || [];
        const at = Math.max(0, this._currentBeatIndex(sc, this.time));
        const beat = beats[at];
        const flatIdx = this._currentFlatIndex(this.time);
        const nav = html`
            <div class="card-nav">
                <button class="btn" title="Previous beat (↑)" ?disabled=${flatIdx <= 0} @click=${() => this.stepBeat(-1)}>↑ Previous beat</button>
                <button class="btn" title="Next beat (↓)" ?disabled=${flatIdx >= this.flat.length - 1} @click=${() => this.stepBeat(1)}>
                    Next beat ↓
                </button>
            </div>
        `;
        if (!beat)
            return html`<div class="card"><h3 class="sp-action">Scene ${sc.n} has no beats.</h3></div>
                ${nav}`;

        const r = beatSteps(beat.plain);
        const KIND = { steps: 'Steps', mixed: 'Steps + explanation', explanation: 'Explanation only', none: 'No plain words' };
        // The click order: the steps plus the instructions buried in the explanation (⚑), in script order.
        const plainText = String(beat.plain || '');
        const ordered = [...r.steps.map(text => ({ text, buried: false })), ...r.hidden.map(text => ({ text, buried: true }))]
            .map(x => ({ ...x, at: plainText.indexOf(x.text) }))
            .sort((x, y) => x.at - y.at);
        const steps = ordered.length ? ordered : [{ text: beat.action || DASH, buried: false }];
        const checkText = r.check.join(' ');
        const ownLead = /^(?:you know|when (?:it|this)|you should see|the screen should|it worked when|if it worked|success looks like)/i.test(
            checkText
        );
        const code = beatCode(sc, beat);
        const expects = beatExpects(sc, beat);

        return html`
            <div class="card">
                <div class="sp-head">
                    <span>Beat ${at + 1} / ${beats.length} · suggested ${beat.at}</span>
                    <span class="sp-kind ${r.kind}">${KIND[r.kind] || ''}</span>
                </div>
                <h3 class="sp-action">${rich(beat.action || DASH)}</h3>
                ${beat.narration ? html`<p class="sp-say">${quote(beat.narration)}</p>` : ''}
                <ol class="sp-list">
                    ${steps.map(
                        x =>
                            html`<li
                                class=${x.buried ? 'buried' : ''}
                                title=${x.buried ? 'This click was written inside the explanation, not as a step' : ''}
                            >
                                ${x.buried ? '⚑ ' : ''}${rich(x.text)}
                            </li>`
                    )}
                </ol>
                ${r.hidden.length
                    ? html`<p class="sp-label">
                          ⚑ = a click the script wrote inside its explanation, placed here in order. Check it before recording.
                      </p>`
                    : ''}
                ${code.map(
                    b => html`
                        <div class="code-block">
                            <div class="code-head">
                                <span>Paste · ${b.label}</span>
                                <button class="btn" @click=${() => this._copy(b.label, b.text)}>
                                    ${this.copied === b.label ? 'Copied' : 'Copy'}
                                </button>
                            </div>
                            <pre><code>${highlightCode(formatCode(b.text)).map(tok =>
                                tok.t === 'text' || tok.t === 'punc' ? tok.v : html`<span class="tk-${tok.t}">${tok.v}</span>`
                            )}</code></pre>
                        </div>
                    `
                )}
                ${checkText ? html`<p class="sp-check">${ownLead ? '✓ ' : '✓ You should see: '}${rich(checkText)}</p>` : ''}
                ${r.fix.length
                    ? html`<ul class="sp-fix">
                          ${r.fix.map(f => html`<li>⚠ ${rich(f)}</li>`)}
                      </ul>`
                    : ''}
                ${expects.length
                    ? html`<ul class="sp-expect">
                          ${expects.map(x => html`<li>✓ ${rich(x)}</li>`)}
                      </ul>`
                    : ''}
                ${(sc.notes || []).length
                    ? html`<ul class="sp-notes">
                          ${sc.notes.map(n => html`<li>Operator note (not spoken): ${rich(n)}</li>`)}
                      </ul>`
                    : ''}
                ${r.why.length
                    ? html`<details class="sp-why">
                          <summary>Why</summary>
                          ${r.why.map(w => html`<p>${rich(w)}</p>`)}
                      </details>`
                    : ''}
            </div>
            ${nav}
        `;
    }

    /** The Reference card: the script's prep checklist, definitions and facts, verbatim. */
    renderRef() {
        const p = this.parsed;
        const prep = p.prep || [];
        const defs = p.definitions || [];
        const facts = p.facts || [];
        return html`
            <div class="card">
                <h3 class="sp-action">Reference</h3>
                ${prep.length
                    ? html`<div class="ref-block">
                          <h4>Before you record</h4>
                          <ol>
                              ${prep.map(x => html`<li>${plain(x)}</li>`)}
                          </ol>
                      </div>`
                    : ''}
                ${defs.length
                    ? html`<div class="ref-block">
                          <h4>Definitions used on camera</h4>
                          <dl>
                              ${defs.map(
                                  d =>
                                      html`<dt>${d.term}</dt>
                                          <dd>${plain(d.text)}</dd>`
                              )}
                          </dl>
                      </div>`
                    : ''}
                ${facts.length
                    ? html`<div class="ref-block">
                          <h4>Facts — read these off screen</h4>
                          <table class="facts">
                              ${facts.map(
                                  f =>
                                      html`<tr title=${f.file}>
                                          <td>${plain(f.fact)}</td>
                                          <td class="value">${plain(f.value)}</td>
                                      </tr>`
                              )}
                          </table>
                      </div>`
                    : ''}
                ${prep.length || defs.length || facts.length ? '' : html`<p class="note">This script has no prep, definitions or facts sections.</p>`}
            </div>
        `;
    }

    renderScroll() {
        const parsed = this.parsed;
        const idx = this._currentFlatIndex(this.time);
        const timed = parsed.mode === 'timed';
        const sceneLabel = n => {
            const scene = parsed.scenes[n - 1];
            if (!scene) return '';
            return timed ? `Scene ${scene.n} — ${scene.app || DASH}` : scene.app;
        };
        let lastScene = null;
        return html`
            <div
                class="prompter"
                style="--script-scale:${this.fontScale};--reading-line:${this.readingLine * 100}%"
                @wheel=${e => this._handleWheel(e)}
            >
                <div class="scroll">
                    <ol class="script-text">
                        ${this.flat.map((entry, i) => {
                            const label = entry.sceneN !== lastScene && parsed.scenes.length > 1 ? sceneLabel(entry.sceneN) : '';
                            lastScene = entry.sceneN;
                            return html`
                                <li class="line ${i === idx ? 'current' : i < idx ? 'past' : ''}" @click=${() => this.seekTo(entry.atSeconds)}>
                                    ${label ? html`<span class="scene-label">${label}</span>` : ''} ${rich(entry.action || DASH)}
                                    ${entry.narration ? html`<div class="narration">${quote(entry.narration)}</div>` : ''}
                                </li>
                            `;
                        })}
                    </ol>
                </div>
                <div
                    class="reading-line ${this._lineDragging ? 'dragging' : ''}"
                    title="Drag to move the reading line · double-click to reset"
                    @pointerdown=${e => this._startLineDrag(e)}
                    @pointermove=${e => this._dragLine(e)}
                    @pointerup=${() => this._endLineDrag()}
                    @pointercancel=${() => this._endLineDrag()}
                    @dblclick=${() => this._resetLine()}
                ></div>
            </div>
        `;
    }
}

customElements.define('script-view', ScriptView);
