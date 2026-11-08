// ==UserScript==
// @name         WZU CAS 登录页 CPU 修复
// @name:en      WZU CAS login page CPU fix
// @namespace    https://wzu.edu.cn/
// @version      2.2.0
// @description  移除 CAS 登录页 onUnstable 自激 0ms 定时器订阅，修复 CPU 满载
// @match        https://source-443.webvpn.wzu.edu.cn/*
// @match        https://source.wzu.edu.cn/*
// @run-at       document-start
// @grant        none
// @noframes
// ==/UserScript==

/*
 * 根因
 * ----
 * 登录页的 reCheck() 订阅了 Angular NgZone.onUnstable，回调里执行：
 *
 *   setTimeout(() => ngZone.run(() => {}), 0)
 *
 * ngZone.run() 又会触发 onUnstable，于是不断排新的 0ms 定时器，前台可占满一个 CPU 核心。
 * 这段代码在普通 UA 和百度 UA 分支里各有一份，百度 UA 会订阅两次。
 *
 * 修复
 * ----
 * Angular 启动后找到 NgZone 实例，把 onUnstable 上所有包含 “setTimeout + _ngZone” 的
 * 订阅回调替换成空函数。只停掉问题订阅，不改页面其它定时器，也不影响正常点击和输入。
 * 用 MutationObserver 和 requestAnimationFrame 尽早发现 NgZone，避免被 0ms 定时器风暴
 * 拖慢轮询；setInterval 只作为兜底。
 */

(function () {
  'use strict';

  const stats = {
    attempts: 0,
    zoneFound: false,
    neutralized: 0,
    done: false,
    foundBy: null,
    foundAt: null,
  };
  window.__wzuCpuFix = stats;

  const startedAt = performance.now();
  let rafId = 0;
  let observer = null;
  let fallbackTimer = 0;
  let cleanupTimer = 0;
  let zone = null;

  function isBuggyCallback(fn) {
    try {
      const src = Function.prototype.toString.call(fn);
      return src.indexOf('setTimeout') !== -1 && /_ngZone|ngZone/.test(src);
    } catch (e) {
      return false;
    }
  }

  function neutralize(zone) {
    const observers = zone && zone.onUnstable && zone.onUnstable.observers;
    if (!Array.isArray(observers)) return 0;

    let count = 0;
    for (const observer of observers) {
      let cur = observer;
      for (let depth = 0; cur && depth < 10; depth++) {
        if (typeof cur.next === 'function' && isBuggyCallback(cur.next)) {
          cur.next = function () {};
          count++;
        }
        const partial = cur.partialObserver;
        if (partial && typeof partial.next === 'function' && isBuggyCallback(partial.next)) {
          partial.next = function () {};
          count++;
        }
        cur = cur.destination;
      }
    }
    return count;
  }

  function looksLikeZone(v) {
    return !!v && !!v.onUnstable && typeof v.run === 'function' && Array.isArray(v.onUnstable.observers);
  }

  function findZone(root) {
    let ctx;
    try {
      ctx = root.__ngContext__;
    } catch (e) {
      return null;
    }
    if (!Array.isArray(ctx)) return null;

    // 常见结构：app-root.__ngContext__ 的某一项直接带 _zone。
    for (const value of ctx) {
      if (!value || (typeof value !== 'object' && typeof value !== 'function')) continue;
      if (value._zone && looksLikeZone(value._zone)) return value._zone;
      if (looksLikeZone(value)) return value;
    }

    // 兜底：在 Angular 上下文里做一次有界 BFS。
    const seen = new WeakSet();
    const queue = [];
    for (const value of ctx) queue.push({ value, depth: 0 });

    let steps = 0;
    while (queue.length && steps++ < 5000) {
      const item = queue.shift();
      const v = item.value;
      if (!v || (typeof v !== 'object' && typeof v !== 'function')) continue;
      if (v === window || v === document || v instanceof Node) continue;
      if (seen.has(v)) continue;
      seen.add(v);

      if (looksLikeZone(v)) return v;
      if (item.depth >= 6) continue;

      let keys;
      try {
        keys = Object.keys(v);
      } catch (e) {
        continue;
      }
      for (const key of keys) {
        let child;
        try {
          child = v[key];
        } catch (e) {
          continue;
        }
        if (child && (typeof child === 'object' || typeof child === 'function')) {
          queue.push({ value: child, depth: item.depth + 1 });
        }
      }
    }
    return null;
  }

  function stopEverything() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
    if (fallbackTimer) {
      clearInterval(fallbackTimer);
      fallbackTimer = 0;
    }
    if (cleanupTimer) {
      clearTimeout(cleanupTimer);
      cleanupTimer = 0;
    }
  }

  function attempt(why) {
    if (stats.done) return;
    stats.attempts++;

    if (!zone) {
      const root = document.querySelector('app-root') || document.querySelector('[ng-version]');
      if (!root) return;

      zone = findZone(root);
      if (!zone) return;
      stats.zoneFound = true;
    }

    const count = neutralize(zone);
    if (count > 0) {
      stats.neutralized += count;
      stats.done = true;
      stats.foundBy = why;
      stats.foundAt = Math.round(performance.now() - startedAt);
      stopEverything();
    }
  }

  // Angular 启动时会大量改 DOM，MutationObserver 往往能比定时器更早抢到执行机会。
  observer = new MutationObserver(function () {
    attempt('mutation');
  });
  observer.observe(document, { childList: true, subtree: true, attributes: true });

  // 前 5 秒用 requestAnimationFrame 紧一点地看，之后交给兜底定时器。
  function rafLoop() {
    rafId = 0;
    if (stats.done) return;
    attempt('raf');
    if (!stats.done && performance.now() - startedAt < 5000) {
      rafId = requestAnimationFrame(rafLoop);
    }
  }
  rafId = requestAnimationFrame(rafLoop);

  // 兜底：500ms 一次，最多 30 秒。即使定时器被风暴拖慢，前面两条路径通常已经处理完。
  let ticks = 0;
  fallbackTimer = setInterval(function () {
    ticks++;
    attempt('interval');
    if (stats.done || ticks >= 60) {
      clearInterval(fallbackTimer);
      fallbackTimer = 0;
    }
  }, 500);

  cleanupTimer = setTimeout(function () {
    if (!stats.done && observer) observer.disconnect();
    cleanupTimer = 0;
  }, 30000);

  attempt('init');
})();
