import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    loadScript,
    flatTimeline,
    beatCode,
    beatExpects,
    beatSteps,
    sceneSlides,
    scenePace,
    sceneAutoAdvanceDue,
    shortFile,
} from '../src/ui/script/scriptTimeline.js';

// The shape of the tasksbaby IT pack scripts: narration beats, "In plain words",
// a numbered code block of paste stages, an Expected line and a facts table.
const SCRIPT = `# Play-by-Play Recording Script

**Title:** test the incident service
**Base slug:** \`it_demo\`

## Facts from the pack

| Fact | Value | File |
|---|---|---|
| rows in the ticket export | 12 | \`it_demo_tickets_r1.csv\` |

### Scene 1 — Setup + Provenance (1:00)

| Time | Action | Narration beat |
|---|---|---|
| 0:00 | Open the inputs folder \`it_demo_tickets_r1.csv\`. | "Every input was made for this exercise, all 12 rows." |
| 0:30 | Confirm nothing is branded. | — |

#### In plain words

- **0:00** - Open the file manager on the inputs folder. When it worked, one window lists the files.
- **0:30** - Look over the screen for logos.

**Checkpoint (silent):** inputs local.

### Scene 2 — Insomnia: write the tests (2:00)

| Time | Action | Narration beat |
|---|---|---|
| 1:00 | Click New Test and paste stage 2. | "Second test: the list returns 12 rows." |
| 2:00 | Click Run Tests and wait for every test. | "I run the tests." |

\`\`\`javascript
1. expect(status).to.equal(200);
2. expect(body).to.have.lengthOf(12);
\`\`\`

Expected result in Run Tests: 2 passing.

**Hard evidence produced:** \`it_demo_export_r1.json\` — the export.

## Total runtime budget

| Scene | App | Time |
|---|---|---|
| **Total** | | **~3:00** |
`;

test('reads beats, plain words, checkpoint after the plain-words block, and facts', () => {
    const p = loadScript(SCRIPT);
    assert.equal(p.mode, 'timed');
    assert.equal(p.totalSeconds, 180);
    assert.deepEqual(p.warnings, []);
    assert.equal(p.scenes[0].checkpoint, 'inputs local.');
    assert.match(p.scenes[0].beats[0].plain, /^Open the file manager/);
    assert.equal(p.scenes[0].beats[1].narration, '');
    assert.deepEqual(p.facts, [{ fact: 'rows in the ticket export', value: '12', file: 'it_demo_tickets_r1.csv' }]);
    assert.equal(flatTimeline(p).length, 4);
});

test('a beat that says "paste stage 2" gets stage 2, and Run Tests gets the Expected line', () => {
    const sc = loadScript(SCRIPT).scenes[1];
    assert.deepEqual(beatCode(sc, sc.beats[0]), [{ label: 'Stage 2', text: 'expect(body).to.have.lengthOf(12);' }]);
    assert.deepEqual(beatCode(sc, sc.beats[1]), []);
    assert.deepEqual(beatExpects(sc, sc.beats[1]), ['Expected result in Run Tests: 2 passing.']);
});

test('plain words split into a step and a "you should see" check', () => {
    const r = beatSteps(loadScript(SCRIPT).scenes[0].beats[0].plain);
    assert.deepEqual(r.steps, ['Open the file manager on the inputs folder.']);
    assert.deepEqual(r.check, ['When it worked, one window lists the files.']);
});

test('slides carry the objective, talking points and the files used and made', () => {
    const [s1, s2] = sceneSlides(loadScript(SCRIPT));
    assert.equal(s1.app, 'Setup + Provenance');
    assert.deepEqual(s1.points, ['Every input was made for this exercise, all 12 rows.', 'Confirm nothing is branded.']);
    assert.deepEqual(s1.uses, ['it_demo_tickets_r1.csv']);
    assert.equal(s2.objective, 'write the tests');
    assert.equal(s2.makes, 'it_demo_export_r1.json');
    assert.equal(shortFile(s2.makes, 'it_demo'), 'export.json');
});

test('pace and auto-advance read only the stopwatch', () => {
    assert.equal(scenePace({ budget: 60, plannedStart: 0, enteredAt: 0, watch: 30 }).level, 'ok');
    assert.equal(scenePace({ budget: 60, plannedStart: 0, enteredAt: 0, watch: 55 }).level, 'warn');
    assert.equal(scenePace({ budget: 60, plannedStart: 0, enteredAt: 0, watch: 61 }).level, 'over');
    assert.equal(sceneAutoAdvanceDue({ budget: 60, enteredAt: 10, watch: 69 }), false);
    assert.equal(sceneAutoAdvanceDue({ budget: 60, enteredAt: 10, watch: 70 }), true);
});
