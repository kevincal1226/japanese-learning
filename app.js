(function () {
  "use strict";

  // ---------- storage ----------

  const store = {
    get(key, fallback) {
      try {
        const value = localStorage.getItem(key);
        return value === null ? fallback : JSON.parse(value);
      } catch (e) {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch (e) {
        // Storage can be unavailable (private mode). The app still works for this visit.
      }
    },
  };

  // ---------- state ----------

  const els = {
    quiz: document.getElementById("quiz"),
    card: document.getElementById("card"),
    options: document.getElementById("options"),
    promptToggle: document.getElementById("prompt-toggle"),
    answerToggle: document.getElementById("answer-toggle"),
    correct: document.getElementById("correct-count"),
    wrong: document.getElementById("wrong-count"),
    remaining: document.getElementById("remaining"),
    sheet: document.getElementById("sheet"),
    sheetTitle: document.getElementById("sheet-title"),
    levelGrid: document.getElementById("level-grid"),
    levelPane: document.getElementById("level-pane"),
    settingsPane: document.getElementById("settings-pane"),
    tabLevel: document.getElementById("tab-level"),
    tabSettings: document.getElementById("tab-settings"),
    shuffle: document.getElementById("setting-shuffle"),
    autoplay: document.getElementById("setting-autoplay"),
    resetScores: document.getElementById("reset-scores"),
  };

  const settings = Object.assign(
    { prompt: "kanji", answer: "english", shuffle: true, autoplay: false },
    store.get("settings", {})
  );
  let highScores = store.get("highScores", {});
  let decks = [];
  const deckData = {};
  let session = null;
  let animating = false;

  const GROUPS_PER_ROW = 8;
  // Group value for a session over every card in a level.
  const ALL = "all";

  // ---------- helpers ----------

  function esc(text) {
    return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function shuffled(list) {
    const out = list.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  function fetchJSON(url) {
    return fetch(url).then((res) => {
      if (!res.ok) throw new Error(url + ": " + res.status);
      return res.json();
    });
  }

  function loadDeck(id) {
    if (deckData[id]) return Promise.resolve(deckData[id]);
    return fetchJSON("data/" + id + ".json").then((data) => {
      deckData[id] = data;
      return data;
    });
  }

  function deckInfo(id) {
    return decks.find((d) => d.id === id);
  }

  function cardsFor(deckId, group) {
    const data = deckData[deckId];
    if (group !== ALL) return data.groups[group];
    if (!data.all) data.all = [].concat(...data.groups);
    return data.all;
  }

  function groupCards() {
    return cardsFor(session.deck, session.group);
  }

  function currentIndex() {
    return session.order[session.pos];
  }

  function currentCard() {
    return groupCards()[currentIndex()];
  }

  // What each mode shows. For kana decks: "kanji" is the kana itself, "kana" is the
  // same sound in the other script and "english" is the romaji.
  function text(card, mode) {
    if (mode === "kanji") return card.k;
    if (mode === "kana") return card.r;
    return card.m;
  }

  function modeLabels(deckId) {
    if (deckId === "hiragana") {
      return {
        prompt: [["kanji", "Hiragana"], ["kana", "Katakana"], ["english", "Romaji"]],
        answer: [["kana", "Katakana"], ["english", "Romaji"]],
      };
    }
    if (deckId === "katakana") {
      return {
        prompt: [["kanji", "Katakana"], ["kana", "Hiragana"], ["english", "Romaji"]],
        answer: [["kana", "Hiragana"], ["english", "Romaji"]],
      };
    }
    return {
      prompt: [["kanji", "Kanji"], ["kana", "Kana"], ["english", "English"]],
      answer: [["kana", "Kana"], ["english", "English"]],
    };
  }

  function isJapaneseMode(mode) {
    return mode === "kanji" || mode === "kana";
  }

  function saveSession() {
    store.set("session", session);
  }

  function saveSettings() {
    store.set("settings", settings);
  }

  // ---------- session ----------

  function makeOptions() {
    const cards = groupCards();
    const answerIndex = currentIndex();
    const card = cards[answerIndex];
    const promptText = text(card, settings.prompt);
    const answers = new Set([text(card, settings.answer)]);
    const picked = [answerIndex];
    const pool = shuffled(cards.map((_, i) => i).filter((i) => i !== answerIndex));
    for (const i of pool) {
      if (picked.length === 9) break;
      const other = cards[i];
      const otherAnswer = text(other, settings.answer);
      // Skip cards that would make a second correct-looking choice.
      if (answers.has(otherAnswer) || text(other, settings.prompt) === promptText) continue;
      answers.add(otherAnswer);
      picked.push(i);
    }
    return shuffled(picked);
  }

  function startSession(deckId, group) {
    return loadDeck(deckId).then(() => {
      const count = cardsFor(deckId, group).length;
      const order = Array.from({ length: count }, (_, i) => i);
      session = {
        deck: deckId,
        group: group,
        order: settings.shuffle ? shuffled(order) : order,
        pos: 0,
        correct: 0,
        wrong: 0,
        chosen: null,
        options: null,
        done: false,
        score: null,
        best: null,
      };
      session.options = makeOptions();
      saveSession();
      render();
    });
  }

  function choose(index) {
    if (!session || session.done || session.chosen !== null || animating) return;
    session.chosen = index;
    if (index === currentIndex()) {
      session.correct++;
    } else {
      session.wrong++;
    }
    saveSession();
    render();
    if (settings.autoplay) speak();
  }

  function finish() {
    const total = session.order.length;
    const score = Math.round((100 * session.correct) / total);
    const scores = highScores[session.deck] || (highScores[session.deck] = {});
    const previous = scores[session.group];
    scores[session.group] = previous === undefined ? score : Math.max(previous, score);
    store.set("highScores", highScores);
    session.done = true;
    session.pos = total - 1;
    session.score = score;
    session.best = scores[session.group];
  }

  function nextCard(direction) {
    if (!session || session.done || session.chosen === null || animating) return;
    slide(direction, () => {
      session.chosen = null;
      if (session.pos + 1 >= session.order.length) {
        finish();
      } else {
        session.pos++;
        session.options = makeOptions();
      }
      saveSession();
      render();
    });
  }

  function slide(direction, update) {
    animating = true;
    const q = els.quiz;
    q.className = "quiz slide-out-" + direction;
    setTimeout(() => {
      update();
      q.className = "quiz slide-in-from-" + (direction === "left" ? "right" : "left");
      void q.offsetWidth;
      q.className = "quiz slide-in";
      setTimeout(() => {
        q.className = "quiz";
        animating = false;
      }, 230);
    }, 200);
  }

  // ---------- audio ----------

  function speak() {
    if (!session || !("speechSynthesis" in window)) return;
    const card = currentCard();
    const info = deckInfo(session.deck);
    const utterance = new SpeechSynthesisUtterance(info.type === "kanji" ? card.r : card.k);
    utterance.lang = "ja-JP";
    utterance.rate = 0.9;
    const voice = speechSynthesis.getVoices().find((v) => /^ja[-_]/i.test(v.lang));
    if (voice) utterance.voice = voice;
    speechSynthesis.cancel();
    speechSynthesis.speak(utterance);
  }

  // ---------- rendering ----------

  const ICONS = {
    speaker:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9v6h4l5 4V5L7 9H3z" fill="currentColor"/><path d="M15.5 8.6a4.8 4.8 0 0 1 0 6.8M18 6.2a8.2 8.2 0 0 1 0 11.6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
    check:
      '<svg class="mark" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12.5l6 6L21 5" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    cross:
      '<svg class="mark" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5l14 14M19 5L5 19" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/></svg>',
  };

  function render() {
    if (!session) return;
    const total = session.order.length;
    els.correct.textContent = session.correct;
    els.wrong.textContent = session.wrong;
    els.remaining.textContent = "Remaining: " + (total - session.correct - session.wrong);
    renderCard();
    renderToggles();
    renderOptions();
  }

  function footerHTML() {
    const info = deckInfo(session.deck);
    const total = session.order.length;
    return (
      '<div class="card-footer"><span>' +
      esc(info.label + (session.group === ALL ? " All" : " Group " + (session.group + 1))) +
      "</span><span>" +
      (session.pos + 1) + " of " + total +
      "</span></div>"
    );
  }

  function promptHTML(card) {
    const value = text(card, settings.prompt);
    if (settings.prompt === "kanji") {
      return '<div class="big-kanji">' + esc(value) + "</div>";
    }
    if (settings.prompt === "kana" || deckInfo(session.deck).type === "kanji") {
      if (settings.prompt === "kana") {
        const size = value.length <= 2 ? 64 : value.length <= 4 ? 52 : value.length <= 6 ? 40 : 32;
        return '<div class="big-kana" style="font-size:' + size + 'px">' + esc(value) + "</div>";
      }
      return '<div class="big-english">' + esc(value) + "</div>";
    }
    // Romaji for kana decks.
    return '<div class="big-english" style="font-size:48px">' + esc(value) + "</div>";
  }

  function renderCard() {
    const card = currentCard();
    const info = deckInfo(session.deck);

    if (session.done) {
      els.card.innerHTML =
        '<div class="card-front"><div>' +
        '<div class="done-title">Group complete</div>' +
        '<div class="done-score">' + session.score + "%</div>" +
        '<div class="done-best">High score: ' + session.best + "</div>" +
        "</div></div>" +
        footerHTML();
      return;
    }

    if (session.chosen === null) {
      els.card.innerHTML = '<div class="card-front">' + promptHTML(card) + "</div>" + footerHTML();
      return;
    }

    let rows;
    let examples = "";
    if (info.type === "kanji") {
      rows = [["English", card.e, false]];
      if (card.kun.length) rows.push(["Kun Yomi", card.kun.join(", "), true]);
      if (card.on.length) rows.push(["On Yomi", card.on.join(", "), true]);
      if (card.x.length) {
        examples =
          '<div class="examples-title">Examples</div><div class="examples-table">' +
          card.x
            .map((x) => '<div class="ex-word">' + esc(x[0]) + " (" + esc(x[1]) + ')</div><div class="ex-meaning">' + esc(x[2]) + "</div>")
            .join("") +
          "</div>";
      }
    } else {
      rows = [
        ["Romaji", card.m, false],
        [info.id === "hiragana" ? "Katakana" : "Hiragana", card.r, true],
      ];
    }

    els.card.innerHTML =
      '<div class="card-top">' +
      '<div class="reveal-char">' + esc(card.k) + "</div>" +
      '<div class="reveal-info">' +
      '<button class="speaker" id="speaker" aria-label="Play audio">' + ICONS.speaker + "</button>" +
      rows
        .map((r) => '<div><div class="info-label">' + r[0] + '</div><div class="info-value' + (r[2] ? " ja" : "") + '">' + esc(r[1]) + "</div></div>")
        .join("") +
      "</div></div>" +
      '<div class="card-examples">' + examples + '<div class="swipe-hint">Swipe anywhere for next card</div></div>';

    document.getElementById("speaker").addEventListener("click", speak);
  }

  function renderToggles() {
    const labels = modeLabels(session.deck);
    els.promptToggle.innerHTML = labels.prompt
      .map((l) => '<button data-mode="' + l[0] + '" class="' + (settings.prompt === l[0] ? "on" : "") + '">' + l[1] + "</button>")
      .join("");
    els.answerToggle.innerHTML = labels.answer
      .map((l) => '<button data-mode="' + l[0] + '" class="' + (settings.answer === l[0] ? "on" : "") + '">' + l[1] + "</button>")
      .join("");
  }

  function renderOptions() {
    if (session.done) {
      const info = deckInfo(session.deck);
      const hasNext = session.group !== ALL && session.group + 1 < info.groups;
      els.options.innerHTML =
        '<button class="option" style="grid-column:1/-1" data-action="restart">Restart group</button>' +
        '<button class="option" style="grid-column:1/-1" data-action="' + (hasNext ? "next-group" : "select") + '">' +
        (hasNext ? "Next group" : "Select level") +
        "</button>";
      return;
    }

    const cards = groupCards();
    const answerIndex = currentIndex();
    const deckIsKana = deckInfo(session.deck).type === "kana";
    const answerIsJapanese = settings.answer === "kana";

    els.options.innerHTML = session.options
      .map((i) => {
        const card = cards[i];
        const revealed = session.chosen !== null && (i === answerIndex || i === session.chosen);
        if (revealed) {
          const right = i === answerIndex;
          return (
            '<button class="option ' + (right ? "correct" : "wrong") + '" data-index="' + i + '">' +
            (right ? ICONS.check : ICONS.cross) +
            '<span class="opt-char">' + esc(card.k) + "</span>" +
            '<span class="opt-kana">' + esc(card.r) + "</span>" +
            '<span class="opt-english">' + esc(card.m) + "</span>" +
            "</button>"
          );
        }
        const value = text(card, settings.answer);
        let cls = "option";
        if (answerIsJapanese) cls += " ja" + (value.length > 5 ? " long" : "");
        else if (deckIsKana) cls += " ja";
        return '<button class="' + cls + '" data-index="' + i + '">' + esc(value) + "</button>";
      })
      .join("");
  }

  // ---------- level sheet ----------

  function scoreClass(score) {
    if (score >= 90) return "s90";
    if (score >= 80) return "s80";
    if (score >= 70) return "s70";
    if (score >= 60) return "s60";
    if (score >= 50) return "s50";
    if (score >= 1) return "s1";
    return "s0";
  }

  function renderLevelGrid() {
    const cell = (deck, group, scores) => {
      const score = scores[group] === undefined ? 0 : scores[group];
      return '<button class="cell ' + scoreClass(score) + '" data-deck="' + deck.id + '" data-group="' + group + '">' + score + "</button>";
    };
    let html = '<div class="head label">Group #</div>';
    for (let c = 1; c <= GROUPS_PER_ROW; c++) html += '<div class="head">' + c + "</div>";
    html += '<div class="head">All</div>';
    for (const deck of decks) {
      const rows = Math.ceil(deck.groups / GROUPS_PER_ROW);
      const scores = highScores[deck.id] || {};
      for (let r = 0; r < rows; r++) {
        html += '<div class="row-label">' + (r === 0 ? esc(deck.label) : "") + "</div>";
        for (let c = 0; c < GROUPS_PER_ROW; c++) {
          const g = r * GROUPS_PER_ROW + c;
          html += g < deck.groups ? cell(deck, g, scores) : '<div class="cell"></div>';
        }
        // The All box sits on the level's first row only.
        html += r === 0 ? cell(deck, ALL, scores) : "<div></div>";
      }
    }
    els.levelGrid.innerHTML = html;
  }

  function showTab(name) {
    const level = name === "level";
    els.tabLevel.classList.toggle("active", level);
    els.tabSettings.classList.toggle("active", !level);
    els.levelPane.hidden = !level;
    els.settingsPane.hidden = level;
    els.sheetTitle.textContent = level ? "Select Level" : "Settings";
  }

  function openSheet() {
    renderLevelGrid();
    showTab("level");
    els.shuffle.checked = settings.shuffle;
    els.autoplay.checked = settings.autoplay;
    document.body.classList.add("sheet-open");
    els.sheet.setAttribute("aria-hidden", "false");
  }

  function closeSheet() {
    document.body.classList.remove("sheet-open");
    els.sheet.setAttribute("aria-hidden", "true");
  }

  // ---------- events ----------

  function setPrompt(mode) {
    settings.prompt = mode;
    if (settings.answer === mode) settings.answer = mode === "kana" ? "english" : "kana";
    modesChanged();
  }

  function setAnswer(mode) {
    settings.answer = mode;
    if (settings.prompt === mode) settings.prompt = "kanji";
    modesChanged();
  }

  function modesChanged() {
    saveSettings();
    if (session && !session.done && session.chosen === null) {
      session.options = makeOptions();
      saveSession();
    }
    render();
  }

  function bindEvents() {
    document.getElementById("menu-button").addEventListener("click", openSheet);
    document.getElementById("sheet-close").addEventListener("click", closeSheet);
    els.tabLevel.addEventListener("click", () => showTab("level"));
    els.tabSettings.addEventListener("click", () => showTab("settings"));

    els.promptToggle.addEventListener("click", (e) => {
      const button = e.target.closest("button[data-mode]");
      if (button) setPrompt(button.dataset.mode);
    });
    els.answerToggle.addEventListener("click", (e) => {
      const button = e.target.closest("button[data-mode]");
      if (button) setAnswer(button.dataset.mode);
    });

    els.options.addEventListener("click", (e) => {
      const button = e.target.closest("button");
      if (!button) return;
      const action = button.dataset.action;
      if (action === "restart") startSession(session.deck, session.group);
      else if (action === "next-group") startSession(session.deck, session.group + 1);
      else if (action === "select") openSheet();
      else if (button.dataset.index !== undefined) choose(Number(button.dataset.index));
    });

    els.levelGrid.addEventListener("click", (e) => {
      const cell = e.target.closest("button.cell");
      if (!cell) return;
      closeSheet();
      const group = cell.dataset.group;
      startSession(cell.dataset.deck, group === ALL ? ALL : Number(group));
    });

    els.shuffle.addEventListener("change", () => {
      settings.shuffle = els.shuffle.checked;
      saveSettings();
    });
    els.autoplay.addEventListener("change", () => {
      settings.autoplay = els.autoplay.checked;
      saveSettings();
    });

    let resetTimer = null;
    els.resetScores.addEventListener("click", () => {
      if (resetTimer) {
        clearTimeout(resetTimer);
        resetTimer = null;
        highScores = {};
        store.set("highScores", highScores);
        els.resetScores.textContent = "Done";
        setTimeout(() => (els.resetScores.textContent = "Reset"), 1500);
        return;
      }
      els.resetScores.textContent = "Tap again to reset";
      resetTimer = setTimeout(() => {
        resetTimer = null;
        els.resetScores.textContent = "Reset";
      }, 3000);
    });

    // Swipe anywhere on the main screen for the next card.
    let startX = null;
    let startY = null;
    window.addEventListener("pointerdown", (e) => {
      if (document.body.classList.contains("sheet-open")) return;
      startX = e.clientX;
      startY = e.clientY;
    });
    window.addEventListener("pointerup", (e) => {
      if (startX === null) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      startX = null;
      if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.2) nextCard(dx < 0 ? "left" : "right");
    });
    window.addEventListener("pointercancel", () => {
      startX = null;
    });

    window.addEventListener("keydown", (e) => {
      if (document.body.classList.contains("sheet-open")) {
        if (e.key === "Escape") closeSheet();
        return;
      }
      if (e.key === "ArrowRight" || e.key === "Enter" || e.key === " ") nextCard("left");
    });
  }

  // ---------- start ----------

  function restoreSession() {
    const saved = store.get("session", null);
    if (!saved || !deckInfo(saved.deck)) return Promise.resolve(false);
    return loadDeck(saved.deck).then((data) => {
      const group = saved.group === ALL || data.groups[saved.group] ? cardsFor(saved.deck, saved.group) : null;
      if (!group || !Array.isArray(saved.order) || saved.order.length !== group.length) return false;
      session = saved;
      if (!session.done && !Array.isArray(session.options)) session.options = makeOptions();
      render();
      return true;
    });
  }

  function init() {
    bindEvents();
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    }
    fetchJSON("data/decks.json")
      .then((list) => {
        decks = list;
        return restoreSession();
      })
      .then((restored) => (restored ? null : startSession("n5", 0)))
      .catch(() => {
        els.card.innerHTML =
          '<div class="card-front"><div class="big-english" style="font-size:18px">Could not load the flashcards. Connect to the internet and reopen the app.</div></div>';
      });
  }

  init();
})();
