// ==UserScript==
// @name         Education Perfect Auto-Answer
// @namespace    http://tampermonkey.net/
// @version      2.0
// @description  Automatically answers all question types on Education Perfect
// @match        https://app.educationperfect.com/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function () {
  'use strict';

  let running = false;
  let loopTimeout = null;
  // Track whether we have already typed into the current long-answer editor
  let longAnswerTyped = false;

  // ── Log panel ─────────────────────────────────────────────────────────────

  function log(msg, color) {
    if (!(window.__phantomSettings && window.__phantomSettings.debugMode)) return;
    let panel = document.getElementById('ep-macro-log');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'ep-macro-log';
      Object.assign(panel.style, {
        position:'fixed', top:'8px', right:'8px', zIndex:'2147483647',
        background:'rgba(0,0,0,0.88)', color:'#fff', padding:'6px 10px',
        borderRadius:'6px', fontSize:'11px', fontFamily:'monospace',
        maxWidth:'320px', maxHeight:'180px', overflowY:'auto',
        pointerEvents:'none', lineHeight:'1.4',
      });
      document.body.appendChild(panel);
    }
    const line = document.createElement('div');
    line.textContent = msg;
    if (color) line.style.color = color;
    panel.appendChild(line);
    panel.scrollTop = panel.scrollHeight;
    while (panel.children.length > 20) panel.removeChild(panel.firstChild);
  }

  // ── Angular helpers ────────────────────────────────────────────────────────

  function getScope() {
    const el = document.querySelector('.game-page');
    if (!el) return null;
    try { return angular.element(el).scope(); } catch { return null; }
  }

  function getCurrentQuestion() {
    const scope = getScope();
    if (!scope) return null;
    const game = scope.game;
    return game && game.model && game.model._currentQuestion || null;
  }

  function getComponents() {
    const q = getCurrentQuestion();
    return q && q.questionDef && q.questionDef.Components || [];
  }

  function getComponent(typeCode) {
    return getComponents().find(c => c.ComponentTypeCode === typeCode) || null;
  }

  // ── DOM helpers ────────────────────────────────────────────────────────────

  // Find a visible <button> by its exact trimmed text.
  function findBtn(text) {
    return [...document.querySelectorAll('button')].find(
      b => b.textContent.trim() === text && b.offsetParent !== null
    );
  }

  // Find a visible <a> or <button> by text (partial match OK).
  function findLink(text) {
    return [...document.querySelectorAll('a, button')].find(
      el => el.textContent.trim().includes(text) && el.offsetParent !== null
    );
  }

  // ── Timer check ────────────────────────────────────────────────────────────

  function isTimerRunning() {
    return !![...document.querySelectorAll('button')].find(
      b => /\d+\s*s\s*(remaining)?/i.test(b.textContent.trim()) && b.offsetParent !== null
    );
  }

  // ── Modal / dialog buttons ─────────────────────────────────────────────────

  // Handles all post-question and section-transition modals.
  function clickModalButton() {
    // Long-answer feedback: "Got It!" (success) or AI feedback dismissed
    const gotIt = findBtn('Got It!');
    if (gotIt) { gotIt.click(); longAnswerTyped = false; return true; }

    // "Have a go!" dialog: skip to showing model answer
    const stuck = findLink("I'm stuck");
    if (stuck) { stuck.click(); return true; }

    // Section-complete modal
    const nextSection = findBtn('Next Section');
    if (nextSection) { nextSection.click(); longAnswerTyped = false; return true; }

    // Post-answer next-question button (shown inside explanation panel)
    const nextQuestion = findBtn('Next Question');
    if (nextQuestion) { nextQuestion.click(); return true; }

    // "Next Up..." recommended lesson cards — click first one to start next lesson
    const nextTaskCard = document.querySelector('.next-task.ng-scope');
    if (nextTaskCard && nextTaskCard.offsetParent) {
      log('Next Up: clicking first recommended lesson', '#4fc');
      angular.element(nextTaskCard).triggerHandler('click');
      longAnswerTyped = false;
      return true;
    }

    // Activity Completed: rate confidence (blue stars) if unrated
    const blueStar = document.querySelector('.grey-star.blue-star-hover');
    if (blueStar && blueStar.offsetParent) {
      log('Rating confidence...', '#4fc');
      angular.element(blueStar).triggerHandler('click');
      return true;
    }

    // Activity Completed: rate helpfulness (yellow stars) if unrated
    const yellowStar = document.querySelector('.grey-star.yellow-star-hover');
    if (yellowStar && yellowStar.offsetParent) {
      log('Rating helpfulness...', '#4fc');
      angular.element(yellowStar).triggerHandler('click');
      return true;
    }

    // "Next Activity" button (appears when lesson ends — opens Activity Completed view)
    const nextActivity = findBtn('Next Activity');
    if (nextActivity) { nextActivity.click(); longAnswerTyped = false; return true; }

    return false;
  }

  // ── Navigation: Continue (info slides) ────────────────────────────────────

  function clickContinue() {
    const btn = findBtn('Continue');
    if (btn) { btn.click(); return true; }
    return false;
  }

  // EP TextTemplate uses [block align="center"\nText\n] markup — extract inner text.
  // Options also use backtick inline-code syntax (e.g. `110` Bpm) rendered as plain text in DOM.
  function stripTemplate(t) {
    if (!t) return '';
    if (/^\[image\b/i.test(t.trim())) return ''; // image blocks have no matchable text
    t = t.replace(/\[block[^\n]*\n([\s\S]*?)\n?\]/gi, '$1');
    t = t.replace(/`+([^`\n]*)`+/g, '$1');  // strip inline code backticks
    t = t.replace(/<[^>]+>/g, '');           // strip HTML tags
    // Convert common LaTeX to Unicode so DOM text matching works
    t = t.replace(/\\frac\{([^}]*)\}\{([^}]*)\}/g, '$1/$2');
    t = t.replace(/\^?\{?\\circ\}?/g, '°');
    t = t.replace(/\\text\{([^}]*)\}/g, '$1');
    t = t.replace(/\\times/g, '×');
    t = t.replace(/\\cdot/g, '·');
    t = t.replace(/\\pm/g, '±');
    t = t.replace(/\\mu/g, 'μ');
    t = t.replace(/\^[\{]?(\w+)[\}]?/g, '$1');  // remove superscript notation
    t = t.replace(/[\{\}\\]/g, '');               // strip remaining LaTeX delimiters
    return t.trim();
  }

  // ── MCQ (Multiple Choice) ──────────────────────────────────────────────────

  function clickOption(input) {
    // Strategy 1: direct click on input
    if (!input.checked) {
      input.click();
      log('  click input → checked=' + input.checked, input.checked ? '#4f4' : '#fa0');
    }
    if (input.checked) return true;

    // Strategy 2: click parent
    if (input.parentElement) {
      input.parentElement.click();
      log('  click parent → checked=' + input.checked, input.checked ? '#4f4' : '#fa0');
    }
    if (input.checked) return true;

    // Strategy 3: full mouse event sequence on the input
    const rect = input.getBoundingClientRect();
    const cx = Math.round(rect.left + rect.width / 2);
    const cy = Math.round(rect.top + rect.height / 2);
    const mo = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, detail: 1 };
    input.dispatchEvent(new MouseEvent('mousedown', mo));
    input.dispatchEvent(new MouseEvent('mouseup',   mo));
    input.dispatchEvent(new MouseEvent('click',     mo));
    log('  mouseEvent → checked=' + input.checked, input.checked ? '#4f4' : '#f44');

    return true;
  }

  function handleMCQ() {
    const comp = getComponent('MULTICHOICE_COMPONENT') || getComponent('TRUE_FALSE_COMPONENT');
    if (!comp) { log('MCQ: no component', '#f44'); return false; }

    // ALL correct options (could be multiple for "Select ALL correct" questions)
    const correctOpts = (comp.Options || []).filter(o => o.Correct === 'true' || o.Correct === true);
    if (!correctOpts.length) { log('MCQ: no correct option', '#f44'); return false; }

    const correctTexts = new Set(correctOpts.map(o => stripTemplate(o.TextTemplate)));
    log('MCQ: want ' + correctOpts.length + ': ' + [...correctTexts].map(t => '"' + t.substring(0,12) + '"').join(', '), '#ff9');

    const inputs = [...document.querySelectorAll(
      '.game-page input[type="checkbox"], .game-page input[type="radio"]'
    )].filter(i => !i.disabled);
    log('MCQ: ' + inputs.length + ' inputs found', '#aaa');

    let matched = 0;
    for (let i = 0; i < inputs.length; i++) {
      const input = inputs[i];
      const sibText = (input.nextElementSibling || {}).textContent || '';
      const parText = (input.parentElement || {}).textContent || '';
      if (correctTexts.has(sibText.trim()) || correctTexts.has(parText.trim())) {
        log('  → match idx ' + i + ' "' + sibText.trim().substring(0,20) + '"', '#4f4');
        if (!input.checked) clickOption(input);
        matched++;
      }
    }

    if (matched > 0) {
      log('MCQ: matched ' + matched + '/' + correctOpts.length, matched === correctOpts.length ? '#4f4' : '#fa0');
      return true;
    }

    // Index fallback if no text matched
    log('MCQ: no text match, using index fallback', '#fa0');
    let any = false;
    correctOpts.forEach(opt => {
      const idx = comp.Options.indexOf(opt);
      if (idx >= 0 && inputs[idx] && !inputs[idx].checked) {
        clickOption(inputs[idx]);
        any = true;
      }
    });
    return any;
  }

  // ── Multi-select (checkboxes) ──────────────────────────────────────────────

  function handleMultiSelect() {
    const comp = getComponent('MULTISELECT_COMPONENT') || getComponent('MULTI_SELECT_COMPONENT')
              || (getComponent('MULTICHOICE_COMPONENT') && getComponent('MULTICHOICE_COMPONENT').AllowMultiSelect ? getComponent('MULTICHOICE_COMPONENT') : null);
    if (!comp) return false;

    const correctOptions = (comp.Options || []).filter(
      o => o.Correct === 'true' || o.Correct === true
    );
    if (!correctOptions.length) return false;

    const correctTexts = new Set(correctOptions.map(o => stripTemplate(o.TextTemplate)));
    const boxes = [...document.querySelectorAll('.game-page input[type="checkbox"]:not(:disabled)')];
    let clicked = false;
    for (const box of boxes) {
      const sib = box.nextElementSibling;
      const sibText = sib ? sib.textContent.trim() : '';
      const parentText = box.parentElement ? box.parentElement.textContent.trim() : '';
      if (correctTexts.has(sibText) || correctTexts.has(parentText)) {
        if (!box.checked) { clickOption(box); clicked = true; }
      }
    }
    return clicked;
  }

  // ── Short Answer ───────────────────────────────────────────────────────────

  function handleShortAnswer() {
    const comp = getComponent('SHORT_ANSWER_COMPONENT') || getComponent('SHORT_ANSWER');
    if (!comp) return false;

    // Find the correct answer text — EP stores it in various fields
    let answerText = null;
    const candidates = [
      comp.Answer, comp.CorrectAnswer, comp.ModelAnswer,
      (comp.ValidAnswers || [])[0],
      (comp.Answers || [])[0],
      (comp.Options && comp.Options.find(o => o.Correct === 'true' || o.Correct === true) || {}).TextTemplate,
    ].filter(Boolean);

    if (candidates.length) {
      answerText = String(candidates[0]).replace(/<[^>]+>/g, '').trim();
    }

    if (!answerText) return false;

    const input = document.querySelector(
      'input[type="text"]:not(:disabled), input[type="search"]:not(:disabled)'
    );
    if (!input || input.offsetParent === null) return false;

    input.focus();
    // Use native input value setter so Angular/React detects the change
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value'
    ).set;
    nativeInputValueSetter.call(input, answerText);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  // ── Cloze / Fill-in-the-blank ──────────────────────────────────────────────

  function handleCloze() {
    const comp = getComponent('CLOZE_COMPONENT') || getComponent('CLOZE');
    if (!comp) return false;

    // Cloze gaps are either <input> fields or drag targets.
    // For input-style gaps, find each blank and fill with the correct word.
    const blanks = [...document.querySelectorAll('.cloze-input, input.blank, [class*="cloze"] input:not(:disabled)')];
    if (!blanks.length) return false;

    // Try to get correct words from Gaps array
    const gaps = comp.Gaps || comp.Blanks || [];
    blanks.forEach((blank, i) => {
      if (blank.value) return; // already filled
      const gap = gaps[i];
      let word = null;
      if (gap) {
        word = gap.Answer || gap.CorrectAnswer || (gap.Answers && gap.Answers[0]) || null;
      }
      if (word) {
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype, 'value'
        ).set;
        nativeInputValueSetter.call(blank, word);
        blank.dispatchEvent(new Event('input', { bubbles: true }));
        blank.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    return true;
  }

  // ── Fill-in-gaps drag-and-drop (InputType=2) ──────────────────────────────

  function simulateDrag(dragEl, dropEl) {
    const dr = dragEl.getBoundingClientRect();
    const dp = dropEl.getBoundingClientRect();
    const sx = dr.left + dr.width / 2, sy = dr.top + dr.height / 2;
    const tx = dp.left + dp.width / 2, ty = dp.top + dp.height / 2;
    const pe = (el, type, x, y) => el.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, clientX: x, clientY: y,
      pointerId: 1, pointerType: 'mouse', isPrimary: true,
      pressure: type === 'pointerup' ? 0 : 0.5,
    }));
    pe(dragEl, 'pointerdown', sx, sy);
    pe(document, 'pointermove', sx + 2, sy + 2);
    pe(document, 'pointermove', (sx + tx) / 2, (sy + ty) / 2);
    pe(document, 'pointermove', tx, ty);
    pe(dropEl,  'pointerenter', tx, ty);
    pe(dropEl,  'pointerup',    tx, ty);
    pe(document,'pointerup',    tx, ty);
  }

  function handleFillInGaps() {
    const comp = getComponent('FILL_IN_GAPS_COMPONENT');
    if (!comp) return false;

    const gaps = comp.Gaps || [];
    if (!gaps.length) return false;

    // For text-input gaps (InputType=1) reuse cloze logic
    if (comp.InputType === 1) {
      const blanks = [...document.querySelectorAll(
        '.fitg-component input:not(:disabled), [id*="FillInTheGaps"] input:not(:disabled)'
      )].filter(e => e.offsetParent !== null);
      if (!blanks.length) return false;
      const nv = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      blanks.forEach((blank, i) => {
        const word = gaps[i] && gaps[i].CorrectOptions && gaps[i].CorrectOptions[0];
        if (word && !blank.value) {
          nv.call(blank, word);
          blank.dispatchEvent(new Event('input', { bubbles: true }));
          blank.dispatchEvent(new Event('change', { bubbles: true }));
        }
      });
      return true;
    }

    // Drag-and-drop gaps (InputType=2)
    // Drop zones use id pattern: FillInTheGaps_*_input_N
    const zones = [...document.querySelectorAll('[id*="FillInTheGaps"][id*="input"]')]
      .filter(e => e.offsetParent !== null && e.className.includes('fitg-inline-dropzone'))
      .sort((a, b) => parseInt(a.id.split('_').pop()) - parseInt(b.id.split('_').pop()));

    if (!zones.length) {
      log('FITG: no dropzones found', '#f44');
      return false;
    }
    log('FITG: ' + zones.length + ' zones, ' + gaps.length + ' gaps', '#ff9');

    let filled = 0;
    for (let i = 0; i < Math.min(gaps.length, zones.length); i++) {
      const word = gaps[i] && gaps[i].CorrectOptions && gaps[i].CorrectOptions[0];
      if (!word) continue;
      // Skip zones that already have content
      if (!zones[i].classList.contains('empty')) continue;

      const chip = [...document.querySelectorAll('.draggable')]
        .find(d => d.textContent.trim() === word && d.offsetParent !== null);
      if (!chip) { log('FITG: chip not found for "' + word + '"', '#fa0'); continue; }

      log('FITG: drag "' + word + '" → gap ' + i, '#4f4');
      simulateDrag(chip, zones[i]);
      filled++;
    }
    return filled > 0;
  }

  // ── Dropdown ───────────────────────────────────────────────────────────────

  function handleDropdown() {
    const comp = getComponent('DROPDOWN_COMPONENT');
    if (!comp) return false;
    const correctOpt = (comp.Options || []).find(o => o.Correct === 'true' || o.Correct === true);
    if (!correctOpt) return false;
    const answer = correctOpt.Description;
    if (!answer || answer.trim() === '< None >') return false;
    const sel = document.querySelector('.game-page select');
    if (!sel || sel.offsetParent === null) return false;
    const nv = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    nv.call(sel, answer.trim());
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    log('Dropdown: "' + answer.trim() + '"', '#4fc');
    return true;
  }

  // ── Matching ───────────────────────────────────────────────────────────────

  function handleMatching() {
    const comp = getComponent('MATCHING_COMPONENT') || getComponent('MATCH_COMPONENT');
    if (!comp) return false;

    // Matching uses dropdowns or drag-and-drop.
    // Try dropdown approach first.
    const selects = [...document.querySelectorAll('select:not(:disabled)')].filter(
      s => s.offsetParent !== null
    );
    if (!selects.length) return false;

    const pairs = comp.Pairs || comp.Options || [];
    selects.forEach((sel, i) => {
      const pair = pairs[i];
      if (!pair) return;
      const correctVal = pair.CorrectMatch || pair.Answer || pair.RightText;
      if (!correctVal) return;
      // Find the matching option
      const opt = [...sel.options].find(o => o.text.trim() === correctVal.trim());
      if (opt) sel.value = opt.value;
    });
    return true;
  }

  // ── Long Answer (essay / rich text) ───────────────────────────────────────

  // Generic answers for long-answer brainstorming / reflection questions.
  const LONG_ANSWER_TEXT =
    'Science helps us understand the natural world through systematic observation and data analysis. ' +
    'By studying the world around us, scientists can answer important questions and develop new technologies.';

  function handleLongAnswer() {
    const comp = getComponent('LONG_ANSWER_COMPONENT');
    if (!comp) return false;

    const editor = document.querySelector('.ProseMirror[contenteditable="true"]');
    if (!editor || editor.offsetParent === null) return false;

    if (!longAnswerTyped || editor.textContent.trim().length < 5) {
      editor.focus();
      // Clear existing content first
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);
      document.execCommand('insertText', false, LONG_ANSWER_TEXT);
      longAnswerTyped = true;
      return true; // re-run step to then click Check Answer
    }

    const checkBtn = findBtn('Check Answer');
    if (checkBtn) { checkBtn.click(); return true; }

    return false;
  }

  // ── Submit ────────────────────────────────────────────────────────────────

  function clickSubmit() {
    const btn = findBtn('Submit');
    if (btn) { btn.click(); return true; }
    return false;
  }

  // ── Detect which question type is active ──────────────────────────────────

  function getActiveComponentType() {
    const comps = getComponents();
    if (!comps.length) return null;
    return comps[0].ComponentTypeCode || null;
  }

  // ── Assessment ────────────────────────────────────────────────────────────

  function isAssessment() {
    return window.location.pathname.includes('/assessment/');
  }

  // Returns {idx, text} for the correct MCQ option.
  // previewOptions (display order) are used when available.
  // Renderer validation requires count match + text overlap with current Options.
  function getAssessmentCorrect() {
    const comp = getComponent('MULTICHOICE_COMPONENT') || getComponent('TRUE_FALSE_COMPONENT');
    if (!comp) return null;

    const q = getCurrentQuestion();
    const compId = String(comp.ComponentID || '');
    const options = comp.Options || [];

    const isVariableBased = options.some(o => {
      const c = o.Correct;
      if (typeof c !== 'string') return false;
      const cl = c.trim().toLowerCase();
      return cl !== 'true' && cl !== 'false' && cl.length > 0;
    });

    const poText = (o) => {
      for (const k of ['text', 'label', 'displayText', 'TextTemplate', 'content', 'value']) {
        if (o[k] && typeof o[k] === 'string') return o[k];
      }
      return '';
    };

    // Renderer validation: option count must match, and any text must overlap with Options.
    // A same-count stale renderer with no text passes — we can't perfectly distinguish those.
    const isCurrentQuestion = (po) => {
      if (po.length !== options.length) return false;
      const poTexts = po.map(o => stripTemplate(poText(o)).toLowerCase().trim()).filter(t => t.length > 1);
      if (poTexts.length === 0) return true; // count matched, no text to check further
      const optTexts = options.map(o => stripTemplate(o.TextTemplate || '').toLowerCase().trim());
      const hits = poTexts.filter(pt => optTexts.some(ot => ot === pt || ot.includes(pt) || pt.includes(ot))).length;
      return hits >= Math.ceil(poTexts.length / 2);
    };

    const scanBlocks = (blocks, label) => {
      for (const block of (blocks || [])) {
        const po = block?.component?.componentState?.previewOptions;
        if (!po || !po.length || !po.some(o => 'correct' in o)) continue;
        if (!isCurrentQuestion(po)) {
          log('MCQ skipped renderer (' + label + ') cnt=' + po.length + '/' + options.length, '#888');
          continue;
        }
        const idx = po.findIndex(o => o.correct === true);
        if (idx >= 0) {
          const raw = poText(po[idx]);
          const text = raw ? stripTemplate(raw) : '';
          log('MCQ previewOpts idx=' + idx + '/' + po.length + ' text="' + text.substring(0, 20) + '" (' + label + ')', '#4af');
          return { idx, text };
        }
      }
      return null;
    };

    if (q?.cachedRenderers) {
      if (compId && q.cachedRenderers[compId]) {
        const r = scanBlocks(q.cachedRenderers[compId].composition?.blocks, 'compId=' + compId);
        if (r) return r;
      }
      for (const key of Object.keys(q.cachedRenderers)) {
        if (key === compId) continue;
        const r = scanBlocks(q.cachedRenderers[key]?.composition?.blocks, 'key=' + key);
        if (r) { log('MCQ previewOpts validated renderer key=' + key, '#4af'); return r; }
      }
    }

    if (isVariableBased) {
      log('MCQ variable: no valid renderer, skipping', '#f84');
      return null;
    }

    // Collect all options with Correct=true (handles boolean true, string 'true'/'True')
    const correctIndices = [];
    for (let i = 0; i < options.length; i++) {
      const c = options[i].Correct;
      if (c === true || (typeof c === 'string' && c.trim().toLowerCase() === 'true')) correctIndices.push(i);
    }
    if (correctIndices.length === 0) return null;
    let idx = correctIndices[0];
    // When multiple options are marked correct, use CorrectDisplayed as 0-based index into that list
    if (correctIndices.length > 1 && typeof comp.CorrectDisplayed === 'number') {
      const cd = comp.CorrectDisplayed;
      if (cd >= 0 && cd < correctIndices.length) {
        idx = correctIndices[cd];
        log('MCQ Options multi-correct CorrectDisplayed=' + cd + ' correctIndices=' + correctIndices.join(',') + ' → idx=' + idx, '#fa0');
      }
    }
    const tmpl = options[idx].TextTemplate || '';
    const text = stripTemplate(tmpl);
    log('MCQ Options idx=' + idx + ' text="' + text.substring(0, 20) + '"', '#fa0');
    return { idx, text };
  }

  function clickAssessmentMCQ() {
    const comp = getComponent('MULTICHOICE_COMPONENT') || getComponent('TRUE_FALSE_COMPONENT');
    if (!comp) return false;

    const correct = getAssessmentCorrect();
    if (!correct) return false;

    const { idx: correctIdx } = correct;
    const correctText = correct.text; // empty = skip text matching, use index directly

    const inputs = [...document.querySelectorAll(
      '.game-page input[type="radio"]:not(:disabled), .game-page input[type="checkbox"]:not(:disabled)'
    )];

    // Normalize all Unicode space variants (EP uses thin-space \u202f between numbers and units)
    const norm = s => s.replace(/[\s\u00a0\u202f\u2009\u2007\u2006\u2005\u2004\u2002\u200a\u200b]+/g, ' ').trim();
    const normCorrect = norm(correctText);
    const tokenize = s => s.match(/\d+\.?\d*|[a-zA-Z\u00b0\u03bc\u00d7\u00b7\u00b1\u00b2\u00b3\/%]+/g) || [];
    const targetTokens = tokenize(normCorrect);
    log('Assessment MCQ: want "' + normCorrect.substring(0, 25) + '"', '#aaf');

    if (normCorrect) {
      // 1. Exact match
      for (const input of inputs) {
        const sibText = norm((input.nextElementSibling || {}).textContent || '');
        const parText = norm((input.parentElement || {}).textContent || '');
        if (sibText === normCorrect || parText === normCorrect) {
          if (input.checked) return true;
          clickOption(input);
          log('Assessment MCQ: exact "' + normCorrect.substring(0, 20) + '"', '#4f4');
          return true;
        }
      }
      // 2. Substring match
      for (const input of inputs) {
        const parText = norm((input.parentElement || {}).textContent || '');
        if (parText.includes(normCorrect)) {
          if (input.checked) return true;
          clickOption(input);
          log('Assessment MCQ: substr "' + normCorrect.substring(0, 20) + '"', '#fa0');
          return true;
        }
      }
      // 3. Token overlap
      if (targetTokens.length > 0) {
        let bestInput = null, bestScore = 0;
        for (const input of inputs) {
          const parText = norm((input.parentElement || {}).textContent || '');
          const optTokens = tokenize(parText);
          let score = 0;
          for (const t of targetTokens) { if (optTokens.includes(t)) score++; }
          if (score > bestScore) { bestScore = score; bestInput = input; }
        }
        if (bestInput && bestScore > 0) {
          if (bestInput.checked) { log('Assessment MCQ: token already checked', '#888'); return true; }
          clickOption(bestInput);
          log('Assessment MCQ: token ' + bestScore + '/' + targetTokens.length + ' "' + normCorrect.substring(0, 15) + '"', '#fa0');
          return true;
        }
      }
    }

    // 4. Last-resort index fallback (risky if DOM order != Options order)
    if (inputs[correctIdx]?.checked) { log('Assessment MCQ: idx ' + correctIdx + ' already checked', '#888'); return true; }
    if (inputs[correctIdx]) {
      clickOption(inputs[correctIdx]);
      log('Assessment MCQ: idx fallback ' + correctIdx, '#f84');
      return true;
    }

    return false;
  }
  function getAssessmentProgress() {
    const m = document.body.innerText.match(/(\d+)\s+of\s+(\d+)/);
    return m ? { current: parseInt(m[1]), total: parseInt(m[2]) } : null;
  }

  function clickNext() {
    const btn = document.querySelector('.btn.next') || findBtn('Next');
    if (btn && btn.offsetParent !== null) { btn.click(); return true; }
    return false;
  }

  function clickSubmitAssessment() {
    const btn = findBtn('Submit Assessment');
    if (btn && btn.offsetParent !== null) { btn.click(); return true; }
    return false;
  }

  // Confirm the "Are you sure?" modal EP shows after Submit Assessment.
  // Only fires when the modal overlay is actually present.
  function clickConfirmSubmit() {
    const overlay = document.querySelector('[class*="modal"], [class*="dialog"], [class*="overlay"]');
    if (!overlay || overlay.offsetParent === null) return false;
    for (const text of ['Yes, submit', 'Submit', 'Confirm', 'Yes']) {
      const btn = findBtn(text);
      if (btn) { btn.click(); return true; }
    }
    return false;
  }

  function assessmentStep() {
    // Confirmation modal after Submit Assessment
    if (clickConfirmSubmit()) { reschedule(2000); return; }

    // No game-page means results page — done
    if (!document.querySelector('.game-page')) { running = false; return; }

    const compType = getActiveComponentType();

    // No question yet (loading or intro slide) — try Continue, then wait
    if (!compType) {
      if (clickContinue()) { reschedule(1000); return; }
      reschedule(700);
      return;
    }

    // Answer the question
    let answered = false;
    if (compType === 'MULTICHOICE_COMPONENT' || compType === 'TRUE_FALSE_COMPONENT') {
      answered = clickAssessmentMCQ();
    } else if (compType === 'SHORT_ANSWER_COMPONENT' || compType === 'SHORT_ANSWER') {
      answered = handleShortAnswer();
    } else if (compType === 'FILL_IN_GAPS_COMPONENT') {
      answered = handleFillInGaps();
    } else if (compType === 'CLOZE_COMPONENT' || compType === 'CLOZE') {
      answered = handleCloze();
    } else {
      // Unknown type — advance anyway
      answered = true;
    }

    if (answered) {
      reschedule(400, () => {
        const progress = getAssessmentProgress();
        if (progress && progress.current >= progress.total) {
          // Last question — submit
          if (!clickSubmitAssessment()) reschedule(800, () => clickSubmitAssessment());
        } else {
          if (!clickNext()) reschedule(800, () => { if (!clickNext()) clickSubmitAssessment(); });
          else reschedule(600);
        }
      });
      return;
    }

    reschedule(700);
  }

  // ── Main loop ──────────────────────────────────────────────────────────────

  function step() {
    if (!running) return;

    // Assessment mode: separate loop
    if (isAssessment()) { assessmentStep(); return; }

    // 0. Activity-starter page — click Start Lesson to begin
    if (window.location.href.includes('activity-starter')) {
      const startBtn = [...document.querySelectorAll('button')]
        .find(b => b.offsetParent !== null && /start lesson/i.test(b.textContent));
      if (startBtn) {
        log('Starting lesson...', '#4fc');
        startBtn.click();
        reschedule(3000);
      } else {
        reschedule(800);
      }
      return;
    }

    // 1. Handle any modal/dialog buttons first (they overlay the timer)
    if (clickModalButton()) { reschedule(1200); return; }

    // 2. Timer still ticking on slide — wait
    if (isTimerRunning()) { reschedule(500); return; }

    // 3. Info slide Continue
    if (clickContinue()) { reschedule(1000); return; }

    // 4. Question-type dispatch
    const compType = getActiveComponentType();

    if (compType === 'MULTICHOICE_COMPONENT' || compType === 'TRUE_FALSE_COMPONENT') {
      if (handleMCQ()) {
        reschedule(600, () => { clickSubmit(); reschedule(1500); });
        return;
      }
    }

    if (compType === 'MULTISELECT_COMPONENT' || compType === 'MULTI_SELECT_COMPONENT') {
      if (handleMultiSelect()) {
        reschedule(600, () => { clickSubmit(); reschedule(1500); });
        return;
      }
    }

    if (compType === 'SHORT_ANSWER_COMPONENT' || compType === 'SHORT_ANSWER') {
      if (handleShortAnswer()) {
        reschedule(600, () => { clickSubmit(); reschedule(1500); });
        return;
      }
    }

    if (compType === 'FILL_IN_GAPS_COMPONENT') {
      if (handleFillInGaps()) {
        reschedule(1000, () => { clickSubmit(); reschedule(1500); });
        return;
      }
    }

    if (compType === 'CLOZE_COMPONENT' || compType === 'CLOZE') {
      if (handleCloze()) {
        reschedule(600, () => { clickSubmit(); reschedule(1500); });
        return;
      }
    }

    if (compType === 'DROPDOWN_COMPONENT') {
      if (handleDropdown()) {
        reschedule(600, () => { clickSubmit(); reschedule(1500); });
        return;
      }
    }

    if (compType === 'MATCHING_COMPONENT' || compType === 'MATCH_COMPONENT') {
      if (handleMatching()) {
        reschedule(600, () => { clickSubmit(); reschedule(1500); });
        return;
      }
    }

    if (compType === 'LONG_ANSWER_COMPONENT') {
      if (handleLongAnswer()) { reschedule(900); return; }
    }

    // 5. Fallback: try Submit if any button is there
    if (clickSubmit()) { reschedule(1500); return; }

    // 6. Nothing matched — keep polling
    reschedule(700);
  }

  function reschedule(ms, fn) {
    clearTimeout(loopTimeout);
    loopTimeout = setTimeout(() => {
      if (fn) fn();
      else step();
    }, ms);
  }

  // ── UI button ──────────────────────────────────────────────────────────────

  function addUI() {
    if (document.getElementById('ep-macro-btn')) return;

    const btn = document.createElement('button');
    btn.id = 'ep-macro-btn';
    btn.textContent = '▶ Auto';
    Object.assign(btn.style, {
      position: 'fixed',
      bottom: '20px',
      left: '20px',
      zIndex: '2147483647',
      padding: '10px 18px',
      background: '#28a745',
      color: '#fff',
      border: 'none',
      borderRadius: '6px',
      fontSize: '14px',
      fontWeight: 'bold',
      cursor: 'pointer',
      boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
      fontFamily: 'sans-serif',
    });

    btn.addEventListener('click', () => {
      running = !running;
      longAnswerTyped = false;
      btn.textContent = running ? '⏹ Stop' : '▶ Auto';
      btn.style.background = running ? '#dc3545' : '#28a745';
      if (running) step();
      else clearTimeout(loopTimeout);
    });

    document.body.appendChild(btn);
  }

  // Expose a start function so phantom.py can auto-start after inject
  window.__phantomStart = function() {
    addUI();
    if (!running) {
      running = true;
      longAnswerTyped = false;
      const b = document.getElementById('ep-macro-btn');
      if (b) { b.textContent = '⏹ Stop'; b.style.background = '#dc3545'; }
      step();
    }
  };

  // Watch for the game page to appear (handles SPA navigation).
  const observer = new MutationObserver(() => {
    if (document.querySelector('.game-page')) addUI();
  });
  observer.observe(document.body, { childList: true, subtree: true });
  if (document.querySelector('.game-page')) addUI();

})();
